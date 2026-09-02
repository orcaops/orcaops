// Fitting the Brief's rows to a pane half as wide as the screen.
//
// At the 110-column split threshold each pane is about 54 cells, roughly half
// the full-width measure. A row that overflows does not just look wrong:
// an unplanned wrap changes the row's HEIGHT, which invalidates the attention
// budget below it and can push the warnings band out of the initial viewport.
// So both panes fit through here, and the helper that budgets attention rows is
// the same one that produces their rendered lines — a count and a separate
// render are two things that can disagree.
//
// Measurement is `displayLen`/`truncate` (code points), never `String.length`.

import type { BriefAttentionRow, BriefAttentionTone } from './briefAttention';
import { displayLen, truncate } from '../layout';

/** The cursor gutter every Brief row reserves, selected or not. */
const MARKER_WIDTH = 2;
/**
 * Cells held back on every fitted row.
 *
 * `displayLen` counts code points, and the separators these rows are built from
 * (`·`, `−`) are East-Asian-ambiguous: a terminal may paint them two cells wide.
 * A row measured as exactly full therefore wraps — and a wrap is not cosmetic
 * here, it changes the row's height and spends a line the band below it was
 * budgeted.
 */
const WRAP_MARGIN = 2;
/** Below this a label is not worth showing, so an optional field is dropped instead. */
const MIN_LABEL_WIDTH = 10;

export interface BriefLeafRowParts {
  marker: string;
  glyph: string;
  label: string;
  /** Blocker badges — secondary: dropped only after churn. */
  badges: string | null;
  /** `+42 −8 · 2f` — optional: the first thing to go. */
  churn: string | null;
}

export interface BriefLeafRowInput {
  width: number;
  selected: boolean;
  /** Cells of leading indentation beneath a group heading. */
  indent: number;
  glyph: string;
  label: string;
  badges?: string | null;
  churn?: string | null;
}

/**
 * Fit one tree leaf by priority.
 *
 * Required: cursor marker, state glyph and label (truncated last, never
 * dropped). Secondary: blocker badges. Optional: churn, dropped first — it is
 * the only field a reviewer can get elsewhere in one keystroke.
 */
export function fitBriefLeafRow(input: BriefLeafRowInput): BriefLeafRowParts {
  const marker = input.selected ? '❯ ' : '  ';
  const indent = ' '.repeat(Math.max(0, input.indent));
  const fixed = MARKER_WIDTH + WRAP_MARGIN + displayLen(indent) + displayLen(input.glyph) + 1;
  let remaining = Math.max(0, Math.floor(input.width) - fixed);

  const badges = input.badges === undefined || input.badges === '' ? null : input.badges;
  const churn = input.churn === undefined || input.churn === '' ? null : input.churn;
  const labelWidth = displayLen(input.label);

  let keptChurn: string | null = null;
  let keptBadges: string | null = null;
  if (badges !== null && remaining - (displayLen(badges) + 1) >= MIN_LABEL_WIDTH) {
    keptBadges = badges;
    remaining -= displayLen(badges) + 1;
  }
  if (churn !== null && remaining - (displayLen(churn) + 1) >= MIN_LABEL_WIDTH) {
    keptChurn = churn;
    remaining -= displayLen(churn) + 1;
  }

  return {
    marker: `${marker}${indent}`,
    glyph: input.glyph,
    label: labelWidth <= remaining ? input.label : truncate(input.label, remaining),
    badges: keptBadges,
    churn: keptChurn,
  };
}

/**
 * A `Label · value` orientation row, fitted to exactly one line.
 *
 * The label keeps its own separator rather than being padded into a column:
 * these labels are phrases of different lengths ("What", "Open uncertainties"),
 * and a fixed column either truncates the long ones or wastes half the pane on
 * the short ones.
 */
