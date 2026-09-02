import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

import { runBoundedSubprocess } from './subprocess.js';

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe('runBoundedSubprocess — spawn ordering', () => {
  it('does not signal a pre-aborted child before its spawn event', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 43_210,
      exitCode: null,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      kill: vi.fn(() => true),
    });
    spawnMock.mockReturnValue(child);
    const processKill = vi.spyOn(process, 'kill').mockImplementation(((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    const controller = new AbortController();
    controller.abort();

    const pending = runBoundedSubprocess({
      argv: ['fake-command'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });
    await Promise.resolve();

    expect(processKill).not.toHaveBeenCalled();

    child.emit('spawn');
    expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');

    await expect(pending).resolves.toMatchObject({
      killed_reason: 'canceled',
      hard_killed: false,
      termination_confirmed: true,
    });
  });
});
