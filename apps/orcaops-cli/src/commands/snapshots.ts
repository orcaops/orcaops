import path from 'node:path';

import {
  diffSnapshotTrees,
  listSensitiveTreePaths,
  materializeSnapshotTree,
  Repo,
  SNAPSHOT_REF_PREFIX,
} from '@orcaops/core';
import {
  applyDatabaseGitReclamation,
  type DatabaseMaintenanceInspection,
  type DatabaseMaintenanceResource,
  inspectDatabaseMaintenance,
  readRegisteredDatabaseContext,
  resumeDatabaseGitReclamation,
} from '@orcaops/core/history/database-retention';
import { cutTruncatedSecretTail } from '@orcaops/evaluator-protocol/secrets';
import { resolveDatabaseHistoryArtifact } from '@orcaops/project-scope/history/database';
import {
  checkoutsRoot,
  type Checkpoint,
  redactSecretsInString,
  resolveCaptureExcludes,
  uuidv7,
  writeCachedirTag,
} from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  openProjectDatabase,
  ProjectDatabaseError,
  readProjectGitReclamationAdmission,
  resolveProjectArtifactDetails,
} from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writePipeFriendlyStdout,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { historyGitEnvironment, historyRepository } from '../lib/database-branch-history.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { retainedCheckpointManifest } from '../lib/database-manifest-sources.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import {
  getInvocationCwd,
  getInvocationEnv,
  getInvocationRootOverride,
} from '../lib/invocation-context.js';
import { parseDigitInt } from '../lib/strict-int.js';

const PRUNE_WARNING =
  'WARNING: pruning retired snapshot refs can make their boundary trees unavailable ' +
  'when no other Git ref retains the objects.';

export interface SnapshotsPruneOptions {
  artifact?: string;
  orphans?: boolean;
  all?: boolean;
  apply?: boolean;
  json?: boolean;
}

type PruneMode = 'artifact' | 'orphans' | 'all';

interface PruneCounts {
  publications: number;
  operations: number;
  removed: number;
  absent: number;
  replayed: number;
}

const emptyPruneCounts = (): PruneCounts => ({
  publications: 0,
  operations: 0,
  removed: 0,
  absent: 0,
  replayed: 0,
});

function selectedSnapshotResources(
  inspection: DatabaseMaintenanceInspection,
  mode: PruneMode,
  artifactId: string | null
): DatabaseMaintenanceResource[] {
  return inspection.resources.filter((resource) => {
    if (resource.role === 'checkpoint') {
      return mode !== 'artifact' || resource.ownerId === artifactId;
    }
    if (resource.role !== null || !resource.fullRef.startsWith(`${SNAPSHOT_REF_PREFIX}/`)) {
      return false;
    }
    return (
      mode !== 'artifact' || resource.fullRef.startsWith(`${SNAPSHOT_REF_PREFIX}/${artifactId}/`)
    );
  });
}

function resolveArtifactId(
  handle: Awaited<ReturnType<typeof openProjectDatabase>>,
  requested: string,
  projectId: string
): string {
  const resolved = resolveProjectArtifactDetails(handle, requested);
  if (resolved.kind === 'missing') {
    throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${requested}".`);
  }
  if (resolved.kind === 'ambiguous') {
    throw new OrcaopsError(
      ErrorCodes.AMBIGUOUS_ARTIFACT,
      'Use a longer prefix or an exact artifact UUID.',
      'artifact',
      {
        history_candidates: resolved.candidates.map((artifactId) => ({
          id: artifactId,
          project_id: projectId,
          command: `orcaops snapshots prune --artifact ${artifactId}`,
        })),
      }
    );
  }
  return resolved.artifactId;
}

function recordPruneOutcome(
  counts: PruneCounts,
  completed: Set<string>,
  publicationId: string,
  result: { value: { outcome: 'removed' | 'absent' }; replayed: boolean }
): void {
  completed.add(publicationId);
  counts.publications = completed.size;
  counts.operations += 1;
  counts[result.value.outcome] += 1;
  if (result.replayed) counts.replayed += 1;
}

