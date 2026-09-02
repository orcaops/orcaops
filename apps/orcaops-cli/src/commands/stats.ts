import {
  captureWorktreeTreeSha,
  diffSnapshotTrees,
  matchDiffAgainstManifests,
} from '@orcaops/core';
import type { CodingSessionRow, EvaluatorRunStatsRow, StoreStats } from '@orcaops/storage';
import { resolveCaptureExcludes } from '@orcaops/storage';

import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { loadInFlightOnBranch } from '../lib/active-artifact.js';
import {
  type SelectedArtifactProjection,
  selectProjectArtifacts,
} from '../lib/artifact-projections.js';
import { resolveBranchReadScope } from '../lib/artifact-scope.js';
import { buildContext, type CliContext } from '../lib/context.js';
import { readForEnumeration } from '../lib/enumeration-read.js';
import { loadManifestSources } from '../lib/manifest-sources.js';
import { formatProjectScopeWarnings, openAllProjects } from '../lib/project-scope.js';

/**
 * `orcaops stats [--json]` — repo-wide store aggregates. The base sections
 * (`artifacts` / `checkpoints` / `summaries` / `coding_sessions`) are frozen.
 * Everything else (`evaluators`, `plan_revisions`, `checkpoint_durations`,
 * `hygiene`) rides in SIBLING sections — additive keys, never a reshape, so
 * new sections stay non-breaking.
 */
/**
 * `hygiene.diff_attributed_pct`: the matcher's unambiguous
 * coverage over the latest artifact's base→worktree window. Every failure
 * path answers null — this is a HYGIENE HINT, never a gate.
 */
async function computeDiffAttributedPct(ctx: CliContext): Promise<number | null> {
  try {
    const branch = await ctx.repo.getCurrentBranch();
    const inFlight = await loadInFlightOnBranch(ctx, branch);
    // Seeded participation (storage-class rule, decided explicitly): the
    // hygiene window anchors on live work ('live-only'); imported manifests
    // still participate as attribution evidence ('include') below.
    const liveScope = await resolveBranchReadScope(ctx, { branch }, { imported: 'live-only' });
    const artifact = inFlight[0]?.row ?? liveScope.rows[0] ?? null;
    if (artifact === null || artifact.base_sha.length === 0) return null;
    const live = await captureWorktreeTreeSha(ctx.repo, {
      excludePatterns: resolveCaptureExcludes(ctx.config.capture).patterns,
    });
    if (!live.ok) return null;
    // A conflicted worktree keeps the pct null: marker hunks would silently
    // dip a scalar hint that has nowhere to disclose why.
    if (live.unmerged_paths.length > 0) return null;
    const cap = ctx.config.diff_fingerprint.max_diff_bytes;
    const diff = await diffSnapshotTrees({
      repo: ctx.repo,
      openTreeSha: artifact.base_sha,
      closeTreeSha: live.tree_sha,
      maxDiffBytes: cap,
    });
    if (!diff.ok) return null;
    // {} = default scope (current branch), so 'include' unions the imported corpus.
    const attributionScope = await resolveBranchReadScope(ctx, {}, { imported: 'include' });
    const { sources, skippedUnreadableArtifacts } = await loadManifestSources(
      ctx,
      attributionScope.rows
    );
    // A skip-reduced pool must degrade to null, never a confident number:
    // the skipped artifact's manifests could have made any hunk ambiguous.
    if (skippedUnreadableArtifacts.length > 0) return null;
    if (sources.length === 0) return null;
    const matched = await matchDiffAgainstManifests({
      diffBytes: diff.diff,
      truncated: diff.truncated,
      maxDiffBytes: cap,
      sources,
    });
    return matched.coverage.attributed_pct;
  } catch {
    return null;
  }
}

export interface StatsOptions {
  /**
   * Cross-project mode: per-project store rollups + grand
   * totals as SIBLING sections (`projects[]`, `totals`) — the
   * single-project sections are untouched by construction.
   */
  allProjects?: boolean;
  json?: boolean;
}

