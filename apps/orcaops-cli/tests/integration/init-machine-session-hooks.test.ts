import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const promptState = vi.hoisted(() => ({ machineConsent: false }));
const CANCELLED = Symbol('clack-cancel');

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  isCancel: (value: unknown) => value === CANCELLED,
  multiselect: vi.fn(async () => ['claude-code']),
  select: vi.fn(async ({ initialValue }: { initialValue?: unknown }) => initialValue),
  confirm: vi.fn(async ({ message, initialValue }: { message: string; initialValue?: boolean }) =>
    message.startsWith('Continue with') ? promptState.machineConsent : initialValue
  ),
  text: vi.fn(async ({ initialValue }: { initialValue?: string }) => initialValue ?? 'orcaops'),
}));

describe('interactive personal init machine session hooks', () => {
  let repo: TempRepo;
  let homeRoot: string;
  let agent: ReturnType<typeof makeAgent>;
  let hadStdoutTty: boolean | undefined;
  let hadStdinTty: boolean | undefined;
  let hadCi: string | undefined;

  const envFor = (root: string): Record<string, string> => ({
    ORCAOPS_DISABLE_DRAIN: '1',
    ORCAOPS_DATA_DIR: path.join(root, 'data'),
    ORCAOPS_GLOBAL_ROOT: path.join(root, 'global'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CODEX_HOME: path.join(root, 'codex'),
  });

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    homeRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-init-machine-'));
    agent = makeAgent({ cwd: repo.path, env: envFor(homeRoot) });
    hadStdoutTty = process.stdout.isTTY;
    hadStdinTty = process.stdin.isTTY;
    hadCi = process.env.CI;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    delete process.env.CI;
    promptState.machineConsent = false;
    const prompts = await import('@clack/prompts');
    vi.mocked(prompts.confirm).mockClear();
    vi.mocked(prompts.select).mockClear();
    vi.mocked(prompts.multiselect).mockClear();
  });

  afterEach(async () => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadStdoutTty;
    (process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = hadStdinTty;
    if (hadCi === undefined) delete process.env.CI;
    else process.env.CI = hadCi;
    await repo.cleanup();
  });

  it('the all-default interview leaves a live managed bootstrap and names the deferred hook action', async () => {
    const result = await agent.runRaw(['init', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(repo.path, 'CLAUDE.local.md'), 'utf8')).toContain(
      '<!-- orcaops:start'
    );
    await expect(access(path.join(homeRoot, 'claude', 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(result.stdout).toContain('Bootstrap section written to:');
    expect(result.stdout).toContain('CLAUDE.local.md');
    expect(result.stdout).toContain('Action needed:');
    expect(result.stdout).toContain('`orcaops session-hooks install`');
  });

  it('--yes remains non-interactive and never writes machine registration', async () => {
    const prompts = await import('@clack/prompts');
    const result = await agent.runRaw(['init', '--yes', '--json', '--no-llm', '--session-hooks']);

    expect(result.exitCode).toBe(0);
    expect(vi.mocked(prompts.confirm)).not.toHaveBeenCalled();
    expect(vi.mocked(prompts.select)).not.toHaveBeenCalled();
    expect(vi.mocked(prompts.multiselect)).not.toHaveBeenCalled();
    const output = JSON.parse(result.stdout) as {
      machine_session_hooks: unknown;
      machine_session_hooks_deferred: boolean;
    };
    expect(output.machine_session_hooks).toBeNull();
    expect(output.machine_session_hooks_deferred).toBe(true);
    await expect(access(path.join(homeRoot, 'claude', 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('points an enabled Codex-only init to machine registration without re-suggesting the flag', async () => {
    const result = await agent.runRaw([
      'init',
      '--yes',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'codex',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Finish machine registration with `orcaops session-hooks install` in an interactive terminal.'
    );
    expect(result.stdout).not.toContain('Tip: pass `--session-hooks`');
    await expect(access(path.join(homeRoot, 'codex', 'config.toml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses the same apply plan and settings bytes as the standalone consent command', async () => {
    promptState.machineConsent = true;
    const inline = await agent.runRaw(['init', '--json', '--no-llm']);
    const inlineOutput = JSON.parse(inline.stdout) as {
      machine_session_hooks: { plans: Array<{ agent: string; path: string; action: string }> };
    };
    const inlineSettings = await readFile(path.join(homeRoot, 'claude', 'settings.json'), 'utf8');

    const standaloneRepo = await createTempRepo({ initialBranch: 'main' });
    const standaloneHome = await mkdtemp(path.join(tmpdir(), 'orcaops-standalone-machine-'));
    const standaloneAgent = makeAgent({ cwd: standaloneRepo.path, env: envFor(standaloneHome) });
    const standalone = await standaloneAgent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'claude-code',
      '--json',
    ]);
    const standaloneOutput = JSON.parse(standalone.stdout) as {
      plans: Array<{ agent: string; path: string; action: string }>;
    };
    const standaloneSettings = await readFile(
      path.join(standaloneHome, 'claude', 'settings.json'),
      'utf8'
    );

    expect(
      inlineOutput.machine_session_hooks.plans.map(({ agent, action }) => ({ agent, action }))
    ).toEqual(standaloneOutput.plans.map(({ agent, action }) => ({ agent, action })));
    expect(inlineSettings).toBe(standaloneSettings);
    await standaloneRepo.cleanup();
  });

  it('reports a staged apply failure as partial and leaves the hook unclaimed', async () => {
    promptState.machineConsent = true;
    const settingsPath = path.join(homeRoot, 'claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{ not json\n', 'utf8');

    const result = await agent.runRaw(['init', '--json', '--no-llm']);
    const output = JSON.parse(result.stdout) as {
      machine_session_hooks: {
        plans: Array<{ action: string }>;
        live_agents: string[];
        partial_failure: boolean;
      };
      machine_session_hooks_deferred: boolean;
      warnings: string[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.machine_session_hooks.plans).toEqual([
      expect.objectContaining({ action: 'preserved-invalid-json' }),
    ]);
    expect(output.machine_session_hooks.live_agents).toEqual([]);
    expect(output.machine_session_hooks.partial_failure).toBe(true);
    expect(output.machine_session_hooks_deferred).toBe(true);
    expect(output.warnings.join('\n')).toContain('not a valid JSON object');
    await expect(access(path.join(homeRoot, 'global', 'hooks.local.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
