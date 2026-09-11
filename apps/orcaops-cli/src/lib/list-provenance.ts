import type { ArtifactOriginKind, ArtifactState } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export const TOUCHING_NOTE =
  'closed checkpoints only — open checkpoints have no files_changed until close';

/** One closed-checkpoint hit for a `--touching` path, pre-projected for the collector. */
export interface TouchingHit {
  artifact_id: string;
  n: number;
  closed_at: string;
  summary: string;
  completed_step_ids: string[];
}

/** Artifact-level metadata the rollup needs beyond what the hit rows carry. */
export interface TouchingArtifactMeta {
  label: string;
  task: string;
  branch: string;
  /** Null when the artifact is unreadable — unknown, never substituted. */
  state: ArtifactState | null;
  unreadable?: true;
  origin?: ArtifactOriginKind | null;
}

export interface TouchingArtifactRollup {
  id: string;
  label: string;
  task: string;
  branch: string;
  /** Null when the artifact is unreadable — unknown, never substituted. */
  state: ArtifactState | null;
  unreadable?: true;
  origin: ArtifactOriginKind | null;
  first_touched_at: string;
  last_touched_at: string;
  checkpoints: Array<{
    n: number;
    closed_at: string;
    summary: string;
    completed_step_ids: string[];
  }>;
}

/**
 * Pure rollup for `list --touching`: group closed-cp hits by artifact,
 * keeping only artifacts present in `artifactMeta` (the branch/status-scoped
 * set — membership in the map IS the scope filter). Checkpoints render
 * newest-first per artifact; artifacts order by `last_touched_at` desc.
 * Exported for direct unit testing — retained tests exercise this pure original rollup; common touching now uses normal artifact rows.
 */
export function collectTouchingRollup(input: {
  hits: ReadonlyArray<TouchingHit>;
  artifactMeta: ReadonlyMap<string, TouchingArtifactMeta>;
}): TouchingArtifactRollup[] {
  const byArtifact = new Map<string, TouchingHit[]>();
  for (const hit of input.hits) {
    if (!input.artifactMeta.has(hit.artifact_id)) continue;
    const bucket = byArtifact.get(hit.artifact_id);
    if (bucket) bucket.push(hit);
    else byArtifact.set(hit.artifact_id, [hit]);
  }
  const rollups: TouchingArtifactRollup[] = [];
  for (const [artifactId, hits] of byArtifact) {
    const meta = input.artifactMeta.get(artifactId) as TouchingArtifactMeta;
    const sorted = [...hits].sort((a, b) =>
      a.closed_at === b.closed_at ? b.n - a.n : a.closed_at < b.closed_at ? 1 : -1
    );
    rollups.push({
      id: artifactId,
      label: meta.label,
      task: meta.task,
      branch: meta.branch,
      state: meta.state,
      ...(meta.unreadable === true ? { unreadable: true as const } : {}),
      origin: meta.origin ?? null,
      first_touched_at: sorted[sorted.length - 1].closed_at,
      last_touched_at: sorted[0].closed_at,
      checkpoints: sorted.map((h) => ({
        n: h.n,
        closed_at: h.closed_at,
        summary: h.summary,
        completed_step_ids: h.completed_step_ids,
      })),
    });
  }
  rollups.sort((a, b) =>
    a.last_touched_at === b.last_touched_at
      ? a.id.localeCompare(b.id)
      : a.last_touched_at < b.last_touched_at
        ? 1
        : -1
  );
  return rollups;
}

/**
 * Parse the `--between <ref1>..<ref2>` range: exactly one two-dot separator,
 * both sides non-empty. Three-dot (symmetric-difference) ranges and anything
 * else are `INVALID_INPUT` — only the two-dot form is supported. Exported for
 * direct unit testing.
 */
