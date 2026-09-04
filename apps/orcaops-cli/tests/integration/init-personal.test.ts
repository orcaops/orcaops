import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

/**
 * `orcaops init --personal` on a fixture "enterprise"
 * repo: `git status` stays CLEAN (zero tracked-file changes), the
 * bootstrap block lands in CLAUDE.local.md (never AGENTS.md/CLAUDE.md),
 * skills materialize via the global machinery (sandboxed through
 * ORCAOPS_GLOBAL_ROOT), no committed install.json exists, the personal
 * footprint hides via .git/info/exclude, and any non-claude-code agent
 * in the install set errors up front naming the v1 constraint.
 */

describe('orcaops init --personal', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let globalRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-personal-root-'));
    // A shared "enterprise" repo baseline: a committed AGENTS.md the
    // personal install must never touch.
    await writeFile(
      path.join(repo.path, 'AGENTS.md'),
      '# Team instructions\n\nDo not edit lightly.\n',
      'utf8'
    );
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'team AGENTS.md'], { cwd: repo.path });
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_GLOBAL_ROOT: globalRoot },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const p = (...s: string[]): string => path.join(repo.path, ...s);
  const exists = async (abs: string): Promise<boolean> => {
    try {
      await stat(abs);
      return true;
    } catch {
      return false;
    }
  };

  it('refuses --personal over a committed project install with an actionable error', async () => {
    const projectInit = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents-md',
    ]);
    expect(projectInit.exitCode).toBe(0);
    execFileSync('git', ['add', '-A'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'commit orcaops bootstrap'], { cwd: repo.path });

    const result = await agent.runRaw(['init', '--yes', '--force', '--personal', '--no-llm']);
    expect(result.exitCode).toBe(1);
    // Moving a committed project install to personal scope edits tracked
    // files, which is `update --scope personal`'s job — it shows that diff.
    expect(result.stderr).toContain('committed orcaops file');
    expect(result.stderr).toMatch(/\.orcaops\/config\.json|\.orcaops\/install\.json/u);
    expect(result.stderr).toContain('orcaops update --scope personal');
    // A clean CLI error, never a raw invariant stack trace.
    expect(result.stderr).not.toMatch(/\n\s+at /u);
  });

  it('keeps `git status` clean: no instruction file, skills global, ownership in the common dir', async () => {
    const r = await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      scope: string;
      install_agents: string[];
      global: { root: string; materialized: string[] } | null;
    };
    expect(out.scope).toBe('personal');
    expect(out.install_agents).toEqual(['claude-code']);

    // THE headline: zero tracked-file changes on the shared repo.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo.path })
      .toString()
      .trim();
    expect(status).toBe('');

    // Personal scope owns no instruction file; team files untouched.
    expect(await exists(p('CLAUDE.local.md'))).toBe(false);
    expect(await readFile(p('AGENTS.md'), 'utf8')).toBe(
      '# Team instructions\n\nDo not edit lightly.\n'
    );
    expect(await exists(p('CLAUDE.md'))).toBe(false);

    // Skills via the global machinery — nothing in the repo tree.
    expect(await exists(p('.claude', 'skills'))).toBe(false);
    expect(out.global).not.toBeNull();
    expect(out.global?.root).toBe(globalRoot);
    const globalSkill = path.join(
      globalRoot,
      'claude-code',
      'skills',
      'orcaops-capture',
      'SKILL.md'
    );
    expect(await exists(globalSkill)).toBe(true);

    // No committed install.json and no worktree manifest: the ownership
    // record is the common personal manifest, shared by every worktree.
    expect(await exists(p('.orcaops', 'install.json'))).toBe(false);
    expect(await exists(p('.orcaops', 'install.local.json'))).toBe(false);
    expect(await exists(p('.git', 'orcaops', 'personal-manifest.json'))).toBe(true);

    // The personal footprint hides via info/exclude — never .gitignore — and
    // the managed block is exactly the store.
    const exclude = await readFile(p('.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('# >>> orcaops >>>');
    expect(exclude).toContain('.orcaops/');
    expect(exclude).not.toContain('CLAUDE.local.md');
    expect(exclude).not.toContain('install.local.json');
    expect(await exists(p('.gitignore'))).toBe(false);

    // Capture still fires: the ambient lifecycle works under personal.
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: 'personal-plan-1',
          task: 'personal fixture',
          label: 'personal fixture',
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);
    const statusAfterCapture = execFileSync('git', ['status', '--porcelain'], { cwd: repo.path })
      .toString()
      .trim();
    expect(statusAfterCapture).toBe('');
  });

  it('summarizes a fresh personal install and points to change and undo commands', async () => {
    const result = await agent.runRaw(['init', '--personal', '--no-llm']);
    const repoDisplayPath = await realpath(repo.path);
    const normalized = result.stdout
      .replaceAll(repoDisplayPath, '<repo>')
      .replaceAll(repo.path, '<repo>')
      .replaceAll(globalRoot, '<global>');

    expect(result.exitCode).toBe(0);
    expect(normalized).toMatchInlineSnapshot(`
      "Orcaops initialized at <repo>

      Created:
        <repo>/.git/orcaops/config.json

      Installed 18 skills for claude-code → <global>/claude-code/skills

      Archive backfill: 0 event(s) replayed, 0 remaining; 0 artifact(s) rebuilt, 0 rebuild(s) remaining.

      Tip: pass \`--with-hooks\` next time to auto-run \`orcaops lineage\` after merges/rebases.

      No evaluator packs installed.
        Run \`orcaops eval add-pack @orcaops/evaluator-pack core\` to install the default first-party pack.

      Tip: pass \`--session-hooks\` to inject orcaops capture guidance at every agent session start.

      LLM tool: none (no \`claude\` or \`codex\` found on PATH).
      LLM evaluators will be skipped until a provider CLI is installed.

      Invisible install: nothing touches git — \`git status\` stays clean, teammates
      see nothing. To adopt orcaops as a team later: \`orcaops update --scope project\`,
      then commit the files it materializes.

      Next: have your agent capture plans + checkpoints via \`orcaops capture …\`.
      Change settings: \`orcaops configure\` · Undo: \`orcaops uninstall\`
      "
    `);
  });

  it('warns that a personal --reset-config changes settings for every linked worktree', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
    const result = await agent.runRaw([
      'init',
      '--personal',
      '--force',
      '--reset-config',
      '--json',
      '--no-llm',
    ]);
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as { warnings: string[]; config_reset: boolean };
    expect(out.config_reset).toBe(true);
    expect(out.warnings.some((w) => w.includes('EVERY linked worktree'))).toBe(true);
  });

  it('moves an UNTRACKED project config to the common dir under --force --personal', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--no-agents-md']);
    const worktreeConfig = path.join(repo.path, '.orcaops', 'config.json');
    expect(await exists(worktreeConfig)).toBe(true);

    const result = await agent.runRaw(['init', '--force', '--personal', '--json', '--no-llm']);
    expect(result.exitCode).toBe(0);
    // Nothing was tracked, so the move is invisible: the shared config appears
    // and the worktree copy — which would fail source selection closed — is gone.
    expect(await exists(worktreeConfig)).toBe(false);
    const shared = JSON.parse(await readFile(await effectiveConfigPath(repo.path), 'utf8')) as {
      install: { scope: string };
    };
    expect(shared.install.scope).toBe('personal');
    expect(await effectiveConfigPath(repo.path)).toContain(path.join('.git', 'orcaops'));
  });

  it('rejoins an existing personal config without replacing its settings', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
    const sharedPath = await effectiveConfigPath(repo.path);
    const shared = JSON.parse(await readFile(sharedPath, 'utf8')) as Record<string, unknown>;
    shared.naming = { prefix: 'shared' };
    shared.capture = { exclude: ['shared/**'] };
    await writeFile(sharedPath, `${JSON.stringify(shared, null, 2)}\n`, 'utf8');
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const worktreePath = path.join(repo.path, '.orcaops', 'config.json');
    const worktree = JSON.parse(await readFile(worktreePath, 'utf8')) as Record<string, unknown>;
    worktree.naming = { prefix: 'worktree' };
    await writeFile(worktreePath, `${JSON.stringify(worktree, null, 2)}\n`, 'utf8');

    const result = await agent.runRaw(['init', '--force', '--personal', '--json']);

    expect(result.exitCode).toBe(0);
    expect(await exists(worktreePath)).toBe(false);
    const adopted = JSON.parse(await readFile(sharedPath, 'utf8')) as {
      naming: { prefix: string };
      capture: { exclude: string[] };
    };
    expect(adopted.naming.prefix).toBe('shared');
    expect(adopted.capture.exclude).toEqual(['shared/**']);
  });

  it('moves an untracked project install from a linked worktree nested in the main checkout', async () => {
    const nested = path.join(repo.path, 'nested-worktree');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'nested-personal', nested], {
      cwd: repo.path,
    });
    try {
      const nestedAgent = makeAgent({
        cwd: nested,
        env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      await nestedAgent.runRaw([
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--no-agents-md',
      ]);

      const result = await nestedAgent.runRaw([
        'init',
        '--force',
        '--personal',
        '--json',
        '--no-llm',
      ]);

      expect(result.exitCode).toBe(0);
      expect(await exists(path.join(nested, '.orcaops', 'config.json'))).toBe(false);
      expect(await exists(path.join(repo.path, '.git', 'orcaops', 'config.json'))).toBe(true);
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', nested], { cwd: repo.path });
    }
  });

  it('points an already-initialized settings change to configure', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm']);

    const result = await agent.runRaw(['init', '--personal', '--no-llm']);
    const normalized = result.stderr
      .replaceAll(await realpath(repo.path), '<repo>')
      .replaceAll(repo.path, '<repo>');

    expect(result.exitCode).toBe(1);
    expect(normalized).toMatchInlineSnapshot(`
      "Error: <repo>/.git/orcaops/config.json already exists. Run \`orcaops configure\` to change settings, or pass --force to re-initialize.
      "
    `);
  });

  it('keeps a missing git info directory absent during dry-run planning', async () => {
    await rm(p('.git', 'info'), { recursive: true });

    const result = await agent.runRaw(['init', '--personal', '--dry-run', '--json', '--no-llm']);

    expect(result.exitCode).toBe(0);
    expect(await exists(p('.git', 'info'))).toBe(false);
  });

  it('a multi-agent personal install succeeds — skills go global, git status stays clean', async () => {
    const r = await agent.runRaw([
      'init',
      '--personal',
      '--install-agent',
      'claude-code',
      '--install-agent',
      'codex',
      '--json',
      '--no-llm',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      scope: string;
      install_agents: string[];
      warnings: string[];
      global: { materialized: string[] } | null;
    };
    expect(out.scope).toBe('personal');
    expect(out.install_agents).toEqual(['claude-code', 'codex']);
    // Both agents' skills materialize via the global machinery.
    expect(out.global).not.toBeNull();
    expect(out.global!.materialized.length).toBeGreaterThan(0);
    // Still zero tracked-file changes on the shared repo.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo.path })
      .toString()
      .trim();
    expect(status).toBe('');
  });

  it('config schema accepts scope personal (round-trips through resolve)', async () => {
    const r = await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
    expect(r.exitCode).toBe(0);
    const config = JSON.parse(await readFile(await effectiveConfigPath(repo.path), 'utf8')) as {
      install: { scope: string };
    };
    expect(config.install.scope).toBe('personal');
    // A follow-up command resolves the config without error (schema accepts it).
    const status = await agent.runRaw(['status', '--json']);
    expect(status.exitCode).toBe(0);
  });
});
