import {
  captureWorktreeTreeSha,
  diffSnapshotTrees,
  matchDiffAgainstManifests,
  type MatchDiffResult,
  reconcileCommitsAgainstCoverage,
  type ReconciledCommit,
} from '@orcaops/core';
import { type ArtifactRow, RecoveryRefusedError, resolveCaptureExcludes } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { loadInFlightOnBranch } from '../lib/active-artifact.js';
import { resolveBranchReadScope } from '../lib/artifact-scope.js';
import { buildContext, type CliContext } from '../lib/context.js';
import { classifyOverlapMatch, loadManifestSources } from '../lib/manifest-sources.js';

export interface DiffAttributionOptions {
  attribution?: boolean;
  /** Audit in-window commits. Mutually exclusive with --attribution. */
  reconcile?: boolean;
  base?: string;
  target?: string;
  artifact?: string;
  unattributed?: boolean;
  json?: boolean;
}

/**
 * How the diff base was chosen. `flag` is `--base <ref>`; `artifact_flag` is an
 * explicit `--artifact <id>`. They are deliberately distinct: collapsing both to
 * `flag` would leave `base.source` unable to say WHICH flag drove selection.
 */
type BaseSource = 'flag' | 'artifact_flag' | 'active_artifact' | 'recent_artifact';

/**
 * Which artifact(s) the checkpoint manifests were sourced from. Discriminated
 * because the default sources manifests from EVERY artifact on the branch — a
 * singular `artifact_id` would be a false claim in that mode.
 */
type ManifestScope = { kind: 'artifact'; artifact_id: string } | { kind: 'branch'; branch: string };

/**
 * `orcaops diff --attribution [--unattributed] [--base <ref>]
 *   [--target <ref>] [--artifact <id>] [--json]`
 *
 * Which checkpoints produced this diff? (The consumption surface over
 * hunk-hash manifests.)
 *
 * DELIBERATELY MINIMAL matching: exact hunk-hash + line-range only; NO
 * fuzzy/rebase-tracking — that is the cloud matcher's territory (the
 * freemium line). Plain `orcaops diff` without `--attribution` is
 * reserved and errors with guidance.
 *
 * Diff construction (like-for-like with manifests): base tree vs the
 * live worktree tree captured through the SAME pipeline as checkpoints
 * (`captureWorktreeTreeSha`: temp index, untracked included,
 * volatile-dir scrub, tree-only — no commit-object accretion), diffed
 * under `diff_fingerprint.max_diff_bytes`.
 *
 * Base semantics: `--base <ref>` wins, then an explicit `--artifact <id>`,
 * then the current branch's in-flight artifact's plan `base_sha`
 * (branch-scoped resolution — the shell pin is NEVER consulted: it can
 * point cross-branch, `lib/active-artifact.ts` documents the hazard),
 * falling back to the branch's most recent artifact (read-only command,
 * disclosed via `base.source`), and hard-requiring `--base` or
 * `--artifact` when the branch has no artifacts. `--target <ref>` switches
 * the live side to a committed state (CI use).
 *
 * The `--artifact` tier fixes the BASE, not just manifest sourcing. Ranking
 * the base purely by status and recency would mean that on a branch carrying
 * two summarized artifacts the newest wins even when the caller named the
 * older — a read-only review artifact silently becoming the base for the
 * implementation work it reviewed. `base.source` distinguishes `flag` from
 * `artifact_flag`, and `manifest_scope` discloses which artifact(s) the
 * manifests came from.
 *
 * Graceful degradation (hard requirement): every checkpoint without a
 * loadable manifest (stored → archive derive-cache → nothing) degrades
 * to file-level attribution over its `files_changed`;
 * `attribution_granularity` reports the best available level and a
 * per-checkpoint map says which is which. Manifest-side data stays
 * hash-only; live-side output carries paths/ranges but no raw hunk text.
 */
