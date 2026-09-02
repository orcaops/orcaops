/** Shared pure formatters used by the TUI renderers. */

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
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
