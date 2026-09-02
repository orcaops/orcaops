import { describe, expect, it } from 'vitest';

import { replayReviewLedgerV2 } from '@orcaops/review-core';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
} from '@orcaops/review-engine';

import {
  briefDestinationIndexForKey,
  briefFinishRow,
  briefLeafBadges,
  briefLeafMetrics,
  buildBriefTree,
} from './briefTree';
import { buildFinishObligations } from './finishPresentation';
import { buildStoryReader, type ReaderModel, type ReaderPage } from './readerModel';
import {
  buildFixtureReader,
  buildWatchReviewFixture,
} from '../../../tests/review/reviewExperienceFixtures';
import { buildStoryReviewHarnessFixture } from '../../../tests/review/storyReviewHarness';

async function storyHarnessReader(): Promise<ReaderModel> {
  const fixture = buildStoryReviewHarnessFixture();
  const eligibleTargets = await buildEligibleNarrativeTargets(fixture.floor, fixture.reviewDiff);
  const currentThreads = await buildCurrentThreadManifests(fixture.floor, eligibleTargets);
  const currentGapRows = await buildCurrentGapRows(fixture.floor, fixture.reviewDiff);
  const ledger = await replayReviewLedgerV2({ events: [], currentThreads });
  return buildStoryReader({
    floor: fixture.floor,
    model: fixture.model,
    reviewDiff: fixture.reviewDiff,
    eligibleTargets,
    ledger,
    currentThreads,
    finishFacts: { targets: { ok: true }, currentGapRows, comments: [] },
  });
}

/**
 * `buildBriefTree` reads only the page identity/grouping fields plus the
 * unassigned/residue totals, so a stub carrying exactly those is what lets the
 * key-collision cases be constructed at all — no real floor can be made to mint
 * a checkpointKey and a partKey that collide.
 */
function stubReader(input: {
  lens: ReaderModel['lens'];
  pages: Array<Partial<ReaderPage> & Pick<ReaderPage, 'kind' | 'key'>>;
  unassignedTotal?: number;
}): ReaderModel {
  return {
    lens: input.lens,
    pages: input.pages.map((page) => ({
      label: page.key,
      complete: false,
      ownedRows: new Map(),
      threadKey: 'thread',
      threadTitle: 'Thread',
      actKey: 'act',
      actTitle: 'Act',
      ...page,
    })),
    unassigned: { total: input.unassignedTotal ?? 0 },
    auxiliaryPage: { kind: 'unassigned', sliceStops: [] },
  } as unknown as ReaderModel;
}

