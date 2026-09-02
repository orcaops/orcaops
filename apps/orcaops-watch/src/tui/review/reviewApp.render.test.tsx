/**
 * Mounted-application render tests: the falsifiability floor for Task Review.
 *
 * Every assertion here reads the frame the real `ReviewApp` painted, after real
 * keys crossed the real `useKeyboard → dispatch → executeCommand → render` seam.
 *
 * The rule: assert the frame the real renderer painted, and assert layout as
 * GEOMETRY — what actually sits beside what. A hand-written mirror of the UI can
 * emit strings the product never does, and every assertion against it passes while
 * proving nothing about the screen a reviewer sees.
 *
 * Runs under `bun test` (see `test:render`): @opentui/core loads `bun:`-protocol
 * modules, which is why Vitest stubs it and cannot mount the real renderer.
 */
import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseStoryReviewModel } from '@orcaops/review-engine';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import {
  buildReviewAppHarness,
  loadedReviewWithStoryFixture,
  tallHarnessDiff,
} from '../../../tests/review/reviewAppHarness';
import {
  buildStoryReviewHarnessFixture,
  storyOverlay,
} from '../../../tests/review/storyReviewHarness';

const WIDTHS: number[] = [80, 110, 160];
const execFileAsync = promisify(execFile);

describe('authoritative live refresh', () => {
  test('an unchanged heartbeat probes without reloading any review layer', async () => {
    const current = await buildReviewAppHarness({ scenario: 'reader-parity' });
    let activeLoads = 0;
    let installedLoads = 0;
    let auxLoads = 0;
    const app = await mountReviewApp({
      scenario: 'reader-parity',
      autoLoad: true,
      liveRefreshThrottleMs: 0,
      reviewLoader: async () => {
        activeLoads += 1;
        return current.loaded.data;
      },
      installedReviewLoader: async () => {
        installedLoads += 1;
        return current.loaded.data;
      },
      reviewGenerationLoader: async () => ({
        bundle: 'bundle-1',
        story: null,
        storyInstallation: null,
        storyAnchors: null,
        journal: null,
        comments: null,
      }),
      reviewAuxLoader: async () => {
        auxLoads += 1;
        return {
          comments: current.loaded.comments,
        };
      },
    });
    await app.settleUntil((frame) => frame.includes('Freeze deterministic review truth'));
    expect(activeLoads).toBe(1);

    await app.liveRefresh();
    await app.settle();

    expect(activeLoads).toBe(1);
    expect(installedLoads).toBe(0);
    expect(auxLoads).toBe(1);
    app.unmount();
  });

  test('a comments generation change reloads live overlays but not the floor', async () => {
    const current = await buildReviewAppHarness({ scenario: 'reader-parity' });
    let commentsGeneration = 'comments-1';
    let installedLoads = 0;
    let auxLoads = 0;
    const app = await mountReviewApp({
      scenario: 'reader-parity',
      autoLoad: true,
      liveRefreshThrottleMs: 0,
      reviewLoader: async () => current.loaded.data,
      installedReviewLoader: async () => {
        installedLoads += 1;
        return current.loaded.data;
      },
      reviewGenerationLoader: async () => ({
        bundle: 'bundle-1',
        story: null,
        storyInstallation: null,
        storyAnchors: null,
        journal: null,
        comments: commentsGeneration,
      }),
      reviewAuxLoader: async () => {
        auxLoads += 1;
        return {
          comments: current.loaded.comments,
        };
      },
    });
    await app.settleUntil((frame) => frame.includes('Freeze deterministic review truth'));

    commentsGeneration = 'comments-2';
    await app.liveRefresh();
    await app.settle();

    expect(installedLoads).toBe(0);
    expect(auxLoads).toBe(2);
    app.unmount();
  });

  test('Story content and installation replacements both reload an open Watch', async () => {
    const base = await buildReviewAppHarness({ scenario: 'no-narrative' });
    const fixture = buildStoryReviewHarnessFixture();
    const storyA = await storyOverlay(fixture.model, {
      runId: 'story-run-a',
      installationToken: 'story-install-a',
    });
    const modelB = parseStoryReviewModel({
      ...fixture.model,
      overview: {
        ...fixture.model.overview!,
        text: 'The replacement Story is visible without rebuilding the floor.',
      },
    });
    const storyB = await storyOverlay(modelB, {
      runId: 'story-run-b',
      installationToken: 'story-install-b',
    });
    const sameContentRun = await storyOverlay(modelB, {
      runId: 'story-run-b-prime',
      installationToken: 'story-install-b-prime',
    });
    const storyLoaded = await loadedReviewWithStoryFixture({
      base: base.loaded,
      floor: fixture.floor,
      reviewDiff: fixture.reviewDiff,
      routineStory: storyA,
    });
    const dataFor = (routineStory: typeof storyA) => ({
      ...storyLoaded.data,
      routineStory,
    });
    let installedData = dataFor(storyB);
    let generation = {
      bundle: 'story-bundle',
      story: storyA.generation,
      storyInstallation: storyA.installationToken,
      storyAnchors: null as string | null,
      journal: null,
      comments: null,
    };
    const installedRuns: Array<string | null> = [];
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      autoLoad: true,
      liveRefreshThrottleMs: 0,
      reviewLoader: async () => dataFor(storyA),
      installedReviewLoader: async () => {
        installedRuns.push(installedData.routineStory.runId);
        return installedData;
      },
      reviewGenerationLoader: async () => generation,
      width: 160,
      height: 52,
    });
    // Substrings, because the What row truncates long overview prose to fit.
    await app.settleUntil((frame) => frame.includes('The branch replaces a stacked Story'));

    generation = {
      ...generation,
      story: storyB.generation,
      storyInstallation: storyB.installationToken,
      storyAnchors: null,
    };
    await app.liveRefresh();
    expect(
      await app.settleUntil((frame) => frame.includes('The replacement Story is visible'))
    ).toBeTrue();
    expect(app.frame()).not.toContain('The branch replaces a stacked Story');
    expect(app.state().screen).toBe('brief');
    expect(installedRuns).toEqual(['story-run-b']);

    installedData = dataFor(sameContentRun);
    generation = {
      ...generation,
      story: sameContentRun.generation,
      storyInstallation: sameContentRun.installationToken,
      storyAnchors: null,
    };
    await app.liveRefresh();
    await app.settle();

    expect(sameContentRun.generation).toBe(storyB.generation);
    expect(installedRuns).toEqual(['story-run-b', 'story-run-b-prime']);
    expect(app.frame()).toContain('The replacement Story is visible');

    const staleAnchors = {
      ...sameContentRun,
      anchors: {
        model: null,
        status: 'stale' as const,
        issue: 'The anchor generation belongs to an earlier finalized run.',
        generation: null,
      },
    };
    installedData = dataFor(staleAnchors);
    generation = {
      ...generation,
      storyAnchors: 'anchor-install-stale',
    };
    await app.liveRefresh();
    await app.settle();
    expect(installedRuns).toEqual(['story-run-b', 'story-run-b-prime', 'story-run-b-prime']);
    expect(app.frame()).toContain('ANCHORED CONTEXT STALE');
    expect(app.frame()).toContain('The replacement Story is visible');

    // The installation changed, but the validated Story content identity did
    // not. The existing read witness remains usable; it is not tied to run id.
    await app.pressAll(Array.from({ length: 12 }, () => 'j'));
    await app.press('\r');
    expect(app.state().screen).toBe('finish');
    await app.press('p');
    await app.pressAll([...'same Story content remains read', '\u0013']);
    await app.settleUntil((frame) => frame.includes('Durable partial'));
    expect(app.journalEvents.at(-1)).toMatchObject({
      type: 'review_lifecycle',
      action: 'PARTIAL',
      review_basis: 'STORY',
      story_generation: sameContentRun.generation,
    });
    app.unmount();
  });

  test('an installed legacy narrative never activates a Watch lens', async () => {
    const absent = await buildReviewAppHarness({ scenario: 'no-narrative' });
    const current = await buildReviewAppHarness({ scenario: 'reader-parity' });
    let data = absent.loaded.data;
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      autoLoad: true,
      reviewLoader: async () => data,
    });
    await app.settleUntil((frame) => frame.includes('CAPTURED WORK'));
    expect(app.frame()).toContain('CAPTURED WORK');

    data = current.loaded.data;
    await app.liveRefresh();
    await app.settle();
    expect(app.frame()).toContain('CAPTURED WORK');
    expect(app.frame()).not.toContain('Freeze deterministic review truth');
    app.unmount();
  });

  test('a same-lens immutable replacement reveals the reconciled page entry', async () => {
    const twoPages = await buildReviewAppHarness({ scenario: 'two-checkpoints' });
    const onePage = await buildReviewAppHarness({ scenario: 'no-narrative' });
    let bundleGeneration = 'bundle-1';
    let installedLoads = 0;
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
      height: 10,
      autoLoad: true,
      liveRefreshThrottleMs: 0,
      reviewLoader: async () => twoPages.loaded.data,
      installedReviewLoader: async () => {
        installedLoads += 1;
        return onePage.loaded.data;
      },
      reviewGenerationLoader: async () => ({
        bundle: bundleGeneration,
        story: null,
        storyInstallation: null,
        storyAnchors: null,
        journal: null,
        comments: null,
      }),
    });
    await app.settleUntil((frame) => frame.includes('Checkpoint 1/2'));
    await app.press(']');
    await app.press('G');
    expect(app.state().readerPage).toBe(1);
    expect(app.scrollTop()).toBeGreaterThan(0);

    bundleGeneration = 'bundle-2';
    await app.liveRefresh();
    await app.settleUntil((frame) => frame.includes('Checkpoint 1/1'));

    expect(installedLoads).toBe(1);
    expect(app.state().readerPage).toBe(0);
    expect(app.state().diffSliceKey).toBe('hunk_fixture_second:s0');
    expect(app.frame()).toContain('second fixture hunk');
    expect(app.scrollTop()).toBeLessThan(app.scrollBounds().content - app.scrollBounds().viewport);
    app.unmount();
  });

  test('a same-path bundle replacement drops old expanded source and fetches the new pin', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'orcaops-review-source-refresh-'));
    const git = async (args: readonly string[]): Promise<string> => {
      const { stdout } = await execFileAsync('git', [...args], {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'review-source-refresh-test',
          GIT_AUTHOR_EMAIL: 'test@local',
          GIT_COMMITTER_NAME: 'review-source-refresh-test',
          GIT_COMMITTER_EMAIL: 'test@local',
        },
      });
      return String(stdout).trim();
    };
    const sourceText = (sentinel: string) =>
      [
        'stable fixture row',
        ...Array.from({ length: 9 }, (_, index) => `${sentinel} context ${index + 2}`),
        'second fixture hunk',
      ].join('\n');
    const pin = async (sentinel: string, message: string): Promise<void> => {
      await writeFile(path.join(repo, 'src', 'fixture.ts'), `${sourceText(sentinel)}\n`, 'utf8');
      await git(['add', '-A']);
      await git(['commit', '-q', '-m', message]);
      await git(['update-ref', 'refs/orcaops/review/probe', await git(['rev-parse', 'HEAD'])]);
    };

    let app: Awaited<ReturnType<typeof mountReviewApp>> | null = null;
    try {
      await git(['init', '-q', '-b', 'main']);
      await mkdir(path.join(repo, 'src'), { recursive: true });
      await pin('OLD_GENERATION_SENTINEL', 'old source');

      const current = await buildReviewAppHarness({ scenario: 'no-narrative', root: repo });
      let bundleGeneration = 'bundle-old';
      let commentsGeneration = 'comments-old';
      let installedLoads = 0;
      const installedData = { ...current.loaded.data, root: repo, slug: 'probe' };
      app = await mountReviewApp({
        scenario: 'no-narrative',
        root: repo,
        screen: 'floor-diff',
        width: 160,
        autoLoad: true,
        liveRefreshThrottleMs: 0,
        reviewLoader: async () => installedData,
        installedReviewLoader: async () => {
          installedLoads += 1;
          return { ...installedData };
        },
        reviewGenerationLoader: async () => ({
          bundle: bundleGeneration,
          story: null,
          storyInstallation: null,
          storyAnchors: null,
          journal: null,
          comments: commentsGeneration,
        }),
        reviewAuxLoader: async () => ({
          comments: current.loaded.comments,
        }),
      });
      await app.press('z');
      expect(await app.settleUntil((frame) => frame.includes('OLD_GENERATION_SENTINEL'))).toBe(
        true
      );

      // Mutable overlays do not replace the immutable patch/source generation.
      commentsGeneration = 'comments-new';
      await app.liveRefresh();
      expect(app.frame()).toContain('OLD_GENERATION_SENTINEL');
      expect(installedLoads).toBe(0);

      // The path and diff stay identical while the pinned ref moves underneath
      // a new bundle generation — the stale-cache case this test protects.
      await pin('NEW_GENERATION_SENTINEL', 'new source');
      expect(await git(['show', 'refs/orcaops/review/probe:src/fixture.ts'])).toContain(
        'NEW_GENERATION_SENTINEL'
      );
      bundleGeneration = 'bundle-new';
      await app.liveRefresh();
      expect(await app.settleUntil((frame) => frame.includes('9 unchanged lines'))).toBe(true);
      expect(app.frame()).not.toContain('OLD_GENERATION_SENTINEL');
      expect(installedLoads).toBe(1);

      await app.press('z');
      expect(await app.settleUntil((frame) => frame.includes('NEW_GENERATION_SENTINEL'))).toBe(
        true
      );
      expect(app.frame()).not.toContain('OLD_GENERATION_SENTINEL');

      // An unchanged heartbeat keeps the expanded source the reviewer is reading.
      await app.liveRefresh();
      expect(app.frame()).toContain('NEW_GENERATION_SENTINEL');
      expect(installedLoads).toBe(1);
    } finally {
      app?.unmount();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('the true cold-loading screen processes navigation and cancels generation on quit', async () => {
    const commands: string[] = [];
    let loadAborted = false;
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      autoLoad: true,
      startWithoutReview: true,
      reviewLoader: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              loadAborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        }),
      onCommandExecuted: (command) => commands.push(command.kind),
    });

    expect(app.frame()).toContain('Loading review for probe');
    await app.press('j');
    expect(commands).toContain('move-list');

    await app.press('q');
    expect(commands).toContain('quit');
    expect(app.exits()).toBe(1);
    expect(loadAborted).toBe(true);
    app.unmount();
  });

  test('a superseded load publishes neither stale success nor stale error', async () => {
    const current = await buildReviewAppHarness({ scenario: 'reader-parity' });
    const calls: Array<{
      resolve: (value: typeof current.loaded.data) => void;
      reject: (reason: Error) => void;
    }> = [];
    const reviewLoader = () =>
      new Promise<typeof current.loaded.data>((resolve, reject) => calls.push({ resolve, reject }));
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      autoLoad: true,
      reviewLoader,
    });
    expect(calls).toHaveLength(1);

    // A passive heartbeat never supersedes an explicit generation in flight.
    await app.liveRefresh();
    expect(calls).toHaveLength(1);

    // A newer explicit refresh does supersede it and owns publication.
    await app.press('R');
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(current.loaded.data);
    await app.settleUntil((frame) => frame.includes('CAPTURED WORK'));
    expect(app.frame()).toContain('CAPTURED WORK');

    calls[0]!.reject(new Error('stale load failure'));
    await app.settle();
    expect(app.frame()).toContain('CAPTURED WORK');
    expect(app.frame()).not.toContain('stale load failure');
    app.unmount();
  });
});

