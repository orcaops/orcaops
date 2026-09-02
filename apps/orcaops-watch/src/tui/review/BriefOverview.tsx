// The Brief's left pane: where am I, and what still wants me.
//
// Fixed branch-level orientation, deliberately NOT master-detail. Selecting a
// checkpoint in the tree does not change anything here — per-leaf detail belongs
// on Floor Diff and Walk, and a Brief whose left half redrew on every `j` would
// stop being a place you can read in sixty seconds.
//
// The bands below ATTENTION are priced before the attention rows are, so the
// warnings stay inside the initial viewport no matter how long the queue gets.

import type { Floor, UncertaintyState } from '@orcaops/review-core';

import type { RoutineStoryAnchors } from '../../data/reviewSource';
import type { StalenessRow } from '../../data/staleness';
import { useCockpitTheme } from '../ThemeProvider';
import { Section } from '../kit';
import { displayLen } from '../layout';
import { ReviewHitRow } from './ReviewHitRow';
import { reviewTruthBandRows, ReviewTruthBands } from './ReviewTruthBands';
import { type BriefAttentionRow, type BriefAttentionTone } from './briefAttention';
import { briefPlanStatus } from './briefOrientation';
import {
  briefStepDots,
  fitBriefAttentionWindow,
  fitBriefMetaRow,
  fitBriefProseRow,
} from './briefRows';
import type { ReaderModel } from './readerModel';

/**
 * The most lines the attention queue may claim, however tall the terminal.
 *
 * Without a ceiling the queue grows to fill the pane — on a branch carrying
 * twenty-odd open uncertainties that is a wall of near-identical rows, and it
 * pushes the bands beneath it to the floor. The overflow is never lost: it is
 * counted in the `n more` affordance and walked with `n`.
 */
const ATTENTION_LINE_CAP = 12;

/**
 * The most step dots a run may draw, however wide the row.
 *
 * Generous on purpose: the dots exist to show the SHAPE of a run, so when the
 * row has the width the shape should simply be real — a thirteen-checkpoint run
 * draws thirteen dots rather than truncating to a `+1` on a row that fits.
 */
const STEP_DOT_CAP = 24;

export interface BriefOverviewProps {
  floor: Floor;
  reader: ReaderModel;
  attention: readonly BriefAttentionRow[];
  attentionCursor: number;
  /** The durable identity of the selected attention row, or null before traversal. */
  attentionRowKey: string | null;
  focused: boolean;
  width: number;
  height: number;
  staleness?: StalenessRow | null;
  openComments?: number;
  uncertaintyStates?: ReadonlyMap<string, UncertaintyState>;
  /** Semantic-anchor generation health, for the Story's Placement row. */
  anchorStatus?: RoutineStoryAnchors['status'];
  onActivateAttention?: (index: number) => void;
}

type OverviewRow =
  | { kind: 'text'; key: string; label: string; value: string }
  | { kind: 'prose'; key: string; label: string; lines: readonly string[]; indent: number }
  | {
      kind: 'dots';
      key: string;
      label: string;
      done: string;
      remaining: string;
      overflow: string;
      suffix: string;
    };

function textRow(key: string, label: string, value: string, width: number): OverviewRow {
  return { kind: 'text', key, ...fitBriefMetaRow({ width, label, value }) };
}

/** Real prose wraps; see `fitBriefProseRow`. Short metadata stays `textRow`. */
function proseRow(key: string, label: string, value: string, width: number): OverviewRow {
  return { kind: 'prose', key, ...fitBriefProseRow({ width, label, value }) };
}

/**
 * A step-dot row — `Progress · ●●●○○○ 3/6 checkpoints`.
 *
 * The stat tile above already carries the count; what it cannot carry is the
 * SHAPE of the run. The dots are sized from what the row has left after its
 * label and count, so a long plan sheds dots to `+N` rather than overflow.
 */
function dotsRow(input: {
  key: string;
  label: string;
  done: number;
  total: number;
  noun: string;
  width: number;
}): OverviewRow {
  const label = `${input.label} · `;
  const suffix = `${input.done}/${input.total} ${input.noun}`;
  const budget = Math.floor(input.width) - displayLen(label) - displayLen(suffix) - 6;
  const dots = briefStepDots(input.done, input.total, Math.max(0, Math.min(STEP_DOT_CAP, budget)));
  return { kind: 'dots', key: input.key, label, suffix, ...dots };
}

/**
 * Orientation rows, per lens.
 *
 * The countable vitals live in the stat band above both panes. What stays here
 * is what a tile cannot carry: prose, and the shape of a run as step dots. The
 * COVERAGE bar is deliberately NOT repeated — the band below is its one home.
 */
