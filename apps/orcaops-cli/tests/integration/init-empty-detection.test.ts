import { access, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const promptState = vi.hoisted(() => ({ initialAgents: [] as string[] }));

vi.mock('@orcaops/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/adapters')>();
  return { ...actual, detectInstallAgents: vi.fn(async () => []) };
});

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  isCancel: () => false,
  multiselect: vi.fn(async ({ initialValues }: { initialValues: string[] }) => {
    promptState.initialAgents = [...initialValues];
    return initialValues;
  }),
  select: vi.fn(async ({ initialValue }: { initialValue?: unknown }) => initialValue),
  confirm: vi.fn(async () => false),
  text: vi.fn(async ({ initialValue }: { initialValue?: string }) => initialValue ?? 'orcaops'),
}));

describe('interactive init with no detected agents', () => {
  let repo: TempRepo;
  let homeRoot: string;
  let agent: ReturnType<typeof makeAgent>;
  let hadTty: boolean | undefined;
  let hadCi: string | undefined;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    homeRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-empty-detection-'));
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
    promptState.initialAgents = ['not-observed'];
  });

  afterEach(async () => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadTty;
    if (hadCi === undefined) delete process.env.CI;
    else process.env.CI = hadCi;
    await repo.cleanup();
  });

  it('defaults the checklist to empty and creates no agent-home files', async () => {
    const result = await agent.runRaw(['init', '--json', '--no-llm']);
    const output = JSON.parse(result.stdout) as { install_agents: string[]; global: unknown };

    expect(result.exitCode).toBe(0);
    expect(promptState.initialAgents).toEqual([]);
    expect(output.install_agents).toEqual([]);
    expect(output.global).toBeNull();
    expect(await readdir(homeRoot)).toEqual([]);
    await expect(access(path.join(repo.path, 'CLAUDE.local.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
