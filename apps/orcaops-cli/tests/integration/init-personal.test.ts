import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

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
    expect(result.stderr).toContain('personal scope is unavailable');
    expect(result.stderr).toMatch(/AGENTS\.md|CLAUDE\.md|\.orcaops/u);
    expect(result.stderr).toContain('--scope project');
    // A clean CLI error, never a raw invariant stack trace.
    expect(result.stderr).not.toMatch(/\n\s+at /u);
  });

  it('keeps `git status` clean: block in CLAUDE.local.md, skills global, no committed install.json', async () => {
    const r = await agent.runRaw(['init', '--personal', '--json', '--no-llm', '--agents-md']);
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

    // Bootstrap block: CLAUDE.local.md only; team files untouched.
    const localMd = await readFile(p('CLAUDE.local.md'), 'utf8');
    expect(localMd).toContain('<!-- orcaops:start');
    expect(localMd).toContain('orcaops-capture');
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

    // No committed install.json; the local manifest carries everything.
    expect(await exists(p('.orcaops', 'install.json'))).toBe(false);
    expect(await exists(p('.orcaops', 'install.local.json'))).toBe(true);

    // The personal footprint hides via info/exclude — never .gitignore.
    const exclude = await readFile(p('.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('# >>> orcaops >>>');
    expect(exclude).toContain('.orcaops/');
    expect(exclude).toContain('CLAUDE.local.md');
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
    const result = await agent.runRaw(['init', '--personal', '--no-llm', '--agents-md']);
    const repoDisplayPath = await realpath(repo.path);
    const normalized = result.stdout
      .replaceAll(repoDisplayPath, '<repo>')
      .replaceAll(repo.path, '<repo>')
      .replaceAll(globalRoot, '<global>');

    expect(result.exitCode).toBe(0);
    expect(normalized).toMatchInlineSnapshot(`
      "Orcaops initialized at <repo>

      Created:
        .orcaops/artifacts/
        .orcaops/cache/
        .orcaops/config.json

      Installed 18 skills for claude-code → <global>/claude-code/skills

      Bootstrap section written to:
        + CLAUDE.local.md
        (enables automatic capture on non-trivial tasks;
         use --no-agents-md to opt out, or edit between the <!-- orcaops:* --> markers)

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

  it('points an already-initialized settings change to configure', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm']);

    const result = await agent.runRaw(['init', '--personal', '--no-llm']);
    const normalized = result.stderr
      .replaceAll(await realpath(repo.path), '<repo>')
      .replaceAll(repo.path, '<repo>');

    expect(result.exitCode).toBe(1);
    expect(normalized).toMatchInlineSnapshot(`
      "Error: <repo>/.orcaops already exists. Run \`orcaops configure\` to change settings, or pass --force to re-initialize.
      "
    `);
  });

  it('keeps a missing git info directory absent during dry-run planning', async () => {
    await rm(p('.git', 'info'), { recursive: true });

    const result = await agent.runRaw([
      'init',
      '--personal',
      '--dry-run',
      '--json',
      '--no-llm',
      '--agents-md',
    ]);

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
      '--agents-md',
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
    // The one structural Claude-ism surfaces as an ADVISORY, not an error:
    // only Claude Code reads CLAUDE.local.md.
    expect(out.warnings.some((w) => w.includes('only reaches Claude Code'))).toBe(true);
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
    const config = JSON.parse(await readFile(p('.orcaops', 'config.json'), 'utf8')) as {
      install: { scope: string };
    };
    expect(config.install.scope).toBe('personal');
    // A follow-up command resolves the config without error (schema accepts it).
    const status = await agent.runRaw(['status', '--json']);
    expect(status.exitCode).toBe(0);
  });
});