/** One evaluator's run counts + graded pass rate. */
export interface EvaluatorRateRow extends EvaluatorRunStatsRow {
  /**
   * pass / (pass + violation) over completed runs; null when nothing was
   * graded (`info` verdicts, errors, and skips are not graded outcomes).
   */
  pass_rate: number | null;
}

/** Add `pass_rate` to raw per-evaluator counts. Exported for unit tests. */
export function computeEvaluatorRates(
  rows: ReadonlyArray<EvaluatorRunStatsRow>
): EvaluatorRateRow[] {
  return rows.map((r) => {
    const graded = r.pass + r.violation;
    return { ...r, pass_rate: graded === 0 ? null : r.pass / graded };
  });
}

export interface RevisionChurn {
  artifacts_with_plan: number;
  /** Artifacts whose plan was revised at least once (max revision_n > 0). */
  revised_artifacts: number;
  max_revisions: number;
  mean_revisions: number;
  /** revision-count -> artifact count, e.g. {"0": 5, "2": 1}. */
  histogram: Record<string, number>;
}

/** Churn rollup over per-artifact latest revision_n. Exported for unit tests. */
export function computeRevisionChurn(
  counts: ReadonlyArray<{ max_revision_n: number }>
): RevisionChurn {
  const histogram: Record<string, number> = {};
  let max = 0;
  let sum = 0;
  let revised = 0;
  for (const c of counts) {
    const key = String(c.max_revision_n);
    histogram[key] = (histogram[key] ?? 0) + 1;
    max = Math.max(max, c.max_revision_n);
    sum += c.max_revision_n;
    if (c.max_revision_n > 0) revised += 1;
  }
  return {
    artifacts_with_plan: counts.length,
    revised_artifacts: revised,
    max_revisions: max,
    mean_revisions: counts.length === 0 ? 0 : sum / counts.length,
    histogram,
  };
}

export interface DurationStats {
  closed_total: number;
  min_ms: number | null;
  max_ms: number | null;
  mean_ms: number | null;
  median_ms: number | null;
  p90_ms: number | null;
}

/**
 * Duration aggregates over closed-checkpoint intervals (`closed_at −
 * opened_at`, ms). Median averages the two middles on even counts; p90 is
 * the nearest-rank percentile (`sorted[ceil(0.9·n) − 1]`). Exported for
 * unit tests (seeded-timestamp store tests pin the interval source).
 */
export function computeDurationStats(
  intervals: ReadonlyArray<{ opened_at: string; closed_at: string }>
): DurationStats {
  const durations = intervals
    .map((i) => new Date(i.closed_at).getTime() - new Date(i.opened_at).getTime())
    .sort((a, b) => a - b);
  const n = durations.length;
  if (n === 0) {
    return {
      closed_total: 0,
      min_ms: null,
      max_ms: null,
      mean_ms: null,
      median_ms: null,
      p90_ms: null,
    };
  }
  const median =
    n % 2 === 1 ? durations[(n - 1) / 2] : (durations[n / 2 - 1] + durations[n / 2]) / 2;
  return {
    closed_total: n,
    min_ms: durations[0],
    max_ms: durations[n - 1],
    mean_ms: durations.reduce((a, b) => a + b, 0) / n,
    median_ms: median,
    p90_ms: durations[Math.ceil(0.9 * n) - 1],
  };
}