export async function diffAction(opts: DiffAttributionOptions): Promise<void> {
  try {
    if (opts.reconcile === true && opts.attribution === true) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--attribution and --reconcile are mutually exclusive — attribution matches the live ' +
          'diff against manifests; reconcile audits in-window commits against checkpoint ' +
          'coverage.',
        'reconcile'
      );
    }
    if (opts.reconcile === true) {
      await diffReconcile(opts);
      return;
    }
    if (opts.attribution !== true) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Plain `orcaops diff` is reserved — pass --attribution to match this diff against ' +
          'captured checkpoint manifests, or --reconcile to audit in-window commits against ' +
          'checkpoint coverage (see `orcaops diff --help`).',
        'attribution'
      );
    }

    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const branch = await ctx.repo.getCurrentBranch();

      // ── Base resolution ────────────────────────────────────────────
      let baseSha: string;
      let baseRef: string;
      let baseSource: BaseSource;
      if (opts.base !== undefined && opts.base.length > 0) {
        const resolved = await ctx.repo.resolveCommit(opts.base);
        if (resolved === null) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `--base "${opts.base}" does not resolve to a commit.`,
            'base'
          );
        }
        baseSha = resolved;
        baseRef = opts.base;
        baseSource = 'flag';
      } else {
        // --base wins over --artifact: it is the more specific instruction. When
        // absent, an explicit --artifact supplies the base.
        const row = await resolveDefaultBaseArtifact(ctx, branch, opts.artifact);
        if (row === null) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `No artifact on branch "${branch}" to derive a base from — pass --base <ref> ` +
              `or --artifact <id>.`,
            'base'
          );
        }
        if (row.artifact.base_sha.length === 0) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `Artifact ${row.artifact.id} has no recorded base_sha — pass --base <ref>.`,
            'base'
          );
        }
        baseSha = row.artifact.base_sha;
        baseRef = `artifact:${row.artifact.id}`;
        baseSource = row.source;
      }

      // ── Target resolution ──────────────────────────────────────────
      let targetSha: string;
      let target:
        | { kind: 'worktree'; tree_sha: string }
        | { kind: 'ref'; ref: string; sha: string };
      let liveUnmergedPaths: readonly string[] = [];
      let liveUnmergedProbeFailed = false;
      if (opts.target !== undefined && opts.target.length > 0) {
        const resolved = await ctx.repo.resolveCommit(opts.target);
        if (resolved === null) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `--target "${opts.target}" does not resolve to a commit.`,
            'target'
          );
        }
        targetSha = resolved;
        target = { kind: 'ref', ref: opts.target, sha: resolved };
      } else {
        const live = await captureWorktreeTreeSha(ctx.repo, {
          excludePatterns: resolveCaptureExcludes(ctx.config.capture).patterns,
        });
        if (!live.ok) {
          throw new OrcaopsError(
            ErrorCodes.SNAPSHOT_UNAVAILABLE,
            `Could not capture the live worktree tree (reason: ${live.error_reason}` +
              `${live.error_message !== undefined ? ` — ${live.error_message}` : ''}). ` +
              `Resolve the worktree state or pass --target <ref>.`,
            'target'
          );
        }
        targetSha = live.tree_sha;
        target = { kind: 'worktree', tree_sha: live.tree_sha };
        // Capture succeeds through an unmerged index, so the live tree
        // carries the conflicted paths' worktree bytes (markers included):
        // matches on those paths are downgraded below and disclosed here.
        liveUnmergedPaths = live.unmerged_paths;
        liveUnmergedProbeFailed = live.unmerged_probe_failed === true;
        if (liveUnmergedPaths.length > 0) {
          writeTerminalSafeStderr(
            `note: ${liveUnmergedPaths.length} unmerged path(s) in the index ` +
              `(${liveUnmergedPaths.join(', ')}) — the live tree reflects conflicted worktree ` +
              `contents (markers included); attribution matches on these paths are downgraded.\n`
          );
        }
      }

      // ── Live diff (byte-capped, same pipeline as capture) ──────────
      const cap = ctx.config.diff_fingerprint.max_diff_bytes;
      const diff = await diffSnapshotTrees({
        repo: ctx.repo,
        openTreeSha: baseSha,
        closeTreeSha: targetSha,
        maxDiffBytes: cap,
      });
      if (!diff.ok) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `git diff ${baseSha.slice(0, 12)}..${targetSha.slice(0, 12)} failed — is the base ` +
            `reachable in this repo?`,
          'base'
        );
      }

      // ── Manifest sourcing per closed checkpoint ────────────────────
      let candidates: ArtifactRow[];
      let manifestScope: ManifestScope;
      if (opts.artifact !== undefined && opts.artifact.length > 0) {
        const row = ctx.store.store.getArtifact(opts.artifact);
        if (row === null) {
          throw new OrcaopsError(
            ErrorCodes.UNKNOWN_ARTIFACT,
            `No artifact with id "${opts.artifact}".`
          );
        }
        candidates = [row];
        manifestScope = { kind: 'artifact', artifact_id: row.id };
      } else {
        // Seeded participation (storage-class rule, decided explicitly):
        // attribution is a provenance surface — without imported manifests a
        // seeded store answers `granularity: none` for history it holds.
        const scope = await resolveBranchReadScope(ctx, {}, { imported: 'include' });
        candidates = scope.rows;
        manifestScope = { kind: 'branch', branch };
      }

      const {
        sources,
        manifestless,
        checkpointGranularity,
        incompatibleCount,
        overlapAdjudications,
        skippedUnreadableArtifacts,
      } = await loadManifestSources(ctx, candidates);
      // FAIL CLOSED: attribution is decided by pool membership — a
      // skipped artifact shrinks the ambiguity pool, so a hunk two
      // artifacts both claimed would attribute confidently to the one
      // that still reads. Refusal is the only non-strengthening answer.
      if (skippedUnreadableArtifacts.length > 0) {
        throw new OrcaopsError(
          ErrorCodes.INTERNAL,
          `attribution cannot proceed: artifact(s) ${skippedUnreadableArtifacts.join(', ')} ` +
            `could not be read, so the ambiguity pool would be incomplete and matches could ` +
            `be misattributed. Run \`orcaops doctor\` to see the corruption.`
        );
      }

      // ── Hunk-level matching (fail-open to file-level) ──────────────
      let matched: MatchDiffResult | null = null;
      if (sources.length > 0) {
        try {
          matched = await matchDiffAgainstManifests({
            diffBytes: diff.diff,
            truncated: diff.truncated,
            maxDiffBytes: cap,
            sources,
          });
        } catch {
          matched = null; // parser failure → file-level below, disclosed
        }
      }

      // ── overlap adjudication downgrade ─────────────────────────────
      // A match against an ambiguous/mixed_segment file is WEAK evidence
      // (never clean); own_claim_pending is PROVISIONAL (likely right,
      // unconfirmed while the overlap group is open). Manifests alone
      // are not trustworthy under overlap — this is the read-model side
      // of the claims partition.
      let annotatedHunks = matched?.hunks ?? null;
      let coverage = matched?.coverage ?? null;
      if (matched !== null && overlapAdjudications.size > 0) {
        annotatedHunks = matched.hunks.map((hunk) => {
          if (hunk.matches.length === 0) return hunk;
          let sawStrong = false;
          let sawWeak = false;
          const matches = hunk.matches.map((m) => {
            const adj = overlapAdjudications.get(`${m.artifact_id}:${m.checkpoint_n}`);
            const status = classifyOverlapMatch(adj, m.manifest_file ?? hunk.file);
            if (status === 'ambiguous' || status === 'mixed_segment') sawWeak = true;
            else sawStrong = true;
            return status === null ? m : { ...m, overlap_status: status };
          });
          // Every match weak → the hunk cannot be trusted as attribution.
          const ambiguous = hunk.ambiguous || (sawWeak && !sawStrong);
          return { ...hunk, matches, ambiguous };
        });
        // Recompute coverage after the downgrade (same formula as the matcher).
        const nonWeak = annotatedHunks.filter((h) => !h.known_weak);
        const attributed = nonWeak.filter((h) => h.matches.length > 0 && !h.ambiguous).length;
        const ambiguousCount = nonWeak.filter((h) => h.matches.length > 0 && h.ambiguous).length;
        const knownWeak = annotatedHunks.length - nonWeak.length;
        coverage = {
          total_hunks: annotatedHunks.length,
          attributed_hunks: attributed,
          ambiguous_hunks: ambiguousCount,
          unattributed_hunks: nonWeak.length - attributed - ambiguousCount,
          known_weak_hunks: knownWeak,
          attributed_pct:
            nonWeak.length === 0 ? null : Math.round((attributed / nonWeak.length) * 1000) / 10,
        };
      }

      // ── live unmerged-path downgrade ───────────────────────────────
      // A live hunk on a conflicted worktree path is marker-bytes
      // evidence, never confident attribution — mark it ambiguous with an
      // explicit annotation, mirroring the overlap downgrade above.
      if (annotatedHunks !== null && liveUnmergedPaths.length > 0) {
        const unmergedSet = new Set(liveUnmergedPaths);
        let sawDowngrade = false;
        annotatedHunks = annotatedHunks.map((hunk) => {
          if (hunk.file === null || !unmergedSet.has(hunk.file)) return hunk;
          sawDowngrade = true;
          return { ...hunk, live_unmerged: true, ambiguous: true };
        });
        if (sawDowngrade) {
          const nonWeak = annotatedHunks.filter((h) => !h.known_weak);
          const attributed = nonWeak.filter((h) => h.matches.length > 0 && !h.ambiguous).length;
          const ambiguousCount = nonWeak.filter((h) => h.matches.length > 0 && h.ambiguous).length;
          coverage = {
            total_hunks: annotatedHunks.length,
            attributed_hunks: attributed,
            ambiguous_hunks: ambiguousCount,
            unattributed_hunks: nonWeak.length - attributed - ambiguousCount,
            known_weak_hunks: annotatedHunks.length - nonWeak.length,
            attributed_pct:
              nonWeak.length === 0 ? null : Math.round((attributed / nonWeak.length) * 1000) / 10,
          };
        }
      }

      // ── File-level attributions for degraded checkpoints ───────────
      const changedFiles = await ctx.repo.getChangedFiles(baseSha, targetSha);
      const changedSet = new Set(changedFiles);
      const fileAttributions = manifestless
        .map((m) => ({
          artifact_id: m.artifact_id,
          checkpoint_n: m.checkpoint_n,
          files: m.files_changed.filter((f) => changedSet.has(f)),
        }))
        .filter((m) => m.files.length > 0);

      const granularity: 'hunk' | 'file' | 'none' =
        matched !== null ? 'hunk' : fileAttributions.length > 0 ? 'file' : 'none';

      const unattributedHunks =
        annotatedHunks === null
          ? null
          : annotatedHunks.filter((h) => !h.known_weak && h.matches.length === 0);

      const disclosure = {
        manifestless_checkpoints: manifestless.map((m) => ({
          artifact_id: m.artifact_id,
          checkpoint_n: m.checkpoint_n,
        })),
        truncated_manifest_checkpoints: matched?.truncated_manifest_checkpoints ?? [],
        incompatible_manifest_count: incompatibleCount,
        live_diff_truncated: diff.truncated,
        parser_failed: sources.length > 0 && matched === null,
        // Checkpoints whose manifests were adjudication-
        // downgraded (window overlap); pending = group not fully closed.
        overlap_checkpoints: [...overlapAdjudications.entries()].map(([key, adj]) => ({
          checkpoint: key,
          finalized: adj.finalized,
          ambiguous_count: adj.ambiguous.length,
          mixed_segment_count: adj.mixedSegment.length,
          own_claim_pending_count: adj.ownClaimPending.length,
          unreadable_sibling_artifacts: adj.unreadableSiblingArtifacts,
        })),
        // Optional-absent: the live worktree's conflicted paths (matches on
        // them downgraded above) and whether the probe itself failed.
        ...(liveUnmergedPaths.length > 0 ? { live_unmerged_paths: [...liveUnmergedPaths] } : {}),
        ...(liveUnmergedProbeFailed ? { live_unmerged_probe_failed: true } : {}),
      };

      const envelope = {
        base: { ref: baseRef, sha: baseSha, source: baseSource },
        // Discloses which artifact's manifests were consulted; reconcile
        // carries the same information as `artifact: {id, source}`.
        manifest_scope: manifestScope,
        target,
        attribution_granularity: granularity,
        ...(opts.unattributed === true
          ? {}
          : { hunks: annotatedHunks, file_attributions: fileAttributions }),
        unattributed: unattributedHunks,
        coverage,
        checkpoint_granularity: checkpointGranularity,
        disclosure,
      };

      if (opts.json) {
        emitOk(envelope);
        return;
      }
      writeTerminalSafeStdout(formatHuman(envelope));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/**
 * Base-artifact resolution: an explicit `--artifact <id>` wins, else the
 * in-flight artifact on the branch (newest first — same invariant as capture
 * autodetect), else the branch's most recent artifact. The shell pin is
 * deliberately NOT consulted (it can point cross-branch; see
 * `resolveActiveArtifactId`'s rationale).
 *
 * `explicitId` exists because the fallback tiers are status- and recency-ranked,
 * never identity-ranked: with two summarized artifacts on one branch,
 * `listArtifacts` orders by `started_at DESC`, so the newest wins even when the
 * caller named the older one. A read-only review artifact silently becoming the
 * attribution base for the implementation work it reviewed is the failure this
 * closes.
 */
