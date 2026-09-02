import path from 'node:path';

import {
  type ArtifactOriginKind,
  type ArtifactState,
  type ArtifactStatus,
  loadArtifactThreadFromArchive,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import {
  selectProjectArtifacts,
  unavailableArtifactIdsWithoutSelectedProjection,
} from '../lib/artifact-projections.js';
import {
  assertWindowOrdered,
  importedArtifactsDisclosure,
  importedTag,
  importedTrailerLine,
  parseLimit,
  parseSince,
  parseUntil,
  resolveBranchReadScope,
} from '../lib/artifact-scope.js';
import { buildContext } from '../lib/context.js';
import { readForEnumeration } from '../lib/enumeration-read.js';
import { fallbackState } from '../lib/lifecycle-state.js';
import {
  formatProjectScopeWarnings,
  openAllProjects,
  openCurrentProjectArchive,
  type ProjectHandle,
} from '../lib/project-scope.js';

export interface ListOptions {
  branch?: string;
  state?: string;
  /**
   * Override the default branch-membership filter and list every
   * artifact in the cache. When set, `--branch` is ignored.
   */
  allBranches?: boolean;
  limit?: number;
  /** Lower `started_at` bound (ISO date or datetime, UTC). */
  since?: string;
  /** Upper `started_at` bound (ISO date or datetime, UTC). */
  until?: string;
  /** Lower activity-window bound (interval-overlap semantics, UTC). */
  activeSince?: string;
  /** Upper activity-window bound (interval-overlap semantics, UTC). */
  activeUntil?: string;
  /**
   * Artifact SELECTOR: only artifacts with a CLOSED checkpoint whose
   * `files_changed` contains this path. Window flags are rejected in
   * this mode (file provenance is current state, never time-filtered).
   */
  touching?: string;
  /**
   * Artifact SELECTOR: `<ref1>..<ref2>` — artifacts whose recorded head
   * shas (checkpoint / summary / pre-pr) intersect `git rev-list
   * ref1..ref2`. Rejects `--branch`/`--all-branches` (the sha set is
   * branch-agnostic), window flags (the range IS the window), and
   * `--touching` (two selectors).
   */
  between?: string;
  /**
   * Cross-project mode: fan out over every archived project's index. The
   * current project's hot and retained archive projections are deduplicated
   * freshest-first, with ties using hot. Implies all branches; rejects
   * `--branch` and the repo-anchored selectors
   * (`--touching` file provenance and `--between` git ranges are
   * meaningful only within one repo).
   */
  allProjects?: boolean;
  imported?: boolean;
  json?: boolean;
}

export const DEFAULT_BARE_LIST_LIMIT = 50;

function isBareList(opts: ListOptions): boolean {
  return (
    opts.branch === undefined &&
    opts.state === undefined &&
    opts.allBranches !== true &&
    opts.limit === undefined &&
    opts.since === undefined &&
    opts.until === undefined &&
    opts.activeSince === undefined &&
    opts.activeUntil === undefined &&
    opts.touching === undefined &&
    opts.between === undefined &&
    opts.allProjects !== true &&
    opts.imported !== true
  );
}

export function resolveListLimit(opts: ListOptions): number | undefined {
  return opts.limit ?? (isBareList(opts) ? DEFAULT_BARE_LIST_LIMIT : undefined);
}

/**
 * Tasks can be multi-line (imported artifacts embed the commit list);
 * raw newlines would render as extra table rows. One line, truncated —
 * JSON output keeps the full text.
 */
function taskCell(task: string, max = 100): string {
  const single = task.replace(/\s+/gu, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1).trimEnd()}…` : single;
}

/**
 * Table ID cell. Every other list surface already renders the 8-char prefix,
 * and the table headers reserve exactly that — padding a full 36-char UUID to
 * 8 is a no-op that shoves every later column out from under its heading.
 * `--json` carries the full id.
 */
function idCell(id: string): string {
  return id.slice(0, 8).padEnd(8);
}

const VALID_STATES: ArtifactState[] = ['planned', 'active', 'blocked', 'summarized'];

export interface StateFilter {
  /**
   * Coarse storage-side filter (the SQLite status column). Used ONLY by
   * the archive-backed --all-projects arm, where no artifact.json
   * exists to derive an exact state. Hot-store arms must NOT prefilter
   * by it: an unreadable artifact in the other coarse bucket would
   * escape the degraded-row disclosure entirely.
   */
  status: ArtifactStatus;
  /** Exact post-filter on the DERIVED state. Always set. */
  state: ArtifactState;
}

interface ArchiveStateFilterWarning {
  kind: 'archive_state_filter_unevaluable';
  state: 'planned' | 'blocked';
  projects: Array<{ project_id: string; project: string }>;
  message: string;
}

/**
 * Validate the raw `--state` flag value: every state carries an exact
 * post-filter on the DERIVED state (the coarse status is used only by the
 * archive-backed --all-projects arm, which has no artifact.json). Exported for
 * direct unit testing — production callers go through `listAction`.
 */
export function parseStateFilter(raw: string | undefined): StateFilter | undefined {
  if (raw === undefined) return undefined;
  if (!VALID_STATES.includes(raw as ArtifactState)) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `--state must be one of: ${VALID_STATES.join(', ')}; got "${raw}".`,
      'state'
    );
  }
  if (raw === 'summarized') return { status: 'complete', state: 'summarized' };
  return { status: 'active', state: raw as ArtifactState };
}

// Window/limit parsers live beside the scope resolver (lib/artifact-scope.ts);
// re-exported here for their historical import path.
export { assertWindowOrdered, parseLimit, parseSince, parseUntil };

/**
 * Fixed provenance disclosure carried in the `--touching` JSON envelope (and
 * relayed by the tour skill): the rollup can only ever see CLOSED checkpoints,
 * because `files_changed` is a close-time payload — an open checkpoint has
 * nothing to match yet.
 */
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
 * Exported for direct unit testing — production callers go through
 * `listAction`.
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

async function runBetween(opts: ListOptions): Promise<void> {
  if (opts.branch !== undefined || opts.allBranches) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--between already spans branches (the recorded-sha set is branch-agnostic); ' +
        'drop --branch/--all-branches.',
      'between'
    );
  }
  if (
    opts.since !== undefined ||
    opts.until !== undefined ||
    opts.activeSince !== undefined ||
    opts.activeUntil !== undefined
  ) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'window flags have no effect with --between; the ref range IS the window. ' +
        'Drop the window flags.',
      'between'
    );
  }
  const { from, to } = parseBetweenRange(opts.between as string);
  const filter = parseStateFilter(opts.state);
  const limit = parseLimit(opts.limit);
  const ctx = await buildContext({ mintArchiveIdentity: false });
  try {
    const fromSha = await ctx.repo.resolveCommit(from);
    if (fromSha === null) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--between: could not resolve "${from}" to a commit.`,
        'between'
      );
    }
    const toSha = await ctx.repo.resolveCommit(to);
    if (toSha === null) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--between: could not resolve "${to}" to a commit.`,
        'between'
      );
    }
    const revListShas = new Set(await ctx.repo.listCommitShasBetween(fromSha, toSha));
    // Candidates disclosure only makes sense when the RAW ref2 text names a
    // local branch whose lineage membership we can compare against.
    const ref2LocalBranch = (await ctx.repo.branchExists(to)) ? to : null;
    const archive = await openCurrentProjectArchive(ctx.repo, ctx.repoRoot);
    try {
      const project: ProjectHandle = {
        projectId: archive?.projectId ?? '',
        displayName: archive?.displayName ?? path.basename(ctx.repoRoot),
        store: ctx.store.store,
        hot: true,
        hotStore: ctx.store,
        archiveStore: archive?.store,
        archiveMeta: archive?.meta,
        projectDir: archive?.projectDir ?? '',
        issues: archive?.issues ?? [],
        close: () => {},
      };
      const selected = await selectProjectArtifacts(project);
      const artifacts: BetweenArtifactInput[] = [];
      const degraded = new Set(
        unavailableArtifactIdsWithoutSelectedProjection(archive?.issues ?? [], selected)
      );
      const scopeWarning = formatProjectScopeWarnings(archive?.issues ?? []);
      if (scopeWarning.length > 0) writeTerminalSafeStderr(scopeWarning);

      for (const selectedArtifact of selected) {
        const a = selectedArtifact.row;
        const shas: BetweenSha[] = [];
        let summary;
        let artifactJson;
        if (selectedArtifact.source === 'hot') {
          if (selectedArtifact.hotReadError !== undefined) {
            await readForEnumeration(a.id, 'list --between', () =>
              Promise.reject(selectedArtifact.hotReadError)
            );
            degraded.add(a.id);
            continue;
          }
          for (const cp of selectedArtifact.store.getCheckpoints(a.id)) {
            shas.push({ source: 'checkpoint', n: cp.n, head_sha: cp.head_sha });
          }
          const summaryRead = await readForEnumeration(a.id, 'list --between', () =>
            ctx.store.readSummary(a.id)
          );
          const artifactRead =
            summaryRead.kind === 'unreadable'
              ? summaryRead
              : await readForEnumeration(a.id, 'list --between', () =>
                  ctx.store.readArtifact(a.id)
                );
          if (summaryRead.kind === 'unreadable' || artifactRead.kind === 'unreadable') {
            degraded.add(a.id);
            continue;
          }
          summary = summaryRead.value;
          artifactJson = artifactRead.value;
        } else {
          const threadRead = await readForEnumeration(a.id, 'list --between', () =>
            loadArtifactThreadFromArchive(project.projectDir, a.id)
          );
          if (threadRead.kind === 'unreadable') {
            degraded.add(a.id);
            continue;
          }
          const thread = threadRead.value;
          if (thread.lossyLines > 0) {
            writeTerminalSafeStderr(
              `warning: artifact ${a.id} is unreadable in list --between — the archive copy ` +
                `has ${thread.lossyLines} corrupt event-log line(s)\n`
            );
            degraded.add(a.id);
            continue;
          }
          for (const cp of thread.checkpoints) {
            shas.push({ source: 'checkpoint', n: cp.n, head_sha: cp.head_sha });
          }
          summary = thread.summary;
          artifactJson = thread.artifactJson;
        }
        if (summary?.head_sha) shas.push({ source: 'summary', head_sha: summary.head_sha });
        const prePrSha = artifactJson?.pre_pr_checked_head_sha ?? null;
        if (prePrSha !== null) shas.push({ source: 'pre_pr', head_sha: prePrSha });
        const state = artifactJson?.state ?? fallbackState(a.status);
        if (filter?.state !== undefined && state !== filter.state) continue;
        artifacts.push({
          id: a.id,
          label: a.label ?? 'unlabelled',
          task: a.task,
          branch: a.branch,
          state,
          started_at: a.started_at,
          completed_at: a.completed_at ?? null,
          shas,
          lineageBranches:
            ref2LocalBranch === null
              ? []
              : (artifactJson?.branch_lineage.map((entry) => entry.branch) ?? []),
          origin: a.origin_kind ?? null,
        });
      }
      const { matched, unmatched_candidates } = collectBetweenArtifacts({
        artifacts,
        revListShas,
        ref2LocalBranch,
      });
      const visible = limit === undefined ? matched : matched.slice(0, limit);

      if (opts.json) {
        emitOk({
          between: {
            from,
            to,
            from_sha: fromSha,
            to_sha: toSha,
            commit_count: revListShas.size,
            ref2_branch: ref2LocalBranch,
          },
          degraded_artifacts: [...degraded],
          matched: visible,
          unmatched_candidates,
        });
        return;
      }
      writeTerminalSafeStdout(
        formatHumanBetween(from, to, visible, unmatched_candidates, [...degraded])
      );
    } finally {
      archive?.close();
    }
  } finally {
    ctx.store.close();
  }
}

function formatHumanBetween(
  from: string,
  to: string,
  matched: BetweenMatch[],
  candidates: BetweenCandidate[],
  degraded: readonly string[] = []
): string {
  const lines: string[] = [];
  if (matched.length === 0) {
    lines.push(`No artifacts with recorded work in ${from}..${to}.`);
  } else {
    lines.push(`Artifacts with recorded work in ${from}..${to}:`, '');
    for (const m of matched) {
      const anchors = m.matched_shas
        .map((s) => (s.source === 'checkpoint' ? `cp${s.n}` : s.source))
        .join(', ');
      lines.push(
        `${m.id.slice(0, 8)}  ${importedTag(m.origin)}${m.label} ` +
          `(${m.branch}, ${m.state}) via ${anchors}`
      );
    }
  }
  if (candidates.length > 0) {
    lines.push('', 'Possibly rebased away (lineage matches, no recorded sha in range):');
    for (const c of candidates) {
      lines.push(`${c.id.slice(0, 8)}  ${importedTag(c.origin)}${c.label} (${c.branch})`);
    }
  }
  if (degraded.length > 0) {
    lines.push(
      '',
      `${degraded.length} artifact(s) unreadable (their head SHAs are unknown, so the ` +
        `range walk could not place them): ${degraded.join(', ')} — run \`orcaops doctor\``
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function runTouching(opts: ListOptions): Promise<void> {
  const file = (opts.touching ?? '').trim();
  if (file === '') {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--touching requires a non-empty path.',
      'touching'
    );
  }
  if (
    opts.since !== undefined ||
    opts.until !== undefined ||
    opts.activeSince !== undefined ||
    opts.activeUntil !== undefined
  ) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'window flags have no effect with --touching; file provenance is current state ' +
        '(closed checkpoints only), never time-filtered. Drop the window flags.',
      'touching'
    );
  }
  const filter = parseStateFilter(opts.state);
  const limit = parseLimit(opts.limit);
  const ctx = await buildContext({ mintArchiveIdentity: false });
  try {
    // LIKE-scan cost acceptance: findCheckpointsTouchingFile is an unindexed
    // checkpoint-table scan + exact JS re-filter — the same query `why` runs
    // per invocation; single-digit ms at OSS per-repo scale.
    const hits: TouchingHit[] = [];
    for (const cp of ctx.store.store.findCheckpointsTouchingFile({ file })) {
      hits.push({
        artifact_id: cp.artifact_id,
        n: cp.n,
        closed_at: cp.closed_at,
        summary: cp.summary,
        completed_step_ids: cp.completed_step_ids,
      });
    }
    // Branch scope via lineage MEMBERSHIP (identical rule to plain `list`),
    // NOT findCheckpointsTouchingFile's `a.branch` column filter — the two
    // diverge for artifacts whose branch_lineage spans multiple names.
    // `--imported` mirrors the main arm: it drops branch scope (seeded
    // lineage records the remote-tracking ref) and keeps imported hits only.
    const scope = await resolveBranchReadScope(
      ctx,
      {
        branch: opts.branch,
        allBranches: opts.allBranches || (opts.imported === true && opts.branch === undefined),
      },
      { imported: 'disclose' }
    );
    const scopedRows = opts.imported
      ? scope.scopedRows.filter((row) => row.origin_kind === 'git-import')
      : scope.defaultScope
        ? scope.rows
        : scope.scopedRows;
    const hitArtifactIds = new Set(hits.map((h) => h.artifact_id));
    // Imported artifacts whose checkpoints touched the file but fall outside
    // the default branch scope — owed the standardized trailer.
    const importedHitsWithheld =
      opts.imported || !scope.defaultScope
        ? 0
        : scope.importedRows.filter((row) => hitArtifactIds.has(row.id)).length;
    const importedTouchingHint = `orcaops list --touching ${file} --imported`;
    const artifactMeta = new Map<string, TouchingArtifactMeta>();
    const degraded: string[] = [];
    for (const a of scopedRows) {
      if (!hitArtifactIds.has(a.id)) continue;
      const read = await readForEnumeration(a.id, 'list --touching', () =>
        ctx.store.readArtifact(a.id)
      );
      if (read.kind === 'unreadable') {
        // A state filter cannot evaluate this row; disclose, never guess.
        degraded.push(a.id);
        if (filter?.state !== undefined) continue;
      }
      const artifactJson = read.kind === 'readable' ? read.value : null;
      const state =
        read.kind === 'unreadable' ? null : (artifactJson?.state ?? fallbackState(a.status));
      if (filter?.state !== undefined && state !== filter.state) continue;
      artifactMeta.set(a.id, {
        label: a.label ?? 'unlabelled',
        task: a.task,
        branch: a.branch,
        state,
        origin: a.origin_kind ?? null,
        ...(read.kind === 'unreadable' ? { unreadable: true as const } : {}),
      });
    }
    const rollups = collectTouchingRollup({ hits, artifactMeta });
    const visible = limit === undefined ? rollups : rollups.slice(0, limit);

    if (opts.json) {
      emitOk({
        touching: file,
        note: TOUCHING_NOTE,
        artifacts: visible,
        degraded_artifacts: degraded,
        ...(importedHitsWithheld > 0
          ? {
              imported_artifacts: importedArtifactsDisclosure(
                importedHitsWithheld,
                importedTouchingHint
              ),
            }
          : {}),
      });
      return;
    }
    writeTerminalSafeStdout(
      formatHumanTouching(file, visible, degraded, importedHitsWithheld, importedTouchingHint)
    );
  } finally {
    ctx.store.close();
  }
}

