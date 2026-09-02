import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

// Integration coverage for git-root-anchored execution: every
// command must work from a nested subdirectory of the worktree, --root /
// ORCAOPS_ROOT must override discovery, `why` must normalize a cwd-relative
// target, `init` must gate a subdir, and realpath canonicalization must hold
// through an explicitly-created symlink (so it exercises Linux CI too, not
// just the macOS /var → /private/var tmpdir symlink).

describe('orcaops — execution from any subdirectory (git-root anchored)', () => {
  let repo: TempRepo;
  let subdir: string;
  let rootAgent: ReturnType<typeof makeAgent>;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    subdir = path.join(repo.path, 'apps', 'cli', 'src');
    await mkdir(subdir, { recursive: true });
    rootAgent = makeAgent({ cwd: repo.path });
    // an empty --agents '' keeps init fast (no skill generation) and is irrelevant
    // to directory resolution.
    await rootAgent.runRaw(['init', '--json', '--no-llm', '--agents', '', '--no-agents-md']);
  });

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    await repo.cleanup();
  });

  const sub = (env?: Record<string, string>) => makeAgent({ cwd: subdir, env });

  async function outsideDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-outside-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  const ids = (stdout: string): string[] =>
    (JSON.parse(stdout) as { artifacts: Array<{ id: string }> }).artifacts.map((a) => a.id);
  const code = (stdout: string): string =>
    (JSON.parse(stdout) as { error: { code: string } }).error.code;

  it('status from a nested subdir finds the artifact captured at the root', async () => {
    const plan = await rootAgent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const res = await sub().runRaw(['status', '--json']);
    expect(res.exitCode).toBe(0);
    expect(ids(res.stdout)).toContain(plan.artifact_id);
  });

  it('checkpoint open+close works from a subdir', async () => {
    const plan = await rootAgent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const cp = await sub().captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        summary: 'closed from a subdir',
        files_changed: ['apps/cli/src/x.ts'],
        completed_step_ids: [plan.plan_steps[0].step_id],
      },
      { noLlm: true }
    );
    expect(cp.ok).toBe(true);
  });

  it('digest renders from a subdir (resolves the same artifact)', async () => {
    const plan = await rootAgent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await rootAgent.captureSummary({ artifact_id: plan.artifact_id, outcome: 'shipped' });
    const res = await sub().runRaw(['digest', '--json', '--artifact', plan.artifact_id]);
    expect(res.exitCode).toBe(0);
    expect((JSON.parse(res.stdout) as { ok: boolean }).ok).toBe(true);
  });

  it('why from a subdir normalizes cwd-relative AND absolute targets to the stored root-relative key', async () => {
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);
    await writeFile(path.join(subdir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    await git.add('apps/cli/src/a.ts');
    await git.commit('add a', { '--allow-empty': null });

    const plan = await rootAgent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await rootAgent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        summary: 'touched a.ts',
        files_changed: ['apps/cli/src/a.ts'],
        completed_step_ids: [plan.plan_steps[0].step_id],
      },
      { noLlm: true }
    );

    // bare cwd-relative target → normalized to the root-relative path and hits the cp
    const fromSub = await sub().why('a.ts:1');
    expect(fromSub.file).toBe('apps/cli/src/a.ts');
    expect(fromSub.best).not.toBeNull();
    expect(fromSub.best?.artifact_id).toBe(plan.artifact_id);

    // absolute target under the symlinked temp root → resolves identically
    const fromAbs = await sub().why(`${path.join(subdir, 'a.ts')}:1`);
    expect(fromAbs.file).toBe('apps/cli/src/a.ts');
    expect(fromAbs.best?.artifact_id).toBe(plan.artifact_id);
  });

  it('why with an out-of-tree target yields no match, not an error', async () => {
    const r = await sub().why('../../../../../../no-such-out-of-tree-file.ts:1');
    expect(r.best).toBeNull();
    expect(r.blame_sha).toBeNull();
  });

  it('why keeps a tracked symlink literal (does not follow it to its destination)', async () => {
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);
    await writeFile(path.join(repo.path, 'real.ts'), 'export const r = 1;\n', 'utf8');
    await symlink('real.ts', path.join(repo.path, 'link.ts')); // tracked symlink → real.ts
    await git.add(['real.ts', 'link.ts']);
    await git.commit('add real + symlink', { '--allow-empty': null });

    const plan = await rootAgent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    // the checkpoint records the SYMLINK path, not its destination
    await rootAgent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        summary: 'touched the symlink',
        files_changed: ['link.ts'],
        completed_step_ids: [plan.plan_steps[0].step_id],
      },
      { noLlm: true }
    );

    // why must keep `link.ts` literal (NOT normalize to real.ts) and hit the cp
    const onLink = await rootAgent.why('link.ts:1');
    expect(onLink.file).toBe('link.ts');
    expect(onLink.best?.artifact_id).toBe(plan.artifact_id);
  });

  it('--root (appended) and ORCAOPS_ROOT resolve from outside the repo', async () => {
    const plan = await rootAgent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const outside = await outsideDir();

    const viaFlag = await makeAgent({ cwd: outside }).runRaw([
      'status',
      '--json',
      '--root',
      repo.path,
    ]);
    expect(viaFlag.exitCode).toBe(0);
    expect(ids(viaFlag.stdout)).toContain(plan.artifact_id);

    const viaEnv = await makeAgent({ cwd: outside, env: { ORCAOPS_ROOT: repo.path } }).runRaw([
      'status',
      '--json',
    ]);
    expect(viaEnv.exitCode).toBe(0);
    expect(ids(viaEnv.stdout)).toContain(plan.artifact_id);
  });

  it('--root reaches NESTED commands (eval list) and the before-subcommand position', async () => {
    const outside = await outsideDir();

    // nested command, --root APPENDED — exercises optsWithGlobals() (the leaf's
    // opts().root is undefined because Commander binds it to the `eval` parent).
    const nestedAppended = await makeAgent({ cwd: outside }).runRaw([
      'eval',
      'list',
      '--json',
      '--root',
      repo.path,
    ]);
    expect(nestedAppended.exitCode).toBe(0);
    expect((JSON.parse(nestedAppended.stdout) as { ok: boolean }).ok).toBe(true);

    // --root BEFORE the subcommand (program-level), nested.
    const beforeNested = await makeAgent({ cwd: outside }).runRaw([
      '--root',
      repo.path,
      'eval',
      'list',
      '--json',
    ]);
    expect(beforeNested.exitCode).toBe(0);
    expect((JSON.parse(beforeNested.stdout) as { ok: boolean }).ok).toBe(true);

    // a 3-level-deep capture-lifecycle command also resolves the root: a bogus
    // artifact gets PAST root resolution to a non-NOT_A_REPO error.
    const deepNested = await makeAgent({ cwd: outside }).runRaw([
      'capture',
      'checkpoint',
      'open',
      '--root',
      repo.path,
      '--input',
      inputFile(JSON.stringify({ artifact_id: 'does-not-exist', declared_step_ids: ['x'] })),
    ]);
    expect(code(deepNested.stdout)).not.toBe('NOT_A_REPO');

    // control: the same nested command with no override → NOT_A_REPO.
    const control = await makeAgent({ cwd: outside }).runRaw(['eval', 'list', '--json']);
    expect(control.exitCode).not.toBe(0);
    expect(code(control.stdout)).toBe('NOT_A_REPO');
  });

  it('a non-git cwd is NOT_A_REPO; a --root at a git repo without .orcaops is UNINITIALIZED', async () => {
    const outside = await outsideDir();
    const noRepo = await makeAgent({ cwd: outside }).runRaw(['status', '--json']);
    expect(noRepo.exitCode).not.toBe(0);
    expect(code(noRepo.stdout)).toBe('NOT_A_REPO');

    const bare = await createTempRepo({ initialBranch: 'main' });
    cleanups.push(() => bare.cleanup());
    const uninit = await makeAgent({ cwd: outside }).runRaw([
      'status',
      '--json',
      '--root',
      bare.path,
    ]);
    expect(code(uninit.stdout)).toBe('UNINITIALIZED');
  });

  it('init from a subdir refuses with INIT_NOT_AT_ROOT; --here initializes the subdir', async () => {
    const refuse = await sub().runRaw(['init', '--json', '--agents', '', '--no-agents-md']);
    expect(refuse.exitCode).not.toBe(0);
    expect(code(refuse.stdout)).toBe('INIT_NOT_AT_ROOT');

    // ORCAOPS_ROOT must NOT influence init placement: a subdir init with the env
    // set (and no --root/--here) still refuses — init reads the flag, never env.
    const envIgnored = await sub({ ORCAOPS_ROOT: repo.path }).runRaw([
      'init',
      '--json',
      '--agents',
      '',
      '--no-agents-md',
    ]);
    expect(code(envIgnored.stdout)).toBe('INIT_NOT_AT_ROOT');

    const here = await sub().runRaw(['init', '--json', '--agents', '', '--no-agents-md', '--here']);
    expect(here.exitCode).toBe(0);
    expect((JSON.parse(here.stdout) as { ok: boolean }).ok).toBe(true);
  });

  it('init --root <gitTop> from a subdir creates .orcaops at the worktree root', async () => {
    const fresh = await createTempRepo({ initialBranch: 'main' });
    cleanups.push(() => fresh.cleanup());
    const freshSub = path.join(fresh.path, 'pkg', 'src');
    await mkdir(freshSub, { recursive: true });

    const res = await makeAgent({ cwd: freshSub }).runRaw([
      'init',
      '--json',
      '--agents',
      '',
      '--no-agents-md',
      '--root',
      fresh.path,
    ]);
    expect(res.exitCode).toBe(0);
    expect((JSON.parse(res.stdout) as { ok: boolean }).ok).toBe(true);
    // created at the ROOT, not the subdir
    expect(existsSync(path.join(fresh.path, '.orcaops'))).toBe(true);
    expect(existsSync(path.join(freshSub, '.orcaops'))).toBe(false);
  });

  it('doctor runs from a subdir and reports git-repo=pass + init=pass (resolved the worktree top)', async () => {
    const res = await sub().runRaw(['doctor', '--json']);
    const report = JSON.parse(res.stdout) as { checks: Array<{ name: string; status: string }> };
    expect(report.checks.find((c) => c.name === 'git-repo')?.status).toBe('pass');
    expect(report.checks.find((c) => c.name === 'init')?.status).toBe('pass');
  });

  it('resolves through a test-created symlinked path (realpath canonicalization)', async () => {
    const plan = await rootAgent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const linkParent = await mkdtemp(path.join(tmpdir(), 'orcaops-link-'));
    cleanups.push(() => rm(linkParent, { recursive: true, force: true }));
    const link = path.join(linkParent, 'repo-link');
    await symlink(repo.path, link);

    const viaLink = await makeAgent({ cwd: path.join(link, 'apps', 'cli', 'src') }).runRaw([
      'status',
      '--json',
    ]);
    expect(viaLink.exitCode).toBe(0);
    expect(ids(viaLink.stdout)).toContain(plan.artifact_id);
  });
});
