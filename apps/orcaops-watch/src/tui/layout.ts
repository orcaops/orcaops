/**
 * Pure layout maths for the watch TUI: responsive column widths from
 * the terminal's column count, unicode-safe fit/pad, block progress bars, and
 * dim-track/bright-last sparkline cells.
 *
 * Kept pure so layout tests can assert column alignment and bar rendering
 * without mounting components.
 */

/** Code-point count — the display width for our content (ASCII + width-1 glyphs). */
export function displayLen(s: string): number {
  return [...s].length;
}

/** Truncate to `w` code points, marking elision with a single-cell ellipsis. */
export function truncate(s: string, w: number): string {
  if (w <= 0) return '';
  const chars = [...s];
  if (chars.length <= w) return s;
  if (w === 1) return '…';
  return `${chars.slice(0, w - 1).join('')}…`;
}

export function padEnd(s: string, w: number): string {
  const pad = w - displayLen(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

export function padStart(s: string, w: number): string {
  const pad = w - displayLen(s);
  return pad > 0 ? ' '.repeat(pad) + s : s;
}

/** Truncate to `w`, then pad to exactly `w` (left- or right-aligned). */
export function cell(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  const t = truncate(s, w);
  return align === 'right' ? padStart(t, w) : padEnd(t, w);
}

export interface ProgressBar {
  done: string;
  todo: string;
  label: string;
}

/**
 * A block progress bar sized to `width`: `▓` filled / `░` remaining, with a
 * trailing `completed/total` label. `done.length + todo.length` always equals
 * the bar width so the whole thing occupies exactly `width` cells.
 */
export function progressBar(completed: number, total: number, width: number): ProgressBar {
  const label = total > 0 ? `${completed}/${total}` : '—';
  if (total <= 0 || width <= 0) return { done: '', todo: '', label };
  const barWidth = Math.max(0, width - displayLen(label) - 1);
  const ratio = Math.min(1, Math.max(0, completed / total));
  const filled = Math.round(ratio * barWidth);
  return { done: '▓'.repeat(filled), todo: '░'.repeat(barWidth - filled), label };
}

const SPARK_LEVELS = '▁▂▃▄▅▆▇█';

export type SparkState = 'off' | 'on' | 'glow';

export interface SparkCell {
  char: string;
  state: SparkState;
}

/**
 * Peak-normalised sparkline cells, right-aligned to `width` (trailing buckets,
 * left-padded with zeros). Empty buckets render a faint `▁` baseline — never a
 * blank — so the activity track is always visible; the most recent non-empty
 * bucket is flagged `glow` for the bright endpoint the component lights up.
 */
export function sparkCells(buckets: readonly number[], width: number): SparkCell[] {
  if (width <= 0) return [];
  const tail = buckets.slice(-width);
  const padded =
    tail.length < width ? [...Array.from({ length: width - tail.length }, () => 0), ...tail] : tail;
  const peak = Math.max(1, ...padded);
  let lastActive = -1;
  for (let i = 0; i < padded.length; i += 1) if ((padded[i] ?? 0) > 0) lastActive = i;
  return padded.map((n, i) => {
    if (n <= 0) return { char: '▁', state: 'off' };
    const idx = Math.min(
      SPARK_LEVELS.length - 1,
      Math.round((n / peak) * (SPARK_LEVELS.length - 1))
    );
    return { char: SPARK_LEVELS.charAt(idx), state: i === lastActive ? 'glow' : 'on' };
  });
}