describe('deterministic floor route (no narrative)', () => {
  test('boots on the floor and says so', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative' });
    const frame = app.frame();
    // This is the Brief of the deterministic lens, and it says what the reviewer
    // has actually READ — not a fallback that every screen they asked for collapsed
    // into.
    expect(frame).toContain('CAPTURED WORK');
    expect(frame).toContain('Reading · captured checkpoints');
    expect(frame).toContain('0/1 complete');
    expect(frame).not.toContain('no narrative yet · deterministic floor');
    app.unmount();
  });

  test('opens a current routine Story on the shared Brief surface', async () => {
    const current = await buildReviewAppHarness({ scenario: 'no-narrative' });
    const fixture = buildStoryReviewHarnessFixture();
    const routineStory = await storyOverlay(fixture.model, {
      runId: 'routine-run',
      installationToken: 'routine-installation',
    });
    const loaded = await loadedReviewWithStoryFixture({
      base: current.loaded,
      floor: fixture.floor,
      reviewDiff: fixture.reviewDiff,
      routineStory,
    });
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      width: 160,
      initialLoadedOverride: loaded,
    });

    // The ownership label is the Story's headline vital, and the banner is its
    // trust statement — both on the shared Brief surface.
    expect(app.frame()).toContain('OWNERSHIP');
    expect(app.frame()).toContain('derived');
    expect(app.frame()).toContain('Capture-backed Story ownership');
    expect(app.frame()).toContain('The branch replaces a stacked Story');
    expect(app.frame()).toContain('Route the Story through shared primitives');
    expect(app.frame()).not.toContain('CAPTURED WORK');
    app.unmount();
  });

  test.each(WIDTHS)(
    'Enter opens the retained diff with compact opaque context at %i columns',
    async (width) => {
      const app = await mountReviewApp({ scenario: 'no-narrative', width });
      await app.press('\r');

      expect(app.state().screen).toBe('floor-diff');
      const frame = app.frame();
      // The product identifies the slice stop and file. The parent hunk is rendering
      // context, not reviewer-facing navigation state.
      expect(frame).toContain('Fixture checkpoint');
      expect(frame).toContain('Slice 1/3');
      expect(frame).toContain('fixture.ts');
      expect(frame).not.toContain('SLICE GRAIN');
      expect(frame).not.toContain('Enter for rows');
      expect(app.surface('review-reader-header').backgroundAlpha).toBe(1);
      // `RETAINED DIFF` is not a string the app emits.
      expect(frame).not.toContain('RETAINED DIFF');
      app.unmount();
    }
  );

  test('shell surfaces stay opaque while the diff canvas may be transparent', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r');
    expect(app.surface('review-context-rail').backgroundAlpha).toBe(1);
    expect(app.surface('review-reader-header').backgroundAlpha).toBe(1);
    expect(app.surface('review-footer').backgroundAlpha).toBe(1);

    await app.press('c');
    expect(app.surface('review-input-modal').backgroundAlpha).toBe(1);
    app.unmount();

    const finish = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'finish',
      width: 160,
    });
    expect(finish.surface('review-finish-scroll').backgroundAlpha).toBe(1);
    finish.unmount();
  });

  test('Help overlays the still-mounted reader and restores it without another redraw', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 10,
    });
    await app.press('G');
    const before = app.scrollTop();
    expect(before).toBeGreaterThan(0);

    await app.press('?');
    expect(app.frame()).toContain('Review controls');
    expect(app.frame()).toContain('Checkpoint 1/1 · Fixture checkpoint');
    expect(app.surface('review-diff-scroll').width).toBeGreaterThan(0);
    expect(app.surface('review-help-backdrop').backgroundAlpha).toBe(0);
    expect(app.surface('review-help-dialog').backgroundAlpha).toBe(1);
    await app.press('j');
    expect(app.scrollTop()).toBe(before);

    await app.press('?');
    expect(app.frame()).toContain('Checkpoint 1/1 · Fixture checkpoint');
    expect(app.scrollTop()).toBe(before);
    app.unmount();
  });

  test.each(WIDTHS)(
    'text input retains the exact reader viewport behind an opaque responsive overlay at %i columns',
    async (width) => {
      const app = await mountReviewApp({
        scenario: 'no-narrative',
        screen: 'floor-diff',
        width,
        height: 24,
        reviewDiff: tallHarnessDiff(120),
      });
      await app.press('G');
      const before = app.scrollTop();
      expect(before).toBeGreaterThan(0);

      await app.press('c');

      expect(app.frame()).toContain('Comment on src/fixture.ts:1');
      expect(app.frame()).toContain('^S Add comment');
      expect(app.frame()).toContain('Esc Cancel');
      expect(app.surface('review-diff-scroll').width).toBeGreaterThan(0);
      expect(app.surface('review-input-backdrop').backgroundAlpha).toBe(1);
      expect(app.surface('review-input-modal').backgroundAlpha).toBe(1);
      expect(app.scrollTop()).toBe(before);
      const modal = app.surfaceRect('review-input-modal');
      expect(modal.x).toBeGreaterThanOrEqual(0);
      expect(modal.y).toBeGreaterThanOrEqual(0);
      expect(modal.x + modal.width).toBeLessThanOrEqual(width);
      expect(modal.y + modal.height).toBeLessThanOrEqual(24);

      await app.press('escape');
      expect(app.frame()).not.toContain('^S Add comment');
      expect(app.scrollTop()).toBe(before);
      app.unmount();
    }
  );

  test('required composers keep focus on invalid save and expose pointer Save and Cancel paths', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 110,
      height: 24,
    });

    await app.press('c');
    await app.press('\u0013');
    expect(app.frame()).toContain('Write a comment before saving.');
    expect(app.frame()).toContain('^S Add comment');
    expect(app.sidecar()).toHaveLength(0);

    await app.pressAll([...'pointer-authored note']);
    let rows = app.rows();
    let actionRow = rows.findIndex((row) => row.includes('^S Add comment'));
    expect(actionRow).toBeGreaterThanOrEqual(0);
    let actionColumn = rows[actionRow]!.indexOf('Add comment');
    await app.mockMouse.click(actionColumn + 1, actionRow);
    await app.settleUntil((frame) => frame.includes('Comment filed'));
    expect(app.sidecar().map((comment) => comment.body)).toEqual(['pointer-authored note']);

    await app.press('c');
    rows = app.rows();
    actionRow = rows.findIndex((row) => row.includes('Esc Cancel'));
    expect(actionRow).toBeGreaterThanOrEqual(0);
    actionColumn = rows[actionRow]!.indexOf('Cancel');
    await app.mockMouse.click(actionColumn + 1, actionRow);
    await app.settle();
    expect(app.frame()).not.toContain('Esc Cancel');
    expect(app.sidecar()).toHaveLength(1);
    app.unmount();
  });

  test.each(
    WIDTHS.flatMap((width) => [
      { scenario: 'no-narrative' as const, screen: 'floor-diff' as const, width },
      { scenario: 'reader-parity' as const, screen: 'walk' as const, width },
    ])
  )(
    'returning from $screen paints an opaque Brief immediately at $width columns',
    async ({ scenario, screen, width }) => {
      const app = await mountReviewApp({ scenario, screen, width });
      await app.press('escape');

      expect(app.state().screen).toBe('brief');
      expect(app.surface('review-screen-plane').backgroundAlpha).toBe(1);
      expect(app.surface('review-screen-plane').width).toBe(width);
      expect(app.surface('review-screen-plane').height).toBeGreaterThan(0);
      expect(app.surface('review-brief-scroll').backgroundAlpha).toBe(0);
      expect(app.frame()).not.toContain('second fixture hunk');
      app.unmount();
    }
  );

  test('treats a completed load with no deterministic floor as neutral empty', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      initialLoadedOverride: null,
    });
    expect(app.frame()).toContain('No deterministic review floor');
    expect(app.frame()).toContain('Capture and close implementation checkpoints');
    expect(app.frame()).not.toContain('Review unavailable');
    app.unmount();
  });

  test('the diff column renders the CHECKPOINT: whole file cards, every parent hunk', async () => {
    // The unit of review is the checkpoint, so the column shows the files it
    // touched — each with ALL of its parent hunks, and the unchanged code between
    // them collapsed but present. Resolving ONE hunk out of a flat list instead
    // shows the reviewer a fragment with no idea what surrounds it.
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r');
    const frame = app.frame();

    // The header names the checkpoint the cursor is on, and where it sits in the
    // branch's captured record — `1/1` here because this fixture has one checkpoint.
    // `two-checkpoints` (readerShell.render.test.tsx) is where paging is proved.
    expect(frame).toContain('Checkpoint 1/1 · Fixture checkpoint');

    // BOTH of src/fixture.ts's hunks are on screen, in one card...
    expect(frame).toContain('@@ -1,0 +1 @@');
    expect(frame).toContain('@@ -10,0 +11 @@');
    // ...with the unchanged run between them collapsed into an expandable gap.
    expect(frame).toContain('9 unchanged lines');
    // ...and the second file the checkpoint touched gets its own card.
    expect(frame).toContain('src/second.ts');

    // The card header carries the file's real signs.
    expect(frame).toContain('M src/fixture.ts +2 −0');
    app.unmount();
  });

  test('z expands the collapsed gap, visibly', async () => {
    // The gap is expandable; prove it by reading the frame, not by observing that a
    // command was emitted.
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r');
    expect(app.frame()).toContain('9 unchanged lines');

    await app.press('z');
    const frame = app.frame();
    // The collapsed row is gone, replaced by the source it was hiding. Without a
    // pinned tree the fixture cannot fetch it, so it says so IN PLACE — which is
    // still an expansion, and still not a lie about why.
    expect(frame).not.toContain('▾ 9 unchanged lines');
    app.unmount();
  });

  test('every paging key moves the viewport the right way', async () => {
    // Paging in BOTH directions: a command name that carries no direction makes a
    // missing page-DOWN unobservable. Every one of these funnels through the scroll
    // coordinator, and each is asserted by where the viewport actually LANDED — not
    // by observing that a command was emitted.
    // A SHORT viewport, so the content genuinely overflows it. At a taller one the
    // two file cards barely exceed the viewport and every key clamps to the same
    // maxScroll — the test would pass while proving nothing about the step sizes.
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160, height: 10 });
    await app.press('\r');
    const top = app.scrollTop();
    expect(top).toBe(0);

    await app.press('f'); // page down
    const paged = app.scrollTop();
    expect(paged).toBeGreaterThan(top);

    await app.press('b'); // page up — symmetric, back to where we started
    expect(app.scrollTop()).toBe(top);

    await app.press('D'); // half-page down
    const half = app.scrollTop();
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(paged);

    await app.press('G'); // bottom
    const bottom = app.scrollTop();
    expect(bottom).toBeGreaterThan(half);

    await app.press('G'); // ...and it STOPS there, rather than running off the end
    expect(app.scrollTop()).toBe(bottom);

    await app.press('g'); // top
    expect(app.scrollTop()).toBe(0);
    app.unmount();
  });

  test('`.` and `,` move to the next and previous FILE', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r');
    expect(app.frame()).toContain('· src/fixture.ts');

    await app.press('.');
    expect(app.frame()).toContain('· src/second.ts');

    await app.press(','); // back to the FIRST hunk of the previous file
    expect(app.frame()).toContain('Slice 1/3 · src/fixture.ts');

    await app.press(','); // ...and no-ops at the first file rather than wrapping
    expect(app.frame()).toContain('First file');
    app.unmount();
  });

  test('the contextual rail renders the checkpoint-close record beside the diff', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r');
    const frame = app.frame();

    expect(frame).toContain('REVIEW CONTEXT · CHECKPOINT');
    expect(frame).toContain('cp1 · Fixture checkpoint');
    // Reviewer-value labels and prose lead; raw artifact bookkeeping does not.
    expect(frame).toContain('OUTCOME');
    expect(frame).toContain('Checkpoint 1 reworked the');
    expect(frame).toContain('CAPTURED QUESTIONS · 1 OPEN');
    expect(frame).toContain('DECISION');
    expect(frame).toContain('RULED OUT');
    expect(frame).not.toContain('WHAT TO REVIEW');
    expect(frame).not.toContain('reader-contract');
    expect(frame).toContain('FILES');
    expect(frame).not.toContain('artifact-fixture');
    // ...and the record prose itself, not just its label. The rail is ~40
    // columns, so record text soft-wraps: asserting this sentence on one line
    // asserts a line the product renders at NO width. Assert the wrap the reviewer
    // actually sees.
    expect(frame).toContain('↳ Reviewer progress must survive');
    expect(frame).toContain('regeneration.');
    app.unmount();
  });

  test('j advances the selected slice, and the header counts up with it', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r');
    expect(app.state().diffHunkKey).toBe('hunk_fixture');
    expect(app.state().diffSliceKey).toBe('hunk_fixture:s0');
    expect(app.frame()).toContain('Slice 1/3');

    await app.press('j');
    expect(app.state().diffHunkKey).toBe('hunk_fixture_second');
    expect(app.state().diffSliceKey).toBe('hunk_fixture_second:s0');
    expect(app.frame()).toContain('Slice 2/3');

    await app.press('k');
    expect(app.state().diffHunkKey).toBe('hunk_fixture');
    expect(app.state().diffSliceKey).toBe('hunk_fixture:s0');
    expect(app.frame()).toContain('Slice 1/3');
    app.unmount();
  });

  test('slice navigation follows measured geometry when the next stop is below the fold', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 14,
    });
    expect(app.scrollTop()).toBe(0);

    await app.pressAll(['j', 'j']);

    expect(app.state().diffSliceKey).toBe('hunk_fixture_third:s0');
    expect(app.scrollTop()).toBeGreaterThan(0);
    expect(app.frame()).toContain('third fixture hunk');
    app.unmount();
  });

  test('two slices in one parent hunk remain two rendered navigation stops', async () => {
    const app = await mountReviewApp({
      scenario: 'same-hunk-slices',
      screen: 'floor-diff',
      width: 160,
    });

    await app.press('j');
    expect(app.state().diffSliceKey).toBe('hunk_fixture_second:s0');
    expect(app.state().diffHunkKey).toBe('hunk_fixture_second');
    expect(app.frame()).toContain('Slice 2/4');

    await app.press('j');
    expect(app.state().diffSliceKey).toBe('hunk_fixture_second:s1');
    // The rendering context did not change; the selected slice did.
    expect(app.state().diffHunkKey).toBe('hunk_fixture_second');
    expect(app.frame()).toContain('Slice 3/4');
    expect(app.frame()).toContain('second fixture hunk');
    expect(app.frame()).toContain('cp2 added this row');
    app.unmount();
  });

  test('Right descends to row grain and Left restores the same hunk grain', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('return');
    const sliceKey = app.state().diffSliceKey;
    const routeHistory = app.state().routeHistory;
    await app.press('right');

    expect(app.state().diffGrain).toBe('row');
    expect(app.frame()).toContain('Row 1/');
    await app.press('left');
    expect(app.state()).toMatchObject({
      screen: 'floor-diff',
      focus: 'diff',
      diffGrain: 'hunk',
      diffSliceKey: sliceKey,
      diffSelectionAnchor: null,
    });
    expect(app.state().routeHistory).toEqual(routeHistory);
    app.unmount();
  });

  test('F reaches the flat all-files escape hatch', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative' });
    await app.press('F');

    expect(app.state().screen).toBe('flat-files');
    const frame = app.frame();
    expect(frame).toContain('ALL FILES · deterministic floor');
    expect(frame).toContain('src/fixture.ts');
    app.unmount();
  });

  test('Brief opens the selected thread directly when an earlier artifact shares its hunk', async () => {
    const app = await mountReviewApp({
      scenario: 'cross-artifact-shared-hunk',
      screen: 'brief',
      width: 160,
    });

    await app.press('j');
    // The second leaf sits under the later artifact's thread heading.
    expect(app.frame()).toContain('Later artifact work');
    const selected = app.rows().find((row) => row.includes('❯'));
    expect(selected).toContain('Later artifact checkpoint');
    await app.press('\r');

    expect(app.state().readerPage).toBe(1);
    expect(app.frame()).toContain('Later artifact checkpoint');
    app.unmount();
  });
});

