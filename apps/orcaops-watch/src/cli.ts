export interface CliOptions {
  root?: string;
  intervalMs: number;
  selfcheck: boolean;
  /** Headless: poll one snapshot, print totals as JSON, exit (no rendering). */
  probe: boolean;
}

/** Minimal flag parser for the watch entrypoint. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { intervalMs: 2000, selfcheck: false, probe: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--selfcheck') {
      opts.selfcheck = true;
    } else if (arg === '--probe') {
      opts.probe = true;
    } else if (arg === '--root') {
      opts.root = argv[++i];
    } else if (arg === '--interval') {
      const ms = Number(argv[++i]);
      if (Number.isFinite(ms) && ms > 0) opts.intervalMs = ms;
    }
  }
  return opts;
}