function formatHumanTouching(
  file: string,
  artifacts: TouchingArtifactRollup[],
  degraded: readonly string[] = [],
  importedWithheld = 0,
  importedHint = 'orcaops list --imported'
): string {
  if (artifacts.length === 0 && degraded.length === 0) {
    return importedWithheld > 0
      ? `No closed checkpoints touched ${file}.\n` +
          `${importedTrailerLine(importedWithheld, importedHint)}\n`
      : `No closed checkpoints touched ${file}.\n`;
  }
  const lines: string[] = [`Artifacts touching ${file} (${TOUCHING_NOTE}):`, ''];
  for (const a of artifacts) {
    lines.push(
      `${a.id.slice(0, 8)}  ${importedTag(a.origin)}${a.label} ` +
        `(${a.branch}, ${a.state ?? 'unreadable'})`
    );
    for (const cp of a.checkpoints) {
      lines.push(`  cp ${cp.n}  ${cp.closed_at}  ${cp.summary.split('\n')[0]}`);
    }
  }
  if (importedWithheld > 0) {
    lines.push('', importedTrailerLine(importedWithheld, importedHint));
  }
  if (degraded.length > 0) {
    lines.push(
      '',
      `${degraded.length} artifact(s) unreadable (not classifiable): ${degraded.join(', ')} — run \`orcaops doctor\``
    );
  }
  lines.push('');
  return lines.join('\n');
}

