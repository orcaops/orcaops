import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import {
  CODEX_HOOKS_JSON_NOTE,
  CODEX_TOML_MARKER_END,
  CODEX_TOML_MARKER_START,
  codexTomlSnippet,
  planUserSessionHooks,
  readCodexTomlState,
  removeCodexTomlBlock,
  writeCodexTomlBlock,
} from '../../src/lib/session-hooks-user.js';
import { canonicalSessionHookCommand } from '../../src/lib/session-hooks.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * `orcaops session-hooks` — the machine-level registration and THE consent
 * boundary of the invisible install: install is TTY-interactive only, lists
 * exact absolute paths, hard-refuses --yes / non-TTY with zero writes;
 * uninstall restores the pre-consent state record-independently; the merge
 * core preserves user hooks in the co-owned user files.
 */

const CANCELLED = Symbol('clack-cancel');

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(async () => false),
  select: vi.fn(async () => 'skip'),
  isCancel: (v: unknown) => v === CANCELLED,
}));

// `codex --version` is the one resolver input a test cannot state as a file.
// Answering the probe here keeps every case deterministic and spawns nothing;
// the default (no answer) is what a machine without codex on PATH gives, which
// keeps the registration on config.toml.
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

type Mock = ReturnType<typeof vi.fn>;

async function confirmMock(): Promise<Mock> {
  const clack = await import('@clack/prompts');
  return clack.confirm as Mock;
}

async function selectMock(): Promise<Mock> {
  const clack = await import('@clack/prompts');
  return clack.select as Mock;
}

