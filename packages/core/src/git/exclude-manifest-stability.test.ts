import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { Repo } from './repo.js';
import { captureWorktreeTree, diffSnapshotTrees } from './snapshots.js';
import { buildDiffFingerprintManifest } from '../diff-fingerprint/adapter.js';

const MAX_DIFF_BYTES = 2_000_000;
const EXCLUDES = ['**/.env', '**/.env.*'];

/**
 * The exclude set must never become an input to manifest derivation.
 *
 * The load-bearing assertion here is the structural one — that nothing about
 * the exclude set appears in the manifest. The re-derivation cases beside it
 * only establish determinism, since derivation takes no exclude argument to
 * vary.
 *
 * `deriveManifestHashes` re-diffs the trees a checkpoint RECORDED, so a
 * checkpoint captured before the feature and one captured after must each stay
 * self-consistent under whatever config happens to be in effect later. If the
 * set leaked into the manifest — the way `max_diff_bytes` legitimately does,
 * because that one reproduces a capture-time truncation decision — then merely
 * enabling excludes would perturb the stored hash of every prior checkpoint and
 * trip INTEGRITY_MISMATCH across the whole repository.
 */
describe('capture.exclude does not perturb manifest derivation', () => {
  let repo: TempRepo;

  const capturePair = async (
    excludePatterns: readonly string[] | undefined
  ): Promise<{ open: string; close: string }> => {
    const r = new Repo(repo.path);
    const opts = excludePatterns
      ? { skipCommit: true as const, excludePatterns }
      : { skipCommit: true as const };
    // Reset to a known state first: a second invocation in the same test would
    // otherwise find nothing left to change and snapshot two identical trees,
    // leaving every assertion here comparing empty manifests off one tree sha.
    await writeFile(path.join(repo.path, 'src.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=x\n', 'utf8');
    const open = await captureWorktreeTree(r, 'open', opts);
    await writeFile(path.join(repo.path, 'src.ts'), 'export const a = 2;\n', 'utf8');
    // The excluded file has to change INSIDE the window, or it is absent from
    // the open-to-close diff whether or not exclusion works, and the structural
    // assertion below cannot fail.
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=changed\n', 'utf8');
    const close = await captureWorktreeTree(r, 'close', opts);
    return {
      open: (open as { tree_sha: string }).tree_sha,
      close: (close as { tree_sha: string }).tree_sha,
    };
  };

  const manifestFor = async (open: string, close: string) => {
    const diff = await diffSnapshotTrees({
      repo: new Repo(repo.path),
      openTreeSha: open,
      closeTreeSha: close,
      maxDiffBytes: MAX_DIFF_BYTES,
    });
    if (!diff.ok) throw new Error('diff failed');
    const built = await buildDiffFingerprintManifest({
      artifactId: '01a03416-0000-7000-8000-000000000001',
      checkpointN: 1,
      openTreeSha: open,
      closeTreeSha: close,
      diffBytes: diff.diff,
      truncated: diff.truncated,
      maxDiffBytes: MAX_DIFF_BYTES,
    });
    // `manifest_hash` lives on the summary. Read off the BuildResult it is
    // undefined, and the comparisons below then pass while asserting nothing —
    // hence the explicit null guard.
    const hash = built.summary.manifest_hash;
    if (hash === null) throw new Error('manifest hash was not derived');
    return { hash, serialized: JSON.stringify(built) };
  };

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeFile(path.join(repo.path, 'src.ts'), 'export const a = 1;\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('src.ts');
    await git.commit('root');
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=x\n', 'utf8');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const REDERIVE_CASES: ReadonlyArray<[string, readonly string[] | undefined]> = [
    ['captured WITHOUT excludes', undefined],
    ['captured WITH excludes', EXCLUDES],
  ];

  it.each(REDERIVE_CASES)(
    're-derives an identical hash from trees %s',
    async (_label, patterns) => {
      // This proves DETERMINISM only: `manifestFor` takes no exclude argument, so
      // there is nothing to vary between the two derivations. That the exclude set
      // cannot reach derivation at all is the actual invariant, and the structural
      // test below is what asserts it.
      const trees = await capturePair(patterns);
      const atCapture = await manifestFor(trees.open, trees.close);
      const reDerived = await manifestFor(trees.open, trees.close);
      expect(atCapture.hash).toMatch(/\S/);
      expect(reDerived.hash).toBe(atCapture.hash);
    }
  );

  it('records nothing about the exclude set in the manifest', async () => {
    // The structural guard. `max_diff_bytes` IS recorded, because derivation
    // must reproduce a truncation decision; the exclude set has no such
    // decision to reproduce — the tree object is the record. Adding it here
    // would perturb every prior checkpoint's stored hash.
    const excludedTrees = await capturePair(EXCLUDES);
    const excluded = await manifestFor(excludedTrees.open, excludedTrees.close);
    const includedTrees = await capturePair(undefined);
    const included = await manifestFor(includedTrees.open, includedTrees.close);
    // Control, and the reason this assertion can fail at all: the excluded file
    // changes inside the window, so it IS recorded when exclusion is off.
    expect(included.serialized).toContain('.env');
    // Guards the guard: a not.toContain pair passes trivially against an empty
    // or malformed manifest, so pin something the manifest genuinely records.
    expect(excluded.serialized).toContain('max_diff_bytes');
    expect(excluded.serialized).not.toContain('exclude');
    expect(excluded.serialized).not.toContain('.env');
  });

  it('excluding a file changes the TREE but nothing about how a tree is hashed', async () => {
    const withOut = await capturePair(undefined);
    const withEx = await capturePair(EXCLUDES);
    const entries = (sha: string): string[] =>
      execFileSync('git', ['ls-tree', '-r', '--name-only', sha], { cwd: repo.path })
        .toString('utf8')
        .split('\n')
        .filter(Boolean);
    expect(entries(withOut.open)).toContain('.env');
    expect(entries(withEx.open)).not.toContain('.env');
    // Different trees legitimately hash differently. What matters is that each
    // is stable under re-derivation, which the two cases above assert.
    expect(withEx.open).not.toBe(withOut.open);
  });
});