describe('responsive layout, asserted as geometry', () => {
  // No `LAYOUT · SPLIT (...)` banner exists in the product, so grepping a frame for
  // one at three widths would pass while flipping the real flexDirection failed
  // nothing. What "split" MEANS is that the trail and the diff occupy the same rows.
  test.each(WIDTHS)('never renders a LAYOUT banner at %i columns', async (width) => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width });
    await app.press('\r');
    expect(app.frame()).not.toContain('LAYOUT');
    app.unmount();
  });

  test.each(WIDTHS)('the footer is an opaque full-width row at %i columns', async (width) => {
    for (const entry of [
      { scenario: 'no-narrative' as const, screen: 'floor-diff' as const },
      { scenario: 'unassigned-floor-only' as const, screen: 'unassigned' as const },
    ]) {
      const app = await mountReviewApp({ ...entry, width });
      expect(app.surface('review-footer')).toEqual({
        width,
        height: 1,
        backgroundAlpha: 1,
      });
      app.unmount();
    }
  });

  test('at 110+ the trail and the diff share rows, trail on the left', async () => {
    for (const width of [110, 160] as const) {
      const app = await mountReviewApp({ scenario: 'no-narrative', width });
      await app.press('\r');
      // Probe the rail's PROSE against the diff's FILE CARD. The diff's position
      // header is not the thing to probe: it sits above the scroll region (so that
      // the scrolled content is exactly what the layout measured), which puts it on
      // a row the rail has not started painting yet.
      const shared = app
        .rows()
        .find(
          (row) =>
            (row.includes('OUTCOME') || row.includes('Checkpoint 1')) &&
            row.includes('src/fixture.ts')
        );
      expect(shared).toBeDefined();
      const railText = shared!.includes('OUTCOME') ? 'OUTCOME' : 'Checkpoint 1';
      expect(shared!.indexOf(railText)).toBeLessThan(shared!.indexOf('src/fixture.ts'));
      app.unmount();
    }
  });

  test('at 80 the trail and the diff stack, trail above', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 80 });
    await app.press('\r');
    const rows = app.rows();

    expect(rows.some((row) => row.includes('REVIEW CONTEXT') && row.includes('Slice 1/3'))).toBe(
      false
    );
    const trailRow = rows.findIndex((row) => row.includes('REVIEW CONTEXT'));
    const diffRow = rows.findIndex((row) => row.includes('Slice 1/3'));
    expect(trailRow).toBeGreaterThanOrEqual(0);
    expect(diffRow).toBeGreaterThan(trailRow);
    app.unmount();
  });
});

