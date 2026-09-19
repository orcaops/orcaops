import { loadReadOnlyProjectConfig } from '@orcaops/core';
import {
  ArtifactFinalizedError,
  ArtifactLockTimeoutError,
  attachLeaseLossCause,
  CheckpointValidationError,
  ConfigValidationError,
  OpenCheckpointOverlapError,
  PlanAcceptanceCriteriaRequiredError,
  PlanIdempotencyPendingError,
  PlanRevisionInputInvalidError,
  PlanRevisionOpenCpConflictError,
  SecretInPayloadError,
  StalePlanRevisionError,
  StaleSummarySupersedeError,
  SummaryAlreadyCapturedError,
  UnacknowledgedCriteriaChangesError,
  UnacknowledgedDroppedCompletionsError,
} from '@orcaops/storage';

import { toSecretFindingReport } from './cloud-secret-gate.js';
import { getInvocationCwd } from './invocation-context.js';
import { resolveOrcaopsRoot } from './resolve-root.js';
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
 *   - `PlanAcceptanceCriteriaRequiredError`   → `PLAN_ACCEPTANCE_CRITERIA_REQUIRED`
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
    if (err instanceof PlanAcceptanceCriteriaRequiredError) {
      emit(new OrcaopsError(ErrorCodes.PLAN_ACCEPTANCE_CRITERIA_REQUIRED, err.message, err.path));
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
