import {
  buildDiffFingerprintManifest,
  computeDiffFingerprintManifestHash,
  diffSnapshotTrees,
  Repo,
  summarizeManifest,
} from '@orcaops/core';
import { resolveDatabaseHistoryArtifact } from '@orcaops/project-scope/history/database';
import {
  type DiffFingerprintManifest,
  replayAttributionDegradedRemovals,
  replayWindowOverlapRemovals,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { retainedCheckpointManifest } from '../lib/database-manifest-sources.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import { getInvocationEnv } from '../lib/invocation-context.js';

export interface FingerprintShowOptions {
  artifact: string;
  checkpoint: number;
  json?: boolean;
}

/** A declared manifest hash requires retained evidence; absence is never a benign skip. */
export async function fingerprintShowAction(opts: FingerprintShowOptions): Promise<void> {
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

    const ctx = await resolveDatabaseHistoryCommandContext({ profile: 'exact' });
    try {
      const target = resolveDatabaseHistoryArtifact(ctx.scope, opts.artifact);
      opts.artifact = target.artifactId;
      const thread = target.artifact.thread;
      const cp = thread.checkpoints.find((checkpoint) => checkpoint.n === opts.checkpoint) ?? null;
      if (cp === null) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `No checkpoint #${opts.checkpoint} for artifact "${opts.artifact}".`,
          'checkpoint'
        );
      }
      if (cp.status !== 'closed') {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Checkpoint #${opts.checkpoint} is ${cp.status}, not closed — no fingerprint to show.`,
          'checkpoint'
        );
      }

      const summary = cp.diff_fingerprint_summary;
      const manifest = await retainedCheckpointManifest(thread, cp);

      if (summary.manifest_hash === null) {
        if (summary.status !== 'skipped') {
          // captured/empty/truncated ALWAYS carry a non-null hash; a
          // null hash on a non-skipped status is corrupt projection
          // state, not a benign skip.
          throw new OrcaopsError(
            ErrorCodes.EVENT_LOG_CORRUPT,
            `Checkpoint #${opts.checkpoint} has status "${summary.status}" but a null manifest_hash — ` +
              `corrupt fingerprint state. Run \`orcaops doctor\` and preserve the database for explicit repair.`,
            'checkpoint'
          );
        }
        // Benign deliberate-skip / capture-failure: render the summary.
        renderSkipped(opts, cp.n, summary);
        return;
      }

      if (manifest === null) {
        throw new OrcaopsError(
          ErrorCodes.EVENT_LOG_CORRUPT,
          `Checkpoint #${opts.checkpoint} declares manifest_hash ${summary.manifest_hash} but its ` +
            `diff-fingerprint manifest could not be loaded (missing or inconsistent retained event payload). Run \`orcaops doctor\` and preserve the database for explicit repair.`,
          'checkpoint'
        );
      }

      renderManifest(opts, cp.n, cp.open_snapshot, cp.close_snapshot, summary, manifest);
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

type SnapshotBoundary = {
  snapshot_ref: string | null;
  tree_sha: string | null;
  snapshot_commit_sha: string | null;
  snapshot_error_reason: string | null;
};

type FingerprintSummary = {
  status: 'captured' | 'empty' | 'truncated' | 'skipped';
  hunk_count: number;
  captured_hunk_count: number;
  truncated: boolean;
  fingerprint_algorithm: string | null;
  manifest_hash: string | null;
  manifest_hash_algorithm: string | null;
  error_reason: string | null;
};

function renderSkipped(opts: FingerprintShowOptions, n: number, summary: FingerprintSummary): void {
  if (opts.json) {
    emitOk({
      artifact: opts.artifact,
      checkpoint: n,
      summary,
      manifest: null,
      note: `no manifest captured (status: ${summary.status}, error_reason: ${summary.error_reason ?? 'null'})`,
    });
    return;
  }
  const lines = [
    `Fingerprint — artifact ${opts.artifact} checkpoint #${n}`,
    `  status:        ${summary.status}`,
    `  error_reason:  ${summary.error_reason ?? '(none)'}`,
    `  manifest:      (none captured)`,
    '',
  ];
  writeTerminalSafeStdout(lines.join('\n'));
}