describe('shared deterministic route', () => {
  test('Unassigned shows both gates with their counts', async () => {
    const app = await mountReviewApp({ scenario: 'unassigned', screen: 'unassigned' });
    const frame = app.frame();

    expect(frame).toContain('Unassigned · Slice 1/2');
    expect(frame).toContain('src/unassigned.ts');
    expect(frame).toContain('src/ambiguous.ts');
    expect(frame).toContain('ambiguous before');
    app.unmount();
  });

  test('the comments index reads the sidecar without a narrative model', async () => {
    const app = await mountReviewApp({
      scenario: 'comments',
      screen: 'comments',
      width: 160,
      comments: [
        {
          comment_id: 'c1',
          ts: '2026-01-01T00:00:00.000Z',
          author: 'reviewer',
          body: 'Does this preserve the retry boundary?',
          status: 'open',
          anchor: {
            kind: 'DIFF_LINE',
            file: 'src/fixture.ts',
            side: 'add',
            line: 1,
            lineHash: 'h1',
          },
          replies: [],
          position: {
            rung: 'line_hash',
            file: 'src/fixture.ts',
            side: 'add',
            line: 1,
            endLine: null,
            hunkKey: 'hunk_fixture',
            threadKey: null,
            drifted: false,
          },
          context: [],
          owner: null,
          trail: [],
        },
      ],
    });
    const frame = app.frame();

    expect(frame).toContain('Does this preserve the retry boundary?');
    // And WHERE it landed — the re-anchor fate.
    expect(frame).toContain('src/fixture.ts:1');
    expect(frame).not.toContain('canonical review items');
    app.unmount();
  });
});

