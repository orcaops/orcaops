import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type DetailedCommit,
  EMPTY_TREE_SHA,
  loadSeedHistory,
  Repo,
  type SeedCheckpointGroup,
  type SeedCluster,
} from '@orcaops/core';
import { requireDatabaseExecutionContext } from '@orcaops/core/history/database-capture';
import {
  buildDefaultSkippedFingerprintSummary,
  getDefaultConfig,
  prepareArtifactDraft,
  uuidv7,
} from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  appendProjectArtifactEvents,
  appendProjectImportedArtifact,
  openProjectDatabase,
  readProjectArtifact,
  readProjectExecution,
  readProjectPendingCapture,
} from '@orcaops/storage/history/database';

import { writeDatabaseSeedCluster } from './database-seed-write.js';
import { fixture, git } from '../../tests/helpers/database-history.js';
import { synthesizeSeedCluster } from '../commands/seed/synthesize.js';
import { prepareSeedSnapshots } from '../commands/seed/write.js';

const sha = (seed: string): string => seed.repeat(40).slice(0, 40);

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

/** A two-checkpoint cluster with deterministic member shas. */
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

async function preparedSeedFixture() {
  const f = await fixture();
  await writeFile(path.join(f.main, 'service.ts'), 'export const service = true;\n');
  await git(f.main, ['add', 'service.ts']);
  await git(f.main, ['commit', '-qm', 'feat: establish retained seed history']);
  await writeFile(path.join(f.main, 'health.ts'), 'export const healthy = true;\n');
  await git(f.main, ['add', 'health.ts']);
  await git(f.main, ['commit', '-qm', 'fix: retain seed snapshots']);
  const repo = new Repo(f.main);
  const history = await loadSeedHistory(repo, { sinceIso: '2024-01-01T00:00:00.000Z' });
  const cluster = history.clusters.find((candidate) =>
    candidate.checkpoints.some((checkpoint) => checkpoint.parentSha !== EMPTY_TREE_SHA)
  );
  if (!cluster) throw new Error('Seed fixture did not select a pinnable cluster');
  const synthesis = synthesizeSeedCluster({
    cluster,
    branch: history.branch.ref,
    rootSha: history.firstParentCommits.at(-1)!.sha,
    installNonce: '00112233445566778899aabbccddeeff',
    importedAt: '2026-09-09T00:00:00.000Z',
    toolVersion: 'test',
  });
  const prepared = await prepareSeedSnapshots(repo, [synthesis], {
    fingerprints: true,
    maxDiffBytes: getDefaultConfig().diff_fingerprint.max_diff_bytes,
  });
  const registered = await requireDatabaseExecutionContext({ cwd: f.main, root: f.root });
  return { f, prepared, registered, repo, synthesis };
}

