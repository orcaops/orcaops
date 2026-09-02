import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { withRepositoryInstallLock } from '../../src/lib/repository-install-lock.js';
import { makeAgent } from '../support/test-agent.js';

interface UninstallJson {
  ok: true;
  command: 'uninstall';
  applied: boolean;
  dry_run: boolean;
  manifest_present: boolean;
  removed: string[];
  removed_unverified: { path: string; kind: string }[];
  removed_dirs: string[];
  preserved: { path: string; kind: string; reason: string }[];
  confirm_required: { path: string; kind: string }[];
  blocks_removed: string[];
  blocks_preserved_modified: string[];
  hooks_removed: string[];
  hooks_preserved: string[];
  hooks_unverified: string[];
  gitignore_removed: string[];
  data_purged: boolean;
  global: { removed: string[]; skipped_version_mismatch: boolean; root: string } | null;
  warnings: string[];
}

/** Exists, following symlinks (a dangling symlink → false). */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
/** Exists as a path entry, NOT following symlinks (detects the link itself). */
async function lexists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `orcaops uninstall` / eject. Reverses init under the same deleteMode
 * guard as prune (hash → remove, never → preserve, confirm → list / --force),
 * excises managed blocks (never the host with user prose), removes stamped hooks
 * and orcaops .gitignore lines, and keeps .orcaops data unless --purge-data.
 */
