import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

/**
 * `orcaops configure` — the interactive settings menu. Under test: the menu
 * is a front-end over the existing machinery (apply persists config then runs
 * the update reconcile; archive routes through its backfill-aware toggles;
 * git hooks through their planners), and NOTHING is written until an explicit
 * apply — cancel and discard are guaranteed write-free.
 */

const CANCELLED = Symbol('clack-cancel');

vi.mock('@clack/prompts', () => ({
  // Fallback impls make an exhausted scripted sequence EXIT the menu loop
  // (discard) instead of spinning it forever on undefined.
  select: vi.fn(async () => 'discard'),
  multiselect: vi.fn(async () => []),
  confirm: vi.fn(async () => false),
  text: vi.fn(async () => 'orcaops'),
  isCancel: (v: unknown) => v === CANCELLED,
}));

type Mock = ReturnType<typeof vi.fn>;

async function mocks(): Promise<{ select: Mock; multiselect: Mock; confirm: Mock; text: Mock }> {
  const clack = await import('@clack/prompts');
  return {
    select: clack.select as Mock,
    multiselect: clack.multiselect as Mock,
    confirm: clack.confirm as Mock,
    text: clack.text as Mock,
  };
}

function prime(mock: Mock, fallback: unknown, ...values: unknown[]): void {
  mock.mockReset();
  for (const v of values) mock.mockResolvedValueOnce(v);
  mock.mockImplementation(async () => fallback);
}

