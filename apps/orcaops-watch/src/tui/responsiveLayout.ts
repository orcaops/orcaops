import { displayLen } from './layout';

/** Readable terminal prose measure (~100–110 columns). */
export const MAX_PROSE_WIDTH = 106;

export function readableProseWidth(availableWidth: number, horizontalChrome = 0): number {
  return Math.max(
    0,
    Math.min(
      MAX_PROSE_WIDTH,
      Math.floor(availableWidth) - Math.max(0, Math.floor(horizontalChrome))
    )
  );
}

export interface ActionRowItem {
  id: string;
  fullLabel: string;
  shortLabel?: string;
  /** Cells occupied by fixed chrome such as a key label, badge, or padding. */
  fixedWidth?: number;
  /** Optional exact widths for presentations whose label and value share a cell. */
  fullWidth?: number;
  shortWidth?: number;
  /** Lower values are retained and expanded before higher values. */
  priority: number;
  /** Required items are considered before every optional item. */
  required?: boolean;
}

export interface FittedActionRowItem {
  id: string;
  label: string;
  variant: 'full' | 'short';
  width: number;
}

export interface ActionRowLayout {
  items: readonly FittedActionRowItem[];
  droppedIds: readonly string[];
  requiredDroppedIds: readonly string[];
  occupiedWidth: number;
}

function itemWidth(item: ActionRowItem, label: string, variant: 'full' | 'short'): number {
  const exact = variant === 'full' ? item.fullWidth : item.shortWidth;
  return exact === undefined
    ? Math.max(0, Math.floor(item.fixedWidth ?? 0)) + displayLen(label)
    : Math.max(0, Math.floor(exact));
}

/**
 * Fit one fixed-height action row without relying on Yoga clipping.
 *
 * Items enter at their shortest truthful label, required first and then by
 * priority. Remaining cells upgrade labels in the same order. Impossible
 * budgets are explicit through `requiredDroppedIds`, never silent overflow.
 */
export function fitActionRow(
  items: readonly ActionRowItem[],
  budget: number,
  separatorWidth = 0
): ActionRowLayout {
  const widthBudget = Math.max(0, Math.floor(budget));
  const separator = Math.max(0, Math.floor(separatorWidth));
  const ranked = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        Number(Boolean(b.item.required)) - Number(Boolean(a.item.required)) ||
        a.item.priority - b.item.priority ||
        a.index - b.index
    );
  const selected = new Map<
    string,
    { item: ActionRowItem; index: number; label: string; variant: 'full' | 'short'; width: number }
  >();
  let occupiedWidth = 0;

  for (const candidate of ranked) {
    const shortLabel = candidate.item.shortLabel ?? candidate.item.fullLabel;
    const variant = shortLabel === candidate.item.fullLabel ? 'full' : 'short';
    const width = itemWidth(candidate.item, shortLabel, variant);
    const nextWidth = occupiedWidth + (selected.size === 0 ? 0 : separator) + width;
    if (nextWidth > widthBudget) continue;
    selected.set(candidate.item.id, {
      ...candidate,
      label: shortLabel,
      variant,
      width,
    });
    occupiedWidth = nextWidth;
  }

  for (const candidate of ranked) {
    const current = selected.get(candidate.item.id);
    if (current === undefined || current.variant === 'full') continue;
    const fullWidth = itemWidth(candidate.item, candidate.item.fullLabel, 'full');
    const growth = fullWidth - current.width;
    if (occupiedWidth + growth > widthBudget) continue;
    current.label = candidate.item.fullLabel;
    current.variant = 'full';
    current.width = fullWidth;
    occupiedWidth += growth;
  }

  const ordered = [...selected.values()].sort((a, b) => a.index - b.index);
  const dropped = items.filter((item) => !selected.has(item.id));
  return {
    items: ordered.map(({ item, label, variant, width }) => ({
      id: item.id,
      label,
      variant,
      width,
    })),
    droppedIds: dropped.map((item) => item.id),
    requiredDroppedIds: dropped.filter((item) => item.required).map((item) => item.id),
    occupiedWidth,
  };
}

export interface ModalGeometryInput {
  width: number;
  height: number;
  desiredWidth: number;
  desiredHeight: number;
  hasActions: boolean;
}

export interface ModalGeometry {
  frameWidth: number;
  frameHeight: number;
  left: number;
  top: number;
  innerWidth: number;
  innerRows: number;
  titleRows: number;
  titleGapRows: number;
  bodyRows: number;
  actionGapRows: number;
  actionRows: number;
  actionWidth: number;
}

/** One source of truth for the clamped frame and every row inside its border. */
export function resolveModalGeometry(input: ModalGeometryInput): ModalGeometry {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const frameWidth = Math.max(1, Math.min(input.desiredWidth, Math.max(1, width - 2)));
  const frameHeight = Math.max(1, Math.min(input.desiredHeight, Math.max(1, height - 2)));
  const innerWidth = Math.max(1, frameWidth - 4);
  const innerRows = Math.max(0, frameHeight - 2);
  const titleRows = Math.min(1, innerRows);
  const actionRows = input.hasActions && innerRows - titleRows >= 2 ? 1 : 0;
  let bodyRows = Math.max(0, innerRows - titleRows - actionRows);
  const titleGapRows = bodyRows >= 2 ? 1 : 0;
  bodyRows -= titleGapRows;
  const actionGapRows = actionRows > 0 && bodyRows >= 2 ? 1 : 0;
  bodyRows -= actionGapRows;

  return {
    frameWidth,
    frameHeight,
    left: Math.max(0, Math.floor((width - frameWidth) / 2)),
    top: Math.max(0, Math.floor((height - frameHeight) / 2)),
    innerWidth,
    innerRows,
    titleRows,
    titleGapRows,
    bodyRows,
    actionGapRows,
    actionRows,
    actionWidth: actionRows === 0 ? 0 : innerWidth,
  };
}

