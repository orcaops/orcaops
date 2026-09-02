import { readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { loadSeedHistory, Repo } from '@orcaops/core';
import { artifactPathsFor, ArtifactStore, getDefaultConfig, readEventLog } from '@orcaops/storage';
import { createHistoryRepo } from '@orcaops/test-harness';

import { synthesizeSeedCluster } from './synthesize.js';
import { prepareSeedSnapshots, writeSeedCluster } from './write.js';

describe('writeSeedCluster', () => {
  it('writes summarized imported artifacts idempotently with real tree fingerprints', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', subject: 'feat: root', files: { 'src/root.ts': 'root\n' } },
      {
        type: 'commit',
        label: 'next',
        subject: 'fix: next',
        files: { 'src/next.ts': 'next\n' },
      },
    ]);
    const config = getDefaultConfig();
    const store = new ArtifactStore({ repoRoot: history.path, config });
    try {
      const repo = new Repo(history.path);
      const loaded = await loadSeedHistory(repo, { sinceIso: '2024-01-01T00:00:00.000Z' });
      const synthesis = synthesizeSeedCluster({
        cluster: loaded.clusters[0]!,
        branch: loaded.branch.ref,
        rootSha: history.shas.root!,
        installNonce: '00112233445566778899aabbccddeeff',
        importedAt: '2026-01-01T00:00:00.000Z',
        toolVersion: '0.0.5',
      });

      const pinRefs = vi.spyOn(repo, 'updateRefsBatch');
      const prepared = await prepareSeedSnapshots(repo, [synthesis], {
        fingerprints: true,
        maxDiffBytes: config.diff_fingerprint.max_diff_bytes,
      });
      expect(pinRefs).toHaveBeenCalledTimes(1);
      const artifactLocks = vi.spyOn(store.lock, 'withLock');
      const first = await writeSeedCluster({ repo, store, config }, synthesis, { prepared });
      expect(first).toMatchObject({ outcome: 'created', checkpoints: 2 });
      expect(artifactLocks).toHaveBeenCalledTimes(1);
      expect((await store.readPlan(synthesis.artifactId))?.origin?.kind).toBe('git-import');
      expect(await store.readSummary(synthesis.artifactId)).toMatchObject({
        head_sha: synthesis.cluster.headSha,
      });
      const checkpoints = (await store.readCheckpoints(synthesis.artifactId)).filter(
        (checkpoint) => checkpoint.status === 'closed'
      );
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints.every((checkpoint) => checkpoint.opened_at === checkpoint.closed_at)).toBe(
        true
      );
      expect(checkpoints.every((checkpoint) => !('window_overlap' in checkpoint))).toBe(true);
      expect(checkpoints.every((checkpoint) => !('verification' in checkpoint))).toBe(true);
      expect(checkpoints[0]?.diff_fingerprint_summary.status).toBe('skipped');
      expect(checkpoints[0]?.open_snapshot).toMatchObject({
        snapshot_ref: null,
        tree_sha: null,
        snapshot_commit_sha: null,
        snapshot_error_reason: null,
      });
      expect(checkpoints[1]?.diff_fingerprint_summary.status).toBe('captured');
      const imported = synthesis.checkpoints[1]!;
      const openRef = `refs/orcaops/snap/${synthesis.artifactId}/${imported.n}/open`;
      const closeRef = `refs/orcaops/snap/${synthesis.artifactId}/${imported.n}/close`;
      expect(checkpoints[1]?.open_snapshot).toMatchObject({
        snapshot_ref: openRef,
        snapshot_commit_sha: imported.group.parentSha,
        snapshot_error_reason: null,
      });
      expect(checkpoints[1]?.close_snapshot).toMatchObject({
        snapshot_ref: closeRef,
        snapshot_commit_sha: imported.group.headSha,
        snapshot_error_reason: null,
      });
      expect(await repo.resolveCommit(openRef)).toBe(imported.group.parentSha);
      expect(await repo.resolveCommit(closeRef)).toBe(imported.group.headSha);
      expect(checkpoints[1]?.open_snapshot.tree_sha).toBe(
        await repo.resolveTree(imported.group.parentSha)
      );
      expect(checkpoints[1]?.close_snapshot.tree_sha).toBe(
        await repo.resolveTree(imported.group.headSha)
      );

      const paths = artifactPathsFor(history.path, config, synthesis.artifactId);
      const before = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      const replay = await writeSeedCluster({ repo, store, config }, synthesis, { prepared });
      const after = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(replay.outcome).toBe('complete');
      expect(after.events).toHaveLength(before.events.length);
    } finally {
      store.close();
      await history.cleanup();
    }
  });

  it('resumes a dangling checkpoint without duplicating the plan or open event', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', files: { 'root.txt': 'root\n' } },
    ]);
    const config = getDefaultConfig();
    const store = new ArtifactStore({ repoRoot: history.path, config });
    try {
      const repo = new Repo(history.path);
      const loaded = await loadSeedHistory(repo, { sinceIso: '2024-01-01T00:00:00.000Z' });
      const synthesis = synthesizeSeedCluster({
        cluster: loaded.clusters[0]!,
        branch: loaded.branch.ref,
        rootSha: history.shas.root!,
        installNonce: 'ffeeddccbbaa99887766554433221100',
        importedAt: '2026-01-01T00:00:00.000Z',
        toolVersion: '0.0.5',
      });
      const plan = await store.writePlan(synthesis.plan, {
        idempotencyKey: synthesis.idempotencyKeys.plan,
      });
      const prepared = await prepareSeedSnapshots(repo, [synthesis], {
        fingerprints: true,
        maxDiffBytes: config.diff_fingerprint.max_diff_bytes,
      });
      const checkpoint = synthesis.checkpoints[0]!;
      await store.writeCheckpointOpened(
        {
          artifact_id: synthesis.artifactId,
          declared_step_ids: [checkpoint.stepId],
          policy_exceptions: [],
          plan_revision_id: plan.event_id,
        },
        {
          headSha: checkpoint.group.parentSha,
          openedAt: checkpoint.timestamp,
          idempotencyKey: checkpoint.idempotencyKeys.open,
          invokedByAgent: 'other',
          snapshotCallbacks: {
            captureOpenSnapshot: async () => ({
              boundary: prepared.get(`${synthesis.artifactId}:${checkpoint.n}`)!.openBoundary,
            }),
          },
        }
      );

      expect(
        await writeSeedCluster({ repo, store, config }, synthesis, { prepared })
      ).toMatchObject({ outcome: 'resumed' });
      const paths = artifactPathsFor(history.path, config, synthesis.artifactId);
      const events = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(events.events.filter((event) => event.type === 'plan_captured')).toHaveLength(1);
      expect(events.events.filter((event) => event.type === 'checkpoint_opened')).toHaveLength(1);
      expect(events.events.filter((event) => event.type === 'checkpoint_closed')).toHaveLength(1);
      expect(events.events.filter((event) => event.type === 'summary_captured')).toHaveLength(1);
    } finally {
      store.close();
      await history.cleanup();
    }
  });

  it('re-imports a cluster whose stranded checkpoint was abandoned', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', files: { 'root.txt': 'root\n' } },
    ]);
    const config = getDefaultConfig();
    const store = new ArtifactStore({ repoRoot: history.path, config });
    try {
      const repo = new Repo(history.path);
      const loaded = await loadSeedHistory(repo, { sinceIso: '2024-01-01T00:00:00.000Z' });
      const synthesis = synthesizeSeedCluster({
        cluster: loaded.clusters[0]!,
        branch: loaded.branch.ref,
        rootSha: history.shas.root!,
        installNonce: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
        importedAt: '2026-01-01T00:00:00.000Z',
        toolVersion: '0.0.5',
      });
      const plan = await store.writePlan(synthesis.plan, {
        idempotencyKey: synthesis.idempotencyKeys.plan,
      });
      const prepared = await prepareSeedSnapshots(repo, [synthesis], {
        fingerprints: true,
        maxDiffBytes: config.diff_fingerprint.max_diff_bytes,
      });
      const checkpoint = synthesis.checkpoints[0]!;
      const opened = await store.writeCheckpointOpened(
        {
          artifact_id: synthesis.artifactId,
          declared_step_ids: [checkpoint.stepId],
          policy_exceptions: [],
          plan_revision_id: plan.event_id,
        },
        {
          headSha: checkpoint.group.parentSha,
          openedAt: checkpoint.timestamp,
          idempotencyKey: checkpoint.idempotencyKeys.open,
          invokedByAgent: 'other',
        }
      );
      expect(opened.outcome).toBe('created');
      await store.writeCheckpointAbandoned(
        { artifact_id: synthesis.artifactId, n: 1, reason: 'operator cleared the wedged run' },
        { idempotencyKey: 'test:abandon:1' }
      );

      expect(
        await writeSeedCluster({ repo, store, config }, synthesis, { prepared })
      ).toMatchObject({ outcome: 'resumed', checkpoints: 1 });
      const checkpoints = await store.readCheckpoints(synthesis.artifactId);
      expect(checkpoints.filter((entry) => entry.status === 'abandoned')).toHaveLength(1);
      expect(checkpoints.filter((entry) => entry.status === 'closed')).toMatchObject([
        { head_sha: checkpoint.group.headSha },
      ]);
      expect(await store.readSummary(synthesis.artifactId)).toMatchObject({
        head_sha: synthesis.cluster.headSha,
      });
    } finally {
      store.close();
      await history.cleanup();
    }
  });

  it('writes the all-skipped triple when batched diff preparation fails', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', files: { 'root.txt': 'root\n' } },
      { type: 'commit', label: 'next', files: { 'next.txt': 'next\n' } },
    ]);
    const config = getDefaultConfig();
    const store = new ArtifactStore({ repoRoot: history.path, config });
    try {
      const repo = new Repo(history.path);
      const loaded = await loadSeedHistory(repo, { sinceIso: '2024-01-01T00:00:00.000Z' });
      const synthesis = synthesizeSeedCluster({
        cluster: loaded.clusters[0]!,
        branch: loaded.branch.ref,
        rootSha: history.shas.root!,
        installNonce: 'abcdefabcdefabcdefabcdefabcdefab',
        importedAt: '2026-01-01T00:00:00.000Z',
        toolVersion: '0.0.5',
      });
      vi.spyOn(repo, 'diffCommitPairs').mockRejectedValue(new Error('diff failed'));
      const prepared = await prepareSeedSnapshots(repo, [synthesis], {
        fingerprints: true,
        maxDiffBytes: config.diff_fingerprint.max_diff_bytes,
      });

      await writeSeedCluster({ repo, store, config }, synthesis, { prepared });
      const checkpoints = (await store.readCheckpoints(synthesis.artifactId)).filter(
        (checkpoint) => checkpoint.status === 'closed'
      );
      for (const checkpoint of checkpoints) {
        expect(checkpoint.open_snapshot).toEqual({
          snapshot_ref: null,
          tree_sha: null,
          snapshot_commit_sha: null,
          snapshot_error_reason: null,
        });
        expect(checkpoint.close_snapshot).toEqual(checkpoint.open_snapshot);
        expect(checkpoint.diff_fingerprint_summary).toMatchObject({
          status: 'skipped',
          manifest_hash: null,
          error_reason: null,
        });
      }
    } finally {
      store.close();
      await history.cleanup();
    }
  });
  it('re-imports a cluster whose summary event landed but whose projections did not', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', subject: 'feat: root', files: { 'src/root.ts': 'root\n' } },
      { type: 'commit', label: 'next', subject: 'fix: next', files: { 'src/next.ts': 'next\n' } },
    ]);
    const config = getDefaultConfig();
    const store = new ArtifactStore({ repoRoot: history.path, config });
    try {
      const repo = new Repo(history.path);
      const loaded = await loadSeedHistory(repo, { sinceIso: '2024-01-01T00:00:00.000Z' });
      const synthesis = synthesizeSeedCluster({
        cluster: loaded.clusters[0]!,
        branch: loaded.branch.ref,
        rootSha: history.shas.root!,
        installNonce: '00112233445566778899aabbccddeeff',
        importedAt: '2026-01-01T00:00:00.000Z',
        toolVersion: '0.0.5',
      });
      const prepared = await prepareSeedSnapshots(repo, [synthesis], {
        fingerprints: true,
        maxDiffBytes: config.diff_fingerprint.max_diff_bytes,
      });
      const ctx = { repo, store, config };
      expect(await writeSeedCluster(ctx, synthesis, { prepared })).toMatchObject({
        outcome: 'created',
      });

      // Reproduce a kill -9 between the durable summary_captured append and the
      // projection + cache writes. Deterministic: the projections are pure
      // functions of the log prefix, so this is the same state the crash left.
      const paths = artifactPathsFor(history.path, config, synthesis.artifactId);
      await rm(paths.summaryJson);
      await rm(paths.summaryMd);
      const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      artifactJson.state = 'active';
      await writeFile(paths.artifactJson, JSON.stringify(artifactJson, null, 2) + '\n');
      store.store.db
        .prepare('DELETE FROM summaries WHERE artifact_id = ?')
        .run(synthesis.artifactId);
      store.store.db
        .prepare("UPDATE artifacts SET status = 'active', completed_at = NULL WHERE id = ?")
        .run(synthesis.artifactId);
      expect(store.store.getSummary(synthesis.artifactId)).toBeNull();

      // Before the fix this threw `canonicalJson: undefined is not
      // representable at <root>` and every later run repeated it forever.
      const healed = await writeSeedCluster(ctx, synthesis, { prepared });
      expect(healed.outcome).toBe('resumed');
      expect(store.store.getSummary(synthesis.artifactId)).not.toBeNull();
      expect(JSON.parse(await readFile(paths.artifactJson, 'utf8')).state).toBe('summarized');
      expect(await store.readSummary(synthesis.artifactId)).toMatchObject({
        head_sha: synthesis.cluster.headSha,
      });

      // Healed once and for all, not merely non-fatal: the log still carries a
      // single summary_captured, so nothing was appended to paper over it.
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(log.events.filter((e) => e.type === 'summary_captured')).toHaveLength(1);
    } finally {
      store.close();
      await history.cleanup();
    }
  });
});