describe('orcaops configure (mocked TTY + clack)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let dataDir: string;
  let hadTty: boolean | undefined;
  let hadStdinTty: boolean | undefined;
  let hadCi: string | undefined;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataDir = await mkdtemp(path.join(tmpdir(), 'orcaops-cfg-data-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
    });
    hadTty = process.stdout.isTTY;
    hadStdinTty = process.stdin.isTTY;
    hadCi = process.env.CI;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    delete process.env.CI;
    const m = await mocks();
    prime(m.select, 'discard');
    prime(m.multiselect, []);
    prime(m.confirm, false);
    prime(m.text, 'orcaops');
  });

  afterEach(async () => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadTty;
    (process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = hadStdinTty;
    if (hadCi !== undefined) process.env.CI = hadCi;
    await repo.cleanup();
  });

  async function configJson(): Promise<string> {
    return readFile(await effectiveConfigPath(repo.path), 'utf8');
  }

  it('flips the session-hook payload end-to-end: config persisted, reconcile run, settings entry untouched', async () => {
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
    const settingsAbs = path.join(repo.path, '.claude/settings.json');
    const settingsBefore = await readFile(settingsAbs, 'utf8');

    const m = await mocks();
    prime(m.select, 'discard', 'session-hooks', 'state-aware', 'project', 'apply');
    prime(m.confirm, false, true); // apply confirm

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      'session hooks: on (static, repo entries) → on (state-aware, repo entries)'
    );
    expect(r.stdout).toContain('Configuration applied.');

    const cfg = JSON.parse(await configJson()) as {
      session_hooks: { enabled: boolean; payload: string };
    };
    expect(cfg.session_hooks).toEqual({ enabled: true, payload: 'state-aware' });
    // The arm-flip invariant: the installed settings entry is byte-identical.
    expect(await readFile(settingsAbs, 'utf8')).toBe(settingsBefore);
  });

  it('discard and menu-cancel both write nothing', async () => {
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
    const before = await configJson();

    const m = await mocks();
    // Change something, then discard anyway.
    prime(m.select, 'discard', 'session-hooks', 'off', 'discard');
    let r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No changes written.');
    expect(await configJson()).toBe(before);

    // Ctrl-C at the menu behaves the same.
    prime(m.select, 'discard', CANCELLED);
    r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(await configJson()).toBe(before);
  });

  it('a tweaked item is marked * in its LABEL with an old → new hint on re-render', async () => {
    // The marker must live in the label: clack renders hints only on the
    // FOCUSED row, so an unfocused-but-tweaked item would otherwise carry no
    // visible signal.
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
    const m = await mocks();
    prime(m.select, 'discard', 'session-hooks', 'state-aware', 'project', 'discard');
    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);

    const menuCalls = m.select.mock.calls.filter(([arg]) =>
      String((arg as { message?: string }).message ?? '').includes('Orcaops settings')
    );
    // First render: nothing pending — plain labels, no legend.
    const first = menuCalls[0][0] as {
      message: string;
      options: Array<{ value: string; label: string; hint?: string }>;
    };
    expect(first.message).not.toContain('* = pending');
    expect(first.options.find((o) => o.value === 'session-hooks')?.label).toBe(
      'Session-start hooks'
    );

    // Re-render after the edit: the tweaked item is starred with an
    // old → new hint; untouched items stay plain with current-value hints.
    const rerender = menuCalls[1][0] as typeof first;
    expect(rerender.message).toContain('* = pending');
    const hooksRow = rerender.options.find((o) => o.value === 'session-hooks');
    expect(hooksRow?.label).toBe('Session-start hooks *');
    expect(hooksRow?.hint).toBe('on (static, repo entries) → on (state-aware, repo entries)');
    const agentsRow = rerender.options.find((o) => o.value === 'agents');
    expect(agentsRow?.label).toBe('Installed agents');
    expect(agentsRow?.hint).toBe('claude-code');
  });

  it('cancelling hook registration restores the whole session-hook edit', async () => {
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
    const before = await configJson();
    const m = await mocks();
    prime(m.select, 'discard', 'session-hooks', 'state-aware', CANCELLED, 'discard');

    const r = await agent.runRaw(['configure']);

    expect(r.exitCode).toBe(0);
    expect(await configJson()).toBe(before);
    const menuCalls = m.select.mock.calls.filter(([arg]) =>
      String((arg as { message?: string }).message ?? '').includes('Orcaops settings')
    );
    const rerender = menuCalls[1][0] as {
      message: string;
      options: Array<{ value: string; label: string; hint?: string }>;
    };
    expect(rerender.message).not.toContain('* = pending');
    expect(rerender.options.find(({ value }) => value === 'session-hooks')).toEqual(
      expect.objectContaining({
        label: 'Session-start hooks',
        hint: 'on (static, repo entries)',
      })
    );
  });

  it('cancelling link mode restores the whole install-location edit', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--json',
      '--no-llm',
      '--agents',
      'claude-code',
    ]);
    const before = await configJson();
    const m = await mocks();
    prime(m.select, 'discard', 'install', 'scope', 'personal', CANCELLED, 'back', 'discard');

    const r = await agent.runRaw(['configure']);

    expect(r.exitCode).toBe(0);
    expect(await configJson()).toBe(before);
    const submenuCalls = m.select.mock.calls.filter(
      ([arg]) => String((arg as { message?: string }).message ?? '') === 'Installation & files'
    );
    const rerender = submenuCalls[1][0] as {
      options: Array<{ value: string; label: string; hint?: string }>;
    };
    expect(rerender.options.find(({ value }) => value === 'scope')).toEqual(
      expect.objectContaining({ label: 'Install location', hint: 'project / copy' })
    );
  });

  it('declining the apply confirm returns to the menu without writing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
    const before = await configJson();
    const m = await mocks();
    prime(m.select, 'discard', 'block', 'manual', 'apply', 'discard');
    prime(m.confirm, false, false); // apply confirm declined
    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(await configJson()).toBe(before);
  });

  it('bootstrap managed→manual strips the block via the shared reconcile', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--json',
      '--no-llm',
      '--agents-md',
    ]);
    expect(await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8')).toContain('orcaops:start');

    const m = await mocks();
    prime(m.select, 'discard', 'block', 'manual', 'apply');
    prime(m.confirm, false, true);

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('instruction block: managed → manual');
    const cfg = JSON.parse(await configJson()) as { bootstrap: string };
    expect(cfg.bootstrap).toBe('manual');
    // The update reconcile (the ONE write path) excised the managed region.
    const agentsMd = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8').catch(() => '');
    expect(agentsMd).not.toContain('orcaops:start');
  });

  it('archive enable routes through the backfill machinery, not a raw config bit', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
    // Something to backfill.
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'configure archive fixture',
          label: `cfg-arch-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);

    const m = await mocks();
    prime(m.select, 'discard', 'archive', 'apply');
    prime(m.confirm, false, true /* enable archive */, true /* apply */);

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(await configJson()) as { archive: { enabled: boolean } };
    expect(cfg.archive.enabled).toBe(true);
    // The first-enable backfill ran: the archive project dir materialized.
    const status = await agent.runRaw(['archive', 'status', '--json']);
    const parsed = JSON.parse(status.stdout) as { project_dir?: string };
    expect(parsed.project_dir).toBeDefined();
    await expect(access(parsed.project_dir as string)).resolves.toBeUndefined();
  });

  it('git hooks install and remove through the planners', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
    const hookAbs = path.join(repo.path, '.git', 'hooks', 'post-merge');

    const m = await mocks();
    prime(m.select, 'discard', 'install', 'git-hooks', 'back', 'apply');
    prime(m.confirm, false, true /* install */, true /* apply */);
    let r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(await readFile(hookAbs, 'utf8')).toContain('# orcaops-hook v=');

    prime(m.select, 'discard', 'install', 'git-hooks', 'back', 'apply');
    prime(m.confirm, false, false /* remove */, true /* apply */);
    r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    await expect(access(hookAbs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('an invalid prefix re-prompts with the rule, then the rename reconciles', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
    const m = await mocks();
    prime(m.select, 'discard', 'install', 'prefix', 'back', 'apply');
    prime(m.text, 'orcaops', 'Bad-Prefix', 'oo');
    prime(m.confirm, false, true);

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('must be lowercase and hyphen-safe');
    expect(r.stdout).toContain('naming prefix: orcaops → oo');
    const cfg = JSON.parse(await configJson()) as { naming: { prefix: string } };
    expect(cfg.naming.prefix).toBe('oo');
    // The reconcile re-rendered under the new prefix.
    await expect(
      access(path.join(repo.path, '.claude', 'skills', 'oo-capture', 'SKILL.md'))
    ).resolves.toBeUndefined();
  });

  it('refuses a tracked project → personal move and names the transition command', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
    execFileSync('git', ['add', '-A'], { cwd: repo.path });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'adopt'], {
      cwd: repo.path,
    });
    const before = await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8');

    const m = await mocks();
    prime(m.select, 'discard', 'install', 'scope', 'personal', 'copy', 'back', 'apply', 'discard');
    prime(m.confirm, false, true);

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('committed orcaops file');
    expect(r.stderr).toContain('orcaops update --scope personal');
    // Nothing moved: the tracked config is untouched and no shared file appeared.
    expect(await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')).toBe(before);
    await expect(access(path.join(repo.path, '.git', 'orcaops', 'config.json'))).rejects.toThrow();
  });

  it('scope personal + widened agents applies cleanly (advisory surfaces in the reconcile)', async () => {
    // Personal supports every agent now — the old claude-code-only apply
    // gate is gone. The draft (personal + [claude-code, cursor]) persists and
    // routes through the same update reconcile; the instruction-surface
    // advisory rides the update output.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--json',
      '--no-llm',
      '--agents',
      'claude-code',
    ]);

    const m = await mocks();
    prime(
      m.select,
      'discard',
      'install',
      'scope',
      'personal',
      'copy',
      'back',
      'agents',
      'apply',
      'discard'
    );
    prime(m.multiselect, [], ['claude-code', 'cursor']);
    prime(m.confirm, false, true);

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('works with Claude Code only');
    const cfg = JSON.parse(await configJson()) as {
      install: { scope: string; agents: string[] };
    };
    expect(cfg.install.scope).toBe('personal');
    expect(cfg.install.agents).toEqual(['claude-code', 'cursor']);
  });

  it('scope flip THROUGH the menu reconciles info/exclude add/strip end-to-end', async () => {
    // The update-path equivalents are covered in update-personal; this pins
    // the MENU path: configure's apply runs the same reconcile, so a scope
    // flip must carry the invisible footprint's hiding mechanism with it.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--json',
      '--no-llm',
      '--agents',
      'claude-code',
    ]);
    const excludeAbs = path.join(repo.path, '.git', 'info', 'exclude');
    const gitignoreAbs = path.join(repo.path, '.gitignore');
    const skillAbs = path.join(repo.path, '.claude', 'skills', 'orcaops-capture', 'SKILL.md');
    expect((await readFile(excludeAbs, 'utf8').catch(() => '')).includes('.orcaops/')).toBe(false);
    expect(await readFile(gitignoreAbs, 'utf8')).toContain('# >>> orcaops >>>');
    await expect(access(skillAbs)).resolves.toBeUndefined();

    // project → personal: exclude lines added, repo trees pruned.
    const m = await mocks();
    prime(m.select, 'discard', 'install', 'scope', 'personal', 'copy', 'back', 'apply');
    prime(m.confirm, false, true);
    let r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    const excl = await readFile(excludeAbs, 'utf8');
    expect(excl).toContain('.orcaops/');
    expect(excl).not.toContain('CLAUDE.local.md');
    await expect(access(skillAbs)).rejects.toMatchObject({ code: 'ENOENT' });
    // The tracked file has to lose the block too, or the "invisible" install
    // still shows up in git.
    expect(await readFile(gitignoreAbs, 'utf8').catch(() => '')).not.toContain('# >>> orcaops >>>');

    // personal → project: the same menu path strips the exclude lines back
    // out and re-materializes the repo trees.
    prime(m.select, 'discard', 'install', 'scope', 'project', 'copy', 'back', 'apply');
    prime(m.confirm, false, true);
    r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    const stripped = await readFile(excludeAbs, 'utf8').catch(() => '');
    expect(stripped).not.toContain('.orcaops/');
    expect(stripped).not.toContain('CLAUDE.local.md');
    await expect(access(skillAbs)).resolves.toBeUndefined();
    expect(await readFile(gitignoreAbs, 'utf8')).toContain('# >>> orcaops >>>');
  });

  it('apply writes per-key deltas only — untouched keys never materialize in raw config', async () => {
    // Writing an untouched key would pin today's resolved DEFAULT into the
    // repo, detaching it from future default changes. Strip defaulted keys
    // from the raw config, flip only the session-hook payload, and the
    // stripped keys must still be absent afterwards.
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
    const cfgPath = await effectiveConfigPath(repo.path);
    const parsed = JSON.parse(await configJson()) as Record<string, unknown>;
    delete parsed.bootstrap;
    delete parsed.generated_files;
    delete parsed.naming;
    delete parsed.workflow;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(cfgPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

    const m = await mocks();
    prime(m.select, 'discard', 'session-hooks', 'state-aware', 'project', 'apply');
    prime(m.confirm, false, true);

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    const after = JSON.parse(await configJson()) as Record<string, unknown>;
    expect(after.bootstrap).toBeUndefined();
    expect(after.generated_files).toBeUndefined();
    expect(after.naming).toBeUndefined();
    expect(after.workflow).toBeUndefined();
    expect((after.session_hooks as { payload: string }).payload).toBe('state-aware');
  });

  it('submenu: a plumbing change stars the group row; cancel there is Back, draft intact', async () => {
    await agent.runRaw(['init', '--yes', '--json', '--no-llm', '--agents', 'claude-code']);
    const m = await mocks();
    // Enter the submenu, change the prefix, Back to the top menu (its group
    // row must now be starred), re-enter via CANCEL exit, then discard.
    prime(m.select, 'discard', 'install', 'prefix', 'back', 'install', CANCELLED, 'discard');
    prime(m.text, 'orcaops', 'oo');
    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No changes written.');

    const menuCalls = m.select.mock.calls.filter(([arg]) =>
      String((arg as { message?: string }).message ?? '').includes('Orcaops settings')
    );
    const first = menuCalls[0][0] as {
      options: Array<{ value: string; label: string; hint?: string }>;
    };
    // Approved top-level order; the instruction-file row is absent under the
    // personal default, which owns no instruction file.
    expect(first.options.map((o) => o.value)).toEqual([
      'session-hooks',
      'hints',
      'agents',
      'archive',
      'install',
      'apply',
      'discard',
    ]);
    expect(first.options.find((o) => o.value === 'install')?.label).toBe('Installation & files…');
    // After the prefix edit: aggregate star on the group row.
    const rerender = menuCalls[1][0] as typeof first;
    const groupRow = rerender.options.find((o) => o.value === 'install');
    expect(groupRow?.label).toBe('Installation & files… *');
    expect(groupRow?.hint).toContain('prefix oo');
    // Inside the submenu on the second visit, the prefix row shows old → new.
    const subCalls = m.select.mock.calls.filter(([arg]) =>
      String((arg as { message?: string }).message ?? '').includes('Installation & files')
    );
    const subRender = subCalls[1][0] as typeof first;
    expect(subRender.options.find((o) => o.value === 'prefix')?.label).toBe(
      'Command name prefix *'
    );
    expect(subRender.options.find((o) => o.value === 'prefix')?.hint).toBe('orcaops → oo');
  });

  it('custom reminder lines: remove one, add one, persist exactly', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--json',
      '--no-llm',
      '--agents',
      'claude-code',
    ]);
    const cfgPath = await effectiveConfigPath(repo.path);
    const parsed = JSON.parse(await configJson()) as Record<string, unknown>;
    parsed.workflow = {
      hints: { keys: ['checkpoint-cadence'], custom: ['Old rule one.', 'Old rule two.'] },
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(cfgPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

    const m = await mocks();
    prime(m.select, 'discard', 'hints', 'apply');
    // multiselect #1 = curated keys (keep), #2 = keep only the SECOND custom line.
    prime(m.multiselect, [], ['checkpoint-cadence'], ['1']);
    // Add one new line, then blank to finish. Fallback '' so an accidental
    // extra prompt terminates instead of looping on the default.
    prime(m.text, '', 'New rule.', '');
    prime(m.confirm, false, true); // apply confirm

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('custom reminders: 2 line(s) edited');
    const after = JSON.parse(await configJson()) as {
      workflow: { hints: { keys: string[]; custom: string[] } };
    };
    expect(after.workflow.hints.keys).toEqual(['checkpoint-cadence']);
    expect(after.workflow.hints.custom).toEqual(['Old rule two.', 'New rule.']);
  });

  it('cancel in the custom editor keeps lines; a keys-only change preserves them', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--json',
      '--no-llm',
      '--agents',
      'claude-code',
    ]);
    const cfgPath = await effectiveConfigPath(repo.path);
    const parsed = JSON.parse(await configJson()) as Record<string, unknown>;
    parsed.workflow = { hints: { keys: [], custom: ['Keep me.'] } };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(cfgPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

    const m = await mocks();
    prime(m.select, 'discard', 'hints', 'apply');
    // Curated picked, then ctrl-C at the keep prompt: the curated edit stays
    // in the draft, the custom list stays untouched.
    prime(m.multiselect, [], ['capture-on-nontrivial'], CANCELLED);
    prime(m.text, '');
    prime(m.confirm, false, true);

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    const after = JSON.parse(await configJson()) as {
      workflow: { hints: { keys: string[]; custom: string[] } };
    };
    expect(after.workflow.hints.keys).toEqual(['capture-on-nontrivial']);
    expect(after.workflow.hints.custom).toEqual(['Keep me.']);
  });

  it('re-enabling session hooks seeds the select with the STORED payload preference', async () => {
    // payload survives the off state in config; the menu must resume it
    // rather than silently resetting a stored state-aware choice to static.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--yes',
      '--json',
      '--no-llm',
      '--session-hook-payload',
      'state-aware',
      '--agents',
      'claude-code',
    ]);

    const m = await mocks();
    prime(m.select, 'discard', 'session-hooks', 'state-aware', 'project', 'discard');
    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);

    const hooksPrompt = m.select.mock.calls.find(([arg]) =>
      String((arg as { message?: string }).message ?? '').includes('Session-start hooks put')
    );
    expect(hooksPrompt).toBeDefined();
    expect((hooksPrompt?.[0] as { initialValue?: string }).initialValue).toBe('state-aware');
  });

  it('entries flip project→none: persisted, repo entries stripped, machine status line shown', async () => {
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
    const settingsAbs = path.join(repo.path, '.claude', 'settings.json');
    await expect(access(settingsAbs)).resolves.toBeUndefined();

    const m = await mocks();
    prime(m.select, 'discard', 'session-hooks', 'static', 'none', 'apply');
    prime(m.confirm, false, true);

    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    // Read-only machine registration status (none installed in this sandbox)
    // pointing at the consent command — configure itself never writes it.
    expect(r.stdout).toContain('machine-level registration: not installed');
    expect(r.stdout).toContain('orcaops session-hooks install');
    expect(r.stdout).toContain(
      'session hooks: on (static, repo entries) → on (static, machine-level)'
    );

    const cfg = JSON.parse(await configJson()) as {
      session_hooks: { enabled: boolean; entries: string };
    };
    expect(cfg.session_hooks.enabled).toBe(true);
    expect(cfg.session_hooks.entries).toBe('none');
    // The same apply reconcile stripped the repo settings entry (husk deleted).
    await expect(access(settingsAbs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('entries edit then discard writes nothing', async () => {
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
    const before = await configJson();
    const m = await mocks();
    prime(m.select, 'discard', 'session-hooks', 'static', 'none', 'discard');
    const r = await agent.runRaw(['configure']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No changes written.');
    expect(await configJson()).toBe(before);
    await expect(access(path.join(repo.path, '.claude', 'settings.json'))).resolves.toBeUndefined();
  });
});

describe('orcaops configure (non-interactive)', () => {
  it('errors with a pointer at the update flags when there is no TTY', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
      await agent.runRaw(['init', '--scope', 'project', '--yes', '--json', '--no-llm']);
      // Default vitest environment: no TTY (and CI may be set) — both gate.
      const r = await agent.runRaw(['configure']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('needs a TTY');
      expect(r.stderr).toContain('orcaops update');
    } finally {
      await repo.cleanup();
    }
  });
});