function pruneRecoverability(
  handle: Awaited<ReturnType<typeof openProjectDatabase>>,
  admissionOperationId: string
): 'pending' | 'settled' | 'unknown' {
  try {
    const record = readProjectGitReclamationAdmission(handle, admissionOperationId).value;
    return record && !record.terminal ? 'pending' : record ? 'settled' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function pruneFailure(
  cause: unknown,
  counts: PruneCounts,
  kind: 'pending_reclamation' | 'git_publication' | 'inspection',
  id: string,
  recoverability?: 'pending' | 'settled' | 'unknown'
): never {
  throw new OrcaopsError(
    cause instanceof ProjectDatabaseError ? cause.code : 'SNAPSHOT_PRUNE_FAILED',
    `Snapshot pruning stopped at ${kind} ${id}: ${cause instanceof Error ? cause.message : String(cause)}`,
    undefined,
    {
      ...(cause instanceof ProjectDatabaseError && cause.reason ? { reason: cause.reason } : {}),
      snapshot_prune_progress: {
        state:
          recoverability === 'pending'
            ? 'recoverable_in_progress'
            : counts.publications > 0
              ? 'partial_completion'
              : 'refused',
        completed: { ...counts },
        failed_candidate: { kind, id },
      },
    }
  );
}

function pruneOutput(
  inspection: DatabaseMaintenanceInspection | null,
  mode: PruneMode,
  artifactId: string | null,
  counts: PruneCounts
) {
  const resources = inspection ? selectedSnapshotResources(inspection, mode, artifactId) : [];
  return {
    project_id: inspection?.authority.projectId ?? null,
    artifact: artifactId,
    completeness: inspection?.completeness ?? { complete: true, issues: [] },
    candidates: resources
      .filter((resource) => resource.state === 'eligible')
      .map((resource) => resource.fullRef),
    protected: resources
      .filter((resource) => resource.state === 'protected')
      .map((resource) => ({
        publication_id: resource.publicationId,
        full_ref: resource.fullRef,
        reason: resource.reason,
      })),
    unknown: resources
      .filter((resource) => resource.publicationId === null)
      .map((resource) => resource.fullRef),
    outcomes: counts,
    deleted: counts.removed,
  };
}

export async function snapshotsPruneAction(received: SnapshotsPruneOptions = {}): Promise<void> {
  const opts = { ...received };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  let reader: Awaited<ReturnType<typeof openProjectDatabase>> | null = null;
  let writer: Awaited<ReturnType<typeof openProjectDatabase>> | null = null;
  try {
    const selected: PruneMode[] = [];
    if (opts.artifact !== undefined) selected.push('artifact');
    if (opts.orphans === true) selected.push('orphans');
    if (opts.all === true) selected.push('all');
    if (selected.length !== 1) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Exactly one of --artifact <id> | --orphans | --all is required.',
        selected.length === 0 ? undefined : 'selector'
      );
    }
    const mode = selected[0];
    if (mode === 'artifact' && (opts.artifact === undefined || opts.artifact.length === 0)) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '--artifact requires an id.', 'artifact');
    }
    if (mode === 'all' && opts.apply !== true) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '--all requires --apply.', 'all');
    }

    const invocationCwd = getInvocationCwd();
    const env = { ...getInvocationEnv() };
    const override = getInvocationRootOverride() ?? env.ORCAOPS_ROOT;
    const cwd = override?.trim() ? path.resolve(invocationCwd, override) : invocationCwd;
    const root = await normalizeHistoryRoot({ cwd: invocationCwd, env });
    const context = await readRegisteredDatabaseContext(
      { cwd, root: root.resolvedRoot },
      { signal: controller.signal }
    );
    if (!context) {
      if (mode === 'artifact') {
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'Registered project history is unavailable. Preserve the registration, SQLite companion files and retained evidence, then run `orcaops doctor`. Restore only the verified original database; setup cannot replace missing history.'
        );
      }
      const output = pruneOutput(null, mode, null, emptyPruneCounts());
      if (opts.json) emitOk({ schema_version: 1, applied: opts.apply === true, mode, ...output });
      else writeTerminalSafeStdout(formatPruneHuman(opts.apply === true, mode, output));
      return;
    }

    reader = await openProjectDatabase({
      authority: context.authority,
      mode: 'reader',
      signal: controller.signal,
    });
    const artifactId =
      mode === 'artifact'
        ? resolveArtifactId(reader, opts.artifact!, context.authority.projectId)
        : null;
    let inspection = await inspectDatabaseMaintenance(reader, context);
    reader.close();
    reader = null;
    if (opts.apply && !inspection.completeness.complete) {
      throw new ProjectDatabaseError(
        'HISTORY_INACCESSIBLE',
        'Managed Git namespace inspection is incomplete; preserve every ref and repair access before pruning.'
      );
    }

    const initial = pruneOutput(inspection, mode, artifactId, emptyPruneCounts());
    const counts = emptyPruneCounts();
    const completed = new Set<string>();
    const initialCandidates = selectedSnapshotResources(inspection, mode, artifactId).filter(
      (resource) => resource.state === 'eligible'
    );
    if (opts.apply && initialCandidates.length > 0) {
      if (controller.signal.aborted) {
        throw new ProjectDatabaseError('CANCELLED', 'Snapshot pruning cancelled before writing.');
      }
      let waiting = false;
      const operation = {
        signal: controller.signal,
        onWait: () => {
          if (waiting) return;
          waiting = true;
          writeTerminalSafeStderr(
            'Waiting to prune retired snapshot publications; Ctrl-C cancels the wait.\n'
          );
        },
      };
      writer = await openProjectDatabase({
        authority: context.authority,
        mode: 'writer',
        signal: controller.signal,
      });
      for (const admission of inspection.pendingAdmissions) {
        const selected = initialCandidates.some(
          (resource) => resource.publicationId === admission.target.publicationId
        );
        if (!selected) continue;
        try {
          const result = await resumeDatabaseGitReclamation(
            writer,
            context,
            admission.admissionOperationId,
            operation
          );
          recordPruneOutcome(counts, completed, admission.target.publicationId, result);
        } catch (cause) {
          pruneFailure(
            cause,
            counts,
            'pending_reclamation',
            admission.admissionOperationId,
            pruneRecoverability(writer, admission.admissionOperationId)
          );
        }
      }

      try {
        inspection = await inspectDatabaseMaintenance(writer, context);
        if (!inspection.completeness.complete) {
          throw new ProjectDatabaseError(
            'HISTORY_INACCESSIBLE',
            'Managed Git namespace changed to an incomplete state; preserve every remaining ref and repair access before retrying.'
          );
        }
      } catch (cause) {
        pruneFailure(cause, counts, 'inspection', 'managed_git_namespace');
      }
      for (const resource of selectedSnapshotResources(inspection, mode, artifactId)) {
        if (resource.state !== 'eligible' || !resource.target) continue;
        const admission = {
          admissionOperationId: uuidv7(),
          terminalOperationId: uuidv7(),
          target: resource.target,
        };
        try {
          const result = await applyDatabaseGitReclamation(writer, context, admission, operation);
          recordPruneOutcome(counts, completed, resource.publicationId!, result);
        } catch (cause) {
          pruneFailure(
            cause,
            counts,
            'git_publication',
            resource.publicationId!,
            pruneRecoverability(writer, admission.admissionOperationId)
          );
        }
      }
    }
    writer?.close();
    writer = null;

    if (opts.json) {
      emitOk({
        schema_version: 1,
        applied: opts.apply === true,
        mode,
        warning: PRUNE_WARNING,
        ...initial,
        outcomes: counts,
        deleted: counts.removed,
      });
    } else {
      writeTerminalSafeStdout(
        formatPruneHuman(opts.apply === true, mode, { ...initial, outcomes: counts })
      );
    }
  } catch (err) {
    if (reader) closeFailedHistoryRead(reader);
    if (writer) closeFailedHistoryRead(writer);
    if (opts.json) emitError(err);
    else writeErrorLine(err);
    throw new CliExit(1);
  } finally {
    process.off('SIGINT', interrupt);
  }
}

