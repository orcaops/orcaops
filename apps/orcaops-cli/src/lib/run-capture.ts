import {
  eagerPush,
  flushPendingPushes,
  loadReadOnlyProjectConfig,
  resolveCloudTarget,
  resolveCredentialStore,
} from '@orcaops/core';
import {
  ArtifactFinalizedError,
  ArtifactLockTimeoutError,
  assertNoSecretsInPayload,
  attachLeaseLossCause,
  CheckpointValidationError,
  type CloudSyncFailureKind,
  ConfigValidationError,
  OpenCheckpointOverlapError,
  PlanIdempotencyPendingError,
  PlanRevisionInputInvalidError,
  PlanRevisionOpenCpConflictError,
  type SecretFinding,
  SecretInPayloadError,
  StalePlanRevisionError,
  StaleSummarySupersedeError,
  SummaryAlreadyCapturedError,
  UnacknowledgedCriteriaChangesError,
  UnacknowledgedDroppedCompletionsError,
} from '@orcaops/storage';

import { toSecretFindingReport, toSecretWarningReports } from './cloud-secret-gate.js';
import { buildContext, type CliContext } from './context.js';
import {
  getInvocationCloudBaseUrl,
  getInvocationCwd,
  getInvocationEnv,
} from './invocation-context.js';
import { materializeDigest } from './materialize-digest.js';
import { appendNextActions } from './next-actions.js';
import { resolveOrcaopsRoot } from './resolve-root.js';
import { stampUsage, type UsageStampDescriptor } from './usage-stamp.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStderr } from '../io/output.js';

/**
 * The human-set allowlist, loaded without building a context.
 *
 * Any trouble reading it yields an empty allowlist, which is the strict end:
 * a legitimate exemption silently stops applying and the write refuses — loud
 * where it matters, and recoverable — rather than letting a malformed config
 * decide that a secret may pass.
 *
 * Strict is only recoverable if the user can tell the two refusals apart,
 * which is what the stderr report buys. `redact.allow` is the ONLY way past a
 * refusal, so a config that fails to load produces a refusal indistinguishable
 * from the gate disagreeing with an exemption the user believes is in force.
 *
 * The failures are NOT the same: outside a repo there is no config to have
 * failed (and a missing one resolves to defaults rather than throwing), so
 * that stays silent; a config that exists and does not load is worth saying.
 *
 * stderr, not the response `warnings[]` that `capture.exclude` uses. Anything
 * that fails this loader also fails `buildContext`'s stricter `loadConfig`, and
 * the gate's very next act may be to throw `SecretInPayloadError` — so in every
 * reachable case the command ends in an error envelope and there is no success
 * response to attach a warning to. stderr is the one surface that survives, and
 * it leaves the machine-readable stdout envelope untouched.
 *
 * The underlying error message is deliberately NOT echoed. `JSON.parse` quotes
 * the offending source bytes back (`Unexpected token 'A', "AKIAIOSFOD"... is
 * not valid JSON`), and `redact.allow` is where dead credentials are written
 * down — a diagnostic about the secret gate must not become the leak.
 * `ConfigValidationError`'s dotted path is structural, so it carries through.
 */
export async function loadSecretAllowlist(): Promise<readonly string[]> {
  let repoRoot: string;
  try {
    repoRoot = await resolveOrcaopsRoot({ cwd: getInvocationCwd() });
  } catch {
    return [];
  }
  try {
    return (await loadReadOnlyProjectConfig(repoRoot)).redact.allow;
  } catch (err) {
    const where = err instanceof ConfigValidationError ? ` at ${err.path}` : '';
    writeTerminalSafeStderr(
      `warning: .orcaops/config.json could not be read${where}, so redact.allow was IGNORED ` +
        `and the allowlist is EMPTY — every entry in it is inactive and the strings it exempts ` +
        `will be refused as secrets. Fix the file and retry.\n`
    );
    return [];
  }
}

