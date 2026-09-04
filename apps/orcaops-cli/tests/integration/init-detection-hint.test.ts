import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

interface SeenOption {
  value: string;
  hint?: string;
}

const promptState = vi.hoisted(() => ({
  initialAgents: [] as string[],
  options: [] as SeenOption[],
}));

vi.mock('@orcaops/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/adapters')>();
  return {
    ...actual,
    detectInstallAgents: vi.fn(async () => ['claude-code', 'cursor', 'github-copilot']),
    detectInstallAgentEvidence: vi.fn(async () => [
      { id: 'claude-code', evidence: null },
      { id: 'cursor', evidence: '~/.cursor/cli-config.json' },
      { id: 'github-copilot', evidence: '~/.copilot/config.json' },
    ]),
  };
});

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  isCancel: () => false,
  multiselect: vi.fn(
    async ({ initialValues, options }: { initialValues: string[]; options: SeenOption[] }) => {
      promptState.initialAgents = [...initialValues];
      promptState.options = options.map(({ value, hint }) => ({ value, hint }));
      return [];
    }
  ),
  select: vi.fn(async ({ initialValue }: { initialValue?: unknown }) => initialValue),
  confirm: vi.fn(async () => false),
  text: vi.fn(async ({ initialValue }: { initialValue?: string }) => initialValue ?? 'orcaops'),
}));

describe('interactive init agent checklist hints', () => {
  let repo: TempRepo;
  let homeRoot: string;
  let agent: ReturnType<typeof makeAgent>;
  let hadTty: boolean | undefined;
  let hadCi: string | undefined;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    homeRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-detection-hint-'));
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
    promptState.initialAgents = [];
    promptState.options = [];
  });

  afterEach(async () => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadTty;
    if (hadCi === undefined) delete process.env.CI;
    else process.env.CI = hadCi;
    await repo.cleanup();
  });

  it('names the evidence behind each pre-ticked agent', async () => {
    const result = await agent.runRaw(['init', '--json', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(promptState.initialAgents).toEqual(['claude-code', 'cursor', 'github-copilot']);
    const hints = Object.fromEntries(promptState.options.map((o) => [o.value, o.hint]));
    expect(hints).toMatchObject({
      'claude-code': 'detected',
      cursor: 'detected: ~/.cursor/cli-config.json',
      'github-copilot': 'detected: ~/.copilot/config.json',
    });
    expect(hints.codex).toBeUndefined();
    expect(await readdir(homeRoot)).toEqual([]);
  });
});
