import { CloudWireError, type CredentialStore, TrpcRequestError } from '@orcaops/sdk';
import { withNonDerivableWriteLease } from '@orcaops/storage';
import {
  type ArtifactStore,
  type CloudSyncFailureKind,
  ForbiddenControlCharError,
} from '@orcaops/storage';

import { isAuthReady, resolveCloudTarget } from './client.js';
import { ArtifactNotFoundError, MissingGitRemoteError, NotConnectedError } from './errors.js';
import { CloudCapabilityError } from './handshake.js';
import { scrubError } from './scrub-error.js';
import { pushArtifact, type PushArtifactOptions, type PushArtifactResult } from './sync.js';
import {
  isBelowMinimumError,
  isMissingProcedureError,
  isPayloadSchemaUnsupportedError,
} from './trpc-errors.js';
import { runWithRefreshLockAbortSignal } from '../credentials/refresh-lock.js';
import { resolveCredentialStore } from '../credentials/store.js';
import type { Repo } from '../git/repo.js';

/**
 * Cloud-sync surface for the OSS CLI: two best-effort entry points that
 * stream local writes to the cloud and self-heal failed pushes.
 *
 *   - `eagerPush` — bounded best-effort push of one artifact. Capture commands
 *     call this at the end of every write so cloud sees the change in
 *     near real-time. Never throws; its deadline cancels network and
 *     credential-lock waits, then the call returns after the push unwinds.
 *     Persists every
 *     non-env-class outcome via `Store.recordCloudSyncFailure` (failures —
 *     records kind, scrubbed message, attempt timestamps, and increments
 *     the consecutive-failures counter that drives backoff) or
 *     `Store.setCloudSyncState` (success — called inside `pushArtifact`,
 *     and ALSO clears the failure state in the same UPDATE so the next
 *     drain stops gating on stale backoff).
 *   - `flushPendingPushes` — opportunistic drain over never-synced artifacts
 *     and those with activity newer than their last push. Capture commands
 *     call this at the start, login calls it
 *     after persisting credentials, and `orcaops resync` exposes it explicitly,
 *     so a missed eager push gets caught up on the next CLI invocation.
 *     Honors per-artifact backoff via `findArtifactsForCloudSyncDrain`'s
 *     filter unless the caller passes `force: true` (which `orcaops resync
 *     --force` does and implicit drains never do).
 *
 * Failure model: both helpers absorb every error path silently or with a
 * single stderr warning — they're best-effort wrappers around
 * `pushArtifact`, never load-bearing for the local capture flow. Env-class
 * outcomes (NotConnected / MissingGitRemote / ArtifactNotFound) are
 * deliberately NOT recorded as artifact failures: those are local
 * environment / race conditions, not artifact-attributable, and recording
 * them would inflate `consecutive_failures` during a logged-out session.
 */

const DEFAULT_EAGER_TIMEOUT_MS = 5_000;
const DEFAULT_DRAIN_TOTAL_BUDGET_MS = 3_000;
// pushArtifact re-ships the whole artifact each call, so even an incremental
// eager push of a multi-checkpoint thread is ~N sequential RPCs and routinely
// needs more than a second. The force path overrides this far higher.
const DEFAULT_DRAIN_PER_PUSH_TIMEOUT_MS = 2_000;
// `resync --force` is an explicit, user-initiated recovery — not a background
// eager drain — so it gets generous budgets. The tight defaults above bound
// implicit drains so they never stall the capture flow; but a force re-push of
// a many-checkpoint artifact is ~N sequential RPCs that legitimately take
// seconds. The per-push deadline aborts the complete request stack and awaits
// its unwind before the caller can close the store.
const FORCE_DRAIN_TOTAL_BUDGET_MS = 120_000;
const FORCE_DRAIN_PER_PUSH_TIMEOUT_MS = 30_000;

class EagerPushTimeoutError extends Error {
  readonly name = 'EagerPushTimeoutError';
  constructor(timeoutMs: number) {
    super(`Eager push timed out after ${timeoutMs}ms`);
  }
}

export interface EagerPushOptions {
  store: ArtifactStore;
  repo: Repo;
  artifactId: string;
  /** Override the 5s default. Tests use a small value to exercise the timeout path. */
  timeoutMs?: number;
  /** Dependency injection seam for tests — production callers omit this. */
  pushFn?: (opts: PushArtifactOptions) => Promise<PushArtifactResult>;
  /** Resolved cloud baseUrl for the push (forwarded to pushArtifact). */
  baseUrl: string;
  /** Credential store the caller resolved (forwarded to pushArtifact). */
  credentialStore: CredentialStore;
  /** Optional repo root, forwarded to pushArtifact for Branch-B derived_from. */
  repoRoot?: string;
  /**
   * Forwarded to `pushArtifact`: when true, bypass its unchanged-hash
   * short-circuit and re-ship regardless. Set by `orcaops resync --force`
   * so a finalize push that was lost can be re-sent even though the local
   * hash already matches the recorded cloud_sync state.
   */
  force?: boolean;
}

