export interface CliOptions {
  root?: string;
  intervalMs: number;
  /** Headless: print the build version and exit. Wins over every other flag. */
  version: boolean;
  selfcheck: boolean;
  /** Headless: poll one snapshot, print totals as JSON, exit (no rendering). */
  probe: boolean;
}

/** Minimal flag parser for the watch entrypoint. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { intervalMs: 2000, version: false, selfcheck: false, probe: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') {
      opts.version = true;
    } else if (arg === '--selfcheck') {
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

/** The headless modes never touch the terminal; everything else renders. */
export function isHeadless(opts: CliOptions): boolean {
  return opts.version || opts.selfcheck || opts.probe;
}

export const INTERACTIVE_TERMINAL_MESSAGE =
  'orcaops watch needs an interactive terminal (use --probe for a one-shot snapshot)';

/**
 * A render without a terminal on both ends would hang on stdin or spray
 * escape sequences into a pipe; refuse up front.
 */
export function interactiveTerminalProblem(
  opts: CliOptions,
  tty: { stdin: boolean; stdout: boolean }
): string | null {
  if (isHeadless(opts)) return null;
  return tty.stdin && tty.stdout ? null : INTERACTIVE_TERMINAL_MESSAGE;
}