/**
 * Wrap a capture command's main body so any thrown error becomes a JSON
 * error envelope on stdout and exits non-zero. The body returns a JSON-safe
 * object that gets merged into the success envelope (`ok: true` is added).
 *
 * Storage-side typed errors are remapped to public CLI codes here:
 *   - `ArtifactLockTimeoutError`              → `LOCK_TIMEOUT`
 *   - `OpenCheckpointOverlapError`            → `OPEN_CP_OVERLAP`
 *   - `PlanRevisionOpenCpConflictError`       → `PLAN_REVISION_OPEN_CP_CONFLICT`
 *   - `StalePlanRevisionError`                → `STALE_PLAN_REVISION`
 *   - `ArtifactFinalizedError`                → `ARTIFACT_FINALIZED`
 *   - `UnacknowledgedDroppedCompletionsError` → `PLAN_REVISION_UNACKNOWLEDGED_DROPS`
 *   - `UnacknowledgedCriteriaChangesError`    → `PLAN_REVISION_UNACKNOWLEDGED_CRITERIA_CHANGES`
 *   - `PlanRevisionInputInvalidError`         → `PLAN_REVISION_INPUT_INVALID`
 *   - `PlanIdempotencyPendingError`           → `IDEMPOTENCY_PENDING`
 *   - `SecretInPayloadError`                  → `SECRET_IN_PAYLOAD`
 *   - `CheckpointValidationError` (any)       → `INVALID_INPUT`
 * Storage doesn't depend on the CLI's error registry, so the boundary
 * lives here. `BlockedError` and `ConfigValidationError` are remapped
 * inside their respective callers (capture summary; buildContext) so
 * the runtime context is still available for richer error messages.
 */
export async function runCapture<T extends Record<string, unknown>>(
  fn: () => Promise<T>
): Promise<void> {
  try {
    const result = await fn();
    emitOk(result);
  } catch (err) {
    // Every mapped exit below constructs a FRESH OrcaopsError, which would
    // drop a lease-loss cause the storage lease helpers attached to the
    // original. Capture verbs are the heaviest lock users, so carrying it
    // across the remap is what makes the disclosure reachable at all.
    const emit = (mapped: unknown): never => {
      if (mapped !== err) attachLeaseLossCause(mapped, (err as { cause?: unknown })?.cause);
      return emitError(mapped);
    };
    if (err instanceof SecretInPayloadError) {
      emit(
        new OrcaopsError(
          ErrorCodes.SECRET_IN_PAYLOAD,
          `${err.message} Nothing was written, pushed, or snapshotted.`,
          err.findings[0]?.path,
          { secret_findings: err.findings.map(toSecretFindingReport) }
        )
      );
      return;
    }
    if (err instanceof ArtifactLockTimeoutError) {
      emit(new OrcaopsError(ErrorCodes.LOCK_TIMEOUT, err.message));
      return;
    }
    if (err instanceof PlanRevisionOpenCpConflictError) {
      emit(new OrcaopsError(ErrorCodes.PLAN_REVISION_OPEN_CP_CONFLICT, err.message, err.path));
      return;
    }
    if (err instanceof StalePlanRevisionError) {
      emit(new OrcaopsError(ErrorCodes.STALE_PLAN_REVISION, err.message, err.path));
      return;
    }
    if (err instanceof ArtifactFinalizedError) {
      emit(new OrcaopsError(ErrorCodes.ARTIFACT_FINALIZED, err.message));
      return;
    }
    if (err instanceof SummaryAlreadyCapturedError) {
      emit(new OrcaopsError(ErrorCodes.SUMMARY_ALREADY_CAPTURED, err.message));
      return;
    }
    if (err instanceof StaleSummarySupersedeError) {
      emit(new OrcaopsError(ErrorCodes.STALE_SUMMARY, err.message));
      return;
    }
    if (err instanceof UnacknowledgedDroppedCompletionsError) {
      emit(new OrcaopsError(ErrorCodes.PLAN_REVISION_UNACKNOWLEDGED_DROPS, err.message, err.path));
      return;
    }
    if (err instanceof UnacknowledgedCriteriaChangesError) {
      emit(
        new OrcaopsError(
          ErrorCodes.PLAN_REVISION_UNACKNOWLEDGED_CRITERIA_CHANGES,
          err.message,
          err.path
        )
      );
      return;
    }
    if (err instanceof PlanRevisionInputInvalidError) {
      emit(new OrcaopsError(ErrorCodes.PLAN_REVISION_INPUT_INVALID, err.message, err.path));
      return;
    }
    if (err instanceof OpenCheckpointOverlapError) {
      emit(new OrcaopsError(ErrorCodes.OPEN_CP_OVERLAP, err.message));
      return;
    }
    if (err instanceof PlanIdempotencyPendingError) {
      emit(new OrcaopsError(ErrorCodes.IDEMPOTENCY_PENDING, err.message, 'idempotency_key'));
      return;
    }
    if (err instanceof CheckpointValidationError) {
      emit(new OrcaopsError(ErrorCodes.INVALID_INPUT, err.message, err.path));
      return;
    }
    emit(err);
  }
}

