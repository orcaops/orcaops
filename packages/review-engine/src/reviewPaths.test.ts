import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathContainmentError } from '@orcaops/storage';

import { reviewDirPath, reviewEntryPath, reviewRootPath } from './reviewPaths.js';

describe('Review path containment', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-path-'));
    outside = await mkdtemp(path.join(tmpdir(), 'orcaops-review-outside-'));
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('resolves an uncreated review directory inside the repository', async () => {
    expect(reviewDirPath(root, 'feature%2Fsafe')).toBe(
      path.join(await realpath(root), '.orcaops', 'reviews', 'feature%2Fsafe')
    );
  });

  it('rejects symlinked review roots and branch directories', async () => {
    await mkdir(path.join(root, '.orcaops'), { recursive: true });
    await symlink(outside, path.join(root, '.orcaops', 'reviews'), 'dir');
    expect(() => reviewRootPath(root)).toThrow(PathContainmentError);

    await rm(path.join(root, '.orcaops', 'reviews'));
    await mkdir(path.join(root, '.orcaops', 'reviews'));
    await symlink(outside, path.join(root, '.orcaops', 'reviews', 'demo'), 'dir');
    expect(() => reviewDirPath(root, 'demo')).toThrow(PathContainmentError);
  });

  it('rejects symlinks in nested run paths and at final files', async () => {
    const reviewDir = reviewDirPath(root, 'demo');
    await mkdir(reviewDir, { recursive: true });
    await symlink(outside, path.join(reviewDir, 'twolane'), 'dir');
    expect(() =>
      reviewEntryPath(root, path.join(reviewDir, 'twolane', 'run-1'), 'review run')
    ).toThrow(PathContainmentError);

    await rm(path.join(reviewDir, 'twolane'));
    const externalFile = path.join(outside, 'journal.ndjson');
    await symlink(externalFile, path.join(reviewDir, 'journal.ndjson'));
    expect(() =>
      reviewEntryPath(root, path.join(reviewDir, 'journal.ndjson'), 'review journal')
    ).toThrow(PathContainmentError);
  });
});