function orientationRows(input: {
  floor: Floor;
  reader: ReaderModel;
  attention: readonly BriefAttentionRow[];
  attentionRowKey: string | null;
  anchorStatus: RoutineStoryAnchors['status'] | undefined;
  width: number;
}): OverviewRow[] {
  const { floor, reader, width } = input;
  const story = reader.story;
  const complete = reader.coverage.pagesComplete;
  const total = reader.coverage.pagesTotal;
  const plan = briefPlanStatus(floor);
  const rows: OverviewRow[] =
    story === null
      ? [
          textRow(
            'lens',
            'Reading',
            `captured checkpoints · ${floor.scope.branch} · base ${floor.scope.base_sha.slice(0, 7)}`,
            width
          ),
          dotsRow({
            key: 'progress',
            label: 'Progress',
            done: complete,
            total,
            noun: 'checkpoints',
            width,
          }),
          ...(plan === null
            ? []
            : [
                dotsRow({
                  key: 'plan',
                  label: 'Plan',
                  done: plan.claimed,
                  total: plan.total,
                  noun: 'claimed',
                  width,
                }),
              ]),
        ]
      : [
          // The Story's trust headline.
          proseRow('story', 'Story', story.banner, width),
          // Match health of a stale projection: partial survival, said plainly.
          // WRAPS rather than truncates: at the 54-cell pane a single line cuts
          // exactly the tail — `· anchors unavailable`, the part that says the
          // placements are gone too — and a health row that hides its worst
          // clause is worse than no health row.
          ...(reader.staleHealth === undefined
            ? []
            : [
                proseRow(
                  'stale-health',
                  'Stale',
                  `${reader.staleHealth.survivingMappings}/${reader.staleHealth.totalMappings} code mapping(s) current · read-only${
                    reader.staleHealth.anchorsUnavailable ? ' · anchors unavailable' : ''
                  }`,
                  width
                ),
              ]),
          proseRow(
            'what',
            'What',
            story.overview?.text ??
              'No authored account Story; inspect the retained code evidence.',
            width
          ),
          dotsRow({
            key: 'progress',
            label: 'Progress',
            done: complete,
            total,
            noun: reader.pages.some((page) => page.kind === 'part') ? 'parts' : 'pages',
            width,
          }),
          textRow(
            'attribution',
            'Attribution',
            `${Math.round(story.metrics.attributedPct)}% attributed · ${story.metrics.ambiguousRows} ambiguous · ${story.metrics.contestedRows} contested · ${story.metrics.unattributedRows} unattributed`,
            width
          ),
          textRow(
            'sources',
            'Sources',
            `${story.metrics.contributingThreads} thread(s) · ${story.metrics.contributingCheckpoints} checkpoint(s) · ${story.overview?.citations.length ?? 0} overview citation(s)`,
            width
          ),
          ...placementRow(input.anchorStatus, reader, width),
        ];
  return [
    ...rows,
    textRow('selected', 'Selected', selectedValue(input.attention, input.attentionRowKey), width),
  ];
}

/**
 * WHERE the Story's context is anchored — only when anchors were generated.
 *
 * `absent` spends no row: a review without a semantic-anchor generation is the
 * common healthy case, not a degradation worth a line of a half-width pane.
 */
function placementRow(
  anchorStatus: RoutineStoryAnchors['status'] | undefined,
  reader: ReaderModel,
  width: number
): OverviewRow[] {
  if (anchorStatus === undefined || anchorStatus === 'absent') return [];
  const note =
    anchorStatus === 'ok'
      ? `${reader.routeIndex.semanticPlacementById.size} anchored location(s)`
      : `anchors ${anchorStatus}`;
  return [textRow('placement', 'Placement', note, width)];
}

/**
 * WHAT is selected in the attention queue, named rather than promised.
 *
 * Resolves the CURRENT selection key — under the two-step n/N contract this row
 * mirrors the current highlight rather than the next one, so it always names
 * what `↵` would open.
 */
function selectedValue(
  attention: readonly BriefAttentionRow[],
  attentionRowKey: string | null
): string {
  if (attention.length === 0) return 'nothing unresolved';
  if (attentionRowKey === null) return 'nothing selected · n/N to select';
  const selected = attention.find((row) => row.key === attentionRowKey);
  return selected === undefined
    ? 'nothing selected · n/N to select'
    : `${selected.glyph} ${selected.label}`;
}

