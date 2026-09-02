import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import { registryPath } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { resolveReviewTarget } from './reviewTarget';

const execFileAsync = promisify(execFile);

const PID_A = '019f0000-aaaa-7000-8000-000000000001';
const PID_B = '019f0000-bbbb-7000-8000-000000000002';

// git realpath-resolves macOS tmpdir symlinks (/var → /private/var), so the
// worktree path it reports differs from the raw path we created. Compare by
// basename — unique per temp dir in these tests.
const base = (p: string): string => path.basename(p);

// Track everything we create so a test never leaks a worktree or data dir.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function initProject(projectId?: string): Promise<TempRepo> {
  const repo = await createTempRepo({ initialBranch: 'main' });
  cleanups.push(repo.cleanup);
  await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
  if (projectId !== undefined) {
    await new Repo(repo.path).setLocalConfig('orcaops.projectid', projectId);
  }
  return repo;
}

async function addWorktree(repoPath: string, wtPath: string, branch: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'add', wtPath, '-b', branch], { cwd: repoPath });
  await mkdir(path.join(wtPath, '.orcaops'), { recursive: true });
  cleanups.push(async () => {
    await rm(wtPath, { recursive: true, force: true });
  });
}

/** A throwaway non-git directory, so discoverGitRoot(cwd) resolves to null — keeps
 *  the hot-project cwd candidate out of tests that only exercise the registry. */
async function nonRepoDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-cwd-'));
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Write `<dataDir>/projects.json` and return an env scoped to it. */
async function withRegistry(projects: Record<string, string[]>): Promise<NodeJS.ProcessEnv> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'orcaops-data-'));
  cleanups.push(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const registry = {
    schema_version: 1,
    projects: Object.fromEntries(
      Object.entries(projects).map(([id, paths]) => [
        id,
        {
          display_name: id,
          last_seen_paths: paths,
          remotes: [],
          root_commit_shas: [],
          last_seen_at: '',
        },
      ])
    ),
  };
  await writeFile(registryPath(dataDir), JSON.stringify(registry), 'utf8');
  return { ORCAOPS_DATA_DIR: dataDir };
}

