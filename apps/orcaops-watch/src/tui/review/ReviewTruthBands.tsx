// COVERAGE, CAPTURED TRAIL and WARNINGS — facts about the floor, identical
// under both lenses.
//
// The Brief's left pane has a FINITE height and has to price these bands before
// it can decide how many attention rows fit above them. `reviewTruthBandRows`
// and the component are deliberately adjacent: a count that disagreed with the
// render would push the warnings below the fold, which is precisely the thing
// the height budget exists to prevent.

import { CITATION_KIND, type Floor, type UncertaintyState } from '@orcaops/review-core';

import type { StalenessRow } from '../../data/staleness';
import { useCockpitTheme } from '../ThemeProvider';
import { SYMBOL } from '../coreTheme';
import { Section } from '../kit';
import { displayLen, truncate } from '../layout';
import {
  briefOutcomeSummary,
  briefUncertaintyStates,
  coverageTone,
  uncertaintySegments,
} from './briefOrientation';

const COVERAGE_BAR_WIDTH = 18;
const UNCERTAINTY_BAR_WIDTH = 10;

function coverageBar(matched: number, reviewable: number): { done: string; todo: string } {
  const filled = reviewable <= 0 ? 0 : Math.round((matched / reviewable) * COVERAGE_BAR_WIDTH);
  const clamped = Math.max(0, Math.min(COVERAGE_BAR_WIDTH, filled));
  return { done: '█'.repeat(clamped), todo: '░'.repeat(COVERAGE_BAR_WIDTH - clamped) };
}

export interface ReviewTruthBandsInput {
  floor: Floor;
  staleness?: StalenessRow | null;
  openComments: number;
  /** Pane width. Single-line facts are fitted to it; warnings wrap and are priced. */
  width?: number;
  /** Ledger disposition per citation id, for the uncertainty breakdown. */
  uncertaintyStates?: ReadonlyMap<string, UncertaintyState>;
  /** Narrative composition outcomes. Rendered on their own line, never merged. */
  outcomeCounts?: Readonly<Record<string, number>>;
}

const DEFAULT_BAND_WIDTH = 106;

/** Rows a deliberately wrapping warning actually occupies. */
function wrappedRows(copy: string, width: number): number {
  return Math.max(1, Math.ceil((displayLen(copy) + 3) / Math.max(1, width)));
}

function landmarkSummary(floor: Floor): string | null {
  const counts = new Map<string, number>();
  for (const landmark of floor.landmarks) {
    counts.set(landmark.kind, (counts.get(landmark.kind) ?? 0) + 1);
  }
  return counts.size === 0
    ? null
    : [...counts].map(([kind, count]) => `${kind.toLowerCase()} ×${count}`).join(' · ');
}

/** Exactly the rows `ReviewTruthBands` paints, so a caller can budget around them. */
export function reviewTruthBandRows(input: ReviewTruthBandsInput): number {
  const width = input.width ?? DEFAULT_BAND_WIDTH;
  const unclaimed = input.floor.plan_coverage.filter((step) => step.unclaimed).length;
  // blank + COVERAGE + bar + optional landmarks + one row per unclaimed step
  const coverage = 3 + (landmarkSummary(input.floor) === null ? 0 : 1) + unclaimed;
  // blank + CAPTURED TRAIL + three fitted fact rows + an optional outcomes row
  const trail = 5 + (briefOutcomeSummary(input.outcomeCounts ?? {}) === null ? 0 : 1);
  // Warnings are prose and are ALLOWED to wrap, so they are priced by their real
  // wrapped height — an unpriced wrap silently pushes the band out of view.
  const warningRows =
    input.floor.disclosure.reduce((total, row) => total + wrappedRows(row.message, width), 0) +
    (input.staleness == null ? 0 : wrappedRows(input.staleness.message, width));
  return coverage + trail + (warningRows > 0 ? 2 + warningRows : 0);
}