describe('buildBriefTree', () => {
  it('groups floor checkpoints under their thread and flattens only the leaves', async () => {
    const fixture = await buildWatchReviewFixture('two-checkpoints');
    const reader = buildFixtureReader(fixture);
    const tree = buildBriefTree(reader);

    expect(tree.lens).toBe('deterministic');
    expect(reader.pages.length).toBeGreaterThan(0);
    expect(tree.groups.length).toBeGreaterThan(0);

    // Every page is a destination, in page order, and the parents are not.
    const pageDestinations = tree.destinations.filter((entry) => entry.kind === 'page');
    expect(pageDestinations.map((entry) => entry.pageIndex)).toEqual(
      reader.pages.map((_page, index) => index)
    );
    const parentKeys = new Set(tree.groups.map((group) => group.key));
    for (const destination of tree.destinations) {
      expect(parentKeys.has(destination.key)).toBe(false);
    }
  });

  it('emits contiguous ascending leaf ranges whose rollups match the pages', async () => {
    const fixture = await buildWatchReviewFixture('two-checkpoints');
    const tree = buildBriefTree(buildFixtureReader(fixture));

    let expectedNext = 0;
    tree.groups.forEach((group, index) => {
      expect(group.order).toBe(index);
      expect(group.leafDestinationIndices.length).toBe(group.total);
      expect(group.complete).toBeLessThanOrEqual(group.total);
      expect(group.leafDestinationIndices[0]).toBe(expectedNext);
      for (const [offset, destinationIndex] of group.leafDestinationIndices.entries()) {
        expect(destinationIndex).toBe(group.leafDestinationIndices[0]! + offset);
      }
      expectedNext = group.leafDestinationIndices[group.leafDestinationIndices.length - 1]! + 1;
    });
    // The leaf ranges together cover exactly the page destinations.
    expect(expectedNext).toBe(tree.destinations.filter((entry) => entry.kind === 'page').length);
  });

  it('groups Parts under their Act on the story lens', async () => {
    const reader = await storyHarnessReader();
    const tree = buildBriefTree(reader);
    const model = reader.story!;

    expect(tree.lens).toBe('story');
    expect(tree.groups.map((group) => group.key)).toEqual(model.acts.map((act) => `act:${act.id}`));
    expect(tree.groups.map((group) => group.title)).toEqual(model.acts.map((act) => act.title));
    expect(tree.groups.map((group) => group.variant)).toEqual(model.acts.map(() => 'act'));
    // Act ordinals count only the Act spine, one-based, in order.
    expect(tree.groups.map((group) => group.actOrdinal)).toEqual(
      model.acts.map((_act, index) => index + 1)
    );
    for (const destination of tree.destinations) {
      if (destination.kind === 'page') expect(destination.key.startsWith('part:')).toBe(true);
    }
  });

  it('keeps a sole Part as its own leaf beneath its Act', async () => {
    const reader = await storyHarnessReader();
    const tree = buildBriefTree(reader);
    const soleAct = reader.story!.acts.find((act) => act.partIds.length === 1)!;
    const soleGroup = tree.groups.find((group) => group.key === `act:${soleAct.id}`)!;

    expect(soleGroup.leafDestinationIndices).toHaveLength(1);
    expect(briefDestinationIndexForKey(tree, `part:${soleAct.partIds[0]}`)).toBe(
      soleGroup.leafDestinationIndices[0]
    );
  });

  it('appends Unassigned only when unexplained work exists, and Finish always', async () => {
    const withUnassigned = buildBriefTree(
      buildFixtureReader(await buildWatchReviewFixture('unassigned-floor-only'))
    );
    const withoutUnassigned = buildBriefTree(
      buildFixtureReader(await buildWatchReviewFixture('complete-floor-only'))
    );

    expect(withUnassigned.destinations.map((entry) => entry.kind).slice(-2)).toEqual([
      'unassigned',
      'finish',
    ]);
    expect(withoutUnassigned.destinations.map((entry) => entry.kind)).not.toContain('unassigned');
    expect(withoutUnassigned.destinations[withoutUnassigned.destinations.length - 1]!.kind).toBe(
      'finish'
    );
  });

  it('namespaces destination keys so colliding page keys stay distinct', () => {
    const collidingCheckpoint = buildBriefTree(
      stubReader({ lens: 'deterministic', pages: [{ kind: 'checkpoint', key: 'shared' }] })
    );
    const collidingPart = buildBriefTree(
      stubReader({ lens: 'story', pages: [{ kind: 'part', key: 'shared' }] })
    );

    expect(collidingCheckpoint.destinations[0]!.key).toBe('checkpoint:shared');
    expect(collidingPart.destinations[0]!.key).toBe('part:shared');
    // A snapshot taken under one lens must not resolve against the other.
    expect(briefDestinationIndexForKey(collidingPart, 'checkpoint:shared')).toBeNull();
    expect(briefDestinationIndexForKey(collidingCheckpoint, 'part:shared')).toBeNull();
  });

  it('does not let a page keyed "unassigned" or "finish" shadow the peer destinations', () => {
    const tree = buildBriefTree(
      stubReader({
        lens: 'deterministic',
        pages: [
          { kind: 'checkpoint', key: 'unassigned' },
          { kind: 'checkpoint', key: 'finish' },
        ],
        unassignedTotal: 3,
      })
    );

    expect(tree.destinations.map((entry) => entry.key)).toEqual([
      'checkpoint:unassigned',
      'checkpoint:finish',
      'unassigned',
      'finish',
    ]);
    expect(briefDestinationIndexForKey(tree, 'unassigned')).toBe(2);
    expect(briefDestinationIndexForKey(tree, 'finish')).toBe(3);
  });

  it('opens a fresh group when a parent reappears, so leaf ranges stay contiguous', () => {
    const tree = buildBriefTree(
      stubReader({
        lens: 'deterministic',
        pages: [
          { kind: 'checkpoint', key: 'a', threadKey: 't1', threadTitle: 'One' },
          { kind: 'checkpoint', key: 'b', threadKey: 't2', threadTitle: 'Two' },
          { kind: 'checkpoint', key: 'c', threadKey: 't1', threadTitle: 'One' },
        ],
      })
    );

    expect(tree.groups.map((group) => group.leafDestinationIndices)).toEqual([[0], [1], [2]]);
    expect(tree.groups.map((group) => group.order)).toEqual([0, 1, 2]);
  });

  it('resolves a missing or null key to null rather than to a neighbour', async () => {
    const tree = buildBriefTree(
      buildFixtureReader(await buildWatchReviewFixture('two-checkpoints'))
    );

    expect(briefDestinationIndexForKey(tree, null)).toBeNull();
    expect(briefDestinationIndexForKey(tree, 'checkpoint:gone')).toBeNull();
  });
});

