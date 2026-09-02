import {
  buildDiffFingerprintManifest,
  computeDiffFingerprintManifestHash,
  diffSnapshotTrees,
  summarizeManifest,
} from '@orcaops/core';
import {
  type DiffFingerprintManifest,
  replayAttributionDegradedRemovals,
  replayWindowOverlapRemovals,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { buildContext } from '../lib/context.js';
import { readDerivedCache, writeDerivedCache } from '../lib/fingerprint-cache.js';

export interface FingerprintShowOptions {
  artifact: string;
  checkpoint: number;
  json?: boolean;
}

/**
 * `orcaops fingerprint show --artifact <id> --checkpoint <n> [--json]`
 *
 * Read-only inspection of a closed checkpoint's diff-fingerprint:
 * status / counts / algorithm identifiers / manifest_hash / tree SHAs /
 * snapshot refs / per-hunk anchors + hashes.
 *
 * It NEVER prints raw diff / patch / line text — and structurally
 * cannot: the `DiffFingerprintManifest` schema carries only hashes,
 * file paths, line ranges, and counts. An
 * output-guard test asserts the rendered output never contains a
 * unified-diff marker.
 *
 * Strict-manifest integrity:
 *
 *   - `diff_fingerprint_summary.manifest_hash === null` ⇒ benign skip
 *     (the cp's fingerprint was deliberately skipped or capture
 *     failed). Render the summary, exit 0. A non-`skipped` status with
 *     a null hash is itself invalid and is treated as the integrity
 *     error below, not as benign.
 *   - `manifest_hash !== null` but the manifest cannot be loaded ⇒ the
 *     strict-sync missing-manifest condition (corrupt / dropped
 *     sidecar). Surfaced DISTINCTLY as an `EVENT_LOG_CORRUPT` error
 *     with a nonzero exit (never silently rendered as "no manifest"),
 *     pointing at `orcaops resync --force` + `orcaops doctor`.
 */
export async function fingerprintShowAction(opts: FingerprintShowOptions): Promise<void> {
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

    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const artifactRow = ctx.store.store.getArtifact(opts.artifact);
      if (!artifactRow) {
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact with id "${opts.artifact}".`
        );
      }

      const cp = await ctx.store.readCheckpoint(opts.artifact, opts.checkpoint);
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
      const manifest = await ctx.store.readCheckpointDiffFingerprint(
        opts.artifact,
        opts.checkpoint
      );

      // ── branch on manifest_hash ────────────────────────────────────
      if (summary.manifest_hash === null) {
        if (summary.status !== 'skipped') {
          // captured/empty/truncated ALWAYS carry a non-null hash; a
          // null hash on a non-skipped status is corrupt projection
          // state, not a benign skip.
          throw new OrcaopsError(
            ErrorCodes.EVENT_LOG_CORRUPT,
            `Checkpoint #${opts.checkpoint} has status "${summary.status}" but a null manifest_hash — ` +
              `corrupt fingerprint state. Run \`orcaops resync --force\` and \`orcaops doctor\`.`,
            'checkpoint'
          );
        }
        // Benign deliberate-skip / capture-failure: render the summary.
        renderSkipped(opts, cp.n, summary);
        return;
      }

      // manifest_hash !== null ⇒ the manifest MUST be loadable.
      if (manifest === null) {
        throw new OrcaopsError(
          ErrorCodes.EVENT_LOG_CORRUPT,
          `Checkpoint #${opts.checkpoint} declares manifest_hash ${summary.manifest_hash} but its ` +
            `diff-fingerprint manifest could not be loaded (corrupt or dropped sidecar). This is the ` +
            `strict-sync missing-manifest condition — run \`orcaops resync --force\` after fixing the ` +
            `underlying disk/permissions issue, or \`orcaops doctor\` to diagnose.`,
          'checkpoint'
        );
      }

      renderManifest(opts, cp.n, cp.open_snapshot, cp.close_snapshot, summary, manifest);
    } finally {
      ctx.store.close();
    }
  } catch (err) {
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

/**
 * `orcaops fingerprint derive --artifact <id> --checkpoint <n> [--json]`
 *
 * Recompute a closed checkpoint's diff-fingerprint manifest from its pinned
 * snapshot trees and compare the recomputed `manifest_hash` to the one
 * recorded at capture time:
 *
 *   - `verified: true`  — recomputation reproduces the stored hash.
 *   - `verified: false` — the hashes differ (content drift, or a
 *     `max_diff_bytes` cap change since capture — see `note`).
 *   - `verified: null`  — nothing stored to compare against (capture was
 *     skipped but both boundary trees exist, e.g. a capture-time
 *     `git_diff_failed`); the derived summary is fresh output.
 *
 * Tree selection: the STORED manifest's `open_tree_sha`/`close_tree_sha` are
 * authoritative when a manifest exists — empty-fence recovery deliberately
 * builds manifests from a baseline open tree that differs from the cp's own
 * open snapshot (checkpoint.ts Phase C.3). Only a manifest-less cp falls back
 * to the checkpoint snapshot boundaries.
 *
 * Persistence: with
 * the archive enabled, each derivation is written to the archive cache
 * (`…/derived/fingerprint-cp<n>.json`) and later derives with identical
 * inputs read through it (`cached: true` in JSON). Archive disabled →
 * output-only. No store writes either way. Same output
 * guard as `show`: hashes/metadata only, never raw diff text.
 */
export async function fingerprintDeriveAction(opts: FingerprintDeriveOptions): Promise<void> {
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

    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const artifactRow = ctx.store.store.getArtifact(opts.artifact);
      if (!artifactRow) {
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact with id "${opts.artifact}".`
        );
      }

      const cp = await ctx.store.readCheckpoint(opts.artifact, opts.checkpoint);
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
      const manifest = await ctx.store.readCheckpointDiffFingerprint(
        opts.artifact,
        opts.checkpoint
      );

      // Strict-manifest integrity, mirroring `show`: a non-null
      // stored hash whose manifest cannot load is corrupt state — deriving from
      // the cp's own boundaries could silently disagree with a RECOVERED
      // manifest's baseline open tree, so refuse rather than mislead.
      if (summary.manifest_hash !== null && manifest === null) {
        throw new OrcaopsError(
          ErrorCodes.EVENT_LOG_CORRUPT,
          `Checkpoint #${opts.checkpoint} declares manifest_hash ${summary.manifest_hash} but its ` +
            `diff-fingerprint manifest could not be loaded (corrupt or dropped sidecar). Run ` +
            `\`orcaops resync --force\` after fixing the underlying issue, or \`orcaops doctor\`.`,
          'checkpoint'
        );
      }
      if (summary.manifest_hash === null && summary.status !== 'skipped') {
        throw new OrcaopsError(
          ErrorCodes.EVENT_LOG_CORRUPT,
          `Checkpoint #${opts.checkpoint} has status "${summary.status}" but a null manifest_hash — ` +
            `corrupt fingerprint state. Run \`orcaops resync --force\` and \`orcaops doctor\`.`,
          'checkpoint'
        );
      }

      // Tree selection: stored-manifest trees are authoritative (recovery may
      // have pinned a baseline open tree); fall back to the cp boundaries only
      // when no manifest exists (skipped capture with pinned snapshots).
      const source = manifest !== null ? 'stored_manifest_trees' : 'snapshot_boundaries';
      const openTreeSha = manifest !== null ? manifest.open_tree_sha : cp.open_snapshot.tree_sha;
      const closeTreeSha = manifest !== null ? manifest.close_tree_sha : cp.close_snapshot.tree_sha;

      // Archive-side read-through cache — derivations persist when the
      // archive is enabled, and are output-only otherwise. A hit
      // must match every derivation input; anything else re-derives.
      if (ctx.archive && openTreeSha !== null && closeTreeSha !== null) {
        const cached = await readDerivedCache(
          ctx.archive.projectDir,
          opts.artifact,
          opts.checkpoint
        );
        if (
          cached !== null &&
          cached.source === source &&
          cached.open_tree_sha === openTreeSha &&
          cached.close_tree_sha === closeTreeSha &&
          cached.max_diff_bytes === ctx.config.diff_fingerprint.max_diff_bytes &&
          cached.manifest_hash_stored === summary.manifest_hash
        ) {
          renderDerived(
            opts,
            cp.n,
            {
              source: cached.source,
              open_tree_sha: cached.open_tree_sha,
              close_tree_sha: cached.close_tree_sha,
              stored: {
                status: summary.status,
                manifest_hash: summary.manifest_hash,
                hunk_count: summary.hunk_count,
                truncated: summary.truncated,
              },
              derived: cached.derived_summary,
              verified: cached.verified,
              note: cached.note ?? undefined,
            },
            true
          );
          return;
        }
      }
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
        repo: ctx.repo,
        openTreeSha,
        closeTreeSha,
        maxDiffBytes: cap,
      });
      if (!diff.ok) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `git diff ${openTreeSha.slice(0, 12)}..${closeTreeSha.slice(0, 12)} failed — one or both ` +
            `trees are unreachable. The snapshot refs pinning them were likely pruned ` +
            `(\`orcaops snapshots prune\` / \`orcaops gc\`); a pruned checkpoint is no longer derivable.`,
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

      // Persist the derivation to the archive cache (best-effort,
      // fail-open) so later derives read through and consumers can
      // consume the manifest without re-deriving.
      if (ctx.archive) {
        await writeDerivedCache(ctx.archive.projectDir, opts.artifact, opts.checkpoint, {
          schema_version: 1,
          artifact_id: opts.artifact,
          checkpoint_n: opts.checkpoint,
          source,
          open_tree_sha: openTreeSha,
          close_tree_sha: closeTreeSha,
          max_diff_bytes: cap,
          manifest_hash_stored: summary.manifest_hash,
          verified,
          note: note ?? null,
          // The REPLAYED manifest (window-overlap removals applied) —
          // downstream consumers must never see dropped hunks.
          manifest: derivedManifest,
          derived_summary: {
            status: derivedSummary.status,
            manifest_hash: derivedSummary.manifest_hash,
            hunk_count: derivedSummary.hunk_count,
            captured_hunk_count: derivedSummary.captured_hunk_count,
            truncated: derivedSummary.truncated,
          },
        });
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
      ctx.store.close();
    }
  } catch (err) {
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

function renderDerived(
  opts: FingerprintDeriveOptions,
  n: number,
  view: DerivedView,
  cached = false
): void {
  if (opts.json) {
    const { note, ...rest } = view;
    emitOk({
      artifact: opts.artifact,
      checkpoint: n,
      ...rest,
      ...(cached ? { cached: true } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    return;
  }
  const lines = [
    `Fingerprint derive — artifact ${opts.artifact} checkpoint #${n}` +
      (cached ? ' (served from archive cache)' : ''),
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
