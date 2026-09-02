import { describe, expect, it, vi } from 'vitest';

import { LiveRefreshCoordinator } from './liveRefreshCoordinator';

describe('LiveRefreshCoordinator', () => {
  it('retains one trailing authoritative read for events during a running refresh', async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );
    const coordinator = new LiveRefreshCoordinator(run, 2_000);

    coordinator.request();
    await vi.runOnlyPendingTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
    coordinator.request();
    coordinator.request();
    releases.shift()?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(2);

    coordinator.dispose();
    releases.shift()?.();
    vi.useRealTimers();
  });

  it('cancels a queued trailing read when its owner unmounts', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const coordinator = new LiveRefreshCoordinator(run, 2_000);
    coordinator.request();
    await vi.runOnlyPendingTimersAsync();
    coordinator.request();
    coordinator.dispose();
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
