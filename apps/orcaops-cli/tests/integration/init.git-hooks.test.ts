import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

interface InitOk {
  ok: true;
  git_hooks: Array<{ path: string; action: string }>;
}

describe('orcaops init --with-hooks', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('default init (no flag) leaves .git/hooks alone and returns git_hooks: []', async () => {
    const res = await agent.runRaw(['init', '--no-llm', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as InitOk;
    expect(r.git_hooks).toEqual([]);
    await expect(stat(path.join(repo.path, '.git', 'hooks', 'post-merge'))).rejects.toThrow();
    await expect(stat(path.join(repo.path, '.git', 'hooks', 'post-rewrite'))).rejects.toThrow();
  });

  it('--with-hooks installs both hooks (created), executable, with the orcaops stamp', async () => {
    const res = await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as InitOk;
    expect(r.git_hooks.map((h) => h.action)).toEqual(['created', 'created']);
    expect(r.git_hooks.map((h) => h.path).sort()).toEqual([
      '.git/hooks/post-merge',
      '.git/hooks/post-rewrite',
    ]);
    for (const name of ['post-merge', 'post-rewrite']) {
      const hookPath = path.join(repo.path, '.git', 'hooks', name);
      const body = await readFile(hookPath, 'utf8');
      expect(body).toContain('# orcaops-hook v=');
      expect(body).toContain('orcaops lineage');
      const st = await stat(hookPath);
      expect(st.mode & 0o100).toBe(0o100);
    }
  });

  it('installs hooks in the shared Git directory from a linked worktree', async () => {
    const worktreeParent = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-worktree-'));
    const worktree = path.join(worktreeParent, 'linked');
    try {
      await gitClient(repo.path).raw(['worktree', 'add', '--detach', worktree, 'HEAD']);
      const linkedAgent = makeAgent({ cwd: worktree });

      const res = await linkedAgent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);

      expect(res.exitCode).toBe(0);
      expect(await readFile(path.join(repo.path, '.git', 'hooks', 'post-merge'), 'utf8')).toContain(
        '# orcaops-hook v='
      );
      expect((await stat(path.join(worktree, '.git'))).isFile()).toBe(true);
    } finally {
      await gitClient(repo.path)
        .raw(['worktree', 'remove', '--force', worktree])
        .catch(() => {});
      await rm(worktreeParent, { recursive: true, force: true });
    }
  });

  it('rerunning --with-hooks on an already-installed setup is unchanged (idempotent)', async () => {
    await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
    const res = await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks', '--force']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as InitOk;
    expect(r.git_hooks.every((h) => h.action === 'unchanged')).toBe(true);
  });

  it('refreshes a stamped hook whose contents drifted (e.g., older orcaops version)', async () => {
    await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
    const hookPath = path.join(repo.path, '.git', 'hooks', 'post-merge');
    const old = await readFile(hookPath, 'utf8');
    await writeFile(hookPath, old.replace('orcaops lineage', '# stale'), { mode: 0o755 });
    const res = await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks', '--force']);
    const r = JSON.parse(res.stdout) as InitOk;
    const merge = r.git_hooks.find((h) => h.path.endsWith('post-merge'));
    expect(merge?.action).toBe('refreshed');
    const refreshed = await readFile(hookPath, 'utf8');
    expect(refreshed).toContain('orcaops lineage');
    expect(refreshed).not.toContain('# stale');
  });

  it('preserves a pre-existing unstamped hook and surfaces the conflict in the result', async () => {
    const hookPath = path.join(repo.path, '.git', 'hooks', 'post-merge');
    const userBody = '#!/bin/sh\necho "user hook"\n';
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, userBody, 'utf8');
    await chmod(hookPath, 0o755);

    const res = await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
    const r = JSON.parse(res.stdout) as InitOk;
    const merge = r.git_hooks.find((h) => h.path.endsWith('post-merge'));
    expect(merge?.action).toBe('preserved-conflict');
    const onDisk = await readFile(hookPath, 'utf8');
    expect(onDisk).toBe(userBody);
    const rewrite = r.git_hooks.find((h) => h.path.endsWith('post-rewrite'));
    expect(rewrite?.action).toBe('created');
  });

  it('an AHEAD-stamped hook survives init --force with directional advice, not the unstamped text', async () => {
    await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
    const hookPath = path.join(repo.path, '.git', 'hooks', 'post-merge');
    const aheadBody = (await readFile(hookPath, 'utf8')).replace(
      /# orcaops-hook v=[^\s]+/,
      '# orcaops-hook v=99.0.0'
    );
    await writeFile(hookPath, aheadBody, { mode: 0o755 });

    const res = await agent.runRaw(['init', '--no-llm', '--with-hooks', '--force']);
    expect(res.exitCode).toBe(0);
    expect(await readFile(hookPath, 'utf8')).toBe(aheadBody);
    expect(res.stdout).toMatch(/stamped by a NEWER orcaops/);
    expect(res.stdout).toMatch(/Upgrade orcaops to manage/);
    expect(res.stdout).not.toMatch(/no orcaops stamp/);
  });

  it('preserves a redirected hook without reading or replacing its target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-user-hook-'));
    const externalHook = path.join(outside, 'post-merge');
    const hookPath = path.join(repo.path, '.git', 'hooks', 'post-merge');
    const userBody = '#!/bin/sh\n# orcaops-hook v=0.0.1\necho external\n';
    await writeFile(externalHook, userBody, 'utf8');
    await symlink(externalHook, hookPath);

    try {
      const res = await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
      expect(res.exitCode).toBe(0);
      const r = JSON.parse(res.stdout) as InitOk;
      expect(r.git_hooks.find((hook) => hook.path.endsWith('post-merge'))?.action).toBe(
        'preserved-conflict'
      );
      expect(await readFile(externalHook, 'utf8')).toBe(userBody);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('preserves a non-regular hook as a conflict', async () => {
    const hookPath = path.join(repo.path, '.git', 'hooks', 'post-merge');
    await mkdir(hookPath);

    const res = await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);

    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as InitOk;
    expect(r.git_hooks.find((hook) => hook.path.endsWith('post-merge'))?.action).toBe(
      'preserved-conflict'
    );
    expect((await stat(hookPath)).isDirectory()).toBe(true);
    expect(r.git_hooks.find((hook) => hook.path.endsWith('post-rewrite'))?.action).toBe('created');
  });

  it('human output (no --json) without --with-hooks shows the opt-in tip', async () => {
    const res = await agent.runRaw(['init', '--no-llm']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/--with-hooks/);
  });

  it('human output with --with-hooks lists the installed paths', async () => {
    const res = await agent.runRaw(['init', '--no-llm', '--with-hooks']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/Installed git hooks:/);
    expect(res.stdout).toMatch(/\.git\/hooks\/post-merge/);
    expect(res.stdout).toMatch(/\.git\/hooks\/post-rewrite/);
  });

  // ── doctor's git-hooks check ──────────────────────────────────────
  //
  // A stale hook is the one install surface nothing else can see: hooks are
  // never committed and are not manifest-tracked, and the body ends in
  // `|| true` so invoking a command that no longer exists is completely
  // silent.
  describe('doctor git-hooks check', () => {
    interface DoctorReport {
      checks: Array<{ name: string; status: string; summary: string; details?: string[] }>;
    }
    const hooksCheck = async (): Promise<DoctorReport['checks'][number]> => {
      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = r.checks.find((c) => c.name === 'git-hooks');
      expect(check).toBeDefined();
      return check!;
    };

    it('passes when no hooks are installed (they are opt-in)', async () => {
      await agent.runRaw(['init', '--no-llm', '--json']);
      const check = await hooksCheck();
      expect(check.status).toBe('pass');
      expect(check.summary).toMatch(/no orcaops git hooks/);
    });

    it('passes on freshly installed hooks', async () => {
      await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
      const check = await hooksCheck();
      expect(check.status).toBe('pass');
      expect(check.summary).toMatch(/2 orcaops git hook\(s\) current/);
    });

    it('warns on a stamped hook whose body drifted, naming the refresh command', async () => {
      await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
      const hookPath = path.join(repo.path, '.git', 'hooks', 'post-merge');
      // Stand in for a stale stamped hook: still stamped, still
      // executable, but invoking a command this version does not have.
      const body = await readFile(hookPath, 'utf8');
      await writeFile(hookPath, body.replace('orcaops lineage', 'echo drifted-body'), {
        mode: 0o755,
      });

      const check = await hooksCheck();
      expect(check.status).toBe('warn');
      expect(check.details?.join('\n')).toMatch(/post-merge/);
      expect(check.details?.join('\n')).toMatch(/orcaops update/);
      expect(check.details?.join('\n')).toMatch(/orcaops doctor --fix/);
    });

    it('update refreshes old stamped hooks and preserves unstamped hooks', async () => {
      await agent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
      const hooksDir = path.join(repo.path, '.git', 'hooks');
      const mergePath = path.join(hooksDir, 'post-merge');
      const rewritePath = path.join(hooksDir, 'post-rewrite');
      const current = await readFile(mergePath, 'utf8');
      const old = current
        .replace(/# orcaops-hook v=.*\n/, '# orcaops-hook v=0.0.0\n')
        .replace('orcaops lineage', 'echo drifted-body');
      const foreign = '#!/bin/sh\necho "user hook"\n';
      await writeFile(mergePath, old, { mode: 0o755 });
      await writeFile(rewritePath, foreign, { mode: 0o755 });
      expect((await hooksCheck()).status).toBe('warn');

      const update = await agent.runRaw(['update', '--json']);
      expect(update.exitCode).toBe(0);
      expect(await readFile(mergePath, 'utf8')).toBe(current);
      expect(await readFile(rewritePath, 'utf8')).toBe(foreign);
      expect((await hooksCheck()).status).toBe('pass');
    });

    it('doctor --fix refreshes an old stamped hook and reports it current', async () => {
      await agent.runRaw(['init', '--agents', '', '--no-llm', '--json', '--with-hooks']);
      const hookPath = path.join(repo.path, '.git', 'hooks', 'post-merge');
      const current = await readFile(hookPath, 'utf8');
      await writeFile(
        hookPath,
        current
          .replace(/# orcaops-hook v=.*\n/, '# orcaops-hook v=0.0.0\n')
          .replace('orcaops lineage', 'echo drifted-body'),
        { mode: 0o755 }
      );
      expect((await hooksCheck()).status).toBe('warn');

      const fixed = await agent.runRaw(['doctor', '--fix', '--json']);
      expect(fixed.exitCode).toBe(0);
      expect(await readFile(hookPath, 'utf8')).toBe(current);
      const report = JSON.parse(fixed.stdout) as DoctorReport;
      expect(report.checks.find((check) => check.name === 'git-hooks')?.status).toBe('pass');
    });

    it('ignores an unstamped hook the user wrote themselves', async () => {
      await agent.runRaw(['init', '--no-llm', '--json']);
      const hooksDir = path.join(repo.path, '.git', 'hooks');
      await mkdir(hooksDir, { recursive: true });
      await writeFile(path.join(hooksDir, 'post-merge'), '#!/bin/sh\necho mine\n', { mode: 0o755 });

      const check = await hooksCheck();
      expect(check.status).toBe('pass');
      expect(check.summary).toMatch(/no orcaops git hooks/);
    });
  });
});
