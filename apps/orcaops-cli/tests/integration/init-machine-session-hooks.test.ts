import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  CODEX_TOML_MARKER_END,
  CODEX_TOML_MARKER_START,
  codexTomlSnippet,
} from '../../src/lib/session-hooks-user.js';
import { makeAgent } from '../support/test-agent.js';

const promptState = vi.hoisted(() => ({
  machineConsent: false,
  agents: ['claude-code'],
  codexChoice: null as string | null,
}));
const CANCELLED = Symbol('clack-cancel');

// The codex representation resolver probes `codex --version`; answering it
// here keeps the surface these tests exercise independent of what is
// installed on the machine, and spawns nothing. No answer (the default) is
// what a machine without codex gives, which keeps codex on config.toml.
const codexVersion = vi.hoisted(() => ({ output: null as string | null }));

vi.mock('@orcaops/evaluator-protocol/subprocess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/evaluator-protocol/subprocess')>();
  return {
    ...actual,
    runBoundedSubprocess: async (
      request: Parameters<typeof actual.runBoundedSubprocess>[0]
    ): ReturnType<typeof actual.runBoundedSubprocess> => {
      const [bin, ...args] = request.argv;
      const probesCodex =
        (bin === 'codex' || bin.endsWith('/codex')) && args.length === 1 && args[0] === '--version';
      if (!probesCodex) return actual.runBoundedSubprocess(request);
      return {
        exit_code: codexVersion.output === null ? 1 : 0,
        signal: null,
        stdout: codexVersion.output ?? '',
        stderr: '',
        duration_ms: 0,
        killed_reason: null,
        spawn_error: null,
        hard_killed: false,
        termination_confirmed: true,
      };
    },
  };
});

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  isCancel: (value: unknown) => value === CANCELLED,
  multiselect: vi.fn(async () => promptState.agents),
  select: vi.fn(async ({ message, initialValue }: { message: string; initialValue?: unknown }) =>
    message.startsWith('Codex registers') && promptState.codexChoice !== null
      ? promptState.codexChoice
      : initialValue
  ),
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
    codexVersion.output = null;
    promptState.machineConsent = false;
    promptState.agents = ['claude-code'];
    promptState.codexChoice = null;
    const prompts = await import('@clack/prompts');
    vi.mocked(prompts.confirm).mockClear();
    vi.mocked(prompts.select).mockClear();
    vi.mocked(prompts.multiselect).mockClear();
  });

  const exists = async (p: string): Promise<boolean> => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };

  afterEach(async () => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadStdoutTty;
    (process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = hadStdinTty;
    if (hadCi === undefined) delete process.env.CI;
    else process.env.CI = hadCi;
    await repo.cleanup();
  });

  it('a declined consent prompt names what the agent still has and how to add the reminder', async () => {
    const prompts = await import('@clack/prompts');
    const result = await agent.runRaw(['init', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(
      vi
        .mocked(prompts.confirm)
        .mock.calls.some(([args]) =>
          (args as { message: string }).message.startsWith('Continue with')
        )
    ).toBe(true);
    // Personal scope owns no instruction file: declining the hook leaves the
    // agent with its global skills and the CLI, and no automatic reminder.
    await expect(access(path.join(repo.path, 'CLAUDE.local.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(path.join(homeRoot, 'claude', 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(result.stdout).not.toContain('Bootstrap section written to:');
    expect(result.stdout).toContain(
      'Machine session hooks were not installed (prompt declined): claude-code keeps its ' +
        'global skills and the orcaops CLI, but gets no automatic session reminder. ' +
        'Run `orcaops session-hooks install` when you want one.'
    );
    expect(result.stdout).not.toContain('interactive terminal');
  });

  it('the declined prompt is reported in the JSON envelope', async () => {
    const result = await agent.runRaw(['init', '--json', '--no-llm']);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      machine_session_hooks: unknown;
      machine_session_hooks_deferred: boolean;
      machine_session_hooks_declined: boolean;
    };
    expect(output.machine_session_hooks).toBeNull();
    expect(output.machine_session_hooks_deferred).toBe(true);
    expect(output.machine_session_hooks_declined).toBe(true);
  });

  it('the manual Codex choice points at the paste and the status command', async () => {
    promptState.machineConsent = true;
    promptState.agents = ['codex'];
    promptState.codexChoice = 'manual';
    const result = await agent.runRaw(['init', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(codexTomlSnippet());
    expect(result.stdout).toContain(
      'Paste the Codex snippet above, then run `orcaops session-hooks status`.'
    );
    expect(result.stdout).not.toContain('interactive terminal');
    await expect(access(path.join(homeRoot, 'codex', 'config.toml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('a refused Codex write points at editing the config rather than a bare re-run', async () => {
    promptState.machineConsent = true;
    promptState.agents = ['codex'];
    const configToml = path.join(homeRoot, 'codex', 'config.toml');
    await mkdir(path.dirname(configToml), { recursive: true });
    await writeFile(configToml, 'hooks = []\n', 'utf8');

    const result = await agent.runRaw(['init', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('in a form orcaops cannot append to');
    expect(result.stdout).toContain(
      `Edit ${configToml} as described above, then re-run \`orcaops session-hooks install\`.`
    );
    expect(result.stdout).not.toContain('interactive terminal');
    expect(await readFile(configToml, 'utf8')).toBe('hooks = []\n');
  });

  it('an unreadable Codex config points at repairing it with the Codex-scoped install', async () => {
    promptState.machineConsent = true;
    promptState.agents = ['codex'];
    const configToml = path.join(homeRoot, 'codex', 'config.toml');
    await mkdir(configToml, { recursive: true });

    const result = await agent.runRaw(['init', '--json', '--no-llm']);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      machine_session_hooks: { codex_outcome: string; live_agents: string[] };
      warnings: string[];
    };
    expect(output.machine_session_hooks.codex_outcome).toBe('refused-unreadable');
    expect(output.machine_session_hooks.live_agents).toEqual([]);
    expect(output.warnings).toContain(
      `${configToml} does not resolve to a regular file — left untouched`
    );

    const textRepo = await createTempRepo({ initialBranch: 'main' });
    const text = await makeAgent({ cwd: textRepo.path, env: envFor(homeRoot) }).runRaw([
      'init',
      '--no-llm',
    ]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      `! ${configToml} does not resolve to a regular file — left untouched`
    );
    expect(text.stdout).toContain(
      `Repair ${configToml} (see the warning above), then re-run \`orcaops session-hooks install --agents codex\`.`
    );
    expect(text.stdout).not.toContain('in an interactive terminal');
    await textRepo.cleanup();
  });

  // Root ignores directory write bits, so the write would not fail.
  it.skipIf(process.getuid?.() === 0)(
    'a Codex config write that fails points at repairing it with the Codex-scoped install',
    async () => {
      promptState.machineConsent = true;
      promptState.agents = ['codex'];
      const seed = '[features]\nshell_snapshots = true\n';
      const lockedDir = path.join(homeRoot, 'locked');
      const lockedToml = path.join(lockedDir, 'config.toml');
      await mkdir(lockedDir, { recursive: true });
      await writeFile(lockedToml, seed, 'utf8');
      const configToml = path.join(homeRoot, 'codex', 'config.toml');
      await mkdir(path.dirname(configToml), { recursive: true });
      await symlink(lockedToml, configToml);
      await chmod(lockedDir, 0o555);

      try {
        const result = await agent.runRaw(['init', '--json', '--no-llm']);
        expect(result.exitCode).toBe(0);
        const output = JSON.parse(result.stdout) as {
          machine_session_hooks: {
            codex_outcome: string;
            live_agents: string[];
            partial_failure: boolean;
          };
          warnings: string[];
        };
        expect(output.machine_session_hooks.codex_outcome).toBe('failed');
        expect(output.machine_session_hooks.live_agents).toEqual([]);
        expect(output.machine_session_hooks.partial_failure).toBe(true);
        expect(output.warnings.join('\n')).toContain(`${configToml} could not be updated (`);

        const textRepo = await createTempRepo({ initialBranch: 'main' });
        const text = await makeAgent({ cwd: textRepo.path, env: envFor(homeRoot) }).runRaw([
          'init',
          '--no-llm',
        ]);
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toContain(`! ${configToml} could not be updated (`);
        expect(text.stdout).toContain(
          `Repair ${configToml} (see the warning above), then re-run \`orcaops session-hooks install --agents codex\`.`
        );
        expect(text.stdout).not.toContain('in an interactive terminal');
        await textRepo.cleanup();
      } finally {
        await chmod(lockedDir, 0o755);
      }
      expect(await readFile(lockedToml, 'utf8')).toBe(seed);
    }
  );

  it('a registration record that cannot be read is left alone and asks for a re-run once it is repaired', async () => {
    promptState.machineConsent = true;
    const recordPath = path.join(homeRoot, 'global', 'hooks.local.json');
    await mkdir(recordPath, { recursive: true });

    const result = await agent.runRaw(['init', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Machine session hooks installed for:\n  + claude-code');
    expect(result.stdout).toContain(`! ${recordPath} could not be read (`);
    expect(result.stdout).toContain(
      'The registration record was not updated (see the warning above); re-run `orcaops session-hooks install` once it is repaired.'
    );
    expect(result.stdout).not.toContain('could not be written');
    expect(result.stdout).not.toContain('in an interactive terminal');
    expect((await stat(recordPath)).isDirectory()).toBe(true);
  });

  it('a registration record that cannot be written asks for a re-run once it is repaired', async () => {
    promptState.machineConsent = true;
    const recordPath = path.join(homeRoot, 'global', 'hooks.local.json');
    await mkdir(path.dirname(recordPath), { recursive: true });
    // A dangling link reads as absent, so the install proceeds to the write,
    // which the record's symlink-free containment refuses.
    await symlink(path.join(homeRoot, 'global', 'missing.json'), recordPath);

    const result = await agent.runRaw(['init', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Machine session hooks installed for:\n  + claude-code');
    expect(result.stdout).toContain(`! ${recordPath} could not be updated (`);
    expect(result.stdout).toContain(
      'The registration record was not updated (see the warning above); re-run `orcaops session-hooks install` once it is repaired.'
    );
    expect(result.stdout).not.toContain('in an interactive terminal');
    expect(await readFile(path.join(homeRoot, 'claude', 'settings.json'), 'utf8')).toContain(
      'SessionStart'
    );
    await expect(access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a --yes project-scope init says machine hooks are registered separately', async () => {
    const result = await agent.runRaw([
      'init',
      '--yes',
      '--no-llm',
      '--scope',
      'project',
      '--session-hooks',
      '--session-hook-entries',
      'none',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Machine session hooks are registered separately from a project-scope init. Run `orcaops session-hooks install` when you want them.'
    );
    expect(result.stdout).not.toContain('in an interactive terminal');
  });

  it('a --yes re-init says machine hooks are not re-offered', async () => {
    const first = await agent.runRaw(['init', '--yes', '--no-llm', '--session-hooks']);
    expect(first.exitCode).toBe(0);

    const again = await agent.runRaw(['init', '--yes', '--no-llm', '--force']);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('(re-initialized;');
    expect(again.stdout).toContain(
      'Machine session hooks are not re-offered by a re-init. Run `orcaops session-hooks install` when you want them.'
    );
    expect(again.stdout).not.toContain('in an interactive terminal');
  });

  it('a skipped Codex chooser names the skip and the agent-scoped install command', async () => {
    promptState.machineConsent = true;
    promptState.agents = ['codex'];
    promptState.codexChoice = 'skip';
    const result = await agent.runRaw(['init', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Action needed:');
    expect(result.stdout).toContain(
      'Codex was skipped. Run `orcaops session-hooks install --agents codex` when you want it.'
    );
    expect(result.stdout).not.toContain('interactive terminal');
    expect(result.stdout).not.toContain('Finish machine registration');
    await expect(access(path.join(homeRoot, 'codex', 'config.toml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('an invalid claude-code settings file points at repairing that file', async () => {
    promptState.machineConsent = true;
    const settingsPath = path.join(homeRoot, 'claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{ not json\n', 'utf8');

    const result = await agent.runRaw(['init', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `! ${settingsPath} is not a valid JSON object — left untouched`
    );
    expect(result.stdout).toContain(
      `Repair ${settingsPath} (see the warning above), then re-run \`orcaops session-hooks install\`.`
    );
    expect(result.stdout).not.toContain('interactive terminal');
    expect(result.stdout).not.toContain('Finish machine registration');
    expect(await readFile(settingsPath, 'utf8')).toBe('{ not json\n');
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
      machine_session_hooks_declined: boolean;
    };
    expect(output.machine_session_hooks).toBeNull();
    expect(output.machine_session_hooks_deferred).toBe(true);
    expect(output.machine_session_hooks_declined).toBe(false);
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

  it('a Codex-only personal init writes the managed block by the default chooser answer', async () => {
    promptState.machineConsent = true;
    promptState.agents = ['codex'];
    const configToml = path.join(homeRoot, 'codex', 'config.toml');
    const features = '[features]\nshell_snapshots = true\n';
    await mkdir(path.dirname(configToml), { recursive: true });
    await writeFile(configToml, features, 'utf8');

    const result = await agent.runRaw(['init', '--json', '--no-llm']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      machine_session_hooks: { codex_outcome: string; live_agents: string[] };
      machine_session_hooks_deferred: boolean;
    };
    expect(output.machine_session_hooks.codex_outcome).toBe('managed-written');
    expect(output.machine_session_hooks.live_agents).toEqual(['codex']);
    expect(output.machine_session_hooks_deferred).toBe(false);

    const prompts = await import('@clack/prompts');
    const chooser = vi
      .mocked(prompts.select)
      .mock.calls.map(([args]) => args as { message: string; initialValue?: unknown })
      .find((args) => args.message.startsWith('Codex registers'));
    expect(chooser?.initialValue).toBe('managed');

    const written = await readFile(configToml, 'utf8');
    expect(written.startsWith(features)).toBe(true);
    expect(written).toContain(CODEX_TOML_MARKER_START);
    expect(written).toContain(codexTomlSnippet());
    expect(await exists(path.join(homeRoot, 'global', 'hooks.local.json'))).toBe(true);
  });

  it('personal init and the standalone install write identical Codex config bytes', async () => {
    promptState.machineConsent = true;
    promptState.agents = ['codex'];
    const seed = '[features]\nshell_snapshots = true\n';
    const inlineToml = path.join(homeRoot, 'codex', 'config.toml');
    await mkdir(path.dirname(inlineToml), { recursive: true });
    await writeFile(inlineToml, seed, 'utf8');
    const inline = await agent.runRaw(['init', '--json', '--no-llm']);
    expect(inline.exitCode).toBe(0);
    const inlineBytes = await readFile(inlineToml, 'utf8');

    const standaloneRepo = await createTempRepo({ initialBranch: 'main' });
    const standaloneHome = await mkdtemp(path.join(tmpdir(), 'orcaops-standalone-codex-'));
    const standaloneToml = path.join(standaloneHome, 'codex', 'config.toml');
    await mkdir(path.dirname(standaloneToml), { recursive: true });
    await writeFile(standaloneToml, seed, 'utf8');
    const standaloneAgent = makeAgent({ cwd: standaloneRepo.path, env: envFor(standaloneHome) });
    const standalone = await standaloneAgent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'codex',
      '--json',
    ]);
    expect(standalone.exitCode).toBe(0);
    const standaloneBytes = await readFile(standaloneToml, 'utf8');

    expect(inlineBytes).not.toBe(seed);
    expect(inlineBytes).toBe(standaloneBytes);
    await standaloneRepo.cleanup();
  });

  it('a Codex build that reads hooks.json registers the sidecar with no chooser', async () => {
    codexVersion.output = 'codex-cli 0.147.0\n';
    promptState.machineConsent = true;
    promptState.agents = ['codex'];

    const result = await agent.runRaw(['init', '--json', '--no-llm']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      machine_session_hooks: { codex_outcome: string | null; live_agents: string[] };
    };
    expect(output.machine_session_hooks.codex_outcome).toBeNull();
    expect(output.machine_session_hooks.live_agents).toEqual(['codex']);

    const prompts = await import('@clack/prompts');
    expect(
      vi
        .mocked(prompts.select)
        .mock.calls.some(([args]) =>
          (args as { message: string }).message.startsWith('Codex registers')
        )
    ).toBe(false);
    expect(await readFile(path.join(homeRoot, 'codex', 'hooks.json'), 'utf8')).toContain(
      'orcaops hook session-start'
    );
    expect(await exists(path.join(homeRoot, 'codex', 'config.toml'))).toBe(false);
  });

  it('a leftover Codex block names the file to clean up and offers the retry', async () => {
    codexVersion.output = 'codex-cli 0.147.0\n';
    promptState.machineConsent = true;
    promptState.agents = ['codex'];
    const configToml = path.join(homeRoot, 'codex', 'config.toml');
    await mkdir(path.dirname(configToml), { recursive: true });
    // Duplicated start markers leave ownership unprovable, so the block stays.
    await writeFile(
      configToml,
      `${CODEX_TOML_MARKER_START}\n${CODEX_TOML_MARKER_START}\n${codexTomlSnippet()}\n${CODEX_TOML_MARKER_END}\n`,
      'utf8'
    );

    const result = await agent.runRaw(['init', '--no-llm']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Action needed:');
    expect(result.stdout).toContain(
      `Codex is registered in ${path.join(homeRoot, 'codex', 'hooks.json')}; delete the leftover ` +
        `orcaops hook in ${configToml} (see the warning above), or re-run ` +
        '`orcaops session-hooks install` to retry the move.'
    );
    expect(await readFile(path.join(homeRoot, 'codex', 'hooks.json'), 'utf8')).toContain(
      'orcaops hook session-start'
    );
    expect(await readFile(configToml, 'utf8')).toContain(codexTomlSnippet());
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