function renderManifest(
  opts: FingerprintShowOptions,
  n: number,
  openSnap: SnapshotBoundary,
  closeSnap: SnapshotBoundary,
  summary: FingerprintSummary,
  manifest: DiffFingerprintManifest
): void {
  if (opts.json) {
    // The manifest is hashes + metadata only (no raw text field exists
    // in the schema); pass it through verbatim.
    emitOk({
      artifact: opts.artifact,
      checkpoint: n,
      open_snapshot: openSnap,
      close_snapshot: closeSnap,
      summary,
      manifest,
    });
    return;
  }

  const lines: string[] = [];
  lines.push(`Fingerprint — artifact ${opts.artifact} checkpoint #${n}`);
  lines.push(`  status:                 ${summary.status}`);
  lines.push(
    `  hunks:                  ${summary.captured_hunk_count}/${summary.hunk_count}` +
      (summary.truncated ? ' (truncated)' : '')
  );
  lines.push(`  manifest_hash:          ${summary.manifest_hash}`);
  lines.push(`  manifest_hash_algo:     ${summary.manifest_hash_algorithm ?? '(none)'}`);
  lines.push(`  fingerprint_algorithm:  ${summary.fingerprint_algorithm ?? '(none)'}`);
  lines.push(`  line_hash_algorithm:    ${manifest.line_hash_algorithm}`);
  lines.push(`  patch_hash_algorithm:   ${manifest.patch_hash_algorithm}`);
  lines.push(`  normalization_version:  ${manifest.normalization_version}`);
  lines.push(`  diff_algorithm:         ${manifest.diff_algorithm}`);
  lines.push(`  open_tree_sha:          ${manifest.open_tree_sha}`);
  lines.push(`  close_tree_sha:         ${manifest.close_tree_sha}`);
  lines.push(`  open_snapshot_ref:      ${openSnap.snapshot_ref ?? '(none)'}`);
  lines.push(`  close_snapshot_ref:     ${closeSnap.snapshot_ref ?? '(none)'}`);
  lines.push('');
  lines.push(`Hunks (${manifest.hunks.length}):`);
  for (const h of manifest.hunks) {
    const file =
      h.file_before === h.file_after
        ? (h.file_after ?? '(none)')
        : `${h.file_before ?? '(none)'} → ${h.file_after ?? '(none)'}`;
    lines.push(
      `  #${h.hunk_index} ${h.change_type}${h.binary ? ' [binary]' : ''} ${file}` +
        `  +${h.added_line_count}/-${h.deleted_line_count}  patch_hash=${h.patch_hash}`
    );
  }
  lines.push('');
  writeTerminalSafeStdout(lines.join('\n'));
}

export interface FingerprintDeriveOptions {
  artifact: string;
  checkpoint: number;
  json?: boolean;
}

