import { sessionUsageDetailByKey } from '@orcaops/core';
import type { CodingSessionRow, UsageSnapshotRow } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { buildContext } from '../lib/context.js';
import {
  artifactUsageJson,
  ATTRIBUTION_ESTIMATE_NOTE,
  buildArtifactUsageView,
  codingSessionsJson,
  renderArtifactUsageLines,
  renderCodingSessionsLines,
  type TokenTotals,
} from '../lib/usage-display.js';

/**
 * `orcaops usage` — the read surface for the usage ledger.
 *
 * Repo scope: exact per-(agent, session_id) totals (the accounting base)
 * plus exact per-model aggregates. Artifact scope (`--artifact <id>`):
 * exact in-scope session totals, the labelled attribution ESTIMATE, exact
 * per-model split, and per-checkpoint high-water deltas. `--artifact` is
 * deliberately single-valued: per-artifact estimates must never be summed
 * (the store doc pins "never additive across artifacts").
 */
export interface UsageOptions {
  artifact?: string;
  json?: boolean;
}

/** Exact per-model aggregate summed from session high-water breakdowns. */
export interface ModelAggregate extends TokenTotals {
  model: string;
}

interface BreakdownEntryShape {
  model?: unknown;
  cumulative?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  };
}

/**
 * Sum per-model cumulative tokens across session high-water breakdowns.
 * Exact, not an estimate: per-model cumulative is monotonic per session, so
 * each session's high-water snapshot carries its true per-model split and
 * summing splits across sessions equals the per-model total. Malformed
 * JSON / entries are skipped, not fatal (decisions-collector precedent).
 * Exported for direct unit testing.
 */