describe('orcaops uninstall', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { CLAUDE_SESSION_ID: 'test-uninstall' } });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const p = (...segs: string[]): string => path.join(repo.path, ...segs);

  describe('the shared global install', () => {
    let globalRoot: string;
    beforeEach(async () => {
      globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-uni-g-'));
    });
    afterEach(async () => {
      await rm(globalRoot, { recursive: true, force: true });
    });

    const globalAgent = (cwd: string): ReturnType<typeof makeAgent> =>
      makeAgent({ cwd, env: { ORCAOPS_GLOBAL_ROOT: globalRoot } });
    // Lazy: globalRoot is assigned in beforeEach, after the describe body runs.
    const globalSkill = (): string =>
      path.join(globalRoot, 'claude-code/skills/orcaops-capture/SKILL.md');

    it('releases this repo refs and removes the artifacts it held last', async () => {
      const a = globalAgent(repo.path);
      await a.runRaw(['init', '--no-llm', '--json']);
      await a.runRaw(['update', '--scope', 'global', '--json']);
      expect(await exists(globalSkill())).toBe(true);

      const res = await a.runRaw(['uninstall', '--json']);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as UninstallJson;
      expect(out.global?.removed.length).toBeGreaterThan(0);
      // Last reference gone, so the artifacts go with it.
      expect(await exists(globalSkill())).toBe(false);
    });

    it('leaves a key another repo still references, then lets that repo clean up', async () => {
      // A phantom ref would block the other repo's genuine cleanup.
      const other = await createTempRepo({ initialBranch: 'main' });
      try {
        for (const r of [repo.path, other.path]) {
          const a = globalAgent(r);
          await a.runRaw(['init', '--no-llm', '--json']);
          await a.runRaw(['update', '--scope', 'global', '--json']);
        }
        await globalAgent(repo.path).runRaw(['uninstall', '--json']);
        // Still referenced by `other`.
        expect(await exists(globalSkill())).toBe(true);

        await globalAgent(other.path).runRaw(['uninstall', '--json']);
        expect(await exists(globalSkill())).toBe(false);
      } finally {
        await other.cleanup();
      }
    });

    it('removes the per-machine manifest under personal scope', async () => {
      // It is the ONLY manifest personal scope writes, so gating its removal on
      // the committed one leaves it behind on the scope that has neither.
      const a = globalAgent(repo.path);
      await a.runRaw(['init', '--no-llm', '--json', '--install-agent', 'claude-code']);
      await a.runRaw(['update', '--personal', '--json']);
      expect(await exists(p('.orcaops', 'install.local.json'))).toBe(true);

      await a.runRaw(['uninstall', '--json']);
      expect(await exists(p('.orcaops', 'install.local.json'))).toBe(false);
    });

    it('releases under personal scope, which writes no committed manifest', async () => {
      // Personal scope has no committed install.json, but the per-machine
      // manifest counts as ownership — and the global release must fire.
      const a = globalAgent(repo.path);
      await a.runRaw(['init', '--no-llm', '--json', '--install-agent', 'claude-code']);
      await a.runRaw(['update', '--personal', '--json']);
      expect(await exists(globalSkill())).toBe(true);

      const res = await a.runRaw(['uninstall', '--json']);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as UninstallJson;
      expect(await exists(p('.orcaops', 'install.json'))).toBe(false);
      expect(out.manifest_present).toBe(true);
      expect(out.global?.removed.length).toBeGreaterThan(0);
      expect(await exists(globalSkill())).toBe(false);
    });

    it('resuming an interrupted purge still releases gate-held cloud refs', async () => {
      // The recovery path releases global refs with the gate closed; uninstall
      // is user-initiated deletion, so a hold must not leak the cloud skills.
      const configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-uni-resume-'));
      try {
        await writeFile(
          path.join(configHome, 'credentials.json'),
          JSON.stringify({
            'https://cloud.example': {
              v: 1,
              loginMethod: 'oauth',
              baseUrl: 'https://cloud.example',
              userId: 'u',
              orgId: 'o',
              orgName: null,
              orgSlug: null,
              email: 'a@b.c',
              accessToken: 'at',
              refreshToken: 'rt',
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          }),
          { mode: 0o600 }
        );
        const a = makeAgent({
          cwd: repo.path,
          env: { ORCAOPS_GLOBAL_ROOT: globalRoot, ORCAOPS_CONFIG_HOME: configHome },
        });
        await a.runRaw(['init', '--no-llm', '--json', '--install-agent', 'claude-code']);
        await a.runRaw(['update', '--scope', 'global', '--json']);
        const cloudSkill = path.join(
          globalRoot,
          'claude-code',
          'skills',
          'orcaops-plan-approval',
          'SKILL.md'
        );
        expect(await exists(cloudSkill)).toBe(true);

        await rm(path.join(configHome, 'credentials.json'));
        // The recovery precondition: .orcaops exists but holds no config.
        await rm(p('.orcaops'), { recursive: true, force: true });
        await mkdir(p('.orcaops'));

        const res = await a.runRaw(['uninstall', '--purge-data', '--json']);
        expect(res.exitCode).toBe(0);
        const out = JSON.parse(res.stdout) as UninstallJson;
        expect(out.data_purged).toBe(true);
        // The recovery path reports its release like the main path does.
        expect(out.global?.removed.length).toBeGreaterThan(0);
        expect(await exists(p('.orcaops'))).toBe(false);
        expect(await exists(cloudSkill)).toBe(false);
        expect(
          await exists(path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture'))
        ).toBe(false);
      } finally {
        await rm(configHome, { recursive: true, force: true });
      }
    });

    it('a held install lock refuses the uninstall and leaves the gate surface untouched', async () => {
      // The 10s acquisition wait is product behaviour; the budget clears it.
      const configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-uni-lock-'));
      try {
        await writeFile(
          path.join(configHome, 'credentials.json'),
          JSON.stringify({
            'https://cloud.example': {
              v: 1,
              loginMethod: 'oauth',
              baseUrl: 'https://cloud.example',
              userId: 'u',
              orgId: 'o',
              orgName: null,
              orgSlug: null,
              email: 'a@b.c',
              accessToken: 'at',
              refreshToken: 'rt',
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          }),
          { mode: 0o600 }
        );
        const a = makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } });
        await a.runRaw([
          'init',
          '--scope',
          'project',
          '--no-llm',
          '--json',
          '--install-agent',
          'claude-code',
        ]);
        const manifestPath = p('.orcaops', 'install.json');
        const cloudSkillPath = p('.claude', 'skills', 'orcaops-plan-approval', 'SKILL.md');
        const manifestBefore = await readFile(manifestPath, 'utf8');
        const skillBefore = await readFile(cloudSkillPath, 'utf8');

        const commonDir = await new Repo(repo.path).getCommonDirAbsolute();
        let acquired!: () => void;
        let release!: () => void;
        const acquiredP = new Promise<void>((r) => (acquired = r));
        const gate = new Promise<void>((r) => (release = r));
        const holder = withRepositoryInstallLock(commonDir, async () => {
          acquired();
          await gate;
        });
        await acquiredP;
        try {
          const res = await a.runRaw(['uninstall', '--json']);
          expect(res.exitCode).not.toBe(0);
          const env = JSON.parse(res.stdout) as { ok: boolean; error?: { code: string } };
          expect(env.ok).toBe(false);
          expect(env.error?.code).toBe('LOCK_TIMEOUT');
        } finally {
          release();
          await holder;
        }

        expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore);
        expect(await readFile(cloudSkillPath, 'utf8')).toBe(skillBefore);
      } finally {
        await rm(configHome, { recursive: true, force: true });
      }
    }, 25_000);

    it('reports no global block for a project-scope repo that holds nothing', async () => {
      const a = globalAgent(repo.path);
      await a.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
      const res = await a.runRaw(['uninstall', '--json']);
      expect((JSON.parse(res.stdout) as UninstallJson).global).toBeNull();
    });
  });

  describe('with cloud skills present', () => {
    const CLOUD_SKILLS = ['orcaops-plan-approval', 'orcaops-review'];
    let configHome: string;
    let a: ReturnType<typeof makeAgent>;

    beforeEach(async () => {
      configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-uni-cloud-'));
      await writeFile(
        path.join(configHome, 'credentials.json'),
        JSON.stringify({
          'https://cloud.example': {
            v: 1,
            loginMethod: 'oauth',
            baseUrl: 'https://cloud.example',
            userId: 'u',
            orgId: 'o',
            orgName: null,
            orgSlug: null,
            email: 'a@b.c',
            accessToken: 'at',
            refreshToken: 'rt',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
        }),
        { mode: 0o600 }
      );
      a = makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } });
      await a.runRaw([
        'init',
        '--scope',
        'project',
        '--no-llm',
        '--json',
        '--install-agent',
        'claude-code',
      ]);
      for (const id of CLOUD_SKILLS) {
        expect(await exists(p('.claude', 'skills', id, 'SKILL.md'))).toBe(true);
      }
    });
    afterEach(async () => {
      await rm(configHome, { recursive: true, force: true });
    });

    it('removes the cloud skills a signed-in install materialized', async () => {
      const res = await a.runRaw(['uninstall', '--json']);
      expect(res.exitCode).toBe(0);
      const r = JSON.parse(res.stdout) as UninstallJson;
      for (const id of CLOUD_SKILLS) {
        expect(r.removed).toContain(`.claude/skills/${id}/SKILL.md`);
        expect(await exists(p('.claude', 'skills', id))).toBe(false);
      }
      expect(r.confirm_required).toEqual([]);
    });

    it('a fresh clone with the gate closed still removes them hash-verified', async () => {
      // No local manifest and no credentials: reconstruction renders the full
      // registry (not the gated set) precisely so ownership can be proven
      // here, and uninstall is user deletion, which the gate never blocks.
      await rm(path.join(configHome, 'credentials.json'));
      await rm(p('.orcaops', 'install.local.json'));

      const res = await a.runRaw(['uninstall', '--json']);
      expect(res.exitCode).toBe(0);
      const r = JSON.parse(res.stdout) as UninstallJson;
      for (const id of CLOUD_SKILLS) {
        expect(r.removed).toContain(`.claude/skills/${id}/SKILL.md`);
        expect(await exists(p('.claude', 'skills', id))).toBe(false);
      }
      // The instruction symlink may be unverifiable on a fresh clone; the
      // cloud entries must not be — their reconstruction hash-verifies.
      const cloudish = (l: { path: string }[]): { path: string }[] =>
        l.filter((e) => /plan-approval|orcaops-review\//.test(e.path));
      expect(cloudish(r.confirm_required)).toEqual([]);
      expect(cloudish(r.removed_unverified)).toEqual([]);
    });

    it('removes carry-forward-preserved cloud skills after the credentials are gone', async () => {
      // The gate blocks creation, never deletion: an uninstall on a machine
      // that lost its credentials must still remove what the manifest owns.
      await rm(path.join(configHome, 'credentials.json'));
      await a.runRaw(['update', '--json']);
      for (const id of CLOUD_SKILLS) {
        expect(await exists(p('.claude', 'skills', id, 'SKILL.md'))).toBe(true);
      }

      const res = await a.runRaw(['uninstall', '--json']);
      expect(res.exitCode).toBe(0);
      const r = JSON.parse(res.stdout) as UninstallJson;
      for (const id of CLOUD_SKILLS) {
        expect(r.removed).toContain(`.claude/skills/${id}/SKILL.md`);
        expect(await exists(p('.claude', 'skills', id))).toBe(false);
      }
      expect(r.confirm_required).toEqual([]);
    });
  });

  it('an interrupted-purge resume with no global refs reports global: null', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
    await rm(p('.orcaops'), { recursive: true, force: true });
    await mkdir(p('.orcaops'));

    const res = await agent.runRaw(['uninstall', '--purge-data', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as UninstallJson;
    expect(out.data_purged).toBe(true);
    expect(out.global).toBeNull();
  });

  it('reports the empty dirs it removed', async () => {
    // A platform-separator split makes every depth 1, so the >= 2 filter drops
    // everything and the cleanup silently returns nothing.
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
    const res = await agent.runRaw(['uninstall', '--json']);
    const out = JSON.parse(res.stdout) as UninstallJson;
    expect(out.removed_dirs.length).toBeGreaterThan(0);
    expect(out.removed_dirs).toContain('.claude/skills');
    for (const d of out.removed_dirs) expect(await exists(p(d))).toBe(false);
  });

  it('init --with-hooks → uninstall --purge-data round-trips to pre-init state', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--with-hooks', '--agents-md']);
    // sanity: init materialized the footprint
    expect(await exists(p('.orcaops', 'config.json'))).toBe(true);
    expect(await exists(p('.claude', 'skills', 'orcaops-capture', 'SKILL.md'))).toBe(true);
    expect(await exists(p('AGENTS.md'))).toBe(true);
    expect(await lexists(p('CLAUDE.md'))).toBe(true);

    const res = await agent.runRaw(['uninstall', '--purge-data', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.data_purged).toBe(true);

    // pre-init: nothing orcaops left. The top-level `.claude` agent dir is intentionally left
    // behind (it may pre-exist orcaops), but its orcaops subdirs are gone.
    expect(await exists(p('.orcaops'))).toBe(false);
    expect(await exists(p('.claude', 'skills'))).toBe(false);
    expect(await exists(p('.claude', 'commands'))).toBe(false);
    expect(await lexists(p('AGENTS.md'))).toBe(false);
    expect(await lexists(p('CLAUDE.md'))).toBe(false);
    expect(await exists(p('.gitignore'))).toBe(false); // --purge removes ALL orcaops gitignore lines
    expect(await exists(p('.git', 'hooks', 'post-merge'))).toBe(false);
    expect(await exists(p('.git', 'hooks', 'post-rewrite'))).toBe(false);
    // and it reported the work
    expect(r.removed.some((x) => x.includes('orcaops-capture'))).toBe(true);
    expect(r.hooks_removed).toContain(path.join('.git', 'hooks', 'post-merge'));
    expect(r.removed_dirs).toContain(path.join('.claude', 'skills'));
    expect(r.removed_dirs).not.toContain('.claude'); // top-level agent dir protected
    // The repo identity survives even a purge: it is what reattaches this
    // checkout to its archived history, which the purge does not touch.
    const projectId = execFileSync('git', ['config', '--local', '--get', 'orcaops.projectid'], {
      cwd: repo.path,
      encoding: 'utf8',
    }).trim();
    expect(projectId).toMatch(/\S/);
  });

  it('default uninstall keeps .orcaops data but removes the install footprint', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const res = await agent.runRaw(['uninstall', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.data_purged).toBe(false);

    // install footprint gone … (the top-level `.claude` is left behind, subdirs removed)
    expect(await exists(p('.claude', 'skills'))).toBe(false);
    expect(await lexists(p('AGENTS.md'))).toBe(false);
    expect(await exists(p('.orcaops', 'install.json'))).toBe(false);
    expect(await exists(p('.orcaops', 'install.local.json'))).toBe(false);
    // … but the user's captured data + config stay
    expect(await exists(p('.orcaops', 'config.json'))).toBe(true);
    expect(await exists(p('.orcaops', 'artifacts'))).toBe(true);
    expect(await exists(p('.orcaops', 'cache'))).toBe(true);
    // The retained .orcaops data stays git-ignored (its ignore lines are NOT removed on a
    // non-purge uninstall); only the now-deleted install.local.json line is dropped.
    const gi = await readFile(p('.gitignore'), 'utf8');
    expect(gi).toContain('.orcaops/artifacts/');
    expect(gi).toContain('.orcaops/cache/');
    expect(gi).not.toContain('install.local.json');
  });

  it.each([[['uninstall', '--json']], [['uninstall', '--force', '--json']]])(
    'preserves an ahead-stamped skill whose newer manifest hash matches (%s)',
    async (cmd) => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
      // Simulate a NEWER CLI's install: restamp a skill and record its
      // matching hash in install.local.json, as the newer CLI itself would.
      const rel = path.join('.claude', 'skills', 'orcaops-capture', 'SKILL.md');
      const abs = p(rel);
      const aheadBytes = (await readFile(abs, 'utf8')).replace(/orcaops@[^"\n]+/, 'orcaops@99.0.0');
      await writeFile(abs, aheadBytes, 'utf8');
      const localPath = p('.orcaops', 'install.local.json');
      const local = JSON.parse(await readFile(localPath, 'utf8')) as {
        entries: { path: string; expectedHash: string | null }[];
      };
      const entry = local.entries.find((e) => e.path === rel.split(path.sep).join('/'))!;
      entry.expectedHash = createHash('sha256').update(aheadBytes).digest('hex');
      await writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`, 'utf8');

      const res = await agent.runRaw(cmd);
      expect(res.exitCode).toBe(0);
      expect(await exists(abs)).toBe(true);
      expect(await readFile(abs, 'utf8')).toBe(aheadBytes);
      const out = JSON.parse(res.stdout) as {
        preserved: { path: string; reason: string }[];
      };
      expect(out.preserved).toContainEqual(
        expect.objectContaining({ path: rel.split(path.sep).join('/'), reason: 'pre-existing' })
      );
    }
  );

  it('an AHEAD-stamped git hook survives uninstall and is named in the human output', async () => {
    await agent.runRaw(['init', '--no-llm', '--with-hooks']);
    const hookPath = p('.git', 'hooks', 'post-merge');
    const aheadBody = (await readFile(hookPath, 'utf8')).replace(
      /# orcaops-hook v=[^\s]+/,
      '# orcaops-hook v=99.0.0'
    );
    await writeFile(hookPath, aheadBody, { mode: 0o755 });

    const res = await agent.runRaw(['uninstall']);
    expect(res.exitCode).toBe(0);
    expect(await readFile(hookPath, 'utf8')).toBe(aheadBody);
    expect(res.stdout + res.stderr).toMatch(/stamped by a NEWER orcaops/);
    // The other hook (current stamp) is still removed normally.
    expect(await exists(p('.git', 'hooks', 'post-rewrite'))).toBe(false);
  });

  it('releases global refs before purging project data', async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-uninstall-global-'));
    try {
      const globalAgent = makeAgent({
        cwd: repo.path,
        env: { CLAUDE_SESSION_ID: 'test-uninstall-global', ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      await globalAgent.runRaw([
        'init',
        '--scope',
        'global',
        '--install-agent',
        'claude-code',
        '--no-llm',
        '--agents-md',
      ]);

      const res = await globalAgent.runRaw(['uninstall', '--purge-data', '--json']);
      expect(res.exitCode).toBe(0);
      expect(await exists(p('.orcaops'))).toBe(false);
      const manifest = JSON.parse(
        await readFile(path.join(globalRoot, 'install.local.json'), 'utf8')
      ) as { entries: unknown[] };
      expect(manifest.entries).toEqual([]);
      expect(
        await lexists(path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md'))
      ).toBe(false);
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('serializes a global update with uninstall and leaves ownership coherent', async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-uninstall-race-'));
    try {
      const globalAgent = makeAgent({
        cwd: repo.path,
        env: { CLAUDE_SESSION_ID: 'test-uninstall-race', ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      await globalAgent.runRaw([
        'init',
        '--scope',
        'global',
        '--install-agent',
        'claude-code',
        '--no-llm',
        '--agents-md',
      ]);
      const commonDir = await new Repo(repo.path).getCommonDirAbsolute();
      let update!: ReturnType<typeof globalAgent.runRaw>;
      let uninstall!: ReturnType<typeof globalAgent.runRaw>;

      await withRepositoryInstallLock(commonDir, async () => {
        update = globalAgent.runRaw(['update', '--json']);
        uninstall = globalAgent.runRaw(['uninstall', '--json']);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const [updateResult, uninstallResult] = await Promise.all([update, uninstall]);
      expect(updateResult.exitCode, updateResult.stderr).toBe(0);
      expect(uninstallResult.exitCode, uninstallResult.stderr).toBe(0);
      const manifest = JSON.parse(
        await readFile(path.join(globalRoot, 'install.local.json'), 'utf8')
      ) as { entries: { refs: string[] }[] };
      const installed = await exists(p('.orcaops', 'install.json'));
      expect(manifest.entries.some((entry) => entry.refs.length > 0)).toBe(installed);
      expect(await lexists(p('AGENTS.md'))).toBe(installed);
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('uninstalls a personal footprint using its local ownership manifest', async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-uninstall-personal-'));
    try {
      const personalAgent = makeAgent({
        cwd: repo.path,
        env: { CLAUDE_SESSION_ID: 'test-uninstall-personal', ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      await personalAgent.runRaw([
        'init',
        '--personal',
        '--install-agent',
        'claude-code',
        '--no-llm',
        '--agents-md',
      ]);
      expect(await exists(p('.orcaops', 'install.json'))).toBe(false);
      expect(await exists(p('.orcaops', 'install.local.json'))).toBe(true);
      expect(await exists(p('CLAUDE.local.md'))).toBe(true);

      const res = await personalAgent.runRaw(['uninstall', '--json']);
      expect(res.exitCode).toBe(0);
      expect(await lexists(p('CLAUDE.local.md'))).toBe(false);
      expect(await exists(p('.orcaops', 'install.local.json'))).toBe(false);
      expect(
        await lexists(path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md'))
      ).toBe(false);
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('finishes a purge when only an empty .orcaops directory remains', async () => {
    await agent.runRaw(['init', '--no-llm']);
    expect((await agent.runRaw(['uninstall', '--purge-data'])).exitCode).toBe(0);
    await mkdir(p('.orcaops'));

    const res = await agent.runRaw(['uninstall', '--purge-data', '--json']);
    expect(res.exitCode).toBe(0);
    expect((JSON.parse(res.stdout) as UninstallJson).data_purged).toBe(true);
    expect(await exists(p('.orcaops'))).toBe(false);
  });

  it('refuses purge before local mutation when global ownership belongs to another version', async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-uninstall-version-'));
    try {
      const globalAgent = makeAgent({
        cwd: repo.path,
        env: { CLAUDE_SESSION_ID: 'test-uninstall-version', ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      await globalAgent.runRaw([
        'init',
        '--scope',
        'global',
        '--install-agent',
        'claude-code',
        '--no-llm',
        '--agents-md',
      ]);
      const manifestPath = path.join(globalRoot, 'install.local.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        materialized_by: string;
      };
      manifest.materialized_by = '99.0.0';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      const res = await globalAgent.runRaw(['uninstall', '--purge-data', '--json']);
      expect(res.exitCode).toBe(1);
      expect(await exists(p('.orcaops', 'config.json'))).toBe(true);
      expect(await exists(p('AGENTS.md'))).toBe(true);
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('an AHEAD global tree refusal never advises uninstall --force (a dead end)', async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-uninstall-ahead-'));
    try {
      const globalAgent = makeAgent({
        cwd: repo.path,
        env: { CLAUDE_SESSION_ID: 'test-uninstall-ahead', ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      await globalAgent.runRaw([
        'init',
        '--scope',
        'global',
        '--install-agent',
        'claude-code',
        '--no-llm',
      ]);
      const manifestPath = path.join(globalRoot, 'install.local.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        materialized_by: string;
      };
      manifest.materialized_by = '99.0.0';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      for (const args of [['uninstall'], ['uninstall', '--force']]) {
        const res = await globalAgent.runRaw(args);
        expect(res.exitCode).toBe(1);
        const out = res.stdout + res.stderr;
        expect(out).toMatch(/update --force|owning \(newer\) CLI/);
        expect(out).not.toMatch(/pass --force/);
      }
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('removes a skills-only github-copilot install: universal tree + block, nothing else', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--agents', 'github-copilot', '--no-llm']);
    expect(await exists(p('.agents', 'skills', 'orcaops-capture', 'SKILL.md'))).toBe(true);

    const res = await agent.runRaw(['uninstall', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as UninstallJson;

    expect(await exists(p('.agents', 'skills'))).toBe(false);
    expect(await lexists(p('AGENTS.md'))).toBe(false);
    expect(r.removed.length).toBeGreaterThan(0);
    expect(r.confirm_required).toEqual([]);
  });

  it('removes the new agents: shared + own skill trees, per-layout commands, block once', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--agents', 'cursor,aider-desk', '--no-llm']);
    // Footprint sanity before the uninstall.
    expect(await exists(p('.agents', 'skills', 'orcaops-capture', 'SKILL.md'))).toBe(true);
    expect(await exists(p('.aider-desk', 'skills', 'orcaops-capture', 'SKILL.md'))).toBe(true);
    expect(await exists(p('.cursor', 'commands', 'orcaops-status.md'))).toBe(true);
    expect(await exists(p('.aider-desk', 'commands', 'orcaops', 'status.md'))).toBe(true);

    const res = await agent.runRaw(['uninstall', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as UninstallJson;

    // Both skill trees and both command layouts are removed hash-verified.
    expect(await exists(p('.agents', 'skills'))).toBe(false);
    expect(await exists(p('.aider-desk', 'skills'))).toBe(false);
    expect(await exists(p('.cursor', 'commands', 'orcaops-status.md'))).toBe(false);
    expect(await exists(p('.aider-desk', 'commands'))).toBe(false);
    // The (orcaops-created) AGENTS.md host is gone with its single block.
    expect(await lexists(p('AGENTS.md'))).toBe(false);
    expect(r.removed.length).toBeGreaterThan(0);
    expect(r.confirm_required).toEqual([]);
  });

  it('excises the managed block but keeps a host file that has user prose', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsPath = p('AGENTS.md');
    const original = await readFile(agentsPath, 'utf8');
    await writeFile(agentsPath, `# My project notes\n\n${original}`, 'utf8');

    const res = await agent.runRaw(['uninstall', '--json']);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.blocks_removed).toContain('AGENTS.md');

    // host preserved, block gone, prose intact, symlink secondary removed
    expect(await exists(agentsPath)).toBe(true);
    const after = await readFile(agentsPath, 'utf8');
    expect(after).toContain('# My project notes');
    expect(after).not.toContain('orcaops:start');
    expect(await lexists(p('CLAUDE.md'))).toBe(false);
  });

  it('preserves a user-MODIFIED managed block (left + warned, never deleted)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsPath = p('AGENTS.md');
    const original = await readFile(agentsPath, 'utf8');
    // edit INSIDE the markers so the block no longer matches the expected render
    await writeFile(
      agentsPath,
      original.replace('<!-- orcaops:end -->', 'EDITED BY USER\n<!-- orcaops:end -->'),
      'utf8'
    );

    const res = await agent.runRaw(['uninstall', '--json']);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.blocks_preserved_modified.length).toBeGreaterThan(0);
    expect(await exists(agentsPath)).toBe(true);
    const after = await readFile(agentsPath, 'utf8');
    expect(after).toContain('orcaops:start'); // block left intact
    expect(after).toContain('EDITED BY USER');
  });

  it('a confirm-gated entry is listed, not deleted, without --force', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const confirmPath = await markFirstSkillConfirm(repo.path);

    const res = await agent.runRaw(['uninstall', '--json']);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.confirm_required.some((c) => c.path === confirmPath)).toBe(true);
    expect(r.removed).not.toContain(confirmPath);
    // the confirm-gated file survives a bare uninstall
    expect(await exists(p(confirmPath))).toBe(true);
  });

  it('uninstall --force removes the confirm-gated entry', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const confirmPath = await markFirstSkillConfirm(repo.path);

    const res = await agent.runRaw(['uninstall', '--force', '--json']);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.removed).toContain(confirmPath);
    expect(await exists(p(confirmPath))).toBe(false);
    // The forced confirm removal is surfaced as UNVERIFIABLE (may carry edits).
    expect(r.removed_unverified.some((u) => u.path === confirmPath)).toBe(true);
  });

  it('uninstall --force removes a reconstructed instruction symlink without reading it', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsPath = p('AGENTS.md');
    await writeFile(agentsPath, `${await readFile(agentsPath, 'utf8')}\nUser notes\n`, 'utf8');
    await rm(p('.orcaops', 'install.local.json'));

    const res = await agent.runRaw(['uninstall', '--force', '--json']);

    expect(res.exitCode, `${res.stdout}\n${res.stderr}`).toBe(0);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.removed).toContain('CLAUDE.md');
    expect(await lexists(p('CLAUDE.md'))).toBe(false);
    expect(await readFile(agentsPath, 'utf8')).toContain('User notes');
    expect(await exists(p('.orcaops', 'install.json'))).toBe(false);
  });

  it('uninstall --force flags unverifiable removals in human output', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const confirmPath = await markFirstSkillConfirm(repo.path);

    const res = await agent.runRaw(['uninstall', '--force']); // human mode
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/UNVERIFIABLE/);
    expect(res.stdout).toMatch(/may contain manual edits/);
    expect(res.stdout).toContain(confirmPath);
    // git-clean semantics: --force still removes the file, just transparently.
    expect(await exists(p(confirmPath))).toBe(false);
  });

  it('preserves a generated-file symlink without inspecting its target', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const skillRel = path.join('.claude', 'skills', 'orcaops-capture', 'SKILL.md');
    const skillPath = p(skillRel);
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'orcaops-uninstall-skill-'));
    const external = path.join(outsideDir, 'SKILL.md');
    const externalBody = await readFile(skillPath, 'utf8');
    await writeFile(external, externalBody, 'utf8');
    await rm(skillPath);
    await symlink(external, skillPath);

    try {
      const res = await agent.runRaw(['uninstall', '--json']);
      expect(res.exitCode).toBe(0);
      const result = JSON.parse(res.stdout) as UninstallJson;
      expect(result.preserved.some((entry) => entry.path === skillRel)).toBe(true);
      expect(await lexists(skillPath)).toBe(true);
      expect(await readFile(external, 'utf8')).toBe(externalBody);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it.each(['symlink', 'directory'] as const)(
    'preserves a confirm-mode generated entry replaced by a %s',
    async (replacement) => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const skillRel = await markFirstSkillConfirm(repo.path);
      const skillPath = p(skillRel);
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'orcaops-uninstall-confirm-'));
      const external = path.join(outsideDir, 'SKILL.md');
      await rm(skillPath);
      if (replacement === 'symlink') {
        await writeFile(external, 'replacement\n', 'utf8');
        await symlink(external, skillPath);
      } else {
        await mkdir(skillPath);
      }

      try {
        const res = await agent.runRaw(['uninstall', '--force', '--json']);
        expect(res.exitCode).toBe(0);
        const result = JSON.parse(res.stdout) as UninstallJson;
        expect(result.preserved.some((entry) => entry.path === skillRel)).toBe(true);
        expect(await lexists(skillPath)).toBe(true);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    }
  );

  it('removes stamped hooks but preserves an unstamped (user) hook', async () => {
    // a user hook present BEFORE init → init preserves it (preserved-conflict)
    await writeFile(p('.git', 'hooks', 'post-merge'), '#!/bin/sh\necho mine\n', 'utf8');
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--with-hooks']);

    const res = await agent.runRaw(['uninstall', '--json']);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.hooks_preserved).toContain(path.join('.git', 'hooks', 'post-merge'));
    expect(r.hooks_removed).toContain(path.join('.git', 'hooks', 'post-rewrite'));
    expect(await readFile(p('.git', 'hooks', 'post-merge'), 'utf8')).toContain('echo mine');
    expect(await exists(p('.git', 'hooks', 'post-rewrite'))).toBe(false);
  });

  it('preserves a redirected hook during uninstall without reading its target', async () => {
    await agent.runRaw(['init', '--no-llm', '--with-hooks']);
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'orcaops-uninstall-hook-'));
    const outside = path.join(outsideDir, 'post-merge');
    const hookPath = p('.git', 'hooks', 'post-merge');
    const userBody = '#!/bin/sh\n# orcaops-hook v=0.0.1\necho external\n';
    await writeFile(outside, userBody, 'utf8');
    await rm(hookPath);
    await symlink(outside, hookPath);

    try {
      const res = await agent.runRaw(['uninstall', '--json']);
      expect(res.exitCode).toBe(0);
      const r = JSON.parse(res.stdout) as UninstallJson;
      expect(r.hooks_preserved).not.toContain(path.join('.git', 'hooks', 'post-merge'));
      expect(r.hooks_unverified).toEqual([path.join('.git', 'hooks', 'post-merge')]);
      expect(r.warnings).toEqual([
        `could not verify ownership at Git hook ${path.join(
          '.git',
          'hooks',
          'post-merge'
        )} because its path is redirected or non-regular — left the path untouched`,
      ]);
      expect(await lexists(hookPath)).toBe(true);
      expect(await readFile(outside, 'utf8')).toBe(userBody);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('preserves hooks when their parent directory is redirected', async () => {
    await agent.runRaw(['init', '--no-llm', '--with-hooks']);
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'orcaops-uninstall-hooks-'));
    const hooksPath = p('.git', 'hooks');
    await rm(hooksPath, { recursive: true, force: true });
    await symlink(outsideDir, hooksPath);

    try {
      const res = await agent.runRaw(['uninstall', '--json']);
      expect(res.exitCode).toBe(0);
      const r = JSON.parse(res.stdout) as UninstallJson;
      expect(r.hooks_preserved).toEqual([]);
      expect(r.hooks_unverified).toEqual([
        path.join('.git', 'hooks', 'post-merge'),
        path.join('.git', 'hooks', 'post-rewrite'),
      ]);
      expect(r.warnings).toHaveLength(2);
      expect(r.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(path.join('.git', 'hooks', 'post-merge')),
          expect.stringContaining(path.join('.git', 'hooks', 'post-rewrite')),
        ])
      );
      expect((await lstat(hooksPath)).isSymbolicLink()).toBe(true);
      const config = JSON.parse(
        await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
      ) as { schema_version: number };
      expect(config.schema_version).toBeGreaterThan(0);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not warn for an empty regular hook', async () => {
    const hookPath = p('.git', 'hooks', 'post-merge');
    await writeFile(hookPath, '', 'utf8');
    await agent.runRaw(['init', '--no-llm', '--with-hooks']);

    const res = await agent.runRaw(['uninstall', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.hooks_preserved).toContain(path.join('.git', 'hooks', 'post-merge'));
    expect(r.hooks_unverified).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(await readFile(hookPath, 'utf8')).toBe('');
  });

  it('--dry-run previews and writes nothing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const res = await agent.runRaw(['uninstall', '--dry-run', '--json']);
    const r = JSON.parse(res.stdout) as UninstallJson;
    expect(r.applied).toBe(false);
    expect(r.dry_run).toBe(true);
    // everything still present
    expect(await exists(p('.claude', 'skills', 'orcaops-capture', 'SKILL.md'))).toBe(true);
    expect(await exists(p('.orcaops', 'install.json'))).toBe(true);
    expect(await lexists(p('AGENTS.md'))).toBe(true);
  });
});