/** Stored manifest trees can differ from checkpoint boundaries after recovery. */
export async function fingerprintDeriveAction(opts: FingerprintDeriveOptions): Promise<void> {
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

    const ctx = await resolveDatabaseHistoryCommandContext({ profile: 'exact' });
    try {
      const target = resolveDatabaseHistoryArtifact(ctx.scope, opts.artifact);
      opts.artifact = target.artifactId;
      const thread = target.artifact.thread;
      const cp = thread.checkpoints.find((checkpoint) => checkpoint.n === opts.checkpoint) ?? null;
      if (cp === null) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `No checkpoint #${opts.checkpoint} for artifact "${opts.artifact}".`,
          'checkpoint'
        );
      }
      if (cp.status !== 'closed') {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Checkpoint #${opts.checkpoint} is ${cp.status}, not closed — only a closed ` +
            `checkpoint has capture-time trees to derive from.`,
          'checkpoint'
        );
      }

      const summary = cp.diff_fingerprint_summary;
      const manifest = await retainedCheckpointManifest(thread, cp);

      // Strict-manifest integrity, mirroring `show`: a non-null
      // stored hash whose manifest cannot load is corrupt state — deriving from
      // the cp's own boundaries could silently disagree with a RECOVERED
      // manifest's baseline open tree, so refuse rather than mislead.
      if (summary.manifest_hash !== null && manifest === null) {
        throw new OrcaopsError(
          ErrorCodes.EVENT_LOG_CORRUPT,
          `Checkpoint #${opts.checkpoint} declares manifest_hash ${summary.manifest_hash} but its ` +
            `diff-fingerprint manifest could not be loaded (missing or inconsistent retained event payload). Run ` +
            `\`orcaops doctor\` and preserve the database for explicit repair.`,
          'checkpoint'
        );
      }
      if (summary.manifest_hash === null && summary.status !== 'skipped') {
        throw new OrcaopsError(
          ErrorCodes.EVENT_LOG_CORRUPT,
          `Checkpoint #${opts.checkpoint} has status "${summary.status}" but a null manifest_hash — ` +
            `corrupt fingerprint state. Run \`orcaops doctor\` and preserve the database for explicit repair.`,
          'checkpoint'
        );
      }

      // Tree selection: stored-manifest trees are authoritative (recovery may
      // have pinned a baseline open tree); fall back to the cp boundaries only
      // when no manifest exists (skipped capture with pinned snapshots).
      const source = manifest !== null ? 'stored_manifest_trees' : 'snapshot_boundaries';
      const openTreeSha = manifest !== null ? manifest.open_tree_sha : cp.open_snapshot.tree_sha;
      const closeTreeSha = manifest !== null ? manifest.close_tree_sha : cp.close_snapshot.tree_sha;

      if (openTreeSha === null || closeTreeSha === null) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Checkpoint #${opts.checkpoint} has no derivable trees: fingerprint capture was ` +
            `skipped (reason: ${summary.error_reason ?? 'deliberate skip — diff_fingerprint disabled'}) ` +
            `and no snapshot trees were pinned.`,
          'checkpoint'
        );
      }

      const cap = ctx.config.diff_fingerprint.max_diff_bytes;
      const diff = await diffSnapshotTrees({
        repo: fingerprintRepository(ctx, target.authority.repositoryInstanceId),
        openTreeSha,
        closeTreeSha,
        maxDiffBytes: cap,
      });
      if (!diff.ok) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `git diff ${openTreeSha.slice(0, 12)}..${closeTreeSha.slice(0, 12)} failed — one or both ` +
            `trees are unavailable. Run \`orcaops doctor\` and preserve history for explicit repair.`,
          'checkpoint'
        );
      }

      const derived = await buildDiffFingerprintManifest({
        artifactId: opts.artifact,
        checkpointN: opts.checkpoint,
        openTreeSha,
        closeTreeSha,
        diffBytes: diff.diff,
        truncated: diff.truncated,
        maxDiffBytes: cap,
      });

      // For a close that carried a window_overlap partition,
      // the re-derived manifest is the UNFILTERED fence diff but close
      // persisted the FILTERED pair — replay EXACTLY the recorded
      // removals (dropped_files in all statuses + rejected claims,
      // dual-path) before hashing. Deterministic replay, never
      // re-adjudication; kept-but-flagged files remain (removing them
      // here would itself create false drift).
      let derivedManifest = derived.manifest;
      let derivedSummary = derived.summary;
      if (cp.window_overlap !== undefined && derivedManifest !== null) {
        const replayed = replayWindowOverlapRemovals(derivedManifest, cp.window_overlap);
        if (replayed !== derivedManifest) {
          const replayedHash = await computeDiffFingerprintManifestHash(replayed);
          derivedManifest = replayed;
          derivedSummary = summarizeManifest(replayed, replayedHash);
        }
      }
      // Second removal class: an unmerged-degraded close persisted the
      // manifest with the degraded union's hunks excluded — replay that
      // exclusion too, same doctrine as the overlap replay above.
      if (cp.attribution_degraded !== undefined && derivedManifest !== null) {
        const replayed = replayAttributionDegradedRemovals(
          derivedManifest,
          cp.attribution_degraded.unmerged_paths
        );
        if (replayed !== derivedManifest) {
          const replayedHash = await computeDiffFingerprintManifestHash(replayed);
          derivedManifest = replayed;
          derivedSummary = summarizeManifest(replayed, replayedHash);
        }
      }

      let verified: boolean | null;
      let note: string | undefined;
      if (summary.manifest_hash === null) {
        verified = null;
        note =
          `capture-time fingerprint was skipped (reason: ` +
          `${summary.error_reason ?? 'null'}) — nothing stored to compare; the derived ` +
          `summary is fresh output.`;
      } else {
        verified = derivedSummary.manifest_hash === summary.manifest_hash;
        if (!verified && derivedSummary.truncated !== summary.truncated) {
          note =
            `truncation mismatch (stored truncated=${summary.truncated}, derived ` +
            `truncated=${derived.summary.truncated}) — the current diff_fingerprint.max_diff_bytes ` +
            `(${cap}) likely differs from the capture-time cap; the mismatch may not be content drift.`;
        } else if (!verified) {
          note =
            `derived manifest_hash does not reproduce the stored hash — content drift between ` +
            `the pinned trees and the capture-time manifest.`;
        }
        if (!verified && derivedSummary.truncated === summary.truncated) {
          note =
            cp.window_overlap !== undefined
              ? `${note} (window-overlap replay of ${cp.window_overlap.dropped_files.length} ` +
                `dropped file record(s) + ${cp.window_overlap.rejected_claims.length} rejected ` +
                `claim(s) was applied before comparing)`
              : note;
        }
      }

      renderDerived(opts, cp.n, {
        source,
        open_tree_sha: openTreeSha,
        close_tree_sha: closeTreeSha,
        stored: {
          status: summary.status,
          manifest_hash: summary.manifest_hash,
          hunk_count: summary.hunk_count,
          truncated: summary.truncated,
        },
        derived: {
          status: derivedSummary.status,
          manifest_hash: derivedSummary.manifest_hash,
          hunk_count: derivedSummary.hunk_count,
          captured_hunk_count: derivedSummary.captured_hunk_count,
          truncated: derivedSummary.truncated,
        },
        verified,
        note,
      });
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