function formatPruneHuman(
  applied: boolean,
  mode: PruneMode,
  output: ReturnType<typeof pruneOutput>
): string {
  const lines: string[] = [];
  lines.push(
    applied
      ? `orcaops snapshots prune — applied (mode=${mode})`
      : `orcaops snapshots prune — dry-run (mode=${mode}, pass --apply to delete)`
  );
  lines.push(PRUNE_WARNING);
  lines.push('');
  lines.push(`  project:       ${output.project_id ?? '(unregistered)'}`);
  lines.push(`  completeness:  ${output.completeness.complete ? 'complete' : 'incomplete'}`);
  lines.push(`  candidates:    ${output.candidates.length}`);
  lines.push(`  protected:     ${output.protected.length}`);
  if (applied)
    lines.push(
      `  outcomes:      ${output.outcomes.removed} removed, ${output.outcomes.absent} absent, ` +
        `${output.outcomes.replayed} replayed`
    );
  for (const ref of output.candidates) lines.push(`    eligible  ${ref}`);
  for (const resource of output.protected)
    lines.push(`    protected ${resource.full_ref} (${resource.reason})`);
  lines.push('');
  return lines.join('\n');
}

// ── snapshots checkout ─────────────────────────────────────────────────

type BoundaryPhase = 'open' | 'close' | 'abandon';

const BOUNDARY_PHASES: readonly BoundaryPhase[] = ['open', 'close', 'abandon'];

function snapshotRepository(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  repositoryInstanceId: string
): Repo {
  const git = context.scope.gitContext;
  if (!git || git.repositoryInstanceId !== repositoryInstanceId) {
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Use the repository instance that owns this retained snapshot evidence.'
    );
  }
  return historyRepository(git.worktreeRoot);
}

/**
 * The phase a bare `snapshots checkout` / a range endpoint defaults to,
 * per the endpoint-resolution rules below: the checkpoint's FINALIZED
 * boundary (close for closed, abandon for abandoned), and open for a
 * still-open cp (its only boundary).
 */
export function defaultPhaseForStatus(status: Checkpoint['status']): BoundaryPhase {
  return status === 'closed' ? 'close' : status === 'abandoned' ? 'abandon' : 'open';
}

type SnapshotBoundaryFields = {
  snapshot_ref: string | null;
  tree_sha: string | null;
  snapshot_commit_sha: string | null;
  snapshot_error_reason: string | null;
};

/**
 * The cp's boundary record for `phase`, or null when that phase does not
 * exist for the cp's status (close on non-closed, abandon on
 * non-abandoned, anything-but-open on an open cp resolves through the
 * status-narrowed fields). Null is the caller's `SNAPSHOT_UNAVAILABLE`.
 */
export function boundaryForPhase(
  cp: Checkpoint,
  phase: BoundaryPhase
): SnapshotBoundaryFields | null {
  if (phase === 'open') return cp.open_snapshot;
  if (phase === 'close') return cp.status === 'closed' ? cp.close_snapshot : null;
  return cp.status === 'abandoned' ? cp.abandon_snapshot : null;
}

/**
 * Shared endpoint resolution for checkout (here) and `snapshots diff`
 * validate the phase against the cp's status, then require a
 * materializable boundary. Throws typed `SNAPSHOT_UNAVAILABLE` errors —
 * the three shapes documented on the error code.
 */