/** Mirrored session rows are cumulative counters, so identity dedup is fieldwise max. */
export function mergeCodingSessions(
  sources: ReadonlyArray<ReadonlyArray<CodingSessionRow>>
): CodingSessionRow[] {
  const merged = new Map<string, CodingSessionRow>();
  for (const source of sources) {
    for (const session of source) {
      const key = JSON.stringify([session.agent, session.session_id]);
      const prior = merged.get(key);
      if (prior === undefined) {
        merged.set(key, { ...session });
        continue;
      }
      merged.set(key, {
        ...prior,
        cumulative_input_tokens: Math.max(
          prior.cumulative_input_tokens,
          session.cumulative_input_tokens
        ),
        cumulative_output_tokens: Math.max(
          prior.cumulative_output_tokens,
          session.cumulative_output_tokens
        ),
        cumulative_cache_creation_input_tokens: Math.max(
          prior.cumulative_cache_creation_input_tokens,
          session.cumulative_cache_creation_input_tokens
        ),
        cumulative_cache_read_input_tokens: Math.max(
          prior.cumulative_cache_read_input_tokens,
          session.cumulative_cache_read_input_tokens
        ),
        as_of: prior.as_of > session.as_of ? prior.as_of : session.as_of,
        record_count: Math.max(prior.record_count, session.record_count),
      });
    }
  }
  return [...merged.values()].sort((a, b) =>
    a.agent === b.agent ? a.session_id.localeCompare(b.session_id) : a.agent.localeCompare(b.agent)
  );
}

function selectedStoreStats(selected: readonly SelectedArtifactProjection[]): StoreStats {
  const artifactStatus: Record<string, number> = {};
  const checkpointStatus: Record<string, number> = {};
  let checkpoints = 0;
  let summaries = 0;
  for (const artifact of selected) {
    artifactStatus[artifact.row.status] = (artifactStatus[artifact.row.status] ?? 0) + 1;
    for (const checkpoint of artifact.store.getCheckpoints(artifact.row.id)) {
      checkpointStatus[checkpoint.status] = (checkpointStatus[checkpoint.status] ?? 0) + 1;
      checkpoints += 1;
    }
    if (artifact.store.getSummary(artifact.row.id) !== null) summaries += 1;
  }
  return {
    artifacts: { total: selected.length, by_status: artifactStatus },
    checkpoints: { total: checkpoints, by_status: checkpointStatus },
    summaries: { total: summaries },
  };
}

/** Per-project rollup for `stats --all-projects`. */
async function runStatsAllProjects(opts: StatsOptions): Promise<void> {
  const scope = await openAllProjects();
  try {
    const zero = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const projects = await Promise.all(
      scope.projects.map(async (p) => {
        // Selection reads only index rows plus event-log timestamp metadata;
        // stats never parses an artifact projection in all-projects mode.
        const selected = await selectProjectArtifacts(p);
        const store = selectedStoreStats(selected);
        const sessions = mergeCodingSessions([
          p.store.listCodingSessions(),
          ...(p.hotStore && p.archiveStore ? [p.archiveStore.listCodingSessions()] : []),
        ]);
        const tokens = sessions.reduce(
          (acc, s) => ({
            input_tokens: acc.input_tokens + s.cumulative_input_tokens,
            output_tokens: acc.output_tokens + s.cumulative_output_tokens,
            cache_creation_input_tokens:
              acc.cache_creation_input_tokens + s.cumulative_cache_creation_input_tokens,
            cache_read_input_tokens:
              acc.cache_read_input_tokens + s.cumulative_cache_read_input_tokens,
          }),
          { ...zero }
        );
        return {
          project_id: p.projectId,
          project: p.displayName,
          hot: p.hot,
          ...store,
          coding_sessions: { total: sessions.length, tokens },
        };
      })
    );
    const totals = projects.reduce(
      (acc, p) => ({
        artifacts: acc.artifacts + p.artifacts.total,
        checkpoints: acc.checkpoints + p.checkpoints.total,
        summaries: acc.summaries + p.summaries.total,
        coding_sessions: acc.coding_sessions + p.coding_sessions.total,
      }),
      { artifacts: 0, checkpoints: 0, summaries: 0, coding_sessions: 0 }
    );

    if (opts.json) {
      emitOk({
        all_projects: true,
        projects,
        totals,
        ...(scope.issues.length > 0 ? { warnings: scope.issues } : {}),
      });
      return;
    }
    const lines: string[] = ['Store stats (all projects)'];
    for (const p of projects) {
      lines.push(
        `  ${p.project}${p.hot ? ' (current)' : ''}: ` +
          `${p.artifacts.total} artifacts, ${p.checkpoints.total} checkpoints, ` +
          `${p.summaries.total} summaries, ${p.coding_sessions.total} sessions`
      );
    }
    lines.push(
      `  totals: ${totals.artifacts} artifacts, ${totals.checkpoints} checkpoints, ` +
        `${totals.summaries} summaries, ${totals.coding_sessions} sessions`
    );
    lines.push('');
    writeTerminalSafeStdout(lines.join('\n') + formatProjectScopeWarnings(scope.issues));
  } finally {
    scope.close();
  }
}

