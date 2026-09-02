import {
  assertCloudSupports,
  createCloudClient,
  isBelowMinimumError,
  isConflictError,
  isForbiddenError,
  isMissingProcedureError,
  isNotFoundError,
  isPayloadSchemaUnsupportedError,
  type OrcaopsCapability,
  type Repo,
  resolveCloudTarget,
  resolveCredentialStore,
} from '@orcaops/core';

import { ErrorCodes, OrcaopsError } from '../../../io/errors.js';
import { CLI_VERSION } from '../../../lib/cli-version.js';
import { buildContext } from '../../../lib/context.js';

type CloudClient = Awaited<ReturnType<typeof createCloudClient>>['client'];
type CredentialStore = ReturnType<typeof resolveCredentialStore>;

export interface ReviewCloudContext {
  client: CloudClient;
  repoRoot: string;
  /** The invocation's Repo — baseline resolution + wire repo_url read off it. */
  repo: Repo;
  baseUrl: string;
  orgId: string;
  /** The resolved credential store — `status` reads the authed identity off it. */
  credentialStore: CredentialStore;
}

/**
 * Shared connect-and-cleanup harness for the `plan review` verbs. Resolves
 * the credential store and injected cloud target, opens the cloud client, pings for the
 * authoritative org, runs `fn`, and ALWAYS closes the local store. Each thin
 * `*Action` calls this then emits; the I/O-light `run*` cores stay
 * client-injectable for tests (they never touch this).
 */
export async function withReviewCloud<T>(
  opts: {
    baseUrl?: string;
    /** Capabilities THIS verb consumes. Required — not defaulted — so a new
     *  verb cannot ship ungated by forgetting the field. `[]` is the explicit
     *  way to say a verb needs none. */
    requires: readonly OrcaopsCapability[];
    /** Verb name for the refusal message, e.g. `plan review push`. */
    operation: string;
  },
  fn: (ctx: ReviewCloudContext) => Promise<T>
): Promise<T> {
  const credentialStore = resolveCredentialStore();
  const baseUrl = resolveCloudTarget(opts.baseUrl);
  const ctx = await buildContext();
  try {
    const { client } = await createCloudClient({
      baseUrl,
      store: credentialStore,
      cliVersion: CLI_VERSION,
    });
    // This ping carries the credential handshake. Nothing authored is in it —
    // each verb's `*Action` runs the outbound secret gate before calling in
    // here, so a refusal precedes the handshake as well as the mutation, and
    // the wrappers' order is pinned by
    // `tests/integration/cloud-gate-precedes-handshake.test.ts`.
    const ping = await client.cli.ping();
    assertCloudSupports(ping, opts.requires, opts.operation, { cliVersion: CLI_VERSION });
    const orgId = ping.orgId;
    return await fn({
      client,
      repoRoot: ctx.repoRoot,
      repo: ctx.repo,
      baseUrl,
      orgId,
      credentialStore,
    });
  } finally {
    ctx.store.close();
  }
}

/** Refuse an empty ref (externalId) up front — same shape across the verbs. */
export function requireRef(ref: string, inputPath: string): void {
  if (!ref || ref.length === 0) {
    throw new OrcaopsError(ErrorCodes.NO_INPUT, 'a plan ref (externalId) is required.', inputPath);
  }
}

/**
 * Remap a cloud read rejection into a friendly `OrcaopsError` (returned, not
 * thrown — call sites `throw mapPlanCloudReadError(err, …)` so non-matching
 * errors rethrow unchanged and the wrapper labels them `CLOUD_ERROR`). Arms in
 * ORDER, LOAD-BEARING:
 *
 * 1. Below-minimum (typed launch appCode) — the cloud rejected this CLI or its
 *    protocol as too old. Terminal until the install is upgraded; must run
 *    first so a floor rejection is never mislabeled as skew or a missing row.
 * 2. Payload schema unsupported (typed launch appCode) — terminal for the
 *    payload; an upgrade, not a retry, resolves it.
 * 3. Typed missing procedure (version skew) — this arm runs before plain
 *    NOT_FOUND because the tRPC code may overlap. Callers may override the
 *    message via `missingProcedureMessage` when the generic plan-review message
 *    would mislead.
 * 4. Plain NOT_FOUND — the caller supplies the verb-specific friendly message.
 *
 * Every `plan` / `plan review` cloud verb routes its catch through this, so new
 * verbs inherit all four mappings for free.
 */
