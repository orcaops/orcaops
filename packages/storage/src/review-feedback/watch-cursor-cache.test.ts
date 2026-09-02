import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  readReviewFeedbackWatchCursor,
  writeReviewFeedbackWatchCursor,
} from './watch-cursor-cache.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rf-cursor-'));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

it('round-trips per (base_url, org, subject), null when absent', async () => {
  expect(
    await readReviewFeedbackWatchCursor(dir, 'http://localhost:3001', 'org_1', 'pr_1')
  ).toBeNull();
  await writeReviewFeedbackWatchCursor(dir, {
    baseUrl: 'http://localhost:3001',
    orgId: 'org_1',
    pullRequestId: 'pr_1',
    lastSeenHumanActivityAt: '2026-07-02T10:00:00.000Z',
  });
  // trailing-slash variant keys the same namespace (canonicalize-then-hash)
  expect(await readReviewFeedbackWatchCursor(dir, 'http://localhost:3001/', 'org_1', 'pr_1')).toBe(
    '2026-07-02T10:00:00.000Z'
  );
  expect(
    await readReviewFeedbackWatchCursor(dir, 'http://localhost:3001', 'org_1', 'pr_2')
  ).toBeNull();
});

it('refuses an ancestor cache symlink before reading or writing outside the repository', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'rf-cursor-outside-'));
  try {
    const cacheDir = path.join(dir, '.orcaops', 'cache');
    await mkdir(path.dirname(cacheDir), { recursive: true });
    await symlink(outside, cacheDir);
    const args = {
      baseUrl: 'http://localhost:3001',
      orgId: 'org_1',
      pullRequestId: 'pr_1',
      lastSeenHumanActivityAt: '2026-07-02T10:00:00.000Z',
    };

    await expect(writeReviewFeedbackWatchCursor(cacheDir, args, dir)).rejects.toThrow(
      /must not contain symlinks/
    );
    await expect(
      readReviewFeedbackWatchCursor(cacheDir, args.baseUrl, args.orgId, args.pullRequestId, dir)
    ).rejects.toThrow(/must not contain symlinks/);
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
