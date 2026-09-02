import type { Command } from 'commander';
import { CommanderError } from 'commander';

import { scrubAndBound } from '@orcaops/core';

import { CliExit, flushStdio } from '../io/exit.js';
import { writeTerminalSafeStderr } from '../io/output.js';
import { runInInvocationContext } from '../lib/invocation-context.js';

export interface RunCliOptions {
  argv?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cloudBaseUrl: string;
}

export async function runCli(program: Command, options: RunCliOptions): Promise<number> {
  try {
    await runInInvocationContext(
      {
        cwd: options.cwd,
        env: options.env,
        cloudBaseUrl: options.cloudBaseUrl,
      },
      () =>
        options.argv
          ? program.parseAsync([...options.argv], { from: 'user' })
          : program.parseAsync()
    );
    return 0;
  } catch (err) {
    if (err instanceof CliExit) {
      await flushStdio();
      return err.code;
    }
    if (err instanceof CommanderError) {
      await flushStdio();
      return err.exitCode;
    }
    writeTerminalSafeStderr(
      `Internal error: ${scrubAndBound((err as Error).stack ?? String(err), 8192)}\n`
    );
    await flushStdio();
    return 1;
  }
}