describe('database seed cluster writer', () => {
  it('does not append an imported artifact after cancellation', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      const controller = new AbortController();
      controller.abort();

      await expect(
        writeDatabaseSeedCluster(f.writer, synthesis, {
          operationOptions: { signal: controller.signal },
        })
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(readProjectArtifact(f.writer, synthesis.artifactId)).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  it('refuses snapshot evidence without its exact retained publication', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      const checkpoint = synthesis.checkpoints[0]!;
      const openTree = sha('c');
      const closeTree = sha('d');
      const prepared = new Map([
        [
          `${synthesis.artifactId}:${checkpoint.n}`,
          {
            openBoundary: {
              snapshot_ref: `refs/orcaops/snap/${synthesis.artifactId}/${checkpoint.n}/open`,
              tree_sha: openTree,
              snapshot_commit_sha: checkpoint.group.parentSha,
              snapshot_error_reason: null,
            },
            closeBoundary: {
              snapshot_ref: `refs/orcaops/snap/${synthesis.artifactId}/${checkpoint.n}/close`,
              tree_sha: closeTree,
              snapshot_commit_sha: checkpoint.group.headSha,
              snapshot_error_reason: null,
            },
            fingerprintSummary: buildDefaultSkippedFingerprintSummary(),
            fingerprintManifest: null,
            publications: [],
          },
        ],
      ]);

      await expect(
        writeDatabaseSeedCluster(f.writer, synthesis, { prepared })
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(readProjectArtifact(f.writer, synthesis.artifactId)).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  it('does not admit or publish retained snapshots after cancellation', async () => {
    const { f, prepared, registered, repo, synthesis } = await preparedSeedFixture();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        writeDatabaseSeedCluster(f.writer, synthesis, {
          prepared,
          registered,
          operationOptions: { signal: controller.signal },
        })
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(readProjectArtifact(f.writer, synthesis.artifactId)).toBeNull();
      for (const publication of [...prepared.values()].flatMap((entry) => entry.publications))
        expect(await repo.resolveCommit(publication.fullRef)).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  it('publishes immutable seed refs and leaves an identical replay unchanged', async () => {
    const { f, prepared, registered, repo, synthesis } = await preparedSeedFixture();
    try {
      const publications = [...prepared.values()].flatMap((entry) => entry.publications);
      expect(publications.length).toBeGreaterThan(0);
      for (const publication of publications)
        expect(await repo.resolveCommit(publication.fullRef)).toBeNull();

      const result = await writeDatabaseSeedCluster(f.writer, synthesis, {
        prepared,
        registered,
      });
      expect(result.outcome).toBe('created');
      for (const publication of publications)
        expect(await repo.resolveCommit(publication.fullRef)).toBe(publication.objectOid);
      const retained = readProjectArtifact(f.writer, synthesis.artifactId)!;
      for (const entry of prepared.values()) {
        if (entry.publications.length === 0) continue;
        const checkpointNumber = entry.publications[0]!.checkpointNumber;
        const closed = retained.thread.checkpoints.find(
          (checkpoint) => checkpoint.status === 'closed' && checkpoint.n === checkpointNumber
        );
        if (!closed || closed.status !== 'closed')
          throw new Error(`Seeded checkpoint ${checkpointNumber} did not close`);
        expect(closed.open_snapshot).toEqual(entry.openBoundary);
        expect(closed.close_snapshot).toEqual(entry.closeBoundary);
        expect(closed.diff_fingerprint_summary).toEqual(entry.fingerprintSummary);
        expect(
          retained.thread.events.find(
            (event) =>
              event.record.type === 'checkpoint_closed' &&
              (event.payload as { n?: number }).n === checkpointNumber
          )?.payload
        ).toMatchObject({ diff_fingerprint_manifest: entry.fingerprintManifest });
      }
      const operationId = artifactOperationId(
        synthesis.artifactId,
        synthesis.idempotencyKeys.summary,
        'seed_import_retention'
      );
      const settled = readProjectPendingCapture(f.writer, operationId).value!;
      expect(settled.mode).toBe('import');
      expect(settled.retention.current.kind).toBe('selected');
      const refsBefore = (
        await git(f.main, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          `refs/orcaops/snap/${synthesis.artifactId}`,
        ])
      ).stdout;

      const replay = await writeDatabaseSeedCluster(f.writer, synthesis, {
        prepared: await prepareSeedSnapshots(repo, [synthesis], {
          fingerprints: true,
          maxDiffBytes: getDefaultConfig().diff_fingerprint.max_diff_bytes,
        }),
        registered,
      });
      expect(replay.outcome).toBe('complete');
      expect(readProjectArtifact(f.writer, synthesis.artifactId)!.revision).toEqual(
        retained.revision
      );
      expect(
        await git(f.main, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          `refs/orcaops/snap/${synthesis.artifactId}`,
        ])
      ).toMatchObject({ stdout: refsBefore });
    } finally {
      await f.cleanup();
    }
  });

  it('preserves mismatched refs and resumes the exact admitted seed events', async () => {
    const { f, prepared, registered, repo, synthesis } = await preparedSeedFixture();
    try {
      const publications = [...prepared.values()].flatMap((entry) => entry.publications);
      const mismatched = publications.find((candidate) =>
        publications.some((other) => other.objectOid !== candidate.objectOid)
      );
      if (!mismatched) throw new Error('Seed fixture did not prepare distinct snapshots');
      const wrongOid = publications.find(
        (publication) => publication.objectOid !== mismatched.objectOid
      )!.objectOid;
      for (const publication of publications)
        await git(f.main, ['update-ref', publication.fullRef, publication.objectOid]);
      await git(f.main, ['update-ref', mismatched.fullRef, wrongOid, mismatched.objectOid]);

      await expect(
        writeDatabaseSeedCluster(f.writer, synthesis, { prepared, registered })
      ).rejects.toMatchObject({ code: 'HISTORY_UNEXPECTED_OWNER' });
      expect(await repo.resolveCommit(mismatched.fullRef)).toBe(wrongOid);
      expect(readProjectArtifact(f.writer, synthesis.artifactId)).toBeNull();
      const operationId = artifactOperationId(
        synthesis.artifactId,
        synthesis.idempotencyKeys.summary,
        'seed_import_retention'
      );
      const pending = readProjectPendingCapture(f.writer, operationId).value!;
      expect(pending.mode).toBe('import');
      expect(pending.retention.current.kind).toBe('prepared');
      const admittedEventIds = Buffer.from(pending.capture.eventBytes)
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { event_id: string }).event_id);

      await git(f.main, ['update-ref', mismatched.fullRef, mismatched.objectOid, wrongOid]);
      const resumed = await writeDatabaseSeedCluster(f.writer, synthesis, {
        prepared: await prepareSeedSnapshots(repo, [synthesis], {
          fingerprints: true,
          maxDiffBytes: getDefaultConfig().diff_fingerprint.max_diff_bytes,
        }),
        registered,
      });
      expect(resumed.outcome).toBe('created');
      const retained = readProjectArtifact(f.writer, synthesis.artifactId)!;
      expect(retained.thread.events.map((event) => event.record.event_id)).toEqual(
        admittedEventIds
      );
      for (const publication of publications)
        expect(await repo.resolveCommit(publication.fullRef)).toBe(publication.objectOid);
    } finally {
      await f.cleanup();
    }
  });

  it('writes a git-import thread of plan, N checkpoints and a summary as rows', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      const result = await writeDatabaseSeedCluster(f.writer, synthesis);
      expect(result).toEqual({
        artifactId: synthesis.artifactId,
        outcome: 'created',
        checkpoints: 2,
      });

      const retained = readProjectArtifact(f.writer, synthesis.artifactId);
      expect(retained).not.toBeNull();
      const thread = retained!.thread;
      expect(thread.plan?.origin?.kind).toBe('git-import');
      expect(thread.plan?.label).toBe(synthesis.plan.label);
      expect(thread.checkpoints.filter((cp) => cp.status === 'closed')).toHaveLength(2);
      expect(thread.summary?.head_sha).toBe(sha('b'));
      // The closes carry the cluster's head shas, in order.
      const closes = thread.checkpoints
        .filter((cp) => cp.status === 'closed')
        .sort((a, b) => a.n - b.n);
      expect(closes.map((cp) => cp.head_sha)).toEqual([sha('a'), sha('b')]);

      // A seeded artifact carries an unbound execution record, the same shape an
      // imported artifact gets from importProjectHistory — not null.
      const execution = readProjectExecution(f.writer, synthesis.artifactId);
      expect(execution).not.toBeNull();
      expect(execution!.state.current_binding).toBeNull();
      expect(execution!.state.null_reason).toBe('completed');
      expect(execution!.state.origin_kind).toBe('git-import');

      const reader = new Database(f.writer.databasePath, { readonly: true, fileMustExist: true });
      try {
        const current = reader
          .prepare('SELECT COUNT(*) AS n FROM execution_current WHERE artifact_id = ?')
          .get(synthesis.artifactId) as { n: number };
        const inits = reader
          .prepare('SELECT COUNT(*) AS n FROM execution_initializations WHERE artifact_id = ?')
          .get(synthesis.artifactId) as { n: number };
        const queryMeta = reader
          .prepare('SELECT COUNT(*) AS n FROM execution_query_metadata WHERE artifact_id = ?')
          .get(synthesis.artifactId) as { n: number };
        expect(current.n).toBe(1);
        expect(inits.n).toBe(1);
        expect(queryMeta.n).toBe(1);
      } finally {
        reader.close();
      }
    } finally {
      await f.cleanup();
    }
  });

  it('replays an identical re-write as complete without writing new events', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      await writeDatabaseSeedCluster(f.writer, synthesis);
      const before = readProjectArtifact(f.writer, synthesis.artifactId)!.revision;

      const replay = await writeDatabaseSeedCluster(f.writer, synthesis);
      expect(replay.outcome).toBe('complete');
      // No new events: the retained revision is byte-identical.
      const after = readProjectArtifact(f.writer, synthesis.artifactId)!.revision;
      expect(after).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });

  it('converges on one set of rows with integrity ok when the same cluster is written twice', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      await writeDatabaseSeedCluster(f.writer, synthesis);
      // A second write of the same cluster (the racing-seed case, serialized by
      // the single writer) must add nothing.
      await writeDatabaseSeedCluster(f.writer, synthesis);

      const reader = new Database(f.writer.databasePath, { readonly: true, fileMustExist: true });
      try {
        const integrity = reader.pragma('integrity_check', { simple: true });
        expect(integrity).toBe('ok');
        const events = reader
          .prepare('SELECT event_type FROM artifact_events WHERE artifact_id = ? ORDER BY ordinal')
          .all(synthesis.artifactId) as { event_type: string }[];
        // Exactly one plan, one open + one close per checkpoint, one summary. No duplication.
        const counts = events.reduce<Record<string, number>>((acc, row) => {
          acc[row.event_type] = (acc[row.event_type] ?? 0) + 1;
          return acc;
        }, {});
        expect(counts.plan_captured).toBe(1);
        expect(counts.checkpoint_opened).toBe(2);
        expect(counts.checkpoint_closed).toBe(2);
        expect(counts.summary_captured).toBe(1);
      } finally {
        reader.close();
      }
    } finally {
      await f.cleanup();
    }
  });

  it('resumes a plan-only partial into a whole thread without duplicating the plan', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      // This atomic writer can never leave a plan-only prefix itself (one append
      // settles the whole thread), so the resume branch is exercised defensively by
      // constructing the prefix through a separate append.
      const draft = await prepareArtifactDraft(
        {
          artifactId: synthesis.artifactId,
          priorEvents: [],
          authoredPayload: { seedCluster: synthesis.artifactId },
          secretAllow: [],
          idempotencyBlocks: [],
        },
        (semantics) =>
          semantics.writePlan(synthesis.plan, { idempotencyKey: synthesis.idempotencyKeys.plan })
      );
      await appendProjectArtifactEvents(f.writer, {
        artifactId: synthesis.artifactId,
        operationId: uuidv7(),
        expectedRevision: null,
        eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
        sidecarPayloads: [],
        secretAllow: [],
      });
      const partial = readProjectArtifact(f.writer, synthesis.artifactId)!;
      expect(partial.thread.plan).not.toBeNull();
      expect(partial.thread.summary).toBeNull();
      expect(partial.thread.checkpoints).toHaveLength(0);
      const planEventId = partial.thread.plan!.source_event_id;

      const resumed = await writeDatabaseSeedCluster(f.writer, synthesis);
      expect(resumed).toEqual({
        artifactId: synthesis.artifactId,
        outcome: 'resumed',
        checkpoints: 2,
      });
      const whole = readProjectArtifact(f.writer, synthesis.artifactId)!;
      // The plan was reused, not rewritten: same event id, still revision 0.
      expect(whole.thread.plan!.source_event_id).toBe(planEventId);
      expect(whole.thread.plan!.revision_n).toBe(0);
      expect(whole.thread.checkpoints.filter((cp) => cp.status === 'closed')).toHaveLength(2);
      expect(whole.thread.summary?.head_sha).toBe(sha('b'));
    } finally {
      await f.cleanup();
    }
  });

  it('converges when two writers race to create the same deterministic cluster', async () => {
    const f = await fixture();
    const second = await openProjectDatabase({ authority: f.authority, mode: 'writer' });
    try {
      const synthesis = synthesize();
      // Two writers on two connections, started together: whichever loses the create
      // append sees the winner's revision (STALE_CONTEXT) and converges rather than
      // failing. Either way the database ends with exactly one thread.
      const [a, b] = await Promise.all([
        writeDatabaseSeedCluster(f.writer, synthesis),
        writeDatabaseSeedCluster(second, synthesis),
      ]);
      expect([a.outcome, b.outcome].sort()).toEqual(['complete', 'created']);

      const reader = new Database(f.writer.databasePath, { readonly: true, fileMustExist: true });
      try {
        expect(reader.pragma('integrity_check', { simple: true })).toBe('ok');
        const counts = (
          reader
            .prepare('SELECT event_type FROM artifact_events WHERE artifact_id = ?')
            .all(synthesis.artifactId) as { event_type: string }[]
        ).reduce<Record<string, number>>((acc, row) => {
          acc[row.event_type] = (acc[row.event_type] ?? 0) + 1;
          return acc;
        }, {});
        expect(counts.plan_captured).toBe(1);
        expect(counts.checkpoint_opened).toBe(2);
        expect(counts.checkpoint_closed).toBe(2);
        expect(counts.summary_captured).toBe(1);
      } finally {
        reader.close();
      }
    } finally {
      second.close();
      await f.cleanup();
    }
  });

  it('refuses any changed authored content when converging on a completed import', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      await writeDatabaseSeedCluster(f.writer, synthesis);
      const before = readProjectArtifact(f.writer, synthesis.artifactId)!.revision;
      const changes = [
        (changed: typeof synthesis) => {
          changed.plan.branch = 'changed-branch';
        },
        (changed: typeof synthesis) => {
          changed.plan.decisions = [
            {
              decision: 'Use changed content',
              reason: 'Exercise the exact replay guard',
              revision_n: 0,
            },
          ];
        },
        (changed: typeof synthesis) => {
          changed.plan.origin!.tool_version = 'changed-version';
        },
        (changed: typeof synthesis) => {
          changed.plan.origin!.job = { job_id: 'changed-job', kind: 'resume' };
        },
      ];
      for (const change of changes) {
        const changed = structuredClone(synthesis);
        change(changed);
        await expect(
          writeDatabaseSeedCluster(f.writer, changed, { exactExisting: true })
        ).rejects.toThrow(/differs from the current Git source/u);
      }
      expect(readProjectArtifact(f.writer, synthesis.artifactId)!.revision).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });

  it('refuses a COMPLETE authored artifact at the seed id instead of reporting it complete', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      // An authored capture that completed on this deterministic id (no git-import origin).
      await f.capture(synthesis.artifactId, { reason: 'completed' });
      const before = readProjectArtifact(f.writer, synthesis.artifactId)!;
      expect(before.thread.summary).not.toBeNull();
      expect(before.thread.plan?.origin).toBeUndefined();

      await expect(writeDatabaseSeedCluster(f.writer, synthesis)).rejects.toThrow(
        /belongs to a live capture/u
      );
      // Refused, not converged: the authored artifact is untouched.
      const after = readProjectArtifact(f.writer, synthesis.artifactId)!;
      expect(after.revision).toEqual(before.revision);
    } finally {
      await f.cleanup();
    }
  });

  it('resumes over an incomplete git-import artifact that already carries an execution record', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      // Model a converted incomplete import: plan-only, but WITH an unbound execution
      // record (importProjectHistory settles one; a plain append would not).
      const draft = await prepareArtifactDraft(
        {
          artifactId: synthesis.artifactId,
          priorEvents: [],
          authoredPayload: { seedCluster: synthesis.artifactId },
          secretAllow: [],
          idempotencyBlocks: [],
        },
        (semantics) =>
          semantics.writePlan(synthesis.plan, { idempotencyKey: synthesis.idempotencyKeys.plan })
      );
      await appendProjectImportedArtifact(f.writer, {
        artifactId: synthesis.artifactId,
        operationId: uuidv7(),
        expectedRevision: null,
        eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
        sidecarPayloads: [],
        secretAllow: [],
      });
      const partial = readProjectArtifact(f.writer, synthesis.artifactId)!;
      expect(partial.thread.summary).toBeNull();
      const partialExecution = readProjectExecution(f.writer, synthesis.artifactId);
      expect(partialExecution).not.toBeNull();
      expect(partialExecution!.state.null_reason).toBe('legacy_unknown');

      // The resume advances the retained execution instead of re-initializing it.
      const resumed = await writeDatabaseSeedCluster(f.writer, synthesis);
      expect(resumed.outcome).toBe('resumed');
      const whole = readProjectArtifact(f.writer, synthesis.artifactId)!;
      expect(whole.thread.checkpoints.filter((cp) => cp.status === 'closed')).toHaveLength(2);
      expect(whole.thread.summary?.head_sha).toBe(sha('b'));
      const execution = readProjectExecution(f.writer, synthesis.artifactId);
      expect(execution).not.toBeNull();
      expect(execution!.state.origin_kind).toBe('git-import');
    } finally {
      await f.cleanup();
    }
  });

  it('refuses a deterministic id that already belongs to a live capture', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      // A live (authored) capture minted at the same id.
      await f.capture(synthesis.artifactId);
      const before = readProjectArtifact(f.writer, synthesis.artifactId)!.revision;
      await expect(writeDatabaseSeedCluster(f.writer, synthesis)).rejects.toThrow(
        /belongs to a live capture/u
      );
      // The refusal precedes any write: the authored artifact is untouched.
      const after = readProjectArtifact(f.writer, synthesis.artifactId)!.revision;
      expect(after).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });

  it('salts the retry keys for an abandoned position and replays the rest byte-identically', async () => {
    const f = await fixture();
    try {
      const synthesis = synthesize();
      const firstStep = synthesis.plan.plan_steps[0]!.step_id;
      // A prior run left the first position abandoned (its open key can never close).
      const draft = await prepareArtifactDraft(
        {
          artifactId: synthesis.artifactId,
          priorEvents: [],
          authoredPayload: { seedCluster: synthesis.artifactId },
          secretAllow: [],
          idempotencyBlocks: [],
        },
        async (semantics) => {
          const written = await semantics.writePlan(synthesis.plan, {
            idempotencyKey: synthesis.idempotencyKeys.plan,
          });
          const opened = await semantics.writeCheckpointOpened(
            {
              artifact_id: synthesis.artifactId,
              declared_step_ids: [firstStep],
              policy_exceptions: [],
              plan_revision_id: written.event_id,
            },
            {
              headSha: sha('a'),
              openedAt: synthesis.checkpoints[0]!.timestamp,
              idempotencyKey: synthesis.checkpoints[0]!.idempotencyKeys.open,
              invokedByAgent: 'other',
            }
          );
          if (!('checkpoint' in opened)) throw new Error('fixture open did not admit a checkpoint');
          await semantics.writeCheckpointAbandoned(
            { artifact_id: synthesis.artifactId, n: opened.checkpoint.n, reason: 'interrupted' },
            { idempotencyKey: uuidv7() }
          );
        }
      );
      await appendProjectArtifactEvents(f.writer, {
        artifactId: synthesis.artifactId,
        operationId: uuidv7(),
        expectedRevision: null,
        eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
        sidecarPayloads: [],
        secretAllow: [],
      });
      const abandoned = readProjectArtifact(f.writer, synthesis.artifactId)!;
      expect(abandoned.thread.checkpoints.filter((cp) => cp.status === 'abandoned')).toHaveLength(
        1
      );

      // The writer resumes: the abandoned position's open key is salted (#retry1) so it
      // mints a fresh checkpoint rather than replaying onto the un-closable abandoned one.
      const result = await writeDatabaseSeedCluster(f.writer, synthesis);
      expect(result.outcome).toBe('resumed');
      const whole = readProjectArtifact(f.writer, synthesis.artifactId)!;
      expect(whole.thread.checkpoints.filter((cp) => cp.status === 'closed')).toHaveLength(2);
      expect(whole.thread.checkpoints.filter((cp) => cp.status === 'abandoned')).toHaveLength(1);
      expect(whole.thread.summary?.head_sha).toBe(sha('b'));
    } finally {
      await f.cleanup();
    }
  });
});
