import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { resolveScopeInputs, worktreeCaptureFailureMessage } from './scope.js';

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

describe('resolveScopeInputs — unmerged index', () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('hard-fails naming the conflicted paths (capture itself no longer aborts)', async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    const stageLine = (content: string, stage: number): string => {
      const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repo!.path,
        input: content,
      })
        .toString()
        .trim();
      return `100644 ${sha} ${stage}\tconflict.txt`;
    };
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: repo.path,
      input: `${[stageLine('base\n', 1), stageLine('ours\n', 2), stageLine('theirs\n', 3)].join('\n')}\n`,
    });

    await expect(resolveScopeInputs({ root: repo.path, branch: 'main' })).rejects.toThrow(
      /unresolved merge conflicts in the index \(conflict\.txt\)/
    );
  });
});

describe('resolveScopeInputs — capture.exclude on the pinned review tree', () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

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

  it('withholds an excluded file the author opted in, keeping its benign neighbour', async () => {
    // The tree resolved here is pinned to refs/orcaops/review/<slug>, a durable
    // ref reachable from no branch. Stubbing the hunks downstream leaves the
    // blob in the object store; only withholding it at capture does not.
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeConfig(repo.path, { exclude: ['**/*.secret'], exclude_builtins: true });
    await writeEvidence(repo.path);

    const scope = await resolveScopeInputs({ root: repo.path, branch: 'main' });
    const entries = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', scope.input.pinnedTreeSha],
      { cwd: repo.path, encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean);

    expect(entries).not.toContain('evidence/.env');
    // A repo-declared pattern, so it also proves the exclude set survives the
    // read-only config projection this path loads.
    expect(entries).not.toContain('evidence/prod.secret');
    expect(entries).toContain('evidence/run.log');
    expect(scope.reviewIncludedUntracked).toEqual(['evidence/run.log']);
    expect(
      scope.disclosures.find((d) => d.code === 'untracked_evidence_withheld')?.message
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

    const scope = await resolveScopeInputs({ root: repo.path, branch: 'main' });
    const entries = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', scope.input.pinnedTreeSha],
      { cwd: repo.path, encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean);

    expect(entries).toContain('evidence/.env');
    expect(scope.disclosures.find((d) => d.code === 'untracked_evidence_withheld')).toBeUndefined();
    expect(
      scope.disclosures
        .filter((d) => d.code === 'untracked_evidence_included')
        .map((d) => d.message)
        .join('\n')
    ).toContain('evidence/.env');
  });

  it('refuses before pinning anything when the exclude policy is malformed', async () => {
    // A typo in a security control must not be quietly discarded on the way to
    // a durable ref. The config schema catches an empty entry first; scope's
    // own ExcludePolicyError guard backstops any pattern that clears the schema
    // and still fails glob validation.
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeConfig(repo.path, { exclude: [''], exclude_builtins: true });
    await writeEvidence(repo.path);

    await expect(resolveScopeInputs({ root: repo.path, branch: 'main' })).rejects.toThrow(
      /capture\.exclude/
    );
  });
});
