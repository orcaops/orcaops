import { describe, expect, it } from 'vitest';

import { replayReviewLedgerV2, type ReviewLifecycleLedger } from '@orcaops/review-core';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
} from '@orcaops/review-engine';

import { buildDeterministicReader, buildStoryReader } from './readerModel';
import {
  activateReaderDestination,
  activateReaderRailItem,
  dispatchReaderReviewKey,
  initialReviewControllerState,
  synchronizeRailToTarget,
  unavailableEvidenceNotice,
} from './readerReviewController';
import {
  buildStoryReviewHarnessAnchors,
  buildStoryReviewHarnessFixture,
} from '../../../tests/review/storyReviewHarness';

const OPEN_LIFECYCLE: ReviewLifecycleLedger = {
  state: 'OPEN',
  stale: false,
  current: null,
  history: [],
};

async function readers(withAnchors = false) {
  const fixture = buildStoryReviewHarnessFixture();
  const eligibleTargets = await buildEligibleNarrativeTargets(fixture.floor, fixture.reviewDiff);
  const currentThreads = await buildCurrentThreadManifests(fixture.floor, eligibleTargets);
  const currentGapRows = await buildCurrentGapRows(fixture.floor, fixture.reviewDiff);
  const ledger = await replayReviewLedgerV2({ events: [], currentThreads });
  const finishFacts = { targets: { ok: true } as const, currentGapRows, comments: [] };
  return {
    story: buildStoryReader({
      floor: fixture.floor,
      model: fixture.model,
      reviewDiff: fixture.reviewDiff,
      semanticAnchors: withAnchors ? buildStoryReviewHarnessAnchors(fixture) : null,
      eligibleTargets,
      ledger,
      currentThreads,
      finishFacts,
    }),
    // The same model resolved STALE: its floor hash no longer names the loaded
    // floor, which is the read-only projection the resolver retains.
    stale: buildStoryReader({
      floor: fixture.floor,
      model: { ...fixture.model, floor_input_hash: 'floor-that-moved' },
      reviewDiff: fixture.reviewDiff,
      semanticAnchors: withAnchors ? buildStoryReviewHarnessAnchors(fixture) : null,
      eligibleTargets,
      ledger,
      currentThreads,
      finishFacts,
      staleProjection: true,
    }),
    floor: buildDeterministicReader({
      floor: fixture.floor,
      eligibleTargets,
      ledger,
      currentThreads,
      finishFacts,
    }),
  };
}

