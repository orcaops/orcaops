// The Brief's right pane: Threads → Checkpoints, or Acts → Parts.
//
// The nesting is real but the interaction is flat. Group headings are plain
// text — no hit region, no hover background, no cursor stop — because a Thread
// is not somewhere a reviewer can go. Only leaves, plus the trailing Unassigned
// and Finish rows, are destinations, and they come from `BriefTree.destinations`
// in the same order the cursor walks. That is why the row under the highlight
// and the thing `↵` opens are the same object rather than two derivations that
// have to be kept in agreement.

import type { ReviewLifecycleLedger } from '@orcaops/review-core';

import { useCockpitTheme } from '../ThemeProvider';
import { Section } from '../kit';
import { displayLen, progressBar, truncate } from '../layout';
import { ReviewHitRow } from './ReviewHitRow';
import { fitBriefLeafRow, windowBriefRows } from './briefRows';
import {
  briefFinishRow,
  briefLeafBadges,
  briefLeafGlyph,
  type BriefLeafMetrics,
  type BriefTree as BriefTreeModel,
} from './briefTree';
import type { ReaderModel } from './readerModel';

/** Total cells a group heading's completion meter occupies, bar plus its count. */
const GROUP_METER_WIDTH = 12;

/** One painted line. Groups are inert; every other kind carries a destination index. */
type BriefTreeRenderRow =
  | {
      kind: 'group';
      key: string;
      title: string;
      order: number;
      actOrdinal: number | null;
      complete: number;
      total: number;
    }
  | {
      kind: 'leaf';
      key: string;
      destination: number;
      pageIndex: number;
      metrics: BriefLeafMetrics;
    }
  | { kind: 'unassigned'; key: string; destination: number }
  | { kind: 'finish'; key: string; destination: number };

function renderRows(tree: BriefTreeModel): BriefTreeRenderRow[] {
  const rows: BriefTreeRenderRow[] = [];
  for (const group of tree.groups) {
    rows.push({
      kind: 'group',
      key: `group:${group.key}`,
      title: group.title,
      order: group.order,
      actOrdinal: group.actOrdinal,
      complete: group.complete,
      total: group.total,
    });
    for (const destination of group.leafDestinationIndices) {
      const entry = tree.destinations[destination];
      if (entry?.kind !== 'page') continue;
      rows.push({
        kind: 'leaf',
        key: entry.key,
        destination,
        pageIndex: entry.pageIndex,
        metrics: entry.metrics,
      });
    }
  }
  tree.destinations.forEach((entry, destination) => {
    if (entry.kind === 'unassigned') {
      rows.push({ kind: 'unassigned', key: entry.key, destination });
    }
    if (entry.kind === 'finish') rows.push({ kind: 'finish', key: entry.key, destination });
  });
  return rows;
}

function headerText(
  tree: BriefTreeModel,
  reader: ReaderModel,
  title: string | null,
  width: number
): string {
  const complete = reader.coverage.pagesComplete;
  const total = reader.coverage.pagesTotal;
  const named = title === null ? '' : ` · ${title}`;
  // A degraded-attribution Story routes code through retained checkpoint pages,
  // so the leaf noun follows what the tree actually holds.
  const acts = tree.groups.filter((group) => group.variant === 'act').length;
  const noun = acts > 0 || tree.groups.some((group) => group.variant === 'loose') ? 'part' : 'page';
  const full =
    tree.lens === 'deterministic'
      ? `CAPTURED WORK · ${tree.groups.length} thread(s) · ${total} checkpoint(s) · ${complete}/${total} complete`
      : `STORY${named} · ${acts} act(s) · ${complete}/${total} ${noun}(s) complete`;
  const short =
    tree.lens === 'deterministic'
      ? `CAPTURED WORK · ${complete}/${total} complete`
      : `STORY${named} · ${complete}/${total} ${noun}(s)`;
  const shortest =
    tree.lens === 'deterministic'
      ? `CAPTURED WORK · ${complete}/${total} complete`
      : `STORY · ${complete}/${total} ${noun}(s)`;
  // The heading sheds detail in order — breakdown, then the Story's title —
  // before it truncates. A half-written count is worse than a shorter true one,
  // and the count is the part a reviewer is actually reading.
  if (displayLen(full) <= width) return full;
  if (displayLen(short) <= width) return short;
  return truncate(shortest, width);
}