describe('resolveReviewTarget', () => {
  it('resolves to the worktree that has the branch checked out (cross-project via registry)', async () => {
    const repo = await initProject(PID_A);
    const wt = `${repo.path}-feature`;
    await addWorktree(repo.path, wt, 'feature');
    const env = await withRegistry({ [PID_A]: [repo.path] });

    const res = await resolveReviewTarget({
      projectId: PID_A,
      branch: 'feature',
      env,
      cwd: await nonRepoDir(),
    });
    expect(res.ok).toBe(true);
    expect(res.ok && base(res.root)).toBe(base(wt));
  });

  it('refuses with a no-live-worktree notice when the branch is not checked out anywhere', async () => {
    const repo = await initProject(PID_A);
    const env = await withRegistry({ [PID_A]: [repo.path] });

    const res = await resolveReviewTarget({
      projectId: PID_A,
      branch: 'ghost',
      env,
      cwd: await nonRepoDir(),
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('no live worktree');
  });

  it('refuses with a not-locatable notice when the project cannot be found on disk', async () => {
    const env = await withRegistry({ [PID_A]: ['/definitely/not/a/real/path'] });

    const res = await resolveReviewTarget({
      projectId: PID_A,
      branch: 'feature',
      projectLabel: 'my-proj',
      env,
      cwd: await nonRepoDir(),
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('could not locate');
    expect(res.ok === false && res.reason).toContain('my-proj');
  });

  it('rejects a foreign candidate path whose project id does not match', async () => {
    const other = await initProject(PID_B); // a different project's repo
    // The registry hint for PID_A wrongly points at PID_B's repo.
    const env = await withRegistry({ [PID_A]: [other.path] });

    const res = await resolveReviewTarget({
      projectId: PID_A,
      branch: 'main',
      env,
      cwd: await nonRepoDir(),
    });
    expect(res.ok).toBe(false);
    // Foreign path is rejected, so the repo is treated as not located at all.
    expect(res.ok === false && res.reason).toContain('could not locate');
  });

  it('adds an invalid-candidate diagnostic without mislabeling the requested repository', async () => {
    const repo = await initProject('not-a-uuid');
    const env = await withRegistry({ [PID_A]: [repo.path] });

    const res = await resolveReviewTarget({
      projectId: PID_A,
      branch: 'main',
      env,
      cwd: await nonRepoDir(),
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('could not locate');
    expect(res.ok === false && res.reason).toContain(
      'unreadable or invalid stored project identity'
    );
    expect(res.ok === false && res.reason).toContain('orcaops doctor');
  });

  it('continues past an invalid candidate and prefers a later valid match', async () => {
    const invalid = await initProject('not-a-uuid');
    const valid = await initProject(PID_A);
    const env = await withRegistry({ [PID_A]: [valid.path] });

    const res = await resolveReviewTarget({
      projectId: PID_A,
      branch: 'main',
      launchRoot: invalid.path,
      env,
      cwd: await nonRepoDir(),
    });
    expect(res.ok).toBe(true);
    expect(res.ok && base(res.root)).toBe(base(valid.path));
  });

  it('keeps an identity diagnostic when a valid repository lacks the requested worktree', async () => {
    const invalid = await initProject('not-a-uuid');
    const valid = await initProject(PID_A);
    const env = await withRegistry({ [PID_A]: [valid.path] });

    const res = await resolveReviewTarget({
      projectId: PID_A,
      branch: 'not-checked-out',
      launchRoot: invalid.path,
      env,
      cwd: await nonRepoDir(),
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('no live worktree');
    expect(res.ok === false && res.reason).toContain(
      'unreadable or invalid stored project identity'
    );
  });

  it('resolves the hot project from launchRoot without a registry entry', async () => {
    const repo = await initProject(PID_A);
    const env = await withRegistry({}); // empty registry

    const res = await resolveReviewTarget({
      projectId: PID_A,
      branch: 'main',
      launchRoot: repo.path,
      env,
      cwd: await nonRepoDir(),
    });
    expect(res.ok).toBe(true);
    expect(res.ok && base(res.root)).toBe(base(repo.path));
  });

  it('resolves a null-projectId hot project purely from launchRoot', async () => {
    const repo = await initProject(); // no minted project id
    const env = await withRegistry({});

    const res = await resolveReviewTarget({
      projectId: null,
      branch: 'main',
      launchRoot: repo.path,
      env,
      cwd: await nonRepoDir(),
    });
    expect(res.ok).toBe(true);
    expect(res.ok && base(res.root)).toBe(base(repo.path));
  });

  it('resolves the hot project from the cwd git root when launchRoot is undefined (archive disabled)', async () => {
    // Archive disabled: no minted project id, no registry entry, no --root.
    const repo = await initProject();
    const env = await withRegistry({});

    const res = await resolveReviewTarget({
      projectId: null,
      branch: 'main',
      env,
      cwd: repo.path, // discoverGitRoot(cwd) is the only signal here
    });
    expect(res.ok).toBe(true);
    expect(res.ok && base(res.root)).toBe(base(repo.path));
  });

  it('resolves the hot project from ORCAOPS_ROOT when set', async () => {
    const repo = await initProject(PID_A);
    const env = { ...(await withRegistry({})), ORCAOPS_ROOT: repo.path };

    const res = await resolveReviewTarget({
      projectId: PID_A,
      branch: 'main',
      env,
      cwd: await nonRepoDir(), // no launchRoot; ORCAOPS_ROOT is the signal
    });
    expect(res.ok).toBe(true);
    expect(res.ok && base(res.root)).toBe(base(repo.path));
  });
});