async function resolveDefaultBaseArtifact(
  ctx: CliContext,
  branch: string,
  explicitId?: string
): Promise<{ artifact: ArtifactRow; source: BaseSource } | null> {
  if (explicitId !== undefined && explicitId.length > 0) {
    const row = ctx.store.store.getArtifact(explicitId);
    if (row === null) {
      throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${explicitId}".`);
    }
    return { artifact: row, source: 'artifact_flag' };
  }
  const inFlight = await loadInFlightOnBranch(ctx, branch);
  if (inFlight.length > 0) {
    return { artifact: inFlight[0].row, source: 'active_artifact' };
  }
  // Seeded participation (storage-class rule, decided explicitly): a base is
  // live-work state — an imported artifact is always summarized and
  // backdated, so it can never be the implicit diff base.
  const scope = await resolveBranchReadScope(ctx, { branch }, { imported: 'live-only' });
  if (scope.rows.length > 0) {
    return { artifact: scope.rows[0], source: 'recent_artifact' };
  }
  return null;
}

// ── `orcaops diff --reconcile` ────────────────────────────────────────────

type ReconcileHeadSource = 'latest_closed_checkpoint' | 'branch_head_fallback';

interface ReconcileEnvelope {
  artifact: { id: string; source: BaseSource };
  base: { sha: string };
  window: {
    head: { sha: string; source: ReconcileHeadSource; checkpoint_n: number | null };
    total_commits: number;
    covered_commit_count: number;
    commits: ReconciledCommit[];
    uncovered_commits: ReconciledCommit[];
    /** Fully accounted for, but only via weak/provisional coverage — disclosed. */
    ambiguous_coverage_commits: ReconciledCommit[];
  };
  /**
   * For a SUMMARIZED artifact, the window effectively extends to summary
   * time. Commits after the last checkpoint close but before the summary are
   * this artifact's uncovered work — reconciled LOUDLY here, distinct from
   * genuinely-post-artifact commits (which stay the soft `post_window_commits`
   * disclosure below). Absent for an active artifact, or when the summary commit
   * is not a clean linear descendant of the window head (e.g. a rebase orphan).
   */
  pre_summary?: {
    summary_head_sha: string;
    total_commits: number;
    covered_commit_count: number;
    commits: ReconciledCommit[];
    uncovered_commits: ReconciledCommit[];
    ambiguous_coverage_commits: ReconciledCommit[];
  };
  /** Commits after the last close (or summary, when split) → branch HEAD — listed, not reconciled. */
  post_window_commits: Array<{ sha: string; subject: string; files: string[] }>;
  disclosure: {
    coverage_basis: 'files_changed_and_manifests' | 'files_changed_only';
    manifestless_checkpoints: Array<{ artifact_id: string; checkpoint_n: number }>;
    incompatible_manifest_count: number;
    no_closed_checkpoints: boolean;
    /**
     * Artifacts skipped as unreadable: their claims are absent, so
     * coverage is understated (commits may surface as uncovered).
     */
    skipped_unreadable_artifacts: string[];
    /** Adjudication-downgraded checkpoints in the coverage set. */
    overlap_checkpoints: Array<{
      checkpoint: string;
      finalized: boolean;
      unreadable_sibling_artifacts: string[];
    }>;
  };
}

