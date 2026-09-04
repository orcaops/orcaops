import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createLinkedWorktree,
  createTempRepo,
  inputFile,
  type TempRepo,
} from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

interface InitOk {
  ok: true;
  git_hooks: Array<{ path: string; action: string }>;
  project_id: string | null;
  project_id_minted: boolean;
  global: { materialized: string[] } | null;
}

interface DoctorReport {
  ok: true;
  overall: string;
  checks: Array<{ name: string; status: string; summary: string }>;
}

interface GlobalManifest {
  entries: Array<{ agent: string; surface: string; path: string; refs: string[] }>;
}

/**
 * Linked-worktree end-to-end coverage: the layout where `<root>/.git` is a
 * FILE and shared state (hooks, info/exclude, git local config) lives in the
 * MAIN repo's common dir. Hand-joined `.git/…` paths silently misbehave in
 * this layout; plumbing resolution + the shared projectid make a
 * worktree behave as the same repo.
 */
describe('orcaops in a linked worktree', () => {
  let main: TempRepo;
  let wt: TempRepo;
  let globalRoot: string;
  let wtAgent: ReturnType<typeof makeAgent>;
  let mainAgent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    main = await createTempRepo({ initialBranch: 'main' });
    wt = await createLinkedWorktree(main.path, { branch: 'feature-wt' });
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-wt-global-'));
    const env = { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_GLOBAL_ROOT: globalRoot };
    wtAgent = makeAgent({ cwd: wt.path, env });
    mainAgent = makeAgent({ cwd: main.path, env });
  });

  afterEach(async () => {
    await wt.cleanup();
    await main.cleanup();
  });

  const gitStatus = (cwd: string): string =>
    execFileSync('git', ['status', '--porcelain'], { cwd }).toString().trim();

  it('init --with-hooks from the worktree lands hooks in the MAIN .git/hooks, idempotently', async () => {
    const res = await wtAgent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as InitOk;
    expect(r.git_hooks.map((h) => h.action)).toEqual(['created', 'created']);

    // The hooks physically exist in the main repo's common dir — the only
    // place git runs them from — not behind the worktree's `.git` FILE.
    for (const name of ['post-merge', 'post-rewrite']) {
      const abs = path.join(main.path, '.git', 'hooks', name);
      const body = await readFile(abs, 'utf8');
      expect(body).toContain('# orcaops-hook v=');
      const mode = (await stat(abs)).mode & 0o111;
      expect(mode).not.toBe(0);
    }

    // Hooks live in the git dir → they add NOTHING to either checkout's
    // status. (Plain init's project-scope worktree footprint is expected in
    // the wt; the main checkout, where nothing ran, stays fully clean.)
    const wtLines = gitStatus(wt.path)
      .split('\n')
      .filter(Boolean)
      .map((l) => l.trim());
    for (const line of wtLines) {
      expect(['?? .claude/', '?? .gitignore', '?? .orcaops/']).toContain(line);
    }
    expect(gitStatus(main.path)).toBe('');

    // Re-run is unchanged (exact-body stamp compare through the same resolution).
    const again = await wtAgent.runRaw(['init', '--no-llm', '--json', '--with-hooks', '--force']);
    const r2 = JSON.parse(again.stdout) as InitOk;
    expect(r2.git_hooks.map((h) => h.action)).toEqual(['unchanged', 'unchanged']);
  });

  it('uninstall from the worktree removes the MAIN repo hooks and the manifests', async () => {
    await wtAgent.runRaw(['init', '--no-llm', '--json', '--with-hooks']);
    const hook = path.join(main.path, '.git', 'hooks', 'post-merge');
    await expect(stat(hook)).resolves.toBeDefined();

    const res = await wtAgent.runRaw(['uninstall', '--json']);

    // The hooks the worktree must delete live above its own root, so the
    // mutation path is parent-relative — this used to abort mid-uninstall.
    expect(res.exitCode).toBe(0);
    expect(res.stderr).not.toContain('must stay inside the repository');
    await expect(stat(hook)).rejects.toThrow();
    await expect(stat(path.join(wt.path, '.orcaops', 'install.json'))).rejects.toThrow();
  });

  it('mints one projectid shared by both checkouts, reported in init JSON', async () => {
    const res = await wtAgent.runRaw(['init', '--no-llm', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as InitOk;
    expect(r.project_id).toBeTruthy();
    expect(r.project_id_minted).toBe(true);

    // git local config lives in the common dir: the MAIN checkout sees the
    // exact same identity.
    const fromMain = execFileSync('git', ['config', '--local', 'orcaops.projectid'], {
      cwd: main.path,
    })
      .toString()
      .trim();
    expect(fromMain).toBe(r.project_id);
  });

  it('personal scope from the worktree: excludes land in the common dir, one global ref for both checkouts', async () => {
    const res = await wtAgent.runRaw(['init', '--personal', '--no-llm', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as InitOk;
    expect(r.project_id).toBeTruthy();

    // info/exclude is shared repo state → the section sits in the main
    // common dir and hides the footprint from BOTH checkouts.
    const exclude = await readFile(path.join(main.path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('# >>> orcaops >>>');
    expect(exclude).toContain('.orcaops/');
    expect(gitStatus(wt.path)).toBe('');

    // Global refs key on the projectid — verbatim, exactly once.
    const manifest = JSON.parse(
      await readFile(path.join(globalRoot, 'install.local.json'), 'utf8')
    ) as GlobalManifest;
    expect(manifest.entries.length).toBeGreaterThan(0);
    for (const entry of manifest.entries) {
      expect(entry.refs).toEqual([r.project_id]);
    }

    // The personal config lives in the common dir, so the MAIN checkout is
    // already enabled: a plain init refuses, and a forced re-init from there
    // resolves the SAME identity → still a single ref per key, never a
    // second worktree-shaped duplicate.
    const refused = await mainAgent.runRaw(['init', '--personal', '--no-llm', '--json']);
    expect(refused.exitCode).toBe(1);
    expect((JSON.parse(refused.stdout) as { error: { code: string } }).error.code).toBe(
      'ALREADY_INITIALIZED'
    );
    const mainRes = await mainAgent.runRaw(['init', '--personal', '--force', '--no-llm', '--json']);
    expect(mainRes.exitCode).toBe(0);
    const m = JSON.parse(mainRes.stdout) as InitOk;
    expect(m.project_id).toBe(r.project_id);
    expect(m.project_id_minted).toBe(false);
    const after = JSON.parse(
      await readFile(path.join(globalRoot, 'install.local.json'), 'utf8')
    ) as GlobalManifest;
    for (const entry of after.entries) {
      expect(entry.refs).toEqual([r.project_id]);
    }
  });

  it('read verbs in an enabled sibling with no data serve an empty source and create nothing', async () => {
    // Personal init in the MAIN checkout enables the worktree through the
    // shared config; the worktree itself has never captured anything.
    await mainAgent.runRaw(['init', '--personal', '--no-llm', '--json']);
    await expect(stat(path.join(wt.path, '.orcaops'))).rejects.toThrow();

    for (const args of [
      ['status', '--json'],
      ['list', '--json'],
      ['search', 'anything', '--json'],
    ]) {
      const res = await wtAgent.runRaw(args);
      expect(res.exitCode, args.join(' ')).toBe(0);
      expect((JSON.parse(res.stdout) as { ok: boolean }).ok).toBe(true);
    }
    // Reads created no store, no cache, no locks: the tree is untouched.
    await expect(stat(path.join(wt.path, '.orcaops'))).rejects.toThrow();
    expect(gitStatus(wt.path)).toBe('');

    // A write creates exactly this worktree's data; the sibling stays empty.
    const plan = await wtAgent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'work in the linked worktree',
          label: 'linked worktree work',
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);
    await expect(stat(path.join(wt.path, '.orcaops', 'artifacts'))).resolves.toBeDefined();
    await expect(stat(path.join(main.path, '.orcaops'))).rejects.toThrow();
    // The main checkout still reads as an empty source and lists nothing.
    const mainList = JSON.parse((await mainAgent.runRaw(['list', '--json'])).stdout) as {
      artifacts: unknown[];
    };
    expect(mainList.artifacts).toEqual([]);
  });

  it('doctor from the worktree resolves hooks and global refs correctly', async () => {
    await wtAgent.runRaw(['init', '--personal', '--no-llm', '--json', '--with-hooks']);
    const res = await wtAgent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const report = JSON.parse(res.stdout) as DoctorReport;

    const gitHooks = report.checks.find((c) => c.name === 'git-hooks');
    expect(gitHooks?.status).toBe('pass');
    expect(gitHooks?.summary).toContain('current');

    const globalInstall = report.checks.find((c) => c.name === 'global-install');
    expect(globalInstall?.status).toBe('pass');
  });

  it('machine-level hook arbitration is judged per-checkout: --user yields to THIS checkout, not the main one', async () => {
    // Project entry committed in main (settings.json + config with hooks
    // enabled), then a second worktree created FROM that commit. The --user
    // invocation must resolve the repo root through the worktree's `.git`
    // FILE and judge the project entry of the checkout it runs in.
    const res = await mainAgent.runRaw([
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
    expect(res.exitCode).toBe(0);
    const git = (args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: main.path,
      });
    };
    git(['add', '-A']);
    git(['commit', '-m', 'orcaops project install']);

    const wt2 = await createLinkedWorktree(main.path, { branch: 'feature-hooks' });
    try {
      const wt2Agent = makeAgent({
        cwd: wt2.path,
        env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      // The checkout carries the project entry → --user yields (the project
      // entry emits in the same session; double guidance is worse).
      const yielded = await wt2Agent.runRaw([
        'hook',
        'session-start',
        '--agent',
        'claude-code',
        '--user',
      ]);
      expect(yielded.exitCode).toBe(0);
      expect(yielded.stdout).toBe('');
      const project = await wt2Agent.runRaw(['hook', 'session-start', '--agent', 'claude-code']);
      expect(project.stdout).not.toBe('');

      // Remove the entry from THIS checkout only — the copy still present in
      // the MAIN checkout must not silence the worktree's machine hook.
      await rm(path.join(wt2.path, '.claude', 'settings.json'));
      const emitted = await wt2Agent.runRaw([
        'hook',
        'session-start',
        '--agent',
        'claude-code',
        '--user',
      ]);
      expect(emitted.exitCode).toBe(0);
      expect(emitted.stdout).not.toBe('');
    } finally {
      await wt2.cleanup();
    }
  });
});
