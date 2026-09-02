import { spawn } from 'node:child_process';

export interface GitLogEntry {
  hash: string;
  message: string;
  author_name: string;
  date: string;
}

export interface GitLog {
  all: GitLogEntry[];
  latest: GitLogEntry | null;
  total: number;
}

/**
 * The slice of git that tests drive directly, over raw spawns.
 *
 * Tests used simple-git for this, but that library sleeps a fixed 50ms after
 * any command that writes nothing to stdout or stderr — which is most of what
 * a fixture does (`add`, `checkout -b`, `reset`, `merge`). Paid once per
 * fixture step across hundreds of tests, it dominated suite wall time.
 *
 * Method names and return shapes mirror the simple-git calls they replaced, so
 * the call sites read unchanged: `revparse` trims, `raw` does not.
 */
export interface GitClient {
  add(files: string | string[]): Promise<void>;
  commit(message: string, options?: Record<string, string | null>): Promise<void>;
  revparse(args: string | string[]): Promise<string>;
  raw(args: string[]): Promise<string>;
  checkout(args: string | string[]): Promise<void>;
  checkoutBranch(branch: string, startPoint: string): Promise<void>;
  checkoutLocalBranch(branch: string): Promise<void>;
  merge(args: string[]): Promise<void>;
  reset(args: string[]): Promise<void>;
  mv(from: string, to: string): Promise<void>;
  tag(args: string[]): Promise<void>;
  addConfig(key: string, value: string): Promise<void>;
  log(): Promise<GitLog>;
}

/** Unit separator. Spelled `%x1f` in the format so the argv stays printable — a
 *  literal control byte in an argument is rejected by Node's spawn. */
const LOG_SEP = '\x1f';

export function gitClient(cwd: string): GitClient {
  const spawnGit = (
    args: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  const fail = (args: string[], code: number | null, detail: string): Error =>
    new Error(`git ${args.join(' ')} failed (exit ${code}): ${detail}`);

  /**
   * Resolve stdout unless git wrote to stderr, mirroring simple-git's failure
   * rule — which keys on stderr, not the exit code. Fixtures depend on the
   * difference: `config --unset` of a missing key exits 5 in silence, and
   * committing a clean tree exits 1 with only stdout. Both are no-ops here.
   *
   * Only for commands whose real failures reach stderr. A command that reports
   * failure on STDOUT — `merge` on a conflict — needs {@link runStrict}, or it
   * resolves and hands the caller a broken repo. That is not hypothetical: it
   * is the bug this split was added to fix.
   */
  const run = async (args: string[]): Promise<string> => {
    const { code, stdout, stderr } = await spawnGit(args);
    if (code !== 0 && stderr.trim().length > 0) throw fail(args, code, stderr.trim());
    return stdout;
  };

  /** Reject on any non-zero exit, reporting whichever stream git explained itself on. */
  const runStrict = async (args: string[]): Promise<string> => {
    const { code, stdout, stderr } = await spawnGit(args);
    if (code !== 0) throw fail(args, code, (stderr.trim() || stdout.trim()) ?? '');
    return stdout;
  };

  return {
    async add(files) {
      await run(['add', ...(Array.isArray(files) ? files : [files])]);
    },
    async commit(message, options) {
      // simple-git took trailing flags as an object whose null values mean
      // "flag with no argument"; the fixtures pass `{ '--allow-empty': null }`.
      const flags = Object.entries(options ?? {}).flatMap(([flag, value]) =>
        value === null ? [flag] : [flag, value]
      );
      await run(['commit', '-m', message, '--quiet', ...flags]);
    },
    async revparse(args) {
      return (await run(['rev-parse', ...(Array.isArray(args) ? args : [args])])).trim();
    },
    raw(args) {
      return run(args);
    },
    async checkout(args) {
      await run(['checkout', ...(Array.isArray(args) ? args : [args])]);
    },
    async checkoutBranch(branch, startPoint) {
      await run(['checkout', '-b', branch, startPoint]);
    },
    async checkoutLocalBranch(branch) {
      await run(['checkout', '-b', branch]);
    },
    async merge(args) {
      // Strict: a conflicted merge exits non-zero with CONFLICT on stdout and
      // nothing on stderr, so the stderr rule would call it a success.
      await runStrict(['merge', ...args]);
    },
    async reset(args) {
      await run(['reset', ...args]);
    },
    async mv(from, to) {
      await run(['mv', from, to]);
    },
    async tag(args) {
      await run(['tag', ...args]);
    },
    async addConfig(key, value) {
      // No unsafe-value gate here, unlike simple-git: callers that set
      // `core.hooksPath` had to opt past that guard, and plain git has none.
      await run(['config', '--local', key, value]);
    },
    async log() {
      const out = await run(['log', '--pretty=format:%H%x1f%s%x1f%an%x1f%aI']);
      const all = out
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const [hash = '', message = '', author_name = '', date = ''] = line.split(LOG_SEP);
          return { hash, message, author_name, date };
        });
      return { all, latest: all[0] ?? null, total: all.length };
    },
  };
}