interface DerivedView {
  source: 'stored_manifest_trees' | 'snapshot_boundaries';
  open_tree_sha: string;
  close_tree_sha: string;
  stored: {
    status: string;
    manifest_hash: string | null;
    hunk_count: number;
    truncated: boolean;
  };
  derived: {
    status: string;
    manifest_hash: string | null;
    hunk_count: number;
    captured_hunk_count: number;
    truncated: boolean;
  };
  verified: boolean | null;
  note: string | undefined;
}

function renderDerived(opts: FingerprintDeriveOptions, n: number, view: DerivedView): void {
  if (opts.json) {
    const { note, ...rest } = view;
    emitOk({
      artifact: opts.artifact,
      checkpoint: n,
      ...rest,
      ...(note !== undefined ? { note } : {}),
    });
    return;
  }
  const lines = [
    `Fingerprint derive — artifact ${opts.artifact} checkpoint #${n}`,
    `  verified:        ${view.verified === null ? 'null (nothing stored to compare)' : view.verified}`,
    `  tree source:     ${view.source}`,
    `  open_tree_sha:   ${view.open_tree_sha}`,
    `  close_tree_sha:  ${view.close_tree_sha}`,
    `  stored:          status=${view.stored.status} hunks=${view.stored.hunk_count}` +
      `${view.stored.truncated ? ' (truncated)' : ''} manifest_hash=${view.stored.manifest_hash ?? '(none)'}`,
    `  derived:         status=${view.derived.status} hunks=${view.derived.captured_hunk_count}/${view.derived.hunk_count}` +
      `${view.derived.truncated ? ' (truncated)' : ''} manifest_hash=${view.derived.manifest_hash ?? '(none)'}`,
    ...(view.note !== undefined ? [`  note:            ${view.note}`] : []),
    '',
  ];
  writeTerminalSafeStdout(lines.join('\n'));
}

function fingerprintRepository(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  repositoryInstanceId: string
): Repo {
  const git = context.scope.gitContext;
  if (!git || git.repositoryInstanceId !== repositoryInstanceId)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Open the artifact repository to derive its retained snapshot fingerprint.'
    );
  return new Repo(git.worktreeRoot, {
    env: {
      ...Object.fromEntries(
        Object.entries(getInvocationEnv()).filter(([key]) => !key.startsWith('GIT_'))
      ),
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1',
    },
  });
}
