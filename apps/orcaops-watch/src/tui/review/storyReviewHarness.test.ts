import { describe, expect, it } from 'vitest';

import { parseStoryReviewModel } from '@orcaops/review-engine';

import {
  buildCodeOnlyStoryReviewHarnessFixture,
  buildProductionStoryReviewHarnessFixture,
  buildStoryReviewHarnessFixture,
  PRODUCTION_STORY_HARNESS_SHAPE,
  STORY_HARNESS_SHAPE,
  storyOverlay,
} from '../../../tests/review/storyReviewHarness';

describe('Story review harness fixtures', () => {
  it('pins the authored and obligation fields the shared shell must not drop', () => {
    const { floor, model } = buildStoryReviewHarnessFixture();

    expect(model.acts).toHaveLength(STORY_HARNESS_SHAPE.acts);
    expect(model.parts).toHaveLength(STORY_HARNESS_SHAPE.parts);
    expect(model.overview?.text).toContain('routed review experience');
    expect(model.parts.map((part) => part.title)).toEqual([
      'Route the Story through shared primitives',
      'Preserve captured context',
      'Prove bounded review behavior',
    ]);

    const contextOnly = model.parts.find((part) => part.id === 'P2');
    expect(contextOnly).toMatchObject({
      contextOnly: true,
      changedRows: 0,
      segments: [],
    });
    expect(model.uncertainties).toContainEqual(
      expect.objectContaining({ partId: 'P2', state: 'UNADJUDICATED' })
    );
    expect(model.questions).toContainEqual(
      expect.objectContaining({ id: 'question:required-global', file: null, required: true })
    );
    expect(model.findings).toContainEqual(
      expect.objectContaining({ id: 'finding:required-global', required: true })
    );

    expect(model.parts.find((part) => part.id === 'P1')?.ambiguous).toContainEqual(
      expect.objectContaining({ hunkKey: 'hunk_story_same_part' })
    );
    expect(model.residue.contested).toContainEqual(
      expect.objectContaining({ hunkKey: 'hunk_story_contested', partIds: ['P1', 'P3'] })
    );
    expect(model.residue.unattributed.map((entry) => entry.kind).sort()).toEqual([
      'ambiguous_no_part',
      'gap',
      'unowned',
    ]);
    expect(model.residue).toMatchObject({
      reviewableRows: 5,
      files: ['src/ambiguous-residue.ts', 'src/gap.ts', 'src/unowned.ts'],
    });
    expect(model.metrics).toMatchObject({
      attributedRows: 4,
      ambiguousRows: 2,
      contestedRows: 3,
      unattributedRows: 5,
      contributingThreads: 2,
      contributingCheckpoints: 2,
    });
    expect(floor.coverage.summary).toMatchObject({
      matched_rows: 4,
      unexplained_rows: 3,
      ambiguous_rows: 7,
      reviewable_rows: 14,
    });
    expect(
      floor.coverage.items.find((item) => item.hunkKey === 'hunk_story_unowned')?.units
    ).toEqual([expect.objectContaining({ kind: 'gap_slice', owner: null, lines: 1 })]);
    expect(model.ledger.map((entry) => entry.attachment.kind).sort()).toEqual(['part', 'residue']);
  });

  it('keeps CODE_ONLY routable without fabricating Acts or Part ownership', () => {
    const { model } = buildCodeOnlyStoryReviewHarnessFixture();

    expect(model.label).toBe('CODE_ONLY');
    expect(model.overview).toBeNull();
    expect(model.acts).toEqual([]);
    expect(model.parts).toEqual([]);
    expect(model.residue.reviewableRows).toBeGreaterThan(0);
    expect(model.uncertainties.every((uncertainty) => uncertainty.partId === null)).toBe(true);
    expect(model.ledger.every((entry) => entry.attachment.kind === 'residue')).toBe(true);
  });

  it('separates Story content replacement from same-content run replacement', async () => {
    const fixture = buildStoryReviewHarnessFixture();
    const runA = await storyOverlay(fixture.model, {
      runId: 'run-a',
      installationToken: 'install-a',
    });
    const sameContentRun = await storyOverlay(fixture.model, {
      runId: 'run-a-prime',
      installationToken: 'install-a-prime',
    });
    const changedModel = parseStoryReviewModel({
      ...fixture.model,
      overview: {
        ...fixture.model.overview!,
        text: 'A different authored overview changes Story lifecycle content.',
      },
    });
    const runB = await storyOverlay(changedModel, {
      runId: 'run-b',
      installationToken: 'install-b',
    });

    expect(sameContentRun.generation).toBe(runA.generation);
    expect(sameContentRun.installationToken).not.toBe(runA.installationToken);
    expect(runB.generation).not.toBe(runA.generation);
  });

  it('matches the calibrated production topology and row totals', () => {
    const { floor, model, reviewDiff } = buildProductionStoryReviewHarnessFixture();
    const segments = model.parts.flatMap((part) => part.segments);
    const rows = segments.reduce((sum, segment) => sum + segment.lines, 0);
    const hunksByFile = new Map<string, number>();
    for (const item of floor.coverage.items) {
      hunksByFile.set(item.file, (hunksByFile.get(item.file) ?? 0) + 1);
    }

    expect(model.acts).toHaveLength(PRODUCTION_STORY_HARNESS_SHAPE.acts);
    expect(model.parts).toHaveLength(PRODUCTION_STORY_HARNESS_SHAPE.parts);
    expect(segments).toHaveLength(PRODUCTION_STORY_HARNESS_SHAPE.segments);
    expect(rows).toBe(PRODUCTION_STORY_HARNESS_SHAPE.reviewableRows);
    expect(floor.coverage.summary.reviewable_rows).toBe(
      PRODUCTION_STORY_HARNESS_SHAPE.reviewableRows
    );
    expect(Math.max(...segments.map((segment) => segment.lines))).toBe(
      PRODUCTION_STORY_HARNESS_SHAPE.tallHunkRows
    );
    expect([...hunksByFile.values()]).toHaveLength(PRODUCTION_STORY_HARNESS_SHAPE.parts);
    expect(Math.min(...hunksByFile.values())).toBeGreaterThan(200);
    expect(reviewDiff.match(/^diff --git /gm)).toHaveLength(PRODUCTION_STORY_HARNESS_SHAPE.parts);
    expect(reviewDiff).toContain('production row 6000');
  });
});
