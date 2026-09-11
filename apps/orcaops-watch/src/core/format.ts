/** Shared pure formatters used by the TUI renderers. */

import type { SessionTokens } from '@orcaops/watch-data/ui';

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface SessionTokenSummary {
  status: 'exact' | 'incomplete' | 'unavailable';
  tokens: number | null;
  sessions: number;
}

/** Deduplicate session evidence without turning an incomplete observation into an exact total. */
export function summarizeSessionTokens(input: readonly SessionTokens[]): SessionTokenSummary {
  const sessions = new Map<string, SessionTokens>();
  for (const session of input) {
    const key = JSON.stringify([session.agent, session.session_id]);
    const current = sessions.get(key);
    if (
      current === undefined ||
      (current.status === 'incomplete' && session.status === 'exact') ||
      (current.status === session.status && session.tokens > current.tokens)
    )
      sessions.set(key, session);
  }
  if (sessions.size === 0) return { status: 'unavailable', tokens: null, sessions: 0 };
  return {
    status: [...sessions.values()].every((session) => session.status === 'exact')
      ? 'exact'
      : 'incomplete',
    tokens: [...sessions.values()].reduce((total, session) => total + session.tokens, 0),
    sessions: sessions.size,
  };
}

/** Compact numeric value; an incomplete zero is undisclosed rather than presented as a total. */
export function fmtSessionTokenValue(summary: SessionTokenSummary): string {
  if (summary.tokens === null || (summary.status === 'incomplete' && summary.tokens === 0))
    return '—';
  return `${summary.status === 'incomplete' ? '≥' : ''}${fmtTokens(summary.tokens)}`;
}

export function ago(ms: number | null, nowMs: number): string {
  if (ms === null) return '—';
  const secs = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function truncate(s: string, len: number): string {
  return s.length <= len ? s : `${s.slice(0, len - 1)}…`;
}
