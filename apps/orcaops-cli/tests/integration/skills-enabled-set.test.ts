import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * The enabled skill set threads through EVERY consumer:
 * disable (config edit) → doctor flags skill-drift + a stale block →
 * `update` prunes the dir, drops it from install.json, AND re-renders the
 * managed AGENTS.md block without the dead ref → re-enable → `update`
 * restores all three. `--dry-run` previews the prune without touching disk.
 *
 * (This file pins the underlying pipeline via direct config edits; the
 * `orcaops skills enable|disable` command surface is covered in
 * `skills.test.ts`.)
 */

interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; status: string; summary: string; details?: string[] }>;
}

interface UpdateJson {
  ok: true;
  dry_run: boolean;
  installed: string[];
  pruned: string[];
  removed_dirs: string[];
}

describe('enabled skill set → install pipeline', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  const DIGEST_DIR = '.claude/skills/orcaops-digest';
  const DIGEST_FILE = `${DIGEST_DIR}/SKILL.md`;

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

  async function setDigestOverride(value: boolean | null): Promise<void> {
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
      skills?: { enabled: Record<string, boolean> };
    };
    if (value === null) {
      delete cfg.skills;
    } else {
      cfg.skills = { enabled: { digest: value } };
    }
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }

  const exists = async (rel: string): Promise<boolean> => {
    try {
      await stat(path.join(repo.path, rel));
      return true;
    } catch {
      return false;
    }
  };

  async function doctorCheck(name: string): Promise<{ status: string; details?: string[] }> {
    const res = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(res.stdout) as DoctorReport;
    const check = report.checks.find((c) => c.name === name);
    expect(check, name).toBeDefined();
    return check!;
  }

  it('disable → drift warns → update prunes (dir + manifest + block) → re-enable restores', async () => {
    // Baseline: installed and referenced.
    expect(await exists(DIGEST_FILE)).toBe(true);
    expect(await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8')).toContain('orcaops-digest');
    expect((await doctorCheck('skill-drift')).status).toBe('pass');

    // Disable digest (raw config edit).
    await setDigestOverride(false);

    // Doctor: still installed → skill-drift warns with the prune hint; the
    // block still references it → block-skill-refs warns about the dead ref.
    const drift = await doctorCheck('skill-drift');
    expect(drift.status).toBe('warn');
    expect(drift.details?.join('\n')).toMatch(/orcaops-digest/);
    expect(drift.details?.join('\n')).toMatch(/orcaops update/);
    const blockRefs = await doctorCheck('block-skill-refs');
    expect(blockRefs.status).toBe('warn');
    expect(blockRefs.details?.join('\n')).toMatch(/orcaops-digest/);

    // --dry-run previews the prune without touching disk.
    const dry = JSON.parse(
      (await agent.runRaw(['update', '--json', '--dry-run'])).stdout
    ) as UpdateJson;
    expect(dry.dry_run).toBe(true);
    expect(dry.pruned).toContain(DIGEST_FILE);
    expect(await exists(DIGEST_FILE)).toBe(true);

    // Real update: dir pruned, manifest entry dropped, block re-rendered.
    const real = JSON.parse((await agent.runRaw(['update', '--json'])).stdout) as UpdateJson;
    expect(real.pruned).toContain(DIGEST_FILE);
    expect(real.removed_dirs).toContain(DIGEST_DIR);
    expect(await exists(DIGEST_DIR)).toBe(false);
    const manifest = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')
    ) as { entries: Array<{ path: string }> };
    expect(manifest.entries.some((e) => e.path === DIGEST_FILE)).toBe(false);
    const agentsMd = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    expect(agentsMd).not.toContain('orcaops-digest');
    expect(agentsMd).toContain('plan → checkpoint(s) → finish.');

    // Doctor is green again on every skill surface.
    expect((await doctorCheck('skill-drift')).status).toBe('pass');
    expect((await doctorCheck('block-skill-refs')).status).toBe('pass');
    expect((await doctorCheck('agent-skills')).status).toBe('pass');

    // Re-enable → update reinstalls the dir and the block ref.
    await setDigestOverride(null);
    const restored = JSON.parse((await agent.runRaw(['update', '--json'])).stdout) as UpdateJson;
    expect(restored.installed).toContain(DIGEST_FILE);
    expect(await exists(DIGEST_FILE)).toBe(true);
    expect(await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8')).toContain('orcaops-digest');
    expect((await doctorCheck('skill-drift')).status).toBe('pass');
  });

  it('doctor rejects an unknown skills.enabled override id', async () => {
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
      skills?: { enabled: Record<string, boolean> };
    };
    cfg.skills = { enabled: { 'not-a-skill': true } };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const result = await agent.runRaw(['doctor', '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      overall: 'fail',
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'config',
          status: 'fail',
          summary: expect.stringContaining('skills.enabled.not-a-skill'),
        }),
      ]),
    });
  });
});
