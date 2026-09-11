import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadReadOnlyProjectConfig, Repo } from '@orcaops/core';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { resolveReviewBasis, worktreeCaptureFailureMessage } from './reviewBasis.js';

// The floor-capture throw preserves the capture pipeline's
// underlying cause — the bare reason enum ("unknown") had discarded the git
// stderr that explains the failure.
describe('worktreeCaptureFailureMessage', () => {
  it('carries the underlying error message alongside the reason', () => {
    expect(
      worktreeCaptureFailureMessage({
        error_reason: 'unknown',
        error_message: 'fatal: could not write .git/objects: Operation not permitted',
      })
    ).toBe(
      'worktree tree capture failed: unknown — fatal: could not write .git/objects: Operation not permitted'
    );
  });

  it('falls back to the reason alone when no message exists', () => {
    expect(worktreeCaptureFailureMessage({ error_reason: 'merge_conflict' })).toBe(
      'worktree tree capture failed: merge_conflict'
    );
  });

  it('ignores an empty error message', () => {
    expect(worktreeCaptureFailureMessage({ error_reason: 'unknown', error_message: '' })).toBe(
      'worktree tree capture failed: unknown'
    );
  });
});

let repo: TempRepo | undefined;
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

async function basis(root: string) {
  return resolveReviewBasis({
    root,
    repo: new Repo(root),
    branch: 'main',
    config: await loadReadOnlyProjectConfig(root),
    artifacts: [],
    overrideTree: null,
    overrideRef: null,
    durableObjects: false,
  });
}

const writeConfig = async (root: string, capture: unknown): Promise<void> => {
  await mkdir(path.join(root, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(root, '.orcaops', 'config.json'),
    JSON.stringify({
      schema_version: 6,
      review: { include_untracked: ['evidence'] },
      capture,
    }),
    'utf8'
  );
};

const writeEvidence = async (root: string): Promise<void> => {
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'evidence', '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');
  await writeFile(path.join(root, 'evidence', 'prod.secret'), 'EXAMPLE0\n', 'utf8');
  await writeFile(path.join(root, 'evidence', 'run.log'), 'started\n', 'utf8');
};

const treeEntries = (root: string, tree: string): string[] =>
  execFileSync('git', ['ls-tree', '-r', '--name-only', tree], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

describe('resolveReviewBasis — unmerged index', () => {
  it('hard-fails naming the conflicted paths (capture itself no longer aborts)', async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    const stageLine = (content: string, stage: number): string => {
      const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repo!.path,
        input: content,
        encoding: 'utf8',
      }).trim();
      return `100644 ${oid} ${stage}\tconflicted.txt`;
    };
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: repo.path,
      input: `${stageLine('base\n', 1)}\n${stageLine('ours\n', 2)}\n${stageLine('theirs\n', 3)}\n`,
    });
    await expect(basis(repo.path)).rejects.toThrow(/unresolved merge conflicts/u);
  });
});

describe('resolveReviewBasis — capture.exclude on the pinned review tree', () => {
  it('withholds an excluded file the author opted in, keeping its benign neighbour', async () => {
    // The tree resolved here is pinned to a durable ref reachable from no
    // branch. Stubbing the hunks downstream leaves the blob in the object
    // store; only withholding it at capture does not.
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeConfig(repo.path, { exclude: ['**/*.secret'], exclude_builtins: true });
    await writeEvidence(repo.path);

    const resolved = await basis(repo.path);
    const entries = treeEntries(repo.path, resolved.pinnedTreeSha);

    expect(entries).not.toContain('evidence/.env');
    expect(entries).not.toContain('evidence/prod.secret');
    expect(entries).toContain('evidence/run.log');
    expect(resolved.reviewIncludedUntracked).toEqual(['evidence/run.log']);
    expect(
      resolved.disclosures.find((d) => d.code === 'untracked_evidence_withheld')?.message
    ).toContain('evidence/.env');
  });

  it('never claims a file was withheld while the pinned tree carries it', async () => {
    // Untracking a committed secret is staged before it is committed, and in
    // that window the two sides classify the path differently: untracked to the
    // review classification, tracked to the tree builder. The tree keeps it, so
    // the withheld disclosure must not name it.
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeConfig(repo.path, { exclude: ['**/.env'], exclude_builtins: true });
    await mkdir(path.join(repo.path, 'evidence'), { recursive: true });
    await writeFile(path.join(repo.path, 'evidence', '.env'), 'OLD=harmless\n', 'utf8');
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo?.path, stdio: 'ignore' });
    };
    run('add', 'evidence/.env');
    run('commit', '-m', 'seed evidence');
    await writeFile(path.join(repo.path, 'evidence', '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');
    run('rm', '--cached', '--quiet', 'evidence/.env');

    const resolved = await basis(repo.path);
    const entries = treeEntries(repo.path, resolved.pinnedTreeSha);

    expect(entries).toContain('evidence/.env');
    expect(
      resolved.disclosures.find((d) => d.code === 'untracked_evidence_withheld')
    ).toBeUndefined();
    expect(
      resolved.disclosures
        .filter((d) => d.code === 'untracked_evidence_included')
        .map((d) => d.message)
        .join('\n')
    ).toContain('evidence/.env');
  });

  it('refuses before pinning anything when the exclude policy is malformed', async () => {
    // A typo in a security control must not be quietly discarded on the way to
    // a durable ref.
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeConfig(repo.path, { exclude: [''], exclude_builtins: true });
    await writeEvidence(repo.path);

    await expect(basis(repo.path)).rejects.toThrow(/capture\.exclude/u);
  });
});
