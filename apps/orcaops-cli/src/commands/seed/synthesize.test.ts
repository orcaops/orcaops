import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { DetailedCommit, SeedCluster } from '@orcaops/core';

import { synthesizeSeedCluster } from './synthesize.js';

function member(sha: string, subject: string, file: string): DetailedCommit {
  return {
    sha: sha.padEnd(40, '0'),
    parentShas: [],
    authorEmail: 'dev@example.com',
    committerDateIso: '2025-01-02T03:04:05.000Z',
    subject,
    body: '',
    files: [file],
  };
}

function fixture(): SeedCluster {
  const first = member('a', 'feat: repeated work', 'src/a.ts');
  const second = member('b', 'feat: repeated work', 'src/b.ts');
  return {
    key: `run:${first.sha}:${second.sha}`,
    kind: 'run',
    label: 'A useful imported unit',
    baseSha: '1'.repeat(40),
    headSha: second.sha,
    commits: [first, second],
    checkpoints: [
      {
        key: first.sha,
        commits: [first],
        parentSha: '1'.repeat(40),
        headSha: first.sha,
        files: first.files,
        committerDateIso: first.committerDateIso,
      },
      {
        key: second.sha,
        commits: [second],
        parentSha: first.sha,
        headSha: second.sha,
        files: second.files,
        committerDateIso: second.committerDateIso,
      },
    ],
    authors: ['dev@example.com'],
    files: ['src/a.ts', 'src/b.ts'],
    firstParentPosition: 1,
    displayDateIso: second.committerDateIso,
    latestCommitDateIso: second.committerDateIso,
    conventionalType: 'feat',
    conventionalScope: null,
    warnings: [],
  };
}

describe('synthesizeSeedCluster', () => {
  const options = {
    cluster: fixture(),
    branch: 'main',
    rootSha: 'f'.repeat(40),
    installNonce: 'nonce',
    importedAt: '2026-01-01T00:00:00.000Z',
    toolVersion: '1.2.3',
  };

  it('is deterministic for one installation and salted across installations', () => {
    const first = synthesizeSeedCluster(options);
    const replay = synthesizeSeedCluster(options);
    const other = synthesizeSeedCluster({ ...options, installNonce: 'other' });
    expect(replay).toEqual(first);
    expect(other.artifactId).not.toBe(first.artifactId);
    expect(other.checkpoints[0]?.stepId).not.toBe(first.checkpoints[0]?.stepId);
    expect(other.plan.origin).toEqual(first.plan.origin);
  });

  it('creates honest empty evidence fields and unique step labels', () => {
    const synthesis = synthesizeSeedCluster(options);
    expect(synthesis.plan.origin).toMatchObject({
      kind: 'git-import',
      source_range: `${options.cluster.baseSha}..${options.cluster.headSha}`,
      enriched_at: null,
      cluster_key: createHash('sha256')
        .update(`orcaops-seed:v1:${options.rootSha}:${options.cluster.key}`, 'utf8')
        .digest('hex'),
      member_shas_hash: createHash('sha256')
        .update(JSON.stringify(options.cluster.commits.map((commit) => commit.sha).sort()), 'utf8')
        .digest('hex'),
    });
    expect(synthesis.plan.plan_steps.map((step) => step.label)).toEqual([
      'feat: repeated work',
      `feat: repeated work [${options.cluster.commits[1]!.sha.slice(0, 7)}]`,
    ]);
    expect(synthesis.plan.plan_steps.every((step) => step.acceptance_criteria.length === 0)).toBe(
      true
    );
    expect(synthesis.plan.decisions).toEqual([]);
    expect(synthesis.summary).toMatchObject({
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
    });
  });

  it('truncates over-limit labels at a word boundary, never mid-word', () => {
    const cluster = fixture();
    cluster.label =
      'feat: reconcile the enrichment bundle retargeting pipeline across resumed generation jobs';

    const synthesis = synthesizeSeedCluster({ ...options, cluster });
    expect(synthesis.plan.label.length).toBeLessThanOrEqual(70);
    expect(synthesis.plan.label).toBe(
      'feat: reconcile the enrichment bundle retargeting pipeline across…'
    );
  });

  it('unwraps revert wrappers in step labels and keeps truncated quotes balanced', () => {
    const cluster = fixture();
    const nestedRevert = member(
      'a',
      'Revert "Revert "feat(seed): extend the enrichment bundle retargeting pipeline across resumed generation jobs""',
      'src/a.ts'
    );
    const quoted = member(
      'b',
      'feat: rename the "diff fingerprint manifest overflow disclosure banner" everywhere',
      'src/b.ts'
    );
    cluster.checkpoints[0]!.commits = [nestedRevert];
    cluster.checkpoints[1]!.commits = [quoted];

    const synthesis = synthesizeSeedCluster({ ...options, cluster });
    const [reapplyLabel, quotedLabel] = synthesis.plan.plan_steps.map((step) => step.label);
    expect(reapplyLabel).toMatch(/^reapply: feat\(seed\): extend the enrichment/u);
    expect(reapplyLabel).not.toContain('Revert "');
    // Truncation dropped the quoted span's closing quote, so the dangling
    // opener goes with it.
    expect(quotedLabel).toBe('feat: rename the…');
    for (const label of [reapplyLabel!, quotedLabel!]) {
      expect(label.length).toBeLessThanOrEqual(70);
      expect((label.split('"').length - 1) % 2).toBe(0);
    }
  });

  it('stamps the generating job only when the caller supplies one', () => {
    const jobless = synthesizeSeedCluster(options);
    expect(jobless.plan.origin).not.toHaveProperty('job');

    const stamped = synthesizeSeedCluster({
      ...options,
      job: { job_id: 'job-1', kind: 'commit' },
    });
    expect(stamped.plan.origin?.job).toEqual({ job_id: 'job-1', kind: 'commit' });
    // The job rides on provenance only: ids stay deterministic across runs.
    expect(stamped.artifactId).toBe(jobless.artifactId);
    expect(stamped.checkpoints.map((checkpoint) => checkpoint.stepId)).toEqual(
      jobless.checkpoints.map((checkpoint) => checkpoint.stepId)
    );
  });

  it('hashes the canonical member set independently of commit order', () => {
    const reversed = fixture();
    reversed.commits.reverse();
    const forwardOrigin = synthesizeSeedCluster(options).plan.origin;
    const reversedOrigin = synthesizeSeedCluster({ ...options, cluster: reversed }).plan.origin;
    expect(reversedOrigin?.member_shas_hash).toBe(forwardOrigin?.member_shas_hash);
  });

  it('normalizes git timezone offsets for protocol datetime fields', () => {
    const cluster = fixture();
    for (const commit of cluster.commits) commit.committerDateIso = '2025-01-01T19:04:05-08:00';
    for (const checkpoint of cluster.checkpoints) {
      checkpoint.committerDateIso = '2025-01-01T19:04:05-08:00';
    }
    cluster.displayDateIso = '2025-01-01T19:04:05-08:00';

    const synthesis = synthesizeSeedCluster({ ...options, cluster });
    expect(synthesis.plan.started_at).toBe('2025-01-02T03:04:05.000Z');
    expect(synthesis.summary.ts).toBe('2025-01-02T03:04:05.000Z');
    expect(synthesis.checkpoints.map((checkpoint) => checkpoint.timestamp)).toEqual([
      '2025-01-02T03:04:05.000Z',
      '2025-01-02T03:04:05.000Z',
    ]);
  });
});
