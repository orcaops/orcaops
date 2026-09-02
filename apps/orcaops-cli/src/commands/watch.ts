import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { CliExit } from '../io/exit.js';
import { writeTerminalSafeStderr } from '../io/output.js';
import { getInvocationEnv } from '../lib/invocation-context.js';

/**
 * `orcaops watch` — a thin delegation stub that spawns the standalone
 * `@orcaops/watch` binary (an OpenTUI app that runs under Bun), keeping its
 * Bun/renderer runtime entirely out of this Node CLI's process.
 *
 * Pass-through args go straight to the child. `--root` is CONSUMED by commander
 * (`addRootOptionRecursively` declares it on this command too), so it never
 * reaches `passThroughArgs`; the caller reads `optsWithGlobals().root` and hands
 * it here, and we re-forward it via the child's `ORCAOPS_ROOT` env — which the
 * watch app reads through the parameterized `resolveExplicitOverride`.
 *
 * The base env is `getInvocationEnv()` (production-equivalent to `process.env`;
 * in the in-process test harness it is the per-invocation ALS env, which is how
 * a test injects `ORCAOPS_WATCH_BIN`).
 */
export function watchAction(passThroughArgs: string[], root: string | undefined): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...getInvocationEnv() };
  if (root !== undefined && root !== '') env.ORCAOPS_ROOT = root;
  const bin = resolveWatchBin(env);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, passThroughArgs, { stdio: 'inherit', env });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        writeTerminalSafeStderr(
          `orcaops watch: could not find the 'orcaops-watch' binary.\n` +
            `Install the watch app (@orcaops/watch) so 'orcaops-watch' is on your PATH, ` +
            `or set ORCAOPS_WATCH_BIN to its location. The watch TUI runs under Bun ` +
            `(https://bun.sh).\n`
        );
        reject(new CliExit(127));
        return;
      }
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (signal !== null) {
        reject(new CliExit(1));
      } else if (code !== null && code !== 0) {
        reject(new CliExit(code));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Resolve the watch binary: `ORCAOPS_WATCH_BIN` override → the sibling of this
 * CLI's own bin (both land in the same `.bin` dir under pnpm and in a global
 * install) → a bare `orcaops-watch` PATH lookup.
 *
 * The sibling candidate is used only when it actually EXISTS: spawning an
 * absolute path forfeits the PATH fallback, so an unchecked sibling guess
 * would hard-fail layouts where the two bins live in different directories
 * (workspace checkouts, split installs) even with `orcaops-watch` on PATH.
 */
export function resolveWatchBin(env: NodeJS.ProcessEnv): string {
  const override = env.ORCAOPS_WATCH_BIN;
  if (override !== undefined && override !== '') return override;
  const argv1 = process.argv[1];
  if (argv1 !== undefined) {
    try {
      const sibling = path.join(path.dirname(realpathSync(argv1)), 'orcaops-watch');
      if (existsSync(sibling)) return sibling;
    } catch {
      // process.argv[1] unresolvable — fall through to a bare PATH lookup.
    }
  }
  return 'orcaops-watch';
}