export function mapPlanCloudReadError(
  err: unknown,
  opts: { notFoundMessage: string; inputPath: string; missingProcedureMessage?: string }
): unknown {
  if (isBelowMinimumError(err)) {
    return new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      'The cloud rejected this CLI as below its minimum supported version. Upgrade your orcaops install, then re-run the command.',
      opts.inputPath
    );
  }
  if (isPayloadSchemaUnsupportedError(err)) {
    return new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      "The cloud no longer accepts this payload's schema version. Upgrade your orcaops install, then re-run the command.",
      opts.inputPath
    );
  }
  if (isMissingProcedureError(err)) {
    return new OrcaopsError(
      ErrorCodes.NO_INPUT,
      opts.missingProcedureMessage ??
        "This cloud doesn't expose the plan-review surface; check the deploy.",
      opts.inputPath
    );
  }
  if (isNotFoundError(err)) {
    return new OrcaopsError(ErrorCodes.NO_INPUT, opts.notFoundMessage, opts.inputPath);
  }
  return err;
}

/**
 * The ready-to-paste `capture plan --source-plan` ref for an approved version —
 * null when the plan has never been approved. Read verbs (view/list/status/
 * approve) emit this wherever an approved version is shown.
 */
export function pinRefOf(externalId: string, approvedVersionNumber: number | null): string | null {
  return approvedVersionNumber === null ? null : `cloud:${externalId}@${approvedVersionNumber}`;
}

export type ReviewCommand = 'push' | 'propose' | 'comment' | 'verdict' | 'decline';

/**
 * Remap a cloud authz / status rejection into a friendly `OrcaopsError`, to be
 * thrown INSIDE the `run*` core. This MUST live in the core, not the wrapper:
 * the wrapper's `toCloudErrorEnvelope` flattens any plain `Error` to
 * `CLOUD_ERROR` with the cloud's raw message, so a remap left to it never fires.
 *
 * Both FORBIDDEN cases share the `CLOUD_ERROR` code (only `push`'s CAS conflict
 * gets a distinct code); the user-facing MESSAGE is chosen by command + flag
 * context, never by code alone. Non-authz errors are returned unchanged so the
 * caller re-throws them and the wrapper labels them `CLOUD_ERROR`.
 *
 * NOTE `push`'s publish (CAS) conflict does NOT reach here — the SDK maps it into
 * `reviewPush`'s discriminated `conflict` arm — so a thrown CONFLICT on `push`
 * only ever means the plan left IN_REVIEW (APPROVED/PINNED).
 */
export function mapReviewAuthzError(
  err: unknown,
  ctx: { command: ReviewCommand; supersedes?: boolean; reply?: boolean }
): unknown {
  const inputPath = `plan-review-${ctx.command}`;
  if (isForbiddenError(err)) {
    if (ctx.command === 'push') {
      return new OrcaopsError(
        ErrorCodes.CLOUD_ERROR,
        'Only the plan author can push the candidate.',
        inputPath
      );
    }
    if (ctx.command === 'propose' && ctx.supersedes) {
      return new OrcaopsError(
        ErrorCodes.CLOUD_ERROR,
        'You can only supersede your own OPEN proposal.',
        inputPath
      );
    }
    if (ctx.command === 'verdict') {
      return new OrcaopsError(
        ErrorCodes.CLOUD_ERROR,
        'You are not a requested reviewer on this plan — verdicts are reviewer-seat only.',
        inputPath
      );
    }
    if (ctx.command === 'decline') {
      return new OrcaopsError(
        ErrorCodes.CLOUD_ERROR,
        'Only the plan author can decline a proposal.',
        inputPath
      );
    }
    return new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      'You are not permitted to perform this review action.',
      inputPath
    );
  }
  if (isConflictError(err)) {
    if (ctx.command === 'comment') {
      // A reply CONFLICT is ambiguous by code: the cloud asserts pinned BEFORE it
      // resolves the parent, so this one code covers a pinned plan, a missing
      // parent comment, AND replying to a reply. Name all three rather than
      // matching on the cloud's error wording (which would be fragile).
      return new OrcaopsError(
        ErrorCodes.CLOUD_ERROR,
        ctx.reply
          ? 'Could not post the reply: the parent comment was not found, it is itself a reply (one level only), or the plan is pinned (comments closed).'
          : 'The plan is pinned; comments are closed.',
        inputPath
      );
    }
    if (ctx.command === 'verdict') {
      return new OrcaopsError(
        ErrorCodes.CLOUD_ERROR,
        'The plan is no longer in review (approved or pinned) — verdicts only apply while it is in review.',
        inputPath
      );
    }
    if (ctx.command === 'decline') {
      // Decline stays open through APPROVED (triage continues); only PINNED closes it.
      return new OrcaopsError(
        ErrorCodes.CLOUD_ERROR,
        'The plan is pinned; proposals can no longer be declined.',
        inputPath
      );
    }
    return new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      'The plan is no longer in review (it is approved or pinned).',
      inputPath
    );
  }
  return err;
}
