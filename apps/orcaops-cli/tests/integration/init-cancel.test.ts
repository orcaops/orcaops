import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const promptState = vi.hoisted(() => ({
  cancelledMessage: '',
  openCustomize: false,
}));
const CANCELLED = Symbol('clack-cancel');

vi.mock('@clack/prompts', () => {
  const cancelled = (message: unknown): boolean =>
    String(message).includes(promptState.cancelledMessage);
  return {
    cancel: vi.fn(),
    isCancel: (value: unknown) => value === CANCELLED,
    multiselect: vi.fn(async ({ message }: { message: string }) => {
      if (cancelled(message)) return CANCELLED;
      return message.startsWith('Which AI coding agents') ? ['claude-code'] : [];
    }),
    select: vi.fn(async ({ message }: { message: string }) => {
      if (cancelled(message)) return CANCELLED;
      if (message.startsWith('Session-start hooks')) return 'static';
      if (message.startsWith('Let orcaops keep a section')) return 'manual';
      if (message.startsWith('Where should')) return 'personal';
      if (message.startsWith('For home-directory')) return 'copy';
      if (message.startsWith('Should the files')) return 'commit';
      return 'project';
    }),
    confirm: vi.fn(async ({ message }: { message: string }) => {
      if (cancelled(message)) return CANCELLED;
      if (message.startsWith('Continue with')) return true;
      if (message.startsWith('Customize more')) return promptState.openCustomize;
      return false;
    }),
    text: vi.fn(async ({ message }: { message: string }) => {
      if (cancelled(message)) return CANCELLED;
      return message.startsWith('Add a reminder') ? '' : 'orcaops';
    }),
  };
});

describe('interactive init cancellation', () => {
  let repo: TempRepo;
  let homeRoot: string;
  let agent: ReturnType<typeof makeAgent>;
  let hadTty: boolean | undefined;
  let hadCi: string | undefined;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    homeRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-init-cancel-'));
    agent = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_DISABLE_DRAIN: '1',
        ORCAOPS_DATA_DIR: path.join(homeRoot, 'data'),
        ORCAOPS_GLOBAL_ROOT: path.join(homeRoot, 'global'),
        CLAUDE_CONFIG_DIR: path.join(homeRoot, 'claude'),
        CODEX_HOME: path.join(homeRoot, 'codex'),
      },
    });
    hadTty = process.stdout.isTTY;
    hadCi = process.env.CI;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    delete process.env.CI;
  });

  afterEach(async () => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadTty;
    if (hadCi === undefined) delete process.env.CI;
    else process.env.CI = hadCi;
    await repo.cleanup();
  });

  it.each([
    ['agent selection', 'Which AI coding agents', false],
    ['session-hook choice', 'Session-start hooks', false],
    ['machine-hook consent', 'Continue with', false],
    ['instruction-file choice', 'Let orcaops keep a section', false],
    ['archive choice', 'Keep a backup', false],
    ['customization choice', 'Customize more', false],
    ['command prefix', 'Name prefix', true],
    ['install scope', 'Where should', true],
    ['link mode', 'For home-directory', true],
    ['generated-file mode', 'Should the files', true],
    ['workflow reminders', 'Pick extra one-line reminders', true],
    ['custom workflow reminder', 'Add a reminder', true],
    ['session-hook registration', 'Which registration carries', true],
    ['git hooks', 'Install git hooks', true],
  ])('cancelling %s aborts before any write', async (_name, message, openCustomize) => {
    promptState.cancelledMessage = message;
    promptState.openCustomize = openCustomize;

    const result = await agent.runRaw(['init', '--json', '--no-llm']);

    expect(result.exitCode).toBe(1);
    await expect(access(path.join(repo.path, '.orcaops'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      spawnSync('git', ['status', '--porcelain'], { cwd: repo.path, encoding: 'utf8' }).stdout
    ).toBe('');
    expect(
      spawnSync('git', ['config', '--local', '--get', 'orcaops.projectid'], {
        cwd: repo.path,
      }).status
    ).not.toBe(0);
    expect(await readdir(homeRoot)).toEqual([]);
    const { cancel } = await import('@clack/prompts');
    expect(cancel).toHaveBeenCalledWith('Nothing was written.');
  });
});
