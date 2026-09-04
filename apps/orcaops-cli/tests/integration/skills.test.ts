import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * `orcaops skills list|enable|disable` end to end:
 * list → disable → update prunes → enable → update restores, plus the
 * per-row list contract, no-op detection, the lifecycle warning, and
 * unknown-id rejection. The pure toggle matrix lives in
 * `commands/skills/toggle.test.ts`.
 */

interface SkillsListOk {
  ok: true;
  skills: Array<{
    id: string;
    group: string | null;
    default_enabled: boolean;
    override: boolean | null;
    effective: boolean;
    requires: string[];
    capability_satisfied: boolean;
    installed: Record<string, boolean> | null;
  }>;
}

interface ToggleOk {
  ok: true;
  id: string;
  enabled: boolean;
  previous_effective: boolean;
  previous_override: boolean | null;
  noop: boolean;
  config_path: string;
  warnings: string[];
  hint: string;
}

describe('orcaops skills list|enable|disable', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  const DIGEST_FILE = '.claude/skills/orcaops-digest/SKILL.md';

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--agents-md',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const exists = async (rel: string): Promise<boolean> => {
    try {
      await stat(path.join(repo.path, rel));
      return true;
    } catch {
      return false;
    }
  };

  async function list(): Promise<SkillsListOk> {
    const r = await agent.runRaw(['skills', 'list', '--json']);
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout) as SkillsListOk;
  }

  it('list → disable → update prunes → enable → update restores', async () => {
    // Fresh init: every shipped skill effective + installed for claude-code.
    const fresh = await list();
    expect(fresh.skills.length).toBeGreaterThanOrEqual(10);
    const freshDigest = fresh.skills.find((s) => s.id === 'digest')!;
    expect(freshDigest).toMatchObject({
      group: 'read',
      default_enabled: true,
      override: null,
      effective: true,
      capability_satisfied: true,
    });
    expect(freshDigest.installed).toEqual({ 'claude-code': true });

    // Disable persists the override + hints at update.
    const disable = JSON.parse(
      (await agent.runRaw(['skills', 'disable', 'digest', '--json'])).stdout
    ) as ToggleOk;
    expect(disable).toMatchObject({
      id: 'digest',
      enabled: false,
      previous_effective: true,
      previous_override: null,
      noop: false,
    });
    expect(disable.hint).toMatch(/orcaops update/);
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { skills: { enabled: Record<string, boolean> } };
    expect(cfg.skills.enabled).toEqual({ digest: false });

    // Not yet materialized: still installed until update runs.
    const preUpdate = await list();
    const preDigest = preUpdate.skills.find((s) => s.id === 'digest')!;
    expect(preDigest.effective).toBe(false);
    expect(preDigest.override).toBe(false);
    expect(preDigest.installed).toEqual({ 'claude-code': true });

    // update prunes the dir; list reflects it.
    await agent.runRaw(['update', '--json']);
    expect(await exists(DIGEST_FILE)).toBe(false);
    const postPrune = await list();
    expect(postPrune.skills.find((s) => s.id === 'digest')!.installed).toEqual({
      'claude-code': false,
    });

    // enable → update restores.
    const enable = JSON.parse(
      (await agent.runRaw(['skills', 'enable', 'digest', '--json'])).stdout
    ) as ToggleOk;
    expect(enable).toMatchObject({ enabled: true, previous_effective: false, noop: false });
    await agent.runRaw(['update', '--json']);
    expect(await exists(DIGEST_FILE)).toBe(true);
    const restored = await list();
    expect(restored.skills.find((s) => s.id === 'digest')!).toMatchObject({
      effective: true,
      installed: { 'claude-code': true },
    });
  });

  it('renders the human table with per-agent install columns', async () => {
    const r = await agent.runRaw(['skills', 'list']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      'ID              GROUP          EFFECTIVE  DEFAULT  OVERRIDE  INSTALLED'
    );
    // digest: group read, effective, default on, no override, installed for claude-code.
    expect(r.stdout).toMatch(/digest\s+read\s+true\s+true\s+-\s+claude-code:yes/);
    // loose-ends: default-off insight skill, not installed.
    expect(r.stdout).toMatch(/loose-ends\s+insight\s+false\s+false\s+-\s+claude-code:no/);
  });

  it('an opt-in skill is absent by default; enable → update materializes its file', async () => {
    // Default exclusion: not installed, not effective, not referenced by the block.
    const LOOSE_ENDS_FILE = '.claude/skills/orcaops-loose-ends/SKILL.md';
    expect(await exists(LOOSE_ENDS_FILE)).toBe(false);
    expect(await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8')).not.toContain(
      'orcaops-loose-ends'
    );
    const fresh = await list();
    expect(fresh.skills.find((s) => s.id === 'loose-ends')!).toMatchObject({
      group: 'insight',
      default_enabled: false,
      override: null,
      effective: false,
      installed: { 'claude-code': false },
    });

    // enable → update: file materializes AND the block gains the skill's
    // routing trigger (enabled skills with a blockTriggerLine contribute an
    // intent entry).
    await agent.runRaw(['skills', 'enable', 'loose-ends', '--json']);
    await agent.runRaw(['update', '--json']);
    expect(await exists(LOOSE_ENDS_FILE)).toBe(true);
    expect(await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8')).toContain(
      'orcaops-loose-ends'
    );
    const after = await list();
    expect(after.skills.find((s) => s.id === 'loose-ends')!).toMatchObject({
      effective: true,
      installed: { 'claude-code': true },
    });
  });

  it('an insight skill (lessons) follows the same enable → update story', async () => {
    const LESSONS_FILE = '.claude/skills/orcaops-lessons/SKILL.md';
    expect(await exists(LESSONS_FILE)).toBe(false);
    const fresh = await list();
    expect(fresh.skills.find((s) => s.id === 'lessons')!).toMatchObject({
      group: 'insight',
      default_enabled: false,
      effective: false,
    });

    await agent.runRaw(['skills', 'enable', 'lessons', '--json']);
    await agent.runRaw(['update', '--json']);
    expect(await exists(LESSONS_FILE)).toBe(true);
    expect(await readFile(path.join(repo.path, LESSONS_FILE), 'utf8')).toContain(
      'orcaops stats --json'
    );
    expect(await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8')).toContain('orcaops-lessons');
  });

  it('reports a final generated-file symlink as not installed without inspecting its target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-skills-list-outside-'));
    const external = path.join(outside, 'SKILL.md');
    const externalBody = 'generatedBy: "orcaops@0.0.0"\nexternal\n';
    await writeFile(external, externalBody, 'utf8');
    await rm(path.join(repo.path, DIGEST_FILE));
    await symlink(external, path.join(repo.path, DIGEST_FILE));

    try {
      const out = await list();
      expect(out.skills.find((s) => s.id === 'digest')?.installed).toEqual({
        'claude-code': false,
      });
      expect(await readFile(external, 'utf8')).toBe(externalBody);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(['symlink', 'directory'] as const)(
    'reports a contained final %s replacement as not installed',
    async (replacement) => {
      const digestPath = path.join(repo.path, DIGEST_FILE);
      await rm(digestPath);
      if (replacement === 'symlink') {
        const target = path.join(repo.path, 'replacement-skill.md');
        await writeFile(target, 'generatedBy: "orcaops@0.0.5"\ncontained\n', 'utf8');
        await symlink(target, digestPath);
      } else {
        await mkdir(digestPath);
      }

      const out = await list();
      expect(out.skills.find((s) => s.id === 'digest')?.installed).toEqual({
        'claude-code': false,
      });
    }
  );

  it('no-op detection keys on the effective state; the override is still recorded', async () => {
    const r = JSON.parse(
      (await agent.runRaw(['skills', 'enable', 'digest', '--json'])).stdout
    ) as ToggleOk;
    expect(r.noop).toBe(true);
    expect(r.previous_effective).toBe(true);
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { skills: { enabled: Record<string, boolean> } };
    expect(cfg.skills.enabled).toEqual({ digest: true });
  });

  it('disabling a lifecycle skill warns (allowed, not denylisted)', async () => {
    const r = JSON.parse(
      (await agent.runRaw(['skills', 'disable', 'checkpoint', '--json'])).stdout
    ) as ToggleOk;
    expect(r.enabled).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/degrades the capture lifecycle/);
  });

  it('author-evaluator lists under the authoring group and disables without a warning', async () => {
    const fresh = await list();
    const row = fresh.skills.find((s) => s.id === 'author-evaluator')!;
    expect(row).toMatchObject({ group: 'authoring', default_enabled: true, effective: true });
    expect(row.installed?.['claude-code']).toBe(true);

    // The lifecycle-disable warning keys on the group; a discoverability skill
    // must not borrow it.
    const off = JSON.parse(
      (await agent.runRaw(['skills', 'disable', 'author-evaluator', '--json'])).stdout
    ) as ToggleOk;
    expect(off.enabled).toBe(false);
    expect(off.warnings).toEqual([]);
  });

  it('an unknown id is rejected with the known-id list', async () => {
    const r = await agent.runRaw(['skills', 'enable', 'nope', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { ok: false; error: { code: string; message: string } };
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toContain('capture');
  });

  it('unknown override ids in config are rejected', async () => {
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    cfg.skills = { enabled: { 'future-skill': true } };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const result = await agent.runRaw(['skills', 'list', '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_CONFIG', path: 'skills.enabled.future-skill' },
    });
  });
});

