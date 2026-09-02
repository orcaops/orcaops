export interface LiveRefreshClock {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const SYSTEM_CLOCK: LiveRefreshClock = {
  now: Date.now,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: clearTimeout,
};

/**
 * Coalesce a burst without dropping its trailing state. At most one refresh is
 * in flight and one timer is armed; an event observed during either becomes one
 * authoritative trailing read after the throttle window.
 */
export class LiveRefreshCoordinator {
  private disposed = false;
  private running = false;
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastStartedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly run: () => Promise<void>,
    private readonly throttleMs: number,
    private readonly clock: LiveRefreshClock = SYSTEM_CLOCK
  ) {}

  request(): void {
    if (this.disposed) return;
    this.pending = true;
    if (this.running || this.timer !== null) return;
    const delay = Math.max(0, this.lastStartedAt + this.throttleMs - this.clock.now());
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      void this.start();
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
  }

  private async start(): Promise<void> {
    if (this.disposed || this.running || !this.pending) return;
    this.pending = false;
    this.running = true;
    this.lastStartedAt = this.clock.now();
    try {
      await this.run();
    } finally {
      this.running = false;
      if (this.pending) this.request();
    }
  }
}