export async function listAction(opts: ListOptions = {}): Promise<void> {
  try {
    if (opts.touching !== undefined && opts.between !== undefined) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--touching and --between are both artifact selectors with different semantics; ' +
          'use one per invocation.',
        'between'
      );
    }
    if (opts.allProjects) {
      if (opts.branch !== undefined) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          '--all-projects implies all branches; drop --branch.',
          'branch'
        );
      }
      if (opts.touching !== undefined || opts.between !== undefined) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          '--touching and --between are repo-anchored selectors (file paths / git ranges) ' +
            'and cannot combine with --all-projects.',
          opts.touching !== undefined ? 'touching' : 'between'
        );
      }
      await runListAllProjects(opts);
      return;
    }
    if (opts.between !== undefined) {
      await runBetween(opts);
      return;
    }
    if (opts.touching !== undefined) {
      await runTouching(opts);
      return;
    }
    const filter = parseStateFilter(opts.state);
    const limit = parseLimit(opts.limit);
    const since = parseSince(opts.since, 'since');
    const until = parseUntil(opts.until, 'until');
    const activeSince = parseSince(opts.activeSince, 'active-since');
    const activeUntil = parseUntil(opts.activeUntil, 'active-until');
    assertWindowOrdered(since, until, 'since', 'until');
    assertWindowOrdered(activeSince, activeUntil, 'active-since', 'active-until');
    const window = { since, until, activeSince, activeUntil };
    const bareList = isBareList(opts);
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      // Strict branch-name membership filter via lineage_branches: an
      // artifact "belongs to" a branch iff any entry in its
      // branch_lineage[] has that branch name. `--all-branches` and an
      // unset --branch both fall through to the unfiltered listArtifacts
      // path; `--imported` without --branch deliberately drops branch
      // scope (seeded lineage records the remote-tracking ref).
      // No coarse status prefilter: the exact state is decided per row
      // below, and an unreadable artifact must reach the disclosure
      // regardless of which coarse bucket SQLite has it in.
      const scope = await resolveBranchReadScope(
        ctx,
        {
          branch: opts.branch,
          allBranches: opts.allBranches || (opts.imported === true && opts.branch === undefined),
        },
        { imported: 'disclose' },
        { ...window }
      );
      const allRows = scope.scopedRows;
      const importedCount = bareList
        ? scope.importedRows.length
        : allRows.filter((row) => row.origin_kind === 'git-import').length;
      const rows = opts.imported
        ? allRows.filter((row) => row.origin_kind === 'git-import')
        : bareList
          ? scope.rows
          : allRows;
      // The public vocabulary is the artifact.json lifecycle `state`
      // (planned / active / blocked / summarized); the SQLite status column
      // is internal coarse plumbing and folds in as a fallback. One file
      // read per row is fine for OSS-grade list sizes.
      const enriched = await Promise.all(
        rows.map(async (a) => {
          const read = await readForEnumeration(a.id, 'list', () => ctx.store.readArtifact(a.id));
          const unreadable = read.kind === 'unreadable';
          const artifactJson = read.kind === 'readable' ? read.value : null;
          return {
            id: a.id,
            // The row label follows the latest plan revision (enrichment
            // rewrites it on imported artifacts); task alone would keep
            // rendering the pre-enrichment wording.
            label: a.label ?? 'unlabelled',
            task: a.task,
            branch: a.branch,
            // Unreadable ⇒ unknown, never a substituted state.
            state: unreadable ? null : (artifactJson?.state ?? fallbackState(a.status)),
            started_at: a.started_at,
            completed_at: a.completed_at,
            checkpoint_count: ctx.store.store.getCheckpoints(a.id).length,
            origin: a.origin_kind ?? null,
            ...(unreadable ? { unreadable: true as const } : {}),
          };
        })
      );
      // A state filter cannot evaluate an unreadable row — such rows are
      // excluded from the match but disclosed, never silently dropped.
      const degraded = enriched.filter((a) => a.unreadable === true).map((a) => a.id);
      const stateFiltered =
        filter?.state === undefined ? enriched : enriched.filter((a) => a.state === filter.state);

      const effectiveLimit = resolveListLimit({ ...opts, limit });
      const visible =
        effectiveLimit === undefined ? stateFiltered : stateFiltered.slice(0, effectiveLimit);
      const truncated = effectiveLimit !== undefined && stateFiltered.length > effectiveLimit;

      if (opts.json) {
        emitOk({
          artifacts: visible,
          degraded_artifacts: degraded,
          ...(bareList
            ? {
                imported_artifacts: importedArtifactsDisclosure(importedCount),
                ...(truncated ? { truncated: true } : {}),
              }
            : {}),
        });
        return;
      }
      writeTerminalSafeStdout(
        formatHumanList(visible, degraded, bareList ? importedCount : 0, truncated)
      );
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
 * `list --all-projects`: one query per project store (all branches by
 * construction — lineage filtering is repo-local), merged newest-first. Hot
 * current-project rows derive lifecycle state from the selected hot or archive
 * thread, or carry state null + `unreadable` on refusal. Fully archive-backed
 * projects keep the coarse fallback fold.
 */