export function BriefOverview(props: BriefOverviewProps) {
  const { ACCENT, AMBER, BLUE, BRIGHT, CYAN, DIM, DIMMER, FG, LIVE, RED, SEL_BG } =
    useCockpitTheme();
  // One tone, one colour — parallel to the glyph carried on every row, so the
  // severity a reviewer reads and the hue they see cannot disagree.
  const attentionToneColor = (tone: BriefAttentionTone): string => {
    switch (tone) {
      case 'critical':
        return RED;
      case 'warn':
      case 'prompt':
      case 'uncertainty':
        return AMBER;
      case 'comment':
        return BLUE;
      case 'decision':
        return ACCENT;
      case 'inspect':
      case 'structural':
        return CYAN;
    }
  };
  const openComments = props.openComments ?? 0;
  // ONE content width for the whole pane: the scrollbox's left padding plus its
  // scrollbar column, priced once. Three slightly different widths is how a row
  // ends up a single cell too long, wraps, and quietly costs the band below it
  // the row it was budgeted.
  const contentWidth = Math.max(1, props.width - 3);
  const rows = orientationRows({
    floor: props.floor,
    reader: props.reader,
    attention: props.attention,
    attentionRowKey: props.attentionRowKey,
    anchorStatus: props.anchorStatus,
    width: contentWidth,
  });
  const bandRows = reviewTruthBandRows({
    floor: props.floor,
    staleness: props.staleness,
    openComments,
    width: contentWidth,
    ...(props.uncertaintyStates === undefined
      ? {}
      : { uncertaintyStates: props.uncertaintyStates }),
  });
  // OVERVIEW heading + orientation + blank + ATTENTION heading + the two scroll
  // affordance slots, then the bands. The affordances have to be priced too: an
  // unpriced `n more` line is one row of overflow, and one row of overflow is
  // the warnings band leaving the viewport.
  // Prose rows are multi-line; budget PHYSICAL lines, not logical rows.
  const orientationLines = rows.reduce(
    (total, row) => total + (row.kind === 'prose' ? row.lines.length : 1),
    0
  );
  const fixedRows = 1 + orientationLines + 2 + 2 + bandRows;
  // Capped even when the terminal is tall enough to paint every row. A queue
  // that fills the pane pushes COVERAGE, CAPTURED TRAIL and WARNINGS to the
  // floor and reads as a wall; the rest of the queue is one `n` away.
  const attentionBudget = Math.min(ATTENTION_LINE_CAP, Math.max(1, props.height - fixedRows));
  const window = fitBriefAttentionWindow({
    rows: props.attention,
    cursor: props.attentionCursor,
    width: contentWidth,
    maxLines: attentionBudget,
  });

  return (
    <scrollbox
      id="review-brief-overview"
      scrollY={true}
      focused={false}
      width={props.width}
      height={props.height}
      paddingLeft={1}
    >
      <box id="review-brief-overview-body" flexDirection="column" width={contentWidth}>
        <Section
          id="review-brief-overview-header"
          title="OVERVIEW"
          variant="cap"
          focused={props.focused}
        />
        {rows.map((row) =>
          row.kind === 'text' ? (
            <text key={row.key} fg={FG}>
              {' '}
              <span fg={DIM}>{row.label}</span>
              {row.value}
            </text>
          ) : row.kind === 'prose' ? (
            <box key={row.key} flexDirection="column">
              {row.lines.map((line, at) => (
                <text key={at} fg={FG}>
                  {' '}
                  {at === 0 ? <span fg={DIM}>{row.label}</span> : ' '.repeat(row.indent)}
                  {line}
                </text>
              ))}
            </box>
          ) : (
            <text key={row.key}>
              {' '}
              <span fg={DIM}>{row.label}</span>
              <span fg={LIVE}>{row.done}</span>
              <span fg={DIMMER}>{row.remaining}</span>
              <span fg={DIM}>{`${row.overflow} ${row.suffix}`}</span>
            </text>
          )
        )}
        <text> </text>
        {/* `muted` (DIMMER) is the token the Watch dashboard uses for its own
            in-pane section headers, so the two screens read the same. */}
        <Section
          id="review-brief-attention"
          title={`ATTENTION · ${props.attention.length}`}
          tone="muted"
        />
        {props.attention.length === 0 ? <text fg={LIVE}> ✓ no unresolved review work</text> : null}
        {window.hiddenBefore > 0 ? <text fg={DIM}> ↑ {window.hiddenBefore} more above</text> : null}
        {window.lines.map((line) => (
          <ReviewHitRow
            key={line.key}
            id={`review-brief-attention-${line.index}`}
            flexDirection="column"
            selectedBackground={line.selected ? SEL_BG : undefined}
            onSelect={
              props.onActivateAttention === undefined
                ? undefined
                : () => props.onActivateAttention?.(line.index)
            }
          >
            <text>
              <span fg={line.selected ? ACCENT : DIM}>{line.selected ? ' ❯ ' : '   '}</span>
              <span fg={attentionToneColor(line.tone)}>{line.glyph}</span>
              <span fg={line.selected ? BRIGHT : FG}> {line.label}</span>
            </text>
            {line.detail === null ? null : (
              <text fg={DIM}>
                {'     '}
                {line.detail}
              </text>
            )}
          </ReviewHitRow>
        ))}
        {props.attention.length === 0 ? null : (
          <text fg={DIM}>
            {' '}
            {window.hiddenAfter > 0 ? `↓ ${window.hiddenAfter} more · ` : ''}n/N select · ↵ open
          </text>
        )}
        <ReviewTruthBands
          floor={props.floor}
          staleness={props.staleness}
          openComments={openComments}
          width={contentWidth}
          uncertaintyStates={props.uncertaintyStates}
        />
      </box>
    </scrollbox>
  );
}