export function requireBoundary(
  cp: Checkpoint,
  phase: BoundaryPhase,
  artifactId: string
): SnapshotBoundaryFields {
  const boundary = boundaryForPhase(cp, phase);
  if (boundary === null) {
    throw new OrcaopsError(
      ErrorCodes.SNAPSHOT_UNAVAILABLE,
      `Checkpoint #${cp.n} of "${artifactId}" is ${cp.status} — phase "${phase}" has no ` +
        `snapshot boundary for this status.`,
      'phase'
    );
  }
  if (boundary.snapshot_commit_sha === null || boundary.tree_sha === null) {
    const reason = boundary.snapshot_error_reason;
    throw new OrcaopsError(
      ErrorCodes.SNAPSHOT_UNAVAILABLE,
      reason !== null
        ? `Checkpoint #${cp.n} has no ${phase} snapshot: capture failed (reason: ${reason}).`
        : `Checkpoint #${cp.n} has no ${phase} snapshot: capture was deliberately skipped ` +
            `(diff_fingerprint disabled at capture time) — nothing to materialize.`,
      'phase'
    );
  }
  return boundary;
}

/** The pruned-boundary message shared by checkout and diff. */
function prunedBoundaryMessage(shaShort: string, n: number, phase: BoundaryPhase): string {
  return (
    `Snapshot commit ${shaShort} for checkpoint #${n} phase "${phase}" is unreachable. The ` +
    `retired publication may have been pruned with \`orcaops snapshots prune\` or ` +
    `\`orcaops gc\`, or its Git objects may be unavailable. This boundary can no longer be ` +
    `materialized until the missing Git evidence is restored.`
  );
}

export interface SnapshotsCheckoutOptions {
  artifact: string;
  checkpoint: number;
  /** Defaults per `defaultPhaseForStatus`. */
  phase?: string;
  /** Target dir (must not exist, or be empty). Default: `<checkoutsRoot>/…`. */
  into?: string;
  json?: boolean;
}

/**
 * `orcaops snapshots checkout --artifact <id> --checkpoint <n>
 *   [--phase open|close|abandon] [--into <dir>] [--json]`
 *
 * Materialize a pinned checkpoint boundary tree into a detached scratch
 * worktree (mechanism + hygiene in `materializeSnapshotTree`).
 * NEVER touches the live worktree or index.
 *
 * Boundary source is the PHYSICAL boundary (`cp.<phase>_snapshot`).
 * When a stored manifest's fingerprint window differs (empty-fence
 * recovery pinned a baseline open tree), the output carries an
 * informational `note` — the physical state is never silently
 * substituted with the fingerprint window.
 *
 * Default location: `checkoutsRoot(env)` — cache-classified
 * (CACHEDIR.TAG at the ROOT only; a checkout itself must mirror the
 * pinned tree exactly) — under a `<artifact8>-cp<n>-<phase>-<uuid>`
 * dir. Cleanup: `git worktree remove --force <dir>` (or `rm -rf` +
 * a later `git worktree prune`).
 *
 * Materializing a snapshot writes UNTRACKED-file content that `git add -A`
 * captured — the same privacy delta the diff path discloses, but larger: a
 * whole tree rather than a two-tree delta, and into a destination outside the
 * repository where its ignore rules do not reach. Paths matching
 * `capture.exclude` are listed before the write.
 */