export function fitBriefMetaRow(input: { width: number; label: string; value: string }): {
  label: string;
  value: string;
} {
  const label = truncate(input.label, Math.max(4, Math.floor(input.width) - 6));
  const available = Math.max(0, Math.floor(input.width) - displayLen(label) - 3 - WRAP_MARGIN);
  return { label: `${label} · `, value: truncate(input.value, available) };
}

/** Wrapped prose rows never exceed this height; the tail line is ellipsized. */
export const BRIEF_PROSE_LINE_CAP = 6;

/**
 * Word-wrap into a first-line budget and a continuation budget. A token wider
 * than a whole line hard-breaks at the budget rather than overflowing.
 *
 * The break slices CODE POINTS, because `budget` is a `displayLen` measure and
 * `displayLen` counts code points. Slicing code units instead splits an astral
 * character down the middle — the emitted line ends on a lone high surrogate and
 * the remainder begins on its orphaned low half, so both render as `�`. That is
 * corruption, not an under-fill.
 *
 * LINEAR in the input. Rescanning the whole remaining token on every chunk — for
 * the length check or for the break — costs O(n²) on a long unbroken token, and
 * the Story banner it wraps is an unbounded string. Each word is converted
 * to code points once and consumed by offset, the in-progress line length is
 * carried rather than remeasured, and emission stops one line past the cap.
 *
 * Exported for that bound: the caller only ever sees the capped slice, so the
 * stop is invisible from `fitBriefProseRow` and can only be pinned here.
 */
export function wrapProse(text: string, firstWidth: number, contWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  // Tracked, not remeasured: `displayLen(line)` per pass would be quadratic.
  let lineLen = 0;
  let budget = Math.max(1, Math.floor(firstWidth));
  const flush = (): void => {
    lines.push(line);
    line = '';
    lineLen = 0;
    budget = Math.max(1, Math.floor(contWidth));
  };
  // One line past the cap is all `fitBriefProseRow` needs to know it must
  // ellipsize, and stopping there is what bounds the work: a 40k-code-point
  // token would otherwise build ~900 lines so the caller could keep six.
  const enough = (): boolean => lines.length > BRIEF_PROSE_LINE_CAP;
  for (const word of text.split(/\s+/).filter((token) => token.length > 0)) {
    if (enough()) return lines;
    // ONE spread per word. The hard-break below walks an offset into it rather
    // than rebuilding the remainder.
    const chars = [...word];
    let at = 0;
    while (at < chars.length) {
      const remaining = chars.length - at;
      const separator = lineLen === 0 ? 0 : 1;
      if (lineLen + separator + remaining <= budget) {
        const token = at === 0 ? word : chars.slice(at).join('');
        line = lineLen === 0 ? token : `${line} ${token}`;
        lineLen += separator + remaining;
        break;
      }
      if (lineLen !== 0) {
        flush();
        // Checked HERE too, not only after the hard break below: a flush that
        // reaches the cap followed by a hard break in the same word would emit
        // one line past the bound this function advertises.
        if (enough()) return lines;
        continue;
      }
      lines.push(chars.slice(at, at + budget).join(''));
      at += budget;
      budget = Math.max(1, Math.floor(contWidth));
      if (enough()) return lines;
    }
  }
  if (line !== '') lines.push(line);
  return lines.length === 0 ? [''] : lines;
}

/**
 * A `Label · value` orientation row whose value WRAPS instead of truncating.
 *
 * For the rows that carry real prose — the Story banner and the overview's
 * What — a single-line clamp would eat whole paragraphs at the 54-cell pane.
 * Continuation lines indent to the value column. The height is bounded by
 * `BRIEF_PROSE_LINE_CAP` so a pathological paragraph cannot push the truth
 * bands out of the initial viewport; the cap line ends in an ellipsis.
 *
 * Callers MUST budget `lines.length` physical rows, not one.
 */
