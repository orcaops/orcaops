import type { ScrollBoxRenderable } from '@opentui/core';

export type ScrollSurfaceOwnership =
  | 'app-owned-virtualized'
  | 'native-mirrored-virtualized'
  | 'native';

type CancelTask = () => void;

export interface ScrollLifecycleScheduler {
  /** Queue outside the native slider stack but before a timer-driven frame. */
  deferNativeRead: (task: () => void) => void;
  /** Coalesce viewport/layout bursts and return cancellation for cleanup. */
  scheduleViewportRead: (task: () => void, delayMs: number) => CancelTask;
}

const DEFAULT_SCHEDULER: ScrollLifecycleScheduler = {
  deferNativeRead: (task) => queueMicrotask(task),
  scheduleViewportRead: (task, delayMs) => {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
};

interface NativePolicy {
  policy: 'native';
  surface: ScrollBoxRenderable;
}

interface NativeMirroredPolicy {
  policy: 'native-mirrored-virtualized';
  surface: ScrollBoxRenderable;
  /** Publish native scrollTop + viewport before rebuilding the virtual window. */
  publishViewport: () => void;
}

interface AppOwnedPolicy {
  policy: 'app-owned-virtualized';
  surface: ScrollBoxRenderable;
  /** True while React has planned a native write that must not re-enter. */
  isAppWritePending: () => boolean;
  /** Publish a genuine native scrollbar drag into the app-owned render plan. */
  publishNativeScroll: () => void;
  /** Publish converged viewport geometry and release bootstrap growth bounds. */
  publishViewport: () => void;
  /** Synchronous React publication used only for a genuine native drag. */
  flushPublish: (publish: () => void) => void;
  viewportReadDelayMs: number;
  scheduler?: ScrollLifecycleScheduler;
}

export type ScrollSurfacePolicy = NativePolicy | NativeMirroredPolicy | AppOwnedPolicy;

/**
 * Bind one explicit scroll-ownership policy to an OpenTUI surface.
 *
 * The modes intentionally do not share defaults: app-owned diff scrolling has
 * a publication fence, native-mirrored virtualization publishes immediately,
 * and ordinary native lists install no lifecycle listeners at all.
 */
export function bindScrollSurfacePolicy(config: ScrollSurfacePolicy): () => void {
  if (config.policy === 'native') return () => {};

  const scrollbar = config.surface.verticalScrollBar;
  const viewport = config.surface.viewport;

  if (config.policy === 'native-mirrored-virtualized') {
    scrollbar.on('change', config.publishViewport);
    viewport.on('layout-changed', config.publishViewport);
    viewport.on('resized', config.publishViewport);
    config.publishViewport();
    return () => {
      scrollbar.off('change', config.publishViewport);
      viewport.off('layout-changed', config.publishViewport);
      viewport.off('resized', config.publishViewport);
    };
  }

  const scheduler = config.scheduler ?? DEFAULT_SCHEDULER;
  let cancelViewportRead: CancelTask | null = null;
  let nativeReadQueued = false;
  let cancelled = false;
  const scheduleViewportRead = (): void => {
    if (cancelViewportRead !== null) return;
    cancelViewportRead = scheduler.scheduleViewportRead(() => {
      cancelViewportRead = null;
      if (!cancelled) config.publishViewport();
    }, config.viewportReadDelayMs);
  };
  const mirrorNativeScrollbarChange = (): void => {
    if (config.isAppWritePending() || nativeReadQueued) return;
    nativeReadQueued = true;
    scheduler.deferNativeRead(() => {
      nativeReadQueued = false;
      if (!cancelled) config.flushPublish(config.publishNativeScroll);
    });
  };

  scrollbar.on('change', mirrorNativeScrollbarChange);
  viewport.on('layout-changed', scheduleViewportRead);
  viewport.on('resized', scheduleViewportRead);
  config.publishNativeScroll();
  scheduleViewportRead();
  return () => {
    cancelled = true;
    cancelViewportRead?.();
    cancelViewportRead = null;
    scrollbar.off('change', mirrorNativeScrollbarChange);
    viewport.off('layout-changed', scheduleViewportRead);
    viewport.off('resized', scheduleViewportRead);
  };
}
