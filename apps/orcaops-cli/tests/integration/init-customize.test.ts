import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

/**
 * The customize-more branch of interactive init: ONE default-No confirm after
 * the archive question, opening the settings init does not otherwise ask
 * about (prefix, install location, generated files, workflow reminders,
 * session-hook registration, git hooks). Under test: default-No leaves
 * config at defaults; the yes-path persists all of them through the normal
 * init pipeline; cancel aborts before writes; and --yes never prompts at all.
 */

const CANCELLED = Symbol('clack-cancel');

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  select: vi.fn(async () => 'static'),
  multiselect: vi.fn(async () => ['claude-code']),
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

describe('init customize-more branch (mocked TTY + @clack)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let dataDir: string;
  let hadTty: boolean | undefined;
  let hadCi: string | undefined;

  const DEFAULTS = resolveConfig({});

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataDir = await mkdtemp(path.join(tmpdir(), 'orcaops-customize-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataDir },
    });
    hadTty = process.stdout.isTTY;
    hadCi = process.env.CI;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    delete process.env.CI;
    const m = await mocks();
    // Fallbacks walk the happy path: session hooks static, section via select
    // fallback ('static' → maps to manual), archive/customize declined.
    prime(m.select, 'static');
    prime(m.multiselect, ['claude-code']);
    prime(m.confirm, false);
    prime(m.text, 'orcaops');
  });

  afterEach(async () => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadTty;
    if (hadCi !== undefined) process.env.CI = hadCi;
    await repo.cleanup();
  });

  async function cfg(): Promise<{
    naming: { prefix: string };
    install: { scope: string; link: string };
    generated_files: string;
    workflow: { hints: { keys: string[]; custom?: string[] } };
    session_hooks?: { enabled?: boolean; entries?: string };
  }> {
    return JSON.parse(await readFile(await effectiveConfigPath(repo.path), 'utf8')) as never;
  }

  it('declining "Customize more?" leaves every branch setting at its default', async () => {
    const m = await mocks();
    prime(m.confirm, false); // archive no, customize no
    const r = await agent.runRaw(['init', '--json', '--no-llm']);
    expect(r.exitCode).toBe(0);
    const c = await cfg();
    // Init writes a MINIMAL delta: default-valued keys are simply absent
    // (absent = default), and the fresh-init scope default is `personal`
    // (the invisible install), pinned explicitly.
    expect(c.naming?.prefix ?? DEFAULTS.naming.prefix).toBe(DEFAULTS.naming.prefix);
    expect(c.install.scope).toBe('personal');
    expect(c.install.link ?? DEFAULTS.install.link).toBe(DEFAULTS.install.link);
    expect(c.generated_files ?? DEFAULTS.generated_files).toBe(DEFAULTS.generated_files);
    expect(c.workflow?.hints.keys ?? DEFAULTS.workflow.hints.keys).toEqual(
      DEFAULTS.workflow.hints.keys
    );
    await expect(access(path.join(repo.path, '.git', 'hooks', 'post-merge'))).rejects.toThrow();
  });

  it('the yes-path persists every branch setting through the normal init pipeline', async () => {
    const m = await mocks();
    prime(
      m.confirm,
      false,
      false /* machine-hook consent */,
      false /* archive */,
      true /* customize */,
      true /* git hooks */
    );
    prime(m.text, '', 'oo' /* prefix */, 'Review migrations before committing.', '');
    // The instruction-file question is asked once project scope is chosen —
    // the personal default owns no instruction file to ask about.
    prime(
      m.select,
      'static',
      'static' /* session hooks */,
      'project' /* scope */,
      'manual' /* section */,
      'symlink' /* link */,
      'ignore' /* generated files */,
      'none' /* session-hook registration (entries) */
    );
    prime(
      m.multiselect,
      ['claude-code'],
      ['claude-code'] /* agents */,
      ['checkpoint-cadence'] /* reminders */
    );

    const r = await agent.runRaw(['init', '--json', '--no-llm']);
    expect(r.exitCode).toBe(0);
    const c = await cfg();
    expect(c.naming.prefix).toBe('oo');
    expect(c.install.scope).toBe('project');
    expect(c.install.link).toBe('symlink');
    expect(c.generated_files).toBe('ignore');
    expect(c.workflow.hints.keys).toEqual(['checkpoint-cadence']);
    expect(c.workflow.hints.custom).toEqual(['Review migrations before committing.']);
    // The entries knob (configure's session-hooks item) is reachable from the
    // customize branch once hooks are enabled — and persists like the rest.
    expect(c.session_hooks?.enabled).toBe(true);
    expect(c.session_hooks?.entries).toBe('none');
    // The prefix flowed into generation (not just config)…
    await expect(
      access(path.join(repo.path, '.claude', 'skills', 'oo-capture', 'SKILL.md'))
    ).resolves.toBeUndefined();
    // …and the git-hooks answer drove the same machinery as --with-hooks.
    expect(await readFile(path.join(repo.path, '.git', 'hooks', 'post-merge'), 'utf8')).toContain(
      '# orcaops-hook v='
    );
  });

  it('cancelling inside the customization branch aborts before writes', async () => {
    const m = await mocks();
    prime(
      m.confirm,
      false,
      false /* machine-hook consent */,
      false /* archive */,
      true /* customize */
    );
    prime(m.text, 'orcaops', CANCELLED /* prefix */);
    prime(m.select, 'static', 'static' /* session hooks */, 'manual' /* section */);
    prime(m.multiselect, ['claude-code'], ['claude-code'] /* agents */);

    const r = await agent.runRaw(['init', '--json', '--no-llm']);
    expect(r.exitCode).toBe(1);
    await expect(access(path.join(repo.path, '.orcaops'))).rejects.toThrow();
    await expect(access(path.join(repo.path, '.git', 'hooks', 'post-merge'))).rejects.toThrow();
  });

  it('asks about managed instructions after a codex-only personal draft changes to project', async () => {
    const m = await mocks();
    prime(
      m.confirm,
      false,
      false /* machine-hook consent */,
      false /* archive */,
      true /* customize */,
      false /* git hooks */
    );
    prime(m.text, '', 'orcaops' /* prefix */, '' /* finish custom reminders */);
    prime(
      m.select,
      'static',
      'static' /* session hooks */,
      'project' /* scope */,
      'managed' /* late instruction block */,
      'copy' /* link */,
      'commit' /* generated files */,
      'project' /* session-hook registration */
    );
    prime(m.multiselect, [], ['codex'] /* agents */, [] /* reminders */);

    const result = await agent.runRaw(['init', '--json', '--no-llm']);

    expect(result.exitCode).toBe(0);
    const blockCall = m.select.mock.calls.find(([options]) =>
      String((options as { message: string }).message).startsWith('Let orcaops keep a section')
    );
    expect(blockCall?.[0]).toEqual(expect.objectContaining({ initialValue: 'managed' }));
    const config = await cfg();
    expect(config.install.scope).toBe('project');
    expect((config as { bootstrap?: string }).bootstrap).toBe('managed');
    expect(await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8')).toContain(
      '<!-- orcaops:start'
    );
  });

  it('--reset-config re-interview of a personal repo flips scope to project: exclude stripped, trees materialized', async () => {
    // The invisible default × re-interview interaction: a plain init pins
    // personal (footprint hidden via .git/info/exclude); --force alone
    // re-asks nothing, so `--force --reset-config` IS the consent to
    // re-interview, and choosing project through the customize branch must
    // undo the hiding mechanism end-to-end.
    let r = await agent.runRaw(['init', '--yes', '--json', '--no-llm']);
    expect(r.exitCode).toBe(0);
    const excludeAbs = path.join(repo.path, '.git', 'info', 'exclude');
    expect(await readFile(excludeAbs, 'utf8')).toContain('.orcaops/');
    const skillAbs = path.join(repo.path, '.claude', 'skills', 'orcaops-capture', 'SKILL.md');
    await expect(access(skillAbs)).rejects.toThrow();

    const m = await mocks();
    prime(m.confirm, false, false /* archive */, true /* customize */, false /* git hooks */);
    prime(m.text, '', 'orcaops' /* prefix */, '' /* finish custom reminders */);
    prime(
      m.select,
      'static',
      'off' /* session hooks (kept off) */,
      'project' /* scope — the flip under test */,
      'manual' /* section */,
      'copy' /* link */,
      'commit' /* generated files */
    );
    prime(m.multiselect, [], ['claude-code'] /* agents */, [] /* reminders */);

    r = await agent.runRaw(['init', '--force', '--reset-config', '--json', '--no-llm']);
    expect(r.exitCode).toBe(0);
    const c = await cfg();
    expect(c.install.scope).toBe('project');
    // The hiding mechanism is undone: exclude lines stripped, repo trees real.
    const stripped = await readFile(excludeAbs, 'utf8').catch(() => '');
    expect(stripped).not.toContain('.orcaops/');
    expect(stripped).not.toContain('CLAUDE.local.md');
    await expect(access(skillAbs)).resolves.toBeUndefined();
  });

  it('--yes never prompts at all', async () => {
    const m = await mocks();
    const r = await agent.runRaw(['init', '--yes', '--json', '--no-llm']);
    expect(r.exitCode).toBe(0);
    expect(m.select).not.toHaveBeenCalled();
    expect(m.multiselect).not.toHaveBeenCalled();
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.text).not.toHaveBeenCalled();
  });
});
