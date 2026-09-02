import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { seedCloudLogin } from '../support/test-helpers.js';

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

interface GlobalManifest {
  materialized_by: string;
  entries: { agent: string; surface: string; prefix: string; path: string; refs: string[] }[];
}

/**
 * `update --scope global`. Hermetic via ORCAOPS_GLOBAL_ROOT (a temp dir),
 * so the real ~/.claude is never touched.
 */
describe('orcaops update --scope global', () => {
  let globalRoot: string;

  beforeEach(async () => {
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-groot-'));
  });
  afterEach(async () => {
    await rm(globalRoot, { recursive: true, force: true });
  });

  const agentFor = (repo: TempRepo): ReturnType<typeof makeAgent> =>
    makeAgent({ cwd: repo.path, env: { ORCAOPS_GLOBAL_ROOT: globalRoot } });

  const globalManifest = async (): Promise<GlobalManifest> =>
    JSON.parse(
      await readFile(path.join(globalRoot, 'install.local.json'), 'utf8')
    ) as GlobalManifest;

  /** Seed a credential file into a caller-owned config home; returns its path. */
  function seedCreds(configHome: string): string {
    seedCloudLogin({ dir: configHome, baseUrl: 'https://cloud.test' });
    return path.join(configHome, 'credentials.json');
  }

  it.each([
    ['init --force', ['init', '--no-llm', '--force', '--prefix', 'oo', '--json']],
    ['update', ['update', '--prefix', 'oo', '--json']],
  ])('keeps the old-prefix global cloud skills across a rename via %s', async (_label, argv) => {
    // The hold used to be keyed on the CURRENT prefix only, so a rename left the
    // old-prefix key in neither the desired nor the held set and the refcount
    // sweep deleted it — a skill the closed gate is then forbidden to re-create.
    const repo = await createTempRepo({ initialBranch: 'main' });
    const configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-rn-'));
    const cloudSkill = path.join(globalRoot, 'claude-code/skills/orcaops-plan-approval/SKILL.md');
    try {
      const agent = makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_GLOBAL_ROOT: globalRoot, ORCAOPS_CONFIG_HOME: configHome },
      });
      const credentials = seedCreds(configHome);
      await agent.runRaw(['init', '--no-llm', '--json']);
      await agent.runRaw(['update', '--scope', 'global', '--json']);
      expect(await exists(cloudSkill)).toBe(true);

      await rm(credentials, { force: true });
      const res = await agent.runRaw(argv);
      expect(res.exitCode).toBe(0);

      expect(await exists(cloudSkill)).toBe(true);
      // …while the ordinary skills did rename.
      expect(await exists(path.join(globalRoot, 'claude-code/skills/oo-capture/SKILL.md'))).toBe(
        true
      );
    } finally {
      await repo.cleanup();
      await rm(configHome, { recursive: true, force: true });
    }
  });

  it('keeps the old-prefix global cloud skills across a personal-scope rename', async () => {
    // Personal scope writes no committed manifest, so a caller can never source
    // the prior prefix from one — the derivation inside the installer is the
    // only thing that can protect this path.
    const repo = await createTempRepo({ initialBranch: 'main' });
    const configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-rnp-'));
    const cloudSkill = path.join(globalRoot, 'claude-code/skills/orcaops-plan-approval/SKILL.md');
    try {
      const agent = makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_GLOBAL_ROOT: globalRoot, ORCAOPS_CONFIG_HOME: configHome },
      });
      const credentials = seedCreds(configHome);
      await agent.runRaw(['init', '--no-llm', '--json', '--install-agent', 'claude-code']);
      await agent.runRaw(['update', '--personal', '--json']);
      expect(await exists(cloudSkill)).toBe(true);

      await rm(credentials, { force: true });
      const res = await agent.runRaw(['update', '--personal', '--prefix', 'oo', '--json']);
      expect(res.exitCode).toBe(0);
      expect(await exists(cloudSkill)).toBe(true);
    } finally {
      await repo.cleanup();
      await rm(configHome, { recursive: true, force: true });
    }
  });

  it('holds the global cloud skills when the credentials go away', async () => {
    // The gate blocks creation, never deletion -- and `update` is the call site
    // where global scope broke it: the gated skill set fed straight into the
    // refcount sweep, so a logout deleted the cloud skills from the user's
    // per-user dir on the next run, with the hash guard permitting it precisely
    // because the files were unmodified.
    const repo = await createTempRepo({ initialBranch: 'main' });
    const configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-gcfg-'));
    const credentials = path.join(configHome, 'credentials.json');
    const cloudSkill = path.join(globalRoot, 'claude-code/skills/orcaops-plan-approval/SKILL.md');
    try {
      const withCreds = makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_GLOBAL_ROOT: globalRoot, ORCAOPS_CONFIG_HOME: configHome },
      });
      seedCreds(configHome);

      await withCreds.runRaw(['init', '--no-llm', '--json']);
      await withCreds.runRaw(['update', '--scope', 'global', '--json']);
      expect(await exists(cloudSkill)).toBe(true);

      // The logout: credentials gone, everything else identical.
      await rm(credentials, { force: true });
      const res = await withCreds.runRaw(['update', '--json']);
      expect(res.exitCode).toBe(0);

      expect(await exists(cloudSkill)).toBe(true);
      const m = await globalManifest();
      const entry = m.entries.find((e) => e.path.includes('orcaops-plan-approval'));
      expect(entry?.refs).toHaveLength(1);
    } finally {
      await repo.cleanup();
      await rm(configHome, { recursive: true, force: true });
    }
  });

  it('migrates project skills to the global dirs; block + manifest stay project', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = agentFor(repo);
      await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json', '--agents-md']);
      // project skills exist after init
      expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
        true
      );

      const res = await agent.runRaw(['update', '--scope', 'global', '--json']);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as { scope: string; global: { materialized: string[] } };
      expect(out.scope).toBe('global');
      expect(out.global.materialized.length).toBeGreaterThan(0);

      // Skills now live GLOBALLY (under the temp root), and the project copies are pruned.
      expect(
        await exists(path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md'))
      ).toBe(true);
      expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
        false
      );

      // The instruction block stays PROJECT-scoped.
      const md = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
      expect(md).toMatch(/<!-- orcaops:start/);

      // The committed install.json (project) records NO generated-file entries under global
      // scope (skills are global), but still tracks the block + gitignore.
      const install = JSON.parse(
        await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')
      ) as { entries: { kind: string }[] };
      expect(install.entries.some((e) => e.kind === 'generated-file')).toBe(false);
      expect(install.entries.some((e) => e.kind === 'injected-block')).toBe(true);

      // scope persisted to config.
      const cfg = JSON.parse(
        await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
      ) as { install: { scope: string } };
      expect(cfg.install.scope).toBe('global');

      // doctor reflects global scope + a current global install.
      const doc = await agent.runRaw(['doctor', '--json']);
      const report = JSON.parse(doc.stdout) as {
        checks: { name: string; status: string; summary: string }[];
      };
      expect(report.checks.find((c) => c.name === 'agent-skills')?.summary).toMatch(/scope=global/);
      expect(report.checks.find((c) => c.name === 'global-install')?.status).toBe('pass');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an unowned global target before changing project scope', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = agentFor(repo);
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const configPath = path.join(repo.path, '.orcaops', 'config.json');
      const beforeConfig = await readFile(configPath, 'utf8');
      const target = path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'foreign bytes', 'utf8');

      const res = await agent.runRaw(['update', '--scope', 'global', '--json']);
      expect(res.exitCode).toBe(1);
      expect(await readFile(target, 'utf8')).toBe('foreign bytes');
      expect(await readFile(configPath, 'utf8')).toBe(beforeConfig);
      expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
        true
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('two repos sharing the global root ref-count a key to 2', async () => {
    const repoA = await createTempRepo({ initialBranch: 'main' });
    const repoB = await createTempRepo({ initialBranch: 'main' });
    try {
      for (const repo of [repoA, repoB]) {
        const agent = agentFor(repo);
        await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
        await agent.runRaw(['update', '--scope', 'global', '--json']);
      }
      const m = await globalManifest();
      expect(m.entries.length).toBeGreaterThan(0);
      // Every shared key is now referenced by BOTH repos (distinct repo ids).
      expect(m.entries.every((e) => e.refs.length === 2)).toBe(true);
    } finally {
      await repoA.cleanup();
      await repoB.cleanup();
    }
  });

  it('doctor warns when scope=global but nothing is materialized for this repo', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    const agent = agentFor(repo);
    try {
      // Project init, then flip config to scope=global WITHOUT materializing global.
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
      const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as { install: { scope: string } };
      cfg.install.scope = 'global';
      await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

      // globalRoot is an empty temp dir → no global manifest → not materialized here.
      const doc = await agent.runRaw(['doctor', '--json']);
      const report = JSON.parse(doc.stdout) as {
        checks: { name: string; status: string; summary: string }[];
      };
      const gi = report.checks.find((c) => c.name === 'global-install');
      expect(gi?.status).toBe('warn');
      expect(gi?.summary).toMatch(/no skills are materialized/);
    } finally {
      await repo.cleanup();
    }
  });

  it('doctor does NOT warn a project repo about another repo global version', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    const agent = agentFor(repo);
    try {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']); // scope=project (default)
      // Simulate ANOTHER repo's global materialization at a DIFFERENT CLI version.
      await writeFile(
        path.join(globalRoot, 'install.local.json'),
        `${JSON.stringify(
          {
            manifest_version: 1,
            materialized_by: '0.0.0-other-cli',
            entries: [
              {
                agent: 'claude-code',
                surface: 'skill',
                prefix: 'orcaops',
                path: path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md'),
                materialization: 'copy',
                symlinkTarget: null,
                expectedHash: 'other-repo-content-hash',
                refs: ['some-other-repo-id'],
              },
            ],
          },
          null,
          2
        )}\n`
      );
      // hasThisRepo is false (refs exclude this repo) + scope=project → no version warn.
      const doc = await agent.runRaw(['doctor', '--json']);
      const report = JSON.parse(doc.stdout) as { checks: { name: string; status: string }[] };
      expect(report.checks.find((c) => c.name === 'global-install')?.status).toBe('pass');
    } finally {
      await repo.cleanup();
    }
  });
});