/**
 * `runCapture` + cloud-sync bookends. Builds the context, drains any
 * pending eager pushes from prior failed sessions, runs the command body,
 * eager-pushes the just-written artifact, then closes the context. Each
 * capture command becomes a single `runCaptureWithSync(async (ctx) => …)`
 * call instead of repeating the buildContext / drain / push / close
 * choreography per file.
 *
 * Both sync calls are best-effort and never throw — see `eagerPush` /
 * `flushPendingPushes` for the failure-absorption contract.
 */
export async function runCaptureWithSync<T extends Record<string, unknown>, I = undefined>(
  fn: (ctx: CliContext, input: I) => Promise<T & { secretWarnings?: readonly SecretFinding[] }>,
  opts: { parseInput?: () => Promise<I> } = {}
): Promise<void> {
  await runCapture(async () => {
    // Payload validation runs BEFORE buildContext: context construction
    // mints the repo identity for write verbs, and a payload that fails
    // validation must leave no persistent state behind. Parsing stays
    // inside runCapture so a ZodError still maps to the INVALID_INPUT
    // envelope.
    const input = (opts.parseInput ? await opts.parseInput() : undefined) as I;
    // Warn-tier findings are returned rather than thrown and ride the success
    // envelope — the generic key=value matcher fires on ordinary quoted code,
    // so blocking on it would stop an agent citing test evidence.
    // The allowlist is read on its own rather than from `ctx.config`: the gate
    // runs before `buildContext`, so there is no context to read it from.
    const secretWarnings = assertNoSecretsInPayload(input, await loadSecretAllowlist());
    const ctx = await buildContext();
    try {
      const drain = await flushPendingPushes({
        store: ctx.store,
        repo: ctx.repo,
        baseUrl: resolveCloudTarget(getInvocationCloudBaseUrl()),
        // Thread repoRoot so the drain's born-pin pushes resolve Branch-B
        // derived_from lineage (findByPath keys the cache dir off repoRoot). The
        // eager push below already passes it; without it here a pending born-pin
        // that lands via the top-of-command drain loses its lineage breadcrumb.
        repoRoot: ctx.repoRoot,
        env: getInvocationEnv(),
      });
      const raw = await fn(ctx, input);
      // Commands opt into post-processing on individual success returns. Strip
      // those private signals here so an early return is safe by default and
      // internal control fields never reach the emitted JSON.
      const {
        usageStamp,
        renderFinalDigest,
        secretWarnings: bodySecretWarnings = [],
        ...result
      } = raw as typeof raw & {
        usageStamp?: UsageStampDescriptor;
        renderFinalDigest?: true;
        secretWarnings?: readonly SecretFinding[];
      };
      const artifactId =
        typeof result.artifact_id === 'string' && result.artifact_id.length > 0
          ? result.artifact_id
          : null;
      // Replay paths produce no new local writes — the artifact is byte-for-byte
      // identical to the prior capture, so an eager push would only re-upload
      // unchanged data and burn the 5s timeout on hot dedup hits. The drain
      // we already ran at the top of this command catches anything that
      // legitimately needs to land.
      const isReplay = result.idempotency_status === 'replay';
      // One quiet stderr note per SUCCESSFUL non-replay capture when
      // attribution fell through every tier — tells a direct/manual caller
      // how to fix it without polluting the machine-readable stdout envelope
      // (error envelopes keep a clean stderr; replays stamped nothing new).
      if (!isReplay && ctx.invokingAgent.source === 'fallback') {
        const conflict = ctx.invokingAgent.ambient_conflict;
        writeTerminalSafeStderr(
          `note: invoking agent could not be determined${
            conflict ? ` (conflicting markers: ${conflict.join(', ')})` : ''
          }; attributing to "other". Pass --invoked-by-agent <id> or set ` +
            `ORCAOPS_INVOKED_BY_AGENT.\n`
        );
      }
      // Single private usage stamp — before the eager push (sync reads
      // the ledger), skipped on replay (no new work landed). Best-effort.
      if (usageStamp && !isReplay) {
        await stampUsage(ctx, usageStamp);
      }
      const credentialStore = resolveCredentialStore();
      const baseUrl = resolveCloudTarget(getInvocationCloudBaseUrl());
      if (artifactId && !isReplay) {
        await eagerPush({
          store: ctx.store,
          repo: ctx.repo,
          artifactId,
          baseUrl,
          credentialStore,
          repoRoot: ctx.repoRoot,
        });
      }
      let digestResult: Record<string, unknown> = {};
      if (artifactId && renderFinalDigest) {
        try {
          const digest = await materializeDigest(ctx, artifactId);
          digestResult = {
            finalization_status: 'finalized',
            digest: { status: 'current', cached_at: digest.path },
          };
        } catch {
          digestResult = {
            finalization_status: 'finalized_without_digest',
            digest: {
              status: 'failed',
              message: 'The summary was saved, but digest generation failed.',
              action: `orcaops digest --artifact ${artifactId}`,
            },
          };
        }
      }
      const warningReports = toSecretWarningReports([...secretWarnings, ...bodySecretWarnings]);
      const withSync = {
        ...result,
        ...digestResult,
        cloud_sync: surfaceCloudSync(ctx, drain, baseUrl, artifactId),
        ...(warningReports.length === 0 ? {} : { secret_warnings: warningReports }),
      };
      // Just-in-time next-step hints. Runs AFTER the body, so the snapshot
      // reflects this command's writes (e.g. pre-pr-check's marker, summary's
      // state transition). Best-effort — appendNextActions never throws.
      return await appendNextActions(ctx, withSync);
    } finally {
      ctx.store.close();
    }
  });
}

