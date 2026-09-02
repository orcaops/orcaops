import { type FSWatcher, watch } from 'node:fs';

/**
 * A trailing debouncer: `trigger()` resets a timer, so a burst of calls
 * coalesces into ONE `fn()` `ms` after the last call. Extracted so the debounce
 * is unit-testable with fake timers independent of fs.watch.
 */
export function createDebouncer(
  fn: () => void,
  ms: number
): {
  trigger: () => void;
  cancel: () => void;
} {
  let timer: NodeJS.Timeout | null = null;
  return {
    trigger(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
      timer.unref?.();
    },
    cancel(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export interface FsWatchOptions {
  /** Directories to watch recursively (dataRoot/projects + the hot artifacts dir). */
  roots: string[];
  /** Trailing-debounce window before a burst coalesces into one tick (default 250ms). */
  debounceMs?: number;
  /** Fired (debounced) on any change under a watched root. */
  onTick: () => void;
  /** Fired once when a watcher errors — the caller stays on the poll heartbeat. */
  onDegrade?: (err: Error) => void;
}

/**
 * Recursive fs.watch over the archive projects dir + the hot artifacts dir,
 * debounced into `onTick` (→ engine.tick()). A new top-level project dir simply
 * fires a tick, which the engine turns into a scope rescan. Watchers drop events
 * and meta needs periodic refresh, so the caller KEEPS a (slower) poll tick as a
 * heartbeat; on a watcher error we warn once via onDegrade and rely on the poll.
 */
export class FsWatch {
  private readonly watchers: FSWatcher[] = [];
  private readonly debouncer: ReturnType<typeof createDebouncer>;
  private closed = false;
  private degraded = false;

  constructor(private readonly opts: FsWatchOptions) {
    this.debouncer = createDebouncer(() => {
      if (!this.closed) this.opts.onTick();
    }, opts.debounceMs ?? 250);
  }

  /** Returns true if at least one watcher was established (else caller stays poll-only). */
  start(): boolean {
    for (const root of this.opts.roots) {
      try {
        const w = watch(root, { recursive: true }, () => this.debouncer.trigger());
        w.on('error', (err) => this.degrade(err));
        this.watchers.push(w);
      } catch (err) {
        // A root that simply doesn't exist yet (e.g. a repo that has never
        // opened a review) is skippable, not a degradation — the remaining
        // watchers stay authoritative and the heartbeat covers the gap.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.degrade(err as Error);
      }
    }
    return this.watchers.length > 0 && !this.degraded;
  }

  private degrade(err: Error): void {
    if (this.degraded) return; // warn once
    this.degraded = true;
    this.opts.onDegrade?.(err);
  }

  close(): void {
    this.closed = true;
    this.debouncer.cancel();
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // already closed / never opened
      }
    }
    this.watchers.length = 0;
  }
}