describe('coverage-unavailable is visible, not silent', () => {
  // When floor and diff.patch disagree, owned rows are unknown: coverage cannot
  // be computed and `m` cannot record anything. Swallowing the throw — and, on the
  // floor-only path, not even recording it — renders the review as healthy while
  // mark-reviewed does nothing forever.
  test('the reviewer is told, on the floor route', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', reviewDiff: '' });
    const frame = app.frame();

    expect(frame).toContain('COVERAGE UNAVAILABLE');
    expect(frame).toContain('mark reviewed cannot record progress');
    expect(frame).toContain('no retained parent hunk in diff.patch');
    app.unmount();
  });

  test('a legacy narrative cannot hide the deterministic coverage warning', async () => {
    const app = await mountReviewApp({
      scenario: 'reader-parity',
      screen: 'walk',
      reviewDiff: '',
    });
    expect(app.frame()).toContain('COVERAGE UNAVAILABLE');
    app.unmount();
  });

  test('a healthy review never shows the banner', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative' });
    expect(app.frame()).not.toContain('COVERAGE UNAVAILABLE');
    app.unmount();
  });
});

describe('the gap-expansion keys answer honestly', () => {
  // "expansion is unavailable on the bounded review route" is a false answer:
  // there is no other route, and a gap that will not open means the buildPatchIndex
  // call site passed no root+slug, so the file has no source fetcher. The
  // fetch/state contract is asserted in gapSource.test.ts; what has to be true HERE
  // is that the reader does not tell the reviewer a story about why it cannot do
  // the thing.
  const LIE = 'unavailable on the bounded review route';

  test('z does not claim expansion is unavailable on this route', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative' });
    await app.press('\r'); // into the diff, so a hunk is selected
    await app.press('z');

    expect(app.frame()).not.toContain(LIE);
    app.unmount();
  });

  test('Z does not claim expansion is unavailable on this route', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative' });
    await app.press('\r');
    await app.press('Z');

    expect(app.frame()).not.toContain(LIE);
    app.unmount();
  });

  test('a live reply is visible on the deterministic route, not swallowed by the status line', async () => {
    // A floor route that overwrites every notice with "no narrative yet ·
    // deterministic floor" leaves no keypress able to reply to the reviewer.
    //
    // The card carries the whole file, so `z` finds the 9 hidden lines and opens
    // them. Walking it to exhaustion asserts that a true answer reaches the screen
    // AND proves `z` advances through every block instead of flipping one forever.
    const app = await mountReviewApp({ scenario: 'no-narrative' });
    expect(app.frame()).toContain('captured checkpoints'); // standing context, no notice yet

    await app.press('\r');
    let exhausted = false;
    for (let press = 0; press < 6 && !exhausted; press += 1) {
      await app.press('z');
      exhausted = app.frame().includes('No hidden context left in this file');
    }

    expect(exhausted).toBe(true);
    app.unmount();
  });

  test('a failed source fetch says WHY, in the reviewer’s line of sight', async () => {
    // The fixture has no pinned tree, so expanding the gap cannot fetch the source.
    // That is a real failure with a real remedy, and the reviewer has to be told —
    // the failure this pins is the reader going quiet, or worse, blaming the wrong
    // thing.
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r');
    await app.press('z');

    // The fetch is a real async read, so WAIT for its answer rather than assuming
    // one settle is enough — a fixed count passes alone and fails under load.
    expect(await app.settleUntil((frame) => frame.includes('pinned tree pruned'))).toBe(true);
    expect(app.frame()).toContain('orcaops review data');
    app.unmount();
  });
});

describe('durable effects', () => {
  test('finishing a complete review appends a durable lifecycle event', async () => {
    const app = await mountReviewApp({ scenario: 'complete', screen: 'brief' });
    // Move past the sole deterministic checkpoint row onto Finish, then open it.
    await app.pressAll(['j', '\r']);
    expect(app.state().screen).toBe('finish');
    expect(app.frame()).toContain('REVIEW STATUS');

    await app.press('\r');
    // The observable effect is a journal event on disk, not an emitted command.
    const lifecycle = app.journalEvents.filter((event) => event.type === 'review_lifecycle');
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]).toMatchObject({ type: 'review_lifecycle', action: 'COMPLETE' });
    app.unmount();
  });
});