describe('orcaops skills list under personal scope', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let globalRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-skills-personal-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_GLOBAL_ROOT: globalRoot },
    });
    await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(globalRoot, { recursive: true, force: true });
  });

  const exists = async (abs: string): Promise<boolean> => {
    try {
      await stat(abs);
      return true;
    } catch {
      return false;
    }
  };

  it('reports installed state from the per-user dirs, not project paths', async () => {
    const r = await agent.runRaw(['skills', 'list', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as SkillsListOk;
    const digest = out.skills.find((s) => s.id === 'digest')!;
    expect(digest.installed).toEqual({ 'claude-code': true });

    // The report comes from the per-user materialization: the repo tree has
    // no skill files at all, and the per-user file is present.
    expect(await exists(path.join(repo.path, '.claude/skills/orcaops-digest/SKILL.md'))).toBe(
      false
    );
    const perUserDir = path.join(globalRoot, 'claude-code', 'skills', 'orcaops-digest');
    expect(await exists(path.join(perUserDir, 'SKILL.md'))).toBe(true);

    // Removing the per-user materialization flips the report — the row
    // tracks the per-user dir, not the manifest alone.
    await rm(perUserDir, { recursive: true, force: true });
    const after = JSON.parse(
      (await agent.runRaw(['skills', 'list', '--json'])).stdout
    ) as SkillsListOk;
    expect(after.skills.find((s) => s.id === 'digest')!.installed).toEqual({
      'claude-code': false,
    });
  });
});
