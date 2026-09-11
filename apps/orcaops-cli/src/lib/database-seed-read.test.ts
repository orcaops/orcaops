import { describe, expect, it } from 'vitest';

import type { DetailedCommit, SeedCheckpointGroup, SeedCluster } from '@orcaops/core';
import { uuidv7 } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';

import {
  collectDatabaseCoveredShas,
  inspectDatabaseOpenCheckpointGuard,
} from './database-seed-read.js';
import { writeDatabaseSeedCluster } from './database-seed-write.js';
import { fixture } from '../../tests/helpers/database-history.js';
import { synthesizeSeedCluster } from '../commands/seed/synthesize.js';

const sha = (seed: string): string => seed.repeat(40).slice(0, 40);

// A repo stub so coverage collection is tested without a real git ancestry: no
// range expansion, so `covered` is exactly the direct closed/summary head SHAs.
const noExpansion = {
  isAncestor: async () => false,
  getCommitsBetweenStrict: async () => [],
};

function commit(seed: string, files: string[], date: string): DetailedCommit {
  return {
    sha: sha(seed),
    parentShas: [sha('0')],
    authorEmail: 'dev@example.test',
    committerDateIso: date,
    subject: `Do ${seed}`,
    body: '',
    files,
  };
}
function group(seed: string, parent: string, files: string[], date: string): SeedCheckpointGroup {
  return {
    key: `grp-${seed}`,
    commits: [commit(seed, files, date)],
    parentSha: sha(parent),
    headSha: sha(seed),
    files,
    committerDateIso: date,
  };
}
function cluster(): SeedCluster {
  const g1 = group('a', '0', ['src/a.ts'], '2026-01-01T00:00:00.000Z');
  const g2 = group('b', 'a', ['src/b.ts'], '2026-01-02T00:00:00.000Z');
  return {
    key: 'cluster-ab',
    kind: 'run',
    label: 'Build the thing',
    baseSha: sha('0'),
    headSha: sha('b'),
    commits: [...g1.commits, ...g2.commits],
    checkpoints: [g1, g2],
    authors: ['dev@example.test'],
    files: ['src/a.ts', 'src/b.ts'],
    firstParentPosition: 0,
    displayDateIso: '2026-01-02T00:00:00.000Z',
    latestCommitDateIso: '2026-01-02T00:00:00.000Z',
    conventionalType: null,
    conventionalScope: null,
    warnings: [],
  };
}
function synthesize() {
  return synthesizeSeedCluster({
    cluster: cluster(),
    branch: 'main',
    rootSha: sha('r'),
    installNonce: 'nonce-0123456789abcdef0123456789abcdef',
    importedAt: '2026-01-03T00:00:00.000Z',
    toolVersion: 'test',
  });
}

describe('database seed coverage scan', () => {
  it('collects closed checkpoint and summary head SHAs from the project database', async () => {
    const f = await fixture();
    try {
      await writeDatabaseSeedCluster(f.writer, synthesize());
      const covered = await collectDatabaseCoveredShas(f.writer, noExpansion);
      expect(covered.has(sha('a'))).toBe(true);
      expect(covered.has(sha('b'))).toBe(true);
      // An unrelated sha the history never closed is not covered.
      expect(covered.has(sha('z'))).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it('is empty for a project whose only artifact is a plan with no closed work', async () => {
    const f = await fixture();
    try {
      await f.capture();
      const covered = await collectDatabaseCoveredShas(f.writer, noExpansion);
      expect(covered.size).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
});

describe('database seed open-checkpoint guard', () => {
  it('blocks on a foreign open checkpoint and names it', async () => {
    const f = await fixture();
    try {
      const id = await f.capture();
      const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
      await f.mutate(id, { open: true }, (semantics) =>
        semantics.writeCheckpointOpened(
          { artifact_id: id, declared_step_ids: [plan.plan_steps[0]!.step_id] },
          { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
        )
      );
      const guard = inspectDatabaseOpenCheckpointGuard(f.writer);
      expect(guard.blocked).toBe(true);
      expect(guard.message).toContain(id);
      expect(guard.stranded).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });

  it('treats a git-import open checkpoint as stranded recovery, not a block', async () => {
    const f = await fixture();
    try {
      const id = await f.capture(uuidv7(), { reason: 'imported' });
      const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
      await f.mutate(id, { open: true }, (semantics) =>
        semantics.writeCheckpointOpened(
          { artifact_id: id, declared_step_ids: [plan.plan_steps[0]!.step_id] },
          { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
        )
      );
      const guard = inspectDatabaseOpenCheckpointGuard(f.writer);
      expect(guard.blocked).toBe(false);
      expect(guard.stranded.map((entry) => entry.artifact_id)).toEqual([id]);
      expect(guard.recovery_message).toContain(id);
    } finally {
      await f.cleanup();
    }
  });

  it('reports no open checkpoints on a clean project', async () => {
    const f = await fixture();
    try {
      await f.capture();
      const guard = inspectDatabaseOpenCheckpointGuard(f.writer);
      expect(guard.blocked).toBe(false);
      expect(guard.open_checkpoints).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });
});