/**
 * Which in-window COMMITS does no checkpoint account for? The
 * `--attribution` sweep diffs base → live worktree, so a commit landed
 * inside the artifact window with no checkpoint is invisible there (its
 * changes sit in both trees). Reconcile enumerates the window's commits
 * and checks each commit's files against checkpoint coverage.
 *
 * Window: artifact `base_sha` → the latest closed checkpoint's
 * `head_sha` (fallback: branch HEAD when no checkpoint has closed).
 * When window head ≠ branch HEAD, the trailing span is listed
 * separately as `post_window_commits`, never silently dropped.
 *
 * Coverage (RAW by design): the union of closed checkpoints'
 * `files_changed` claims PLUS manifest file paths (both rename sides) —
 * manifests catch under-reported files. No manifests → files_changed
 * only, disclosed. Coverage uses the ADJUDICATED sets for checkpoints
 * carrying `window_overlap`.
 *
 * Strict range resolution: base AND head are validated via
 * `resolveCommit` BEFORE enumeration, and enumeration uses the strict
 * non-swallowing variant — for an audit command, empty-because-error
 * must never read as empty-because-clean.
 */
async function diffReconcile(opts: DiffAttributionOptions): Promise<void> {
  if (opts.base !== undefined || opts.target !== undefined || opts.unattributed === true) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--base/--target/--unattributed apply to --attribution only. --reconcile always audits ' +
        'the artifact window (base_sha → latest closed checkpoint head).',
      'reconcile'
    );
  }

  const ctx = await buildContext({ mintArchiveIdentity: false });
  try {
    const branch = await ctx.repo.getCurrentBranch();

    // ── Artifact resolution (window owner) ─────────────────────────────
    let artifactRow: ArtifactRow;
    let artifactSource: BaseSource;
    if (opts.artifact !== undefined && opts.artifact.length > 0) {
      const row = ctx.store.store.getArtifact(opts.artifact);
      if (row === null) {
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact with id "${opts.artifact}".`
        );
      }
      artifactRow = row;
      artifactSource = 'flag';
    } else {
      const resolved = await resolveDefaultBaseArtifact(ctx, branch);
      if (resolved === null) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `No artifact on branch "${branch}" to reconcile — pass --artifact <id>.`,
          'reconcile'
        );
      }
      artifactRow = resolved.artifact;
      artifactSource = resolved.source;
    }
    if (artifactRow.base_sha.length === 0) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Artifact ${artifactRow.id} has no recorded base_sha — nothing to reconcile against.`,
        'reconcile'
      );
    }

    // ── Strict ref validation (error-not-clean, always) ────────────────
    const baseSha = await ctx.repo.resolveCommit(artifactRow.base_sha);
    if (baseSha === null) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Artifact base ${artifactRow.base_sha.slice(0, 12)} does not resolve to a commit ` +
          `(history rewritten or pruned?) — refusing to reconcile: an unresolvable window ` +
          `would read as clean.`,
        'reconcile'
      );
    }
    const branchHeadSha = await ctx.repo.resolveCommit('HEAD');
    if (branchHeadSha === null) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Branch HEAD does not resolve to a commit — refusing to reconcile.',
        'reconcile'
      );
    }

    const cps = await ctx.store.readCheckpointsRecovered(artifactRow.id);
    let latestClosed: { n: number; head_sha: string; closed_at: string } | null = null;
    for (const cp of cps) {
      if (cp.status !== 'closed') continue;
      if (
        latestClosed === null ||
        cp.closed_at > latestClosed.closed_at ||
        (cp.closed_at === latestClosed.closed_at && cp.n > latestClosed.n)
      ) {
        latestClosed = { n: cp.n, head_sha: cp.head_sha, closed_at: cp.closed_at };
      }
    }

    let windowHeadSha: string;
    let headSource: ReconcileHeadSource;
    if (latestClosed !== null) {
      const resolved = await ctx.repo.resolveCommit(latestClosed.head_sha);
      if (resolved === null) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Checkpoint #${latestClosed.n}'s recorded head_sha ` +
            `${latestClosed.head_sha.slice(0, 12)} does not resolve to a commit (history ` +
            `rewritten or pruned?) — refusing to reconcile: an unresolvable window would ` +
            `read as clean.`,
          'reconcile'
        );
      }
      windowHeadSha = resolved;
      headSource = 'latest_closed_checkpoint';
    } else {
      windowHeadSha = branchHeadSha;
      headSource = 'branch_head_fallback';
    }

    // For a SUMMARIZED artifact the window effectively runs to summary time.
    // Split the trailing span at the summary commit: windowHead→summaryHead is
    // this artifact's uncovered work (reconciled LOUDLY below), summaryHead→HEAD
    // is genuinely post-artifact (the soft disclosure). Gate on isAncestor for
    // BOTH boundaries — a rebase can leave summary.head_sha resolvable yet NOT on
    // the linear windowHead..HEAD path, which would mis-partition; then we fall
    // back to the single soft span (current behavior).
    const summary = await ctx.store.readSummary(artifactRow.id);
    let preSummaryHeadSha: string | null = null;
    if (summary !== null && windowHeadSha !== branchHeadSha) {
      const summaryHead = await ctx.repo.resolveCommit(summary.head_sha);
      if (
        summaryHead !== null &&
        summaryHead !== windowHeadSha &&
        (await ctx.repo.isAncestor(windowHeadSha, summaryHead)) &&
        (await ctx.repo.isAncestor(summaryHead, branchHeadSha))
      ) {
        preSummaryHeadSha = summaryHead;
      }
    }
    // The soft post-window disclosure starts at the summary commit when a valid
    // split exists, else at the window head (unchanged).
    const postWindowBaseSha = preSummaryHeadSha ?? windowHeadSha;

    // ── Strict enumeration ─────────────────────────────────────────────
    let windowCommits: Array<{ sha: string; subject: string; files: string[] }>;
    try {
      windowCommits = await ctx.repo.getCommitsBetweenStrict(baseSha, windowHeadSha);
    } catch (err) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `git failed enumerating ${baseSha.slice(0, 12)}..${windowHeadSha.slice(0, 12)} ` +
          `(${(err as Error).message.trim()}) — refusing to report a clean reconcile on an ` +
          `enumeration error.`,
        'reconcile'
      );
    }
    // The pre-summary span (windowHead → summaryHead), reconciled loudly below.
    let preSummaryCommits: Array<{ sha: string; subject: string; files: string[] }> = [];
    if (preSummaryHeadSha !== null) {
      try {
        preSummaryCommits = await ctx.repo.getCommitsBetweenStrict(
          windowHeadSha,
          preSummaryHeadSha
        );
      } catch (err) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `git failed enumerating pre-summary span ${windowHeadSha.slice(0, 12)}..` +
            `${preSummaryHeadSha.slice(0, 12)} (${(err as Error).message.trim()}) — refusing to ` +
            `report a clean reconcile on an enumeration error.`,
          'reconcile'
        );
      }
    }
    let postWindowCommits: Array<{ sha: string; subject: string; files: string[] }> = [];
    if (postWindowBaseSha !== branchHeadSha) {
      try {
        postWindowCommits = await ctx.repo.getCommitsBetweenStrict(
          postWindowBaseSha,
          branchHeadSha
        );
      } catch (err) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `git failed enumerating post-window span ${postWindowBaseSha.slice(0, 12)}..` +
            `${branchHeadSha.slice(0, 12)} (${(err as Error).message.trim()}) — refusing to ` +
            `report a clean reconcile on an enumeration error.`,
          'reconcile'
        );
      }
    }

    // ── Coverage: files_changed claims + manifest paths ────────────────
    // For checkpoints carrying window_overlap, coverage comes from the
    // ADJUDICATED sets
    // — retained + segment-attributed files. A claim rejected by
    // segment evidence never covers; ambiguous / mixed-segment /
    // own-claim-pending files provide only WEAK coverage (a commit
    // covered only by them is disclosed as ambiguous coverage, never
    // silently clean).
    // Seeded participation matches --attribution: imported manifests count
    // as coverage evidence for the history they imported.
    const candidates =
      opts.artifact !== undefined && opts.artifact.length > 0
        ? [artifactRow]
        : (await resolveBranchReadScope(ctx, {}, { imported: 'include' })).rows;
    const {
      sources,
      manifestless,
      incompatibleCount,
      overlapAdjudications,
      skippedUnreadableArtifacts,
    } = await loadManifestSources(ctx, candidates);
    // Reconcile-side skips are conservative (a skipped artifact only
    // WEAKENS coverage, surfacing commits as uncovered), so enumeration
    // continues — but the omission must ride the structured disclosure,
    // not stderr alone.
    const skippedUnreadable = new Set<string>(skippedUnreadableArtifacts);

    const weakCoverage = new Set<string>();
    const weakByCp = new Map<string, Set<string>>();
    for (const [key, adj] of overlapAdjudications) {
      const set = new Set<string>();
      for (const f of [...adj.ambiguous, ...adj.mixedSegment, ...adj.ownClaimPending]) {
        if (f.file_before !== null) set.add(f.file_before);
        if (f.file_after !== null) set.add(f.file_after);
      }
      for (const p of set) weakCoverage.add(p);
      weakByCp.set(key, set);
    }

    const coverage = new Set<string>();
    for (const row of candidates) {
      // Sibling rot stays sibling-local: skip the unreadable row with a
      // warning rather than aborting the diff for the whole branch.
      const rowCps =
        row.id === artifactRow.id
          ? cps
          : await ctx.store.readCheckpointsRecovered(row.id).catch((err: unknown) => {
              if (!(err instanceof RecoveryRefusedError)) throw err;
              skippedUnreadable.add(row.id);
              process.stderr.write(
                `warning: skipping unreadable artifact ${row.id} in diff coverage — ` +
                  `${err.message}\n`
              );
              return [];
            });
      for (const cp of rowCps) {
        if (cp.status !== 'closed') continue;
        const cpWeak = weakByCp.get(`${row.id}:${cp.n}`);
        const rejected = new Set(cp.window_overlap?.rejected_claims ?? []);
        for (const f of cp.files_changed) {
          if (rejected.has(f)) continue; // rejected claim never covers
          if (cpWeak?.has(f)) continue; // weak from this cp — weak set carries it
          coverage.add(f);
        }
        // Files held purely on exclusive-segment evidence count as
        // strong coverage even though nobody self-reported them.
        for (const f of cp.window_overlap?.segment_attributed ?? []) coverage.add(f);
      }
    }
    for (const source of sources) {
      const cpWeak = weakByCp.get(`${source.artifact_id}:${source.checkpoint_n}`);
      for (const hunk of source.manifest.hunks) {
        // Both rename sides: a commit touching either path is covered.
        for (const p of [hunk.file_before, hunk.file_after]) {
          if (p === null) continue;
          if (cpWeak?.has(p)) continue;
          coverage.add(p);
        }
      }
    }

    const reconciled = reconcileCommitsAgainstCoverage({
      commits: windowCommits,
      coverage,
      weakCoverage,
    });
    // Reconcile the pre-summary span against the SAME coverage set.
    const reconciledPreSummary =
      preSummaryHeadSha !== null
        ? reconcileCommitsAgainstCoverage({
            commits: preSummaryCommits,
            coverage,
            weakCoverage,
          })
        : null;

    const envelope: ReconcileEnvelope = {
      artifact: { id: artifactRow.id, source: artifactSource },
      base: { sha: baseSha },
      window: {
        head: {
          sha: windowHeadSha,
          source: headSource,
          checkpoint_n: latestClosed?.n ?? null,
        },
        total_commits: reconciled.commits.length,
        covered_commit_count: reconciled.covered_commit_count,
        commits: reconciled.commits,
        uncovered_commits: reconciled.uncovered_commits,
        ambiguous_coverage_commits: reconciled.commits.filter((c) => c.ambiguous_coverage),
      },
      // Pre-summary uncovered span — optional-absent (present only for a
      // summarized artifact with a clean linear split).
      ...(reconciledPreSummary !== null && preSummaryHeadSha !== null
        ? {
            pre_summary: {
              summary_head_sha: preSummaryHeadSha,
              total_commits: reconciledPreSummary.commits.length,
              covered_commit_count: reconciledPreSummary.covered_commit_count,
              commits: reconciledPreSummary.commits,
              uncovered_commits: reconciledPreSummary.uncovered_commits,
              ambiguous_coverage_commits: reconciledPreSummary.commits.filter(
                (c) => c.ambiguous_coverage
              ),
            },
          }
        : {}),
      post_window_commits: postWindowCommits,
      disclosure: {
        coverage_basis: sources.length > 0 ? 'files_changed_and_manifests' : 'files_changed_only',
        manifestless_checkpoints: manifestless.map((m) => ({
          artifact_id: m.artifact_id,
          checkpoint_n: m.checkpoint_n,
        })),
        incompatible_manifest_count: incompatibleCount,
        no_closed_checkpoints: latestClosed === null,
        skipped_unreadable_artifacts: [...skippedUnreadable].sort(),
        overlap_checkpoints: [...overlapAdjudications.entries()].map(([key, adj]) => ({
          checkpoint: key,
          finalized: adj.finalized,
          unreadable_sibling_artifacts: adj.unreadableSiblingArtifacts,
        })),
      },
    };

    if (opts.json) {
      emitOk(envelope);
      return;
    }
    writeTerminalSafeStdout(formatReconcileHuman(envelope));
  } finally {
    ctx.store.close();
  }
}