export function aggregateModelTotals(
  rows: ReadonlyArray<{ model_breakdown: string }>
): ModelAggregate[] {
  const byModel = new Map<string, ModelAggregate>();
  for (const row of rows) {
    let entries: BreakdownEntryShape[];
    try {
      const parsed: unknown = JSON.parse(row.model_breakdown);
      if (!Array.isArray(parsed)) continue;
      entries = parsed as BreakdownEntryShape[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry?.model !== 'string' || typeof entry.cumulative !== 'object') continue;
      const c = entry.cumulative ?? {};
      const agg = byModel.get(entry.model) ?? {
        model: entry.model,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      agg.input_tokens += typeof c.input_tokens === 'number' ? c.input_tokens : 0;
      agg.output_tokens += typeof c.output_tokens === 'number' ? c.output_tokens : 0;
      agg.cache_creation_input_tokens +=
        typeof c.cache_creation_input_tokens === 'number' ? c.cache_creation_input_tokens : 0;
      agg.cache_read_input_tokens +=
        typeof c.cache_read_input_tokens === 'number' ? c.cache_read_input_tokens : 0;
      byModel.set(entry.model, agg);
    }
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}

/** One checkpoint's high-water usage span for one (agent, session). */
export interface CheckpointUsageDelta {
  checkpoint_n: number;
  agent: string;
  session_id: string;
  /** The last stamped lifecycle event inside the checkpoint window. */
  lifecycle_event: string;
  deltas: TokenTotals;
}

/**
 * Per-checkpoint usage spans from artifact-scoped snapshots. Every
 * `checkpoint_open`-baselined row's delta is CUMULATIVE-SINCE-OPEN
 * (ledger doc: per-row deltas are audit-only) — so per
 * (checkpoint_n, agent, session_id) the LAST row by (ts, snapshot_id)
 * IS the high-water span; summing rows double-counts every earlier
 * increment (the ledger tests pin SUM=250 where the true span is 150).
 * Input rows must be in `artifactScopedUsageSnapshots` order
 * (ts ASC, snapshot_id ASC). Exported for direct unit testing.
 */
export function collectCheckpointDeltas(
  snapshots: ReadonlyArray<UsageSnapshotRow>
): CheckpointUsageDelta[] {
  const latest = new Map<string, CheckpointUsageDelta>();
  for (const s of snapshots) {
    if (s.checkpoint_n === null || s.baseline_kind !== 'checkpoint_open') continue;
    if (
      s.delta_input_tokens === null ||
      s.delta_output_tokens === null ||
      s.delta_cache_creation_input_tokens === null ||
      s.delta_cache_read_input_tokens === null
    ) {
      continue;
    }
    // Later rows overwrite earlier ones — input order is ts ASC.
    latest.set(`${s.checkpoint_n}\u0000${s.agent}\u0000${s.session_id}`, {
      checkpoint_n: s.checkpoint_n,
      agent: s.agent,
      session_id: s.session_id,
      lifecycle_event: s.lifecycle_event,
      deltas: {
        input_tokens: s.delta_input_tokens,
        output_tokens: s.delta_output_tokens,
        cache_creation_input_tokens: s.delta_cache_creation_input_tokens,
        cache_read_input_tokens: s.delta_cache_read_input_tokens,
      },
    });
  }
  return [...latest.values()].sort(
    (a, b) =>
      a.checkpoint_n - b.checkpoint_n ||
      a.agent.localeCompare(b.agent) ||
      a.session_id.localeCompare(b.session_id)
  );
}

const CHECKPOINT_DELTAS_NOTE =
  'per-checkpoint deltas are cumulative-since-open high-water spans (ESTIMATE; the last stamped row per agent/session inside the checkpoint window) — never sum rows within a window';

function sumSessionTokens(sessions: ReadonlyArray<CodingSessionRow>): TokenTotals {
  const t: TokenTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  for (const s of sessions) {
    t.input_tokens += s.cumulative_input_tokens;
    t.output_tokens += s.cumulative_output_tokens;
    t.cache_creation_input_tokens += s.cumulative_cache_creation_input_tokens;
    t.cache_read_input_tokens += s.cumulative_cache_read_input_tokens;
  }
  return t;
}

export async function usageAction(opts: UsageOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      if (opts.artifact !== undefined) {
        const row = ctx.store.store.getArtifact(opts.artifact);
        if (!row) {
          throw new OrcaopsError(
            ErrorCodes.UNKNOWN_ARTIFACT,
            `No artifact with id "${opts.artifact}".`
          );
        }
        const view = buildArtifactUsageView(ctx.store.store, opts.artifact);
        const models = aggregateModelTotals(
          ctx.store.store.artifactSessionModelBreakdowns(opts.artifact)
        );
        const checkpoints = collectCheckpointDeltas(
          ctx.store.store.artifactScopedUsageSnapshots(opts.artifact)
        );
        if (opts.json) {
          emitOk({
            scope: 'artifact',
            artifact_id: opts.artifact,
            ...artifactUsageJson(view),
            models,
            checkpoints,
            checkpoints_note: CHECKPOINT_DELTAS_NOTE,
          });
          return;
        }
        writeTerminalSafeStdout(formatHumanArtifact(opts.artifact, view, models, checkpoints));
        return;
      }

      const sessions = ctx.store.store.listCodingSessions();
      const breakdowns = ctx.store.store.listSessionModelBreakdowns();
      const detailByKey = sessionUsageDetailByKey(breakdowns);
      const models = aggregateModelTotals(breakdowns);
      if (opts.json) {
        emitOk({
          scope: 'repo',
          sessions: {
            total: sessions.length,
            tokens: sumSessionTokens(sessions),
            per_session: codingSessionsJson(sessions, detailByKey),
          },
          models,
          usd: 'priced_by_cloud',
          note: ATTRIBUTION_ESTIMATE_NOTE,
        });
        return;
      }
      writeTerminalSafeStdout(formatHumanRepo(sessions, detailByKey, models));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function formatModelsLines(models: ModelAggregate[]): string[] {
  if (models.length === 0) return [];
  const lines = ['Per-model totals (exact):'];
  for (const m of models) {
    lines.push(
      `  ${m.model}: in ${m.input_tokens} · out ${m.output_tokens} · ` +
        `cache-write ${m.cache_creation_input_tokens} · cache-read ${m.cache_read_input_tokens}`
    );
  }
  return lines;
}

function formatHumanRepo(
  sessions: CodingSessionRow[],
  detailByKey: ReturnType<typeof sessionUsageDetailByKey>,
  models: ModelAggregate[]
): string {
  if (sessions.length === 0) return 'No coding-agent usage recorded.\n';
  const lines = [
    ...renderCodingSessionsLines(sessions, detailByKey),
    ...formatModelsLines(models),
    '',
  ];
  return lines.join('\n');
}

function formatHumanArtifact(
  artifactId: string,
  view: ReturnType<typeof buildArtifactUsageView>,
  models: ModelAggregate[],
  checkpoints: CheckpointUsageDelta[]
): string {
  if (!view.hasUsage) return `No coding-agent usage recorded for ${artifactId}.\n`;
  const lines = [...renderArtifactUsageLines(view), ...formatModelsLines(models)];
  if (checkpoints.length > 0) {
    lines.push('Per-checkpoint spans (estimate — last stamp per agent/session in the window):');
    for (const c of checkpoints) {
      lines.push(
        `  cp ${c.checkpoint_n} ${c.agent}/${c.session_id.slice(0, 8)} [${c.lifecycle_event}]: ` +
          `in ${c.deltas.input_tokens} · out ${c.deltas.output_tokens} · ` +
          `cache-write ${c.deltas.cache_creation_input_tokens} · cache-read ${c.deltas.cache_read_input_tokens}`
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