export function parseBetweenRange(raw: string): { from: string; to: string } {
  const fail = (): OrcaopsError =>
    new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `--between must be <ref1>..<ref2> (two-dot form, both refs non-empty; ` +
        `three-dot ranges are not supported); got "${raw}".`,
      'between'
    );
  if (raw.includes('...')) throw fail();
  const parts = raw.split('..');
  if (parts.length !== 2) throw fail();
  const [from, to] = [parts[0].trim(), parts[1].trim()];
  if (from === '' || to === '') throw fail();
  return { from, to };
}

/** One recorded head-sha anchor for `--between` matching. */
export interface BetweenSha {
  /**
   * Where the sha was recorded. NOTE: when the work is committed after the
   * checkpoint closes, a checkpoint's head_sha is the CLOSE-TIME HEAD — one
   * commit BEFORE the checkpoint's own commit; summary/pre-pr shas are
   * recorded after the final commit. Matching unions all three so a single-checkpoint
   * artifact still matches the range containing its own work.
   */
  source: 'checkpoint' | 'summary' | 'pre_pr';
  /** Checkpoint n — only for source 'checkpoint'. */
  n?: number;
  head_sha: string;
}

export interface BetweenArtifactInput {
  id: string;
  label: string;
  task: string;
  branch: string;
  state: ArtifactState;
  started_at: string;
  completed_at: string | null;
  shas: ReadonlyArray<BetweenSha>;
  lineageBranches: readonly string[];
  origin?: ArtifactOriginKind | null;
}

export interface BetweenMatch {
  id: string;
  label: string;
  task: string;
  branch: string;
  state: ArtifactState;
  started_at: string;
  completed_at: string | null;
  /** The anchors that landed in-range — "close-time/summary-time HEAD ∈ range", NOT "this checkpoint's own commit". */
  matched_shas: BetweenSha[];
  origin: ArtifactOriginKind | null;
}

export interface BetweenCandidate {
  id: string;
  label: string;
  branch: string;
  reason: 'no_head_sha_in_range';
  origin: ArtifactOriginKind | null;
}

/**
 * Pure matcher for `list --between`: an artifact is matched iff any recorded
 * sha ∈ the rev-list set; disclosure-only candidates are artifacts with the
 * ref2 branch in their lineage but ZERO in-range shas (possibly rebased away)
 * — never silently promoted into `matched`. Candidates exist only when ref2
 * names a local branch. Both lists order by `started_at` desc. Exported for
 * direct unit testing.
 */
export function collectBetweenArtifacts(input: {
  artifacts: ReadonlyArray<BetweenArtifactInput>;
  revListShas: ReadonlySet<string>;
  ref2LocalBranch: string | null;
}): { matched: BetweenMatch[]; unmatched_candidates: BetweenCandidate[] } {
  const matched: BetweenMatch[] = [];
  const candidates: Array<BetweenCandidate & { started_at: string }> = [];
  for (const a of input.artifacts) {
    const matchedShas = a.shas.filter((s) => input.revListShas.has(s.head_sha));
    if (matchedShas.length > 0) {
      matched.push({
        id: a.id,
        label: a.label,
        task: a.task,
        branch: a.branch,
        state: a.state,
        started_at: a.started_at,
        completed_at: a.completed_at,
        matched_shas: matchedShas,
        origin: a.origin ?? null,
      });
      continue;
    }
    if (input.ref2LocalBranch !== null && a.lineageBranches.includes(input.ref2LocalBranch)) {
      candidates.push({
        id: a.id,
        label: a.label,
        branch: a.branch,
        reason: 'no_head_sha_in_range',
        started_at: a.started_at,
        origin: a.origin ?? null,
      });
    }
  }
  const byStartedDesc = <T extends { started_at: string; id: string }>(xs: T[]): T[] =>
    xs.sort((x, y) =>
      x.started_at === y.started_at
        ? x.id.localeCompare(y.id)
        : x.started_at < y.started_at
          ? 1
          : -1
    );
  byStartedDesc(matched);
  byStartedDesc(candidates);
  return {
    matched,
    unmatched_candidates: candidates.map(({ id, label, branch, reason, origin }) => ({
      id,
      label,
      branch,
      reason,
      origin,
    })),
  };
}
