import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { ensureProjectId, PROJECT_ID_CONFIG_KEY, readProjectId } from './project-identity.js';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('project identity', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reads null before any mint', async () => {
    expect(await readProjectId(new Repo(repo.path))).toBeNull();
  });

  it('mints a UUIDv7 once and is idempotent thereafter', async () => {
    const r = new Repo(repo.path);
    const first = await ensureProjectId(r);
    expect(first.minted).toBe(true);
    expect(first.projectId).toMatch(UUID_V7_RE);
    const second = await ensureProjectId(r);
    expect(second.minted).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    expect(await readProjectId(r)).toBe(first.projectId);
  });

  it('shares one identity across worktrees (common-dir property)', async () => {
    await writeFile(path.join(repo.path, 'seed.txt'), 'x\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('seed.txt');
    await git.commit('seed');
    const { projectId } = await ensureProjectId(new Repo(repo.path));

    const wtPath = `${repo.path}-wt`;
    await git.raw(['worktree', 'add', wtPath, '-b', 'wt-branch']);
    const fromWorktree = await ensureProjectId(new Repo(wtPath));
    expect(fromWorktree.minted).toBe(false);
    expect(fromWorktree.projectId).toBe(projectId);
  });

  it('uses the lowercase config key', () => {
    expect(PROJECT_ID_CONFIG_KEY).toBe('orcaops.projectid');
  });
});