export interface CloudSyncStatus {
  /**
   * `ok`      — THIS artifact reached the cloud this run (or was already there).
   * `paused`  — NOT uploaded and you must act (auth / config / a failed push).
   *             Surface it to the user and stop silently capturing across it.
   * `skipped` — NOT uploaded, but expected/benign (a local-only repo with no git
   *             remote, or the drain explicitly disabled). No action needed.
   */
  status: 'ok' | 'paused' | 'skipped';
  /** Why it didn't upload (present on `paused`/`skipped`) — tells the agent how to heal. */
  reason?:
    | 'not_authenticated' // paused → `orcaops resync` / `orcaops login`
    | 'push_failed' // paused → `orcaops resync --force`
    | 'content_invalid' // paused → NON-retryable: scrub the disallowed byte + rebuild
    | 'upgrade_required' // paused → NON-retryable on this binary: upgrade the CLI, then resync
    | 'missing_remote' // skipped → benign: no git remote to attribute the push
    | 'drain_disabled' // skipped → benign: ORCAOPS_DISABLE_DRAIN=1
    | 'no_cloud_configured'; // skipped → benign: this machine has no cloud at all
  /**
   * Present on `paused` only: one sentence the agent can quote to the user.
   * The remediation lives here rather than in the committed skill bodies, which
   * must render identically with and without credentials.
   */
  message?: string;
  /** Present on `paused` only: the imperative fix for `reason`. */
  action?: string;
  /** Artifacts written locally but not yet on the cloud (incl. this one). */
  pending?: number;
}

/** The skip reasons `flushPendingPushes` can return on its top-of-command drain. */
type DrainReason = 'not-connected' | 'missing-remote' | 'disabled-by-env' | undefined;