export async function snapshotsCheckoutAction(opts: SnapshotsCheckoutOptions): Promise<void> {
  opts = { ...opts };
  try {
    if (typeof opts.artifact !== 'string' || opts.artifact.length === 0) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '--artifact <id> is required.', 'artifact');
    }
    if (!Number.isInteger(opts.checkpoint) || opts.checkpoint <= 0) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--checkpoint <n> must be a positive integer.',
        'checkpoint'
      );
    }
    if (opts.phase !== undefined && !BOUNDARY_PHASES.includes(opts.phase as BoundaryPhase)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--phase must be one of open|close|abandon (got "${opts.phase}").`,
        'phase'
      );
    }

    const ctx = await resolveDatabaseHistoryCommandContext({ profile: 'exact' });
    try {
      const target = resolveDatabaseHistoryArtifact(ctx.scope, opts.artifact);
      opts.artifact = target.artifactId;
      const repo = snapshotRepository(ctx, target.authority.repositoryInstanceId);
      const gitEnv = historyGitEnvironment();
      const cp =
        target.artifact.thread.checkpoints.find((checkpoint) => checkpoint.n === opts.checkpoint) ??
        null;
      if (cp === null) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `No checkpoint #${opts.checkpoint} for artifact "${opts.artifact}".`,
          'checkpoint'
        );
      }

      const phase = (opts.phase as BoundaryPhase | undefined) ?? defaultPhaseForStatus(cp.status);
      const boundary = requireBoundary(cp, phase, opts.artifact);
      // requireBoundary narrows both to non-null; keep locals for clarity.
      const commitSha = boundary.snapshot_commit_sha as string;

      // Manifest-window divergence note (closed cps only). A manifest
      // integrity error is show/derive territory — the PHYSICAL boundary
      // checkout proceeds regardless.
      let note: string | undefined;
      if (cp.status === 'closed') {
        const manifest = await retainedCheckpointManifest(target.artifact.thread, cp);
        if (
          manifest !== null &&
          (manifest.open_tree_sha !== cp.open_snapshot.tree_sha ||
            manifest.close_tree_sha !== cp.close_snapshot.tree_sha)
        ) {
          note =
            `stored manifest's fingerprint window (${manifest.open_tree_sha.slice(0, 12)}..` +
            `${manifest.close_tree_sha.slice(0, 12)}) differs from the physical snapshot ` +
            `boundaries (empty-fence recovery). This checkout materializes the PHYSICAL ` +
            `"${phase}" boundary tree.`;
        }
      }

      let dir: string;
      if (opts.into !== undefined && opts.into.length > 0) {
        dir = path.resolve(opts.into);
      } else {
        const root = checkoutsRoot(getInvocationEnv());
        await writeCachedirTag(root); // ensureDir0700 + CACHEDIR.TAG at the ROOT only
        dir = path.join(root, `${opts.artifact.slice(0, 8)}-cp${cp.n}-${phase}-${uuidv7()}`);
      }

      // Disclose before writing. `git worktree add` is atomic with no
      // interception point, and deleting after materialization is a
      // time-of-check race that would also make `git status --short` inside
      // the scratch dir report deletions the user never made — in a directory
      // the timetravel skill tells an agent to work in. So the honest control
      // is to say what is about to land, not to quietly alter it.
      //
      // Refs pinned before capture.exclude existed still carry whatever they
      // captured; this is how a user finds that out before running an install
      // in that tree.
      // A boundary with no recorded tree discloses nothing rather than
      // guessing from the commit — same fail-open posture as the probe itself.
      const sensitivePaths =
        boundary.tree_sha === null
          ? []
          : await listSensitiveTreePaths(
              repo,
              boundary.tree_sha,
              resolveCaptureExcludes(ctx.config.capture).patterns,
              gitEnv
            );

      const result = await materializeSnapshotTree(repo, commitSha, dir, { env: gitEnv });
      if (!result.ok) {
        if (result.error_reason === 'commit_unreachable') {
          throw new OrcaopsError(
            ErrorCodes.SNAPSHOT_UNAVAILABLE,
            prunedBoundaryMessage(commitSha.slice(0, 12), cp.n, phase),
            'checkpoint'
          );
        }
        if (result.error_reason === 'target_not_empty') {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `--into ${dir} exists and is not empty.`,
            'into'
          );
        }
        throw new OrcaopsError(
          ErrorCodes.SNAPSHOT_UNAVAILABLE,
          `git worktree add failed for checkpoint #${cp.n} phase "${phase}": ` +
            `${result.error_message ?? 'unknown error'}`,
          'checkpoint'
        );
      }

      const cleanup = `git worktree remove --force ${result.dir}`;
      if (opts.json) {
        emitOk({
          artifact: opts.artifact,
          checkpoint: cp.n,
          phase,
          dir: result.dir,
          snapshot_ref: boundary.snapshot_ref,
          tree_sha: boundary.tree_sha,
          snapshot_commit_sha: commitSha,
          sensitive_paths: sensitivePaths,
          sensitive_path_count: sensitivePaths.length,
          cleanup,
          ...(note !== undefined ? { note } : {}),
        });
        return;
      }
      const lines = [
        `Materialized artifact ${opts.artifact} checkpoint #${cp.n} (${phase}) into:`,
        `  ${result.dir}`,
        '',
        `  tree_sha:  ${boundary.tree_sha}`,
        `  ref:       ${boundary.snapshot_ref ?? '(none)'}`,
        ...(note !== undefined ? [`  note:      ${note}`] : []),
        ...(sensitivePaths.length > 0
          ? [
              '',
              `Sensitive paths written (${sensitivePaths.length}):`,
              ...sensitivePaths.map((p) => `  ${p}`),
              '  These match capture.exclude in the tree this checkpoint recorded.',
              '  Exclusion applies to untracked files at capture time, so a match is',
              '  here either because it is tracked — in which case it will be listed',
              '  on every checkout — or because the snapshot predates the pattern.',
              '  The destination above is outside the repository, so its .gitignore',
              '  does not cover them.',
            ]
          : []),
        '',
        `Cleanup: ${cleanup}`,
        '  (rm -rf + a later `git worktree prune` also works)',
        'Caveats: full tree even under sparse-checkout; submodules materialize as empty dirs;',
        '  LFS pointers smudge only if local LFS objects exist.',
        '',
      ];
      writeTerminalSafeStdout(lines.join('\n'));
    } finally {
      ctx.scope.close();
    }
  } catch (cause) {
    const err = historyScopeCommandError(cause);
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

// ── snapshots diff ─────────────────────────────────────────────────────

/** One side of a `snapshots diff` range: a checkpoint or the plan-time baseline. */
type DiffEndpoint = { kind: 'checkpoint'; n: number } | { kind: 'baseline' };

type ParsedDiffRange =
  | { form: 'single'; n: number }
  | { form: 'range'; from: DiffEndpoint; to: DiffEndpoint };

/**
 * Parse the positional range argument: `<n>` (one checkpoint's window) or
 * `<from>..<to>` where each side is a checkpoint number or the literal
 * `baseline` (the artifact's plan-time seed). `baseline..baseline` is
 * refused — it can only ever be empty.
 */
export function parseDiffRange(range: string): ParsedDiffRange {
  if (/^\d+$/.test(range)) {
    const n = parseDigitInt(range) ?? 0;
    if (n > 0) return { form: 'single', n };
  }
  const m = /^(baseline|\d+)\.\.(baseline|\d+)$/.exec(range);
  if (m) {
    const parse = (s: string): DiffEndpoint =>
      s === 'baseline' ? { kind: 'baseline' } : { kind: 'checkpoint', n: parseDigitInt(s) ?? 0 };
    const from = parse(m[1]);
    const to = parse(m[2]);
    if (from.kind === 'baseline' && to.kind === 'baseline') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'baseline..baseline is always empty — pick at least one checkpoint endpoint.',
        'range'
      );
    }
    if ((from.kind === 'checkpoint' && from.n <= 0) || (to.kind === 'checkpoint' && to.n <= 0)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Checkpoint endpoints must be positive integers.',
        'range'
      );
    }
    return { form: 'range', from, to };
  }
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `Invalid range "${range}" — expected <n> or <from>..<to> where each side is a ` +
      `checkpoint number or "baseline".`,
    'range'
  );
}

