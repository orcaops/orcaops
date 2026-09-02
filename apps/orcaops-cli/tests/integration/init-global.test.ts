import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * `init --scope global`. Hermetic
 * via ORCAOPS_GLOBAL_ROOT (a temp dir), so the real ~/.claude is never touched.
 */
describe('orcaops init --scope global', () => {
  let globalRoot: string;

  beforeEach(async () => {
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-init-groot-'));
  });
  afterEach(async () => {
    await rm(globalRoot, { recursive: true, force: true });
  });

  const agentFor = (repo: TempRepo): ReturnType<typeof makeAgent> =>
    makeAgent({ cwd: repo.path, env: { ORCAOPS_GLOBAL_ROOT: globalRoot } });

  it('materializes global skills; project skills NOT installed; block + manifest stay project', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = agentFor(repo);
      const res = await agent.runRaw([
        'init',
        '--scope',
        'global',
        '--no-llm',
        '--json',
        '--agents-md',
      ]);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as { scope: string; global: { materialized: string[] } };
      expect(out.scope).toBe('global');
      expect(out.global.materialized.length).toBeGreaterThan(0);

      expect(
        await exists(path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md'))
      ).toBe(true);
      // project skills are NOT installed under global scope
      expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
        false
      );

      // block stays PROJECT
      const md = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
      expect(md).toMatch(/<!-- orcaops:start/);

      // committed install.json (project) records NO generated-file entries under global scope
      const install = JSON.parse(
        await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')
      ) as { entries: { kind: string }[] };
      expect(install.entries.some((e) => e.kind === 'generated-file')).toBe(false);

      // scope persisted to config
      const cfg = JSON.parse(
        await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
      ) as { install: { scope: string } };
      expect(cfg.install.scope).toBe('global');
    } finally {
      await repo.cleanup();
    }
  });

  it('init --force does NOT downgrade ahead FILES left by an interrupted newer run', async () => {
    // Artifacts land before the manifest, so only the bytes reveal the skew.
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = agentFor(repo);
      await agent.runRaw(['init', '--scope', 'global', '--no-llm', '--json']);

      const { writeFile } = await import('node:fs/promises');
      const skill = path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
      const aheadBytes = (await readFile(skill, 'utf8')).replace(
        /orcaops@[^"\n]+/,
        'orcaops@99.0.0'
      );
      await writeFile(skill, aheadBytes, 'utf8');
      // Manifest deliberately left claiming the CURRENT version — untouched.
      const manifestPath = path.join(globalRoot, 'install.local.json');
      const before = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        materialized_by: string;
      };

      const res = await agent.runRaw([
        'init',
        '--force',
        '--scope',
        'global',
        '--no-llm',
        '--json',
      ]);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as {
        global: { skipped_version_mismatch: boolean; materialized: string[]; removed: string[] };
        warnings: string[];
      };
      expect(out.global.skipped_version_mismatch).toBe(true);
      expect(out.warnings.join('\n')).toMatch(/NEWER orcaops \(v99\.0\.0\)/);
      expect(out.global.materialized).toEqual([]);
      expect(out.global.removed).toEqual([]);
      expect(await readFile(skill, 'utf8')).toBe(aheadBytes);
      const after = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        materialized_by: string;
      };
      expect(after.materialized_by).toBe(before.materialized_by);
    } finally {
      await repo.cleanup();
    }
  });

  it('init --force does NOT downgrade a global tree materialized by a NEWER orcaops (ahead guard)', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = agentFor(repo);
      await agent.runRaw(['init', '--scope', 'global', '--no-llm', '--json']);

      const { writeFile } = await import('node:fs/promises');
      const skill = path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
      const aheadBytes = (await readFile(skill, 'utf8')).replace(
        /orcaops@[^"\n]+/,
        'orcaops@99.0.0'
      );
      await writeFile(skill, aheadBytes, 'utf8');
      const manifestPath = path.join(globalRoot, 'install.local.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        materialized_by: string;
      };
      manifest.materialized_by = '99.0.0';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      const res = await agent.runRaw([
        'init',
        '--force',
        '--scope',
        'global',
        '--no-llm',
        '--json',
      ]);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as {
        global: { skipped_version_mismatch: boolean };
        warnings: string[];
      };
      expect(out.global.skipped_version_mismatch).toBe(true);
      expect(out.warnings.join('\n')).toMatch(/NEWER orcaops \(v99\.0\.0\)/);
      expect(await readFile(skill, 'utf8')).toBe(aheadBytes);
      const after = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        materialized_by: string;
      };
      expect(after.materialized_by).toBe('99.0.0'); // ownership not taken over

      const forced = await agent.runRaw(['update', '--force', '--json']);
      expect(forced.exitCode).toBe(0);
      expect(await readFile(skill, 'utf8')).not.toMatch(/orcaops@99\.0\.0/);
      const downgraded = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        materialized_by: string;
      };
      expect(downgraded.materialized_by).not.toBe('99.0.0');
    } finally {
      await repo.cleanup();
    }
  });

  it('--link symlink threads through to the global manifest', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = agentFor(repo);
      await agent.runRaw(['init', '--scope', 'global', '--link', 'symlink', '--no-llm', '--json']);
      const m = JSON.parse(await readFile(path.join(globalRoot, 'install.local.json'), 'utf8')) as {
        entries: { materialization: string }[];
      };
      // a fresh (absent) global dir → symlinked
      expect(m.entries.some((e) => e.materialization === 'symlink')).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('a global version mismatch refuses ALL global changes: no files, no refs', async () => {
    const repoA = await createTempRepo({ initialBranch: 'main' });
    const repoB = await createTempRepo({ initialBranch: 'main' });
    try {
      await agentFor(repoA).runRaw(['init', '--scope', 'global', '--no-llm', '--json']);
      const manifestPath = path.join(globalRoot, 'install.local.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        materialized_by: string;
      };
      manifest.materialized_by = '0.0.0-other';
      const mismatched = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(manifestPath, mismatched, 'utf8');
      const skill = path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
      const before = await readFile(skill, 'utf8');

      const result = await agentFor(repoB).runRaw([
        'init',
        '--scope',
        'global',
        '--no-llm',
        '--json',
      ]);

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout) as {
        global: { skipped_version_mismatch: boolean; materialized: string[] } | null;
      };
      expect(out.global?.skipped_version_mismatch).toBe(true);
      expect(out.global?.materialized).toHaveLength(0);
      expect(await readFile(skill, 'utf8')).toBe(before);
      // Refcounts are part of the mismatched tree's ownership state: the
      // refusal leaves the manifest byte-identical — repoB records no ref.
      expect(await readFile(manifestPath, 'utf8')).toBe(mismatched);
    } finally {
      await repoA.cleanup();
      await repoB.cleanup();
    }
  });

  it('default init (no --scope) is INVISIBLE: personal scope, global skills, no repo trees', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = agentFor(repo);
      const res = await agent.runRaw(['init', '--no-llm', '--json']);
      const out = JSON.parse(res.stdout) as {
        scope: string;
        global: { materialized: string[] } | null;
      };
      expect(out.scope).toBe('personal');
      expect(out.global).not.toBeNull();
      expect(out.global!.materialized.length).toBeGreaterThan(0);
      // Skills materialize under the (sandboxed) global root — never the repo.
      expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
        false
      );
      expect(await exists(path.join(globalRoot, 'install.local.json'))).toBe(true);

      // The old project default is one flag away.
      const proj = await agent.runRaw([
        'init',
        '--scope',
        'project',
        '--no-llm',
        '--json',
        '--force',
      ]);
      const pOut = JSON.parse(proj.stdout) as { scope: string };
      expect(pOut.scope).toBe('project');
      expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
        true
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an unowned global target before creating project state', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const target = path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'foreign bytes', 'utf8');

      const res = await agentFor(repo).runRaw(['init', '--scope', 'global', '--no-llm', '--json']);
      expect(res.exitCode).toBe(1);
      expect(await readFile(target, 'utf8')).toBe('foreign bytes');
      expect(await exists(path.join(repo.path, '.orcaops'))).toBe(false);
      expect(await exists(path.join(repo.path, 'AGENTS.md'))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a bogus --scope', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = makeAgent({ cwd: repo.path });
      const res = await agent.runRaw(['init', '--scope', 'bogus', '--no-llm', '--json']);
      expect(res.exitCode).not.toBe(0);
    } finally {
      await repo.cleanup();
    }
  });
});
