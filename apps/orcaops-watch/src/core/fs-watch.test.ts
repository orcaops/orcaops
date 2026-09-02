import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDebouncer, FsWatch } from './fs-watch.js';

async function stimulateUntilTick(dir: string, ticked: Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await writeFile(path.join(dir, `event-${attempt}.txt`), String(attempt));
    if (await Promise.race([ticked.then(() => true), delay(100, false)])) return;
  }
  throw new Error('real filesystem watcher did not acknowledge any of 100 distinct changes');
}

describe('createDebouncer', () => {
  it('coalesces a burst into ONE call after the window (fake timers)', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = createDebouncer(fn, 250);
      d.trigger();
      d.trigger();
      d.trigger();
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(249);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(fn).toHaveBeenCalledTimes(1);
      // A later trigger fires again.
      d.trigger();
      vi.advanceTimersByTime(250);
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel() prevents a pending fire', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = createDebouncer(fn, 250);
      d.trigger();
      d.cancel();
      vi.advanceTimersByTime(300);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FsWatch (integration)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-fsw-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fires a debounced tick when a file changes under a watched root', async () => {
    let ticks = 0;
    let acknowledgeTick!: () => void;
    const ticked = new Promise<void>((resolve) => {
      acknowledgeTick = resolve;
    });
    const fsw = new FsWatch({
      roots: [dir],
      debounceMs: 40,
      onTick: () => {
        ticks += 1;
        acknowledgeTick();
      },
    });
    expect(fsw.start()).toBe(true);
    try {
      await stimulateUntilTick(dir, ticked);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      fsw.close();
    }
  });

  it('skips a nonexistent root without degrading — the rest still watch', async () => {
    // A repo that never opened a review has no .orcaops/reviews dir; that root
    // must be SKIPPED, not degrade the whole watcher to fast-poll.
    const onDegrade = vi.fn();
    let ticks = 0;
    let acknowledgeTick!: () => void;
    const ticked = new Promise<void>((resolve) => {
      acknowledgeTick = resolve;
    });
    const fsw = new FsWatch({
      roots: [path.join(dir, 'nope'), dir],
      debounceMs: 40,
      onTick: () => {
        ticks += 1;
        acknowledgeTick();
      },
      onDegrade,
    });
    expect(fsw.start()).toBe(true);
    try {
      await stimulateUntilTick(dir, ticked);
      expect(ticks).toBeGreaterThan(0);
      expect(onDegrade).not.toHaveBeenCalled();
    } finally {
      fsw.close();
    }
  });

  it('only-missing roots leave the caller poll-only (start() false, no degrade)', () => {
    const onDegrade = vi.fn();
    const fsw = new FsWatch({ roots: [path.join(dir, 'nope')], onTick: () => {}, onDegrade });
    try {
      expect(fsw.start()).toBe(false);
      expect(onDegrade).not.toHaveBeenCalled();
    } finally {
      fsw.close();
    }
  });
});