function formatReconcileHuman(env: ReconcileEnvelope): string {
  const lines: string[] = [];
  lines.push(`Reconcile — artifact ${env.artifact.id.slice(0, 8)} (via ${env.artifact.source})`);
  const head = env.window.head;
  lines.push(
    `  window: ${env.base.sha.slice(0, 12)} → ${head.sha.slice(0, 12)} ` +
      (head.source === 'latest_closed_checkpoint'
        ? `(latest closed checkpoint #${head.checkpoint_n})`
        : '(no closed checkpoint — branch HEAD fallback)')
  );
  lines.push(
    `  commits in window: ${env.window.total_commits} — ` +
      `${env.window.covered_commit_count} covered, ` +
      `${env.window.uncovered_commits.length} with uncovered files`
  );
  if (env.window.uncovered_commits.length > 0) {
    lines.push('  ⚠ UNCOVERED COMMITS — in-window work no checkpoint accounts for:');
    for (const c of env.window.uncovered_commits) {
      lines.push(
        `    - ${c.sha.slice(0, 12)} "${c.subject}"` +
          `${c.fully_uncovered ? ' [fully uncovered]' : ''}`
      );
      for (const f of c.uncovered_files) lines.push(`        ${f}`);
    }
  }
  if (env.window.ambiguous_coverage_commits.length > 0) {
    lines.push('  ⚠ AMBIGUOUS COVERAGE — accounted for only by weak/provisional evidence:');
    for (const c of env.window.ambiguous_coverage_commits) {
      lines.push(`    - ${c.sha.slice(0, 12)} "${c.subject}"`);
      for (const f of c.weakly_covered_files) lines.push(`        ${f}`);
    }
  }
  // The pre-summary span is a FINDING (this artifact's post-last-close work
  // before the summary), not the soft post-window disclosure.
  if (env.pre_summary !== undefined) {
    const ps = env.pre_summary;
    lines.push(
      `  pre-summary span (after the last close, before the summary — reconciled): ` +
        `${ps.total_commits} commit(s), ${ps.covered_commit_count} covered`
    );
    if (ps.uncovered_commits.length > 0) {
      lines.push(
        "  ⚠ UNCOVERED (post-last-close, pre-summary) — this artifact's work no checkpoint accounts for:"
      );
      for (const c of ps.uncovered_commits) {
        lines.push(
          `    - ${c.sha.slice(0, 12)} "${c.subject}"${c.fully_uncovered ? ' [fully uncovered]' : ''}`
        );
        for (const f of c.uncovered_files) lines.push(`        ${f}`);
      }
    }
    if (ps.ambiguous_coverage_commits.length > 0) {
      lines.push('  ⚠ AMBIGUOUS COVERAGE (pre-summary) — weak/provisional evidence only:');
      for (const c of ps.ambiguous_coverage_commits) {
        lines.push(`    - ${c.sha.slice(0, 12)} "${c.subject}"`);
        for (const f of c.weakly_covered_files) lines.push(`        ${f}`);
      }
    }
  }
  if (env.post_window_commits.length > 0) {
    lines.push(
      `  post-window commits (after the last checkpoint close — not reconciled): ` +
        `${env.post_window_commits.length}`
    );
    for (const c of env.post_window_commits) {
      lines.push(`    - ${c.sha.slice(0, 12)} "${c.subject}"`);
    }
  }
  const d = env.disclosure;
  const notes: string[] = [];
  if (d.coverage_basis === 'files_changed_only') {
    notes.push('coverage from files_changed claims only (no manifests loadable)');
  }
  if (d.manifestless_checkpoints.length > 0) {
    notes.push(`${d.manifestless_checkpoints.length} manifestless cp(s)`);
  }
  if (d.incompatible_manifest_count > 0) {
    notes.push(`${d.incompatible_manifest_count} incompatible manifest(s)`);
  }
  if (d.no_closed_checkpoints) {
    notes.push('no closed checkpoints — window head is branch HEAD');
  }
  if (d.overlap_checkpoints.length > 0) {
    const pending = d.overlap_checkpoints.filter((o) => !o.finalized).length;
    notes.push(
      `${d.overlap_checkpoints.length} overlap-adjudicated cp(s)` +
        (pending > 0 ? ` (${pending} pending finalization)` : '')
    );
  }
  if (d.skipped_unreadable_artifacts.length > 0) {
    notes.push(
      `${d.skipped_unreadable_artifacts.length} unreadable artifact(s) skipped — coverage ` +
        `understated: ${d.skipped_unreadable_artifacts.join(', ')}`
    );
  }
  const unreadableSiblings = [
    ...new Set(d.overlap_checkpoints.flatMap((o) => o.unreadable_sibling_artifacts)),
  ];
  if (unreadableSiblings.length > 0) {
    notes.push(`overlap sibling(s) unreadable — never finalizes: ${unreadableSiblings.join(', ')}`);
  }
  if (notes.length > 0) lines.push(`  disclosure: ${notes.join('; ')}`);
  lines.push('');
  return lines.join('\n');
}