/**
 * Pure classifier for the honest `cloud_sync` signal — `ok` iff THIS artifact
 * actually landed (ground truth). It is NOT derived from `drain.skipped`: the
 * per-command eager push runs even when `ORCAOPS_DISABLE_DRAIN=1` skips the
 * drain, so a disabled drain alone does not mean this artifact failed to upload.
 *
 * Precedence, in one rule: a deterministic LOCAL fault outranks the credential
 * check, and every cloud-directed reason is subordinate to it.
 *
 * `content_invalid` is repaired offline (scrub the byte, `orcaops rebuild`), so
 * a machine without credentials is exactly the one that can still fix it.
 * Everything else needs to REACH the cloud, which that machine cannot do, and
 * the failure counter survives a logout — so reporting them would nag forever
 * at commands the gate hides.
 *
 * Among the cloud-directed reasons a recorded failure still outranks a benign
 * `skipped`; `not-connected` means the injected cloud has no usable
 * credentials.
 */
export function classifyCloudSync(inputs: {
  /** Is THIS artifact still pending cloud sync after the eager push? */
  artifactPending: boolean;
  /** Has THIS artifact ever recorded a successful push (`cloud_synced_at` set)? */
  artifactSynced: boolean;
  /** Recorded consecutive push failures for this artifact (0 = none recorded). */
  consecutiveFailures: number;
  /** Kind of the last recorded push failure (null = none) — singles out a non-retryable fault. */
  lastErrorKind: CloudSyncFailureKind | null;
  /** Does this machine hold cloud credentials at all? */
  hasCloudCredentials: boolean;
  /** The drain's skip reason, if it skipped. */
  drainReason: DrainReason;
  /** Local-only artifacts incl. this one. */
  pending: number;
}): CloudSyncStatus {
  const {
    artifactPending,
    artifactSynced,
    consecutiveFailures,
    lastErrorKind,
    hasCloudCredentials,
    drainReason,
    pending,
  } = inputs;
  // `ok` claims THIS artifact reached the cloud, so it is keyed on the
  // artifact's own landed fact, never on the machine's current credentials:
  // revoking the session that uploaded it does not un-sync it.
  if (!artifactPending) {
    if (artifactSynced) return { status: 'ok' };
    // Not pending and never landed — nothing was uploaded, so `ok` would read
    // as "synced" to every agent branching on this field. Without credentials
    // that is a machine with no cloud at all; with them it is a local-only row
    // (a `git-import`), which the pending predicate excludes from the drain
    // outright. No existing reason describes local-only truthfully and the
    // shipped skill bodies enumerate the reason set, so that case carries none.
    return hasCloudCredentials
      ? { status: 'skipped', pending }
      : { status: 'skipped', reason: 'no_cloud_configured', pending };
  }
  // The one local fault, above the credential check: its remedy needs no cloud.
  if (lastErrorKind === 'content-invalid')
    return { status: 'paused', reason: 'content_invalid', pending };
  // Everything below needs the cloud, so a credential-less machine cannot act.
  if (!hasCloudCredentials) return { status: 'skipped', reason: 'no_cloud_configured', pending };
  // pending → did not land this run. Order is load-bearing: a deterministic
  // fault outranks the generic failure counter, since neither is retryable
  // as-is and each must steer to its own remediation rather than a bare
  // `resync --force`.
  if (lastErrorKind === 'upgrade-required')
    return { status: 'paused', reason: 'upgrade_required', pending };
  if (consecutiveFailures > 0) return { status: 'paused', reason: 'push_failed', pending };
  if (drainReason === 'not-connected')
    return { status: 'paused', reason: 'not_authenticated', pending };
  if (drainReason === 'missing-remote')
    return { status: 'skipped', reason: 'missing_remote', pending };
  if (drainReason === 'disabled-by-env')
    return { status: 'skipped', reason: 'drain_disabled', pending };
  // Drain ran clean but this artifact still isn't landed (e.g. a replay of a
  // still-pending prior artifact) — actionable; `resync --force` retries.
  return { status: 'paused', reason: 'push_failed', pending };
}

