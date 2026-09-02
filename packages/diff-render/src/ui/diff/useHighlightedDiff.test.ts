import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { diffFileFromPatch } from '../../fromPatch';
import { DEFAULT_DARK_THEME_ID, resolveTheme } from '../themes';
import type { HighlightedDiffCode } from './pierre';
import {
  deferMountedDiffHighlightsForInteraction,
  MAX_ACTIVE_MOUNTED_HIGHLIGHTS,
  MOUNTED_HIGHLIGHT_DWELL_MS,
  MOUNTED_HIGHLIGHT_INTERACTION_QUIET_MS,
  prefetchHighlightedDiff,
  readMountedDiffHighlightSchedulerCompletionCount,
  resetMountedHighlightSchedulerForTests,
  scheduleMountedHighlight,
  waitForMountedDiffHighlightsIdle,
} from './useHighlightedDiff';

const pierreMocks = vi.hoisted(() => ({
  loadHighlightedDiff: vi.fn(),
  loadHighlightedDiffHunk: vi.fn(),
}));

vi.mock('./pierre', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pierre')>();
  return {
    ...actual,
    loadHighlightedDiff: pierreMocks.loadHighlightedDiff,
    loadHighlightedDiffHunk: pierreMocks.loadHighlightedDiffHunk,
  };
});

const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);
const highlighted: HighlightedDiffCode = { deletionLines: [], additionLines: [] };

function file(sourceId: string) {
  return diffFileFromPatch(
    [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 0000001..0000002 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-const answer = 1;',
      '+const answer = 2;',
    ].join('\n'),
    { sourceId }
  );
}