/**
 * Trim a byte-capped buffer back to a valid UTF-8 boundary: the raw cap
 * (`runGit` slices at exactly `maxStdoutBytes`) can split a multibyte
 * character, which would decode to U+FFFD garbage in the JSON `diff`
 * field. Scans back at most 3 bytes for a lead byte and drops the
 * trailing char if its continuation bytes were cut off.
 */
export function trimToUtf8Boundary(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  // Find the last lead byte within the final 4 bytes.
  let i = buf.length - 1;
  const stop = Math.max(0, buf.length - 4);
  while (i > stop && (buf[i] & 0xc0) === 0x80) i--;
  const lead = buf[i];
  const expected = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i < expected ? buf.subarray(0, i) : buf;
}

/**
 * Bytes read beyond `max_diff_bytes` so a secret sitting ACROSS the cap is
 * whole when the redactor runs, and gets marked in place rather than cut.
 *
 * This is an optimization for the common case, not the safety property. It is
 * deliberately NOT sized to the longest possible match — PEM and
 * service-account bodies have no upper bound, so no fixed overlap could be.
 * Anything the final trim severs is handled by `cutTruncatedSecretTail`.
 */
const SECRET_STRADDLE_OVERLAP_BYTES = 4096;

/**
 * Trim the over-read, already-redacted diff back to the configured cap, then
 * drop whatever that trim severed mid-secret.
 */
export function trimRedactedToCap(text: string, cap: number, redacting: boolean): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= cap) return text;
  const out = trimToUtf8Boundary(buf.subarray(0, cap)).toString('utf8');
  return redacting ? cutTruncatedSecretTail(out) : out;
}

/**
 * Keep the pipe path byte-exact even when a text diff contains invalid UTF-8.
 * The secret corpus is ASCII, so latin1 is a one-code-unit-per-byte carrier
 * that lets the shared redactor replace matches without decoding other bytes.
 */
export function preparePipedDiff(
  raw: Buffer,
  cap: number,
  redacting: boolean
): { bytes: Buffer; trimmed: boolean } {
  const scrubbed = redacting
    ? Buffer.from(redactSecretsInString(raw.toString('latin1')), 'latin1')
    : raw;
  if (scrubbed.byteLength <= cap) return { bytes: scrubbed, trimmed: false };

  const capped = scrubbed.subarray(0, cap);
  if (!redacting) return { bytes: capped, trimmed: true };
  return {
    bytes: Buffer.from(cutTruncatedSecretTail(capped.toString('latin1')), 'latin1'),
    trimmed: true,
  };
}

export interface SnapshotsDiffOptions {
  artifact: string;
  range: string;
  fromPhase?: string;
  toPhase?: string;
  json?: boolean;
}

interface ResolvedEndpoint {
  kind: 'checkpoint' | 'baseline';
  checkpoint?: number;
  phase?: BoundaryPhase;
  /** Tree (checkpoint boundaries) or commit (baseline) — git diff peels both. */
  sha: string;
  ref: string | null;
}

/**
 * `orcaops snapshots diff --artifact <id> <n>|<from>..<to>
 *   [--from-phase X] [--to-phase Y] [--json]`
 *
 * Raw diff between two checkpoint boundaries. Endpoint
 * defaults per the endpoint-resolution rules: single `<n>` is the
 * cp's window (open → close|abandon by status; error while still open);
 * range endpoints default to each cp's finalized phase.
 *
 * Tree authority: endpoints resolve from PHYSICAL boundaries, EXCEPT the
 * single-cp open..close window of a closed cp with a stored manifest —
 * there the manifest's trees are authoritative (derive parity: a
 * recovered manifest's window IS the cp's fingerprint window), disclosed
 * via `tree_source` + a divergence note.
 *
 * Output boundary: this diff is RAW TEXT computed from live local trees
 * — fine and deliberately distinct from the hash-only fingerprint paths.
 * Snapshot trees include UNTRACKED-file content (captured via `add -A`),
 * a privacy delta vs plain `git diff` — stated here, and the text passes
 * through the standard output redaction when `digest.redact_secrets` is
 * on. Byte-capped by `diff_fingerprint.max_diff_bytes`; the capped tail
 * is trimmed to a valid UTF-8 boundary.
 */