export function BriefTreePane({
  tree,
  reader,
  cursor,
  focused,
  width,
  height,
  lifecycle,
  title,
  onActivate,
}: {
  tree: BriefTreeModel;
  reader: ReaderModel;
  cursor: number;
  focused: boolean;
  width: number;
  height: number;
  lifecycle?: ReviewLifecycleLedger;
  /** The composed Story's title, under synthesis. */
  title?: string | null;
  onActivate?: (destination: number) => void;
}) {
  const { AMBER, BRIGHT, DIM, FAINT, FG, LIVE, RED, SEL_BG } = useCockpitTheme();
  const rows = renderRows(tree);
  const rowWidth = Math.max(1, width - 2);
  // The cursor indexes DESTINATIONS; the window scrolls RENDER ROWS. Mapping
  // one to the other here is what keeps the selected destination on screen even
  // though headings occupy lines the cursor never visits.
  const cursorRow = Math.max(
    0,
    rows.findIndex((row) => row.kind !== 'group' && row.destination === cursor)
  );
  // Header, the `n above` line it always reserves, and a possible `n below`.
  const windowed = windowBriefRows(rows, cursorRow, Math.max(1, height - 3));
  const finish = briefFinishRow(lifecycle, reader.finish);

  const leafRow = (row: Extract<BriefTreeRenderRow, { kind: 'leaf' }>) => {
    const page = reader.pages[row.pageIndex];
    if (page === undefined) return null;
    const metrics = row.metrics;
    const prefix = page.kind === 'checkpoint' ? `cp${page.member.cp} · ` : '';
    const parts = fitBriefLeafRow({
      width: rowWidth,
      selected: row.destination === cursor,
      indent: 2,
      glyph: briefLeafGlyph(page),
      label: `${prefix}${page.label}`,
      badges: briefLeafBadges(page),
      churn:
        metrics.files === 0 ? null : `· +${metrics.added} −${metrics.removed} · ${metrics.files}f`,
    });
    return (
      <ReviewHitRow
        key={row.key}
        id={`review-brief-leaf-${row.destination}`}
        selectedBackground={row.destination === cursor && focused ? SEL_BG : undefined}
        onSelect={onActivate === undefined ? undefined : () => onActivate(row.destination)}
      >
        <text fg={row.destination === cursor ? AMBER : page.complete ? LIVE : FG}>
          {parts.marker}
          {parts.glyph} {parts.label}
          {parts.badges === null ? null : <span fg={AMBER}> {parts.badges}</span>}
          {parts.churn === null ? null : (
            <>
              <span fg={DIM}> · </span>
              <span fg={LIVE}>+{metrics.added}</span>
              <span fg={RED}> −{metrics.removed}</span>
              <span fg={DIM}> · {metrics.files}f</span>
            </>
          )}
        </text>
      </ReviewHitRow>
    );
  };

  return (
    <box
      id="review-brief-tree"
      flexDirection="column"
      width={width}
      height={height}
      paddingLeft={1}
    >
      <Section
        id="review-brief-tree-header"
        title={headerText(tree, reader, title ?? null, Math.max(1, width - 5))}
        variant="cap"
        focused={focused}
      />
      {windowed.hiddenBefore > 0 ? (
        <text fg={DIM}> ↑ {windowed.hiddenBefore} more above</text>
      ) : (
        <text> </text>
      )}
      {windowed.rows.map((row) => {
        if (row.kind === 'group') {
          // INERT. No hit region and no hover background: a Thread or an Act is
          // a heading over destinations, not a destination — but it carries a
          // completion meter, so how far a Thread has come reads at a glance.
          const prefix =
            row.actOrdinal !== null
              ? `ACT ${row.actOrdinal} · `
              : tree.lens === 'deterministic'
                ? `${row.order + 1} · `
                : '';
          const meter = progressBar(row.complete, row.total, GROUP_METER_WIDTH);
          const titleMax = Math.max(4, rowWidth - displayLen(prefix) - GROUP_METER_WIDTH - 2);
          return (
            <box key={row.key} flexDirection="row" width={rowWidth} height={1} flexShrink={0}>
              <text fg={BRIGHT}>
                {' '}
                {prefix}
                {truncate(row.title, titleMax)}
              </text>
              <box flexGrow={1} />
              <text>
                <span fg={row.complete > 0 ? LIVE : FAINT}>{meter.done}</span>
                <span fg={FAINT}>{meter.todo}</span>
                <span fg={DIM}> {meter.label}</span>
              </text>
            </box>
          );
        }
        if (row.kind === 'leaf') return leafRow(row);
        if (row.kind === 'unassigned') {
          // Story residue is explained cross-Part evidence with its own page;
          // it must not be relabelled as deterministic Unassigned.
          const residue =
            reader.auxiliaryPage.kind === 'story-residue' ? reader.auxiliaryPage : null;
          const rowComplete = residue === null ? reader.unassigned.complete : residue.complete;
          const parts = fitBriefLeafRow({
            width: rowWidth,
            selected: row.destination === cursor,
            indent: 0,
            glyph: rowComplete ? '✓' : '!',
            label:
              residue === null
                ? `Unassigned · ${reader.unassigned.gap.currentRows.length} unexplained row(s) · ${reader.unassigned.ambiguous.length} ambiguous hunk(s)`
                : `Residue · ${residue.inspectionRows.length} changed row(s) · ${residue.ambiguousHunkKeys.length} ambiguous hunk(s)`,
          });
          return (
            <ReviewHitRow
              key={row.key}
              id="review-brief-unassigned"
              selectedBackground={row.destination === cursor && focused ? SEL_BG : undefined}
              onSelect={onActivate === undefined ? undefined : () => onActivate(row.destination)}
            >
              <text fg={row.destination === cursor ? AMBER : rowComplete ? LIVE : AMBER}>
                {parts.marker}
                {parts.glyph} {parts.label}
              </text>
            </ReviewHitRow>
          );
        }
        const parts = fitBriefLeafRow({
          width: rowWidth,
          selected: row.destination === cursor,
          indent: 0,
          glyph: finish.glyph,
          label: finish.label,
          badges: finish.detail === null ? null : `· ${finish.detail}`,
        });
        return (
          <ReviewHitRow
            key={row.key}
            id="review-brief-finish"
            selectedBackground={row.destination === cursor && focused ? SEL_BG : undefined}
            onSelect={onActivate === undefined ? undefined : () => onActivate(row.destination)}
          >
            <text fg={row.destination === cursor ? AMBER : finish.blocked ? FG : LIVE}>
              {parts.marker}
              {parts.glyph} {parts.label}
              {parts.badges === null ? null : <span fg={DIM}> {parts.badges}</span>}
            </text>
          </ReviewHitRow>
        );
      })}
      {windowed.hiddenAfter > 0 ? <text fg={DIM}> ↓ {windowed.hiddenAfter} more below</text> : null}
    </box>
  );
}
