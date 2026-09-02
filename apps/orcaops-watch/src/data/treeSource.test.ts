// Round-trips the tree-source fetcher against a REAL temp repo: two commits,
// the two review refs set by hand (update-ref), then every degrade path —
// old/new reads, the rename old-path, size cap, absent path (null), missing
// ref (the loud pruned message), and the per-side closure cache.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTreeSourceFetcher,
  PinnedSourceUnavailableError,
  PRUNED_SOURCE_MESSAGE,
  SourceTooLargeError,
} from './treeSource';

const execFileAsync = promisify(execFile);

const SLUG = 'fixture-branch';
const BASE_TEXT = 'const base = 1;\nconst keep = 2;\n';
const PINNED_TEXT = 'const base = 1;\nconst keep = 2;\nconst added = 3;\n';
const RENAMED_FROM_TEXT = 'renamed source, old spelling\n';

let root: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'treeSource-test',
      GIT_AUTHOR_EMAIL: 'test@local',
      GIT_COMMITTER_NAME: 'treeSource-test',
      GIT_COMMITTER_EMAIL: 'test@local',
    },
  });
  return String(stdout).trim();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orcaops-tree-source-'));
  await git(['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'a.ts'), BASE_TEXT, 'utf8');
  await writeFile(path.join(root, 'old-name.ts'), RENAMED_FROM_TEXT, 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'base']);
  const baseSha = await git(['rev-parse', 'HEAD']);
  await writeFile(path.join(root, 'a.ts'), PINNED_TEXT, 'utf8');
  await rm(path.join(root, 'old-name.ts'));
  await writeFile(path.join(root, 'new-name.ts'), RENAMED_FROM_TEXT, 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'pinned']);
  const pinnedSha = await git(['rev-parse', 'HEAD']);
  await git(['update-ref', `refs/orcaops/review/${SLUG}`, pinnedSha]);
  await git(['update-ref', `refs/orcaops/review/${SLUG}-base`, baseSha]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createTreeSourceFetcher', () => {
  it('round-trips both sides through the pinned refs', async () => {
    const f = createTreeSourceFetcher({ root, slug: SLUG, path: 'a.ts' });
    await expect(f.getFullText('new')).resolves.toBe(PINNED_TEXT);
    await expect(f.getFullText('old')).resolves.toBe(BASE_TEXT);
  });

  it('reads the old side through prevPath for renamed files', async () => {
    const f = createTreeSourceFetcher({
      root,
      slug: SLUG,
      path: 'new-name.ts',
      prevPath: 'old-name.ts',
    });
    await expect(f.getFullText('new')).resolves.toBe(RENAMED_FROM_TEXT);
    await expect(f.getFullText('old')).resolves.toBe(RENAMED_FROM_TEXT);
  });

  it('resolves null for a path absent on that side (added/deleted files)', async () => {
    // new-name.ts exists only in the pinned tree — its base-side read is the
    // added-file case; a never-existing path is the same quiet null.
    const added = createTreeSourceFetcher({ root, slug: SLUG, path: 'new-name.ts' });
    await expect(added.getFullText('old')).resolves.toBeNull();
    const ghost = createTreeSourceFetcher({ root, slug: SLUG, path: 'no/such/file.ts' });
    await expect(ghost.getFullText('new')).resolves.toBeNull();
  });

  it('trips the size cap with SourceTooLargeError', async () => {
    const f = createTreeSourceFetcher({ root, slug: SLUG, path: 'a.ts', maxBytes: 4 });
    await expect(f.getFullText('new')).rejects.toBeInstanceOf(SourceTooLargeError);
  });

  it('throws the loud pruned message when the ref is missing', async () => {
    const f = createTreeSourceFetcher({ root, slug: 'never-pinned', path: 'a.ts' });
    await expect(f.getFullText('new')).rejects.toBeInstanceOf(PinnedSourceUnavailableError);
    await expect(f.getFullText('new')).rejects.toThrow(PRUNED_SOURCE_MESSAGE);
  });

  it('caches per side in the closure (a deleted ref no longer matters)', async () => {
    const f = createTreeSourceFetcher({ root, slug: SLUG, path: 'a.ts' });
    await expect(f.getFullText('new')).resolves.toBe(PINNED_TEXT);
    await git(['update-ref', '-d', `refs/orcaops/review/${SLUG}`]);
    try {
      // Served from the closure cache — no git round-trip, no pruned throw.
      await expect(f.getFullText('new')).resolves.toBe(PINNED_TEXT);
      // A FRESH fetcher does hit git and degrades loudly.
      const fresh = createTreeSourceFetcher({ root, slug: SLUG, path: 'a.ts' });
      await expect(fresh.getFullText('new')).rejects.toThrow(PRUNED_SOURCE_MESSAGE);
    } finally {
      // Restore the ref so test order stays irrelevant.
      await git(['update-ref', `refs/orcaops/review/${SLUG}`, await git(['rev-parse', 'HEAD'])]);
    }
  });
});