export function fitBriefProseRow(input: { width: number; label: string; value: string }): {
  label: string;
  lines: readonly string[];
  indent: number;
} {
  const width = Math.max(1, Math.floor(input.width));
  const label = truncate(input.label, Math.max(4, width - 6));
  const prefix = `${label} · `;
  const indent = Math.min(displayLen(prefix), Math.max(0, width - 8));
  const first = Math.max(1, width - displayLen(prefix) - WRAP_MARGIN);
  const cont = Math.max(1, width - indent - WRAP_MARGIN);
  let lines = wrapProse(input.value, first, cont);
  if (lines.length > BRIEF_PROSE_LINE_CAP) {
    lines = lines.slice(0, BRIEF_PROSE_LINE_CAP);
    lines[BRIEF_PROSE_LINE_CAP - 1] = truncate(
      `${lines[BRIEF_PROSE_LINE_CAP - 1]!} …`,
      Math.max(1, cont)
    );
  }
  return { label: prefix, lines, indent };
}

/**
 * A top-anchored scroll window that always contains `cursorRow`.
 *
 * Top-anchored rather than centred so the list does not jump under the reviewer
 * while they are still reading from the beginning of it; it scrolls only as far
 * as the cursor actually forces.
 */
export function windowBriefRows<T>(
  rows: readonly T[],
  cursorRow: number,
  maxRows: number
): { rows: readonly T[]; start: number; hiddenBefore: number; hiddenAfter: number } {
  const budget = Math.max(0, Math.floor(maxRows));
  if (rows.length === 0 || budget === 0) {
    return { rows: [], start: 0, hiddenBefore: 0, hiddenAfter: rows.length };
  }
  const cursor = Math.max(0, Math.min(cursorRow, rows.length - 1));
  const start = Math.max(0, Math.min(cursor - budget + 1, rows.length - budget, cursor));
  const end = Math.min(rows.length, start + budget);
  return {
    rows: rows.slice(start, end),
    start,
    hiddenBefore: start,
    hiddenAfter: Math.max(0, rows.length - end),
  };
}

export interface BriefAttentionLine {
  key: string;
  index: number;
  selected: boolean;
  glyph: string;
  /** Parallel to `glyph`; the renderer hues the glyph by this. */
  tone: BriefAttentionTone;
  label: string;
  /** Present only when the row's detail line also fits inside the budget. */
  detail: string | null;
}

export interface BriefAttentionWindow {
  lines: readonly BriefAttentionLine[];
  /** Rows scrolled off the top and bottom, for the `… n more` affordances. */
  hiddenBefore: number;
  hiddenAfter: number;
}

/**
 * The attention rows that FIT, already fitted.
 *
 * The window always contains the cursor, so an unrendered row cannot be selected
 * at any pane height. A fixed render cap the cursor does not share lets the
 * highlight walk off the bottom of the rendered list and `↵` activate a row
 * nobody can see.
 */
export function fitBriefAttentionWindow(input: {
  rows: readonly BriefAttentionRow[];
  cursor: number;
  width: number;
  maxLines: number;
}): BriefAttentionWindow {
  const budget = Math.max(0, Math.floor(input.maxLines));
  if (input.rows.length === 0 || budget === 0) {
    return { lines: [], hiddenBefore: 0, hiddenAfter: input.rows.length };
  }
  const cursor = Math.max(0, Math.min(input.cursor, input.rows.length - 1));
  const labelWidth = Math.max(1, Math.floor(input.width) - MARKER_WIDTH - 2 - WRAP_MARGIN);
  const detailWidth = Math.max(1, Math.floor(input.width) - MARKER_WIDTH - 4 - WRAP_MARGIN);

  // A row costs two lines when it has a detail, so the window is priced in
  // LINES, not rows — otherwise a queue of detailed rows silently overflows.
  const cost = (index: number): number => (input.rows[index]!.detail === undefined ? 1 : 2);

  // Anchor at the top and scroll only as far as the cursor forces, which is how
  // the list reads while the reviewer is still near the beginning of it.
  let start = 0;
  let spent = 0;
  for (let index = start; index <= cursor; index += 1) spent += cost(index);
  while (spent > budget && start < cursor) {
    spent -= cost(start);
    start += 1;
  }
  let end = cursor;
  while (end + 1 < input.rows.length && spent + cost(end + 1) <= budget) {
    spent += cost(end + 1);
    end += 1;
  }
  // A single detailed row wider than the whole budget still shows its label.
  const dropDetails = spent > budget;

  const lines: BriefAttentionLine[] = [];
  for (let index = start; index <= end; index += 1) {
    const row = input.rows[index]!;
    lines.push({
      key: row.key,
      index,
      selected: index === cursor,
      glyph: row.glyph,
      tone: row.tone,
      label: truncate(row.label, labelWidth),
      detail: row.detail === undefined || dropDetails ? null : truncate(row.detail, detailWidth),
    });
  }
  return {
    lines,
    hiddenBefore: start,
    hiddenAfter: Math.max(0, input.rows.length - 1 - end),
  };
}