describe('orcaops session-hooks (machine-level registration)', () => {
  let repo: TempRepo;
  let claudeHome: string;
  let codexHome: string;
  let globalRoot: string;
  let agent: ReturnType<typeof makeAgent>;
  let hadTty: boolean | undefined;
  let hadStdinTty: boolean | undefined;
  let hadCi: string | undefined;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    claudeHome = await mkdtemp(path.join(tmpdir(), 'orcaops-uh-claude-'));
    codexHome = await mkdtemp(path.join(tmpdir(), 'orcaops-uh-codex-'));
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-uh-root-'));
    agent = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_DISABLE_DRAIN: '1',
        ORCAOPS_GLOBAL_ROOT: globalRoot,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_HOME: codexHome,
      },
    });
    hadTty = process.stdout.isTTY;
    hadStdinTty = process.stdin.isTTY;
    hadCi = process.env.CI;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    delete process.env.CI;
    codexVersion.output = null;
    (await confirmMock()).mockReset();
    (await confirmMock()).mockImplementation(async () => false);
    (await selectMock()).mockReset();
    (await selectMock()).mockImplementation(async () => 'skip');
  });

  afterEach(async () => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadTty;
    (process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = hadStdinTty;
    if (hadCi !== undefined) process.env.CI = hadCi;
    await repo.cleanup();
  });

  const claudeSettings = (): string => path.join(claudeHome, 'settings.json');
  const codexHooks = (): string => path.join(codexHome, 'hooks.json');
  const recordPath = (): string => path.join(globalRoot, 'hooks.local.json');
  const exists = async (p: string): Promise<boolean> => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };

  it('--yes is HARD-REFUSED with zero writes (the consent boundary)', async () => {
    const r = await agent.runRaw(['session-hooks', 'install', '--yes', '--json']);
    expect(r.exitCode).toBe(1);
    expect(await exists(claudeSettings())).toBe(false);
    expect(await exists(codexHooks())).toBe(false);
    expect(await exists(recordPath())).toBe(false);
  });

  it('non-TTY is refused identically', async () => {
    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    const r = await agent.runRaw(['session-hooks', 'install']);
    expect(r.exitCode).toBe(1);
    expect(await exists(claudeSettings())).toBe(false);
  });

  it('declined consent writes nothing', async () => {
    (await confirmMock()).mockResolvedValueOnce(false);
    const r = await agent.runRaw(['session-hooks', 'install']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Nothing written.');
    expect(await exists(claudeSettings())).toBe(false);
    expect(await exists(recordPath())).toBe(false);
  });

  it('consent lists the exact paths, writes --user entries + the record; a user hook survives', async () => {
    // Pre-seed a user hook in the Claude user settings — the merge must
    // preserve it untouched.
    const userGroup = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] };
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      claudeSettings(),
      `${JSON.stringify({ model: 'opus', hooks: { SessionStart: [userGroup] } }, null, 2)}\n`,
      'utf8'
    );

    (await confirmMock()).mockResolvedValueOnce(true);
    const r = await agent.runRaw(['session-hooks', 'install']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(claudeSettings());
    // With no readable codex version, codex is listed on config.toml; the
    // chooser (fallback: skip) decides the write.
    expect(r.stdout).toContain(path.join(codexHome, 'config.toml'));

    const claude = JSON.parse(await readFile(claudeSettings(), 'utf8')) as {
      model: string;
      hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    // Foreign keys + the user group survive verbatim; ours is appended with --user.
    expect(claude.model).toBe('opus');
    expect(JSON.stringify(claude.hooks.SessionStart[0])).toBe(JSON.stringify(userGroup));
    const ours = claude.hooks.SessionStart.find((g) =>
      g.hooks.some((h) => h.command.includes('orcaops hook session-start'))
    );
    expect(ours).toBeDefined();
    expect(ours!.hooks[0].command).toBe(canonicalSessionHookCommand('claude-code', { user: true }));

    // The config.toml surface never touches the sidecar.
    expect(await exists(codexHooks())).toBe(false);

    const record = JSON.parse(await readFile(recordPath(), 'utf8')) as {
      entries: Array<{ agent: string; path: string }>;
    };
    expect(record.entries.map((e) => e.agent)).toEqual(['claude-code']);
  });

  it('second install is idempotent: unchanged, no restart required', async () => {
    (await confirmMock()).mockResolvedValue(true);
    await agent.runRaw(['session-hooks', 'install']);
    const before = await readFile(claudeSettings(), 'utf8');
    const r = await agent.runRaw(['session-hooks', 'install', '--json']);
    // JSON path still requires consent interactively — mocked true above.
    const out = JSON.parse(r.stdout) as {
      plans: Array<{ action: string }>;
      restart_required: boolean;
    };
    expect(out.plans.every((p) => p.action === 'unchanged')).toBe(true);
    expect(out.restart_required).toBe(false);
    expect(await readFile(claudeSettings(), 'utf8')).toBe(before);
  });

  it('--json routes TTY prompt frames to stderr and emits one stdout document', async () => {
    (await confirmMock()).mockImplementationOnce(
      async (options: { output?: NodeJS.WritableStream }) => {
        options.output?.write('confirm frame\n');
        return true;
      }
    );
    (await selectMock()).mockImplementationOnce(
      async (options: { output?: NodeJS.WritableStream }) => {
        options.output?.write('select frame\n');
        return 'manual';
      }
    );

    const result = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);

    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout).not.toContain('frame');
    expect(result.stderr).toContain('confirm frame');
    expect(result.stderr).toContain('select frame');
  });

  it('preserves a symlinked empty settings file through install and uninstall', async () => {
    const target = path.join(claudeHome, 'settings-target.json');
    await writeFile(target, '{}\n', { encoding: 'utf8', mode: 0o600 });
    await symlink(target, claudeSettings());
    (await confirmMock()).mockResolvedValueOnce(true);

    const install = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'claude-code',
      '--json',
    ]);
    expect(install.exitCode).toBe(0);
    expect((await lstat(claudeSettings())).isSymbolicLink()).toBe(true);
    expect(await readlink(claudeSettings())).toBe(target);
    expect(await readFile(target, 'utf8')).toContain('orcaops hook session-start');
    expect((await stat(target)).mode & 0o777).toBe(0o600);

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect((await lstat(claudeSettings())).isSymbolicLink()).toBe(true);
    expect(await readlink(claudeSettings())).toBe(target);
    expect(await readFile(target, 'utf8')).toBe('{}\n');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('preserves regular-file mode and creates new settings at 0600', async () => {
    await writeFile(claudeSettings(), '{}\n', 'utf8');
    await chmod(claudeSettings(), 0o600);
    (await confirmMock()).mockResolvedValueOnce(true);

    const install = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'claude-code',
      '--json',
    ]);
    expect(install.exitCode).toBe(0);
    expect((await stat(claudeSettings())).mode & 0o777).toBe(0o600);

    await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    (await confirmMock()).mockResolvedValueOnce(true);
    const recreated = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'claude-code',
      '--json',
    ]);
    expect(recreated.exitCode).toBe(0);
    expect((await stat(claudeSettings())).mode & 0o777).toBe(0o600);
  });

  it('refuses a dangling settings symlink with manual repair guidance', async () => {
    const missingTarget = path.join(claudeHome, 'missing-target.json');
    await symlink(missingTarget, claudeSettings());
    (await confirmMock()).mockResolvedValueOnce(true);

    const install = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'claude-code',
      '--json',
    ]);
    const output = JSON.parse(install.stdout) as {
      plans: Array<{ action: string }>;
      warnings: string[];
    };
    expect(install.exitCode).toBe(0);
    expect(output.plans).toEqual([expect.objectContaining({ action: 'preserved-unreadable' })]);
    expect(output.warnings.join('\n')).toContain('dangling symlink');
    expect(output.warnings.join('\n')).toContain('repair or remove the link, then re-run');
    expect((await lstat(claudeSettings())).isSymbolicLink()).toBe(true);
    expect(await exists(missingTarget)).toBe(false);
    expect(await exists(recordPath())).toBe(false);
  });

  it('a selected-agent install preserves unselected settings and registrations', async () => {
    (await confirmMock()).mockResolvedValueOnce(true);
    const claudeInstall = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'claude-code',
    ]);
    expect(claudeInstall.exitCode).toBe(0);
    expect(claudeInstall.stdout).toContain(claudeSettings());
    expect(claudeInstall.stdout).not.toContain(path.join(codexHome, 'config.toml'));
    expect(claudeInstall.stdout).toContain('session-hooks uninstall');
    const claudeBeforeCodex = await readFile(claudeSettings(), 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const codexInstall = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(codexInstall.exitCode).toBe(0);
    expect(codexInstall.stdout).toContain(path.join(codexHome, 'config.toml'));
    expect(codexInstall.stdout).toContain('may modify in managed mode only');
    expect(codexInstall.stdout).not.toContain(claudeSettings());
    expect(await readFile(claudeSettings(), 'utf8')).toBe(claudeBeforeCodex);

    const record = JSON.parse(await readFile(recordPath(), 'utf8')) as {
      entries: Array<{ agent: string }>;
    };
    expect(record.entries.map((entry) => entry.agent)).toEqual(['claude-code', 'codex']);

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect(await exists(claudeSettings())).toBe(false);
    expect(await exists(path.join(codexHome, 'config.toml'))).toBe(false);
    expect(await exists(recordPath())).toBe(false);
  });

  it('status and uninstall honor recorded paths after agent homes change', async () => {
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw(['session-hooks', 'install']);
    expect(install.exitCode).toBe(0);
    const oldClaudePath = claudeSettings();
    const oldCodexPath = path.join(codexHome, 'config.toml');

    const nextClaudeHome = await mkdtemp(path.join(tmpdir(), 'orcaops-uh-next-claude-'));
    const nextCodexHome = await mkdtemp(path.join(tmpdir(), 'orcaops-uh-next-codex-'));
    const movedAgent = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_DISABLE_DRAIN: '1',
        ORCAOPS_GLOBAL_ROOT: globalRoot,
        CLAUDE_CONFIG_DIR: nextClaudeHome,
        CODEX_HOME: nextCodexHome,
      },
    });

    const status = await movedAgent.runRaw(['session-hooks', 'status', '--json']);
    const statusOutput = JSON.parse(status.stdout) as {
      surfaces: Array<{ path: string; state: string }>;
    };
    expect(statusOutput.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: oldClaudePath, state: 'installed' }),
        expect.objectContaining({ path: oldCodexPath, state: 'installed' }),
      ])
    );

    const uninstall = await movedAgent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect(await exists(oldClaudePath)).toBe(false);
    expect(await exists(oldCodexPath)).toBe(false);
    expect(await exists(recordPath())).toBe(false);
  });

  it('uninstall clears absent and foreign records but retains indeterminate paths', async () => {
    const absentPath = path.join(claudeHome, 'missing.json');
    const foreignPath = path.join(claudeHome, 'foreign.json');
    const unreadablePath = path.join(claudeHome, 'settings-directory');
    const foreign = '{"hooks":{"SessionStart":[{"hooks":[{"command":"echo mine"}]}]}}\n';
    await writeFile(foreignPath, foreign, 'utf8');
    await mkdir(unreadablePath);
    await writeFile(
      recordPath(),
      `${JSON.stringify(
        {
          record_version: 1,
          consented_at: '2026-07-30T00:00:00Z',
          cli_version: '0.0.0',
          entries: [
            { agent: 'claude-code', path: absentPath, installed_at: 'x' },
            { agent: 'claude-code', path: foreignPath, installed_at: 'x' },
            { agent: 'claude-code', path: unreadablePath, installed_at: 'x' },
          ],
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    const output = JSON.parse(uninstall.stdout) as { warnings: string[] };
    expect(uninstall.exitCode).toBe(0);
    expect(await readFile(foreignPath, 'utf8')).toBe(foreign);
    expect(output.warnings.join('\n')).toContain('left untouched');
    expect(output.warnings.join('\n')).toContain('retry after restoring access');
    const remaining = JSON.parse(await readFile(recordPath(), 'utf8')) as {
      entries: Array<{ path: string }>;
    };
    expect(remaining.entries.map((entry) => entry.path)).toEqual([unreadablePath]);
  });

  it('uninstall never discards a present record it cannot parse', async () => {
    const malformed = '{"record_version":1,"entries":[';
    await writeFile(recordPath(), malformed, 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'claude-code',
      '--json',
    ]);
    const installOutput = JSON.parse(install.stdout) as { warnings: string[] };
    expect(install.exitCode).toBe(0);
    expect(installOutput.warnings.join('\n')).toContain('left untouched');
    expect(await readFile(recordPath(), 'utf8')).toBe(malformed);

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    const output = JSON.parse(uninstall.stdout) as { warnings: string[] };
    expect(uninstall.exitCode).toBe(0);
    expect(output.warnings.join('\n')).toContain('could not be read');
    expect(output.warnings.join('\n')).toContain('left untouched');
    expect(await readFile(recordPath(), 'utf8')).toBe(malformed);
  });

  it('uninstall strips ours record-independently, preserves the user hook, deletes husks', async () => {
    (await confirmMock()).mockResolvedValueOnce(true);
    // Claude file carries a user hook alongside ours; codex file is ours alone.
    const userGroup = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] };
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      claudeSettings(),
      `${JSON.stringify({ hooks: { SessionStart: [userGroup] } }, null, 2)}\n`,
      'utf8'
    );
    await agent.runRaw(['session-hooks', 'install']);

    const r = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(r.exitCode).toBe(0);
    const claude = JSON.parse(await readFile(claudeSettings(), 'utf8')) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(JSON.stringify(claude.hooks.SessionStart)).toBe(JSON.stringify([userGroup]));
    expect(await exists(recordPath())).toBe(false);
  });

  it('codex managed mode: marker block round-trips through config.toml; invalid TOML refuses', async () => {
    const configToml = path.join(codexHome, 'config.toml');

    // Managed on a FRESH config.toml → marker-owned block written + recorded.
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    let r = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('may modify in managed mode only');
    expect(r.stdout).toContain('session-hooks uninstall');
    expect(r.stdout).not.toContain(claudeSettings());
    const written = await readFile(configToml, 'utf8');
    expect(written).toContain('# >>> orcaops session-hooks >>>');
    expect(written).toContain('orcaops hook session-start --agent codex --user');
    expect(written).not.toContain('[features]');
    const managedState = await runInInvocationContext(
      { env: { ...process.env, CODEX_HOME: codexHome } },
      readCodexTomlState
    );
    expect(managedState).toMatchObject({
      installed: true,
      markerBlock: true,
      markerBlockBroken: false,
      hooksDisabled: false,
    });

    const invalidOutside = `broken = [\n${written}`;
    await writeFile(configToml, invalidOutside, 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    r = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(r.stdout).toContain('is not valid TOML outside the orcaops block');
    expect(r.stdout).toContain('[[hooks.SessionStart]]');
    expect(await readFile(configToml, 'utf8')).toBe(invalidOutside);
    await writeFile(configToml, written, 'utf8');

    const st = await agent.runRaw(['session-hooks', 'status', '--json']);
    const out = JSON.parse(st.stdout) as { surfaces: Array<{ agent: string; state: string }> };
    expect(out.surfaces.find((x) => x.agent === 'codex')?.state).toBe('installed');

    const currentCommand = canonicalSessionHookCommand('codex', { user: true });
    const staleCommand = 'orcaops hook session-start --agent codex --user';
    await writeFile(configToml, written.replace(currentCommand, staleCommand), 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    r = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(r.exitCode).toBe(0);
    const reconciled = await readFile(configToml, 'utf8');
    expect(reconciled).toContain(currentCommand);
    expect(reconciled).not.toContain(`command = "${staleCommand}"`);
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(await readFile(configToml, 'utf8')).toBe(reconciled);

    // Uninstall removes ONLY the marker-owned block (file deleted as a husk).
    r = await agent.runRaw(['session-hooks', 'uninstall', '--yes']);
    expect(r.exitCode).toBe(0);
    expect(await exists(configToml)).toBe(false);

    // An existing [features] table is not our concern: the block is appended
    // after it, the table stays byte-identical, and uninstall restores the
    // original file exactly.
    await mkdir(codexHome, { recursive: true });
    const existing = '[features]\nshell_snapshots = true\n';
    await writeFile(configToml, existing, 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    r = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('paste');
    const appended = await readFile(configToml, 'utf8');
    expect(appended.startsWith(existing)).toBe(true);
    expect(parseToml(appended)).toMatchObject({
      features: { shell_snapshots: true },
      hooks: { SessionStart: [{ matcher: 'startup|resume' }] },
    });
    r = await agent.runRaw(['session-hooks', 'uninstall', '--yes']);
    expect(r.exitCode).toBe(0);
    expect(await readFile(configToml, 'utf8')).toBe(existing);
  });

  it('names the Codex write as created for a fresh config and merged for an existing one', async () => {
    const configToml = path.join(codexHome, 'config.toml');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const fresh = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(fresh.exitCode).toBe(0);
    expect(fresh.stdout).toContain(`created: ${configToml} (marker-owned block)`);
    expect(fresh.stdout).not.toContain('merged into');

    await writeFile(configToml, '[features]\nshell_snapshots = true\n', 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const merged = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(merged.exitCode).toBe(0);
    expect(merged.stdout).toContain(`merged into ${configToml} (marker-owned block)`);
    expect(merged.stdout).not.toContain(`created: ${configToml}`);
  });

  it('a repeat managed Codex install reports the surface as unchanged', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    const written = await readFile(configToml, 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const text = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(`unchanged: ${configToml} (already registered)`);
    expect(text.stdout).not.toContain('marker-owned block');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const json = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(json.exitCode).toBe(0);
    const out = JSON.parse(json.stdout) as {
      plans: Array<{ agent: string; path: string; action: string }>;
      restart_required: boolean;
    };
    expect(out.plans).toEqual([{ agent: 'codex', path: configToml, action: 'unchanged' }]);
    expect(out.restart_required).toBe(false);
    expect(await readFile(configToml, 'utf8')).toBe(written);
  });

  it('a refused Codex write beside a successful claude-code install says Codex needs attention', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    await writeFile(configToml, 'hooks = []\n', 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');

    const r = await agent.runRaw(['session-hooks', 'install', '--agents', 'claude-code,codex']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`created: ${claudeSettings()}`);
    expect(r.stdout).toContain('in a form orcaops cannot append to');
    expect(r.stdout).toContain('Installed for claude-code; Codex needs attention above.');
    expect(r.stdout).toContain('Repos opt in per-repo with `orcaops update --session-hooks`');
    expect(r.stdout).not.toContain('Installed. Repos');
    expect(await readFile(configToml, 'utf8')).toBe('hooks = []\n');
    expect(await exists(claudeSettings())).toBe(true);
  });

  it('appends through a symlinked Codex config and keeps the link and mode', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const target = path.join(codexHome, 'config-target.toml');
    const existing = 'title = "mine"\n';
    await writeFile(target, existing, { encoding: 'utf8', mode: 0o600 });
    await symlink(target, configToml);
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');

    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(install.exitCode).toBe(0);
    expect((await lstat(configToml)).isSymbolicLink()).toBe(true);
    expect(await readlink(configToml)).toBe(target);
    const appended = await readFile(target, 'utf8');
    expect(appended.startsWith(existing)).toBe(true);
    expect(appended).toContain(CODEX_TOML_MARKER_START);
    expect((await stat(target)).mode & 0o777).toBe(0o600);

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect((await lstat(configToml)).isSymbolicLink()).toBe(true);
    expect(await readlink(configToml)).toBe(target);
    expect(await readFile(target, 'utf8')).toBe(existing);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('refuses a dangling Codex config symlink in managed mode', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const missingTarget = path.join(codexHome, 'missing-config.toml');
    await symlink(missingTarget, configToml);
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');

    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    const output = JSON.parse(install.stdout) as { warnings: string[] };
    expect(install.exitCode).toBe(0);
    expect(output.warnings.join('\n')).toContain('dangling symlink');
    expect(output.warnings.join('\n')).toContain('repair or remove the link, then re-run');
    expect((await lstat(configToml)).isSymbolicLink()).toBe(true);
    expect(await exists(missingTarget)).toBe(false);
    expect(await exists(recordPath())).toBe(false);
  });

  it('preserves interleaved Codex config writes at direct and symlinked targets', async () => {
    for (const linked of [false, true]) {
      const configToml = path.join(codexHome, `racing-${linked}.toml`);
      const target = linked ? path.join(codexHome, `racing-target-${linked}.toml`) : configToml;
      const initial = 'title = "before"\n';
      const interleaved = 'title = "written by codex"\n';
      await writeFile(target, initial, 'utf8');
      if (linked) await symlink(target, configToml);

      await expect(
        writeCodexTomlBlock({
          configPath: configToml,
          beforeWrite: async () => writeFile(target, interleaved, 'utf8'),
        })
      ).rejects.toThrow('config.toml changed while editing — re-run');
      expect(await readFile(target, 'utf8')).toBe(interleaved);
      if (linked) expect((await lstat(configToml)).isSymbolicLink()).toBe(true);
    }
  });

  it('treats the recommended manual paste as already registered', async () => {
    const configToml = path.join(codexHome, 'manual-paste.toml');
    const pasted = `title = "mine"\n\n${codexTomlSnippet()}\n`;
    await writeFile(configToml, pasted, 'utf8');

    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('unchanged');
    expect(await readFile(configToml, 'utf8')).toBe(pasted);
  });

  it('appends our entry alongside a user [[hooks.SessionStart]] and removes only ours', async () => {
    const configToml = path.join(codexHome, 'user-session-start.toml');
    const own = '[features]\nhooks = true\n\n[[hooks.SessionStart]]\nmatcher = "startup"\n';
    await writeFile(configToml, own, 'utf8');

    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('written');
    const written = await readFile(configToml, 'utf8');
    expect(written.startsWith(own)).toBe(true);
    expect(parseToml(written)).toMatchObject({
      features: { hooks: true },
      hooks: { SessionStart: [{ matcher: 'startup' }, { matcher: 'startup|resume' }] },
    });

    expect(await removeCodexTomlBlock(configToml)).toBe('removed');
    expect(await readFile(configToml, 'utf8')).toBe(own);
  });

  it('preserves an interleaved Codex config write during managed removal', async () => {
    const configToml = path.join(codexHome, 'racing-remove.toml');
    await writeFile(configToml, 'title = "before"\n', 'utf8');
    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('written');
    const interleaved = 'title = "written by codex"\n';

    await expect(
      removeCodexTomlBlock(configToml, async () => writeFile(configToml, interleaved, 'utf8'))
    ).rejects.toThrow('config.toml changed while editing — re-run');
    expect(await readFile(configToml, 'utf8')).toBe(interleaved);
  });

  it('preserves an interleaved claude settings.json write during reconcile', async () => {
    const settings = claudeSettings();
    const initial = `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`;
    await writeFile(settings, initial, 'utf8');
    const interleaved = `${JSON.stringify({ theme: 'light' }, null, 2)}\n`;

    const result = await runInInvocationContext(
      { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome } },
      () =>
        planUserSessionHooks(['claude-code'], 'apply', 'install', [], async () =>
          writeFile(settings, interleaved, 'utf8')
        )
    );

    expect(result.plans).toEqual([
      expect.objectContaining({ action: 'preserved-unwritable', path: settings }),
    ]);
    expect(result.warnings.join('\n')).toContain('could not be updated');
    expect(await readFile(settings, 'utf8')).toBe(interleaved);
  });

  it('codex managed mode appends beside any [features] spelling and refuses only unparseable or unappendable files', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const appendable = [
      '[ features ]\nshell_snapshots = true\n',
      '["features"]\nshell_snapshots = true\n',
      'features = { shell_snapshots = true }\n',
    ];
    for (const existing of appendable) {
      await writeFile(configToml, existing, 'utf8');
      (await confirmMock()).mockResolvedValueOnce(true);
      (await selectMock()).mockResolvedValueOnce('managed');

      const result = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('paste');
      const written = await readFile(configToml, 'utf8');
      expect(written.startsWith(existing)).toBe(true);
      expect(parseToml(written)).toMatchObject({
        features: { shell_snapshots: true },
        hooks: { SessionStart: [{ matcher: 'startup|resume' }] },
      });
      await rm(configToml);
    }

    await writeFile(configToml, 'features = {\n', 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    let refused = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(refused.exitCode).toBe(0);
    expect(refused.stdout).toContain('is not valid TOML outside the orcaops block');
    expect(refused.stdout).toContain('[[hooks.SessionStart]]');
    expect(await readFile(configToml, 'utf8')).toBe('features = {\n');

    await writeFile(configToml, 'hooks = []\n', 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    refused = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(refused.exitCode).toBe(0);
    expect(refused.stdout).toContain('in a form orcaops cannot append to');
    expect(refused.stdout).toContain('[[hooks.SessionStart]]');
    expect(await readFile(configToml, 'utf8')).toBe('hooks = []\n');
  });

  it('codex managed mode writes beside a disabled feature gate and warns once', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    for (const existing of ['features.hooks = false\n', 'features = { codex_hooks = false }\n']) {
      await writeFile(configToml, existing, 'utf8');
      (await confirmMock()).mockResolvedValueOnce(true);
      (await selectMock()).mockResolvedValueOnce('managed');

      const result = await agent.runRaw([
        'session-hooks',
        'install',
        '--agents',
        'codex',
        '--json',
      ]);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as { warnings: string[] };
      expect(output.warnings).toEqual([
        expect.stringContaining('features.hooks (or codex_hooks) = false, so Codex runs no hook'),
      ]);
      const written = await readFile(configToml, 'utf8');
      expect(written.startsWith(existing)).toBe(true);
      expect(parseToml(written)).toMatchObject({
        hooks: { SessionStart: [{ matcher: 'startup|resume' }] },
      });
      await rm(configToml);
    }
  });

  it('codex managed mode ignores hook commands that sit outside hooks.SessionStart', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const nested = '[unrelated]\nhooks = true\n';
    await writeFile(configToml, nested, 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');

    const result = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);

    expect(result.exitCode).toBe(0);
    const written = await readFile(configToml, 'utf8');
    expect(parseToml(written)).toMatchObject({ unrelated: { hooks: true } });
    expect(parseToml(written)).not.toHaveProperty('features');

    const command = canonicalSessionHookCommand('codex', { user: true });
    await writeFile(configToml, `[unrelated]\nhooks = true\ncommand = "${command}"\n`, 'utf8');
    const status = await agent.runRaw(['session-hooks', 'status', '--json']);
    expect(status.exitCode).toBe(0);
    const output = JSON.parse(status.stdout) as {
      surfaces: Array<{ agent: string; state: string; remedy?: string }>;
    };
    // The install above recorded this path, and a command string under an
    // unrelated table is not a registration.
    const codex = output.surfaces.find((surface) => surface.agent === 'codex');
    expect(codex).toMatchObject({ state: 'registered-but-missing' });
    expect(codex?.remedy).toContain('session-hooks install --agents codex');
    expect(status.stderr).toBe('');
  });

  it('codex status reports hooks disabled for every false spelling of the feature gate', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const disabledGates = [
      'features.hooks = false\n',
      'features = { hooks = false }\n',
      '[ features ]\nhooks = false\n',
      '["features"]\ncodex_hooks = false\n',
      '[features]\nhooks = false\ncodex_hooks = true\n',
    ];
    type Status = { surfaces: Array<{ agent: string; state: string; remedy?: string }> };

    for (const gate of disabledGates) {
      await writeFile(configToml, `${gate}\n${codexTomlSnippet()}\n`, 'utf8');
      const status = await agent.runRaw(['session-hooks', 'status', '--json']);
      expect(status.exitCode).toBe(0);
      expect(status.stderr).toBe('');
      const codex = (JSON.parse(status.stdout) as Status).surfaces.find((s) => s.agent === 'codex');
      expect(codex).toMatchObject({ state: 'registered-but-broken' });
      expect(codex?.remedy).toContain('features.hooks (or codex_hooks) = false');
      expect(codex?.remedy).toContain('set it to true');
      expect(codex?.remedy).not.toContain('session-hooks install');
    }

    // `hooks` wins over its alias, so this spelling runs the hook.
    await writeFile(
      configToml,
      `[features]\nhooks = true\ncodex_hooks = false\n\n${codexTomlSnippet()}\n`,
      'utf8'
    );
    const status = await agent.runRaw(['session-hooks', 'status', '--json']);
    const codex = (JSON.parse(status.stdout) as Status).surfaces.find((s) => s.agent === 'codex');
    expect(codex).toMatchObject({ state: 'installed' });
  });

  it('codex refuses inverted and duplicate marker layouts with line guidance', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const malformed = [
      {
        raw: `setting = true\n${CODEX_TOML_MARKER_END}\n${CODEX_TOML_MARKER_START}\n`,
        lines: '2, 3',
      },
      {
        raw: `${CODEX_TOML_MARKER_START}\n${CODEX_TOML_MARKER_END}\n${CODEX_TOML_MARKER_START}\n`,
        lines: '1, 2, 3',
      },
    ];

    for (const fixture of malformed) {
      await writeFile(configToml, fixture.raw, 'utf8');
      (await confirmMock()).mockResolvedValueOnce(true);
      (await selectMock()).mockResolvedValueOnce('managed');

      const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
      expect(install.exitCode).toBe(0);
      expect(install.stdout).toContain(`marker lines (${fixture.lines})`);
      expect(install.stdout).toContain('remove those complete lines');
      expect(await readFile(configToml, 'utf8')).toBe(fixture.raw);

      const status = await agent.runRaw(['session-hooks', 'status', '--json']);
      const statusOutput = JSON.parse(status.stdout) as {
        surfaces: Array<{ agent: string; state: string; remedy?: string }>;
      };
      const codex = statusOutput.surfaces.find((surface) => surface.agent === 'codex');
      expect(codex).toMatchObject({ state: 'registered-but-broken' });
      expect(codex?.remedy).toContain(`marker lines (${fixture.lines})`);

      const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
      const uninstallOutput = JSON.parse(uninstall.stdout) as { warnings: string[] };
      expect(uninstallOutput.warnings.join('\n')).toContain(`marker lines (${fixture.lines})`);
      expect(await readFile(configToml, 'utf8')).toBe(fixture.raw);
    }
  });

  it('codex repairs and removes a gutted owned block', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const existing = 'note = "mentions # >>> orcaops session-hooks >>> only"\n';
    await writeFile(configToml, existing, 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    const installed = await readFile(configToml, 'utf8');
    const gutted = installed
      .split('\n')
      .filter((line) => !line.startsWith('hooks = [{'))
      .join('\n');
    await writeFile(configToml, gutted, 'utf8');

    const status = await agent.runRaw(['session-hooks', 'status', '--json']);
    const statusOutput = JSON.parse(status.stdout) as {
      surfaces: Array<{ agent: string; state: string; remedy?: string }>;
    };
    const codex = statusOutput.surfaces.find((surface) => surface.agent === 'codex');
    expect(codex).toMatchObject({ state: 'registered-but-broken' });
    expect(codex?.remedy).toContain('session-hooks install --agents codex');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const repair = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(repair.exitCode).toBe(0);
    expect(await readFile(configToml, 'utf8')).toBe(installed);

    await writeFile(configToml, gutted, 'utf8');
    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect(await readFile(configToml, 'utf8')).toBe(existing);
  });

  it('codex managed install and uninstall preserve whitespace outside the owned block', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const existing = 'title = "mine"\n\n\n\n[unrelated]\nvalue = true\n';
    await writeFile(configToml, existing, 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');

    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    const installed = await readFile(configToml, 'utf8');
    expect(installed).toContain('\n\n\n\n[unrelated]');

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect(await readFile(configToml, 'utf8')).toBe(existing);
  });

  it('codex manual mode prints the snippet, writes nothing; a paste is detected but never edited', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('manual');
    let r = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[[hooks.SessionStart]]');
    expect(r.stdout).toContain('orcaops hook session-start --agent codex --user');
    expect(r.stdout).toContain('may modify in managed mode only');
    expect(r.stdout).toContain('session-hooks uninstall');
    expect(r.stdout).not.toContain(claudeSettings());
    expect(await exists(configToml)).toBe(false);
    expect(await exists(recordPath())).toBe(false);

    // Simulate the user pasting it (no orcaops markers): status detects it,
    // uninstall reports it but never edits the user's content.
    await mkdir(codexHome, { recursive: true });
    const pasted = `[features]\nhooks = true\n\n${codexTomlSnippet()}\n`;
    await writeFile(configToml, pasted, 'utf8');
    const st = await agent.runRaw(['session-hooks', 'status', '--json']);
    const out = JSON.parse(st.stdout) as { surfaces: Array<{ agent: string; state: string }> };
    expect(out.surfaces.find((x) => x.agent === 'codex')?.state).toBe('installed');

    r = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(r.exitCode).toBe(0);
    const un = JSON.parse(r.stdout) as { warnings: string[] };
    expect(un.warnings.some((w) => w.includes('never edits content'))).toBe(true);
    expect(await readFile(configToml, 'utf8')).toBe(pasted);
  });

  it('install is unchanged when Codex trust tables sit inside the fence; uninstall keeps them', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const trust = [
      '',
      '[hooks.state]',
      '',
      `[hooks.state."${configToml}:session_start:0:0"]`,
      'trusted_hash = "4f1c2d9e"',
      'enabled = true',
    ].join('\n');
    const fenced = `[features]\nshell_snapshots = true\n\n${CODEX_TOML_MARKER_START}\n${codexTomlSnippet()}\n${trust}\n${CODEX_TOML_MARKER_END}\n`;
    await writeFile(configToml, fenced, 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(install.exitCode).toBe(0);
    expect(await readFile(configToml, 'utf8')).toBe(fenced);

    const status = await agent.runRaw(['session-hooks', 'status', '--json']);
    const surfaces = (
      JSON.parse(status.stdout) as { surfaces: Array<{ agent: string; state: string }> }
    ).surfaces;
    expect(surfaces.find((s) => s.agent === 'codex')?.state).toBe('installed');

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect((JSON.parse(uninstall.stdout) as { warnings: string[] }).warnings).toEqual([]);
    const remaining = await readFile(configToml, 'utf8');
    expect(remaining).not.toContain(CODEX_TOML_MARKER_START);
    expect(remaining).not.toContain('SessionStart');
    expect(parseToml(remaining)).toEqual({
      features: { shell_snapshots: true },
      hooks: {
        state: { [`${configToml}:session_start:0:0`]: { trusted_hash: '4f1c2d9e', enabled: true } },
      },
    });
  });

  it('install is unchanged when a user toggle sits inside a legacy fence; uninstall keeps the toggle', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const legacy = `title = "mine"\n\n${CODEX_TOML_MARKER_START}\n[features]\nhooks = true\nshell_snapshots = true\n\n${codexTomlSnippet()}\n${CODEX_TOML_MARKER_END}\n`;
    await writeFile(configToml, legacy, 'utf8');

    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('unchanged');
    expect(await readFile(configToml, 'utf8')).toBe(legacy);

    expect(await removeCodexTomlBlock(configToml)).toBe('removed');
    const remaining = await readFile(configToml, 'utf8');
    expect(remaining).not.toContain(CODEX_TOML_MARKER_START);
    expect(parseToml(remaining)).toEqual({ title: 'mine', features: { shell_snapshots: true } });
  });

  it('uninstall removes a legacy fence together with its own [features] pair', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const existing = 'title = "mine"\n';
    const legacy = `${existing}\n${CODEX_TOML_MARKER_START}\n[features]\nhooks = true\n\n${codexTomlSnippet()}\n${CODEX_TOML_MARKER_END}\n`;
    await writeFile(configToml, legacy, 'utf8');

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect(await readFile(configToml, 'utf8')).toBe(existing);
  });

  it('repairs a fence whose command is stale without touching Codex tables', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const current = canonicalSessionHookCommand('codex', { user: true });
    const trustKey = `${configToml}:session_start:0:0`;
    const stale = `${CODEX_TOML_MARKER_START}\n${codexTomlSnippet().replace(current, 'orcaops hook session-start --agent codex --user')}\n\n[hooks.state]\n\n[hooks.state."${trustKey}"]\ntrusted_hash = "old"\nenabled = true\n${CODEX_TOML_MARKER_END}\n`;
    await writeFile(configToml, stale, 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const repair = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(repair.exitCode).toBe(0);
    const repaired = await readFile(configToml, 'utf8');
    expect(repaired).not.toContain('command = "orcaops hook session-start --agent codex --user"');
    expect(parseToml(repaired)).toEqual({
      hooks: {
        state: { [trustKey]: { trusted_hash: 'old', enabled: true } },
        SessionStart: [
          { matcher: 'startup|resume', hooks: [{ type: 'command', command: current }] },
        ],
      },
    });
  });

  it('refuses to repair a fence holding lines it cannot prove are its own', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const current = canonicalSessionHookCommand('codex', { user: true });
    const foreign = `${CODEX_TOML_MARKER_START}\n${codexTomlSnippet().replace(current, 'orcaops hook session-start --agent codex --user')}\n\n[[hooks.SessionStart]]\nmatcher = "resume"\nhooks = [{ type = "command", command = "echo mine" }]\n${CODEX_TOML_MARKER_END}\n`;
    await writeFile(configToml, foreign, 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain('lines inside the orcaops block that orcaops did not write');
    expect(install.stdout).toContain('move them outside the markers');
    expect(await readFile(configToml, 'utf8')).toBe(foreign);
    expect(await exists(recordPath())).toBe(false);

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect((JSON.parse(uninstall.stdout) as { warnings: string[] }).warnings.join('\n')).toContain(
      'move them outside the markers'
    );
    expect(await readFile(configToml, 'utf8')).toBe(foreign);
  });

  it('a commented-out paste does not count as registered', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const commented = `${codexTomlSnippet()
      .split('\n')
      .map((line) => `# ${line}`)
      .join('\n')}\n`;
    await writeFile(configToml, commented, 'utf8');

    const status = await agent.runRaw(['session-hooks', 'status', '--json']);
    const surfaces = (
      JSON.parse(status.stdout) as { surfaces: Array<{ agent: string; state: string }> }
    ).surfaces;
    expect(surfaces.find((s) => s.agent === 'codex')?.state).toBe('absent');

    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('written');
    const written = await readFile(configToml, 'utf8');
    expect(written.startsWith(commented)).toBe(true);
    expect(parseToml(written)).toMatchObject({
      hooks: { SessionStart: [{ matcher: 'startup|resume' }] },
    });
  });

  it('a manual paste plus a fence reports registered and installs unchanged', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const both = `${codexTomlSnippet()}\n\n${CODEX_TOML_MARKER_START}\n${codexTomlSnippet()}\n${CODEX_TOML_MARKER_END}\n`;
    await writeFile(configToml, both, 'utf8');

    const status = await agent.runRaw(['session-hooks', 'status', '--json']);
    const surfaces = (
      JSON.parse(status.stdout) as { surfaces: Array<{ agent: string; state: string }> }
    ).surfaces;
    expect(surfaces.find((s) => s.agent === 'codex')?.state).toBe('installed');
    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('unchanged');
    expect(await readFile(configToml, 'utf8')).toBe(both);

    expect(await removeCodexTomlBlock(configToml)).toBe('removed');
    expect(await readFile(configToml, 'utf8')).toBe(`${codexTomlSnippet()}\n`);
  });

  it('appends after a [hooks] table with unrelated keys', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const existing = '[hooks]\nfoo = 1\n';
    await writeFile(configToml, existing, 'utf8');

    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('written');
    const written = await readFile(configToml, 'utf8');
    expect(written.startsWith(existing)).toBe(true);
    expect(parseToml(written)).toMatchObject({
      hooks: { foo: 1, SessionStart: [{ matcher: 'startup|resume' }] },
    });

    expect(await removeCodexTomlBlock(configToml)).toBe('removed');
    expect(await readFile(configToml, 'utf8')).toBe(existing);
  });

  it('CRLF files get a CRLF block and come back byte-identical', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const existing = 'title = "mine"\r\n\r\n[features]\r\nshell_snapshots = true\r\n';
    await writeFile(configToml, existing, 'utf8');

    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('written');
    const written = await readFile(configToml, 'utf8');
    expect(written.startsWith(existing)).toBe(true);
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    expect(written).toContain(`${CODEX_TOML_MARKER_START}\r\n[[hooks.SessionStart]]\r\n`);
    expect(parseToml(written)).toMatchObject({
      hooks: { SessionStart: [{ matcher: 'startup|resume' }] },
    });

    expect(await removeCodexTomlBlock(configToml)).toBe('removed');
    expect(await readFile(configToml, 'utf8')).toBe(existing);
  });

  it('status classifies installed / absent / registered-but-missing', async () => {
    (await confirmMock()).mockResolvedValueOnce(true);
    await agent.runRaw(['session-hooks', 'install', '--agents', 'claude-code']);
    let r = await agent.runRaw(['session-hooks', 'status', '--json']);
    let out = JSON.parse(r.stdout) as {
      surfaces: Array<{ agent: string; state: string }>;
    };
    expect(out.surfaces.find((s) => s.agent === 'claude-code')?.state).toBe('installed');
    expect(out.surfaces.find((s) => s.agent === 'codex')?.state).toBe('absent');

    // A registered file the user deleted → registered-but-missing.
    await writeFile(claudeSettings(), '{}\n', 'utf8');
    r = await agent.runRaw(['session-hooks', 'status', '--json']);
    out = JSON.parse(r.stdout) as typeof out;
    expect(out.surfaces.find((s) => s.agent === 'claude-code')?.state).toBe(
      'registered-but-missing'
    );

    // Human mode names each surface and appends the actionable advisory.
    const human = await agent.runRaw(['session-hooks', 'status']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('registered-but-missing');
    expect(human.stdout).toContain(claudeSettings());
    expect(human.stdout).toContain('re-run `orcaops session-hooks install`');
  });

  it('rejects an unknown agent: error envelope under --json, stderr line otherwise', async () => {
    const asJson = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'not-an-agent',
      '--json',
    ]);
    expect(asJson.exitCode).toBe(1);
    const envelope = JSON.parse(asJson.stdout) as { ok: boolean; error: { message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain('no user-level hook surface for: not-an-agent');

    const human = await agent.runRaw(['session-hooks', 'install', '--agents', 'not-an-agent']);
    expect(human.exitCode).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('no user-level hook surface for: not-an-agent');
    expect(await exists(recordPath())).toBe(false);
  });

  it('doctor evaluates and repairs managed Codex registration health', async () => {
    const binDir = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-codex-bin-'));
    const fakeOrcaops = path.join(binDir, 'orcaops');
    await writeFile(fakeOrcaops, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(fakeOrcaops, 0o755);
    agent = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_DISABLE_DRAIN: '1',
        ORCAOPS_GLOBAL_ROOT: globalRoot,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_HOME: codexHome,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    });
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--session-hook-entries',
      'none',
      '--agents',
      'codex',
    ]);
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);

    type SessionHooksCheck = { name: string; status: string; details?: string[] };
    const doctorCheck = async (): Promise<SessionHooksCheck | undefined> => {
      const doctor = await agent.runRaw(['doctor', '--json']);
      const report = JSON.parse(doctor.stdout) as { checks: SessionHooksCheck[] };
      return report.checks.find((check) => check.name === 'session-hooks');
    };
    expect((await doctorCheck())?.status).toBe('pass');

    const configToml = path.join(codexHome, 'config.toml');
    const healthy = await readFile(configToml, 'utf8');
    const repairable = [
      healthy
        .split('\n')
        .filter((line) => !line.startsWith('hooks = [{'))
        .join('\n'),
      null,
    ];
    for (const broken of repairable) {
      if (broken === null) await rm(configToml);
      else await writeFile(configToml, broken, 'utf8');

      const check = await doctorCheck();
      expect(check?.status).toBe('warn');
      expect((check?.details ?? []).join('\n')).toContain('session-hooks install --agents codex');

      (await confirmMock()).mockResolvedValueOnce(true);
      (await selectMock()).mockResolvedValueOnce('managed');
      const repair = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
      expect(repair.exitCode).toBe(0);
      expect((await doctorCheck())?.status).toBe('pass');
    }

    // A gate the user turned off is reported with the fix, never edited:
    // re-running install leaves the file alone and doctor keeps warning.
    const disabled = `[features]\nhooks = false\n\n${healthy}`;
    await writeFile(configToml, disabled, 'utf8');
    const check = await doctorCheck();
    expect(check?.status).toBe('warn');
    const details = (check?.details ?? []).join('\n');
    expect(details).toContain('features.hooks (or codex_hooks) = false');
    expect(details).toContain('set it to true');
    expect(details).not.toContain('session-hooks install --agents codex');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const rerun = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(rerun.exitCode).toBe(0);
    expect(await readFile(configToml, 'utf8')).toBe(disabled);
    expect((await doctorCheck())?.status).toBe('warn');
  });

  it('doctor names project and machine remedies only for their finding sources', async () => {
    const binDir = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-remedy-bin-'));
    const fakeOrcaops = path.join(binDir, 'orcaops');
    await writeFile(fakeOrcaops, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(fakeOrcaops, 0o755);
    agent = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_DISABLE_DRAIN: '1',
        ORCAOPS_GLOBAL_ROOT: globalRoot,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_HOME: codexHome,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    });
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    await rm(path.join(repo.path, '.claude', 'settings.json'));

    const sessionHookDetails = async (): Promise<string> => {
      const doctor = await agent.runRaw(['doctor', '--json']);
      const report = JSON.parse(doctor.stdout) as {
        checks: Array<{ name: string; details?: string[] }>;
      };
      return (report.checks.find((check) => check.name === 'session-hooks')?.details ?? []).join(
        '\n'
      );
    };

    const projectOnly = await sessionHookDetails();
    expect(projectOnly).toContain('Project entries: run `orcaops update`');
    expect(projectOnly).not.toContain('Machine registration:');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    const configToml = path.join(codexHome, 'config.toml');
    const managed = await readFile(configToml, 'utf8');
    await writeFile(
      configToml,
      managed
        .split('\n')
        .filter((line) => !line.startsWith('hooks = [{'))
        .join('\n'),
      'utf8'
    );

    const mixed = await sessionHookDetails();
    expect(mixed).toContain('Project entries: run `orcaops update`');
    expect(mixed).toContain('Machine registration: run `orcaops session-hooks install`');

    const update = await agent.runRaw(['update', '--json']);
    expect(update.exitCode).toBe(0);
    const machineOnly = await sessionHookDetails();
    expect(machineOnly).not.toContain('Project entries:');
    expect(machineOnly).not.toContain('`orcaops update`');
    expect(machineOnly).toContain('Machine registration: run `orcaops session-hooks install`');
  });

  it('dry-run previews without writing (allowed non-TTY)', async () => {
    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    const r = await agent.runRaw(['session-hooks', 'install', '--dry-run', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { dry_run: boolean; plans: Array<{ action: string }> };
    expect(out.dry_run).toBe(true);
    expect(out.plans.some((p) => p.action === 'created')).toBe(true);
    expect(await exists(claudeSettings())).toBe(false);
  });

  it('--agents codex dry-run (non-TTY --json) names the edit managed mode would make', async () => {
    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    const configToml = path.join(codexHome, 'config.toml');
    type DryRun = {
      dry_run: boolean;
      plans: Array<{ agent: string; path: string; action: string; managed?: string }>;
      warnings: string[];
    };
    const preview = async (): Promise<DryRun> => {
      const r = await agent.runRaw([
        'session-hooks',
        'install',
        '--agents',
        'codex',
        '--dry-run',
        '--json',
      ]);
      expect(r.exitCode).toBe(0);
      return JSON.parse(r.stdout) as DryRun;
    };

    const humanLine = async (): Promise<string> => {
      const r = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--dry-run']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('DRY RUN — nothing written.');
      return r.stdout;
    };

    // Fresh: the chooser can't run in a preview, but the surface must still
    // be named — an empty plans[] would read as "install would do nothing".
    let out = await preview();
    expect(out.dry_run).toBe(true);
    expect(out.plans).toEqual([
      { agent: 'codex', path: configToml, action: 'created', managed: 'append the block' },
    ]);
    expect(out.warnings).toEqual([]);
    expect(await humanLine()).toContain(`created: ${configToml} — append the block`);
    expect(await exists(configToml)).toBe(false);

    // An existing file is appended to, so the preview says updated, not created.
    const features = '[features]\nshell_snapshots = true\n';
    await writeFile(configToml, features, 'utf8');
    out = await preview();
    expect(out.plans).toEqual([
      { agent: 'codex', path: configToml, action: 'updated', managed: 'append the block' },
    ]);
    expect(out.warnings).toEqual([]);
    expect(await humanLine()).toContain(`updated: ${configToml} — append the block`);
    expect(await readFile(configToml, 'utf8')).toBe(features);

    await writeFile(configToml, '  \n\n', 'utf8');
    out = await preview();
    expect(out.plans[0]).toMatchObject({ action: 'created', managed: 'append the block' });

    const pasted = `${codexTomlSnippet()}\n`;
    await writeFile(configToml, pasted, 'utf8');
    out = await preview();
    expect(out.plans).toEqual([
      {
        agent: 'codex',
        path: configToml,
        action: 'unchanged',
        managed: 'unchanged (already registered)',
      },
    ]);
    expect(out.warnings).toEqual([]);
    expect(await humanLine()).toContain(
      `unchanged: ${configToml} — unchanged (already registered)`
    );
    expect(await readFile(configToml, 'utf8')).toBe(pasted);
  });

  it('dry-run names each refusal reason without writing', async () => {
    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    const configToml = path.join(codexHome, 'config.toml');
    const current = canonicalSessionHookCommand('codex', { user: true });
    const cases: Array<{ raw: string; reason: string }> = [
      {
        raw: '[features\nshell_snapshots = true\n',
        reason: 'is not valid TOML outside the orcaops block',
      },
      {
        raw: 'hooks = []\n',
        reason: 'already defines hooks.SessionStart in a form orcaops cannot append to',
      },
      {
        raw: `${CODEX_TOML_MARKER_START}\n${codexTomlSnippet().replace(current, 'orcaops hook session-start --agent codex --user')}\n\n[[hooks.SessionStart]]\nmatcher = "resume"\nhooks = [{ type = "command", command = "echo mine" }]\n${CODEX_TOML_MARKER_END}\n`,
        reason: 'has lines inside the orcaops block that orcaops did not write',
      },
    ];
    for (const { raw, reason } of cases) {
      await writeFile(configToml, raw, 'utf8');
      const json = await agent.runRaw([
        'session-hooks',
        'install',
        '--agents',
        'codex',
        '--dry-run',
        '--json',
      ]);
      expect(json.exitCode).toBe(0);
      const out = JSON.parse(json.stdout) as {
        plans: Array<{ action: string; managed?: string }>;
        warnings: string[];
      };
      expect(out.plans).toHaveLength(1);
      expect(out.plans[0]?.action).toBe('preserved-invalid');
      expect(out.plans[0]?.managed).toMatch(/^refuse: /);
      expect(out.plans[0]?.managed).toContain(reason);
      expect(out.warnings.join('\n')).toContain(
        `managed mode would refuse: ${configToml} ${reason}`
      );
      expect(await readFile(configToml, 'utf8')).toBe(raw);

      const text = await agent.runRaw([
        'session-hooks',
        'install',
        '--agents',
        'codex',
        '--dry-run',
      ]);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain('DRY RUN — nothing written.');
      expect(text.stdout).toContain(
        `preserved-invalid: ${configToml} — refuse: ${configToml} ${reason}`
      );
      expect(text.stdout).not.toContain(`created: ${configToml}`);
      expect(await readFile(configToml, 'utf8')).toBe(raw);
    }
    expect(await exists(recordPath())).toBe(false);
  });

  it('an unparseable config.toml is reported broken with the invalid-TOML remedy, not installed', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const invalidRemedy = `${configToml} is not valid TOML outside the orcaops block — fix it, then re-run`;
    type Status = { surfaces: Array<{ agent: string; state: string; remedy?: string }> };
    const codexStatus = async (): Promise<Status['surfaces'][number] | undefined> => {
      const r = await agent.runRaw(['session-hooks', 'status', '--json']);
      expect(r.exitCode).toBe(0);
      return (JSON.parse(r.stdout) as Status).surfaces.find((s) => s.agent === 'codex');
    };
    type UninstallPreview = { codex: Array<{ path: string; outcome: string }>; warnings: string[] };
    const uninstallPreview = async (): Promise<UninstallPreview> => {
      const r = await agent.runRaw(['session-hooks', 'uninstall', '--dry-run', '--json']);
      expect(r.exitCode).toBe(0);
      return JSON.parse(r.stdout) as UninstallPreview;
    };

    // Not TOML, yet a comment line mentions the command: never "installed".
    const mention = `not toml ===\n# ${codexTomlSnippet().split('\n').join('\n# ')}\n`;
    await writeFile(configToml, mention, 'utf8');
    expect(await codexStatus()).toEqual({
      agent: 'codex',
      path: configToml,
      state: 'registered-but-broken',
      remedy: invalidRemedy,
    });
    const human = await agent.runRaw(['session-hooks', 'status']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(`registered-but-broken    ${configToml}  (codex)`);
    expect(human.stdout).toContain(`! ${invalidRemedy}`);
    expect(human.stdout).not.toContain('installed ');

    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    const install = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'codex',
      '--dry-run',
      '--json',
    ]);
    expect(install.exitCode).toBe(0);
    expect((JSON.parse(install.stdout) as { plans: unknown[] }).plans).toEqual([
      {
        agent: 'codex',
        path: configToml,
        action: 'preserved-invalid',
        managed: `refuse: ${invalidRemedy}`,
      },
    ]);
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;

    // With no fence there is nothing to remove: the mention is the user's to clean up.
    let removal = await uninstallPreview();
    expect(removal.codex).toEqual([{ path: configToml, outcome: 'manual-content' }]);
    expect(removal.warnings.join('\n')).toContain('remove it yourself');
    expect(await readFile(configToml, 'utf8')).toBe(mention);

    await writeFile(configToml, 'not toml ===\n', 'utf8');
    expect(await codexStatus()).toMatchObject({
      state: 'registered-but-broken',
      remedy: invalidRemedy,
    });
    removal = await uninstallPreview();
    expect(removal.codex).toEqual([]);
    expect(removal.warnings).toEqual([]);

    // A recorded managed block whose file later stopped parsing: status and
    // doctor say broken with the same remedy; uninstall refuses to guess.
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    await rm(configToml);
    const managed = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(managed.exitCode).toBe(0);
    const healthy = await readFile(configToml, 'utf8');
    const corrupted = `not toml ===\n${healthy}`;
    await writeFile(configToml, corrupted, 'utf8');
    expect(await codexStatus()).toMatchObject({
      state: 'registered-but-broken',
      remedy: invalidRemedy,
    });
    removal = await uninstallPreview();
    expect(removal.codex).toEqual([{ path: configToml, outcome: 'refused-invalid' }]);
    expect(removal.warnings.join('\n')).toContain(invalidRemedy);
    const uninstallText = await agent.runRaw(['session-hooks', 'uninstall', '--dry-run']);
    expect(uninstallText.stdout).toContain(`refused-invalid: ${configToml}`);
    expect(await readFile(configToml, 'utf8')).toBe(corrupted);

    await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
    const doctor = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; status: string; details?: string[] }>;
    };
    const check = report.checks.find((c) => c.name === 'session-hooks');
    expect(check?.status).toBe('warn');
    const details = (check?.details ?? []).join('\n');
    expect(details).toContain(
      `${configToml}: registered user-level entry is broken — ${invalidRemedy}`
    );
    expect(details).not.toContain('session-hooks install --agents codex');
  });

  it('doctor reports an unrecorded paste inside an unparseable config.toml as broken', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const invalidRemedy = `${configToml} is not valid TOML outside the orcaops block — fix it, then re-run`;
    await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
    const sessionHooksCheck = async (): Promise<{ status?: string; details: string }> => {
      const doctor = await agent.runRaw(['doctor', '--json']);
      const report = JSON.parse(doctor.stdout) as {
        checks: Array<{ name: string; status: string; details?: string[] }>;
      };
      const check = report.checks.find((c) => c.name === 'session-hooks');
      return { status: check?.status, details: (check?.details ?? []).join('\n') };
    };

    // A manual paste, never recorded or fenced, in a file that later stopped parsing.
    await writeFile(configToml, `${codexTomlSnippet()}\nnot toml ===\n`, 'utf8');
    const broken = await sessionHooksCheck();
    expect(broken.status).toBe('warn');
    expect(broken.details).toContain(
      `${configToml}: registered user-level entry is broken — ${invalidRemedy}`
    );
    expect(broken.details).not.toContain('session-hooks install --agents codex');
    expect(await exists(recordPath())).toBe(false);

    // The same unparseable file without any trace of the command is not ours to report.
    await writeFile(configToml, 'not toml ===\n', 'utf8');
    const silent = await sessionHooksCheck();
    expect(silent.details).not.toContain(configToml);
    expect(silent.details).not.toContain('codex');
  });

  it('uninstall dry-run reports what removal would prove without writing', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    type Preview = {
      dry_run: boolean;
      codex: Array<{ path: string; outcome: string }>;
      warnings: string[];
    };
    const preview = async (): Promise<Preview> => {
      const r = await agent.runRaw(['session-hooks', 'uninstall', '--dry-run', '--json']);
      expect(r.exitCode).toBe(0);
      return JSON.parse(r.stdout) as Preview;
    };

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(install.exitCode).toBe(0);
    const clean = await readFile(configToml, 'utf8');
    expect(clean).toContain(CODEX_TOML_MARKER_START);
    let out = await preview();
    expect(out.dry_run).toBe(true);
    expect(out.codex).toEqual([{ path: configToml, outcome: 'removed' }]);
    expect(out.warnings).toEqual([]);
    expect(await readFile(configToml, 'utf8')).toBe(clean);
    expect(await exists(recordPath())).toBe(true);

    const trusted = `[features]\nshell_snapshots = true\n\n${CODEX_TOML_MARKER_START}\n${codexTomlSnippet()}\n\n[hooks.state]\n\n[hooks.state."${configToml}:session_start:0:0"]\ntrusted_hash = "4f1c2d9e"\nenabled = true\n${CODEX_TOML_MARKER_END}\n`;
    await writeFile(configToml, trusted, 'utf8');
    out = await preview();
    expect(out.codex).toEqual([{ path: configToml, outcome: 'removed' }]);
    expect(await readFile(configToml, 'utf8')).toBe(trusted);

    const foreign = `${CODEX_TOML_MARKER_START}\n${codexTomlSnippet()}\n\n[[hooks.SessionStart]]\nmatcher = "resume"\nhooks = [{ type = "command", command = "echo mine" }]\n${CODEX_TOML_MARKER_END}\n`;
    await writeFile(configToml, foreign, 'utf8');
    out = await preview();
    expect(out.codex).toEqual([{ path: configToml, outcome: 'refused-fence' }]);
    expect(out.warnings.join('\n')).toContain('move them outside the markers');
    expect(await readFile(configToml, 'utf8')).toBe(foreign);

    const text = await agent.runRaw(['session-hooks', 'uninstall', '--dry-run']);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('DRY RUN — nothing written.');
    expect(text.stdout).toContain(`refused-fence: ${configToml}`);
    expect(await readFile(configToml, 'utf8')).toBe(foreign);
    expect(await exists(recordPath())).toBe(true);
  });

  it('chooser defaults to managed and the default answer writes the block', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const features = '[features]\nshell_snapshots = true\n';
    await writeFile(configToml, features, 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockImplementationOnce(
      async ({ initialValue }: { initialValue?: unknown }) => initialValue
    );

    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(install.exitCode).toBe(0);

    const chooser = (await selectMock()).mock.calls[0]?.[0] as {
      initialValue: string;
      options: Array<{ value: string; label: string; hint?: string }>;
    };
    expect(chooser.initialValue).toBe('managed');
    expect(chooser.options.map((option) => option.value)).toEqual(['managed', 'manual', 'skip']);
    expect(chooser.options[0]?.label).toContain('(recommended)');
    expect(chooser.options[1]?.label).not.toContain('recommended');
    expect(chooser.options.map((option) => option.hint).join('\n')).not.toContain('root features');

    const written = await readFile(configToml, 'utf8');
    expect(written.startsWith(features)).toBe(true);
    expect(written).toContain(CODEX_TOML_MARKER_START);
    expect(parseToml(written)).toEqual({
      features: { shell_snapshots: true },
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [
              { type: 'command', command: canonicalSessionHookCommand('codex', { user: true }) },
            ],
          },
        ],
      },
    });
    expect(await exists(recordPath())).toBe(true);
  });

  const noteCount = (text: string): number => text.split(CODEX_HOOKS_JSON_NOTE).length - 1;

  it('notes two representations only while both files carry hooks', async () => {
    // Another tool's sidecar beside our config.toml block is exactly what
    // makes Codex report loading hooks from both files.
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    expect(noteCount(install.stdout)).toBe(1);
    expect(install.stdout).not.toContain(`! ${CODEX_HOOKS_JSON_NOTE}`);

    const human = await agent.runRaw(['session-hooks', 'status']);
    expect(noteCount(human.stdout)).toBe(1);
    const st = await agent.runRaw(['session-hooks', 'status', '--json']);
    const out = JSON.parse(st.stdout) as {
      surfaces: Array<{ agent: string; path: string; state: string; note?: string }>;
    };
    expect(out.surfaces.find((row) => row.path === codexConfig())).toMatchObject({
      state: 'installed',
      note: CODEX_HOOKS_JSON_NOTE,
    });

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('manual');
    const manual = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(manual.stdout).toContain('Paste this into');
    expect(noteCount(manual.stdout)).toBe(1);

    // A sidecar Codex loads no hook from is not a second representation.
    for (const sidecar of ['{ not json', '{}\n']) {
      await writeFile(codexHooks(), sidecar, 'utf8');
      expect(noteCount((await agent.runRaw(['session-hooks', 'status'])).stdout)).toBe(0);
    }
  });

  it('hooks.json bytes and mtime are untouched by install and uninstall', async () => {
    const sidecar = '{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[]}]}}\n';
    await writeFile(codexHooks(), sidecar, 'utf8');
    const past = new Date('2024-01-02T03:04:05Z');
    await utimes(codexHooks(), past, past);
    const before = await stat(codexHooks());

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    expect(await readFile(path.join(codexHome, 'config.toml'), 'utf8')).toContain(
      CODEX_TOML_MARKER_START
    );
    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes']);
    expect(uninstall.exitCode).toBe(0);

    const after = await stat(codexHooks());
    expect(await readFile(codexHooks(), 'utf8')).toBe(sidecar);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode).toBe(before.mode);
  });

  it('the hooks.json note follows CODEX_HOME rather than ~/.codex', async () => {
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const plain = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(plain.exitCode).toBe(0);
    expect(noteCount(plain.stdout)).toBe(0);
    expect(noteCount((await agent.runRaw(['session-hooks', 'status'])).stdout)).toBe(0);

    const otherHome = await mkdtemp(path.join(tmpdir(), 'orcaops-uh-codex-other-'));
    await writeFile(path.join(otherHome, 'hooks.json'), supersetHooksJson(), 'utf8');
    const other = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_DISABLE_DRAIN: '1',
        ORCAOPS_GLOBAL_ROOT: globalRoot,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_HOME: otherHome,
      },
    });
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const moved = await other.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(moved.exitCode).toBe(0);
    expect(noteCount(moved.stdout)).toBe(1);
    expect(await exists(path.join(otherHome, 'config.toml'))).toBe(true);
    const status = await other.runRaw(['session-hooks', 'status', '--json']);
    const out = JSON.parse(status.stdout) as {
      surfaces: Array<{ agent: string; path: string; note?: string }>;
    };
    expect(out.surfaces.find((row) => row.path === path.join(otherHome, 'config.toml'))?.note).toBe(
      CODEX_HOOKS_JSON_NOTE
    );
    await rm(otherHome, { recursive: true, force: true });
  });

  it('a hooks.json that is a directory produces no note', async () => {
    await mkdir(codexHooks());
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    expect(noteCount(install.stdout)).toBe(0);
    const status = await agent.runRaw(['session-hooks', 'status']);
    expect(status.exitCode).toBe(0);
    expect(noteCount(status.stdout)).toBe(0);
    expect((await stat(codexHooks())).isDirectory()).toBe(true);
  });

  const SUPPORTED_CODEX_VERSION = 'codex-cli 0.147.0\n';
  const codexConfig = (): string => path.join(codexHome, 'config.toml');
  const supersetHooksJson = (): string =>
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: 'superset notify' }] },
          ],
          SessionEnd: [{ hooks: [{ type: 'command', command: 'superset end' }] }],
        },
      },
      null,
      2
    )}\n`;
  const fencedCodexBlock = (): string =>
    `${CODEX_TOML_MARKER_START}\n${codexTomlSnippet()}\n${CODEX_TOML_MARKER_END}\n`;
  const codexUserCommand = (): string => canonicalSessionHookCommand('codex', { user: true });
  type CodexHooksJson = {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };
  const readCodexHooksJson = async (): Promise<CodexHooksJson> =>
    JSON.parse(await readFile(codexHooks(), 'utf8')) as CodexHooksJson;

  it('moves the Codex registration into an existing hooks.json and carries the approval', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    const oldTrustKey = `${codexConfig()}:session_start:0:0`;
    const supersetTrustKey = `${codexHooks()}:session_start:0:0`;
    const supersetEndTrustKey = `${codexHooks()}:session_end:0:0`;
    await writeFile(
      codexConfig(),
      `model = "gpt-5"\n\n${fencedCodexBlock()}\n` +
        `[hooks.state."${oldTrustKey}"]\ntrusted_hash = "sha256:already-approved"\n\n` +
        `[hooks.state."${supersetTrustKey}"]\ntrusted_hash = "sha256:superset"\nenabled = true\n\n` +
        `[hooks.state."${supersetEndTrustKey}"]\ntrusted_hash = "sha256:superset-end"\n`,
      'utf8'
    );

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain(`~ ${codexHooks()}  (codex; will reconcile this entry)`);
    expect(install.stdout).toContain(
      `- ${codexConfig()}  (codex; the orcaops block is removed from this file)`
    );

    const hooks = await readCodexHooksJson();
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(codexUserCommand());
    expect(hooks.hooks.SessionStart[1].hooks[0].command).toBe('superset notify');
    expect(hooks.hooks.SessionEnd[0].hooks[0].command).toBe('superset end');

    const toml = await readFile(codexConfig(), 'utf8');
    expect(toml).not.toContain(CODEX_TOML_MARKER_START);
    expect(toml).not.toContain('orcaops hook session-start');
    expect(toml).toContain('model = "gpt-5"');
    const state = (
      parseToml(toml) as { hooks: { state: Record<string, { trusted_hash: string }> } }
    ).hooks.state;
    expect(state[supersetTrustKey].trusted_hash).toBe('sha256:already-approved');
    expect(state[oldTrustKey].trusted_hash).toBe('sha256:already-approved');
    // Superset's group moved from index 0 to 1, and its approval with it.
    expect(state[`${codexHooks()}:session_start:1:0`]).toEqual({
      trusted_hash: 'sha256:superset',
      enabled: true,
    });
    expect(state[supersetEndTrustKey].trusted_hash).toBe('sha256:superset-end');

    expect(install.stdout).toContain(`updated: ${codexHooks()} (joined existing hooks.json)`);
    expect(install.stdout).toContain(`removed: ${codexConfig()} (marker block moved)`);
    expect(install.stdout).toContain('approval you already gave this hook moved with it');
    expect(install.stdout).toContain('1 approval already given to another hook moved with it');

    const record = JSON.parse(await readFile(recordPath(), 'utf8')) as {
      entries: Array<{ agent: string; path: string }>;
    };
    expect(record.entries.map(({ agent, path: p }) => ({ agent, path: p }))).toEqual([
      { agent: 'codex', path: codexHooks() },
    ]);
  });

  it('completes the move when the hook was never approved, and says it is reviewed once', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    await writeFile(codexConfig(), `model = "gpt-5"\n\n${fencedCodexBlock()}`, 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain(`removed: ${codexConfig()} (marker block moved)`);
    expect(install.stdout).toContain('Codex reviews the entry once in its new file');
    expect(install.stdout).not.toContain('approval you already gave this hook moved with it');

    const toml = await readFile(codexConfig(), 'utf8');
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).not.toContain(CODEX_TOML_MARKER_START);
    expect(toml).not.toContain('orcaops hook session-start');
    expect((await readCodexHooksJson()).hooks.SessionStart[0].hooks[0].command).toBe(
      codexUserCommand()
    );
  });

  it("re-keys another tool's approval even when config.toml never registered orcaops", async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    const supersetTrustKey = `${codexHooks()}:session_start:0:0`;
    await writeFile(
      codexConfig(),
      `model = "gpt-5"\n\n[hooks.state."${supersetTrustKey}"]\ntrusted_hash = "sha256:superset"\n`,
      'utf8'
    );

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);

    const hooks = await readCodexHooksJson();
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(codexUserCommand());
    const state = (
      parseToml(await readFile(codexConfig(), 'utf8')) as {
        hooks: { state: Record<string, { trusted_hash: string }> };
      }
    ).hooks.state;
    expect(state[`${codexHooks()}:session_start:1:0`].trusted_hash).toBe('sha256:superset');
    expect(state[supersetTrustKey]).toBeUndefined();
    expect(install.stdout).toContain('1 approval already given to another hook moved with it');
  });

  it('drops a stale entry of ours, retires its dead approval, and leaves the group behind it keyed as it was', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    // A previous release registered the same command under a narrower matcher,
    // so Codex trusts it as a hook of its own and the reconcile drops it.
    await writeFile(
      codexHooks(),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [{ type: 'command', command: codexUserCommand() }],
              },
              { matcher: 'startup', hooks: [{ type: 'command', command: 'superset notify' }] },
            ],
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    const staleTrustKey = `${codexHooks()}:session_start:0:0`;
    const supersetTrustKey = `${codexHooks()}:session_start:1:0`;
    await writeFile(
      codexConfig(),
      `model = "gpt-5"\n\n[hooks.state."${staleTrustKey}"]\ntrusted_hash = "sha256:stale-ours"\n\n` +
        `[hooks.state."${supersetTrustKey}"]\ntrusted_hash = "sha256:superset"\n`,
      'utf8'
    );

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);

    const hooks = await readCodexHooksJson();
    expect(hooks.hooks.SessionStart).toHaveLength(2);
    expect(hooks.hooks.SessionStart[0]).toMatchObject({ matcher: 'startup|resume' });
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(codexUserCommand());
    expect(hooks.hooks.SessionStart[1].hooks[0].command).toBe('superset notify');

    const state = (
      parseToml(await readFile(codexConfig(), 'utf8')) as {
        hooks: { state: Record<string, { trusted_hash: string }> };
      }
    ).hooks.state;
    expect(state[supersetTrustKey].trusted_hash).toBe('sha256:superset');
    expect(state[staleTrustKey]).toBeUndefined();
    expect(state[`${codexHooks()}:session_start:2:0`]).toBeUndefined();
    expect(await readFile(codexConfig(), 'utf8')).toContain('model = "gpt-5"');
    expect(install.stdout).not.toContain('already given to another hook moved with it');
  });

  it("keeps another tool's approval when its hook shares a group with ours", async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    // A user appended our command into Superset's own group, so the reconcile
    // rewrites that group around the hook it keeps instead of dropping it.
    await writeFile(
      codexHooks(),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [
                  { type: 'command', command: 'superset notify' },
                  { type: 'command', command: codexUserCommand() },
                ],
              },
            ],
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    const supersetTrustKey = `${codexHooks()}:session_start:0:0`;
    const supersetEndTrustKey = `${codexHooks()}:session_end:0:0`;
    await writeFile(
      codexConfig(),
      `model = "gpt-5"\n\n[hooks.state."${supersetTrustKey}"]\ntrusted_hash = "sha256:superset"\nenabled = true\n\n` +
        `[hooks.state."${supersetEndTrustKey}"]\ntrusted_hash = "sha256:superset-end"\n`,
      'utf8'
    );

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);

    const hooks = await readCodexHooksJson();
    expect(hooks.hooks.SessionStart).toHaveLength(2);
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(codexUserCommand());
    expect(hooks.hooks.SessionStart[1].hooks).toHaveLength(1);
    expect(hooks.hooks.SessionStart[1].hooks[0].command).toBe('superset notify');

    const state = (
      parseToml(await readFile(codexConfig(), 'utf8')) as {
        hooks: { state: Record<string, { trusted_hash: string; enabled?: boolean }> };
      }
    ).hooks.state;
    expect(state).toEqual({
      [`${codexHooks()}:session_start:1:0`]: {
        trusted_hash: 'sha256:superset',
        enabled: true,
      },
      [supersetEndTrustKey]: { trusted_hash: 'sha256:superset-end' },
    });
    expect(install.stdout).toContain('1 approval already given to another hook moved with it');
  });

  it('a config.toml block that cannot be removed keeps both and records only hooks.json', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    // A duplicated start marker leaves ownership unprovable, so the removal
    // refuses and the registration must stay live in both files.
    const unremovable = `${CODEX_TOML_MARKER_START}\n${fencedCodexBlock()}`;
    await writeFile(codexConfig(), unremovable, 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(install.exitCode).toBe(0);
    const output = JSON.parse(install.stdout) as {
      codex_migration: string | null;
      warnings: string[];
    };
    expect(output.codex_migration).toBe('kept-duplicate');
    expect(output.warnings.join('\n')).toContain('malformed or duplicate orcaops marker lines');
    expect(output.warnings.join('\n')).toContain('both are live until it is cleaned up');

    expect(await readFile(codexConfig(), 'utf8')).toBe(unremovable);
    expect((await readCodexHooksJson()).hooks.SessionStart[0].hooks[0].command).toBe(
      codexUserCommand()
    );
    const record = JSON.parse(await readFile(recordPath(), 'utf8')) as {
      entries: Array<{ agent: string; path: string }>;
    };
    expect(record.entries.map((entry) => entry.path)).toEqual([codexHooks()]);
  });

  it('an approval that cannot move to its new key keeps both and names the file to clean up', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    // Superset's approval is written inline, so it has no table to relocate:
    // it stays on the key our entry moves onto, holding a hash of its own, and
    // the edit refuses rather than overwrite it.
    const seed =
      `model = "gpt-5"\n\n[hooks.state]\n"${codexHooks()}:session_start:0:0" = { trusted_hash = "sha256:superset" }\n\n` +
      `${fencedCodexBlock()}\n[hooks.state."${codexConfig()}:session_start:0:0"]\ntrusted_hash = "sha256:already-approved"\n`;
    await writeFile(codexConfig(), seed, 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(install.exitCode).toBe(0);
    const output = JSON.parse(install.stdout) as {
      codex_migration: string | null;
      codex_trust_carry: string | null;
      warnings: string[];
    };
    expect(output.codex_migration).toBe('kept-duplicate');
    expect(output.codex_trust_carry).toBe('refused');
    const warnings = output.warnings.join('\n');
    expect(warnings).toContain(`could not be moved to its ${codexHooks()} key`);
    expect(warnings).toContain(`the older registration in ${codexConfig()} is still there`);
    expect(warnings).toContain('re-run `orcaops session-hooks install` to retry the move');

    expect(await readFile(codexConfig(), 'utf8')).toBe(seed);
    expect((await readCodexHooksJson()).hooks.SessionStart[0].hooks[0].command).toBe(
      codexUserCommand()
    );
  });

  // Root ignores directory write bits, so the trust write would not fail.
  it.skipIf(process.getuid?.() === 0)(
    'a trust write that fails keeps both registrations',
    async () => {
      codexVersion.output = SUPPORTED_CODEX_VERSION;
      await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
      const lockedDir = await mkdtemp(path.join(tmpdir(), 'orcaops-uh-locked-'));
      const lockedToml = path.join(lockedDir, 'config.toml');
      const seed =
        `model = "gpt-5"\n\n${fencedCodexBlock()}\n` +
        `[hooks.state."${codexConfig()}:session_start:0:0"]\ntrusted_hash = "sha256:already-approved"\n`;
      await writeFile(lockedToml, seed, 'utf8');
      await symlink(lockedToml, codexConfig());
      await chmod(lockedDir, 0o555);

      try {
        (await confirmMock()).mockResolvedValueOnce(true);
        const install = await agent.runRaw([
          'session-hooks',
          'install',
          '--agents',
          'codex',
          '--json',
        ]);
        expect(install.exitCode).toBe(0);
        const output = JSON.parse(install.stdout) as {
          codex_migration: string | null;
          codex_trust_carry: string | null;
          warnings: string[];
        };
        expect(output.codex_migration).toBe('kept-duplicate');
        expect(output.codex_trust_carry).toBe('failed');
        expect(output.warnings.join('\n')).toContain(
          `${codexConfig()} could not be updated with the Codex approvals the move carries`
        );
        expect(await readFile(lockedToml, 'utf8')).toBe(seed);
        expect((await readCodexHooksJson()).hooks.SessionStart[0].hooks[0].command).toBe(
          codexUserCommand()
        );
      } finally {
        await chmod(lockedDir, 0o755);
        await rm(lockedDir, { recursive: true, force: true });
      }
    }
  );

  it('a Codex build that cannot be shown to read hooks.json stays in config.toml and says why', async () => {
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const unknown = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(unknown.exitCode).toBe(0);
    expect(unknown.stdout).toContain('`codex --version` could not be read');
    expect(unknown.stdout).toContain(codexConfig());
    expect(await readFile(codexConfig(), 'utf8')).toContain(codexTomlSnippet());
    expect(await readFile(codexHooks(), 'utf8')).toBe(supersetHooksJson());

    await rm(codexConfig(), { force: true });
    codexVersion.output = 'codex-cli 0.140.0\n';
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const old = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(old.exitCode).toBe(0);
    expect(old.stdout).toContain('older than 0.146.0');
    expect(await readFile(codexConfig(), 'utf8')).toContain(codexTomlSnippet());
  });

  it('--representation config-toml writes the fence even where hooks.json exists', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'codex',
      '--representation',
      'config-toml',
    ]);
    expect(install.exitCode).toBe(0);
    expect(await readFile(codexConfig(), 'utf8')).toContain(codexTomlSnippet());
    expect(await readFile(codexHooks(), 'utf8')).toBe(supersetHooksJson());
  });

  it('rejects a --representation value that is neither surface', async () => {
    const asJson = await agent.runRaw([
      'session-hooks',
      'install',
      '--representation',
      'toml',
      '--json',
    ]);
    expect(asJson.exitCode).toBe(1);
    const envelope = JSON.parse(asJson.stdout) as { ok: boolean; error: { message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain('unknown --representation: toml');

    const human = await agent.runRaw(['session-hooks', 'install', '--representation', 'toml']);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain('unknown --representation: toml');
    expect(await exists(codexConfig())).toBe(false);
    expect(await exists(codexHooks())).toBe(false);
  });

  it('--representation hooks-json overrides a failed version gate and warns', async () => {
    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'codex',
      '--representation',
      'hooks-json',
    ]);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain('--representation hooks-json overrides the version gate');
    expect(install.stdout).not.toContain(codexConfig());
    expect((await readCodexHooksJson()).hooks.SessionStart[0].hooks[0].command).toBe(
      codexUserCommand()
    );
    expect(await exists(codexConfig())).toBe(false);
  });

  it('uninstall after the move strips our group and leaves the Superset file intact', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    await writeFile(codexConfig(), fencedCodexBlock(), 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    // The fence was the whole file, so the move leaves nothing behind.
    expect(await exists(codexConfig())).toBe(false);

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes']);
    expect(uninstall.exitCode).toBe(0);
    expect(uninstall.stdout).toContain(`removed: ${codexHooks()}`);
    expect(await readFile(codexHooks(), 'utf8')).toBe(supersetHooksJson());
    expect(await exists(recordPath())).toBe(false);
  });

  it('dry-run on the hooks.json surface names the sidecar and the block the move would take', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    await writeFile(codexConfig(), fencedCodexBlock(), 'utf8');

    const r = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'codex',
      '--dry-run',
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      plans: Array<{ path: string; action: string; managed?: string }>;
    };
    expect(out.plans).toEqual([
      expect.objectContaining({ path: codexHooks(), action: 'updated' }),
      expect.objectContaining({
        path: codexConfig(),
        action: 'removed',
        managed: 'move the registration out of config.toml',
      }),
    ]);
    expect(await readFile(codexHooks(), 'utf8')).toBe(supersetHooksJson());
    expect(await readFile(codexConfig(), 'utf8')).toBe(fencedCodexBlock());
  });

  it('shows the managed/manual chooser for config.toml and never for hooks.json', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    (await confirmMock()).mockResolvedValueOnce(true);
    const sidecar = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(sidecar.exitCode).toBe(0);
    expect(await exists(codexHooks())).toBe(true);
    expect(await selectMock()).not.toHaveBeenCalled();

    codexVersion.output = null;
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const toml = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(toml.exitCode).toBe(0);
    expect(
      (await selectMock()).mock.calls.some(([args]) =>
        (args as { message: string }).message.startsWith('Codex registers')
      )
    ).toBe(true);
    expect(await readFile(codexConfig(), 'utf8')).toContain(codexTomlSnippet());
  });

  // Doctor is a repo-context command, so every case below initializes the repo
  // AFTER registering the machine surfaces it is meant to report on.
  const sessionHookDoctorCheck = async (): Promise<{ status?: string; details: string }> => {
    await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
    const doctor = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; status: string; details?: string[] }>;
    };
    const check = report.checks.find((c) => c.name === 'session-hooks');
    return { status: check?.status, details: (check?.details ?? []).join('\n') };
  };

  it('doctor warns about the config.toml block a refused removal left behind', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    // A hand-pasted registration carries no markers, so orcaops may not remove
    // it: the move leaves both files registering the hook.
    const pasted = `${codexTomlSnippet()}\n`;
    await writeFile(codexConfig(), pasted, 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    expect(await readFile(codexConfig(), 'utf8')).toBe(pasted);

    const status = await agent.runRaw(['session-hooks', 'status', '--json']);
    const surfaces = (
      JSON.parse(status.stdout) as {
        surfaces: Array<{ path: string; state: string; remedy?: string }>;
      }
    ).surfaces;
    expect(surfaces.find((row) => row.path === codexConfig())?.state).toBe('superseded');

    const check = await sessionHookDoctorCheck();
    expect(check.status).toBe('warn');
    expect(check.details).toContain(`${codexConfig()}: leftover duplicate registration`);
    expect(check.details).toContain(`The Codex hook now runs from ${codexHooks()}`);
    expect(check.details).toContain('session-hooks install --agents codex');
    // Registered and running is not broken, missing, or unverified.
    expect(check.details).not.toContain('registered user-level entry');
  });

  it('doctor names the hooks.json file when the registration there cannot be parsed or read', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    const registered = await readFile(codexHooks(), 'utf8');

    await writeFile(codexHooks(), `not json ${registered}`, 'utf8');
    const invalid = await sessionHookDoctorCheck();
    expect(invalid.status).toBe('warn');
    expect(invalid.details).toContain(
      `${codexHooks()}: registered user-level entry is broken — ${codexHooks()} is not valid JSON`
    );
    expect(invalid.details).toContain('session-hooks install --agents codex');
    // The managed/manual chooser belongs to config.toml, not the sidecar.
    expect(invalid.details).not.toContain('choose managed mode');

    if (process.getuid?.() === 0) return;
    await writeFile(codexHooks(), registered, 'utf8');
    await chmod(codexHooks(), 0o000);
    try {
      const unreadable = await sessionHookDoctorCheck();
      expect(unreadable.status).toBe('warn');
      expect(unreadable.details).toContain(
        `${codexHooks()}: registered user-level entry could not be verified`
      );
      expect(unreadable.details).toContain('retry after restoring access');
      const status = await agent.runRaw(['session-hooks', 'status', '--json']);
      const row = (
        JSON.parse(status.stdout) as {
          surfaces: Array<{ path: string; state: string; remedy?: string }>;
        }
      ).surfaces.find((surface) => surface.path === codexHooks());
      expect(row?.state).toBe('registered-unverified');
      expect(row?.remedy).toContain(codexHooks());
    } finally {
      await chmod(codexHooks(), 0o600);
    }
  });

  it('doctor stays silent about the representation once only hooks.json registers', async () => {
    codexVersion.output = SUPPORTED_CODEX_VERSION;
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    await writeFile(codexConfig(), fencedCodexBlock(), 'utf8');

    (await confirmMock()).mockResolvedValueOnce(true);
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    expect(await exists(codexConfig())).toBe(false);
    expect(noteCount(install.stdout)).toBe(0);
    expect(noteCount((await agent.runRaw(['session-hooks', 'status'])).stdout)).toBe(0);

    const check = await sessionHookDoctorCheck();
    expect(check.status).toBeDefined();
    expect(check.details).not.toContain(CODEX_HOOKS_JSON_NOTE);
    expect(check.details).not.toContain(codexConfig());
  });

  it('doctor carries the two-representation note while both files register', async () => {
    await writeFile(codexHooks(), supersetHooksJson(), 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(install.exitCode).toBe(0);
    expect(await readFile(codexConfig(), 'utf8')).toContain(codexTomlSnippet());

    const check = await sessionHookDoctorCheck();
    expect(check.details).toContain(CODEX_HOOKS_JSON_NOTE);
  });

  it('a record naming an agent with no user surface → registered-unsupported + doctor warning', async () => {
    // Simulate an overlay regression: hooks.local.json names an agent this
    // CLI version has no userFile row for (cursor). The capable loop never
    // visits it — status and doctor must surface the half-state instead of
    // silently ignoring it.
    // Cursor is only a PROXY for "no user surface" — assert that precondition
    // so this test fails loudly (not vacuously) the day cursor gains a
    // userFile row, instead of silently ceasing to cover the unsupported path.
    const { resolveUserHookPath } = await import('../../src/lib/session-hooks-user.js');
    expect(resolveUserHookPath('cursor' as Parameters<typeof resolveUserHookPath>[0])).toBeNull();
    await mkdir(globalRoot, { recursive: true });
    await writeFile(
      recordPath(),
      `${JSON.stringify(
        {
          record_version: 1,
          consented_at: '2026-07-30T00:00:00Z',
          cli_version: '0.0.0',
          entries: [{ agent: 'cursor', path: '/nonexistent/hooks.json', installed_at: 'x' }],
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const r = await agent.runRaw(['session-hooks', 'status', '--json']);
    const out = JSON.parse(r.stdout) as {
      surfaces: Array<{ agent: string; state: string }>;
    };
    expect(out.surfaces.find((s) => s.agent === 'cursor')?.state).toBe('registered-unsupported');

    // Doctor (repo context) reports it through the session-hooks check.
    // --yes: this suite fakes a TTY for the consent tests, which would
    // otherwise send init into interactive prompts the clack mock stubs
    // only partially.
    await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
    const doc = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(doc.stdout) as {
      checks: Array<{ name: string; status: string; details?: string[] }>;
    };
    const check = report.checks.find((c) => c.name === 'session-hooks');
    expect(check?.status).toBe('warn');
    expect((check?.details ?? []).join('\n')).toContain('no user-level surface');
  });
});
