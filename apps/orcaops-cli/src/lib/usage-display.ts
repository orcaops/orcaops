import {
  formatUsageDetail,
  isRichUsageDetail,
  sessionDetailKey,
  type SessionUsageDetail,
  sessionUsageDetailByKey,
} from '@orcaops/core';
import type { AttributedUsageRow, CodingSessionRow, Store } from '@orcaops/storage';

/**
 * Shared rendering for coding-agent usage across the read surfaces.
 *
 * The invariant: the **exact `(agent, session_id)` session
 * total** is the accounting base / headline; **per-artifact attribution is an
 * explicitly-labelled estimate** (never exact, never "this artifact cost N",
 * never additive across artifacts). USD is the cloud's job — surfaced as
 * "priced by the cloud", never a stored local number.
 */

/**
 * The estimate-semantics disclosure, single-sourced so every read surface
 * (`show`/`digest` via {@link artifactUsageJson}, `orcaops usage`) quotes
 * byte-identical wording.
 */
export const ATTRIBUTION_ESTIMATE_NOTE =
  'session totals are exact per (agent, session_id); per-artifact attribution is an order-independent ESTIMATE, never additive across artifacts — the cloud must roll up from the session total, never by summing per-artifact estimates';

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

function fmtTokens(u: TokenTotals): string {
  return (
    `in ${u.input_tokens} · out ${u.output_tokens} · ` +
    `cache-write ${u.cache_creation_input_tokens} · cache-read ${u.cache_read_input_tokens}`
  );
}

function sessionTokens(s: CodingSessionRow): TokenTotals {
  return {
    input_tokens: s.cumulative_input_tokens,
    output_tokens: s.cumulative_output_tokens,
    cache_creation_input_tokens: s.cumulative_cache_creation_input_tokens,
    cache_read_input_tokens: s.cumulative_cache_read_input_tokens,
  };
}

export interface ArtifactUsageView {
  /** Exact totals for the sessions that touched this artifact (the headline). */
  sessions: CodingSessionRow[];
  /** Estimated slice attributed to this artifact. */
  attributed: AttributedUsageRow;
  hasUsage: boolean;
  /** Per-(agent, session_id) high-water dimensions + rate-class split (exact;
   *  the attributed estimate below stays scalar-only). Optional so a caller can
   *  build a scalar-only view; the renderers degrade gracefully when absent. */
  detailByKey?: Map<string, SessionUsageDetail>;
}

export function buildArtifactUsageView(store: Store, artifactId: string): ArtifactUsageView {
  const sessions = store.artifactCodingSessions(artifactId);
  return {
    sessions,
    attributed: store.attributedArtifactUsage(artifactId),
    hasUsage: sessions.length > 0,
    detailByKey: sessionUsageDetailByKey(store.artifactSessionModelBreakdowns(artifactId)),
  };
}

/** Human usage block for an artifact (`show`). Empty when no usage recorded. */
export function renderArtifactUsageLines(view: ArtifactUsageView): string[] {
  if (!view.hasUsage) return [];
  const lines = ['Agent usage — exact session total is the accounting base:'];
  for (const s of view.sessions) {
    lines.push(
      `  ${s.agent}/${s.session_id.slice(0, 8)} session total (exact): ${fmtTokens(sessionTokens(s))}`
    );
    const detail = formatUsageDetail(
      view.detailByKey?.get(sessionDetailKey(s.agent, s.session_id))
    );
    if (detail) lines.push(`    ${detail}`);
  }
  lines.push(
    `  attributed to this artifact (ESTIMATED — shared across linked plans, not additive): ${fmtTokens(view.attributed)}`
  );
  lines.push('  USD: priced by the cloud (no local pricing)');
  return lines;
}

/** JSON usage block for an artifact (`show`, `digest`). */
export function artifactUsageJson(view: ArtifactUsageView): Record<string, unknown> {
  return {
    session_totals_exact: view.sessions.map((s) => {
      const detail = view.detailByKey?.get(sessionDetailKey(s.agent, s.session_id));
      return {
        agent: s.agent,
        session_id: s.session_id,
        tokens: sessionTokens(s),
        record_count: s.record_count,
        ...(isRichUsageDetail(detail) ? { detail } : {}),
      };
    }),
    attributed_estimate: { ...view.attributed },
    usd: 'priced_by_cloud',
    note: ATTRIBUTION_ESTIMATE_NOTE,
  };
}

/** Human block for branch-level sessions (`status`). */
export function renderCodingSessionsLines(
  sessions: CodingSessionRow[],
  detailByKey?: Map<string, SessionUsageDetail>
): string[] {
  if (sessions.length === 0) return [];
  const lines = ['Coding sessions (exact token totals — the accounting base):'];
  for (const s of sessions) {
    lines.push(`  ${s.agent}/${s.session_id.slice(0, 8)}: ${fmtTokens(sessionTokens(s))}`);
    const detail = formatUsageDetail(detailByKey?.get(sessionDetailKey(s.agent, s.session_id)));
    if (detail) lines.push(`    ${detail}`);
  }
  lines.push('  USD: priced by the cloud (no local pricing)');
  return lines;
}

/** JSON block for branch-level sessions (`status`). */
export function codingSessionsJson(
  sessions: CodingSessionRow[],
  detailByKey?: Map<string, SessionUsageDetail>
): Array<Record<string, unknown>> {
  return sessions.map((s) => {
    const detail = detailByKey?.get(sessionDetailKey(s.agent, s.session_id));
    return {
      agent: s.agent,
      session_id: s.session_id,
      tokens: sessionTokens(s),
      record_count: s.record_count,
      as_of: s.as_of,
      ...(isRichUsageDetail(detail) ? { detail } : {}),
    };
  });
}
