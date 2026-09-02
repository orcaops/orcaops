/**
 * Time formatting for the watch TUI.
 *
 * Event timestamps arrive as UTC (epoch ms in `tsMs`, or an ISO-8601 string in
 * `ts`). The UI always renders the viewer's local wall-clock, so every clock in
 * the app funnels through here rather than slicing the raw UTC ISO string.
 */

const p2 = (n: number): string => String(n).padStart(2, '0');

/** Local wall-clock `HH:MM:SS` from epoch ms (the source timestamp is UTC). */
export function fmtLocalTime(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