describe('briefLeafMetrics', () => {
  it('counts added and removed rows and distinct files, deduplicating shared rows', () => {
    const page = {
      kind: 'checkpoint',
      key: 'cp',
      ownedRows: new Map([
        [
          'threadA',
          [
            { file: 'src/a.ts', side: 'add', lineHash: 'h1', line: 1 },
            { file: 'src/a.ts', side: 'delete', lineHash: 'h2', line: 2 },
            { file: 'src/b.ts', side: 'add', lineHash: 'h3', line: 3 },
          ],
        ],
        // The same row reached through a second owning thread is one row.
        ['threadB', [{ file: 'src/a.ts', side: 'add', lineHash: 'h1', line: 1 }]],
      ]),
    } as unknown as ReaderPage;

    expect(briefLeafMetrics(page)).toEqual({ added: 2, removed: 1, files: 2 });
  });

  it('reports zeroes for a page that owns no rows', () => {
    const page = { kind: 'checkpoint', key: 'cp', ownedRows: new Map() } as unknown as ReaderPage;
    expect(briefLeafMetrics(page)).toEqual({ added: 0, removed: 0, files: 0 });
  });

  it('matches the fixture pages it describes', async () => {
    const fixture = await buildWatchReviewFixture('two-checkpoints');
    const reader = buildFixtureReader(fixture);
    for (const page of reader.pages) {
      const metrics = briefLeafMetrics(page);
      expect(metrics.added + metrics.removed).toBeLessThanOrEqual(page.rowCount);
      if (page.rowCount > 0) expect(metrics.files).toBeGreaterThan(0);
    }
  });
});

describe('briefLeafBadges', () => {
  const page = (blockers: string[]): ReaderPage => ({ blockers }) as unknown as ReaderPage;

  it('marks only the blockers a reviewer can act on', () => {
    expect(briefLeafBadges(page(['uncertainties']))).toBe('⚑');
    expect(briefLeafBadges(page(['comments', 'uncertainties']))).toBe('✎⚑');
    expect(briefLeafBadges(page(['disclosures']))).toBe('!');
  });

  it('never badges `rows`, which every checkpoint of a fresh review carries', () => {
    // The leaf's own ✓/◐/○ glyph already says it is unread; badging `rows` would
    // print a literal `rows…` on every single line of the tree.
    expect(briefLeafBadges(page(['rows']))).toBeNull();
    expect(briefLeafBadges(page(['rows', 'items']))).toBeNull();
    expect(briefLeafBadges(page(['rows', 'uncertainties']))).toBe('⚑');
    expect(briefLeafBadges(page([]))).toBeNull();
  });
});

describe('briefFinishRow', () => {
  it('names each lifecycle state, reading only the canonical gate', () => {
    const blocked = { allowed: false, blockers: [{ kind: 'comments', open: 2 }] } as never;
    const open = { allowed: true, blockers: [] } as never;

    expect(briefFinishRow(undefined, open)).toMatchObject({
      glyph: '✓',
      label: 'Ready to finish complete',
      blocked: false,
    });
    expect(briefFinishRow({ state: 'OPEN' } as never, blocked)).toMatchObject({
      glyph: '◐',
      label: 'Finish partial or continue review',
      detail: '1 obligation(s) remain',
      blocked: true,
    });
    expect(briefFinishRow({ state: 'COMPLETE', stale: false } as never, open)).toMatchObject({
      glyph: '✓',
      label: 'Review finished complete',
      blocked: false,
    });
    expect(briefFinishRow({ state: 'PARTIAL', stale: true } as never, open)).toMatchObject({
      glyph: '◐',
      label: 'partial record is stale · reopen to reconcile',
      blocked: false,
    });
  });

  it('stays blocked while the canonical gate refuses, and names a routable obligation', async () => {
    // The Brief must show the GATE's answer, never a softer Story-side verdict:
    // `buildStoryReader` takes the canonical floor gate and only ADDS to it
    // (open required Story items become a `story_items` blocker), so an
    // unresolved floor uncertainty keeps Finish blocked no matter how complete
    // the Story reads — otherwise the Brief offers a Finish the transport is
    // going to reject.
    const fixture = buildStoryReviewHarnessFixture();
    const reader = await storyHarnessReader();

    expect(reader.finish.allowed).toBe(false);
    expect(reader.finish.blockers.map((blocker) => blocker.kind)).toContain('uncertainties');

    const row = briefFinishRow({ state: 'OPEN', stale: false } as never, reader.finish);
    expect(row).toMatchObject({
      glyph: '◐',
      label: 'Finish partial or continue review',
      detail: `${reader.finish.blockers.length} obligation(s) remain`,
      blocked: true,
    });

    // Activation cannot record COMPLETE: the executor reads this same gate and,
    // when it refuses, routes to an obligation instead — so there has to BE one.
    const obligations = buildFinishObligations({ floor: fixture.floor, reader });
    expect(obligations.length).toBeGreaterThan(0);
    expect(obligations.some((obligation) => obligation.kind === 'uncertainties')).toBe(true);
  });
});
