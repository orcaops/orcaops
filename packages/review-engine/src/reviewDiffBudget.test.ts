import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { captureReviewWorktreeTreeSha, diffSnapshotTrees, Repo } from '@orcaops/core';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { collectReviewDiffBudget } from './reviewDiffBudget.js';

const repos: TempRepo[] = [];

async function git(root: string, args: readonly string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)('git', [...args], { cwd: root });
  return result.stdout.trim();
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

describe('collectReviewDiffBudget', () => {
  it('keeps the ordinary diff byte-identical when it fits', async () => {
    const fixture = await createTempRepo({ initialBranch: 'main' });
    repos.push(fixture);
    await writeFile(path.join(fixture.path, 'README.md'), '# changed\n');
    const openTreeSha = await git(fixture.path, ['rev-parse', 'HEAD^{tree}']);
    const capture = await captureReviewWorktreeTreeSha(new Repo(fixture.path));
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    const expected = await diffSnapshotTrees({
      repo: new Repo(fixture.path),
      openTreeSha,
      closeTreeSha: capture.tree_sha,
      maxDiffBytes: 1_000_000,
    });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const actual = await collectReviewDiffBudget({
      repo: new Repo(fixture.path),
      openTreeSha,
      closeTreeSha: capture.tree_sha,
      maxDiffBytes: 1_000_000,
      includedUntracked: [],
    });
    expect(actual.ok).toBe(true);
    expect(actual.truncated).toBe(false);
    expect(Buffer.from(actual.diff)).toEqual(Buffer.from(expected.diff));
  });

  it('protects representative product hunks from one giant archive file', async () => {
    const fixture = await createTempRepo({ initialBranch: 'main' });
    repos.push(fixture);
    await mkdir(path.join(fixture.path, 'src'), { recursive: true });
    await writeFile(path.join(fixture.path, '000-archive.md'), 'archive seed\n');
    await writeFile(path.join(fixture.path, 'src', 'alpha.ts'), 'export const alpha = 0;\n');
    await writeFile(path.join(fixture.path, 'src', 'beta.ts'), 'export const beta = 0;\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'budget base']);
    const openTreeSha = await git(fixture.path, ['rev-parse', 'HEAD^{tree}']);

    await writeFile(
      path.join(fixture.path, '000-archive.md'),
      `${Array.from({ length: 2_000 }, (_, index) => `archived finding ${index}`).join('\n')}\n`
    );
    await writeFile(path.join(fixture.path, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
    await writeFile(path.join(fixture.path, 'src', 'beta.ts'), 'export const beta = 2;\n');
    const capture = await captureReviewWorktreeTreeSha(new Repo(fixture.path));
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;

    const result = await collectReviewDiffBudget({
      repo: new Repo(fixture.path),
      openTreeSha,
      closeTreeSha: capture.tree_sha,
      maxDiffBytes: 1_500,
      includedUntracked: [],
    });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    const retained = Buffer.from(result.diff).toString('utf8');
    expect(retained).toContain('src/alpha.ts');
    expect(retained).toContain('src/beta.ts');
    expect(retained).toContain('export const alpha = 1');
    expect(retained).toContain('export const beta = 2');
    expect(result.detail).toContain('000-archive.md');
    expect(result.detail).toContain('retained 0/');
    expect(result.omittedBytes).toBeGreaterThan(0);
  });
});
