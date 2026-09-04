import { spawn } from 'node:child_process';

import { CliExit } from '../io/exit.js';
import { writeTerminalSafeStderr } from '../io/output.js';
import { getInvocationEnv } from '../lib/invocation-context.js';
import {
  INTERACTIVE_TERMINAL_MESSAGE,
  liveCompanionInputs,
  needsTerminal,
  reinstallCommand,
  resolveWatchCompanion,
} from '../lib/watch-companion.js';

/**
 * `orcaops watch` — launch the Task Review UI. The UI is a compiled companion
 * this CLI installed (see watch-companion.ts for how it is found and what it
 * is handed); this command only maps the resolution to a process.
 *
 * Pass-through args go straight to the child. `--root` is CONSUMED by commander
 * (`addRootOptionRecursively` declares it on this command too), so it never
 * reaches `passThroughArgs`; the caller reads `optsWithGlobals().root` and hands
 * it here, and we re-forward it via the child's `ORCAOPS_ROOT` env.
 *
 * The base env is `getInvocationEnv()` (production-equivalent to `process.env`;
 * in the in-process test harness it is the per-invocation ALS env, which is how
 * a test injects `ORCAOPS_WATCH_BIN`).
 */
export function watchAction(passThroughArgs: string[], root: string | undefined): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...getInvocationEnv() };
  if (root !== undefined && root !== '') env.ORCAOPS_ROOT = root;
  const inputs = liveCompanionInputs(env);
  const launch = resolveWatchCompanion(inputs);

  if (launch.kind === 'refuse') {
    writeTerminalSafeStderr(`${launch.message}\n`);
    return Promise.reject(new CliExit(launch.exitCode));
  }

  // A render without a terminal on both ends would hang on stdin or spray
  // escape sequences into a pipe. The override tier is a test hook and skips
  // the guard.
  if (
    launch.tier !== 'override' &&
    needsTerminal(passThroughArgs) &&
    !(process.stdin.isTTY === true && process.stdout.isTTY === true)
  ) {
    writeTerminalSafeStderr(`${INTERACTIVE_TERMINAL_MESSAGE}\n`);
    return Promise.reject(new CliExit(1));
  }

  const version = inputs.cliManifest.version;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args, ...passThroughArgs], {
      stdio: 'inherit',
      env: launch.env,
    });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        writeTerminalSafeStderr(
          `orcaops watch: could not start ${launch.command} (not found); ` +
            `reinstall: ${reinstallCommand(version)}\n`
        );
        reject(new CliExit(127));
        return;
      }
      if (code === 'EACCES') {
        writeTerminalSafeStderr(
          `orcaops watch: ${launch.command} is present but this filesystem refuses to execute ` +
            'it (mounted noexec?); check `findmnt -T` on that path or set npm_config_prefix to ' +
            'an executable location.\n'
        );
        reject(new CliExit(127));
        return;
      }
      // Anything else here is a companion that exists but will not exec — a
      // truncated or wrong-architecture download leaves ENOEXEC or a raw errno.
      // Every other companion failure exits 127 with the reinstall line; this
      // used to reject the raw Error and print a minified stack instead.
      writeTerminalSafeStderr(
        `orcaops watch: ${launch.command} could not be started (${code ?? err.message}); ` +
          `the install may be incomplete — reinstall: ${reinstallCommand(version)}\n`
      );
      reject(new CliExit(127));
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
