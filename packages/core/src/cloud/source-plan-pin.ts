import path from 'node:path';

import {
  type AttachedEntity,
  OssSourcePlanPinPayload,
  type SourcePlanGetResult,
} from '@orcaops/sdk';
import {
  canonicalizeBaseUrl,
  findByPath,
  sha256Hex,
  sourcePlanCacheDir,
  type SourcePlanPin,
} from '@orcaops/storage';

import { isMissingProcedureError, isNotFoundError } from './trpc-errors.js';

export type SourcePlanPinBranch = 'A' | 'B';

export type SourcePlanPreflightReason =
  | 'wrong-origin'
  | 'malformed'
  | 'not-found'
  | 'stale'
  | 'not-approved'
  | 'pinned-elsewhere'
  /** The cloud reports an owner of `null`: terminally pinned, owning thread deleted. */
  | 'owner-deleted';

/**
 * A Branch-A read-only preflight rejection. Thrown BEFORE `captureThread.start`
 * so nothing is published; `push.ts` forwards `.message` (already actionable).
 */
export class SourcePlanPreflightError extends Error {
  override readonly name = 'SourcePlanPreflightError';
  readonly reason: SourcePlanPreflightReason;
  constructor(reason: SourcePlanPreflightReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Minimal cloud surfaces — fakeable in tests. */
export interface PreflightClient {
  sourcePlan: { get(input: { slugOrExternalId: string }): Promise<SourcePlanGetResult> };
}
export interface AttachClient {
  sourcePlan: { attachPin(input: OssSourcePlanPinPayload): Promise<AttachedEntity> };
}

export interface PreflightSourcePlanArgs {
  sourcePlan: SourcePlanPin;
  /** Resolved push baseUrl. */
  baseUrl: string;
  /** Authoritative current org id (from `cli.ping` — NOT the credential blob). */
  currentOrgId: string;
  /**
   * THIS artifact's cloud capture-thread external id from its prior push
   * record (same-org only), or null when this push would publish a NEW
   * thread. Compared against the plan's owning thread when the cloud
   * surfaces one — see the ownership contract on `preflightSourcePlan`.
   */
  currentThreadExternalId: string | null;
}

/**
 * Build the APPROVED-but-version-mismatch staleness message, distinguishing
 * the three shapes so the diagnosis reads true:
 *   1. `approvedVersionNumber === null` — the cloud reports APPROVED yet carries
 *      no approved version number; that's an inconsistent cloud state, not an
 *      ordinary "you pinned an old version".
 *   2. approved < pinned — the approved version was rolled BACK below the pin
 *      (a downgrade); the pinned version is no longer the approved one.
 *   3. approved > pinned — the ordinary re-approval moved the approved version
 *      AHEAD of the pin.
 * All keep `reason: 'stale'` — the remediation is the same (`plan pull` the
 * current approved version); only the wording differs.
 */
function staleApprovedMessage(
  ref: { locator: string; version: string },
  approvedVersionNumber: number | null,
  wantVersion: number
): string {
  const head = `Pinned cloud plan ${ref.locator}@${ref.version} is stale`;
  if (approvedVersionNumber === null) {
    return (
      `${head} — the cloud reports status APPROVED but no approved version number ` +
      `(inconsistent cloud state). Re-pull once an approved version is published.`
    );
  }
  const direction =
    approvedVersionNumber < wantVersion
      ? `the approved version was rolled back to ${approvedVersionNumber}`
      : `the approved version is now ${approvedVersionNumber}`;
  return `${head} — ${direction}. Re-pull the approved version.`;
}

/**
 * Read-only Branch-A guard. MUST run BEFORE `captureThread.start` so a
 * wrong-origin / missing / stale / not-approved cloud pin aborts the push
 * before any artifact is published (else only the pin is blocked and a COMPLETE
 * orphan lands in the wrong org). Cache-independent — the frozen pin embeds its
 * origin. A no-op for local (Branch-B) pins: a born-pin is "create in the
 * current org" by definition.
 *
 * Thread ownership comes from the required-nullable `captureThread` ref on
 * `sourcePlan.get`. Both states refuse or pass HERE rather than deferring to
 * the attach, because "authoritative" is not
 * the question — ordering is. The attach's refusal arrives only after
 * `captureThread.start` has published a thread, which is the orphan this guard
 * exists to prevent:
 *
 *   - an owner object → passes only when it is this artifact's thread;
 *   - `null` → the cloud reports the plan is still PINNED with no owner, i.e.
 *     the owning thread was deleted (`captureThreadId` is SetNull server-side).
 *     The server's attach throws for this unconditionally, so deferring
 *     guaranteed a published orphan followed by a 409.
 */
export async function preflightSourcePlan(
  client: PreflightClient,
  args: PreflightSourcePlanArgs
): Promise<void> {
  const ref = args.sourcePlan.source_ref;
  if (ref.kind !== 'cloud') return;

  // Wrong-origin guard (cache-independent: origin is embedded in the pin).
  if (
    canonicalizeBaseUrl(ref.base_url) !== canonicalizeBaseUrl(args.baseUrl) ||
    ref.org_id !== args.currentOrgId
  ) {
    throw new SourcePlanPreflightError(
      'wrong-origin',
      `Pinned cloud plan ${ref.locator} belongs to a different origin (${ref.base_url} / org ${ref.org_id}) than the current push target (${args.baseUrl} / org ${args.currentOrgId}). Push from the originating cloud + org, or re-pull under this one.`
    );
  }

  // Malformed-version guard. SourceRef.version is `string().min(1)`, so a
  // corrupt / hand-edited pin can carry a non-numeric or non-positive value;
  // `Number(ref.version)` would then be NaN and the APPROVED branch below would
  // report a confusing false "stale" (`approvedVersionNumber !== NaN` is always
  // true). Reject it up front — BEFORE the cloud get, so a corrupt pin fails
  // fast and unambiguously, before any thread is published. (The resolver only
  // ever mints a valid `[1-9]\d*` version, so this bites a tampered pin only.)
  const wantVersion = Number(ref.version);
  if (!Number.isInteger(wantVersion) || wantVersion < 1) {
    throw new SourcePlanPreflightError(
      'malformed',
      `Pinned cloud plan ${ref.locator} has a malformed version "${ref.version}" (expected a positive integer). Re-pull the approved version.`
    );
  }

  let plan: SourcePlanGetResult;
  try {
    plan = await client.sourcePlan.get({ slugOrExternalId: ref.locator });
  } catch (err) {
    // Typed missing-procedure skew may also carry NOT_FOUND, so it must escape
    // this arm untouched and retain its server-behind classification.
    if (isNotFoundError(err) && !isMissingProcedureError(err)) {
      throw new SourcePlanPreflightError(
        'not-found',
        `Pinned cloud plan ${ref.locator} was not found on ${args.baseUrl}. Re-pull or re-upload it.`
      );
    }
    throw err;
  }

  // Status whitelist: only APPROVED (version-matched) and PINNED may proceed.
  if (plan.status === 'APPROVED') {
    if (plan.approvedVersionNumber !== wantVersion) {
      throw new SourcePlanPreflightError(
        'stale',
        staleApprovedMessage(ref, plan.approvedVersionNumber, wantVersion)
      );
    }
    return;
  }
  if (plan.status === 'PINNED') {
    const captureThread = plan.captureThread;
    if (captureThread === null) {
      // The cloud DID report ownership, and reported that there is none. The
      // plan is still terminally PINNED — the owning thread was deleted and the
      // reference nulled — so the attach will 409 no matter which thread pushes.
      // The remedy is deliberately not "push from the owning artifact": that
      // artifact is exactly what no longer exists.
      throw new SourcePlanPreflightError(
        'owner-deleted',
        `Pinned cloud plan ${ref.locator} is still pinned but its owning capture thread was deleted, so the pin can never be re-attached. Upload a fresh plan and pin that instead.`
      );
    }
    const owner = captureThread.externalId;
    if (owner !== args.currentThreadExternalId) {
      throw new SourcePlanPreflightError(
        'pinned-elsewhere',
        `Pinned cloud plan ${ref.locator} is already attached to a different capture thread (${owner}). A plan grades exactly one thread — pull a fresh plan for this work, or push from the artifact that owns the pin.`
      );
    }
    // Same-thread re-push. Staleness is gated on APPROVED ONLY: the Branch-A CAS
    // retains approvedVersionId, so approvedVersionNumber is NON-null on a
    // PINNED plan (null only for Branch-B born-pins) — do NOT staleness-fail and
    // do NOT assert it is null. The attach's A-replay acks (version+hash) or 409s.
    return;
  }
  // DRAFT / UNDER_REVIEW / REJECTED / … → never publish a thread for it.
  throw new SourcePlanPreflightError(
    'not-approved',
    `Pinned cloud plan ${ref.locator} is not approved (status ${plan.status}). Re-pull an approved version.`
  );
}

export interface AttachSourcePlanPinArgs {
  artifactId: string;
  sourcePlan: SourcePlanPin;
  /** Branch-B title (the cloud ignores it for Branch-A). */
  planLabel: string;
  baseUrl: string;
  currentOrgId: string;
  /** OPTIONAL — only Branch-B `derived_from` consumes it; absent → no lineage. */
  repoRoot?: string;
  authoredAt: string;
}

/** Branch A (cloud): echo version/hash/body from the frozen self-contained pin. */
export function buildBranchAPin(args: AttachSourcePlanPinArgs): OssSourcePlanPinPayload {
  const ref = args.sourcePlan.source_ref;
  if (ref.kind !== 'cloud') throw new Error('buildBranchAPin requires a cloud source_ref');
  return OssSourcePlanPinPayload.parse({
    schema_version: 1,
    artifact_id: args.artifactId,
    external_id: ref.locator,
    version_number: Number(ref.version),
    title: args.planLabel.slice(0, 200),
    body: args.sourcePlan.content,
    content_hash: args.sourcePlan.hash,
    source_ref: null,
    derived_from: null,
    summary: null,
    // Always null on Branch A — the cloud ignores it (the plan's authoring
    // baseline already lives cloud-side from `plan upload`), and a locally
    // tampered pin must never echo one in.
    baseline: null,
    authored_at: args.authoredAt,
  });
}

/** Deterministic born-pin external_id (≤64 hex; no state, no migration). */
export function bornPinExternalId(artifactId: string): string {
  return sha256Hex(`source-plan-pin:${artifactId}`);
}

/**
 * Branch B (local): a born-pin sealed at `version_number: 1`.
 *
 * A born-pin is sealed at `version_number: 1` rather than `null` because that
 * is the race-safe value: a fresh plan ⇒ `(latest ?? 0)+1 = 1`; a re-push AND
 * the concurrent-first-push loser funnel into the cloud's A-replay, which acks
 * on `1 === 1` + content_hash. `null` would 409 there — that race is why we
 * send `1`.
 */
export async function buildBranchBPin(
  args: AttachSourcePlanPinArgs
): Promise<OssSourcePlanPinPayload> {
  const ref = args.sourcePlan.source_ref;
  if (ref.kind !== 'local') throw new Error('buildBranchBPin requires a local source_ref');
  const derivedFrom = await resolveDerivedFrom(args);
  return OssSourcePlanPinPayload.parse({
    schema_version: 1,
    artifact_id: args.artifactId,
    external_id: bornPinExternalId(args.artifactId),
    version_number: 1,
    title: args.planLabel.slice(0, 200),
    body: args.sourcePlan.content,
    content_hash: args.sourcePlan.hash,
    source_ref: null,
    derived_from: derivedFrom,
    summary: null,
    // The authoring baseline frozen at `capture plan`. A null baseline is
    // valid here; the storage schema defaults it on every read path, so no
    // coalesce. The cloud persists it on born-pin creation and compares its
    // normalized form as immutable replay identity. It also participates in
    // local change detection, so a divergent replay reaches the cloud and
    // conflicts instead of being hidden by the unchanged short-circuit.
    baseline: args.sourcePlan.baseline,
    authored_at: args.authoredAt,
  });
}

/**
 * Best-effort Branch-B lineage: if the local pin file traces to a prior
 * `plan pull --out` in the push org namespace, set `derived_from`. `repoRoot`
 * is the ONLY push-side consumer of `repoRoot` — absent (unthreaded call path),
 * wrong-org, or no record → null (a lost breadcrumb, never a wrong id, never a
 * broken pin). The cloud resolves the sent ref only within the current org.
 */
export async function resolveDerivedFrom(
  args: AttachSourcePlanPinArgs
): Promise<{ source_plan_external_id: string; version_number: number } | null> {
  const ref = args.sourcePlan.source_ref;
  if (!args.repoRoot || ref.kind !== 'local') return null;
  const filePath = path.isAbsolute(ref.locator)
    ? ref.locator
    : path.resolve(args.repoRoot, ref.locator);
  const hit = await findByPath(
    sourcePlanCacheDir(args.repoRoot),
    args.baseUrl,
    args.currentOrgId,
    filePath,
    args.repoRoot
  );
  return hit
    ? { source_plan_external_id: hit.external_id, version_number: hit.version_number }
    : null;
}

/**
 * The Branch-A/B write — runs AFTER the thread exists (it needs `artifact_id`),
 * before `setCloudSyncState`. Dispatches on the pin kind (cloud → A, local →
 * B). A thrown SDK `ConflictError` / `ValidationError` propagates verbatim so
 * `push.ts` forwards the cloud's specific message (never a flattened one).
 */
export async function attachSourcePlanPin(
  client: AttachClient,
  args: AttachSourcePlanPinArgs
): Promise<SourcePlanPinBranch> {
  if (args.sourcePlan.source_ref.kind === 'cloud') {
    await client.sourcePlan.attachPin(buildBranchAPin(args));
    return 'A';
  }
  await client.sourcePlan.attachPin(await buildBranchBPin(args));
  return 'B';
}
