import type { ScrollBoxRenderable } from '@opentui/core';
import { describe, expect, it, vi } from 'vitest';

import { bindScrollSurfacePolicy, type ScrollLifecycleScheduler } from './scrollSurfacePolicy';

class Events {
  readonly listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  count(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

function surfaceFixture() {
  const scrollbar = new Events();
  const viewport = new Events();
  const surface = { verticalScrollBar: scrollbar, viewport } as unknown as ScrollBoxRenderable;
  return { scrollbar, surface, viewport };
}

function schedulerFixture() {
  const native: Array<() => void> = [];
  const viewport: Array<{ cancelled: boolean; task: () => void }> = [];
  const scheduler: ScrollLifecycleScheduler = {
    deferNativeRead: (task) => native.push(task),
    scheduleViewportRead: (task) => {
      const scheduled = { cancelled: false, task };
      viewport.push(scheduled);
      return () => {
        scheduled.cancelled = true;
      };
    },
  };
  return { native, scheduler, viewport };
}

describe('scroll surface ownership policies', () => {
  it('fences app writes and publishes native drags in one deferred synchronous commit', () => {
    const { scrollbar, surface } = surfaceFixture();
    const { native, scheduler } = schedulerFixture();
    const publishNativeScroll = vi.fn();
    const flushPublish = vi.fn((publish: () => void) => publish());
    let appWritePending = false;
    const cleanup = bindScrollSurfacePolicy({
      policy: 'app-owned-virtualized',
      surface,
      isAppWritePending: () => appWritePending,
      publishNativeScroll,
      publishViewport: vi.fn(),
      flushPublish,
      viewportReadDelayMs: 16,
      scheduler,
    });

    expect(publishNativeScroll).toHaveBeenCalledTimes(1);
    appWritePending = true;
    scrollbar.emit('change');
    expect(native).toHaveLength(0);

    appWritePending = false;
    scrollbar.emit('change');
    scrollbar.emit('change');
    expect(native).toHaveLength(1);
    native[0]!();
    expect(flushPublish).toHaveBeenCalledTimes(1);
    expect(publishNativeScroll).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('coalesces app-owned viewport events and cancels every listener/task on cleanup', () => {
    const { scrollbar, surface, viewport: viewportEvents } = surfaceFixture();
    const { native, scheduler, viewport } = schedulerFixture();
    const publishViewport = vi.fn();
    const cleanup = bindScrollSurfacePolicy({
      policy: 'app-owned-virtualized',
      surface,
      isAppWritePending: () => false,
      publishNativeScroll: vi.fn(),
      publishViewport,
      flushPublish: (publish) => publish(),
      viewportReadDelayMs: 16,
      scheduler,
    });

    viewportEvents.emit('layout-changed');
    viewportEvents.emit('resized');
    expect(viewport).toHaveLength(1);
    scrollbar.emit('change');
    expect(native).toHaveLength(1);
    cleanup();

    expect(viewport[0]!.cancelled).toBe(true);
    viewport[0]!.task();
    native[0]!();
    expect(publishViewport).not.toHaveBeenCalled();
    expect(scrollbar.count()).toBe(0);
    expect(viewportEvents.count()).toBe(0);
  });

  it('mirrors every native navigator event immediately and detaches cleanly', () => {
    const { scrollbar, surface, viewport } = surfaceFixture();
    const publishViewport = vi.fn();
    const cleanup = bindScrollSurfacePolicy({
      policy: 'native-mirrored-virtualized',
      surface,
      publishViewport,
    });

    scrollbar.emit('change');
    viewport.emit('layout-changed');
    viewport.emit('resized');
    expect(publishViewport).toHaveBeenCalledTimes(4);
    cleanup();
    scrollbar.emit('change');
    expect(publishViewport).toHaveBeenCalledTimes(4);
  });

  it('leaves ordinary native lists entirely owned by OpenTUI', () => {
    const { scrollbar, surface, viewport } = surfaceFixture();
    const cleanup = bindScrollSurfacePolicy({ policy: 'native', surface });
    expect(scrollbar.count()).toBe(0);
    expect(viewport.count()).toBe(0);
    cleanup();
  });
});
