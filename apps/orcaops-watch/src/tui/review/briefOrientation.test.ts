import { describe, expect, it } from 'vitest';

import {
  CITATION_KIND,
  COVERAGE_VERDICT,
  type Floor,
  UNCERTAINTY_STATE,
  type UncertaintyState,
} from '@orcaops/review-core';

import {
  briefCoveragePercent,
  briefOutcomeSummary,
  briefPlanStatus,
  briefReviewScope,
  briefUncertaintyStates,
  coverageTone,
  uncertaintySegments,
} from './briefOrientation';
import { buildWatchReviewFixture } from '../../../tests/review/reviewExperienceFixtures';

describe('briefReviewScope', () => {
  it('counts every retained hunk, including ones no reviewer will read', async () => {
    const fixture = await buildWatchReviewFixture('no-narrative');
    const floor = structuredClone(fixture.source.floor) as Floor;
    const template = floor.coverage.items[0]!;
    // EXCLUDED and UNREVIEWABLE hunks are part of the pinned review scope even
    // though no page owns them. Summing owned rows instead would silently make
    // the branch look smaller in the one place a reviewer goes to size it up.
    floor.coverage.items.push(
      {
        ...template,
        hunkKey: 'hunk_excluded',
        file: 'vendor/generated.ts',
        verdict: COVERAGE_VERDICT.EXCLUDED,
        added_lines: 40,
        removed_lines: 5,
      },
      {
        ...template,
        hunkKey: 'hunk_unreviewable',
        file: 'assets/logo.bin',
        verdict: COVERAGE_VERDICT.UNREVIEWABLE,
        added_lines: 0,
        removed_lines: 7,
      }
    );

    const base = briefReviewScope(fixture.source.floor);
    const scope = briefReviewScope(floor);
    expect(scope.files).toBe(base.files + 2);
    expect(scope.added).toBe(base.added + 40);
    expect(scope.removed).toBe(base.removed + 12);
  });

  it('counts each file once however many hunks it carries', async () => {
    const fixture = await buildWatchReviewFixture('no-narrative');
    const scope = briefReviewScope(fixture.source.floor);
    const distinct = new Set(fixture.source.floor.coverage.items.map((item) => item.file));
    expect(scope.files).toBe(distinct.size);
    expect(scope.files).toBeLessThanOrEqual(fixture.source.floor.coverage.items.length);
  });
});

describe('briefCoveragePercent', () => {
  it('is null when there is nothing reviewable to match against', async () => {
    const fixture = await buildWatchReviewFixture('no-narrative');
    const floor = structuredClone(fixture.source.floor) as Floor;
    floor.coverage.summary = { ...floor.coverage.summary, reviewable_rows: 0, matched_rows: 0 };
    expect(briefCoveragePercent(floor)).toBeNull();
  });

  it('rounds the matched share of reviewable rows', async () => {
    const fixture = await buildWatchReviewFixture('no-narrative');
    const floor = structuredClone(fixture.source.floor) as Floor;
    floor.coverage.summary = { ...floor.coverage.summary, reviewable_rows: 8, matched_rows: 3 };
    expect(briefCoveragePercent(floor)).toBe(38);
  });
});

describe('briefPlanStatus', () => {
  it('reports claimed over total, and nothing at all on an empty plan', async () => {
    const fixture = await buildWatchReviewFixture('no-narrative');
    const floor = structuredClone(fixture.source.floor) as Floor;
    const step = floor.plan_coverage[0]!;
    floor.plan_coverage = [
      { ...step, step_id: 'step-a', unclaimed: false },
      { ...step, step_id: 'step-b', unclaimed: true },
      { ...step, step_id: 'step-c', unclaimed: false },
    ];
    expect(briefPlanStatus(floor)).toEqual({ claimed: 2, total: 3 });

    expect(briefPlanStatus({ ...floor, plan_coverage: [] })).toBeNull();
  });
});

