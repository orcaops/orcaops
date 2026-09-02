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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import {
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
    // Codex is listed via its REAL surface (config.toml — hooks.json is not
    // read by shipped codex); the chooser (fallback: skip) decides the write.
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

    // hooks.json is NEVER written — it is not read by shipped codex-cli.
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

  it('codex managed mode: marker block round-trips through config.toml; collisions refuse', async () => {
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
    expect(written).toContain('hooks = true');
    const managedState = await runInInvocationContext(
      { env: { ...process.env, CODEX_HOME: codexHome } },
      readCodexTomlState
    );
    expect(managedState).toMatchObject({ markerBlock: true, collision: false, gateMissing: false });

    const invalidOutside = `broken = [\n${written}`;
    await writeFile(configToml, invalidOutside, 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    r = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(r.stdout).toContain('will not');
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

    // Collision: a config.toml with an existing [features] table refuses the
    // managed write byte-for-byte and prints the snippet instead.
    await mkdir(codexHome, { recursive: true });
    const existing = '[features]\nshell_snapshots = true\n';
    await writeFile(configToml, existing, 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');
    r = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('will not');
    expect(r.stdout).toContain('[[hooks.SessionStart]]');
    expect(await readFile(configToml, 'utf8')).toBe(existing);
  });

  it('preserves a symlinked Codex config and its mode through managed round-trip', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const target = path.join(codexHome, 'config-target.toml');
    await writeFile(target, '', { encoding: 'utf8', mode: 0o600 });
    await symlink(target, configToml);
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');

    const install = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex', '--json']);
    expect(install.exitCode).toBe(0);
    expect((await lstat(configToml)).isSymbolicLink()).toBe(true);
    expect(await readlink(configToml)).toBe(target);
    expect(await readFile(target, 'utf8')).toContain(CODEX_TOML_MARKER_START);
    expect((await stat(target)).mode & 0o777).toBe(0o600);

    const uninstall = await agent.runRaw(['session-hooks', 'uninstall', '--yes', '--json']);
    expect(uninstall.exitCode).toBe(0);
    expect((await lstat(configToml)).isSymbolicLink()).toBe(true);
    expect(await readlink(configToml)).toBe(target);
    expect(await readFile(target, 'utf8')).toBe('');
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

  it('treats the recommended manual paste as already registered, not as a collision', async () => {
    // The snippet the consent prompt tells users to paste defines the root
    // feature and hook tables itself, so a collision check that ran first
    // called their WORKING config invalid and offered the snippet again.
    const configToml = path.join(codexHome, 'manual-paste.toml');
    const pasted = `title = "mine"\n\n${codexTomlSnippet()}\n`;
    await writeFile(configToml, pasted, 'utf8');

    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('unchanged');
    expect(await readFile(configToml, 'utf8')).toBe(pasted);
  });

  it('still refuses to append into a config whose root tables it does not own', async () => {
    const configToml = path.join(codexHome, 'foreign-tables.toml');
    const foreign = '[features]\nhooks = true\n\n[[hooks.SessionStart]]\nmatcher = "startup"\n';
    await writeFile(configToml, foreign, 'utf8');

    expect(await writeCodexTomlBlock({ configPath: configToml })).toBe('refused-collision');
    expect(await readFile(configToml, 'utf8')).toBe(foreign);
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

  it('codex managed mode detects TOML collisions by parsed root keys', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const collisions = [
      'features.hooks = false\n',
      'features = { hooks = false }\n',
      '[ features ]\nshell_snapshots = true\n',
      '["features"]\nshell_snapshots = true\n',
      'hooks = []\n',
      'features = {\n',
    ];

    for (const existing of collisions) {
      await writeFile(configToml, existing, 'utf8');
      (await confirmMock()).mockResolvedValueOnce(true);
      (await selectMock()).mockResolvedValueOnce('managed');

      const result = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('will not');
      expect(result.stdout).toContain('[[hooks.SessionStart]]');
      expect(await readFile(configToml, 'utf8')).toBe(existing);
    }
  });

  it('codex managed mode ignores nested hooks and reads the feature gate structurally', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const nested = '[unrelated]\nhooks = true\n';
    await writeFile(configToml, nested, 'utf8');
    (await confirmMock()).mockResolvedValueOnce(true);
    (await selectMock()).mockResolvedValueOnce('managed');

    const result = await agent.runRaw(['session-hooks', 'install', '--agents', 'codex']);

    expect(result.exitCode).toBe(0);
    const written = await readFile(configToml, 'utf8');
    expect(parseToml(written)).toMatchObject({
      unrelated: { hooks: true },
      features: { hooks: true },
    });

    const command = canonicalSessionHookCommand('codex', { user: true });
    await writeFile(configToml, `[unrelated]\nhooks = true\ncommand = "${command}"\n`, 'utf8');
    const status = await agent.runRaw(['session-hooks', 'status', '--json']);
    expect(status.exitCode).toBe(0);
    const output = JSON.parse(status.stdout) as {
      surfaces: Array<{ agent: string; state: string; remedy?: string }>;
    };
    const codex = output.surfaces.find((surface) => surface.agent === 'codex');
    expect(codex).toMatchObject({ state: 'registered-but-broken' });
    expect(codex?.remedy).toContain('session-hooks install --agents codex');
    expect(status.stderr).toBe('');
  });

  it('codex status accepts every parsed spelling of an enabled feature gate', async () => {
    const configToml = path.join(codexHome, 'config.toml');
    const command = canonicalSessionHookCommand('codex', { user: true });
    const enabledGates = [
      `features.hooks = true\ncommand = "${command}"\n`,
      `features = { hooks = true }\ncommand = "${command}"\n`,
      `[ features ]\nhooks = true\ncommand = "${command}"\n`,
      `["features"]\nhooks = true\ncommand = "${command}"\n`,
    ];

    for (const existing of enabledGates) {
      await writeFile(configToml, existing, 'utf8');
      const status = await agent.runRaw(['session-hooks', 'status', '--json']);
      expect(status.exitCode).toBe(0);
      expect(status.stderr).toBe('');
    }
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
    const pasted = `[features]\nhooks = true\n\n[[hooks.SessionStart]]\nmatcher = "startup|resume"\nhooks = [{ type = "command", command = "orcaops hook session-start --agent codex --user" }]\n`;
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
    const brokenStates = [
      healthy
        .split('\n')
        .filter((line) => !line.startsWith('hooks = [{'))
        .join('\n'),
      healthy.replace('hooks = true', 'hooks = false'),
      null,
    ];
    for (const broken of brokenStates) {
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

  it('--agents codex dry-run (non-TTY --json) names the config.toml surface instead of an empty preview', async () => {
    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    const configToml = path.join(codexHome, 'config.toml');
    type DryRun = {
      dry_run: boolean;
      plans: Array<{ agent: string; path: string; action: string }>;
      warnings: string[];
    };

    // Fresh: the chooser can't run in a preview, but the surface must still
    // be named — an empty plans[] would read as "install would do nothing".
    let r = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'codex',
      '--dry-run',
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    let out = JSON.parse(r.stdout) as DryRun;
    expect(out.dry_run).toBe(true);
    expect(out.plans).toEqual([{ agent: 'codex', path: configToml, action: 'created' }]);
    expect(out.warnings.some((w) => w.includes('chooser-driven'))).toBe(true);
    expect(await exists(configToml)).toBe(false); // read-only preview

    // Collision: managed mode would refuse — the preview says so.
    await mkdir(codexHome, { recursive: true });
    await writeFile(configToml, '[features]\nshell_snapshots = true\n', 'utf8');
    r = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'codex',
      '--dry-run',
      '--json',
    ]);
    out = JSON.parse(r.stdout) as DryRun;
    expect(out.plans).toEqual([{ agent: 'codex', path: configToml, action: 'created' }]);
    expect(out.warnings.some((w) => w.includes('REFUSE'))).toBe(true);

    // Already registered (manual paste): unchanged, no chooser warning.
    const pasted = `[features]\nhooks = true\n\n[[hooks.SessionStart]]\nmatcher = "startup|resume"\nhooks = [{ type = "command", command = "orcaops hook session-start --agent codex --user" }]\n`;
    await writeFile(configToml, pasted, 'utf8');
    r = await agent.runRaw([
      'session-hooks',
      'install',
      '--agents',
      'codex',
      '--dry-run',
      '--json',
    ]);
    out = JSON.parse(r.stdout) as DryRun;
    expect(out.plans).toEqual([{ agent: 'codex', path: configToml, action: 'unchanged' }]);
    expect(out.warnings).toEqual([]);
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