export interface BriefStepDots {
  /** `●` per completed step. */
  done: string;
  /** `○` per step still outstanding. */
  remaining: string;
  /** ` +N` when the run is longer than the dots that fit, else empty. */
  overflow: string;
}

/**
 * A run of step dots, the way the Watch's vitals strip draws its plan.
 *
 * A count tells you how much is left; the dots tell you the SHAPE of what is
 * left at a glance, which is the thing the stat tile above cannot carry. The
 * run is capped so a long plan degrades to `+N` rather than pushing the row
 * over its width.
 */
export function briefStepDots(done: number, total: number, max: number): BriefStepDots {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeDone = Math.max(0, Math.min(Math.floor(done), safeTotal));
  const shown = Math.max(0, Math.min(safeTotal, Math.floor(max)));
  const doneShown = Math.min(safeDone, shown);
  return {
    done: '●'.repeat(doneShown),
    remaining: '○'.repeat(shown - doneShown),
    overflow: safeTotal > shown ? ` +${safeTotal - shown}` : '',
  };
}

/** Cells of breathing room around each stat tile — two either side. */
const STAT_TILE_GAP = 4;
/** A floor under every tile, so a short value cannot crowd its neighbour. */
const STAT_TILE_MIN = 10;
/** The one-column rule drawn between adjacent tiles. */
const STAT_TILE_DIVIDER = 1;

export interface BriefStatTileFit {
  label: string;
  /** The value as plain text, for width measurement only. */
  valueText: string;
}

/**
 * Total cells one stat tile occupies, its gap included.
 *
 * The floor is what gives the band a regular rhythm. Without it a five-cell
 * PLAN sits flush against its neighbour while a fourteen-cell SCOPE sprawls,
 * and the row reads as ragged rather than as columns. One source for both the
 * fitting maths and the rendered box, so the two cannot disagree.
 */
export function briefStatTileCells(tile: BriefStatTileFit): number {
  return (
    Math.max(STAT_TILE_MIN, displayLen(tile.label), displayLen(tile.valueText)) + STAT_TILE_GAP
  );
}

/**
 * The stat tiles that FIT, highest priority first.
 *
 * Tiles arrive pre-sorted by importance; fitting stops at the first that would
 * overflow, so the band sheds its least-important tiles rather than wrapping —
 * the same required-before-optional discipline the leaf rows use. At least one
 * tile always shows, even on a terminal too narrow for it. Every tile after the
 * first also pays for the rule drawn before it.
 */
export function fitBriefStatBand<T extends BriefStatTileFit>(
  tiles: readonly T[],
  width: number
): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const tile of tiles) {
    const cells = briefStatTileCells(tile) + (kept.length > 0 ? STAT_TILE_DIVIDER : 0);
    if (used + cells > width && kept.length > 0) break;
    kept.push(tile);
    used += cells;
  }
  return kept;
}
