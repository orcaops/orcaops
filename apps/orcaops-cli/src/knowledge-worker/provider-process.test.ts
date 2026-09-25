import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { terminateRetainedProviderProcess } from './provider-process.js';

/**
 * Terminating what a lost attempt recorded. Every test drives a real process:
 * signals, process groups and pid identity do not survive being mocked.
 */

const running: { pid?: number; kill(signal: NodeJS.Signals): boolean }[] = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
});

function sleeper(): { pid: number } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  running.push(child);
  if (child.pid === undefined) throw new Error('the fixture process has no pid');
  return { pid: child.pid };
}

const retained = (pid: number, spawnedAt: string) => ({
  pid,
  process_group_id: pid,
  provider: 'claude',
  spawned_at: spawnedAt,
});

describe('terminating a provider a lost attempt recorded', () => {
  it('reports nothing recorded when the attempt recorded nothing', async () => {
    expect(await terminateRetainedProviderProcess(null)).toEqual({ outcome: 'nothing_recorded' });
    expect(await terminateRetainedProviderProcess({ pid: 'not a pid' })).toEqual({
      outcome: 'nothing_recorded',
    });
  });

  it('stops a recorded group and confirms it is gone', async () => {
    const { pid } = sleeper();

    const outcome = await terminateRetainedProviderProcess(
      retained(pid, new Date(Date.now() + 5_000).toISOString()),
      { graceMs: 200, confirmMs: 500 }
    );

    expect(outcome).toMatchObject({ outcome: 'gone', pid, signalled: true });
  });

  it('reports the provider gone when its pid was handed out again, and signals nothing', async () => {
    const { pid } = sleeper();
    // A pid the operating system handed out again: the number matches, the
    // process does not, and signalling it would kill something unrelated. That
    // the provider released the number is also proof that it ended.
    const outcome = await terminateRetainedProviderProcess(
      retained(pid, new Date(Date.now() - 600_000).toISOString()),
      { graceMs: 200, confirmMs: 500 }
    );

    expect(outcome).toEqual({ outcome: 'gone', pid, signalled: false });
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it('signals nothing when it cannot confirm the recorded process identity', async () => {
    const { pid } = sleeper();

    const outcome = await terminateRetainedProviderProcess(
      retained(pid, new Date().toISOString()),
      { startedBefore: () => 'unknown' }
    );

    expect(outcome).toMatchObject({ outcome: 'not_confirmed', pid });
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it('stops the survivors of a group whose leader has exited', async () => {
    // The leader exits at once, leaving a child in its group.
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref()`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    const pid = leader.pid;
    if (pid === undefined) throw new Error('the fixture process has no pid');
    await new Promise((resolve) => leader.once('exit', resolve));
    running.push({
      kill: (sig) => {
        try {
          return process.kill(-pid, sig);
        } catch {
          return false;
        }
      },
    });
    expect(() => process.kill(-pid, 0)).not.toThrow();

    const outcome = await terminateRetainedProviderProcess(
      retained(pid, new Date().toISOString()),
      { graceMs: 200, confirmMs: 500 }
    );

    expect(outcome).toMatchObject({ outcome: 'gone', pid, signalled: true });
    expect(() => process.kill(-pid, 0)).toThrow();
  });

  it('reports a pid nothing holds as already gone', async () => {
    const { pid } = sleeper();
    process.kill(pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const outcome = await terminateRetainedProviderProcess(
      retained(pid, new Date(Date.now() + 5_000).toISOString()),
      { graceMs: 200, confirmMs: 500 }
    );

    expect(outcome).toMatchObject({ outcome: 'gone' });
  });
});