export interface ShellHeightAllocation {
  terminalRows: number;
  menuRows: number;
  topBarRows: number;
  bodyRows: number;
  railRows: number;
  eventRows: number;
  /** Rows the detail pane occupies: all of bodyRows side-by-side, its share stacked. */
  detailRows: number;
  footerRows: number;
  /** Narrow terminals stack the body: detail on top, thread rail below, no events. */
  stacked: boolean;
  usedRows: number;
}

export interface ReviewSurfaceHeightAllocation {
  terminalRows: number;
  warningRows: number;
  bodyRows: number;
  footerRows: number;
  usedRows: number;
}

/** Preserve footer and a six-row primary body; overflow warnings stay scrollable. */
export function allocateReviewSurfaceHeight(
  terminalRows: number,
  warningContentRows: number
): ReviewSurfaceHeightAllocation {
  const terminal = Math.max(0, Math.floor(terminalRows));
  let remaining = terminal;
  const footerRows = Math.min(1, remaining);
  remaining -= footerRows;
  const minimumBodyRows = Math.min(6, remaining);
  remaining -= minimumBodyRows;
  const warningRows = Math.min(Math.max(0, Math.floor(warningContentRows)), remaining);
  remaining -= warningRows;
  const bodyRows = minimumBodyRows + remaining;
  return {
    terminalRows: terminal,
    warningRows,
    bodyRows,
    footerRows,
    usedRows: warningRows + bodyRows + footerRows,
  };
}

/** Below this width the Watch body stacks (the Review surfaces split at the same point). */
export const WATCH_STACK_BREAKPOINT = 110;

/** Stacked body floor: a 6-row detail pane above a 4-row thread rail. */
const STACKED_DETAIL_MIN = 6;
const STACKED_RAIL_MIN = 4;
const STACKED_BODY_MIN = STACKED_DETAIL_MIN + STACKED_RAIL_MIN;
/** TopBar's compact floor when the stacked body is starved (logo already gone below 6). */
const TOPBAR_COMPACT_MIN = 3;

/**
 * Watch shell yield order: menu/footer and primary rail, then TopBar, then
 * secondary events. The body absorbs all remaining height without overflow.
 *
 * Below `WATCH_STACK_BREAKPOINT` columns the body stacks — detail pane on top,
 * thread rail at the bottom, Live Events hidden — with the invariant
 * `detailRows + railRows === bodyRows`. Degradation at short heights: TopBar
 * compacts to 3 rows before the rail yields; below the 10-row stacked floor
 * even with a compact TopBar, the rail collapses (railRows 0) and the detail
 * pane keeps the whole body.
 */
export function allocateShellHeight(
  terminalRows: number,
  terminalWidth: number = Number.POSITIVE_INFINITY
): ShellHeightAllocation {
  const terminal = Math.max(0, Math.floor(terminalRows));
  const stacked = terminalWidth < WATCH_STACK_BREAKPOINT;
  let remaining = terminal;
  const menuRows = Math.min(1, remaining);
  remaining -= menuRows;
  const footerRows = Math.min(1, remaining);
  remaining -= footerRows;

  const minimumPrimaryRows = Math.min(6, remaining);
  remaining -= minimumPrimaryRows;
  let topBarRows = Math.min(6, remaining);
  remaining -= topBarRows;
  let bodyRows = minimumPrimaryRows + remaining;

  if (!stacked) {
    const desiredEventRows = Math.min(12, Math.floor(bodyRows * 0.35));
    const eventRows =
      bodyRows - desiredEventRows >= 6 && desiredEventRows >= 5 ? desiredEventRows : 0;
    const railRows = bodyRows - eventRows;
    return {
      terminalRows: terminal,
      menuRows,
      topBarRows,
      bodyRows,
      railRows,
      eventRows,
      detailRows: bodyRows,
      footerRows,
      stacked,
      usedRows: menuRows + topBarRows + bodyRows + footerRows,
    };
  }

  if (bodyRows < STACKED_BODY_MIN && topBarRows > TOPBAR_COMPACT_MIN) {
    const reclaimed = Math.min(topBarRows - TOPBAR_COMPACT_MIN, STACKED_BODY_MIN - bodyRows);
    topBarRows -= reclaimed;
    bodyRows += reclaimed;
  }
  const railRows =
    bodyRows >= STACKED_BODY_MIN ? Math.max(STACKED_RAIL_MIN, Math.floor(bodyRows * 0.35)) : 0;
  const detailRows = bodyRows - railRows;
  return {
    terminalRows: terminal,
    menuRows,
    topBarRows,
    bodyRows,
    railRows,
    eventRows: 0,
    detailRows,
    footerRows,
    stacked,
    usedRows: menuRows + topBarRows + bodyRows + footerRows,
  };
}
