import { describe, expect, test } from 'bun:test';

import type { JournalEvent } from '@orcaops/review-core';

import { type MountedReviewApp, mountReviewApp } from '../../../tests/review/mountReviewApp';
import {
  buildReviewAppHarness,
  loadedReviewJournalHarness,
  loadedReviewWithStoryFixture,
} from '../../../tests/review/reviewAppHarness';
import {
  buildCodeOnlyStoryReviewHarnessFixture,
  buildStoryReviewHarnessAnchors,
  buildStoryReviewHarnessFixture,
  storyOverlay,
  type StoryReviewHarnessFixture,
} from '../../../tests/review/storyReviewHarness';

async function mountStory(
  input: {
    fixture?: StoryReviewHarnessFixture;
    controllerState?: Parameters<typeof mountReviewApp>[0]['controllerState'];
    initialEvents?: readonly JournalEvent[];
    height?: number;
    anchors?: boolean;
    onProjectionBuild?: Parameters<typeof mountReviewApp>[0]['onProjectionBuild'];
  } = {}
) {
  const fixture = input.fixture ?? buildStoryReviewHarnessFixture();
  const base = await buildReviewAppHarness({ scenario: 'no-narrative' });
  const routineStory = await storyOverlay(fixture.model, {
    runId: 'story-shared-shell',
    installationToken: 'story-shared-shell-install',
    anchors: input.anchors ? buildStoryReviewHarnessAnchors(fixture) : undefined,
  });
  const loaded = await loadedReviewWithStoryFixture({
    base: base.loaded,
    floor: fixture.floor,
    reviewDiff: fixture.reviewDiff,
    routineStory,
  });
  const journal = await loadedReviewJournalHarness(loaded, input.initialEvents);
  const app = await mountReviewApp({
    scenario: 'no-narrative',
    width: 160,
    height: input.height ?? 52,
    controllerState: input.controllerState,
    initialLoadedOverride: journal.loaded,
    journalEffects: journal.journalEffects,
    onProjectionBuild: input.onProjectionBuild,
  });
  return { app, fixture, routineStory, journal };
}

async function clickSurface(app: MountedReviewApp, id: string): Promise<void> {
  const rect = app.surfaceRect(id);
  expect(rect.height, `${id} is not mounted`).toBeGreaterThan(0);
  await app.mockMouse.click(rect.x + 1, rect.y);
  await app.settle();
}