describe('mounted syntax scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMountedHighlightSchedulerForTests();
    pierreMocks.loadHighlightedDiff.mockReset();
    pierreMocks.loadHighlightedDiffHunk.mockReset();
  });

  afterEach(() => {
    resetMountedHighlightSchedulerForTests();
    vi.useRealTimers();
  });

  it('cancels a rapid mount/unmount traversal before any highlight work is enqueued', async () => {
    pierreMocks.loadHighlightedDiffHunk.mockResolvedValue(highlighted);
    const diff = file('cancelled-traversal');
    const cancellations = Array.from({ length: 500 }, (_, hunkIndex) =>
      scheduleMountedHighlight({
        file: diff,
        theme,
        hunkIndex,
        onHighlighted: vi.fn(),
      })
    );

    // Every dwelling request shares one wake timer rather than retaining 500 timer closures.
    expect(vi.getTimerCount()).toBe(1);
    for (const cancel of cancellations) cancel();
    await vi.advanceTimersByTimeAsync(MOUNTED_HIGHLIGHT_DWELL_MS);

    expect(pierreMocks.loadHighlightedDiffHunk).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a stable mounted hunk after one short dwell', async () => {
    pierreMocks.loadHighlightedDiffHunk.mockResolvedValue(highlighted);
    const onHighlighted = vi.fn();
    const cancel = scheduleMountedHighlight({
      file: file('stable-hunk'),
      theme,
      hunkIndex: 0,
      onHighlighted,
    });

    await vi.advanceTimersByTimeAsync(MOUNTED_HIGHLIGHT_DWELL_MS - 1);
    expect(pierreMocks.loadHighlightedDiffHunk).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(pierreMocks.loadHighlightedDiffHunk).toHaveBeenCalledTimes(1);
    expect(onHighlighted).toHaveBeenCalledWith(highlighted);
    cancel();
  });

  it('reports monotonic scheduler completion without counting a cache hit as new work', async () => {
    pierreMocks.loadHighlightedDiffHunk.mockResolvedValue(highlighted);
    const diff = file('scheduler-completion-evidence');
    const before = readMountedDiffHighlightSchedulerCompletionCount();
    const cancelFirst = scheduleMountedHighlight({
      file: diff,
      theme,
      hunkIndex: 0,
      onHighlighted: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(MOUNTED_HIGHLIGHT_DWELL_MS);
    await waitForMountedDiffHighlightsIdle();
    const afterScheduledWork = readMountedDiffHighlightSchedulerCompletionCount();
    expect(afterScheduledWork).toBe(before + 1);
    cancelFirst();

    const cancelCached = scheduleMountedHighlight({
      file: diff,
      theme,
      hunkIndex: 0,
      onHighlighted: vi.fn(),
    });
    expect(readMountedDiffHighlightSchedulerCompletionCount()).toBe(afterScheduledWork);
    cancelCached();
  });

  it('defers mounted work until viewport activity has stayed quiet', async () => {
    pierreMocks.loadHighlightedDiffHunk.mockResolvedValue(highlighted);
    const onHighlighted = vi.fn();
    deferMountedDiffHighlightsForInteraction();
    const cancel = scheduleMountedHighlight({
      file: file('interactive-hunk'),
      theme,
      hunkIndex: 0,
      onHighlighted,
    });
    let idle = false;
    void waitForMountedDiffHighlightsIdle().then(() => {
      idle = true;
    });

    await vi.advanceTimersByTimeAsync(MOUNTED_HIGHLIGHT_INTERACTION_QUIET_MS - 20);
    expect(idle).toBe(false);
    deferMountedDiffHighlightsForInteraction();
    await vi.advanceTimersByTimeAsync(MOUNTED_HIGHLIGHT_INTERACTION_QUIET_MS - 1);
    expect(pierreMocks.loadHighlightedDiffHunk).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(pierreMocks.loadHighlightedDiffHunk).toHaveBeenCalledTimes(1);
    expect(onHighlighted).toHaveBeenCalledWith(highlighted);
    expect(idle).toBe(true);
    cancel();
  });

  it('keeps surviving mounted demand bounded and removes queued requests on unmount', async () => {
    let resolveHighlight!: (result: HighlightedDiffCode) => void;
    const pending = new Promise<HighlightedDiffCode>((resolve) => {
      resolveHighlight = resolve;
    });
    pierreMocks.loadHighlightedDiffHunk.mockReturnValue(pending);
    const diff = file('bounded-mounted-demand');
    const listeners = Array.from({ length: 200 }, () => vi.fn());
    const cancellations = listeners.map((onHighlighted, hunkIndex) =>
      scheduleMountedHighlight({ file: diff, theme, hunkIndex, onHighlighted })
    );

    await vi.advanceTimersByTimeAsync(MOUNTED_HIGHLIGHT_DWELL_MS);
    expect(pierreMocks.loadHighlightedDiffHunk).toHaveBeenCalledTimes(
      MAX_ACTIVE_MOUNTED_HIGHLIGHTS
    );

    for (const cancel of cancellations) cancel();
    resolveHighlight(highlighted);
    await vi.advanceTimersByTimeAsync(0);

    // Every other request stayed cancellable scheduler state, never a Pierre promise closure.
    expect(pierreMocks.loadHighlightedDiffHunk).toHaveBeenCalledTimes(
      MAX_ACTIVE_MOUNTED_HIGHLIGHTS
    );
    expect(listeners.every((listener) => listener.mock.calls.length === 0)).toBe(true);
  });

  it('keeps explicit prefetch immediate and returns its cached result without a dwell', async () => {
    pierreMocks.loadHighlightedDiff.mockResolvedValue(highlighted);
    const diff = file('explicit-prefetch');
    const prefetched = prefetchHighlightedDiff({ file: diff, theme });

    expect(pierreMocks.loadHighlightedDiff).toHaveBeenCalledTimes(1);
    await expect(prefetched).resolves.toBe(highlighted);

    const onHighlighted = vi.fn();
    deferMountedDiffHighlightsForInteraction();
    const cancel = scheduleMountedHighlight({ file: diff, theme, hunkIndex: 0, onHighlighted });
    expect(onHighlighted).toHaveBeenCalledWith(highlighted);
    expect(pierreMocks.loadHighlightedDiff).toHaveBeenCalledTimes(1);
    expect(pierreMocks.loadHighlightedDiffHunk).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    cancel();
  });

  it('reuses highlighted content immediately across a move-only DiffFile clone', async () => {
    pierreMocks.loadHighlightedDiffHunk.mockResolvedValue(highlighted);
    const parsed = file('move-only-enrichment');
    const first = vi.fn();
    const cancelFirst = scheduleMountedHighlight({
      file: parsed,
      theme,
      hunkIndex: 0,
      onHighlighted: first,
    });

    await vi.advanceTimersByTimeAsync(MOUNTED_HIGHLIGHT_DWELL_MS);
    expect(first).toHaveBeenCalledWith(highlighted);
    expect(pierreMocks.loadHighlightedDiffHunk).toHaveBeenCalledTimes(1);
    cancelFirst();

    const enriched: typeof parsed = {
      ...parsed,
      lineMoveKinds: {
        deletionLines: ['moved'],
        additionLines: ['moved'],
      },
    };
    const second = vi.fn();
    deferMountedDiffHighlightsForInteraction();
    const cancelSecond = scheduleMountedHighlight({
      file: enriched,
      theme,
      hunkIndex: 0,
      onHighlighted: second,
    });

    // A content-identity hit is delivered synchronously: the enriched render
    // never falls back to plain text and never queues duplicate Pierre work.
    expect(second).toHaveBeenCalledWith(highlighted);
    expect(pierreMocks.loadHighlightedDiffHunk).toHaveBeenCalledTimes(1);
    expect(pierreMocks.loadHighlightedDiff).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    cancelSecond();
  });

  it('shares an in-flight whole-file prefetch with mounted partial-hunk demand', async () => {
    let resolvePrefetch!: (result: HighlightedDiffCode) => void;
    pierreMocks.loadHighlightedDiff.mockReturnValue(
      new Promise<HighlightedDiffCode>((resolve) => {
        resolvePrefetch = resolve;
      })
    );
    const diff = file('in-flight-prefetch');
    const prefetched = prefetchHighlightedDiff({ file: diff, theme });
    const onHighlighted = vi.fn();
    const cancel = scheduleMountedHighlight({ file: diff, theme, hunkIndex: 0, onHighlighted });

    await vi.advanceTimersByTimeAsync(MOUNTED_HIGHLIGHT_DWELL_MS);
    expect(pierreMocks.loadHighlightedDiff).toHaveBeenCalledTimes(1);
    expect(pierreMocks.loadHighlightedDiffHunk).not.toHaveBeenCalled();

    resolvePrefetch(highlighted);
    await expect(prefetched).resolves.toBe(highlighted);
    await vi.advanceTimersByTimeAsync(0);
    expect(onHighlighted).toHaveBeenCalledWith(highlighted);
    cancel();
  });

  it('coalesces non-partial hunk demand at full-file cache and request scope', async () => {
    pierreMocks.loadHighlightedDiff.mockResolvedValue(highlighted);
    const parsed = file('non-partial-hunks');
    const diff = { ...parsed, metadata: { ...parsed.metadata, isPartial: false } };
    const first = vi.fn();
    const second = vi.fn();
    const cancelFirst = scheduleMountedHighlight({
      file: diff,
      theme,
      hunkIndex: 0,
      onHighlighted: first,
    });
    const cancelSecond = scheduleMountedHighlight({
      file: diff,
      theme,
      hunkIndex: 1,
      onHighlighted: second,
    });

    await vi.advanceTimersByTimeAsync(MOUNTED_HIGHLIGHT_DWELL_MS);

    expect(pierreMocks.loadHighlightedDiff).toHaveBeenCalledTimes(1);
    expect(pierreMocks.loadHighlightedDiffHunk).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledWith(highlighted);
    expect(second).toHaveBeenCalledWith(highlighted);
    cancelFirst();
    cancelSecond();
  });
});