export async function snapshotsDiffAction(opts: SnapshotsDiffOptions): Promise<void> {
  opts = { ...opts };
  try {
    if (typeof opts.artifact !== 'string' || opts.artifact.length === 0) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '--artifact <id> is required.', 'artifact');
    }
    for (const [flag, value] of [
      ['from-phase', opts.fromPhase],
      ['to-phase', opts.toPhase],
    ] as const) {
      if (value !== undefined && !BOUNDARY_PHASES.includes(value as BoundaryPhase)) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--${flag} must be one of open|close|abandon (got "${value}").`,
          flag
        );
      }
    }
    const parsed = parseDiffRange(opts.range);

    const ctx = await resolveDatabaseHistoryCommandContext({ profile: 'exact' });
    try {
      const target = resolveDatabaseHistoryArtifact(ctx.scope, opts.artifact);
      opts.artifact = target.artifactId;
      const thread = target.artifact.thread;
      const repo = snapshotRepository(ctx, target.authority.repositoryInstanceId);
      const gitEnv = historyGitEnvironment();

      const readCp = (n: number): Checkpoint => {
        const cp = thread.checkpoints.find((checkpoint) => checkpoint.n === n) ?? null;
        if (cp === null) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `No checkpoint #${n} for artifact "${opts.artifact}".`,
            'range'
          );
        }
        return cp;
      };

      const resolveCheckpointEndpoint = async (
        n: number,
        explicitPhase: string | undefined
      ): Promise<ResolvedEndpoint> => {
        const cp = await readCp(n);
        const phase =
          (explicitPhase as BoundaryPhase | undefined) ?? defaultPhaseForStatus(cp.status);
        const boundary = requireBoundary(cp, phase, opts.artifact);
        return {
          kind: 'checkpoint',
          checkpoint: n,
          phase,
          sha: boundary.tree_sha as string,
          ref: boundary.snapshot_ref,
        };
      };

      const resolveBaselineEndpoint = async (
        explicitPhase: string | undefined,
        side: 'from' | 'to'
      ): Promise<ResolvedEndpoint> => {
        if (explicitPhase !== undefined) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `--${side}-phase does not apply to the baseline endpoint.`,
            `${side}-phase`
          );
        }
        const ref = null;
        const sha = thread.artifactJson?.baseline_seed_tree_sha ?? null;
        if (sha === null) {
          throw new OrcaopsError(
            ErrorCodes.SNAPSHOT_UNAVAILABLE,
            `No plan-time baseline for "${opts.artifact}" — it was never retained, or its ` +
              `Git objects are unavailable. Salvage fallback: try ` +
              `the prior checkpoint's close boundary, or \`snapshots checkout\` the abandon ` +
              `tree without a diff.`,
            'range'
          );
        }
        return { kind: 'baseline', sha, ref };
      };

      let from: ResolvedEndpoint;
      let to: ResolvedEndpoint;
      let treeSource: 'stored_manifest_trees' | 'snapshot_boundaries' = 'snapshot_boundaries';
      let note: string | undefined;

      if (parsed.form === 'single') {
        const cp = await readCp(parsed.n);
        if (cp.status === 'open') {
          throw new OrcaopsError(
            ErrorCodes.SNAPSHOT_UNAVAILABLE,
            `Checkpoint #${parsed.n} is still open — its window has no finalized end ` +
              `boundary yet. Close or abandon it first, or diff explicit endpoints.`,
            'range'
          );
        }
        const fromPhase = (opts.fromPhase as BoundaryPhase | undefined) ?? 'open';
        const toPhase =
          (opts.toPhase as BoundaryPhase | undefined) ?? defaultPhaseForStatus(cp.status);
        const fromBoundary = requireBoundary(cp, fromPhase, opts.artifact);
        const toBoundary = requireBoundary(cp, toPhase, opts.artifact);
        from = {
          kind: 'checkpoint',
          checkpoint: parsed.n,
          phase: fromPhase,
          sha: fromBoundary.tree_sha as string,
          ref: fromBoundary.snapshot_ref,
        };
        to = {
          kind: 'checkpoint',
          checkpoint: parsed.n,
          phase: toPhase,
          sha: toBoundary.tree_sha as string,
          ref: toBoundary.snapshot_ref,
        };

        // Derive parity: for a closed cp's open..close window, a stored
        // manifest's trees are authoritative (empty-fence recovery may
        // have pinned a baseline open tree ≠ the physical boundary).
        if (cp.status === 'closed' && fromPhase === 'open' && toPhase === 'close') {
          const manifest = await retainedCheckpointManifest(thread, cp);
          if (cp.diff_fingerprint_summary.manifest_hash !== null && manifest === null) {
            throw new OrcaopsError(
              ErrorCodes.EVENT_LOG_CORRUPT,
              `Checkpoint #${parsed.n} declares retained fingerprint evidence that cannot be loaded. ` +
                'Run `orcaops doctor` and preserve the database for explicit repair.',
              'range'
            );
          }
          if (manifest !== null) {
            treeSource = 'stored_manifest_trees';
            if (manifest.open_tree_sha !== from.sha || manifest.close_tree_sha !== to.sha) {
              note =
                `manifest fingerprint window differs from the physical snapshot boundaries ` +
                `(empty-fence recovery) — diffing the manifest window ` +
                `${manifest.open_tree_sha.slice(0, 12)}..${manifest.close_tree_sha.slice(0, 12)}.`;
            }
            from.sha = manifest.open_tree_sha;
            to.sha = manifest.close_tree_sha;
          }
        }
      } else {
        from =
          parsed.from.kind === 'baseline'
            ? await resolveBaselineEndpoint(opts.fromPhase, 'from')
            : await resolveCheckpointEndpoint(parsed.from.n, opts.fromPhase);
        to =
          parsed.to.kind === 'baseline'
            ? await resolveBaselineEndpoint(opts.toPhase, 'to')
            : await resolveCheckpointEndpoint(parsed.to.n, opts.toPhase);
      }

      const cap = ctx.config.diff_fingerprint.max_diff_bytes;
      const diff = await diffSnapshotTrees({
        repo,
        openTreeSha: from.sha,
        closeTreeSha: to.sha,
        // Read a bounded overlap PAST the cap so redaction sees whole
        // secrets. Capping first and redacting after (what this did) lets a
        // secret straddling the cut be shortened below its pattern's minimum
        // length and emitted as an unmatched prefix. The overlap is a fixed
        // small constant, so the memory bound moves by a known amount.
        maxDiffBytes: cap + SECRET_STRADDLE_OVERLAP_BYTES,
        env: gitEnv,
      });
      if (!diff.ok) {
        throw new OrcaopsError(
          ErrorCodes.SNAPSHOT_UNAVAILABLE,
          `git diff ${from.sha.slice(0, 12)}..${to.sha.slice(0, 12)} failed — one or both ` +
            `endpoint trees are unreachable or unavailable. A retired publication may have ` +
            `been pruned with \`orcaops snapshots prune\` or \`orcaops gc\`; this boundary can ` +
            `no longer be diffed.`,
          'range'
        );
      }

      const raw = Buffer.from(diff.diff);
      if (!opts.json && !process.stdout.isTTY) {
        const piped = preparePipedDiff(raw, cap, ctx.config.digest.redact_secrets);
        const truncated = diff.truncated || piped.trimmed;
        writePipeFriendlyStdout(piped.bytes);
        if (truncated) {
          writeTerminalSafeStderr(
            `\n[snapshots diff] truncated at diff_fingerprint.max_diff_bytes=${cap}\n`
          );
        }
        if (note !== undefined) {
          writeTerminalSafeStderr(`[snapshots diff] note: ${note}\n`);
        }
        return;
      }

      const text = (diff.truncated ? trimToUtf8Boundary(raw) : raw).toString('utf8');
      // Redact the OVER-READ text, then trim to the configured cap — in that
      // order, so a secret spanning the cap boundary is matched whole.
      const scrubbed = ctx.config.digest.redact_secrets ? redactSecretsInString(text) : text;
      const redacted = trimRedactedToCap(scrubbed, cap, ctx.config.digest.redact_secrets);
      // Both describe what is actually EMITTED, not the over-read: the reader
      // is asked for `cap + overlap` bytes purely so redaction sees whole
      // secrets, so its own truncation flag understates by that overlap.
      const byteCount = Buffer.byteLength(redacted, 'utf8');
      const truncated = diff.truncated || byteCount < Buffer.byteLength(scrubbed, 'utf8');

      if (opts.json) {
        emitOk({
          artifact: opts.artifact,
          from: { kind: from.kind, checkpoint: from.checkpoint, phase: from.phase, ref: from.ref },
          to: { kind: to.kind, checkpoint: to.checkpoint, phase: to.phase, ref: to.ref },
          from_sha: from.sha,
          to_sha: to.sha,
          tree_source: treeSource,
          truncated,
          byte_count: byteCount,
          diff: redacted,
          ...(note !== undefined ? { note } : {}),
        });
        return;
      }

      // Human mode: stdout carries ONLY the diff text (pipe-friendly);
      // metadata goes to stderr so it never corrupts a piped patch.
      writePipeFriendlyStdout(redacted);
      if (truncated) {
        writeTerminalSafeStderr(
          `\n[snapshots diff] truncated at diff_fingerprint.max_diff_bytes=${cap}\n`
        );
      }
      if (note !== undefined) {
        writeTerminalSafeStderr(`[snapshots diff] note: ${note}\n`);
      }
    } finally {
      ctx.scope.close();
    }
  } catch (cause) {
    const err = historyScopeCommandError(cause);
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