interface EnvelopeForHuman {
  base: { ref: string; sha: string; source: BaseSource };
  manifest_scope: ManifestScope;
  target: { kind: string };
  attribution_granularity: string;
  unattributed: Array<{
    file: string | null;
    new_start: number | null;
    new_lines: number | null;
  }> | null;
  coverage: {
    total_hunks: number;
    attributed_hunks: number;
    ambiguous_hunks: number;
    unattributed_hunks: number;
    known_weak_hunks: number;
    attributed_pct: number | null;
  } | null;
  file_attributions?: Array<{ artifact_id: string; checkpoint_n: number; files: string[] }>;
  disclosure: {
    manifestless_checkpoints: Array<{ artifact_id: string; checkpoint_n: number }>;
    incompatible_manifest_count: number;
    live_diff_truncated: boolean;
    parser_failed: boolean;
    overlap_checkpoints?: Array<{ checkpoint: string; finalized: boolean }>;
  };
}

function formatHuman(env: EnvelopeForHuman): string {
  const lines: string[] = [];
  lines.push(
    `Attribution — base ${env.base.ref} (${env.base.sha.slice(0, 12)}, via ${env.base.source}) ` +
      `→ ${env.target.kind}`
  );
  lines.push(
    `  manifests: ${
      env.manifest_scope.kind === 'artifact'
        ? `artifact ${env.manifest_scope.artifact_id}`
        : `every artifact on ${env.manifest_scope.branch}`
    }`
  );
  lines.push(`  granularity: ${env.attribution_granularity}`);
  if (env.coverage !== null) {
    const c = env.coverage;
    lines.push(
      `  hunks: ${c.total_hunks} total — ${c.attributed_hunks} attributed, ` +
        `${c.ambiguous_hunks} ambiguous, ${c.unattributed_hunks} unattributed` +
        `${c.known_weak_hunks > 0 ? `, ${c.known_weak_hunks} known-weak (excluded)` : ''}` +
        `${c.attributed_pct !== null ? ` — ${c.attributed_pct}% attributed` : ''}`
    );
  }
  if (env.unattributed !== null && env.unattributed.length > 0) {
    lines.push('  unattributed hunks:');
    for (const h of env.unattributed) {
      lines.push(
        `    - ${h.file ?? '(unknown)'}${h.new_start !== null ? `:${h.new_start}` : ''}` +
          `${h.new_lines !== null && h.new_lines > 1 ? `-${(h.new_start ?? 0) + h.new_lines - 1}` : ''}`
      );
    }
  }
  if (env.file_attributions !== undefined && env.file_attributions.length > 0) {
    lines.push('  file-level attributions (checkpoints without manifests):');
    for (const f of env.file_attributions) {
      lines.push(
        `    - cp #${f.checkpoint_n} of ${f.artifact_id.slice(0, 8)}: ${f.files.join(', ')}`
      );
    }
  }
  const d = env.disclosure;
  const overlapCount = d.overlap_checkpoints?.length ?? 0;
  if (
    d.manifestless_checkpoints.length > 0 ||
    d.incompatible_manifest_count > 0 ||
    d.live_diff_truncated ||
    d.parser_failed ||
    overlapCount > 0
  ) {
    lines.push(
      `  disclosure: ${d.manifestless_checkpoints.length} manifestless cp(s), ` +
        `${d.incompatible_manifest_count} incompatible manifest(s)` +
        `${d.live_diff_truncated ? ', live diff truncated' : ''}` +
        `${d.parser_failed ? ', parser failed (file-level only)' : ''}` +
        `${overlapCount > 0 ? `, ${overlapCount} overlap-adjudicated cp(s)` : ''}`
    );
  }
  lines.push('');
  return lines.join('\n');
}
