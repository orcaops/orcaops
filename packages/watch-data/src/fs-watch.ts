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
  /** Directories to watch recursively (the data root's projects directory). */
  roots: string[];
  /** Individual files to watch (each project database and its write-ahead log). */
  files?: string[];
  /** Trailing-debounce window before a burst coalesces into one tick (default 250ms). */
  debounceMs?: number;
  /** Fired (debounced) on any change under a watched root. */
  onTick: () => void;
  /** Fired once when a watcher errors — the caller stays on the poll heartbeat. */
  onDegrade?: (err: Error) => void;
}

/**
 * Recursive fs.watch over the data root's projects directory, plus a direct
 * watch on each project database file and its write-ahead log, debounced into
 * `onTick` (→ engine.tick()). Both halves are needed: the recursive watch sees a
 * project appear or disappear, but on macOS a commit into an existing database
 * writes only the -wal file and raises no notification on any enclosing
 * directory — a file watch on the log itself is what makes a landed capture
 * visible before the caller's heartbeat. Watchers still drop events, so the
 * caller KEEPS a (slower) poll tick; on a directory watcher error we warn once
 * via onDegrade and rely on the poll.
 */
export class FsWatch {
  private readonly watchers: FSWatcher[] = [];
  private readonly files = new Map<string, FSWatcher>();
  private wanted: string[];
  private readonly debouncer: ReturnType<typeof createDebouncer>;
  private closed = false;
  private degraded = false;

  constructor(private readonly opts: FsWatchOptions) {
    this.wanted = [...(opts.files ?? [])];
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
    this.arm();
    return (this.watchers.length > 0 || this.files.size > 0) && !this.degraded;
  }

  /**
   * Replace the watched file set — the caller passes the engine's current files
   * after each tick, so a project that appeared gets watched and one that is
   * gone stops being. A file that does not exist yet is remembered and armed by
   * a later refresh rather than treated as a fault.
   */
  refresh(files: string[]): void {
    if (this.closed) return;
    this.wanted = [...files];
    const keep = new Set(this.wanted);
    for (const [file, watcher] of this.files)
      if (!keep.has(file)) {
        this.files.delete(file);
        try {
          watcher.close();
        } catch {
          // already gone with the project
        }
      }
    this.arm();
  }

  private arm(): void {
    for (const file of this.wanted) {
      if (this.closed || this.files.has(file)) continue;
      try {
        const watcher = watch(file, (event) => {
          // macOS reports the log being replaced or truncated as `rename`, and
          // the kqueue watch stays bound to the old inode: re-arm before the
          // next commit, and still tick, because the replacement is a change.
          if (event === 'rename') this.rearm(file);
          this.debouncer.trigger();
        });
        watcher.on('error', () => this.rearm(file));
        this.files.set(file, watcher);
      } catch {
        // The database or its log may not exist yet; a later refresh arms it.
      }
    }
  }

  private rearm(file: string): void {
    const watcher = this.files.get(file);
    if (!watcher) return;
    this.files.delete(file);
    try {
      watcher.close();
    } catch {
      // already invalid
    }
    if (!this.closed) this.arm();
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
    for (const watcher of this.files.values()) {
      try {
        watcher.close();
      } catch {
        // already closed / never opened
      }
    }
    this.files.clear();
    this.wanted = [];
  }
}
