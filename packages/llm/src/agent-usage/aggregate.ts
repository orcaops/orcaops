/**
 * Shared usage-aggregation internals for {@link AgentUsageSource}
 * implementations (Claude Code transcripts, Codex rollouts, ...).
 *
 * Every source resolves its de-duplicated per-record usage through
 * {@link buildUsageSnapshot} into the same snapshot shape — a summed `total`,
 * a per-(model, rate-class) breakdown, and an `asOf` cutoff marker — so the
 * ledger, display, and cloud wire see identical aggregation semantics
 * regardless of which agent produced the tokens. Tokens only — never any
 * pricing.
 */

import type { AgentTokenUsage, AgentUsageModelBreakdown, AgentUsageSnapshot } from './source.js';

/**
 * Canonical `dimensions` key for reasoning output tokens (Codex; also the
 * natural home for OpenCode/Copilot reasoning counters). A REFINEMENT of
 * `output_tokens` — reasoning is billed inside output — mirroring how the
 * Claude parser's 1h/5m keys refine `cache_creation_input_tokens`.
 */
export const DIM_REASONING_OUTPUT = 'reasoning_output_tokens';

export function emptyUsage(): AgentTokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/** Sum `u` into `acc`, merging the sparse `dimensions` maps additively. */
export function addInto(acc: AgentTokenUsage, u: AgentTokenUsage): void {
  acc.input_tokens += u.input_tokens;
  acc.output_tokens += u.output_tokens;
  acc.cache_creation_input_tokens += u.cache_creation_input_tokens;
  acc.cache_read_input_tokens += u.cache_read_input_tokens;
  if (u.dimensions) {
    const accDims = (acc.dimensions ??= {});
    for (const [k, v] of Object.entries(u.dimensions)) accDims[k] = (accDims[k] ?? 0) + v;
  }
}

/** True when `u` carries at least one non-zero open dimension. */
export function hasDimensions(u: AgentTokenUsage): boolean {
  return u.dimensions !== undefined && Object.values(u.dimensions).some((v) => v > 0);
}

/** Read a non-negative integer-ish token field, defaulting absent/garbage to 0. */
export function tokenField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Total tokens across all four fields — the canonical-record tiebreak weight. */
export function recordTokenTotal(u: AgentTokenUsage): number {
  return (
    u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
  );
}

/**
 * A usage record ready for aggregation: resolved (already de-duplicated)
 * tokens plus the price-determining partition fields. The rate classes are
 * canonicalized by the source (default/absent ⇒ omitted), so aggregation
 * never re-normalizes.
 */
export interface AggregatableUsageRecord {
  usage: AgentTokenUsage;
  model: string;
  /** ISO-8601 record timestamp — drives the `asOf` fallback when no `until` is given. */
  ts: string;
  speed?: string;
  service_tier?: string;
  inference_geo?: string;
}

/** The rate-class partition key for the per-model breakdown — byte-stable JSON. */
export function rateClassKey(
  r: Pick<AggregatableUsageRecord, 'model' | 'speed' | 'service_tier' | 'inference_geo'>
): string {
  return JSON.stringify([r.model, r.speed ?? '', r.service_tier ?? '', r.inference_geo ?? '']);
}

/**
 * Aggregate de-duplicated records into an {@link AgentUsageSnapshot},
 * partitioned by RATE CLASS (model + the non-default price-determining
 * categoricals). Sum / max are order-independent, so total, breakdown, asOf,
 * and recordCount are deterministic regardless of scan order.
 *
 * Rows with NO usage — all four scalars AND all dimensions zero/empty — are
 * dropped from the breakdown (a row carrying a non-zero billable dimension
 * with zero scalar tokens survives), sorted by the canonical rate-class key
 * in BYTE order. `asOf` is the requested cutoff when given (stable), else the
 * latest record timestamp actually counted. Returns `null` for an empty
 * record set ("no usage found").
 */
export function buildUsageSnapshot(
  records: readonly AggregatableUsageRecord[],
  until?: string
): AgentUsageSnapshot | null {
  if (records.length === 0) return null;

  const byRateClass = new Map<string, AgentUsageModelBreakdown>();
  const total = emptyUsage();
  let latestTs: string | undefined;
  for (const rec of records) {
    addInto(total, rec.usage);
    const key = rateClassKey(rec);
    let group = byRateClass.get(key);
    if (!group) {
      group = {
        model: rec.model,
        ...(rec.speed !== undefined ? { speed: rec.speed } : {}),
        ...(rec.service_tier !== undefined ? { service_tier: rec.service_tier } : {}),
        ...(rec.inference_geo !== undefined ? { inference_geo: rec.inference_geo } : {}),
        usage: emptyUsage(),
      };
      byRateClass.set(key, group);
    }
    addInto(group.usage, rec.usage);
    if (latestTs === undefined || rec.ts > latestTs) latestTs = rec.ts;
  }

  const modelBreakdown: AgentUsageModelBreakdown[] = [...byRateClass.entries()]
    .filter(([, g]) => recordTokenTotal(g.usage) > 0 || hasDimensions(g.usage))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, g]) => g);

  return {
    total,
    modelBreakdown,
    asOf: until ?? latestTs ?? '',
    recordCount: records.length,
  };
}