describe('routine Story through the shared reader shell', () => {
  test('Brief and routed rails give every v4 field a visible surface', async () => {
    const { app } = await mountStory();
    const brief = app.frame();

    // The ownership label is the Story's headline vital; the banner is its
    // trust statement, carried on the overview's Story row.
    expect(brief).toContain('OWNERSHIP');
    expect(brief).toContain('derived');
    expect(brief).toContain('Capture-backed Story ownership');
    expect(brief).toContain('The branch replaces a stacked Story document');
    // The v4 metrics surface as the Attribution and Sources rows.
    expect(brief).toContain('29% attributed · 2 ambiguous · 3 contested · 5 unattributed');
    expect(brief).toContain('2 thread(s) · 2 checkpoint(s) · 1 overview citation(s)');
    expect(brief).toContain('The old fork mounts every Part at once.');
    expect(brief).toContain('Does the shared reader preserve the review lifecycle?');
    // Acts head the tree; their interpretations belong to the routed Walk.
    expect(brief).toContain('Build the shared reader');
    expect(brief).toContain('Route the Story through shared primitives');
    expect(brief).toContain('Preserve captured context');
    expect(brief).toContain('Verify the review path');
    expect(brief).toContain('Prove bounded review behavior');
    expect(brief).toContain('Residue');
    expect(brief).toContain('Finish');
    expect(brief).not.toContain('hunk_story_owned_p1 row 1');

    // The pointer and keyboard paths both resolve through the same tree leaf.
    await clickSurface(app, 'review-brief-leaf-0');
    expect(app.state()).toMatchObject({
      screen: 'walk',
      readerPage: 0,
      diffHunkKey: 'hunk_story_owned_p1',
    });
    expect(app.frame()).toContain('Use the deterministic diff structure');
    expect(app.frame()).toContain('CHECKPOINT_DECISION');
    expect(app.frame()).toContain('The Part-local');

    await app.press('\u001b');
    expect(app.state().screen).toBe('brief');
    await app.press('\r');
    expect(app.state()).toMatchObject({
      screen: 'walk',
      readerPage: 0,
      diffHunkKey: 'hunk_story_owned_p1',
    });

    // Part navigation is the same bracket pager used by captured checkpoints,
    // including the Act boundary between P2 and P3.
    await app.press(']');
    expect(app.state().readerPage).toBe(1);
    expect(app.frame()).toContain('A context-only Part remains');
    expect(app.frame()).toContain('reviewable without fabricated rows.');
    expect(app.frame()).toContain('uncertainty · part-');
    await app.press(']');
    expect(app.state().readerPage).toBe(2);
    expect(app.frame()).toContain('Exercise the second code-owning Part');

    await app.press('\u001b');
    await clickSurface(app, 'review-brief-unassigned');
    expect(app.state().screen).toBe('unassigned');
    expect(app.frame()).toContain('Evidence not owned by one Story Part.');
    expect(app.frame()).toContain('OUTSTANDING · Residue remains');
    app.unmount();
  });

  test('anchored context renders inline, cycles real locations, and leaves unplaced prose readable', async () => {
    const { app } = await mountStory({
      anchors: true,
      controllerState: {
        screen: 'walk',
        readerPage: 0,
        preferredLens: 'story',
        focus: 'rail',
      },
    });
    await app.settleUntil((frame) => frame.includes('Route Story code through'));

    // Accepted focus lands on the second owned row and highlights only that
    // focused range; the compact rail keeps the body out of a permanent stack.
    await clickSurface(app, 'review-context-item-0');
    expect(app.state()).toMatchObject({
      screen: 'walk',
      readerPage: 0,
      diffHunkKey: 'hunk_story_owned_p1',
      diffGrain: 'row',
      diffRowCursor: 1,
      activeTarget: 0,
    });
    expect(app.frame()).toContain('focused rows');
    expect(app.frame()).toContain('Route Story code through deterministic diff primitives.');

    // The overview decision has two real targets. Existing location cycling
    // moves through the same route index and changes the Part/page with it.
    await clickSurface(app, 'review-context-item-3');
    expect(app.frame()).toContain('whole block');
    expect(app.frame()).toContain('1/2');
    await app.press(')');
    expect(app.state()).toMatchObject({
      readerPage: 2,
      diffHunkKey: 'hunk_story_owned_p3',
      activeTarget: 1,
    });
    expect(app.frame()).toContain('2/2');
    await app.press('(');
    expect(app.state()).toMatchObject({ readerPage: 0, activeTarget: 0 });

    // A rejected focus remains a truthful block link and visibly explains why
    // the narrower focus was not accepted.
    await clickSurface(app, 'review-context-item-4');
    expect(app.state()).toMatchObject({
      readerPage: 0,
      diffHunkKey: 'hunk_story_owned_p1',
      diffGrain: 'row',
      diffRowCursor: 0,
    });
    expect(app.frame()).toContain('block · FOCUS_RANGE_INVALID');
    expect(app.frame()).toContain('Requested focus was rejected');

    // Ordinary, non-anchor-eligible Part context has a full detail route but
    // never receives a synthesized code location.
    await clickSurface(app, 'review-context-item-1');
    expect(app.state().screen).toBe('captured-context');
    expect(app.frame()).toContain(
      'Retain ordinary source context without inventing a code anchor.'
    );
    expect(app.frame()).toContain('No code location was declared');
    app.unmount();
  });

  test('Flat Files returns to the owning Story Part instead of changing screen identity', async () => {
    const { app } = await mountStory({
      controllerState: {
        screen: 'walk',
        readerPage: 0,
        preferredLens: 'story',
        focus: 'diff',
      },
    });

    await app.press('F');
    expect(app.state().screen).toBe('flat-files');
    await app.press('\r');
    expect(app.state()).toMatchObject({
      screen: 'walk',
      preferredLens: 'story',
      readerPage: 0,
      focus: 'diff',
      diffHunkKey: 'hunk_story_owned_p1',
    });

    await app.press('j');
    expect(app.state()).toMatchObject({
      screen: 'walk',
      diffHunkKey: 'hunk_story_same_part',
    });
    app.unmount();
  });

  test('context-only and residue obligations use durable item and inspection identities', async () => {
    const { app, journal } = await mountStory();
    await clickSurface(app, 'review-brief-leaf-0');

    // Same-Part ambiguity is visible in the Part but is not row coverage.
    // Parts open focused on the diff, so j drives the code cursor directly.
    await app.press('j');
    expect(app.state().diffHunkKey).toBe('hunk_story_same_part');
    await app.press('m');
    await app.settleUntil((frame) => frame.includes('Part ambiguity inspected'));
    expect(journal.journalEvents.at(-1)).toMatchObject({
      type: 'unassigned',
      target: { kind: 'AMBIGUOUS_HUNK', hunkKey: 'hunk_story_same_part' },
    });

    await app.press(']');
    expect(app.state().readerPage).toBe(1);
    await app.press('m');
    expect(app.frame()).toContain('Mark reviewed is blocked');
    expect(journal.journalEvents.some((event) => event.type === 'review_coverage')).toBe(false);
    // A context-only Part has no code stops, so it opens rail-focused and the
    // disposition keys work directly.
    await app.press('r');
    await app.settleUntil(
      (frame) => frame.includes('RESOLVED') && frame.includes('context-only contract')
    );
    expect(journal.journalEvents.at(-1)).toMatchObject({
      type: 'uncertainty',
      citationId: 'cite:artifact-story-one:cp2:uncertainty:0',
      action: 'RESOLVE',
    });
    expect(app.frame()).toContain('✓ 0 changed row(s)');

    await app.press('\u001b');
    await clickSurface(app, 'review-brief-unassigned');
    await app.press('m');
    await app.settleUntil((frame) => frame.includes('Story residue inspected'));
    await app.press('j');
    await app.press('m');
    await app.pressAll(['j', 'j']);
    await app.press('m');

    const inspections = journal.journalEvents.filter((event) => event.type === 'unassigned');
    expect(inspections).toContainEqual(
      expect.objectContaining({
        target: { kind: 'AMBIGUOUS_HUNK', hunkKey: 'hunk_story_contested' },
      })
    );
    expect(inspections).toContainEqual(
      expect.objectContaining({ target: expect.objectContaining({ kind: 'GAP_ROWS' }) })
    );
    expect(inspections).toContainEqual(
      expect.objectContaining({
        target: { kind: 'AMBIGUOUS_HUNK', hunkKey: 'hunk_story_ambiguous_no_part' },
      })
    );
    app.unmount();
  });

  test('required global items block Finish and disposition by exact stable ids', async () => {
    const { app, journal } = await mountStory();
    await clickSurface(app, 'review-brief-finish');
    expect(app.frame()).toContain('Resolve Story review items');
    expect(app.frame()).toContain('2 item(s) remain');

    await app.press('\u001b');
    // Disposition happens where the queue lives: the Brief's attention pane.
    // The fresh selection defaults to the first row, so `r` resolves it; Tab
    // moves focus to the overview pane so `j` walks the queue, not the tree.
    await app.press('r');
    await app.settleUntil(
      (frame) => frame.includes('RESOLVED') && frame.includes('The old fork mounts')
    );
    await app.press('\t');
    await app.press('j');
    await app.press('a');
    await app.settleUntil(
      (frame) => frame.includes('ACKNOWLEDGED') && frame.includes('Does the shared reader')
    );

    expect(journal.journalEvents.slice(-2)).toEqual([
      expect.objectContaining({
        type: 'finding',
        findingKey: 'finding:required-global',
        action: 'RESOLVE',
      }),
      expect.objectContaining({
        type: 'prompt',
        promptKey: 'question:required-global',
        action: 'ACKNOWLEDGE',
      }),
    ]);

    await clickSurface(app, 'review-brief-finish');
    expect(app.frame()).not.toContain('Resolve Story review items');
    app.unmount();
  });

  test('lens switching preserves the physical slice and durable row coverage', async () => {
    const { app, journal } = await mountStory();
    await clickSurface(app, 'review-brief-leaf-0');
    const physical = {
      hunk: app.state().diffHunkKey,
      slice: app.state().diffSliceKey,
    };
    await app.press('tab');
    await app.press('m');
    await app.settleUntil((frame) => frame.includes('Part reviewed'));
    const coverage = journal.journalEvents.find((event) => event.type === 'review_coverage');
    expect(coverage).toBeDefined();

    await app.requestShell('captured-checkpoint-lens');
    expect(app.state()).toMatchObject({
      screen: 'floor-diff',
      diffHunkKey: physical.hunk,
      diffSliceKey: physical.slice,
      preferredLens: 'deterministic',
    });
    await app.requestShell('story-lens');
    expect(app.state()).toMatchObject({
      screen: 'walk',
      diffHunkKey: physical.hunk,
      diffSliceKey: physical.slice,
      preferredLens: 'story',
    });
    expect(journal.journalEvents.filter((event) => event.type === 'review_coverage')).toEqual([
      coverage!,
    ]);
    app.unmount();
  });

  test('reconciliation and render build one Story projection per immutable load', async () => {
    const builds: Array<{ lens: string; loaded: object }> = [];
    const { app, journal } = await mountStory({
      onProjectionBuild: (lens, loaded) => builds.push({ lens, loaded }),
    });
    await app.settle();
    await app.settle();

    expect(builds).toEqual([{ lens: 'story', loaded: journal.loaded }]);
    await app.requestShell('captured-checkpoint-lens');
    await app.requestShell('story-lens');
    expect(builds.filter((entry) => entry.lens === 'story')).toHaveLength(1);
    expect(builds.filter((entry) => entry.lens === 'deterministic')).toHaveLength(1);
    app.unmount();
  });

  test('Story lifecycle writes require the current Story route, while REOPEN does not', async () => {
    const story = await mountStory();
    await clickSurface(story.app, 'review-brief-finish');
    await story.app.press('p');
    await story.app.pressAll([...'Story obligations remain', '\u0013']);
    await story.app.settleUntil((frame) => frame.includes('Durable partial'));
    expect(story.journal.journalEvents.at(-1)).toMatchObject({
      type: 'review_lifecycle',
      action: 'PARTIAL',
      review_basis: 'STORY',
      story_generation: story.routineStory.generation,
    });
    story.app.unmount();

    const unreadFloor = await mountStory({
      controllerState: { screen: 'finish', preferredLens: 'deterministic' },
    });
    await unreadFloor.app.press('p');
    await unreadFloor.app.pressAll([...'Floor notes cannot claim Story', '\u0013']);
    await unreadFloor.app.settleUntil((frame) => frame.includes('Read the current Story Brief'));
    expect(unreadFloor.app.state()).toMatchObject({
      screen: 'brief',
      preferredLens: 'story',
    });
    expect(
      unreadFloor.journal.journalEvents.filter((event) => event.type === 'review_lifecycle')
    ).toHaveLength(0);
    unreadFloor.app.unmount();

    const switchedFloor = await mountStory();
    await switchedFloor.app.requestShell('captured-checkpoint-lens');
    await switchedFloor.app.pressAll(Array.from({ length: 12 }, () => 'j'));
    await switchedFloor.app.press('\r');
    expect(switchedFloor.app.state().screen).toBe('finish');
    await switchedFloor.app.press('p');
    await switchedFloor.app.pressAll([...'A floor route cannot finish the Story', '\u0013']);
    await switchedFloor.app.settleUntil((frame) => frame.includes('Read the current Story Brief'));
    expect(switchedFloor.app.state()).toMatchObject({
      screen: 'brief',
      preferredLens: 'story',
    });
    expect(
      switchedFloor.journal.journalEvents.filter((event) => event.type === 'review_lifecycle')
    ).toHaveLength(0);
    switchedFloor.app.unmount();

    const fixture = buildStoryReviewHarnessFixture();
    const base = await buildReviewAppHarness({ scenario: 'no-narrative' });
    const routineStory = await storyOverlay(fixture.model, {
      runId: 'story-reopen',
      installationToken: 'story-reopen-install',
    });
    const loaded = await loadedReviewWithStoryFixture({
      base: base.loaded,
      floor: fixture.floor,
      reviewDiff: fixture.reviewDiff,
      routineStory,
    });
    const completed: JournalEvent = {
      type: 'review_lifecycle',
      ts: '2026-07-23T12:00:00.000Z',
      action: 'COMPLETE',
      review_basis: 'STORY',
      floor_input_hash: fixture.floor.input_hash,
      story_generation: routineStory.generation,
      ledger_generation: loaded.ledger.ledgerGeneration,
      actor: 'REVIEWER',
      source: 'WATCH',
    };
    const reopenedJournal = await loadedReviewJournalHarness(loaded, [completed]);
    const reopened = await mountReviewApp({
      scenario: 'no-narrative',
      width: 160,
      height: 52,
      controllerState: { screen: 'finish', preferredLens: 'deterministic' },
      initialLoadedOverride: reopenedJournal.loaded,
      journalEffects: reopenedJournal.journalEffects,
    });
    await reopened.press('r');
    await reopened.settleUntil((frame) => frame.includes('Review reopened'));
    expect(reopenedJournal.journalEvents.at(-1)).toMatchObject({
      type: 'review_lifecycle',
      action: 'REOPEN',
      review_basis: 'STORY',
      story_generation: routineStory.generation,
    });
    reopened.unmount();
  });

  test('CODE_ONLY remains a Story Brief with forensic routes and no fabricated Acts', async () => {
    const { app } = await mountStory({
      fixture: buildCodeOnlyStoryReviewHarnessFixture(),
    });
    const frame = app.frame();
    expect(frame).toContain('OWNERSHIP');
    expect(frame).toContain('code only');
    expect(frame).toContain('Forensic code review without an authored account Story');
    expect(frame).toContain('Captured code · Story thread one');
    expect(frame).toContain('Residue');
    expect(frame).toContain('Finish');
    expect(frame).not.toContain('Build the shared reader');
    app.unmount();
  });

  test('an invalid current Story leaves the floor readable but fails lifecycle closed', async () => {
    const base = await buildReviewAppHarness({ scenario: 'complete-floor-only' });
    const issue = 'current Story model failed validation';
    const loaded = {
      ...base.loaded,
      data: {
        ...base.loaded.data,
        routineStory: {
          model: null,
          status: 'invalid' as const,
          issue,
          runId: 'invalid-story-run',
          generation: null,
          installationToken: 'invalid-story-install',
          anchors: {
            model: null,
            status: 'absent' as const,
            issue: null,
            generation: null,
          },
        },
      },
    };
    const journal = await loadedReviewJournalHarness(loaded);
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      width: 160,
      height: 52,
      controllerState: { screen: 'finish', preferredLens: 'deterministic' },
      initialLoadedOverride: journal.loaded,
      journalEffects: journal.journalEffects,
    });
    // The tall STORY banner is a Brief concern now; the finish screen keeps its
    // rows and reports the invalid Story only when a lifecycle action trips it.
    expect(app.frame()).not.toContain('STORY INVALID');
    expect(app.frame()).toContain('Reading the captured checkpoints');

    await app.press('p');
    await app.pressAll([...'Cannot finish through corrupt durable state', '\u0013']);
    await app.settleUntil((frame) => frame.includes(issue));
    expect(journal.journalEvents.filter((event) => event.type === 'review_lifecycle')).toHaveLength(
      0
    );
    app.unmount();
  });
});