describe('briefUncertaintyStates', () => {
  it('enumerates all three ledger states rather than a pair', async () => {
    const fixture = await buildWatchReviewFixture('uncertainty-floor-only');
    const floor = fixture.source.floor;
    const ids = floor.citations
      .filter((citation) => citation.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY)
      .map((citation) => citation.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    const states = new Map<string, UncertaintyState>([
      [ids[0]!, UNCERTAINTY_STATE.ACKNOWLEDGED],
      [ids[1]!, UNCERTAINTY_STATE.RESOLVED],
    ]);
    const counts = briefUncertaintyStates(floor, states);

    // ACKNOWLEDGED is a state of its own: it is neither open nor resolved, so a
    // two-number summary would have to fold it into one side and be wrong.
    expect(counts.total).toBe(ids.length);
    expect(counts.acknowledged).toBe(1);
    expect(counts.resolved).toBe(1);
    expect(counts.open).toBe(ids.length - 2);
    expect(counts.open + counts.acknowledged + counts.resolved).toBe(counts.total);
  });

  it('treats a citation the ledger has never seen as open', async () => {
    const fixture = await buildWatchReviewFixture('uncertainty-floor-only');
    const counts = briefUncertaintyStates(fixture.source.floor, new Map());
    expect(counts.open).toBe(counts.total);
    expect(counts.acknowledged).toBe(0);
    expect(counts.resolved).toBe(0);
  });

  it('ignores a stale ledger entry for a citation the floor no longer carries', async () => {
    const fixture = await buildWatchReviewFixture('uncertainty-floor-only');
    const floor = fixture.source.floor;
    const live = briefUncertaintyStates(floor, new Map());
    // The ledger is append-only, so it retains dispositions for citations a
    // re-floor removed. Counting its values would report work that is no longer
    // part of this review at all.
    const withGhost = briefUncertaintyStates(
      floor,
      new Map<string, UncertaintyState>([
        ['cite:removed:cp9:uncertainty:0', UNCERTAINTY_STATE.RESOLVED],
      ])
    );
    expect(withGhost).toEqual(live);
  });
});

describe('briefOutcomeSummary', () => {
  it('renders only recorded outcomes, and nothing when there are none', () => {
    expect(briefOutcomeSummary({})).toBeNull();
    expect(briefOutcomeSummary({ DECIDED: 0, DEFERRED: 0 })).toBeNull();
    expect(briefOutcomeSummary({ DECIDED: 1, ACCEPTED_RISK: 2, DEFERRED: 0 })).toBe(
      'decided 1 · accepted risk 2'
    );
  });
});

describe('coverageTone', () => {
  it('reads high as healthy, a large remainder as warning, mostly-unmatched as a problem', () => {
    expect(coverageTone(100)).toBe('positive');
    expect(coverageTone(90)).toBe('positive');
    expect(coverageTone(89)).toBe('attention');
    expect(coverageTone(60)).toBe('attention');
    expect(coverageTone(59)).toBe('danger');
    expect(coverageTone(0)).toBe('danger');
  });
});

describe('uncertaintySegments', () => {
  it('fills the whole bar and tracks the counts', () => {
    const seg = uncertaintySegments(15, 1, 0, 8);
    expect(seg.open + seg.acknowledged + seg.resolved).toBe(8);
    expect(seg.open).toBeGreaterThan(seg.acknowledged);
    expect(seg.resolved).toBe(0);
  });

  it('apportions proportionally so segment widths match the counts', () => {
    expect(uncertaintySegments(1, 1, 2, 8)).toEqual({ open: 2, acknowledged: 2, resolved: 4 });
  });

  it('is empty when nothing is uncertain or the bar has no width', () => {
    expect(uncertaintySegments(0, 0, 0, 8)).toEqual({ open: 0, acknowledged: 0, resolved: 0 });
    expect(uncertaintySegments(1, 2, 3, 0)).toEqual({ open: 0, acknowledged: 0, resolved: 0 });
  });
});
