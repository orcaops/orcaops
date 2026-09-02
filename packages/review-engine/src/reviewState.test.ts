import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureReviewStateVersion,
  inspectReviewStateVersion,
  resetReviewState,
  REVIEW_STATE_VERSION,
} from './reviewState.js';

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-state-'));
  dir = path.join(root, '.orcaops', 'reviews', 'a-branch');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function markerVersion(target: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(target, 'review-state.json'), 'utf8')) as {
      review_state_version: number;
    };
    return raw.review_state_version;
  } catch {
    return null;
  }
}

describe('review state version gate', () => {
  it('initializes a fresh directory with the current version', async () => {
    await expect(ensureReviewStateVersion(dir, root)).resolves.toEqual({ initialized: true });
    expect(await markerVersion(dir)).toBe(REVIEW_STATE_VERSION);
  });

  it('refuses to initialize through a symlinked reviews root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-review-state-outside-'));
    try {
      await mkdir(path.join(root, '.orcaops'), { recursive: true });
      await symlink(outside, path.join(root, '.orcaops', 'reviews'), 'dir');

      await expect(ensureReviewStateVersion(dir, root)).rejects.toThrow(/symbolic link/u);
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('leaves a current directory unchanged', async () => {
    await ensureReviewStateVersion(dir, root);
    await writeFile(path.join(dir, 'journal.ndjson'), 'user data\n');

    await expect(ensureReviewStateVersion(dir, root)).resolves.toEqual({ initialized: false });

    expect(await readFile(path.join(dir, 'journal.ndjson'), 'utf8')).toBe('user data\n');
    expect(await readdir(dir)).toEqual(['journal.ndjson', 'review-state.json']);
  });

  it.each([
    ['unversioned', null],
    ['older', REVIEW_STATE_VERSION - 1],
    ['newer', REVIEW_STATE_VERSION + 1],
  ] as const)('rejects %s state without changing it', async (_label, version) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'journal.ndjson'), 'must remain untouched\n');
    if (version !== null) {
      await writeFile(
        path.join(dir, 'review-state.json'),
        `${JSON.stringify({ review_state_version: version })}\n`
      );
    }

    await expect(ensureReviewStateVersion(dir, root)).rejects.toThrow('UNSUPPORTED_SCHEMA');
    expect(await inspectReviewStateVersion(dir)).toMatchObject({
      status: 'UNSUPPORTED_SCHEMA',
      version,
    });
    expect(await readFile(path.join(dir, 'journal.ndjson'), 'utf8')).toBe(
      'must remain untouched\n'
    );
  });

  it('rejects a corrupt current marker', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'review-state.json'), '{not json');

    await expect(ensureReviewStateVersion(dir, root)).rejects.toThrow('CORRUPT');
    expect(await inspectReviewStateVersion(dir)).toMatchObject({ status: 'CORRUPT' });
  });

  it('destructively resets all state to the current version', async () => {
    await mkdir(path.join(dir, 'twolane', 'run-1'), { recursive: true });
    await writeFile(path.join(dir, 'journal.ndjson'), 'reviewer data\n');
    await writeFile(path.join(dir, 'comments.ndjson'), 'comments\n');
    await writeFile(path.join(dir, 'twolane', 'run-1', 'model.json'), 'derived\n');

    await resetReviewState(dir, root);

    expect(await readdir(dir)).toEqual(['review-state.json']);
    expect(await markerVersion(dir)).toBe(REVIEW_STATE_VERSION);
  });

  it('refuses to reset through a symlinked branch directory', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-review-reset-outside-'));
    try {
      await mkdir(path.dirname(dir), { recursive: true });
      await writeFile(path.join(outside, 'sentinel'), 'keep\n');
      await symlink(outside, dir, 'dir');

      await expect(resetReviewState(dir, root)).rejects.toThrow(/symbolic link/u);
      await expect(readFile(path.join(outside, 'sentinel'), 'utf8')).resolves.toBe('keep\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reinitializes normally after an interrupted destructive reset leaves no directory', async () => {
    await ensureReviewStateVersion(dir, root);
    await rm(dir, { recursive: true, force: true });

    await expect(ensureReviewStateVersion(dir, root)).resolves.toEqual({ initialized: true });
    expect(await markerVersion(dir)).toBe(REVIEW_STATE_VERSION);
  });
});
