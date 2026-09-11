import { describe, expect, it, vi } from 'vitest';

import { loadSeedHistory, Repo } from '@orcaops/core';
import { getDefaultConfig } from '@orcaops/storage';
import { createHistoryRepo } from '@orcaops/test-harness';

import { synthesizeSeedCluster } from './synthesize.js';
import { prepareSeedSnapshots } from './write.js';

async function fixture() {
  const history = await createHistoryRepo([
    { type: 'commit', label: 'root', subject: 'feat: root', files: { 'src/root.ts': 'root\n' } },
    { type: 'commit', label: 'next', subject: 'fix: next', files: { 'src/next.ts': 'next\n' } },
  ]);
  const repo = new Repo(history.path);
  const loaded = await loadSeedHistory(repo, { sinceIso: '2024-01-01T00:00:00.000Z' });
  const synthesis = synthesizeSeedCluster({
    cluster: loaded.clusters[0]!,
    branch: loaded.branch.ref,
    rootSha: history.shas.root!,
    installNonce: '00112233445566778899aabbccddeeff',
    importedAt: '2026-01-01T00:00:00.000Z',
    toolVersion: 'test',
  });
  return { history, repo, synthesis };
}

const options = {
  fingerprints: true,
  maxDiffBytes: getDefaultConfig().diff_fingerprint.max_diff_bytes,
};

describe('seed snapshot preparation', () => {
  it('prepares repeatable fingerprint publications without creating refs', async () => {
    const { history, repo, synthesis } = await fixture();
    try {
      const prepared = await prepareSeedSnapshots(repo, [synthesis], options);
      expect([...prepared.values()].map((entry) => entry.fingerprintSummary.status)).toEqual([
        'skipped',
        'captured',
      ]);
      const captured = [...prepared.values()][1]!;
      expect(captured.publications).toHaveLength(2);
      for (const boundary of [captured.openBoundary, captured.closeBoundary]) {
        expect(boundary.snapshot_ref).toMatch(
          new RegExp(
            `^refs/orcaops/snap/${synthesis.artifactId}/2/(?:open|close)-[0-9a-f-]{36}$`,
            'u'
          )
        );
        expect(await repo.resolveCommit(boundary.snapshot_ref!)).toBeNull();
      }
      expect(await prepareSeedSnapshots(repo, [synthesis], options)).toEqual(prepared);
    } finally {
      await history.cleanup();
    }
  });

  it.each(['resolveTreesBatch', 'diffCommitPairs'] as const)(
    'reports skipped evidence when %s fails',
    async (method) => {
      const { history, repo, synthesis } = await fixture();
      try {
        vi.spyOn(repo, method).mockRejectedValue(new Error('Git preparation failed'));
        const prepared = await prepareSeedSnapshots(repo, [synthesis], options);
        for (const checkpoint of prepared.values()) {
          expect(checkpoint.openBoundary).toEqual({
            snapshot_ref: null,
            tree_sha: null,
            snapshot_commit_sha: null,
            snapshot_error_reason: null,
          });
          expect(checkpoint.closeBoundary).toEqual(checkpoint.openBoundary);
          expect(checkpoint.fingerprintSummary).toMatchObject({
            status: 'skipped',
            manifest_hash: null,
            error_reason: null,
          });
          expect(checkpoint.fingerprintManifest).toBeNull();
          expect(checkpoint.publications).toEqual([]);
        }
      } finally {
        await history.cleanup();
      }
    }
  );
});