/**
 * IO wrapper around {@link classifyCloudSync}: reads the ground truth (did THIS
 * artifact land?) + the exact pending count from the store, classifies, and
 * surfaces an actionable `paused` loudly (stderr) AND machine-readably (the
 * `cloud_sync` field agents branch on). Benign `skipped` states (local-only
 * repo, drain disabled) stay quiet so they don't nag on every capture. Without
 * the loud `paused`, sync goes dark on token expiry with no signal.
 *
 * Ground truth comes from a TARGETED store probe (cap-free), not the LIMIT-20
 * pending list, so an already-synced-but-stale checkpoint that sorts past row 20
 * is still classified correctly.
 */
function surfaceCloudSync(
  ctx: CliContext,
  drain: { skipped: boolean; reason?: string },
  baseUrl: string,
  artifactId: string | null
): CloudSyncStatus {
  const state = artifactId ? ctx.store.store.getCloudSyncStateForArtifact(artifactId) : null;
  // No artifact row (a replay with no id, or a non-writing command) → nothing
  // un-synced to report for it.
  if (!state) return { status: 'ok' };
  const pending = ctx.store.store.countCloudSyncPendingArtifacts();
  const result = classifyCloudSync({
    artifactPending: state.pending,
    artifactSynced: state.syncedAt !== null,
    consecutiveFailures: state.consecutiveFailures,
    lastErrorKind: state.lastErrorKind,
    // Resolved once per invocation, so a command cannot classify against one
    // answer and report against another.
    hasCloudCredentials: ctx.gates.cloud,
    drainReason: drain.skipped ? (drain.reason as DrainReason) : undefined,
    pending,
  });
  if (result.status !== 'paused') return result;
  warnPausedCloudSync(result.reason, baseUrl, pending);
  // Also in the envelope: stderr is not in the agent's structured result path,
  // and the lifecycle skills defer to these fields.
  return { ...result, ...cloudSyncRemediation(result.reason, { baseUrl, pending }) };
}

/**
 * The single source for a paused sync's sentence and its fix, consumed by both
 * the stderr warning and the `cloud_sync` envelope so the two cannot drift. The
 * envelope is what carries it to an agent, since the ungated lifecycle skills
 * name no cloud command.
 */
export function cloudSyncRemediation(
  reason: CloudSyncStatus['reason'],
  ctx: { baseUrl: string | null; pending: number }
): { message: string; action: string } {
  const where = ctx.baseUrl ? `to ${ctx.baseUrl}` : '(no cloud target resolved)';
  return {
    message:
      `This artifact did NOT upload ${where}. ` + `${ctx.pending} artifact(s) are waiting locally.`,
    action: remediationAction(reason),
  };
}

/** Loud, actionable stderr for a `paused` cloud-sync — per-reason remediation. */
function warnPausedCloudSync(
  reason: CloudSyncStatus['reason'],
  baseUrl: string,
  pending: number
): void {
  const { message, action } = cloudSyncRemediation(reason, { baseUrl, pending });
  writeTerminalSafeStderr(`⚠ Cloud sync: ${message}\n  Fix: ${action}\n`);
}

function remediationAction(reason: CloudSyncStatus['reason']): string {
  let fix: string;
  switch (reason) {
    case 'push_failed':
      fix = 'a push attempt failed — run `orcaops resync --force` to retry.';
      break;
    case 'content_invalid':
      fix =
        'this artifact contains a disallowed control byte and will NOT sync until it is ' +
        'scrubbed and rebuilt — this is NOT transient, so `resync --force` will not fix it. ' +
        'Run `orcaops doctor` to see the offending field, then scrub the event log + plan.json ' +
        '(recompute its checksum), `orcaops rebuild`, and `orcaops resync`.';
      break;
    case 'upgrade_required':
      fix =
        'the cloud rejected this CLI as below its minimum supported version — retrying on ' +
        'this binary fails identically. Upgrade your orcaops install, then run `orcaops resync`.';
      break;
    case 'not_authenticated':
    default:
      fix =
        'run `orcaops resync` (an expired session refreshes automatically), ' +
        'or `orcaops login` if it reports your session ended.';
      break;
  }
  return fix;
}