/**
 * Mark the first generated-file entry in install.local.json as a confirm-gated,
 * unverifiable entry. Returns its repo-relative path.
 */
async function markFirstSkillConfirm(repoRoot: string): Promise<string> {
  const localPath = path.join(repoRoot, '.orcaops', 'install.local.json');
  const local = JSON.parse(await readFile(localPath, 'utf8')) as {
    entries: { kind: string; path: string; deleteMode: string; expectedHash: string | null }[];
  };
  const entry = local.entries.find((e) => e.kind === 'generated-file');
  if (!entry) throw new Error('no generated-file entry to mark confirm');
  entry.deleteMode = 'confirm';
  entry.expectedHash = null;
  await writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`, 'utf8');
  return entry.path;
}

describe('orcaops uninstall — personal (invisible) scope round-trip', () => {
  let repo: TempRepo;
  let globalRoot: string;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-un-personal-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_GLOBAL_ROOT: globalRoot },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const gitStatus = (): string =>
    execFileSync('git', ['status', '--porcelain'], { cwd: repo.path }).toString().trim();

  it('non-purge: releases global refs, excises the block, KEEPS retained data hidden — status stays clean', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm', '--agents-md']);
    expect(gitStatus()).toBe('');
    const skill = path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
    expect(await exists(skill)).toBe(true);

    const r = await agent.runRaw(['uninstall', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as UninstallJson & {
      info_exclude_removed: string[];
      global_removed: string[];
      user_session_hooks_present: boolean;
    };

    // Global materialization fully released (refs + files).
    expect(out.global_removed.length).toBeGreaterThan(0);
    expect(await exists(skill)).toBe(false);
    const manifest = JSON.parse(
      await readFile(path.join(globalRoot, 'install.local.json'), 'utf8')
    ) as { entries: unknown[] };
    expect(manifest.entries).toEqual([]);

    // CLAUDE.local.md was an orcaops-created block-only file → excised + deleted.
    expect(out.blocks_removed).toContain('CLAUDE.local.md');
    expect(await exists(path.join(repo.path, 'CLAUDE.local.md'))).toBe(false);

    // RETENTION: the data survives AND stays hidden — the exclude section is
    // rewritten down to `.orcaops/` (mirroring RETAINED_DATA_IGNORES), so
    // `git status` is exactly as clean after uninstall as before it.
    expect(await exists(path.join(repo.path, '.orcaops', 'config.json'))).toBe(true);
    const exclude = await readFile(path.join(repo.path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('# >>> orcaops >>>');
    expect(exclude).toContain('.orcaops/');
    expect(exclude).not.toContain('CLAUDE.local.md');
    expect(gitStatus()).toBe('');
  });

  it('keeps a preserved CLAUDE.local.md hidden after non-purge uninstall', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm', '--agents-md']);
    await appendFile(path.join(repo.path, 'CLAUDE.local.md'), 'User instructions stay private.\n');

    const result = await agent.runRaw(['uninstall', '--json']);
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(repo.path, 'CLAUDE.local.md'), 'utf8')).toBe(
      'User instructions stay private.\n'
    );
    const exclude = await readFile(path.join(repo.path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.orcaops/');
    expect(exclude).toContain('CLAUDE.local.md');
    expect(gitStatus()).toBe('');
  });

  it('never creates an exclude section for a repo whose section is already gone', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm', '--agents-md']);
    const excludePath = path.join(repo.path, '.git', 'info', 'exclude');
    const userLines = '*.swp\n';
    await writeFile(excludePath, userLines, 'utf8');

    const result = await agent.runRaw(['uninstall', '--json']);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as { info_exclude_removed: string[] };
    expect(out.info_exclude_removed).toEqual([]);
    expect(await readFile(excludePath, 'utf8')).toBe(userLines);
  });

  it('refuses the global release entirely on a CLI version mismatch: no files, no refs', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm', '--agents-md']);
    const manifestPath = path.join(globalRoot, 'install.local.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      materialized_by: string;
      entries: Array<{ refs: string[] }>;
    };
    manifest.materialized_by = '0.0.0-other';
    const seeded = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, seeded, 'utf8');
    const skill = path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');

    const result = await agent.runRaw(['uninstall']);

    // A refusal leaves ownership state byte-untouched: no files removed, no
    // refs dropped. --force (covered below) is the deliberate escape.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/materialized by CLI v0\.0\.0-other/);
    expect(result.stderr).toMatch(/pass --force/);
    expect(await exists(skill)).toBe(true);
    expect(await readFile(manifestPath, 'utf8')).toBe(seeded);
  });

  it('forwards --force when releasing global refs', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm', '--agents-md']);
    const manifestPath = path.join(globalRoot, 'install.local.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      materialized_by: string;
    };
    manifest.materialized_by = '0.0.0-other';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const skill = path.join(globalRoot, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');

    const result = await agent.runRaw(['uninstall', '--force', '--json']);
    const output = JSON.parse(result.stdout) as UninstallJson & {
      global_removed: string[];
      global_skipped_version_mismatch: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output.global_skipped_version_mismatch).toBe(false);
    expect(output.global_removed.length).toBeGreaterThan(0);
    expect(await exists(skill)).toBe(false);
  });

  it('--purge-data: the store is deleted and the exclude section strips fully', async () => {
    await agent.runRaw(['init', '--personal', '--json', '--no-llm']);
    const r = await agent.runRaw(['uninstall', '--purge-data', '--json']);
    expect(r.exitCode).toBe(0);
    expect(await exists(path.join(repo.path, '.orcaops'))).toBe(false);
    const exclude = await readFile(path.join(repo.path, '.git', 'info', 'exclude'), 'utf8').catch(
      () => ''
    );
    expect(exclude).not.toContain('# >>> orcaops >>>');
    expect(gitStatus()).toBe('');
  });

  it('a project-scope uninstall never GAINS an exclude section', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const r = await agent.runRaw(['uninstall', '--json']);
    expect(r.exitCode).toBe(0);
    const exclude = await readFile(path.join(repo.path, '.git', 'info', 'exclude'), 'utf8').catch(
      () => ''
    );
    expect(exclude).not.toContain('# >>> orcaops >>>');
  });
});