async function runListAllProjects(opts: ListOptions): Promise<void> {
  const filter = parseStateFilter(opts.state);
  const limit = parseLimit(opts.limit);
  const since = parseSince(opts.since, 'since');
  const until = parseUntil(opts.until, 'until');
  const activeSince = parseSince(opts.activeSince, 'active-since');
  const activeUntil = parseUntil(opts.activeUntil, 'active-until');
  assertWindowOrdered(since, until, 'since', 'until');
  assertWindowOrdered(activeSince, activeUntil, 'active-since', 'active-until');
  const window = { since, until, activeSince, activeUntil };

  const scope = await openAllProjects();
  try {
    const projectResults = await Promise.all(
      scope.projects.map(async (p) => {
        const selected = await selectProjectArtifacts(p);
        const hotEligible = new Set(
          (p.hotStore ? p.store.listArtifacts({ ...window }) : []).map((row) => row.id)
        );
        const archiveStore = p.hotStore ? p.archiveStore : p.store;
        const archiveEligible = new Set(
          (archiveStore?.listArtifacts({ status: filter?.status, ...window }) ?? []).map(
            (row) => row.id
          )
        );
        const rows = await Promise.all(
          selected
            .filter((artifact) =>
              artifact.source === 'hot'
                ? hotEligible.has(artifact.row.id)
                : archiveEligible.has(artifact.row.id)
            )
            .map(async (artifact) => {
              const a = artifact.row;
              let state: ArtifactState | null = fallbackState(a.status);
              let unreadable = artifact.hotReadError !== undefined;
              if (artifact.hotReadError !== undefined) {
                await readForEnumeration(a.id, 'list --all-projects', () =>
                  Promise.reject(artifact.hotReadError)
                );
              }
              if (artifact.source === 'hot' && !unreadable) {
                const read = await readForEnumeration(a.id, 'list --all-projects', () =>
                  p.hotStore!.readArtifact(a.id)
                );
                unreadable = read.kind === 'unreadable';
                const artifactJson = read.kind === 'readable' ? read.value : null;
                state = unreadable ? null : (artifactJson?.state ?? fallbackState(a.status));
              } else if (artifact.source === 'archive' && p.hotStore !== undefined) {
                const read = await readForEnumeration(a.id, 'list --all-projects', () =>
                  loadArtifactThreadFromArchive(p.projectDir, a.id)
                );
                const thread = read.kind === 'readable' ? read.value : null;
                unreadable = read.kind === 'unreadable' || (thread?.lossyLines ?? 0) > 0;
                if ((thread?.lossyLines ?? 0) > 0) {
                  writeTerminalSafeStderr(
                    `warning: artifact ${a.id} is unreadable in list --all-projects — the ` +
                      `archive copy has ${thread!.lossyLines} corrupt event-log line(s)\n`
                  );
                }
                state = unreadable
                  ? null
                  : (thread?.artifactJson?.state ?? fallbackState(a.status));
              } else if (unreadable) {
                state = null;
              }
              return {
                id: a.id,
                label: a.label ?? 'unlabelled',
                task: a.task,
                branch: a.branch,
                state,
                started_at: a.started_at,
                completed_at: a.completed_at,
                checkpoint_count: artifact.store.getCheckpoints(a.id).length,
                project_id: p.projectId,
                project: p.displayName,
                origin: a.origin_kind ?? null,
                ...(unreadable ? { unreadable: true as const } : {}),
              };
            })
        );
        return {
          rows,
          archiveServed: selected.some((artifact) => artifact.source === 'archive'),
          project: p,
        };
      })
    );
    const archiveStateWarning = buildArchiveStateFilterWarning(
      projectResults.filter((result) => result.archiveServed).map((result) => result.project),
      filter?.state
    );
    const merged = projectResults.flatMap((result) => result.rows);
    // This envelope has no degraded_artifacts key (named deferred disclosure
    // gap during the freeze), so a --state filter keeps unreadable rows
    // in-band rather than silently dropping what it cannot evaluate — which
    // also means degraded rows occupy --limit slots in a filtered listing.
    const filtered = merged.filter(
      (a) => filter?.state === undefined || a.state === filter.state || a.unreadable === true
    );
    filtered.sort((a, b) =>
      a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0
    );
    const visible = limit === undefined ? filtered : filtered.slice(0, limit);

    if (opts.json) {
      const warnings = [
        ...scope.issues,
        ...(archiveStateWarning === null ? [] : [archiveStateWarning]),
      ];
      emitOk({
        all_projects: true,
        projects: scope.projects.length,
        artifacts: visible,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
      return;
    }
    const humanWarnings =
      formatProjectScopeWarnings(scope.issues) +
      formatArchiveStateFilterWarning(archiveStateWarning);
    if (visible.length === 0) {
      const emptyMessage =
        archiveStateWarning === null
          ? 'No artifacts captured in any archived project.\n'
          : 'No evaluable artifacts matched this state filter.\n';
      writeTerminalSafeStdout(emptyMessage + humanWarnings);
      return;
    }
    const lines: string[] = [];
    lines.push('ID       PROJECT             STATE        CPS  BRANCH              LABEL — TASK');
    for (const a of visible) {
      const id = idCell(a.id);
      const project = a.project.length > 18 ? a.project.slice(0, 15) + '...' : a.project.padEnd(18);
      const stateCol = (a.state ?? 'unreadable').padEnd(12);
      const cps = String(a.checkpoint_count).padStart(3);
      const branch = a.branch.length > 19 ? a.branch.slice(0, 16) + '...' : a.branch.padEnd(19);
      lines.push(
        `${id} ${project} ${stateCol} ${cps}  ${branch} ` +
          `${importedTag(a.origin)}${a.label} — ${taskCell(a.task)}`
      );
    }
    lines.push('');
    writeTerminalSafeStdout(lines.join('\n') + humanWarnings);
  } finally {
    scope.close();
  }
}

function buildArchiveStateFilterWarning(
  projects: Awaited<ReturnType<typeof openAllProjects>>['projects'],
  state: ArtifactState | undefined
): ArchiveStateFilterWarning | null {
  if (state !== 'planned' && state !== 'blocked') return null;
  const archiveOnlyProjects = projects
    .filter((project) => project.hotStore === undefined)
    .map((project) => ({ project_id: project.projectId, project: project.displayName }))
    .sort((a, b) => a.project_id.localeCompare(b.project_id));
  if (archiveOnlyProjects.length === 0) return null;
  return {
    kind: 'archive_state_filter_unevaluable',
    state,
    projects: archiveOnlyProjects,
    message: `Archive-only projects do not retain exact ${state} state; matching artifacts may be omitted.`,
  };
}

function formatArchiveStateFilterWarning(warning: ArchiveStateFilterWarning | null): string {
  if (warning === null) return '';
  return [
    '',
    `Warning: Partial state results — ${warning.message}`,
    ...warning.projects.map((project) => `  [${project.project}] project_id=${project.project_id}`),
    '',
  ].join('\n');
}

function formatHumanList(
  artifacts: Array<{
    id: string;
    label: string;
    task: string;
    branch: string;
    state: ArtifactState | null;
    started_at: string;
    checkpoint_count: number;
    origin: ArtifactOriginKind | null;
  }>,
  degraded: readonly string[] = [],
  importedCount = 0,
  truncated = false
): string {
  if (artifacts.length === 0 && degraded.length === 0 && importedCount === 0) {
    return 'No artifacts captured.\n';
  }
  const lines: string[] = [];
  if (artifacts.length === 0 && importedCount > 0) {
    // Mirrors `status`'s imported-only shape: without this line the
    // imported trailer reads as a continuation of nothing.
    lines.push('No live artifacts captured.', '');
  }
  if (artifacts.length > 0) {
    lines.push('ID       STATE        CPS  BRANCH                     LABEL — TASK');
    for (const a of artifacts) {
      const id = idCell(a.id);
      const stateCol = (a.state ?? 'unreadable').padEnd(12);
      const cps = String(a.checkpoint_count).padStart(3);
      const branch = a.branch.length > 26 ? a.branch.slice(0, 23) + '...' : a.branch.padEnd(26);
      lines.push(
        `${id} ${stateCol} ${cps}  ${branch} ${importedTag(a.origin)}${a.label} — ${taskCell(a.task)}`
      );
    }
    lines.push('');
  }
  if (truncated) {
    lines.push(
      `Showing the newest ${DEFAULT_BARE_LIST_LIMIT} live artifacts; pass --limit to choose a bound.`,
      ''
    );
  }
  if (importedCount > 0) {
    lines.push(importedTrailerLine(importedCount), '');
  }
  if (degraded.length > 0) {
    lines.push(
      `${degraded.length} artifact(s) unreadable (not classifiable): ${degraded.join(', ')} — run \`orcaops doctor\``
    );
  }
  return lines.join('\n');
}