export function ReviewTruthBands({
  floor,
  staleness,
  openComments,
  width,
  uncertaintyStates,
  outcomeCounts,
}: ReviewTruthBandsInput) {
  const { AMBER, BLUE, DIM, FAINT, LIVE, RED } = useCockpitTheme();
  // Every row carries a leading space, and the last cell is left free so a
  // fitted fact can never be the thing that trips a wrap.
  const rowWidth = Math.max(8, (width ?? DEFAULT_BAND_WIDTH) - 2);
  const summary = floor.coverage.summary;
  const pct =
    summary.reviewable_rows === 0
      ? 0
      : Math.round((summary.matched_rows / summary.reviewable_rows) * 100);
  const landmarks = landmarkSummary(floor);
  const unclaimed = floor.plan_coverage.filter((step) => step.unclaimed);
  const decisions = floor.citations.filter(
    (citation) => citation.kind === CITATION_KIND.CHECKPOINT_DECISION
  ).length;
  const uncertainties = briefUncertaintyStates(floor, uncertaintyStates ?? new Map());
  const outcomes = briefOutcomeSummary(outcomeCounts ?? {});
  const guidance = floor.citations.filter(
    (citation) => citation.kind === CITATION_KIND.EVALUATOR_RUN
  ).length;
  const coverage = coverageBar(summary.matched_rows, summary.reviewable_rows);
  const covTone = coverageTone(pct);
  const coverageColor = covTone === 'positive' ? LIVE : covTone === 'attention' ? AMBER : RED;
  // The uncertainty meter takes whatever the row has left after its label and
  // counts, and is dropped entirely when the pane is too narrow — a bar is never
  // worth wrapping the row and spending the warnings band a line.
  const countsText = `${uncertainties.open} open · ${uncertainties.acknowledged} ack · ${uncertainties.resolved} resolved`;
  const uncBudget = rowWidth - displayLen('uncertainty') - 1 - 2 - displayLen(countsText) - 2;
  const uncWidth = uncBudget >= 3 ? Math.min(UNCERTAINTY_BAR_WIDTH, uncBudget) : 0;
  const uncSeg = uncertaintySegments(
    uncertainties.open,
    uncertainties.acknowledged,
    uncertainties.resolved,
    uncWidth
  );
  const uncRest = Math.max(0, uncWidth - uncSeg.open - uncSeg.acknowledged - uncSeg.resolved);
  return (
    <>
      <text> </text>
      {/* Muted headings, matching the Watch's in-pane section headers. Only
          WARNINGS keeps an attention tone, because only it is an alert. */}
      <Section id="review-truth-coverage" title="COVERAGE" tone="muted" />
      <text>
        {' '}
        <span fg={coverageColor}>{coverage.done}</span>
        <span fg={FAINT}>{coverage.todo}</span>
        <span fg={coverageColor}> {pct}%</span>
        <span fg={DIM}>
          {' '}
          matched ({summary.matched_rows}/{summary.reviewable_rows} rows)
        </span>
      </text>
      {landmarks === null ? null : (
        <text fg={DIM}> {truncate(`landmarks · ${landmarks}`, rowWidth)}</text>
      )}
      {unclaimed.map((step) => (
        <text key={step.step_id} fg={AMBER}>
          {' '}
          {SYMBOL.warning}{' '}
          {truncate(`plan step not landed · ${step.label || step.text}`, rowWidth - 2)}
        </text>
      ))}
      <text> </text>
      <Section id="review-truth-captured-trail" title="CAPTURED TRAIL" tone="muted" />
      <text fg={DIM}>
        {' '}
        {truncate(`${decisions} decision(s) · ${guidance} evaluator note(s)`, rowWidth)}
      </text>
      <text>
        {' '}
        <span fg={DIM}>uncertainty</span>
        {uncWidth > 0 ? (
          <>
            {' '}
            <span fg={AMBER}>{'▓'.repeat(uncSeg.open)}</span>
            <span fg={BLUE}>{'▓'.repeat(uncSeg.acknowledged)}</span>
            <span fg={LIVE}>{'▓'.repeat(uncSeg.resolved)}</span>
            <span fg={FAINT}>{'░'.repeat(uncRest)}</span>
          </>
        ) : null}{' '}
        <span fg={AMBER}>{uncertainties.open} open</span>
        <span fg={DIM}> · </span>
        <span fg={BLUE}>{uncertainties.acknowledged} ack</span>
        <span fg={DIM}> · </span>
        <span fg={LIVE}>{uncertainties.resolved} resolved</span>
      </text>
      <text fg={DIM}> {truncate(`${openComments} open comment(s)`, rowWidth)}</text>
      {outcomes === null ? null : (
        <text fg={DIM}> {truncate(`composition · ${outcomes}`, rowWidth)}</text>
      )}
      {floor.disclosure.length > 0 || staleness != null ? (
        <>
          <text> </text>
          <Section id="review-truth-warnings" title="WARNINGS" tone="attention" />
          {floor.disclosure.map((row, index) => (
            <text key={`${row.code}:${index}`} fg={AMBER}>
              {' '}
              {SYMBOL.warning} {row.message}
            </text>
          ))}
          {staleness != null ? (
            <text fg={AMBER}>
              {' '}
              {SYMBOL.warning} {staleness.message}
            </text>
          ) : null}
        </>
      ) : null}
    </>
  );
}