export async function eagerPush(opts: EagerPushOptions): Promise<void> {
  const { store, repo, artifactId } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EAGER_TIMEOUT_MS;
  const push = opts.pushFn ?? pushArtifact;

  // Sampled BEFORE push() so that recordCloudSyncFailure can gate on it:
  // if a concurrent push succeeds during this attempt, its setCloudSyncState
  // call will advance `cloud_synced_at` past `attemptStartedAt` and our
  // stale failure write will be filtered out by the WHERE clause.
  const attemptStartedAt = new Date().toISOString();

  const abort = new AbortController();
  const timeoutError = new EagerPushTimeoutError(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => abort.abort(timeoutError), timeoutMs);
    await runWithRefreshLockAbortSignal(abort.signal, () =>
      push({
        store,
        repo,
        artifactId,
        baseUrl: opts.baseUrl,
        credentialStore: opts.credentialStore,
        signal: abort.signal,
        ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
        ...(opts.force === true ? { force: true } : {}),
      })
    );
    abort.signal.throwIfAborted();
  } catch (err) {
    const envClassError =
      err instanceof NotConnectedError ||
      err instanceof MissingGitRemoteError ||
      err instanceof ArtifactNotFoundError;
    const settledError = !envClassError && abort.signal.aborted ? abort.signal.reason : err;
    // Env-class outcomes are local-environment / race conditions, not
    // artifact-attributable failures. Skip recording entirely so a
    // logged-out user doesn't accumulate spurious `consecutive_failures`.
    //
    // FingerprintManifestMissingError is deliberately NOT in this list: it
    // is a HARD, artifact-attributable strict-sync failure. It must fall
    // through to classifyEagerPushError → recorded so
    // doctor's `cloud-sync-pending` surfaces the stuck artifact for
    // `orcaops resync --force`. Adding it here would silently swallow the
    // exact failure strict-sync exists to make loud.
    if (envClassError) {
      return;
    }

    const classified = classifyEagerPushError(settledError);
    const attemptedAt = new Date().toISOString();
    try {
      await withNonDerivableWriteLease(
        store.repoRoot,
        () =>
          store.store.recordCloudSyncFailure(artifactId, {
            kind: classified.kind,
            message: classified.message,
            attemptedAt,
            attemptStartedAt,
          }),
        // Bounded: this sits in the absorb catch OUTSIDE the eager race —
        // the writer default would stall a capture ~150s behind a heal.
        // A missed record self-heals on the next drain.
        { acquireTimeoutMs: 2_000 }
      );
    } catch {
      // Storage write must not be load-bearing for the capture flow.
      // If the write itself fails (disk full, locked db), drop the
      // recording silently — the next attempt will record again.
    }
    // No per-artifact stderr here on purpose: a transient failure self-heals on
    // the next drain (stay quiet), and an auth failure is surfaced once, loudly
    // and actionably, by runCaptureWithSync's `cloud_sync` warning. The recorded
    // failure above is what `doctor`'s cloud-sync-pending check reads.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Map a thrown error from `pushArtifact` (or the eager-push timeout) onto
 * the `CloudSyncFailureKind` discriminator + a scrubbed, length-capped
 * message suitable for persistence.
 *
 * Routing (typed `appCode` outranks HTTP buckets — codes are wire contract,
 * status codes overlap):
 *   - `EagerPushTimeoutError` → `timeout` (no message — the timeout itself
 *     is the diagnostic, and the actual cloud error if any is unobservable).
 *   - `ForbiddenControlCharError` → `content-invalid` (deterministic, NOT
 *     retryable — keep the field-path message for scrub+rebuild guidance).
 *   - below-minimum / payload-schema appCodes → `upgrade-required`
 *     (deterministic for this binary: only an upgrade resolves it).
 *   - `UNKNOWN_PROCEDURE` appCode → `server-behind` (deployment skew; the
 *     cloud predates this client's surface — retryable once the deploy lands).
 *   - `TrpcRequestError` with `data.httpStatus` in [400, 500) → `http-4xx`.
 *   - `TrpcRequestError` with `data.httpStatus` >= 500 → `http-5xx`.
 *   - `TrpcRequestError` without a usable status (e.g., transport error
 *     before the response was parsed) → `network`.
 *   - `CloudCapabilityError` → its own `kind` verbatim (`server-behind` /
 *     `upgrade-required` / `wire-invalid`): a local refusal decided from the
 *     handshake before any request, already named in this vocabulary.
 *   - `CloudWireError` (reachable but malformed response) → `wire-invalid`.
 *   - Anything else → `unknown`.
 *
 * Env-class outcomes are filtered out by the caller (`eagerPush`) before
 * this is reached and never appear here.
 */
function classifyEagerPushError(err: unknown): {
  kind: CloudSyncFailureKind;
  message: string | null;
} {
  if (err instanceof EagerPushTimeoutError) {
    return { kind: 'timeout', message: null };
  }
  if (err instanceof ForbiddenControlCharError) {
    // A deterministic content fault (a forbidden control byte the wire-side
    // assert caught), NOT a transient push failure. Record it as a distinct
    // kind + keep the field-path message so `cloud_sync`/doctor steer the user
    // to scrub+rebuild instead of a `resync --force` loop that re-trips it.
    return { kind: 'content-invalid', message: scrubError(err.message) };
  }
  if (err instanceof TrpcRequestError) {
    if (isBelowMinimumError(err) || isPayloadSchemaUnsupportedError(err)) {
      return { kind: 'upgrade-required', message: scrubError(err.message) };
    }
    if (isMissingProcedureError(err)) {
      return { kind: 'server-behind', message: scrubError(err.message) };
    }
    const status = err.data?.httpStatus;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { kind: 'http-4xx', message: scrubError(err.message) };
    }
    if (typeof status === 'number' && status >= 500) {
      return { kind: 'http-5xx', message: scrubError(err.message) };
    }
    return { kind: 'network', message: scrubError(err.message) };
  }
  if (err instanceof CloudCapabilityError) {
    // A refusal this client decided locally from the handshake, before any
    // request went out. Its `kind` is already drawn from this vocabulary, so it
    // maps across directly rather than being re-derived. Without this arm a
    // background drain would record `unknown` for a deterministic, well-named
    // condition, and doctor would offer a bare retry for something no retry
    // fixes — while the foreground CLI showed the correct message.
    return { kind: err.kind, message: scrubError(err.message) };
  }
  if (err instanceof CloudWireError) {
    // Reached a server, but the response was not the protocol (non-JSON body,
    // envelope validation failure) — distinct from a transport-level failure.
    return { kind: 'wire-invalid', message: scrubError(err.message) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'unknown', message: scrubError(message) };
}

export interface FlushPendingPushesOptions {
  store: ArtifactStore;
  repo: Repo;
  /** Optional repo root, forwarded through eagerPush for Branch-B derived_from. */
  repoRoot?: string;
  /** Total wall-clock budget across all artifacts. Defaults to 3000ms. */
  totalBudgetMs?: number;
  /** Per-artifact eager-push timeout. Defaults to 2000ms. */
  perPushTimeoutMs?: number;
  /** Cap on artifacts considered. Defaults to 20. */
  limit?: number;
  /**
   * When true, the storage scan ignores per-artifact backoff. Set by
   * `orcaops resync --force`; implicit drains (capture / login) leave
   * this false so a thundering-herd on a broken artifact is impossible
   * without explicit user intent.
   */
  force?: boolean;
  /** Test seam — production callers omit. */
  pushFn?: EagerPushOptions['pushFn'];
  /**
   * Test seam: ISO-8601-with-Z timestamp threaded through to the storage
   * scan in place of SQLite's `'now'` so backoff filter tests are
   * deterministic. Production callers omit.
   */
  nowOverride?: string;
  /**
   * Env override for the `ORCAOPS_DISABLE_DRAIN` kill-switch read.
   * Defaults to `process.env`. The CLI threads its invocation-context
   * env here so concurrent in-process tests can flip the kill switch
   * per agent without mutating globals.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: inject a `CredentialStore` so the auth-readiness preflight
   * resolves against a known-good or known-empty store without touching
   * the OS keychain. Production callers omit; the preflight resolves via
   * the SDK's default `resolveCredentialStore()`.
   */
  credentialStore?: CredentialStore;
  /** Test seam: override the baseUrl the preflight checks (paired with `credentialStore`). */
  baseUrl?: string;
}

export interface FlushPendingPushesResult {
  /** True if the drain skipped without doing any work (offline / no remote / kill switch). */
  skipped: boolean;
  /** Reason for the skip; null on a normal drain. */
  reason?: 'not-connected' | 'missing-remote' | 'disabled-by-env';
  /** Number of artifacts the drain attempted. */
  attempted: number;
  /** True if the total time budget aborted the loop early. */
  timedOut: boolean;
  /**
   * Cross-tenant guard count. Number of otherwise-eligible artifacts that were
   * previously pushed to a DIFFERENT org than the currently authed one,
   * and were skipped to avoid silently re-publishing someone else's
   * capture under the active session's org. This count is not capped by the
   * included-artifact drain limit.
   *
   * Fresh artifacts (never pushed; `cloud_org_id IS NULL`) are NOT counted
   * here — the cloud-side tenancy gate on captureThread.create handles
   * those at create time. Only previously-pushed-to-other-org rows count.
   */
  skippedForeignOrg: number;
}

export async function flushPendingPushes(
  opts: FlushPendingPushesOptions
): Promise<FlushPendingPushesResult> {
  if ((opts.env ?? process.env).ORCAOPS_DISABLE_DRAIN === '1') {
    return {
      skipped: true,
      reason: 'disabled-by-env',
      attempted: 0,
      timedOut: false,
      skippedForeignOrg: 0,
    };
  }

  // OAuth-aware preflight. Tokens live in the keychain / XDG file / env-var
  // stores managed by the SDK, not in a credentials file on disk.
  const credentialStore = opts.credentialStore ?? resolveCredentialStore();
  const baseUrl = resolveCloudTarget(opts.baseUrl);

  const ready = await isAuthReady({ store: credentialStore, baseUrl });
  if (!ready) {
    return {
      skipped: true,
      reason: 'not-connected',
      attempted: 0,
      timedOut: false,
      skippedForeignOrg: 0,
    };
  }

  const remoteUrl = await opts.repo.getRemoteUrl();
  if (!remoteUrl) {
    return {
      skipped: true,
      reason: 'missing-remote',
      attempted: 0,
      timedOut: false,
      skippedForeignOrg: 0,
    };
  }

  // Resolve the authed org id for the cross-tenant filter. isAuthReady
  // above guaranteed the store has usable credentials for the resolved
  // baseUrl, so this read should never fail under the normal flow — if it
  // does (race against `orcaops logout`, missing baseUrl), the filter
  // simply doesn't apply and the drain considers every candidate.
  const authedOrgId = await resolveAuthedOrgId(credentialStore, baseUrl);

  const totalBudgetMs =
    opts.totalBudgetMs ??
    (opts.force === true ? FORCE_DRAIN_TOTAL_BUDGET_MS : DEFAULT_DRAIN_TOTAL_BUDGET_MS);
  const perPushTimeoutMs =
    opts.perPushTimeoutMs ??
    (opts.force === true ? FORCE_DRAIN_PER_PUSH_TIMEOUT_MS : DEFAULT_DRAIN_PER_PUSH_TIMEOUT_MS);
  const drainResult = opts.store.store.findArtifactsForCloudSyncDrain({
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.force === true ? { force: true } : {}),
    ...(opts.nowOverride !== undefined ? { nowOverride: opts.nowOverride } : {}),
    ...(authedOrgId ? { orgIdFilter: authedOrgId } : {}),
  });
  const candidates = drainResult.included;
  const skippedForeignOrg = drainResult.excludedForeignOrg;

  const startedAt = Date.now();
  let attempted = 0;
  let timedOut = false;

  for (const artifactId of candidates) {
    if (Date.now() - startedAt >= totalBudgetMs) {
      timedOut = true;
      break;
    }
    attempted += 1;
    await eagerPush({
      store: opts.store,
      repo: opts.repo,
      artifactId,
      baseUrl,
      credentialStore,
      timeoutMs: perPushTimeoutMs,
      ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
      ...(opts.force === true ? { force: true } : {}),
      ...(opts.pushFn ? { pushFn: opts.pushFn } : {}),
    });
  }

  return { skipped: false, attempted, timedOut, skippedForeignOrg };
}

/**
 * Read the authed org id from the resolved credential store. Used by
 * `flushPendingPushes` to thread the cross-tenant filter into the drain's
 * candidate query. Returns null when there's no resolvable baseUrl or no
 * credentials — both of which `isAuthReady` would have already gated on,
 * so this is a defense-in-depth fall-through.
 */
async function resolveAuthedOrgId(store: CredentialStore, baseUrl: string): Promise<string | null> {
  const creds = await Promise.resolve(store.read(baseUrl));
  return creds?.orgId ?? null;
}
