import {
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
import { createCanonicalCloudClient } from '@orcaops/core/history';
import type { CredentialStore, OrcaCloudClient } from '@orcaops/sdk';
import {
  type ProjectDatabase,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { ErrorCodes, OrcaopsError } from '../../../io/errors.js';
import { writeTerminalSafeStderr } from '../../../io/output.js';
import { CLI_VERSION } from '../../../lib/cli-version.js';
import {
  openDatabaseCaptureWriter,
  resolveDatabaseCaptureContext,
} from '../../../lib/database-capture-context.js';
import { createDatabaseSourcePlanReviewMutationClient } from '../../../lib/database-source-plan-review-mutations.js';
import { createDatabasePlanReviewPersistence } from '../../../lib/database-source-plan-review.js';
import { stampDatabaseUsage } from '../../../lib/database-usage-stamp.js';
import type { UsageStampDescriptor } from '../../../lib/usage-stamp-types.js';

type OpenWriter = () => Promise<ProjectDatabase>;

export interface ReviewCloudContext {
  client: OrcaCloudClient;
  repoRoot: string;
  repo: Repo;
  baseUrl: string;
  orgId: string;
  credentialStore: CredentialStore;
  target: RemoteTarget;
  reader: ProjectDatabase;
  secretAllow: readonly string[];
  signal: AbortSignal;
  onWait: NonNullable<ProjectOperationOptions['onWait']>;
  openWriter: OpenWriter;
  openSettlementWriter: OpenWriter;
  stampUsage(descriptor: UsageStampDescriptor): Promise<void>;
}

export function createReviewMutation(
  context: ReviewCloudContext,
  command: Readonly<Record<string, unknown>>,
  options: { publicationAt?: string } = {}
) {
  const transport = createDatabaseSourcePlanReviewMutationClient({
    reader: context.reader,
    openWriter: context.openWriter,
    openSettlementWriter: context.openSettlementWriter,
    client: context.client,
    target: context.target,
    command,
    secretAllow: context.secretAllow,
    now: () => new Date().toISOString(),
    publicationAt: options.publicationAt,
    signal: context.signal,
    onWait: context.onWait,
  });
  return {
    client: transport,
    didDispatch: transport.didDispatch,
    publicationAdmission: transport.publicationAdmission,
    persistence: createDatabasePlanReviewPersistence({
      reader: context.reader,
      openWriter: context.openSettlementWriter,
      target: context.target,
      secretAllow: context.secretAllow,
      signal: context.signal,
      onWait: context.onWait,
      publicationAdmission: transport.publicationAdmission,
    }),
  };
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
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  let context: Awaited<ReturnType<typeof resolveDatabaseCaptureContext>> | undefined;
  try {
    const baseUrl = resolveCloudTarget(opts.baseUrl);
    context = await resolveDatabaseCaptureContext({ signal: controller.signal });
    const credentialStore = resolveCredentialStore();
    const connected = await createCanonicalCloudClient({
      baseUrl,
      store: credentialStore,
      cliVersion: CLI_VERSION,
      requires: opts.requires,
      operation: opts.operation,
      signal: controller.signal,
    });
    let waiting = false;
    const onWait = () => {
      if (waiting) return;
      waiting = true;
      writeTerminalSafeStderr(
        `Waiting for ${opts.operation} on the selected project database; Ctrl-C cancels the wait.\n`
      );
    };
    return await fn({
      client: connected.client,
      repoRoot: context.registered.git.worktreeRoot,
      repo: context.repo,
      baseUrl: connected.target.server_url,
      orgId: connected.target.org_id,
      credentialStore: connected.credentialStore,
      target: connected.target,
      reader: context.project.database,
      secretAllow: context.config.redact.allow,
      signal: controller.signal,
      onWait,
      openWriter: () => openDatabaseCaptureWriter(context!, controller.signal),
      openSettlementWriter: () => openDatabaseCaptureWriter(context!),
      stampUsage: async (descriptor) => {
        let writer: ProjectDatabase | undefined;
        try {
          writer = await openDatabaseCaptureWriter(context!, controller.signal);
          await stampDatabaseUsage(
            writer,
            {
              descriptor,
              invokingAgent: context!.invokingAgent.agent,
              env: context!.env,
              cwd: context!.registered.git.worktreeRoot,
              secretAllow: context!.config.redact.allow,
            },
            { signal: controller.signal, onWait }
          );
        } catch {
          // Usage accounting never changes the command result.
        } finally {
          writer?.close();
        }
      },
    });
  } finally {
    context?.close();
    process.off('SIGINT', interrupt);
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
