import type { SessionModelBreakdownRow } from '@orcaops/storage';

/**
 * Shared parsing of a session's HIGH-WATER rich usage — the open `dimensions`
 * map and the per-(model, rate-class) split — out of the raw
 * {@link SessionModelBreakdownRow} JSON. Used by both the digest (core) and the
 * CLI read surfaces (`show` / `status`) so they agree exactly and never drift.
 *
 * Read-only and tokens-only: this surfaces what was captured, never prices.
 */

/** The four Claude-native scalar token totals. */
export interface UsageScalars {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** One per-(model, rate-class) slice of a session's high-water usage. */
export interface ModelRateClassUsage extends UsageScalars {
  model: string;
  /** Non-default price-determining rate classes (omitted when default). */
  speed?: string;
  service_tier?: string;
  inference_geo?: string;
  /** Per-model open dimensions (omitted when empty). */
  dimensions?: Record<string, number>;
}

/** A session's high-water rich usage: total dimensions + the rate-class split. */
export interface SessionUsageDetail {
  dimensions?: Record<string, number>;
  model_breakdown: ModelRateClassUsage[];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Parse a stored open-dimensions object into a sparse map, or undefined when empty. */
function parseDims(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseDimsJson(json: string): Record<string, number> | undefined {
  try {
    return parseDims(JSON.parse(json));
  } catch {
    return undefined;
  }
}

function parseBreakdown(json: string): ModelRateClassUsage[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ModelRateClassUsage[] = [];
  for (const e of raw as Array<Record<string, unknown>>) {
    if (typeof e?.model !== 'string') continue;
    const cum = (
      typeof e.cumulative === 'object' && e.cumulative !== null ? e.cumulative : {}
    ) as Record<string, unknown>;
    const entry: ModelRateClassUsage = {
      model: e.model,
      input_tokens: num(cum.input_tokens),
      output_tokens: num(cum.output_tokens),
      cache_creation_input_tokens: num(cum.cache_creation_input_tokens),
      cache_read_input_tokens: num(cum.cache_read_input_tokens),
    };
    if (typeof e.speed === 'string') entry.speed = e.speed;
    if (typeof e.service_tier === 'string') entry.service_tier = e.service_tier;
    if (typeof e.inference_geo === 'string') entry.inference_geo = e.inference_geo;
    const dims = parseDims(cum.dimensions);
    if (dims) entry.dimensions = dims;
    out.push(entry);
  }
  return out;
}

/** The (agent, session_id) join key — JSON, never a control-char delimiter. */
export function sessionDetailKey(agent: string, sessionId: string): string {
  return JSON.stringify([agent, sessionId]);
}

/** Parse high-water rows into per-(agent, session_id) usage detail. */
export function sessionUsageDetailByKey(
  rows: SessionModelBreakdownRow[]
): Map<string, SessionUsageDetail> {
  const map = new Map<string, SessionUsageDetail>();
  for (const row of rows) {
    map.set(sessionDetailKey(row.agent, row.session_id), {
      dimensions: parseDimsJson(row.dimensions),
      model_breakdown: parseBreakdown(row.model_breakdown),
    });
  }
  return map;
}

/**
 * True when the detail adds something BEYOND the scalar session total — an open
 * dimension or a non-default rate class. Surfaces/fingerprints are gated on this
 * so an all-standard session with no dimensions renders as a plain scalar
 * session.
 */
export function isRichUsageDetail(detail: SessionUsageDetail | undefined): boolean {
  return (
    detail !== undefined &&
    (detail.dimensions !== undefined ||
      detail.model_breakdown.some(
        (m) =>
          m.speed !== undefined || m.service_tier !== undefined || m.inference_geo !== undefined
      ))
  );
}

/**
 * A deterministic serialization of a session's rich usage for the digest
 * fingerprint — so a dimensions/rate-class-only change marks a cached digest
 * stale even when the scalar totals are unchanged. Empty when not rich, so a
 * plain session's fingerprint derives from the scalar totals alone.
 */
export function usageDetailFingerprint(detail: SessionUsageDetail | undefined): string {
  return isRichUsageDetail(detail) ? JSON.stringify(detail) : '';
}

/** A compact one-line summary of a session's rich usage, or '' when none. */
export function formatUsageDetail(detail: SessionUsageDetail | undefined): string {
  if (!detail) return '';
  const parts: string[] = [];
  const classes = detail.model_breakdown
    .filter(
      (m) => m.speed !== undefined || m.service_tier !== undefined || m.inference_geo !== undefined
    )
    .map((m) => {
      const tags = [m.speed, m.service_tier, m.inference_geo].filter(Boolean).join('/');
      return `${m.model} [${tags}]`;
    });
  if (classes.length > 0) parts.push(`rate classes: ${classes.join(', ')}`);
  if (detail.dimensions) {
    const dims = Object.entries(detail.dimensions)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    parts.push(`dimensions: ${dims}`);
  }
  return parts.join(' · ');
}
