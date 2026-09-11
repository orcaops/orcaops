import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { createTempRepo, writeProjectConfig } from '@orcaops/test-harness';

import { resolveReviewTarget } from './reviewTarget';

const execFileAsync = promisify(execFile);
const PID_A = '019f0000-aaaa-7000-8000-000000000001';
const PID_B = '019f0000-bbbb-7000-8000-000000000002';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-target-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(projectId = PID_A) {
  const repo = await createTempRepo({ initialBranch: 'main' });
  cleanups.push(repo.cleanup);
  const dataRoot = await directory();
  const setup = await setupProjectDatabase({
    cwd: repo.path,
    root: dataRoot,
    projectId,
    authoredPayloads: [],
    secretAllow: [],
  });
  await writeProjectConfig(repo.path);
  const commonDirectory = await new Repo(repo.path).getCommonDirAbsolute();
  return {
    repo,
    options: {
      projectId,
      branch: 'main',
      dataRoot,
      storeInstanceId: setup.registration.authority.store_instance_id,
      repository: { commonDirectory, instanceId: setup.registration.repository_instance_id },
      env: { ORCAOPS_DATA_DIR: dataRoot },
      cwd: await directory(),
    },
    registration: path.join(commonDirectory, 'orcaops', 'registration.json'),
    database: path.join(dataRoot, 'projects', projectId, 'history.sqlite3'),
  };
}
async function addWorktree(repoPath: string, branch: string) {
  const worktree = path.join(await directory(), branch);
  await execFileAsync('git', ['worktree', 'add', worktree, '-b', branch], { cwd: repoPath });
  await writeProjectConfig(worktree);
  return worktree;
}

// Git resolves macOS's temporary-directory aliases before reporting worktree paths.
const basename = (value: string) => path.basename(value);

describe('registered review worktree selection', () => {
  it('finds another project branch from its canonical locator without writing history', async () => {
    const f = await fixture();
    const worktree = await addWorktree(f.repo.path, 'feature');
    const before = await Promise.all([readFile(f.registration), readFile(f.database)]);
    const result = await resolveReviewTarget({ ...f.options, branch: 'feature' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(basename(result.root)).toBe(basename(worktree));
    const after = await Promise.all([readFile(f.registration), readFile(f.database)]);
    for (const [index, bytes] of after.entries()) expect(bytes.equals(before[index]!)).toBe(true);
    await expect(readFile(path.join(f.options.dataRoot, 'projects.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('distinguishes an absent branch from an absent repository', async () => {
    const f = await fixture();
    const branch = await resolveReviewTarget({ ...f.options, branch: 'ghost' });
    expect(branch.ok).toBe(false);
    if (!branch.ok) expect(branch.reason).toContain('no live worktree');
    const missing = await resolveReviewTarget({
      ...f.options,
      repository: undefined,
      projectLabel: 'my-project',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toContain('could not locate');
      expect(missing.reason).toContain('my-project');
    }
  });

  it('rejects foreign project, store and repository identities', async () => {
    const f = await fixture(PID_B);
    for (const changed of [
      { projectId: PID_A },
      { storeInstanceId: PID_A },
      { repository: { ...f.options.repository, instanceId: PID_A } },
    ]) {
      const result = await resolveReviewTarget({ ...f.options, ...changed });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('could not locate');
    }
  });

  it('reports broken configuration without treating it as an uninitialized worktree', async () => {
    const f = await fixture();
    const config = path.join(f.repo.path, '.orcaops', 'config.json');
    await writeFile(config, '{ broken');
    const result = await resolveReviewTarget(f.options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('configuration error');
      expect(result.reason).toContain(config);
    }
  });

  it('discloses invalid registration and continues to a later valid candidate', async () => {
    const broken = await fixture(PID_B);
    const valid = await fixture();
    await writeFile(broken.registration, '{ invalid');
    const missing = await resolveReviewTarget(broken.options);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toContain('invalid stored project identity');
      expect(missing.reason).toContain('orcaops doctor');
    }
    const found = await resolveReviewTarget({ ...valid.options, launchRoot: broken.repo.path });
    expect(found.ok).toBe(true);
    if (found.ok) expect(basename(found.root)).toBe(basename(valid.repo.path));
    const absentBranch = await resolveReviewTarget({
      ...valid.options,
      launchRoot: broken.repo.path,
      branch: 'ghost',
    });
    expect(absentBranch.ok).toBe(false);
    if (!absentBranch.ok) {
      expect(absentBranch.reason).toContain('no live worktree');
      expect(absentBranch.reason).toContain('invalid stored project identity');
    }
  });

  it.each(['launch', 'cwd', 'environment'] as const)(
    'finds the current registered project through %s',
    async (source) => {
      const f = await fixture();
      const result = await resolveReviewTarget({
        ...f.options,
        repository: undefined,
        ...(source === 'launch'
          ? { launchRoot: f.repo.path }
          : source === 'cwd'
            ? { cwd: f.repo.path }
            : { env: { ...f.options.env, ORCAOPS_ROOT: f.repo.path } }),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(basename(result.root)).toBe(basename(f.repo.path));
    }
  );

  it('never treats missing registration or a missing project identity as a fresh review target', async () => {
    const f = await fixture();
    await rm(f.registration);
    const result = await resolveReviewTarget({ ...f.options, launchRoot: f.repo.path });
    expect(result.ok).toBe(false);
    await expect(readFile(f.registration)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await resolveReviewTarget({ ...f.options, projectId: null, launchRoot: f.repo.path })
    ).toMatchObject({ ok: false });
  });
});