/**
 * NOTE the health sweep below makes `stats` O(artifacts) over full
 * event-log reads (one recovery-aware `readArtifact` per row), and a
 * `rebuilt` verdict is served in memory without mutating the projection.
 * Measured 2026-08-07 (M1 Pro, 16 GB, Node v22.14.0): warm
 * median ~3.6 s on a real 6-artifact store (1,335 events, ~6 MB of
 * logs+sidecars, 87 checkpoints) vs ~0.5 s on a 50-artifact synthetic
 * store (700 events, 4.6 MB) — cost tracks log bytes and the
 * per-checkpoint diff-attribution git work, not row count (~0.45 s of
 * it is CLI startup; an `orcaops rebuild` replay adds ~1.2-1.8 s).
 * Revisit when warm `stats` nears ~2 s, reached around ~5 MB of event
 * logs on this machine class. The --all-projects arm never runs it.
 */
export async function statsAction(opts: StatsOptions = {}): Promise<void> {
  try {
    if (opts.allProjects) {
      await runStatsAllProjects(opts);
      return;
    }
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const store = ctx.store.store.getStoreStats();
      const sessions = ctx.store.store.listCodingSessions();
      const tokens = sessions.reduce(
        (acc, s) => ({
          input_tokens: acc.input_tokens + s.cumulative_input_tokens,
          output_tokens: acc.output_tokens + s.cumulative_output_tokens,
          cache_creation_input_tokens:
            acc.cache_creation_input_tokens + s.cumulative_cache_creation_input_tokens,
          cache_read_input_tokens:
            acc.cache_read_input_tokens + s.cumulative_cache_read_input_tokens,
        }),
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
      );
      // One health probe per artifact: the aggregates below fold
      // log-content claims (evaluator verdicts, revision churn,
      // checkpoint intervals) — an unreadable artifact makes any
      // aggregate containing it unverifiable, so those degrade to null
      // with the artifacts disclosed. Row COUNTS stay: they are index
      // facts about rows, not claims about log content.
      const degradedArtifacts: string[] = [];
      let importedArtifacts = 0;
      for (const row of ctx.store.store.listArtifacts({})) {
        if (row.origin_kind === 'git-import') importedArtifacts += 1;
        const probe = await readForEnumeration(row.id, 'stats', () =>
          ctx.store.readArtifact(row.id)
        );
        if (probe.kind === 'unreadable') degradedArtifacts.push(row.id);
      }
      const aggregatesDegraded = degradedArtifacts.length > 0;
      const evaluators = {
        by_evaluator: aggregatesDegraded
          ? null
          : computeEvaluatorRates(ctx.store.store.evaluatorRunStats()),
      };
      const planRevisions = aggregatesDegraded
        ? null
        : computeRevisionChurn(ctx.store.store.planRevisionCounts());
      const durations = aggregatesDegraded
        ? null
        : computeDurationStats(ctx.store.store.closedCheckpointIntervals());
      const hygiene = {
        ...ctx.store.store.hygieneCounts(),
        // Unambiguous-only
        // hunk attribution of the current branch's latest artifact window
        // (base_sha → worktree). Fail-open: null when no artifact/base, no
        // manifests, or any git/matcher failure — stats never breaks on
        // attribution. The --all-projects envelope never computes it (that
        // path must not execute git).
        diff_attributed_pct: await computeDiffAttributedPct(ctx),
        notes: {
          diff_attributed_pct:
            "unambiguous hunk-level attribution of the current branch's latest artifact " +
            'window (base_sha → worktree); null when no artifact, no manifests, or degraded',
        },
      };
      const payload = {
        ...store,
        imported_artifacts: importedArtifacts,
        coding_sessions: { total: sessions.length, tokens },
        evaluators,
        plan_revisions: planRevisions,
        checkpoint_durations: durations,
        hygiene,
        degraded_artifacts: degradedArtifacts,
        ...(aggregatesDegraded
          ? {
              degraded_note:
                'evaluator rates, revision churn, and checkpoint durations are null: ' +
                `${degradedArtifacts.length} artifact(s) are unreadable, so aggregates ` +
                'containing them cannot be verified — run `orcaops doctor`',
            }
          : {}),
      };

      if (opts.json) {
        emitOk(payload);
        return;
      }
      const lines = [
        'Store stats',
        `  artifacts:   ${payload.artifacts.total} ${renderByStatus(payload.artifacts.by_status)}`,
        ...(importedArtifacts > 0
          ? [`  imported:    ${importedArtifacts} (excluded from duration aggregates)`]
          : []),
        `  checkpoints: ${payload.checkpoints.total} ${renderByStatus(payload.checkpoints.by_status)}`,
        `  summaries:   ${payload.summaries.total}`,
        `  coding sessions: ${payload.coding_sessions.total}` +
          (payload.coding_sessions.total > 0
            ? ` (in ${tokens.input_tokens} / out ${tokens.output_tokens} / cache-write ` +
              `${tokens.cache_creation_input_tokens} / cache-read ${tokens.cache_read_input_tokens} tokens)`
            : ''),
        ...renderSiblingSections(
          evaluators.by_evaluator,
          planRevisions,
          durations,
          hygiene,
          degradedArtifacts
        ),
        '',
      ];
      writeTerminalSafeStdout(lines.join('\n'));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function renderByStatus(byStatus: Record<string, number>): string {
  const parts = Object.entries(byStatus).map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? `(${parts.join(', ')})` : '';
}

function renderSiblingSections(
  rates: EvaluatorRateRow[] | null,
  churn: RevisionChurn | null,
  durations: DurationStats | null,
  hygiene: Record<string, unknown>,
  degradedArtifacts: readonly string[] = []
): string[] {
  const lines: string[] = [];
  if (degradedArtifacts.length > 0) {
    lines.push(
      `  ${degradedArtifacts.length} artifact(s) unreadable — evaluator rates, revision ` +
        `churn, and durations withheld (run \`orcaops doctor\`): ${degradedArtifacts.join(', ')}`
    );
  }
  if (rates !== null && rates.length > 0) {
    lines.push('  evaluator pass rates (pass / graded):');
    for (const r of rates) {
      const rate = r.pass_rate === null ? 'n/a' : `${Math.round(r.pass_rate * 100)}%`;
      lines.push(
        `    ${r.evaluator_ref} [${r.phase}]: ${rate} (${r.pass}/${r.pass + r.violation} graded, ${r.total} runs)`
      );
    }
  }
  if (churn !== null && churn.artifacts_with_plan > 0) {
    lines.push(
      `  plan revisions: ${churn.revised_artifacts}/${churn.artifacts_with_plan} artifacts revised` +
        ` (max ${churn.max_revisions})`
    );
  }
  if (durations !== null && durations.closed_total > 0) {
    const fmt = (ms: number | null): string => (ms === null ? 'n/a' : `${Math.round(ms / 1000)}s`);
    lines.push(
      `  checkpoint durations: median ${fmt(durations.median_ms)} · p90 ${fmt(durations.p90_ms)} · ` +
        `max ${fmt(durations.max_ms)} (${durations.closed_total} closed)`
    );
  }
  const hygieneEntries = Object.entries(hygiene).filter(
    ([k, v]) => typeof v === 'number' && v > 0 && k !== 'diff_attributed_pct'
  );
  if (hygieneEntries.length > 0) {
    lines.push('  hygiene flags:');
    for (const [k, v] of hygieneEntries) lines.push(`    ${k}: ${v as number}`);
  }
  return lines;
}