describe('reader-driven review controller', () => {
  it('routes Brief, keyboard, and pointer through the same Story destination', async () => {
    const { story } = await readers();
    const pageRow = story.routeIndex.briefRows.find(
      (row) => row.kind === 'page' && row.id === 'page:P1'
    );
    expect(pageRow).toBeDefined();

    const fromBrief = activateReaderDestination(
      initialReviewControllerState(),
      story,
      pageRow!.destination
    );
    expect(fromBrief).toMatchObject({
      screen: 'walk',
      readerPage: 0,
      activeAct: 0,
      activePart: 0,
      diffHunkKey: 'hunk_story_owned_p1',
    });

    const pointer = activateReaderRailItem(
      { ...fromBrief, focus: 'rail', activeItem: 0 },
      story,
      0
    );
    const keyboard = dispatchReaderReviewKey(
      { ...fromBrief, focus: 'rail', activeItem: 0 },
      { name: 'enter', sequence: '\r' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    ).state;
    expect(keyboard).toMatchObject({
      readerPage: pointer.readerPage,
      diffHunkKey: pointer.diffHunkKey,
      activeItem: pointer.activeItem,
    });
  });

  it('routes m to ambiguity inspection without conflating it with row coverage', async () => {
    const { story } = await readers();
    const base = {
      ...initialReviewControllerState(),
      screen: 'walk' as const,
      focus: 'diff' as const,
      readerPage: 0,
    };
    const ambiguity = dispatchReaderReviewKey(
      { ...base, diffHunkKey: 'hunk_story_same_part' },
      { name: 'm', sequence: 'm' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    );
    expect(ambiguity.command).toEqual({ kind: 'mark-inspected' });

    const coverage = dispatchReaderReviewKey(
      { ...base, diffHunkKey: 'hunk_story_owned_p1' },
      { name: 'm', sequence: 'm' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    );
    expect(coverage.command).toEqual({ kind: 'mark-reviewed' });
  });

  it('resolves no command for the residue m under a stale Story', async () => {
    const { story, stale } = await readers();
    const residue = {
      ...initialReviewControllerState(),
      screen: 'unassigned' as const,
      preferredLens: 'story' as const,
    };
    // Live first: the gesture DOES resolve when the projection is current, so
    // the stale assertion below is about suppression, not about a dead binding.
    const live = dispatchReaderReviewKey(
      residue,
      { name: 'm', sequence: 'm' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    );
    expect(live.command).toEqual({ kind: 'mark-inspected' });
    expect(live.consumed).toBe(true);

    // Stale: `commandForGesture` finds nothing, so the key never reaches the
    // executor that would have refused it.
    const suppressed = dispatchReaderReviewKey(
      residue,
      { name: 'm', sequence: 'm' },
      { reader: stale, lifecycle: OPEN_LIFECYCLE },
      0
    );
    expect(suppressed.command).toEqual({ kind: 'none' });
    expect(suppressed.consumed).toBe(false);
    expect(suppressed.state).toEqual(residue);
  });

  it('routes exact anchor rows, cycles locations, and reverse-syncs without overlap jitter', async () => {
    const { story } = await readers(true);
    const page = story.pages[0]!;
    expect(page.kind).toBe('part');
    const acceptedItem =
      page.kind === 'part'
        ? page.railItems.findIndex(
            (item) => item.text === 'Route Story code through deterministic diff primitives.'
          )
        : -1;
    const planItem =
      page.kind === 'part'
        ? page.railItems.findIndex(
            (item) => item.text === 'Use one shared shell for both review lenses.'
          )
        : -1;
    const rejectedItem =
      page.kind === 'part'
        ? page.railItems.findIndex(
            (item) => item.text === 'The context-only contract remains open.'
          )
        : -1;
    const base = {
      ...initialReviewControllerState(),
      screen: 'walk' as const,
      preferredLens: 'story' as const,
      focus: 'rail' as const,
      readerPage: 0,
    };

    const accepted = activateReaderRailItem(base, story, acceptedItem);
    expect(accepted).toMatchObject({
      readerPage: 0,
      diffHunkKey: 'hunk_story_owned_p1',
      diffGrain: 'row',
      diffRowCursor: 1,
    });
    const stillAccepted = synchronizeRailToTarget(accepted, story, {
      pageKey: 'P1',
      hunkKey: 'hunk_story_owned_p1',
      row: { side: 'add', line: 2 },
    });
    expect(stillAccepted.activeStoryItemId).toBe(accepted.activeStoryItemId);

    const plan = activateReaderRailItem(base, story, planItem);
    const cycled = dispatchReaderReviewKey(
      plan,
      { name: ')', sequence: ')' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    ).state;
    expect(cycled).toMatchObject({
      readerPage: 2,
      diffHunkKey: 'hunk_story_owned_p3',
      activeTarget: 1,
    });

    const rejected = activateReaderRailItem(base, story, rejectedItem);
    expect(rejected).toMatchObject({
      readerPage: 0,
      diffHunkKey: 'hunk_story_owned_p1',
      diffRowCursor: 0,
      notice: 'Requested focus was rejected: FOCUS_RANGE_INVALID',
    });
  });

  it('keeps context-only Parts unmarkable while retaining their page identity', async () => {
    const { story } = await readers();
    const state = {
      ...initialReviewControllerState(),
      screen: 'walk' as const,
      readerPage: story.routeIndex.pageIndexByKey.get('P2')!,
    };
    const dispatched = dispatchReaderReviewKey(
      state,
      { name: 'm', sequence: 'm' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    );
    expect(dispatched.command).toEqual({ kind: 'none' });
    expect(dispatched.state.notice).toBe('Mark reviewed is blocked');
  });

  it('discloses a foreign-only floor fallback and keeps cycling the canonical Story item', async () => {
    const { story, floor } = await readers(true);
    const sourcePlacements = [...story.routeIndex.semanticPlacementsByItemId.values()].find(
      (placements) => placements.length === 2
    )!;
    const sourcePlacement = sourcePlacements[1]!;
    const placement = {
      ...sourcePlacement,
      id: 'foreign-only-placement',
      destination: {
        kind: 'deterministic-page' as const,
        pageIndex: 0,
        pageKey: floor.pages[0]!.key,
        hunkKey: floor.pages[0]!.sliceStops[0]!.hunkKey,
        sliceKey: floor.pages[0]!.sliceStops[0]!.sliceKey,
      },
    };
    const firstPlacement = sourcePlacements[0]!;
    if (firstPlacement.destination.kind !== 'page') {
      throw new Error('fixture expected the first related target on a Story Part');
    }
    const reader = {
      ...story,
      routeIndex: {
        ...story.routeIndex,
        destinationsByItemId: new Map(story.routeIndex.destinationsByItemId).set(placement.itemId, [
          {
            ...firstPlacement.destination,
            semanticPlacementId: firstPlacement.id,
          },
          {
            ...placement.destination,
            semanticPlacementId: placement.id,
          },
        ]),
        semanticPlacementsByItemId: new Map(story.routeIndex.semanticPlacementsByItemId).set(
          placement.itemId,
          [firstPlacement, placement]
        ),
        semanticPlacementById: new Map(story.routeIndex.semanticPlacementById).set(
          placement.id,
          placement
        ),
      },
    };
    const routed = activateReaderDestination(initialReviewControllerState(), reader, {
      ...placement.destination,
      semanticPlacementId: placement.id,
    });

    expect(routed).toMatchObject({
      preferredLens: 'deterministic',
      screen: 'floor-diff',
      readerPage: 0,
      activeStoryItemId: placement.itemId,
      notice: 'Opened the deterministic floor because this target is foreign to every Story Part',
    });

    const backInStory = dispatchReaderReviewKey(
      routed,
      { name: '(', sequence: '(' },
      { reader, lifecycle: OPEN_LIFECYCLE },
      0
    ).state;
    expect(backInStory).toMatchObject({
      preferredLens: 'story',
      screen: 'walk',
      readerPage: firstPlacement.destination.pageIndex,
      activeStoryItemId: placement.itemId,
      activeTarget: 0,
    });

    const backOnFloor = dispatchReaderReviewKey(
      backInStory,
      { name: ')', sequence: ')' },
      { reader, lifecycle: OPEN_LIFECYCLE },
      0
    ).state;
    expect(backOnFloor).toMatchObject({
      preferredLens: 'deterministic',
      screen: 'floor-diff',
      activeStoryItemId: placement.itemId,
      activeTarget: 1,
    });
  });

  it('uses the same dispatcher for deterministic checkpoint coverage', async () => {
    const { floor } = await readers();
    const dispatched = dispatchReaderReviewKey(
      {
        ...initialReviewControllerState(),
        screen: 'floor-diff',
        readerPage: 0,
      },
      { name: 'm', sequence: 'm' },
      { reader: floor, lifecycle: OPEN_LIFECYCLE },
      0
    );
    expect(dispatched.command).toEqual({ kind: 'mark-reviewed' });
  });

  it('opens Parts focused on the diff and keeps rail j/k passive', async () => {
    const { story } = await readers();
    const pageRow = story.routeIndex.briefRows.find(
      (row) => row.kind === 'page' && row.id === 'page:P1'
    );
    const opened = activateReaderDestination(
      initialReviewControllerState(),
      story,
      pageRow!.destination
    );
    // Parts open on the code, exactly like checkpoints.
    expect(opened).toMatchObject({ screen: 'walk', focus: 'diff' });

    // On the rail, j moves ONLY the passive cursor: no route, no activation.
    const onRail = { ...opened, focus: 'rail' as const };
    const moved = dispatchReaderReviewKey(
      onRail,
      { name: 'j', sequence: 'j' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    );
    expect(moved.command).toEqual({ kind: 'none' });
    expect(moved.state.activeItem).toBe(onRail.activeItem + 1);
    expect(moved.state.activeStoryItemId).toBe(onRail.activeStoryItemId);
    expect(moved.state.diffHunkKey).toBe(onRail.diffHunkKey);
    expect(moved.state.readerPage).toBe(onRail.readerPage);

    // Boundary: k at the first item stays put with a notice.
    const boundary = dispatchReaderReviewKey(
      onRail,
      { name: 'k', sequence: 'k' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    );
    expect(boundary.state.activeItem).toBe(0);
    expect(boundary.state.notice).toBe('First context item');
  });

  it('Enter activates a newly selected rail item at its FIRST target', async () => {
    const { story } = await readers();
    const pageRow = story.routeIndex.briefRows.find(
      (row) => row.kind === 'page' && row.id === 'page:P1'
    );
    const opened = activateReaderDestination(
      initialReviewControllerState(),
      story,
      pageRow!.destination
    );
    // Simulate a stale activeTarget left by a previously activated item.
    const onRail = {
      ...opened,
      focus: 'rail' as const,
      activeItem: 1,
      activeTarget: 1,
      activeStoryItemId: null,
    };
    const entered = dispatchReaderReviewKey(
      onRail,
      { name: 'return', sequence: '\r' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    );
    // A different item than the last activated one starts at target 0.
    expect(entered.state.activeTarget).toBe(0);
    expect(entered.state.activeStoryItemId).not.toBeNull();
  });

  it('left-arrow moves focus toward the physically-left rail on BOTH diff screens', async () => {
    const { story, floor } = await readers();
    const walkLeft = dispatchReaderReviewKey(
      { ...initialReviewControllerState(), screen: 'walk', focus: 'diff' },
      { name: 'left', sequence: '\u001b[D' },
      { reader: story, lifecycle: OPEN_LIFECYCLE },
      0
    );
    expect(walkLeft.state.focus).toBe('rail');

    const floorLeft = dispatchReaderReviewKey(
      { ...initialReviewControllerState(), screen: 'floor-diff', focus: 'diff' },
      { name: 'left', sequence: '\u001b[D' },
      { reader: floor, lifecycle: OPEN_LIFECYCLE, contextItemCount: 2 },
      0
    );
    expect(floorLeft.state.focus).toBe('rail');
  });

  it('blames the stale projection only for hunks a Part actually authored', async () => {
    const { story, stale } = await readers();
    const GENERIC = 'Selected evidence is not represented on any review page';

    // Authored by P1 as an owned segment, on a stale projection: the exact-match
    // join is what failed, and saying so is the whole point of the message.
    const dropped = unavailableEvidenceNotice(stale, 'hunk_story_owned_p1');
    expect(dropped).toContain('stale Story projection');
    // The Part rail's phrase, reused rather than paraphrased.
    expect(dropped).toMatch(/^Code mapping unavailable · /);
    // An in-Part ambiguous hunk is a mapping too — it becomes a cursor stop.
    expect(unavailableEvidenceNotice(stale, 'hunk_story_same_part')).toBe(dropped);

    // Residue was NEVER a Part mapping. It reaches no Story page whether every
    // mapping survived or none did, so the projection did not drop it and must
    // not be blamed.
    for (const residue of ['hunk_story_contested', 'hunk_story_gap', 'hunk_story_unowned']) {
      expect(unavailableEvidenceNotice(stale, residue)).toBe(GENERIC);
    }

    // A current reader is never degraded, whatever the hunk is.
    expect(unavailableEvidenceNotice(story, 'hunk_story_owned_p1')).toBe(GENERIC);
    expect(unavailableEvidenceNotice(story, 'hunk_story_contested')).toBe(GENERIC);
    // No reader at all, and a hunk no model mentions.
    expect(unavailableEvidenceNotice(null, 'hunk_story_owned_p1')).toBe(GENERIC);
    expect(unavailableEvidenceNotice(stale, 'hunk_that_does_not_exist')).toBe(GENERIC);
  });
});
