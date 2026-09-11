import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile as writeFixtureFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { buildDiffFingerprintManifest } from '@orcaops/core';
import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import {
  COMMENT_AUTHOR,
  COMMENT_STATUS,
  commentEventSchema,
  contextLineHash,
  type Floor,
  type JournalEvent,
  lineHash,
  reviewedRowsDigest,
} from '@orcaops/review-core';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  canonicalJson,
  type DoneCriterion,
  uuidv7,
} from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import { normalizeHistoryRoot } from '../../../storage/dist/history/paths.js';
import { retainSemanticFixture } from '../../tests/semantic-database-fixture.js';
import { exerciseMissingSemanticHistory } from '../../tests/semantic-missing-history-controls.js';
import { exerciseSemanticPublication } from '../../tests/semantic-publication-controls.js';
import { type AccountProjection, type ForensicInput } from '../dossier.js';
import { commitTree } from '../git.js';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
} from '../reviewTargets.js';
import { buildAccountPromptAliases, freshSliceRunState } from '../twolaneSlice.js';
import { appendDatabaseReviewCommentEvents } from './comment-events.js';
import {
  decodeReviewCommentLinks,
  listDatabaseReviewCommentLinks,
  readDatabaseReviewCommentLink,
  snapshotReviewCommentLinks,
} from './comment-link-read.js';
import { resolveReviewCommentLink } from './comment-link-targets.js';
import { linkDatabaseReviewComment } from './comment-links.js';
import { prepareDatabaseReviewComment } from './comment-preparation.js';
import {
  hydrateReviewComments,
  listDatabaseReviewComments,
  snapshotReviewComments,
} from './comment-read.js';
import { createDatabaseReviewComment, readDatabaseReviewComment } from './comments.js';
import {
  prepareDatabaseReviewFloor,
  readDatabaseReviewArtifacts,
  requirePreparedFloor,
} from './floor-preparation.js';
import { publishDatabaseReviewFloor, readDatabaseReviewFloor } from './floors.js';
import { readDatabaseReviewContext } from './read-context.js';
import {
  changeDatabaseReviewBase,
  changeDatabaseReviewMembership,
  createDatabaseReview,
} from './reviews.js';
import { readDatabaseReviewAttempts } from './run-attempt-read.js';
import { prepareDatabaseReviewAttempt, publishDatabaseReviewAttempt } from './run-attempts.js';
import { readDatabaseReviewFinalization } from './run-finalization-read.js';
import { publishDatabaseReviewFinalization } from './run-finalization.js';
import {
  defaultRunInputPolicy,
  prepareDatabaseReviewRunInputs,
  requirePreparedRunInputs,
} from './run-inputs.js';
import { readDatabaseReviewRun } from './run-read.js';
import { startDatabaseReviewRun } from './runs.js';
import { prepareDatabaseSemanticGeneration } from './semantic-preparation.js';
import { publishDatabaseSemanticGeneration } from './semantic-publish.js';
import { readDatabaseSemanticGeneration } from './semantic-read.js';
import { prepareDatabaseReviewFinalization } from './story-preparation.js';
import { workflowTarget } from './workflow-events.js';
import { readDatabaseReviewWorkflow } from './workflow-read.js';
import { appendDatabaseReviewWorkflowEvents } from './workflow.js';

// These integration tests publish durable Git and database evidence on real disk.
vi.setConfig({ testTimeout: 15_000 });

vi.mock('@orcaops/storage/history/database', async (importOriginal) => {
  const actual = await importOriginal<typeof store>();
  return {
    ...actual,
    openProjectDatabase: vi.fn(actual.openProjectDatabase),
    publishProjectEvidence: vi.fn(actual.publishProjectEvidence),
    readProjectArtifact: vi.fn(actual.readProjectArtifact),
    readProjectEvidence: vi.fn(actual.readProjectEvidence),
  };
});
vi.mock('../git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git.js')>();
  return { ...actual, commitTree: vi.fn(actual.commitTree) };
});
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
async function git(root: string, args: string[]) {
  return (
    await exec('git', args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    })
  ).stdout.trim();
}
async function fixture(content = 'const value = 2;\n', registered = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'database-floor-'));
  roots.push(root);
  const gitRoot = path.join(root, 'repo');
  await mkdir(gitRoot);
  await git(gitRoot, ['init', '--quiet']);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(gitRoot, 'value.ts'), 'const value = 1;\n');
  await git(gitRoot, ['add', 'value.ts']);
  await git(gitRoot, ['commit', '--quiet', '-m', 'Retained base']);
  const baseSha = await git(gitRoot, ['rev-parse', 'HEAD']);
  await writeFile(path.join(gitRoot, 'value.ts'), content);
  await git(gitRoot, ['add', 'value.ts']);
  const pinnedTreeSha = await git(gitRoot, ['write-tree']);
  let authority = {
    ...(await normalizeHistoryRoot({ root: path.join(root, 'history') })),
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  if (registered)
    authority = (
      await setupProjectDatabase({
        cwd: gitRoot,
        root: authority.resolvedRoot,
        authoredPayloads: [],
        secretAllow: [],
      })
    ).initialization.authority;
  else {
    await mkdir(path.dirname(store.projectDatabasePath(authority)), { recursive: true });
    (
      await store.initializeProjectDatabase({
        authority,
        initializationOperationId: uuidv7(),
        initializedAt: new Date().toISOString(),
        authorize() {},
      })
    ).close();
  }
  const reviewId = uuidv7();
  const membershipRevisionId = uuidv7();
  const operationId = uuidv7();
  await createDatabaseReview({
    authority,
    operationId,
    secretAllow: [],
    identityBytes: bytes({
      schema_version: 1,
      review_id: reviewId,
      project_id: authority.projectId,
      store_instance_id: authority.storeInstanceId,
      repository_instance_id: null,
      created_by_operation: operationId,
      initial_context: { worktree_id: null, branch: 'topic', base_sha: null, head_sha: null },
      artifact_ids: [],
      legacy_source_ids: [],
    }),
    membershipBytes: bytes({ revisionId: membershipRevisionId, members: [], source: null }),
  });
  const input = {
    authority,
    reviewId,
    expected: {
      membershipRevisionId,
      membershipVersion: 1,
      baseRevisionId: null,
      baseVersion: 0,
      floorVersion: 0,
    },
    basis: {
      gitRoot,
      baseSha,
      pinnedTreeSha,
      worktreeHead: baseSha,
      defaultBranch: null,
      fingerprintMaxDiffBytes: 100000,
      reviewMaxDiffBytes: 100000,
      reviewIncludedUntracked: [],
    },
    generatedAt: '2026-06-01T00:00:00.000Z',
    secretAllow: [],
  };
  vi.clearAllMocks();
  return { input, root };
}

it('assembles exact Git diff and floor bytes through the existing assembler', async () => {
  const f = await fixture();
  const prepared = await prepareDatabaseReviewFloor(f.input);
  const floor = JSON.parse(prepared.floorBytes.toString('utf8'));
  expect(floor.scope.base_sha).toBe(f.input.basis.baseSha);
  expect(floor.scope.pinned_tree_sha).toBe(f.input.basis.pinnedTreeSha);
  expect(floor.coverage.items).toHaveLength(1);
  expect(prepared.diffBytes.toString('utf8')).toContain('+const value = 2;');
  expect(() => requirePreparedFloor(prepared, prepared)).not.toThrow();
  expect(() =>
    requirePreparedFloor(
      { ...prepared, floorBytes: bytes({ ...floor, input_hash: 'forged' }) },
      prepared
    )
  ).toThrow(/assembled inputs/);
  expect(() =>
    requirePreparedFloor({ ...prepared, diffBytes: Buffer.from('different') }, prepared)
  ).toThrow(/assembled inputs/);
  const again = await prepareDatabaseReviewFloor(f.input);
  expect(again.floorBytes).toEqual(prepared.floorBytes);
  expect(again.diffBytes).toEqual(prepared.diffBytes);
  expect(again.counters).toEqual(prepared.counters);
});

it('refuses derived Git content before synthesized lineage objects', async () => {
  const secret = 'ghp_' + 'A'.repeat(36);
  const f = await fixture(`const value = "${secret}";\n`);
  await expect(prepareDatabaseReviewFloor(f.input)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(commitTree).not.toHaveBeenCalled();
});

it('rejects an old base selection and a resolved object different from the retained explicit base', async () => {
  const f = await fixture(undefined, true);
  const baseRevisionId = uuidv7();
  await changeDatabaseReviewBase({
    gitRoot: f.input.basis.gitRoot,
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    revisionId: baseRevisionId,
    expectedVersion: 0,
    baseBytes: bytes({
      kind: 'explicit',
      ref: 'HEAD',
      oid: f.input.basis.baseSha,
      recordedAt: f.input.generatedAt,
      source: null,
    }),
    secretAllow: [],
  });
  await expect(prepareDatabaseReviewFloor(f.input)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const selected = {
    ...f.input,
    expected: { ...f.input.expected, baseRevisionId, baseVersion: 1 },
  };
  const prepared = await prepareDatabaseReviewFloor(selected);
  expect(prepared.expected.baseRevisionId).toBe(baseRevisionId);
  await expect(
    prepareDatabaseReviewFloor({
      ...selected,
      basis: { ...selected.basis, baseSha: selected.basis.pinnedTreeSha },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

it('retains fixed preparation inputs when Git HEAD advances', async () => {
  const f = await fixture();
  const before = await prepareDatabaseReviewFloor(f.input);
  await git(f.input.basis.gitRoot, ['commit', '--quiet', '-m', 'Later HEAD']);
  const after = await prepareDatabaseReviewFloor(f.input);
  expect(after.floorBytes).toEqual(before.floorBytes);
  expect(after.diffBytes).toEqual(before.diffBytes);
  expect(await readFile(path.join(f.input.basis.gitRoot, 'value.ts'), 'utf8')).toContain('2');
});

async function retainedCheckpointFixture(
  overlapping = false,
  doneCriteria: DoneCriterion[] = [],
  sidecarClose = false
) {
  const f = await fixture();
  const saved = JSON.parse(
    await readFile(
      new URL(
        '../../../storage/src/history/database/fixtures/artifact-events.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as {
    rows: {
      artifacts: { artifact_id: string }[];
      artifact_events: {
        artifact_id: string;
        ordinal: number;
        event_id: string;
        record_bytes: { blobHex: string };
        sidecar_payload_bytes: { blobHex: string } | null;
      }[];
    };
  };
  const artifactId = saved.rows.artifacts[0]!.artifact_id;
  const events = saved.rows.artifact_events
    .filter((event) => event.artifact_id === artifactId)
    .sort((a, b) => a.ordinal - b.ordinal);
  const plan = JSON.parse(Buffer.from(events[0]!.record_bytes.blobHex, 'hex').toString('utf8'))
    .payload as { plan_steps: { step_id: string }[] };
  const baseTree = await git(f.input.basis.gitRoot, [
    'rev-parse',
    `${f.input.basis.baseSha}^{tree}`,
  ]);
  await git(f.input.basis.gitRoot, ['commit', '--quiet', '-m', 'Closed checkpoint tree']);
  const closeCommit = await git(f.input.basis.gitRoot, ['rev-parse', 'HEAD']);
  const publication = uuidv7();
  const openRef = `refs/orcaops/snapshot/${publication}/open`;
  const closeRef = `refs/orcaops/snapshot/${publication}/close`;
  await git(f.input.basis.gitRoot, ['update-ref', openRef, f.input.basis.baseSha, '0'.repeat(40)]);
  await git(f.input.basis.gitRoot, ['update-ref', closeRef, closeCommit, '0'.repeat(40)]);
  const openSnapshot = {
    ...buildDefaultSkippedSnapshotBoundary(),
    tree_sha: baseTree,
    snapshot_ref: openRef,
    snapshot_commit_sha: f.input.basis.baseSha,
  };
  const closeSnapshot = {
    ...buildDefaultSkippedSnapshotBoundary(),
    tree_sha: f.input.basis.pinnedTreeSha,
    snapshot_ref: closeRef,
    snapshot_commit_sha: closeCommit,
  };
  const checkpointPayloads: { type: string; payload: Record<string, unknown> }[] = [
    {
      type: 'checkpoint_opened',
      payload: {
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: [plan.plan_steps[0]!.step_id],
        agent: 'codex',
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: events[0]!.event_id,
        opened_at: '2026-06-01T00:02:00.000Z',
        head_sha: f.input.basis.baseSha,
        open_snapshot: openSnapshot,
      },
    },
    {
      type: 'checkpoint_closed',
      payload: {
        artifact_id: artifactId,
        n: 1,
        summary: 'Retained exact outcome',
        files_changed: ['value.ts'],
        decisions: [],
        uncertainty: ['Confirm the retained value assumption.'],
        done_criteria: doneCriteria,
        completed_step_ids: [plan.plan_steps[0]!.step_id],
        closed_by_agent: 'codex',
        head_sha: f.input.basis.baseSha,
        ts: '2026-06-01T00:03:00.000Z',
        close_snapshot: closeSnapshot,
        diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
      },
    },
  ];
  if (overlapping) {
    const [open, close] = checkpointPayloads;
    const overlap = (sibling: number, pending: boolean) => ({
      siblings: [sibling],
      cross_artifact_siblings: [],
      pending,
      dropped_files: [],
      rejected_claims: [],
      ambiguous_files: [{ file_before: 'value.ts', file_after: 'value.ts' }],
      mixed_segment: [],
      own_claim_pending: [],
      segment_attributed: [],
      unattributed_in_window: [],
      degradations: [],
    });
    checkpointPayloads.splice(
      0,
      2,
      open!,
      { type: 'checkpoint_opened', payload: { ...open!.payload, n: 2 } },
      {
        type: 'checkpoint_closed',
        payload: { ...close!.payload, completed_step_ids: [], window_overlap: overlap(2, true) },
      },
      {
        type: 'checkpoint_closed',
        payload: {
          ...close!.payload,
          n: 2,
          completed_step_ids: [],
          window_overlap: overlap(1, false),
        },
      }
    );
  }
  const checkpointSidecars: { eventId: string; bytes: Buffer }[] = [];
  const checkpointEvents = checkpointPayloads.map(({ type, payload }) => {
    const record = {
      event_id: uuidv7(),
      type,
      payload,
      ts: '2026-06-01T00:03:00.000Z',
      schema_version: 1,
      idempotency_key: uuidv7(),
    };
    let wire: object = record;
    if (sidecarClose && type === 'checkpoint_closed') {
      const payloadBytes = bytes(payload);
      checkpointSidecars.push({ eventId: record.event_id, bytes: payloadBytes });
      const { payload: _payload, ...header } = record;
      wire = {
        ...header,
        sidecar_sha256: createHash('sha256').update(payloadBytes).digest('hex'),
        sidecar_size: payloadBytes.length,
      };
    }
    return Buffer.from(
      JSON.stringify({
        ...wire,
        checksum: createHash('sha256').update(canonicalJson(wire)).digest('hex'),
      }) + '\n'
    );
  });
  const lastCheckpointId = JSON.parse(checkpointEvents.at(-1)!.toString()).event_id as string;
  const database = await store.openProjectDatabase({
    authority: f.input.authority,
    mode: 'writer',
  });
  let revision: store.ArtifactRevision;
  let openRevision: store.ArtifactRevision;
  try {
    openRevision = (
      await store.appendProjectArtifactEvents(database, {
        operationId: uuidv7(),
        artifactId,
        expectedRevision: null,
        eventBytes: Buffer.concat([
          ...events.map((event) => Buffer.from(event.record_bytes.blobHex, 'hex')),
          ...checkpointEvents.slice(0, -1),
        ]),
        sidecarPayloads: [
          ...events
            .filter((event) => event.sidecar_payload_bytes !== null)
            .map((event) => ({
              eventId: event.event_id,
              bytes: Buffer.from(event.sidecar_payload_bytes!.blobHex, 'hex'),
            })),
          ...checkpointSidecars.filter((sidecar) => sidecar.eventId !== lastCheckpointId),
        ],
        secretAllow: [],
      })
    ).value.revision;
    revision = (
      await store.appendProjectArtifactEvents(database, {
        operationId: uuidv7(),
        artifactId,
        expectedRevision: openRevision,
        eventBytes: checkpointEvents.at(-1)!,
        sidecarPayloads: checkpointSidecars.filter(
          (sidecar) => sidecar.eventId === lastCheckpointId
        ),
        secretAllow: [],
      })
    ).value.revision;
  } finally {
    database.close();
  }
  const membershipRevisionId = uuidv7();
  await changeDatabaseReviewMembership({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    membershipBytes: bytes({
      revisionId: membershipRevisionId,
      members: [{ artifactId, generation: revision.generation, orderedHash: revision.orderedHash }],
      source: null,
    }),
    expected: { revisionId: f.input.expected.membershipRevisionId, version: 1 },
  });
  return { f, artifactId, revision, openRevision, membershipRevisionId };
}

async function retainedFingerprintFixture(mismatch: 'none' | 'artifact' | 'tree' | 'hash') {
  const artifactId = uuidv7();
  const openTreeSha = 'a'.repeat(40);
  const closeTreeSha = 'b'.repeat(40);
  const built = await buildDiffFingerprintManifest({
    artifactId,
    checkpointN: 1,
    openTreeSha,
    closeTreeSha,
    diffBytes: Buffer.from(
      'diff --git a/value.ts b/value.ts\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-old\n+new\n'
    ),
    truncated: false,
    maxDiffBytes: 100_000,
  });
  if (built.manifest === null) throw new Error('Expected a manifest fixture');
  const manifest = structuredClone(built.manifest);
  const summary = structuredClone(built.summary);
  if (mismatch === 'artifact') manifest.artifact_id = uuidv7();
  if (mismatch === 'tree') manifest.close_tree_sha = 'c'.repeat(40);
  if (mismatch === 'hash') summary.manifest_hash = 'forged';
  const checkpoint = {
    artifact_id: artifactId,
    n: 1,
    status: 'closed',
    declared_step_ids: [],
    completed_step_ids: [],
    files_changed: ['value.ts'],
    decisions: [],
    uncertainty: [],
    done_criteria: [],
    summary: 'Changed value',
    closed_at: '2026-09-09T00:00:00.000Z',
    open_snapshot: { tree_sha: openTreeSha },
    close_snapshot: { tree_sha: closeTreeSha },
    diff_fingerprint_summary: summary,
    source_event_ids: { opened: 'open', closed: 'current-close' },
  };
  const payload = { n: 1, diff_fingerprint_manifest: manifest };
  const thread = {
    artifactId,
    plan: {
      artifact_id: artifactId,
      branch: 'main',
      label: 'Retained fingerprint',
      task: 'Review retained evidence',
      base_sha: openTreeSha,
      started_at: '2026-09-09T00:00:00.000Z',
      revision_n: 0,
      plan_steps: [],
      non_goals: [],
      decisions: [],
    },
    checkpoints: [checkpoint],
    summary: null,
    evaluatorLog: null,
    artifactJson: null,
    events: [
      {
        record: { event_id: 'older-close', type: 'checkpoint_closed' },
        payload: { n: 1, diff_fingerprint_manifest: built.manifest },
      },
      { record: { event_id: 'current-close', type: 'checkpoint_closed' }, payload },
    ],
  };
  const revision = {
    generation: 1,
    orderedHash: 'd'.repeat(64),
    eventCount: 2,
    byteLength: 100,
    tailEventId: 'current-close',
  };
  const database = {
    read: () => ({ value: revision }),
  } as unknown as store.ProjectDatabase;
  vi.mocked(store.readProjectArtifact).mockReturnValueOnce({
    revision,
    thread,
  } as unknown as ReturnType<typeof store.readProjectArtifact>);
  return { artifactId, database, manifest, payload, revision };
}

it.each(['none', 'artifact', 'tree', 'hash'] as const)(
  'loads only a consistent retained fingerprint manifest (%s)',
  async (mismatch) => {
    const f = await retainedFingerprintFixture(mismatch);
    const original = structuredClone(f.payload);
    const artifacts = await readDatabaseReviewArtifacts(f.database, [
      {
        artifactId: f.artifactId,
        generation: f.revision.generation,
        orderedHash: f.revision.orderedHash,
      },
    ]);
    expect(artifacts[0]!.checkpoints[0]!.capturedFingerprint.loadState).toBe(
      mismatch === 'none' ? 'loaded' : 'corrupt'
    );
    expect(f.payload).toEqual(original);
  }
);

it('does not load an older close when the retained close manifest is inconsistent', async () => {
  const f = await retainedFingerprintFixture('hash');
  const artifacts = await readDatabaseReviewArtifacts(f.database, [
    {
      artifactId: f.artifactId,
      generation: f.revision.generation,
      orderedHash: f.revision.orderedHash,
    },
  ]);
  expect(artifacts[0]!.checkpoints[0]!.capturedFingerprint.loadState).toBe('corrupt');
});

it('normalizes exact retained closed checkpoints and derives their original anchors', async () => {
  const { f, artifactId, revision, openRevision, membershipRevisionId } =
    await retainedCheckpointFixture();
  const prepared = await prepareDatabaseReviewFloor({
    ...f.input,
    expected: { ...f.input.expected, membershipRevisionId, membershipVersion: 2 },
  });
  const floor = JSON.parse(prepared.floorBytes.toString('utf8'));
  expect(floor.scope.artifact_ids).toEqual([artifactId]);
  expect(floor.outline.threads).toHaveLength(1);
  expect(floor.outline.threads[0].checkpoints[0].summary).toBe('Retained exact outcome');
  expect(floor.outline.threads[0].checkpoints[0].checkpoint).toMatchObject({
    artifact: artifactId,
    cp: 1,
  });
  const altered = structuredClone(floor);
  altered.outline.threads[0].threadKey = 'forged-thread';
  expect(() => requirePreparedFloor({ ...prepared, floorBytes: bytes(altered) }, prepared)).toThrow(
    /assembled inputs/
  );
  const wrongCheckpoint = structuredClone(floor);
  wrongCheckpoint.outline.threads[0].checkpoints[0].checkpointKey = 'forged-checkpoint';
  expect(() =>
    requirePreparedFloor({ ...prepared, floorBytes: bytes(wrongCheckpoint) }, prepared)
  ).toThrow(/assembled inputs/);
  const request = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    publicationId: uuidv7(),
    secretAllow: [],
    basis: prepared.basis,
    expected: prepared.expected,
    floorBytes: prepared.floorBytes,
    diffBytes: prepared.diffBytes,
  };
  const wrongSlice = structuredClone(floor);
  wrongSlice.outline.threads[0].checkpoints[0].sliceRefs.push({
    hunkKey: 'foreign-hunk',
    slice: 0,
  });
  const wrongCitation = structuredClone(floor);
  expect(wrongCitation.citations.length).toBeGreaterThan(0);
  wrongCitation.citations[0].text = 'Forged original source';
  vi.clearAllMocks();
  for (const forged of [altered, wrongCheckpoint, wrongSlice, wrongCitation]) {
    await expect(
      publishDatabaseReviewFloor({ ...request, floorBytes: bytes(forged) })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.filter(([input]) => input.mode === 'writer')
  ).toHaveLength(0);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  await expect(publishDatabaseReviewFloor(request)).resolves.toMatchObject({ replayed: false });
  expect(
    (await readDatabaseReviewFloor({ authority: f.input.authority, reviewId: f.input.reviewId }))
      .value!.floorBytes
  ).toEqual(prepared.floorBytes);
  const anchored = await prepareDatabaseReviewComment({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    floorPublicationId: request.publicationId,
    expected: { floorVersion: 1, membershipRevisionId: prepared.expected.membershipRevisionId },
    secretAllow: [],
    commentBytes: bytes({
      type: 'add',
      comment_id: 'retained-owned-comment',
      ts: f.input.generatedAt,
      author: COMMENT_AUTHOR.REVIEWER,
      body: 'Explain the selected checkpoint.',
      anchor: {
        kind: 'DIFF_LINE',
        file: 'value.ts',
        side: 'add',
        line: 1,
        lineHash: await lineHash('add', new TextEncoder().encode('const value = 2;')),
        hunkKey: floor.coverage.items[0].hunkKey,
        threadKey: floor.outline.threads[0].threadKey,
      },
    }),
  });
  expect(anchored.comment.anchor.threadKey).toBe(floor.outline.threads[0].threadKey);
  const pinned = await prepareDatabaseReviewRunInputs({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    expected: { ...prepared.expected, floorVersion: 1, floorPublicationId: request.publicationId },
    generatedAt: f.input.generatedAt,
    policy: defaultRunInputPolicy(),
    secretAllow: [],
  });
  expect(pinned.ledger.entries.some((entry) => entry.kind === 'VERIFICATION_GAP')).toBe(true);
  const dossier = pinned.values['dossier-v1.json'] as { account_core: { ledger: unknown[] } };
  expect(dossier.account_core.ledger.length).toBeGreaterThan(0);
  const forged = structuredClone(pinned.values);
  (forged['dossier-v1.json'] as typeof dossier).account_core.ledger = [];
  expect(() => requirePreparedRunInputs({ ...pinned, values: forged }, pinned)).toThrow(
    /exact retained floor/
  );
  const runId = 'retained-account-run';
  const runRevisionId = uuidv7();
  const run = {
    schema_version: 2,
    run_id: runId,
    branch: 'topic',
    mode: 'routine',
    created_at: f.input.generatedAt,
    input_shas: pinned.inputShas,
    slice_state: freshSliceRunState(),
    lane_inputs_served: {},
    attempts: [],
    account_lineage: null,
    latency_input_bytes: Buffer.byteLength(
      (pinned.values['forensic-input-v1.json'] as ForensicInput).diff
    ),
    runtime_identity: null,
    execution_profile: {
      host: null,
      host_version: null,
      model: null,
      effort: null,
      launcher_mode: null,
      instruction_hash: null,
    },
    finalized: null,
  };
  const runInputPublicationId = uuidv7();
  await startDatabaseReviewRun({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    revisionId: runRevisionId,
    publicationId: runInputPublicationId,
    runBytes: bytes(run),
    inputs: pinned.members,
    policy: pinned.policy,
    expected: { ...pinned.expected, currentRunId: null, runSelectionVersion: 0 },
    secretAllow: [],
  });
  const afterRunPreparation = await prepareDatabaseReviewFloor({
    ...f.input,
    expected: { ...prepared.expected, floorVersion: 1 },
  });
  expect(afterRunPreparation.retentionTarget).toMatchObject({
    runId,
    runRevisionId,
    runSelectionVersion: 1,
    floorPublicationId: request.publicationId,
  });
  const forensicPayload = {
    findings: [
      {
        claim: 'Verify the changed value contract.',
        file: 'value.ts',
        related_files: [],
        severity: 'CAUTION',
        confidence: 'HIGH',
      },
    ],
    questions: [{ text: 'Does the caller expect the new value?', file: 'value.ts' }],
  };
  const attempt = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    runId,
    expected: { revisionId: runRevisionId, version: 1, runSelectionVersion: 1 },
    authored: {
      lane: 'forensic' as const,
      at: f.input.generatedAt,
      isolation: 'subagent-fresh' as const,
      usageTokens: null,
      usageSource: null,
      runtimeIdentity: null,
    },
    rawSubmissionBytes: bytes(forensicPayload),
    secretAllow: [],
  };
  const forensicPrepared = await prepareDatabaseReviewAttempt(attempt);
  expect(forensicPrepared.accepted).toBe(true);
  const forensicRevisionId = uuidv7();
  await publishDatabaseReviewAttempt({
    ...attempt,
    operationId: uuidv7(),
    revisionId: forensicRevisionId,
    publicationId: uuidv7(),
    runBytes: forensicPrepared.runBytes,
  });
  const aliases = buildAccountPromptAliases(
    pinned.values['account-projection-v1.json'] as AccountProjection
  );
  expect(aliases.checkpoints.length).toBeGreaterThan(0);
  expect(aliases.citations.length).toBeGreaterThan(0);
  const authored = {
    schema_version: 1,
    overview: {
      text: 'The retained checkpoint changes the value.',
      citations: [aliases.citations[0]!.alias],
    },
    acts: [
      {
        title: 'Retained value change',
        parts: [
          {
            title: 'Exact recorded outcome',
            checkpoints: aliases.checkpoints.map((item) => item.alias),
            interpretation: 'The checkpoint retains its authored outcome.',
            citations: [aliases.citations[0]!.alias],
          },
        ],
      },
    ],
    questions: [],
  };
  const account = {
    ...attempt,
    expected: { ...attempt.expected, revisionId: forensicRevisionId, version: 2 },
    authored: { ...attempt.authored, lane: 'account' as const },
    rawSubmissionBytes: bytes(authored),
  };
  const foreign = structuredClone(authored);
  foreign.acts[0]!.parts[0]!.checkpoints = ['k999'];
  expect(
    (await prepareDatabaseReviewAttempt({ ...account, rawSubmissionBytes: bytes(foreign) }))
      .accepted
  ).toBe(false);
  const accepted = await prepareDatabaseReviewAttempt(account);
  expect(accepted.accepted).toBe(true);
  expect(accepted.run.account_lineage).not.toBeNull();
  const envelope = JSON.parse(
    accepted.members.find((member) => member.name === 'accepted-account.json')!.bytes.toString()
  );
  expect(envelope.compiled_payload.parts[0].checkpoint_refs).toEqual(
    aliases.checkpoints.map((item) => item.canonical)
  );
  expect(envelope.normalized_authored).toEqual(authored);
  const accountRevisionId = uuidv7();
  await publishDatabaseReviewAttempt({
    ...account,
    operationId: uuidv7(),
    revisionId: accountRevisionId,
    publicationId: uuidv7(),
    runBytes: accepted.runBytes,
  });
  const retainedRun = await readDatabaseReviewRun({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(retainedRun.value!.revisionId).toBe(accountRevisionId);
  expect(retainedRun.value!.run.account_lineage).toEqual(accepted.run.account_lineage);
  expect(retainedRun.value!.run.attempts).toHaveLength(2);
  const proof = await readDatabaseReviewAttempts({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(proof.value!.accepted.account).toEqual(envelope.compiled_payload);
  expect(proof.value!.accepted.forensic).toEqual(forensicPayload);
  expect(proof.value!.attempts).toHaveLength(2);
  const finalizationInput = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    runId,
    expected: {
      revisionId: accountRevisionId,
      version: 3,
      runSelectionVersion: 1,
      floorPublicationId: request.publicationId,
      membershipRevisionId: prepared.expected.membershipRevisionId,
      storyVersion: 0,
    },
    finalizedAt: '2026-06-01T00:04:00.000Z',
    runtimeIdentity: null,
    secretAllow: [],
  };
  const finalization = await prepareDatabaseReviewFinalization(finalizationInput);
  expect(finalization.outcome).toBe('FULL');
  expect(finalization.generation).not.toBeNull();
  expect(finalization.terminalPreview.account_lineage).toEqual(accepted.run.account_lineage);
  expect(finalization.terminalPreview.range_validation).toBe('PERFORMED');
  const model = JSON.parse(
    finalization.requiredMembers
      .find((member) => member.name === 'story-review-model-v4.json')!
      .bytes.toString()
  );
  expect(model.parts.length).toBeGreaterThan(0);
  const settled = await publishDatabaseReviewFinalization({
    ...finalizationInput,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    publicationId: uuidv7(),
    runBytes: finalization.runBytes,
    members: finalization.requiredMembers.map(({ name, bytes }) => ({ name, bytes })),
  });
  expect(settled.value.outcome).toBe('FULL');
  const receipt = JSON.parse(Buffer.from(settled.value.terminalBytes, 'base64').toString());
  expect(receipt.account_lineage).toEqual(accepted.run.account_lineage);
  expect(receipt.submission_count).toBe(2);
  const retainedTerminal = await readDatabaseReviewFinalization({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    runId,
  });
  expect(retainedTerminal.value!.terminal.account_lineage).toEqual(accepted.run.account_lineage);
  const retainedContext = await readDatabaseReviewContext({
    dataRoot: f.input.authority.resolvedRoot,
    cwd: f.input.authority.resolvedRoot,
    projectId: f.input.authority.projectId,
    reviewId: f.input.reviewId,
  });
  expect(retainedContext.membership.members.length).toBeGreaterThan(0);
  expect(retainedContext.floor!.floor.outline.threads.length).toBeGreaterThan(0);
  expect(retainedContext.story!.terminal.outcome).toBe('FULL');
  expect(retainedContext.story!.bytes).toEqual(retainedTerminal.value!.bytes);
  expect(retainedContext.run!.runId).toBe(runId);
  expect(retainedContext.story!.runId).toBe(runId);
  expect(retainedContext.storyMatchesSelectedFloor).toBe(true);
  expect(retainedContext.counters).toEqual(retainedTerminal.counters);

  const semanticInput = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    runId,
    generationId: uuidv7(),
    expected: { revisionId: settled.value.revisionId, version: 4, runSelectionVersion: 1 },
    submissionBytes: bytes({ schema_version: 3, dispositions: [] }),
    secretAllow: [],
  };
  const beforeSemantic = await store.openProjectDatabase({
    authority: f.input.authority,
    mode: 'reader',
  });
  const originalCounters = beforeSemantic.read(() => null).counters;
  beforeSemantic.close();
  vi.mocked(store.openProjectDatabase).mockClear();
  const semanticPrepared = await prepareDatabaseSemanticGeneration(semanticInput);
  expect(semanticPrepared.receipt.status).toBe('READY');
  expect(semanticPrepared.receipt.run_id).toBe(runId);
  expect(semanticPrepared.validation.accepted).toBe(true);
  expect(semanticPrepared.catalog.items.length).toBeGreaterThan(0);
  expect(semanticPrepared.catalog.blocks.length).toBeGreaterThan(0);
  expect(semanticPrepared.submission.bytes).toEqual(semanticInput.submissionBytes);
  if (!semanticPrepared.validation.accepted) throw new Error('Expected compiled omission model');
  expect(semanticPrepared.validation.model.run_id).toBe(runId);
  expect(
    semanticPrepared.validation.model.items.every(
      (item) => item.disposition === 'NO_ANCHOR_PROPOSED'
    )
  ).toBe(true);
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([request]) => request.mode === 'reader')
  ).toBe(true);
  const semanticAnchor = await prepareDatabaseSemanticGeneration({
    ...semanticInput,
    generationId: uuidv7(),
    submissionBytes: bytes({
      schema_version: 3,
      dispositions: [
        {
          item: semanticPrepared.catalog.items[0]!.alias,
          disposition: 'ANCHORED',
          targets: [{ block: semanticPrepared.catalog.blocks[0]!.alias, scope: 'WHOLE_BLOCK' }],
        },
      ],
    }),
  });
  expect(semanticAnchor.validation.accepted).toBe(true);
  if (!semanticAnchor.validation.accepted) throw new Error('Expected exact block association');
  expect(semanticAnchor.validation.model.items[0]!.targets[0]).toMatchObject({
    block: { block_key: semanticPrepared.catalog.blocks[0]!.block_key },
  });
  const invalidProposal = await prepareDatabaseSemanticGeneration({
    ...semanticInput,
    generationId: uuidv7(),
    submissionBytes: bytes({
      schema_version: 3,
      dispositions: [{ item: 'i99999', disposition: 'ASSESSED_UNANCHORED', targets: [] }],
    }),
  });
  expect(invalidProposal.validation.accepted).toBe(false);
  await expect(
    prepareDatabaseSemanticGeneration({
      ...semanticInput,
      expected: { ...semanticInput.expected, version: 3 },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  vi.mocked(store.openProjectDatabase).mockClear();
  const refused = 'ghp_' + 'a'.repeat(36);
  await expect(
    prepareDatabaseSemanticGeneration({
      ...semanticInput,
      submissionBytes: bytes({ discarded: refused }),
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const cancelledPreparation = prepareDatabaseSemanticGeneration(semanticInput, options);
  options.signal = new AbortController().signal;
  controller.abort();
  await expect(cancelledPreparation).rejects.toMatchObject({ code: 'CANCELLED' });
  const semanticEvidence = retainedTerminal.value!.publications.find(
    (publication) => publication.kind === 'semantic'
  )!;
  const preparedPayload = semanticEvidence.members.find(
    (member) => member.name === 'semantic-anchor-input-v4.md'
  )!;
  expect(preparedPayload).toBeDefined();
  const payloadFile = path.join(
    path.dirname(store.projectDatabasePath(f.input.authority)),
    preparedPayload.relativePath
  );
  const originalPayload = await readFile(payloadFile);
  try {
    await writeFixtureFile(payloadFile, Buffer.alloc(originalPayload.length, 32));
    await expect(prepareDatabaseSemanticGeneration(semanticInput)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    expect(await readFile(payloadFile)).toEqual(Buffer.alloc(originalPayload.length, 32));
  } finally {
    await writeFixtureFile(payloadFile, originalPayload);
  }
  const afterSemantic = await store.openProjectDatabase({
    authority: f.input.authority,
    mode: 'reader',
  });
  expect(afterSemantic.read(() => null).counters).toEqual(originalCounters);
  afterSemantic.close();
  const semanticRead = { authority: f.input.authority, reviewId: f.input.reviewId, runId };
  expect(await readDatabaseSemanticGeneration(semanticRead)).toEqual({
    value: null,
    counters: originalCounters,
  });
  const retainedSemantic = await retainSemanticFixture(f.input.authority, semanticAnchor);
  vi.mocked(store.openProjectDatabase).mockClear();
  const semanticCurrent = await readDatabaseSemanticGeneration(semanticRead);
  expect(semanticCurrent.value!.generationId).toBe(semanticAnchor.generationId);
  expect(semanticCurrent.value!.attempts[0]!.bytes).toEqual(retainedSemantic.attemptBytes);
  expect(semanticCurrent.value!.terminal!.bytes).toEqual(retainedSemantic.manifestBytes);
  expect(semanticCurrent.value!.model!.bytes).toEqual(retainedSemantic.modelBytes);
  expect(semanticCurrent.value!.model!.value.items[0]!.targets[0]).toEqual(
    semanticAnchor.validation.model.items[0]!.targets[0]
  );
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([request]) => request.mode === 'reader')
  ).toBe(true);
  const semanticModelFile = path.join(
    path.dirname(store.projectDatabasePath(f.input.authority)),
    retainedSemantic.descriptor.relativePath
  );
  try {
    await writeFixtureFile(semanticModelFile, Buffer.alloc(retainedSemantic.modelBytes.length, 32));
    await expect(readDatabaseSemanticGeneration(semanticRead)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    expect(await readFile(semanticModelFile)).toEqual(
      Buffer.alloc(retainedSemantic.modelBytes.length, 32)
    );
  } finally {
    await writeFixtureFile(semanticModelFile, retainedSemantic.modelBytes);
  }
  const SemanticDriver = createRequire(new URL('../../../storage/package.json', import.meta.url))(
    'better-sqlite3'
  );
  const damagedSemantic = new SemanticDriver(store.projectDatabasePath(f.input.authority));
  try {
    damagedSemantic.pragma('foreign_keys=OFF');
    for (const table of ['review_semantic_current', 'review_semantic_generations']) {
      const row = damagedSemantic.prepare(`SELECT * FROM ${table}`).get();
      const trigger = damagedSemantic
        .prepare('SELECT sql FROM sqlite_schema WHERE name=?')
        .get(`${table}_no_delete`).sql;
      damagedSemantic.exec(`DROP TRIGGER ${table}_no_delete; DELETE FROM ${table}`);
      damagedSemantic.exec(trigger);
      await expect(readDatabaseSemanticGeneration(semanticRead)).rejects.toMatchObject({
        code: 'HISTORY_INTEGRITY_REQUIRED',
      });
      expect(damagedSemantic.prepare(`SELECT count(*) AS count FROM ${table}`).get().count).toBe(0);
      const columns = Object.keys(row);
      damagedSemantic
        .prepare(
          `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
        )
        .run(...Object.values(row));
    }
  } finally {
    damagedSemantic.close();
  }
  const anotherSemantic = await prepareDatabaseSemanticGeneration({
    ...semanticInput,
    generationId: uuidv7(),
  });
  await retainSemanticFixture(f.input.authority, anotherSemantic, {
    generationId: semanticAnchor.generationId,
    version: 1,
  });
  const historicalSemantic = await readDatabaseSemanticGeneration({
    ...semanticRead,
    generationId: semanticAnchor.generationId,
  });
  expect(historicalSemantic.value!.model!.bytes).toEqual(retainedSemantic.modelBytes);
  expect(historicalSemantic.value!.current!.generation_id).toBe(anotherSemantic.generationId);
  expect((await readDatabaseSemanticGeneration(semanticRead)).value!.generationId).toBe(
    anotherSemantic.generationId
  );

  const semanticPublication = await exerciseSemanticPublication({
    ...semanticRead,
    expected: {
      ...semanticInput.expected,
      semanticGenerationId: anotherSemantic.generationId,
      semanticVersion: 2,
    },
    submissionBytes: semanticAnchor.submission.bytes,
    inputFile: payloadFile,
  });

  await exerciseMissingSemanticHistory(semanticRead);

  expect(retainedTerminal.value!.bytes).toEqual(Buffer.from(settled.value.terminalBytes, 'base64'));
  expect(receipt.outputs.story_review_model_sha256).toBe(
    finalization.terminalPreview.outputs!.story_review_model_sha256
  );
  expect(
    (await readDatabaseReviewAttempts({ authority: f.input.authority, reviewId: f.input.reviewId }))
      .value!.run.finalized!.outcome
  ).toBe('FULL');
  const uncertainty = floor.citations.find(
    (citation: { kind: string }) => citation.kind === 'CHECKPOINT_UNCERTAINTY'
  );
  expect(uncertainty).toBeDefined();
  expect(model.findings.length).toBeGreaterThan(0);
  expect(model.questions.length).toBeGreaterThan(0);
  const workflowEvents = [
    {
      type: 'section' as const,
      ts: f.input.generatedAt,
      threadKey: floor.outline.threads[0].threadKey as string,
      action: 'VISIT' as const,
    },
    {
      type: 'uncertainty' as const,
      ts: f.input.generatedAt,
      citationId: uncertainty.id as string,
      action: 'ACKNOWLEDGE' as const,
    },
    {
      type: 'finding' as const,
      ts: f.input.generatedAt,
      findingKey: model.findings[0].id as string,
      action: 'ACKNOWLEDGE' as const,
    },
    {
      type: 'prompt' as const,
      ts: f.input.generatedAt,
      promptKey: model.questions[0].id as string,
      action: 'ACKNOWLEDGE' as const,
    },
  ] as const;
  const workflowRequest = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    expected: {
      floor: { publicationId: request.publicationId, version: 1 },
      story: { publicationId: settled.value.publicationId, version: 1 },
      targets: workflowEvents.map((event) => ({
        targetKey: workflowTarget(event),
        revisionId: null,
        version: 0,
      })),
    },
    events: workflowEvents.map((event) => ({ revisionId: uuidv7(), bytes: bytes(event) })),
  };
  await appendDatabaseReviewWorkflowEvents(workflowRequest);
  const workflow = await readDatabaseReviewWorkflow({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(workflow.value.events).toEqual(workflowEvents);
  expect(
    workflow.value.revisions.every(
      (revision) => revision.basis.story?.generation === finalization.generation
    )
  ).toBe(true);
  const forgedQuestion = { ...workflowEvents[3]!, promptKey: 'absent-from-retained-story' };
  vi.clearAllMocks();
  await expect(
    appendDatabaseReviewWorkflowEvents({
      ...workflowRequest,
      operationId: uuidv7(),
      expected: {
        ...workflowRequest.expected,
        targets: [{ targetKey: workflowTarget(forgedQuestion), revisionId: null, version: 0 }],
      },
      events: [{ revisionId: uuidv7(), bytes: bytes(forgedQuestion) }],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  const manifests = await buildCurrentThreadManifests(
    floor,
    await buildEligibleNarrativeTargets(floor, prepared.diffBytes.toString())
  );
  const coveredThreads = manifests.filter(
    (manifest) => manifest.rows !== null && manifest.rows.length > 0
  );
  expect(coveredThreads.length).toBeGreaterThan(0);
  const beforeCoverage = await readDatabaseReviewWorkflow({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  const coverageEvent: JournalEvent = {
    type: 'review_coverage',
    ts: f.input.generatedAt,
    action: 'RECORD_REVIEW_COVERAGE',
    floor_input_hash: floor.input_hash,
    ledger_generation: beforeCoverage.value.ledgerGeneration,
    threads: await Promise.all(
      coveredThreads.map(async (manifest) => ({
        threadKey: manifest.threadKey,
        coveredRows: manifest.rows!,
        coveredRowsDigest: await reviewedRowsDigest(manifest.rows!),
      }))
    ),
  };
  await appendDatabaseReviewWorkflowEvents({
    ...workflowRequest,
    operationId: uuidv7(),
    expected: {
      ...workflowRequest.expected,
      targets: [{ targetKey: workflowTarget(coverageEvent), revisionId: null, version: 0 }],
    },
    events: [{ revisionId: uuidv7(), bytes: bytes(coverageEvent) }],
  });
  const remainingGaps = await buildCurrentGapRows(floor, prepared.diffBytes.toString());
  if (remainingGaps.length > 0) {
    const inspected: JournalEvent = {
      type: 'unassigned',
      ts: f.input.generatedAt,
      action: 'MARK_INSPECTED',
      target: {
        kind: 'GAP_ROWS',
        coveredRows: remainingGaps,
        coveredRowsDigest: await reviewedRowsDigest(remainingGaps),
      },
    };
    await appendDatabaseReviewWorkflowEvents({
      ...workflowRequest,
      operationId: uuidv7(),
      expected: {
        ...workflowRequest.expected,
        targets: [{ targetKey: workflowTarget(inspected), revisionId: null, version: 0 }],
      },
      events: [{ revisionId: uuidv7(), bytes: bytes(inspected) }],
    });
  }
  expect(model.findings[0].required).toBe(true);
  const reopenedFinding = { ...workflowEvents[2], action: 'REOPEN' as const };
  const reopenedFindingRevision = uuidv7();
  await appendDatabaseReviewWorkflowEvents({
    ...workflowRequest,
    operationId: uuidv7(),
    expected: {
      ...workflowRequest.expected,
      targets: [
        {
          targetKey: workflowTarget(reopenedFinding),
          revisionId: workflowRequest.events[2]!.revisionId,
          version: 1,
        },
      ],
    },
    events: [{ revisionId: reopenedFindingRevision, bytes: bytes(reopenedFinding) }],
  });
  const ready = await readDatabaseReviewWorkflow({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  const complete: JournalEvent = {
    type: 'review_lifecycle',
    ts: f.input.generatedAt,
    action: 'COMPLETE',
    review_basis: 'STORY',
    floor_input_hash: floor.input_hash,
    story_generation: finalization.generation,
    ledger_generation: ready.value.ledgerGeneration,
    actor: 'REVIEWER',
    source: 'WATCH',
  };
  await expect(
    appendDatabaseReviewWorkflowEvents({
      ...workflowRequest,
      operationId: uuidv7(),
      expected: {
        ...workflowRequest.expected,
        targets: [{ targetKey: workflowTarget(complete), revisionId: null, version: 0 }],
      },
      events: [{ revisionId: uuidv7(), bytes: bytes(complete) }],
    })
  ).rejects.toThrow(/required Story item/);
  await appendDatabaseReviewWorkflowEvents({
    ...workflowRequest,
    operationId: uuidv7(),
    expected: {
      ...workflowRequest.expected,
      targets: [
        {
          targetKey: workflowTarget(reopenedFinding),
          revisionId: reopenedFindingRevision,
          version: 2,
        },
      ],
    },
    events: [{ revisionId: uuidv7(), bytes: bytes({ ...reopenedFinding, action: 'RESOLVE' }) }],
  });
  const resolvedLedger = await readDatabaseReviewWorkflow({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  const resolvedCompletion = {
    ...complete,
    ledger_generation: resolvedLedger.value.ledgerGeneration,
  };
  const completeRequest = {
    ...workflowRequest,
    operationId: uuidv7(),
    expected: {
      ...workflowRequest.expected,
      targets: [{ targetKey: workflowTarget(resolvedCompletion), revisionId: null, version: 0 }],
    },
    events: [{ revisionId: uuidv7(), bytes: bytes(resolvedCompletion) }],
  };
  await expect(
    appendDatabaseReviewWorkflowEvents({
      ...completeRequest,
      operationId: uuidv7(),
      events: [
        {
          revisionId: uuidv7(),
          bytes: bytes({ ...resolvedCompletion, story_generation: 'different-story-generation' }),
        },
      ],
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await expect(appendDatabaseReviewWorkflowEvents(completeRequest)).resolves.toMatchObject({
    replayed: false,
  });
  const comment = await createDatabaseReviewComment({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    floorPublicationId: request.publicationId,
    expected: { floorVersion: 1, membershipRevisionId },
    commentBytes: anchored.commentBytes,
    secretAllow: [],
  });
  const linkedEntry = pinned.ledger.entries.find((entry) =>
    (
      pinned.values['dossier-v1.json'] as { account_core: { ledger: { id: string }[] } }
    ).account_core.ledger.some((retained) => retained.id === entry.id)
  )!;
  expect(linkedEntry).toBeDefined();
  const ledgerLink = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    linkId: uuidv7(),
    commentId: comment.value.commentId,
    commentRevisionId: comment.value.revisionId,
    endpoint: {
      kind: 'run-ledger-entry' as const,
      runId,
      runRevisionId,
      inputPublicationId: runInputPublicationId,
      ledgerEntryId: linkedEntry.id,
    },
    actor: COMMENT_AUTHOR.AGENT,
    at: f.input.generatedAt,
    secretAllow: [],
  };
  vi.clearAllMocks();
  await expect(
    linkDatabaseReviewComment({
      ...ledgerLink,
      endpoint: { ...ledgerLink.endpoint, ledgerEntryId: 'not-served' },
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  const linked = await linkDatabaseReviewComment(ledgerLink);
  expect(linked.counters.intentChangeCounter).toBe(comment.counters.intentChangeCounter + 1);
  expect(linked.counters.writeSequence).toBe(comment.counters.writeSequence + 1);
  expect(await linkDatabaseReviewComment(ledgerLink)).toMatchObject({
    replayed: true,
    value: linked.value,
    counters: linked.counters,
  });
  await expect(
    linkDatabaseReviewComment({
      ...ledgerLink,
      endpoint: { ...ledgerLink.endpoint, inputPublicationId: uuidv7() },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const openMembership = uuidv7();
  await changeDatabaseReviewMembership({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    expected: { revisionId: membershipRevisionId, version: 2 },
    membershipBytes: bytes({
      revisionId: openMembership,
      members: [
        { artifactId, generation: openRevision.generation, orderedHash: openRevision.orderedHash },
      ],
      source: null,
    }),
  });
  const reply = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    commentId: comment.value.commentId,
    operationId: uuidv7(),
    expected: { revisionId: comment.value.revisionId, version: 1 },
    membership: { revisionId: openMembership, version: 3 },
    secretAllow: [],
    events: [
      {
        revisionId: uuidv7(),
        bytes: bytes({
          type: 'reply',
          comment_id: comment.value.commentId,
          ts: '2026-06-01T00:06:00.000Z',
          author: COMMENT_AUTHOR.AGENT,
          body: 'This checkpoint records the answer.',
          checkpoint_ref: { artifact: artifactId, cp: 1 },
        }),
      },
    ],
  };
  vi.clearAllMocks();
  await expect(appendDatabaseReviewCommentEvents(reply)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(vi.mocked(store.openProjectDatabase).mock.calls.every(([v]) => v.mode === 'reader')).toBe(
    true
  );
  const closedMembership = uuidv7();
  await changeDatabaseReviewMembership({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    expected: { revisionId: openMembership, version: 3 },
    membershipBytes: bytes({
      revisionId: closedMembership,
      members: [{ artifactId, generation: revision.generation, orderedHash: revision.orderedHash }],
      source: null,
    }),
  });
  const closedReply = {
    ...reply,
    operationId: uuidv7(),
    membership: { revisionId: closedMembership, version: 4 },
  };
  await expect(appendDatabaseReviewCommentEvents(reply)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const appended = await appendDatabaseReviewCommentEvents(closedReply);
  const answered = await readDatabaseReviewComment({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    commentId: comment.value.commentId,
  });
  expect(answered.value!.comment.replies[0]!.checkpoint_ref).toEqual({
    artifact: artifactId,
    cp: 1,
  });
  expect(answered.value!.revisions[1]!.basis).toEqual({
    ...answered.value!.revisions[0]!.basis,
    checkpointTarget: {
      membershipRevisionId: closedMembership,
      membershipVersion: 4,
      artifactId,
      generation: revision.generation,
      orderedHash: revision.orderedHash,
      cp: 1,
    },
  });
  expect((await appendDatabaseReviewCommentEvents(closedReply)).value).toEqual(appended.value);
  const republished = await prepareDatabaseReviewFloor({
    ...f.input,
    expected: {
      ...f.input.expected,
      membershipRevisionId: closedMembership,
      membershipVersion: 4,
      floorVersion: 1,
    },
  });
  expect(JSON.parse(republished.floorBytes.toString()).input_hash).toBe(floor.input_hash);
  const repeatedPublication = uuidv7();
  await publishDatabaseReviewFloor({
    ...request,
    operationId: uuidv7(),
    publicationId: repeatedPublication,
    expected: republished.expected,
    basis: republished.basis,
    floorBytes: republished.floorBytes,
    diffBytes: republished.diffBytes,
  });
  const resolvedQuestion = { ...workflowEvents[3]!, action: 'RESOLVE' as const };
  await expect(
    appendDatabaseReviewWorkflowEvents({
      ...workflowRequest,
      operationId: uuidv7(),
      expected: {
        ...workflowRequest.expected,
        floor: { publicationId: repeatedPublication, version: 2 },
        targets: [
          {
            targetKey: workflowTarget(resolvedQuestion),
            revisionId: workflowRequest.events[3]!.revisionId,
            version: 1,
          },
        ],
      },
      events: [{ revisionId: uuidv7(), bytes: bytes(resolvedQuestion) }],
    })
  ).resolves.toMatchObject({ replayed: false });
  const currentQuestion = (
    await readDatabaseReviewWorkflow({ authority: f.input.authority, reviewId: f.input.reviewId })
  ).value.heads.find((head) => head.targetKey === workflowTarget(resolvedQuestion))!;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(f.input.basis.gitRoot, 'value.ts'), 'const value = 3;\n');
  await git(f.input.basis.gitRoot, ['add', 'value.ts']);
  const changedTree = await git(f.input.basis.gitRoot, ['write-tree']);
  const changedFloor = await prepareDatabaseReviewFloor({
    ...f.input,
    expected: {
      ...f.input.expected,
      membershipRevisionId: closedMembership,
      membershipVersion: 4,
      floorVersion: 2,
    },
    basis: { ...f.input.basis, pinnedTreeSha: changedTree },
  });
  expect(JSON.parse(changedFloor.floorBytes.toString()).input_hash).not.toBe(floor.input_hash);
  const changedPublication = uuidv7();
  await publishDatabaseReviewFloor({
    ...request,
    operationId: uuidv7(),
    publicationId: changedPublication,
    expected: changedFloor.expected,
    basis: changedFloor.basis,
    floorBytes: changedFloor.floorBytes,
    diffBytes: changedFloor.diffBytes,
  });
  const changedQuestionRequest = {
    ...workflowRequest,
    operationId: uuidv7(),
    expected: {
      ...workflowRequest.expected,
      floor: { publicationId: changedPublication, version: 3 },
      targets: [currentQuestion],
    },
    events: [{ revisionId: uuidv7(), bytes: bytes({ ...resolvedQuestion, action: 'REOPEN' }) }],
  };
  vi.clearAllMocks();
  await expect(appendDatabaseReviewWorkflowEvents(changedQuestionRequest)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  const missingStory = path.join(
    path.dirname(store.projectDatabasePath(f.input.authority)),
    'evidence',
    settled.value.publicationId!,
    'story-review-model-v4.json'
  );
  await rm(missingStory);
  await expect(appendDatabaseReviewWorkflowEvents(changedQuestionRequest)).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  await expect(readFile(missingStory)).rejects.toMatchObject({ code: 'ENOENT' });
  const historical = await linkDatabaseReviewComment({
    ...ledgerLink,
    operationId: uuidv7(),
    linkId: uuidv7(),
  });
  expect(historical.replayed).toBe(false);
  const retainedLink = await readDatabaseReviewCommentLink({
    authority: ledgerLink.authority,
    reviewId: ledgerLink.reviewId,
    linkId: ledgerLink.linkId,
  });
  expect(retainedLink.value!.endpoint).toEqual(ledgerLink.endpoint);
  expect(retainedLink.value!.target).toMatchObject({ id: linkedEntry.id });
  expect(retainedLink.value!.comment.revisionId).toBe(comment.value.revisionId);
  expect(
    (
      await listDatabaseReviewCommentLinks({
        authority: ledgerLink.authority,
        reviewId: ledgerLink.reviewId,
      })
    ).value.links
  ).toHaveLength(2);
  const missingInput = path.join(
    path.dirname(store.projectDatabasePath(f.input.authority)),
    'evidence',
    runInputPublicationId,
    'dossier-v1.json'
  );
  await rm(missingInput);
  vi.clearAllMocks();
  expect((await linkDatabaseReviewComment(ledgerLink)).replayed).toBe(true);
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  await expect(
    linkDatabaseReviewComment({ ...ledgerLink, operationId: uuidv7(), linkId: uuidv7() })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  await expect(readFile(missingInput)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    readDatabaseReviewCommentLink({
      authority: ledgerLink.authority,
      reviewId: ledgerLink.reviewId,
      linkId: ledgerLink.linkId,
    })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect((await linkDatabaseReviewComment(ledgerLink)).replayed).toBe(true);
  vi.clearAllMocks();
  const metadataOnly = await listDatabaseReviewCommentLinks({
    authority: ledgerLink.authority,
    reviewId: ledgerLink.reviewId,
  });
  expect(metadataOnly.value.links).toHaveLength(2);
  expect(store.readProjectEvidence).not.toHaveBeenCalled();

  await writeFixtureFile(
    missingStory,
    finalization.requiredMembers.find((member) => member.name === 'story-review-model-v4.json')!
      .bytes
  );
  await writeFixtureFile(
    missingInput,
    pinned.members.find((member) => member.name === 'dossier-v1.json')!.bytes
  );
  const replacementInputs = await prepareDatabaseReviewRunInputs({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    expected: { ...changedFloor.expected, floorPublicationId: changedPublication, floorVersion: 3 },
    generatedAt: f.input.generatedAt,
    policy: defaultRunInputPolicy(),
    secretAllow: [],
  });
  const originalSemantic = await readDatabaseSemanticGeneration(semanticRead);
  const racingSemantic = {
    ...semanticPublication.request,
    operationId: uuidv7(),
    generationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
    expected: {
      ...semanticPublication.request.expected,
      semanticGenerationId: originalSemantic.value!.generationId,
      semanticVersion: originalSemantic.value!.current!.version,
    },
  };
  const replacementRunId = 'replacement-account-run';
  const replacementRevisionId = uuidv7();
  const actualPublish = (await vi.importActual<typeof store>('@orcaops/storage/history/database'))
    .publishProjectEvidence;
  vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (...args) => {
    const effects = await actualPublish(...args);
    await startDatabaseReviewRun({
      authority: f.input.authority,
      reviewId: f.input.reviewId,
      operationId: uuidv7(),
      revisionId: replacementRevisionId,
      publicationId: uuidv7(),
      runBytes: bytes({
        ...run,
        run_id: replacementRunId,
        input_shas: replacementInputs.inputShas,
        latency_input_bytes: Buffer.byteLength(
          (replacementInputs.values['forensic-input-v1.json'] as ForensicInput).diff
        ),
      }),
      inputs: replacementInputs.members,
      policy: replacementInputs.policy,
      expected: { ...replacementInputs.expected, currentRunId: runId, runSelectionVersion: 1 },
      secretAllow: [],
    });
    return effects;
  });
  await expect(publishDatabaseSemanticGeneration(racingSemantic)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const replacementRead = (
    await readDatabaseReviewRun({ authority: f.input.authority, reviewId: f.input.reviewId })
  ).value!;
  expect(replacementRead.run.run_id).toBe(replacementRunId);
  expect(replacementRead.currentRevisionId).toBe(replacementRevisionId);
  const retainedOriginal = await readDatabaseSemanticGeneration(semanticRead);
  expect(retainedOriginal.value!.generationId).toBe(originalSemantic.value!.generationId);
  expect(retainedOriginal.counters.writeSequence).toBe(originalSemantic.counters.writeSequence + 1);
  expect(retainedOriginal.counters.intentChangeCounter).toBe(
    originalSemantic.counters.intentChangeCounter
  );
  expect(
    (
      await readDatabaseSemanticGeneration({
        ...semanticRead,
        generationId: racingSemantic.generationId,
      })
    ).value
  ).toBeNull();
  const receiptReader = await store.openProjectDatabase({
    authority: f.input.authority,
    mode: 'reader',
  });
  const missingSemanticReceipt = receiptReader.read((view) =>
    view.get('SELECT 1 FROM operations WHERE operation_id=?', racingSemantic.operationId)
  ).value;
  receiptReader.close();
  expect(missingSemanticReceipt).toBeNull();
  expect(
    (
      await readFile(
        path.join(
          path.dirname(store.projectDatabasePath(f.input.authority)),
          'evidence',
          racingSemantic.modelPublicationId,
          'semantic-anchor-model-v3.json'
        )
      )
    ).length
  ).toBeGreaterThan(0);
  vi.mocked(store.readProjectEvidence).mockClear();
  vi.mocked(store.publishProjectEvidence).mockClear();
  expect(await publishDatabaseSemanticGeneration(semanticPublication.request)).toEqual({
    ...semanticPublication.accepted,
    replayed: true,
  });
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect(
    (await readDatabaseReviewRun({ authority: f.input.authority, reviewId: f.input.reviewId }))
      .value!.run.run_id
  ).toBe(replacementRunId);
}, 30000);

it('requires inspection of actual retained overlap ambiguity before completion', async () => {
  const { f, membershipRevisionId } = await retainedCheckpointFixture(true);
  const prepared = await prepareDatabaseReviewFloor({
    ...f.input,
    expected: { ...f.input.expected, membershipRevisionId, membershipVersion: 2 },
  });
  const floor = JSON.parse(prepared.floorBytes.toString('utf8')) as Floor;
  expect(floor.outline.unassigned.ambiguous.hunkKeys).toHaveLength(1);
  expect(floor.outline.threads.flatMap((thread) => thread.checkpoints)).toHaveLength(2);
  const publicationId = uuidv7();
  await publishDatabaseReviewFloor({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    publicationId,
    secretAllow: [],
    basis: prepared.basis,
    expected: prepared.expected,
    floorBytes: prepared.floorBytes,
    diffBytes: prepared.diffBytes,
  });
  async function request(event: JournalEvent) {
    const history = await readDatabaseReviewWorkflow({
      authority: f.input.authority,
      reviewId: f.input.reviewId,
    });
    const targetKey = workflowTarget(event);
    return {
      authority: f.input.authority,
      reviewId: f.input.reviewId,
      operationId: uuidv7(),
      secretAllow: [],
      expected: {
        floor: { publicationId, version: 1 },
        ...(event.type === 'review_lifecycle'
          ? { story: { publicationId: null, version: 0 } }
          : {}),
        targets: [
          history.value.heads.find((head) => head.targetKey === targetKey) ?? {
            targetKey,
            revisionId: null,
            version: 0,
          },
        ],
      },
      events: [{ revisionId: uuidv7(), bytes: bytes(event) }],
    };
  }
  for (const citation of floor.citations.filter(
    (citation) => citation.kind === 'CHECKPOINT_UNCERTAINTY'
  )) {
    await appendDatabaseReviewWorkflowEvents(
      await request({
        type: 'uncertainty',
        ts: f.input.generatedAt,
        citationId: citation.id,
        action: 'ACKNOWLEDGE',
      })
    );
  }
  const currentRows = await buildCurrentThreadManifests(
    floor,
    await buildEligibleNarrativeTargets(floor, prepared.diffBytes.toString('utf8'))
  );
  const covered = currentRows.filter((row) => row.rows !== null && row.rows.length > 0);
  if (covered.length) {
    const ledger = await readDatabaseReviewWorkflow({
      authority: f.input.authority,
      reviewId: f.input.reviewId,
    });
    await appendDatabaseReviewWorkflowEvents(
      await request({
        type: 'review_coverage',
        action: 'RECORD_REVIEW_COVERAGE',
        ts: f.input.generatedAt,
        floor_input_hash: floor.input_hash,
        ledger_generation: ledger.value.ledgerGeneration,
        threads: await Promise.all(
          covered.map(async (row) => ({
            threadKey: row.threadKey,
            coveredRows: row.rows!,
            coveredRowsDigest: await reviewedRowsDigest(row.rows!),
          }))
        ),
      })
    );
  }
  async function completion() {
    const ledger = await readDatabaseReviewWorkflow({
      authority: f.input.authority,
      reviewId: f.input.reviewId,
    });
    return request({
      type: 'review_lifecycle',
      ts: f.input.generatedAt,
      action: 'COMPLETE',
      actor: 'REVIEWER',
      source: 'WATCH',
      floor_input_hash: floor.input_hash,
      ledger_generation: ledger.value.ledgerGeneration,
      story_generation: null,
      review_basis: 'FLOOR_ONLY',
    });
  }
  const complete = await completion();
  vi.clearAllMocks();
  await expect(appendDatabaseReviewWorkflowEvents(complete)).rejects.toThrow(/ambiguous/i);
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  const event: JournalEvent = {
    type: 'unassigned',
    ts: f.input.generatedAt,
    action: 'MARK_INSPECTED',
    target: { kind: 'AMBIGUOUS_HUNK', hunkKey: floor.outline.unassigned.ambiguous.hunkKeys[0]! },
  };
  const forged: JournalEvent = {
    ...event,
    target: { kind: 'AMBIGUOUS_HUNK', hunkKey: 'not-a-retained-ambiguity' },
  };
  vi.clearAllMocks();
  await expect(appendDatabaseReviewWorkflowEvents(await request(forged))).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  const inspectionRequest = await request(event);
  const inspection = await appendDatabaseReviewWorkflowEvents(inspectionRequest);
  expect(inspection.value.revisions[0]!.targetKey).toBe(workflowTarget(event));
  const finished = await appendDatabaseReviewWorkflowEvents(await completion());
  expect(finished.replayed).toBe(false);
  expect((await appendDatabaseReviewWorkflowEvents(inspectionRequest)).replayed).toBe(true);
});

async function capturedLinkFixture(sidecarClose = false) {
  const retained = await retainedCheckpointFixture(
    false,
    [
      {
        criterion_id: 'retained-unresolved-criterion',
        evidence: 'The exact authored outcome remains retained.',
      },
    ],
    sidecarClose
  );
  const { f, membershipRevisionId, artifactId, revision } = retained;
  const prepared = await prepareDatabaseReviewFloor({
    ...f.input,
    expected: { ...f.input.expected, membershipRevisionId, membershipVersion: 2 },
  });
  const floor = JSON.parse(prepared.floorBytes.toString('utf8')) as Floor;
  const publicationId = uuidv7();
  await publishDatabaseReviewFloor({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    publicationId,
    secretAllow: [],
    basis: prepared.basis,
    expected: prepared.expected,
    floorBytes: prepared.floorBytes,
    diffBytes: prepared.diffBytes,
  });
  const comment = await createDatabaseReviewComment({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    floorPublicationId: publicationId,
    expected: { floorVersion: 1, membershipRevisionId },
    secretAllow: [],
    commentBytes: bytes({
      type: 'add',
      comment_id: 'original-captured-comment',
      ts: f.input.generatedAt,
      author: COMMENT_AUTHOR.REVIEWER,
      body: 'Question the retained criterion evidence.',
      anchor: {
        kind: 'DIFF_LINE',
        file: 'value.ts',
        side: 'add',
        line: 1,
        lineHash: await lineHash('add', new TextEncoder().encode('const value = 2;')),
        hunkKey: floor.coverage.items[0]!.hunkKey,
        threadKey: floor.outline.threads[0]!.threadKey,
      },
    }),
  });
  const request = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    linkId: uuidv7(),
    commentId: comment.value.commentId,
    commentRevisionId: comment.value.revisionId,
    endpoint: {
      kind: 'captured-occurrence' as const,
      membershipRevisionId,
      artifactId,
      artifactRevision: revision,
      sourceEventId: revision.tailEventId,
      fieldPath: '/done_criteria' as const,
      position: 0,
    },
    actor: COMMENT_AUTHOR.AGENT,
    at: f.input.generatedAt,
    secretAllow: [],
  };
  return { retained, comment, request };
}

it.each([false, true])(
  'links the exact captured occurrence with sidecar=%s without duplicating attribution',
  async (sidecarClose) => {
    const { request, comment } = await capturedLinkFixture(sidecarClose);
    const concurrent = await Promise.all([
      linkDatabaseReviewComment(request),
      linkDatabaseReviewComment(request),
    ]);
    expect(concurrent.filter((result) => !result.replayed)).toHaveLength(1);
    expect(concurrent.filter((result) => result.replayed)).toHaveLength(1);
    expect(concurrent[0]!.value).toEqual(concurrent[1]!.value);
    expect(concurrent[0]!.counters).toEqual(concurrent[1]!.counters);
    const result = concurrent[0]!;
    expect(result.counters).toEqual({
      writeSequence: comment.counters.writeSequence + 1,
      intentChangeCounter: comment.counters.intentChangeCounter + 1,
    });
    const database = await store.openProjectDatabase({
      authority: request.authority,
      mode: 'reader',
    });
    try {
      const row = database.read((view) =>
        view.get<{ endpoint_json: string; source_json: string }>(
          'SELECT endpoint_json,source_json FROM review_comment_claim_links WHERE link_id=?',
          request.linkId
        )
      ).value!;
      expect(JSON.parse(row.endpoint_json)).toEqual(request.endpoint);
      expect(JSON.parse(row.source_json)).toEqual({
        kind: 'authored',
        eventId: request.linkId,
        fieldPath: 'link',
        position: 0,
        actor: COMMENT_AUTHOR.AGENT,
        at: request.at,
      });
      const resolved = await resolveReviewCommentLink(database, request);
      expect(resolved.value).toEqual({
        criterion_id: 'retained-unresolved-criterion',
        evidence: 'The exact authored outcome remains retained.',
      });
      expect(resolved.comment.comment.author).toBe(COMMENT_AUTHOR.REVIEWER);
    } finally {
      database.close();
    }
    expect(await linkDatabaseReviewComment(request)).toMatchObject({
      replayed: true,
      value: result.value,
      counters: result.counters,
    });
    vi.clearAllMocks();
    const exact = await readDatabaseReviewCommentLink({
      authority: request.authority,
      reviewId: request.reviewId,
      linkId: request.linkId,
    });
    expect(exact.value!.comment.comment.author).toBe(COMMENT_AUTHOR.REVIEWER);
    expect(exact.value!.source.actor).toBe(COMMENT_AUTHOR.AGENT);
    expect(exact.value!.target).toEqual({
      criterion_id: 'retained-unresolved-criterion',
      evidence: 'The exact authored outcome remains retained.',
    });
    const { comment: _comment, target: _target, ...metadata } = exact.value!;
    vi.clearAllMocks();
    const artifactRead = vi.spyOn(store, 'readProjectArtifact');
    try {
      expect(
        (
          await listDatabaseReviewCommentLinks({
            authority: request.authority,
            reviewId: request.reviewId,
          })
        ).value.links
      ).toEqual([metadata]);
      expect(artifactRead).not.toHaveBeenCalled();
      expect(store.readProjectEvidence).not.toHaveBeenCalled();
    } finally {
      artifactRead.mockRestore();
    }
    expect(
      vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
    ).toBe(true);
    expect(store.publishProjectEvidence).not.toHaveBeenCalled();
    await expect(
      linkDatabaseReviewComment({ ...request, operationId: uuidv7() })
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  }
);

it('refuses wrong captured event, position and historical scope before writer open', async () => {
  const { request, retained } = await capturedLinkFixture();
  const openMembershipId = uuidv7();
  await changeDatabaseReviewMembership({
    authority: request.authority,
    reviewId: request.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    expected: { revisionId: request.endpoint.membershipRevisionId, version: 2 },
    membershipBytes: bytes({
      revisionId: openMembershipId,
      members: [
        {
          artifactId: request.endpoint.artifactId,
          generation: retained.openRevision.generation,
          orderedHash: retained.openRevision.orderedHash,
        },
      ],
      source: null,
    }),
  });
  for (const endpoint of [
    { ...request.endpoint, position: 1 },
    { ...request.endpoint, sourceEventId: uuidv7() },
    { ...request.endpoint, membershipRevisionId: uuidv7() },
    { ...request.endpoint, artifactRevision: retained.openRevision },
    {
      ...request.endpoint,
      membershipRevisionId: openMembershipId,
      artifactRevision: retained.openRevision,
    },
    { ...request.endpoint, sourceEventId: retained.openRevision.tailEventId },
  ]) {
    vi.clearAllMocks();
    await expect(linkDatabaseReviewComment({ ...request, endpoint })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(
      vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
    ).toBe(true);
  }
  expect((await linkDatabaseReviewComment(request)).replayed).toBe(false);
});

it('rolls back a newly inserted link and both counters after a real late uniqueness failure', async () => {
  const { request, comment } = await capturedLinkFixture();
  const original = store.runProjectOperation;
  const injected = vi
    .spyOn(store, 'runProjectOperation')
    .mockImplementation((database, operation, settle, options) =>
      original(
        database,
        operation,
        (tx, prepared) =>
          settle(
            {
              ...tx,
              run(sql, ...parameters) {
                const result = tx.run(sql, ...parameters);
                if (sql.startsWith('INSERT INTO review_comment_claim_links'))
                  tx.run(sql, ...parameters);
                return result;
              },
            },
            prepared
          ),
        options
      )
    );
  try {
    await expect(linkDatabaseReviewComment(request)).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      reason: 'constraint',
    });
  } finally {
    injected.mockRestore();
  }
  const database = await store.openProjectDatabase({
    authority: request.authority,
    mode: 'reader',
  });
  try {
    const after = database.read((view) => ({
      link: view.get(
        'SELECT link_id FROM review_comment_claim_links WHERE link_id=?',
        request.linkId
      ),
      operation: view.get(
        'SELECT operation_id FROM operations WHERE operation_id=?',
        request.operationId
      ),
    }));
    expect(after.value).toEqual({ link: null, operation: null });
    expect(after.counters).toEqual(comment.counters);
  } finally {
    database.close();
  }
  const retried = await linkDatabaseReviewComment(request);
  expect(retried.replayed).toBe(false);
  expect(retried.counters).toEqual({
    writeSequence: comment.counters.writeSequence + 1,
    intentChangeCounter: comment.counters.intentChangeCounter + 1,
  });
});

it('copies original link targets and cancellation before asynchronous reads', async () => {
  const { request } = await capturedLinkFixture();
  const original = structuredClone(request);
  const started = linkDatabaseReviewComment(request);
  request.endpoint.position = 99;
  Reflect.set(request, 'actor', COMMENT_AUTHOR.REVIEWER);
  expect((await started).replayed).toBe(false);
  expect((await linkDatabaseReviewComment(original)).replayed).toBe(true);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  vi.clearAllMocks();
  const canceled = linkDatabaseReviewComment(
    { ...original, operationId: uuidv7(), linkId: uuidv7() },
    options
  );
  options.signal = new AbortController().signal;
  controller.abort();
  await expect(canceled).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  vi.clearAllMocks();
  await expect(
    linkDatabaseReviewComment({ ...original, commentId: 'ghp_' + 'A'.repeat(36) })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
});

it('returns an empty link collection only without retained links or their receipts', async () => {
  const { request, comment } = await capturedLinkFixture();
  vi.clearAllMocks();
  expect(
    await listDatabaseReviewCommentLinks({
      authority: request.authority,
      reviewId: request.reviewId,
    })
  ).toEqual({ value: { reviewId: request.reviewId, links: [] }, counters: comment.counters });
  expect(
    await readDatabaseReviewCommentLink({
      authority: request.authority,
      reviewId: request.reviewId,
      linkId: uuidv7(),
    })
  ).toEqual({ value: null, counters: comment.counters });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
});

it('decodes an original link collection snapshot after another link commits', async () => {
  const { request } = await capturedLinkFixture();
  const original = await linkDatabaseReviewComment(request);
  const database = await store.openProjectDatabase({
    authority: request.authority,
    mode: 'reader',
  });
  try {
    const snapshot = database.read((view) => snapshotReviewCommentLinks(view, request.reviewId));
    const next = await linkDatabaseReviewComment({
      ...request,
      operationId: uuidv7(),
      linkId: uuidv7(),
    });
    const copied = decodeReviewCommentLinks(snapshot);
    expect(copied.value.links.map((link) => link.linkId)).toEqual([request.linkId]);
    expect(copied.counters).toEqual(original.counters);
    const current = await listDatabaseReviewCommentLinks({
      authority: request.authority,
      reviewId: request.reviewId,
    });
    expect(current.value.links.map((link) => link.linkId)).toEqual([
      request.linkId,
      next.value.linkId,
    ]);
    expect(current.counters).toEqual(next.counters);
  } finally {
    database.close();
  }
});

it.each(['record', 'receipt', 'source'] as const)(
  'refuses missing or corrupted link %s without repairing history',
  async (damage) => {
    const { request } = await capturedLinkFixture();
    await linkDatabaseReviewComment(request);
    const Driver = createRequire(new URL('../../../storage/package.json', import.meta.url))(
      'better-sqlite3'
    );
    const database = new Driver(store.projectDatabasePath(request.authority));
    const trigger =
      damage === 'receipt'
        ? 'operations_no_delete'
        : damage === 'record'
          ? 'review_comment_claim_links_no_delete'
          : 'review_comment_claim_links_no_update';
    const definition = database
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(trigger) as { sql: string };
    database.pragma('foreign_keys=OFF');
    database.exec(`DROP TRIGGER ${trigger}`);
    try {
      if (damage === 'record')
        database
          .prepare('DELETE FROM review_comment_claim_links WHERE link_id=?')
          .run(request.linkId);
      else if (damage === 'receipt')
        database.prepare('DELETE FROM operations WHERE operation_id=?').run(request.operationId);
      else
        database.prepare('UPDATE review_comment_claim_links SET source_json=? WHERE link_id=?').run(
          JSON.stringify({
            kind: 'authored',
            eventId: uuidv7(),
            fieldPath: 'link',
            position: 0,
            actor: request.actor,
            at: request.at,
          }),
          request.linkId
        );
    } finally {
      database.exec(definition.sql);
      database.close();
    }
    vi.clearAllMocks();
    await expect(
      readDatabaseReviewCommentLink({
        authority: request.authority,
        reviewId: request.reviewId,
        linkId: request.linkId,
      })
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    await expect(
      listDatabaseReviewCommentLinks({ authority: request.authority, reviewId: request.reviewId })
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(
      vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
    ).toBe(true);
    expect(store.publishProjectEvidence).not.toHaveBeenCalled();
    if (damage === 'record') {
      expect((await linkDatabaseReviewComment(request)).replayed).toBe(true);
      await expect(
        readDatabaseReviewCommentLink({
          authority: request.authority,
          reviewId: request.reviewId,
          linkId: request.linkId,
        })
      ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    }
  }
);

it('rejects base progress committed after preparation without selecting its unused evidence', async () => {
  const f = await fixture(undefined, true);
  const prepared = await prepareDatabaseReviewFloor(f.input);
  const request = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    publicationId: uuidv7(),
    secretAllow: [],
    basis: prepared.basis,
    expected: prepared.expected,
    floorBytes: prepared.floorBytes,
    diffBytes: prepared.diffBytes,
  };
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  const revisionId = uuidv7();
  vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (...args) => {
    const published = await actual.publishProjectEvidence(...args);
    await changeDatabaseReviewBase({
      gitRoot: f.input.basis.gitRoot,
      authority: f.input.authority,
      reviewId: f.input.reviewId,
      operationId: uuidv7(),
      revisionId,
      expectedVersion: 0,
      baseBytes: bytes({
        kind: 'explicit',
        ref: 'HEAD',
        oid: f.input.basis.baseSha,
        recordedAt: f.input.generatedAt,
        source: null,
      }),
      secretAllow: [],
    });
    return published;
  });
  await expect(publishDatabaseReviewFloor(request)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const database = await store.openProjectDatabase({
    authority: f.input.authority,
    mode: 'reader',
  });
  try {
    expect(
      database.read((view) =>
        view.get(
          'SELECT base_revision_id, floor_publication_id, floor_version FROM review_selections WHERE review_id = ?',
          f.input.reviewId
        )
      ).value
    ).toEqual({ base_revision_id: revisionId, floor_publication_id: null, floor_version: 0 });
    expect(
      database.read((view) =>
        view.get('SELECT operation_id FROM operations WHERE operation_id = ?', request.operationId)
      ).value
    ).toBeNull();
  } finally {
    database.close();
  }
  expect(
    await readFile(
      path.join(
        path.dirname(store.projectDatabasePath(f.input.authority)),
        'evidence',
        request.publicationId,
        'floor.json'
      )
    )
  ).toEqual(prepared.floorBytes);
});

it('refuses escaped diff content before any owned connection in the complete publisher', async () => {
  const f = await fixture();
  const prepared = await prepareDatabaseReviewFloor(f.input);
  const secret = 'ghp_' + 'A'.repeat(36);
  const encoded = Array.from(secret)
    .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  const request = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    publicationId: uuidv7(),
    secretAllow: [],
    basis: prepared.basis,
    expected: prepared.expected,
    floorBytes: prepared.floorBytes,
    diffBytes: prepared.diffBytes,
  };
  vi.clearAllMocks();
  await expect(
    publishDatabaseReviewFloor({ ...request, diffBytes: Buffer.from(`+"${encoded}"\n`) })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  await expect(publishDatabaseReviewFloor(request)).resolves.toMatchObject({ replayed: false });
});

async function commentFixture() {
  const f = await fixture('const value = 1;\nconst added = 2;\nconst more = 3;\n');
  const floor = await prepareDatabaseReviewFloor(f.input);
  const publicationId = uuidv7();
  await publishDatabaseReviewFloor({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    publicationId,
    secretAllow: [],
    basis: floor.basis,
    expected: floor.expected,
    floorBytes: floor.floorBytes,
    diffBytes: floor.diffBytes,
  });
  const addHash = await lineHash('add', new TextEncoder().encode('const added = 2;'));
  const nextHash = await lineHash('add', new TextEncoder().encode('const more = 3;'));
  const event = {
    type: 'add' as const,
    comment_id: 'original-comment:question',
    ts: f.input.generatedAt,
    author: COMMENT_AUTHOR.REVIEWER,
    body: 'Explain this result.',
    anchor: {
      kind: 'DIFF_LINE' as const,
      file: 'value.ts',
      side: 'add' as const,
      line: 2,
      lineHash: addHash,
    },
  };
  expect(commentEventSchema.safeParse(event).success).toBe(true);
  const request = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    floorPublicationId: publicationId,
    expected: { floorVersion: 1, membershipRevisionId: f.input.expected.membershipRevisionId },
    commentBytes: bytes(event),
    secretAllow: [],
    gitRoot: f.input.basis.gitRoot,
  };
  vi.clearAllMocks();
  return { f, floor, request, event, addHash, nextHash };
}
it('prepares exact original comment bytes and ordered changed-row anchors from retained evidence', async () => {
  const f = await commentFixture();
  const exact = Buffer.from(JSON.stringify(f.event, null, 2) + '\n');
  const result = await prepareDatabaseReviewComment({ ...f.request, commentBytes: exact });
  expect(result.commentBytes).toEqual(exact);
  expect(result.comment.comment_id).toBe(f.event.comment_id);
  const ranged = {
    ...f.event,
    anchor: {
      ...f.event.anchor,
      kind: 'DIFF_RANGE',
      endLine: 3,
      lineHashes: [f.addHash, f.nextHash],
    },
  };
  const range = await prepareDatabaseReviewComment({ ...f.request, commentBytes: bytes(ranged) });
  expect(range.counters).toEqual(result.counters);
  expect(store.openProjectDatabase).not.toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'writer' })
  );
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('rejects schema-valid wrong diff positions, hashes, hunk and section identities', async () => {
  const f = await commentFixture();
  for (const anchor of [
    { ...f.event.anchor, line: 1 },
    { ...f.event.anchor, lineHash: f.nextHash },
    { ...f.event.anchor, hunkKey: 'foreign-hunk' },
    { ...f.event.anchor, threadKey: 'foreign-section' },
    { ...f.event.anchor, kind: 'DIFF_RANGE', endLine: 3, lineHashes: [f.addHash, f.addHash] },
  ]) {
    await expect(
      prepareDatabaseReviewComment({ ...f.request, commentBytes: bytes({ ...f.event, anchor }) })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(store.openProjectDatabase).not.toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'writer' })
  );
});
it('binds unchanged context to the retained pinned blob instead of current HEAD', async () => {
  const f = await commentFixture();
  const blob = await git(f.request.gitRoot, [
    'rev-parse',
    f.f.input.basis.pinnedTreeSha + ':value.ts',
  ]);
  const anchor = {
    kind: 'UNCHANGED_CONTEXT_LINE' as const,
    file: 'value.ts',
    headBlobOid: blob,
    line: 1,
    lineHash: await contextLineHash('const value = 1;'),
  };
  expect(await git(f.request.gitRoot, ['rev-parse', 'HEAD:value.ts'])).not.toBe(blob);
  const result = await prepareDatabaseReviewComment({
    ...f.request,
    commentBytes: bytes({ ...f.event, anchor }),
  });
  expect(result.comment.anchor).toEqual(anchor);
  for (const wrong of [
    { ...anchor, headBlobOid: await git(f.request.gitRoot, ['rev-parse', 'HEAD:value.ts']) },
    { ...anchor, line: 4, lineHash: await contextLineHash('') },
    { ...anchor, line: 2, lineHash: await contextLineHash('const added = 2;') },
    { ...anchor, file: '../value.ts' },
  ])
    await expect(
      prepareDatabaseReviewComment({
        ...f.request,
        commentBytes: bytes({ ...f.event, anchor: wrong }),
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it('refuses comment secrets before any connection and rejects a stale selected floor', async () => {
  const f = await commentFixture();
  const secret = 'ghp_' + 'A'.repeat(36);
  await expect(
    prepareDatabaseReviewComment({
      ...f.request,
      commentBytes: bytes({ ...f.event, body: secret }),
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  await expect(
    prepareDatabaseReviewComment({
      ...f.request,
      expected: { ...f.request.expected, floorVersion: 0 },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});
it('retains the original cancellation signal across immutable comment evidence reads', async () => {
  const f = await commentFixture();
  const original = new AbortController();
  const options = { signal: original.signal };
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  vi.mocked(store.readProjectEvidence).mockImplementationOnce(async (...args) => {
    const result = await actual.readProjectEvidence(...args);
    options.signal = new AbortController().signal;
    original.abort();
    return result;
  });
  await expect(prepareDatabaseReviewComment(f.request, options)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  expect(store.openProjectDatabase).not.toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'writer' })
  );
});
it('reports unavailable retained context evidence without substituting another checkout', async () => {
  const f = await commentFixture();
  const headBlobOid = await git(f.request.gitRoot, [
    'rev-parse',
    f.f.input.basis.pinnedTreeSha + ':value.ts',
  ]);
  const anchor = {
    kind: 'UNCHANGED_CONTEXT_LINE',
    file: 'value.ts',
    headBlobOid,
    line: 1,
    lineHash: await contextLineHash('const value = 1;'),
  };
  await rm(f.request.gitRoot, { recursive: true });
  await expect(
    prepareDatabaseReviewComment({ ...f.request, commentBytes: bytes({ ...f.event, anchor }) })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(store.openProjectDatabase).not.toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'writer' })
  );
});

async function commentRequest() {
  const f = await commentFixture();
  return { ...f, create: { ...f.request, operationId: uuidv7(), revisionId: uuidv7() } };
}
it('commits exact comment bytes, event identity and basis with an original replay receipt', async () => {
  const f = await commentRequest();
  f.create.commentBytes = Buffer.from(JSON.stringify(f.event, null, 2) + '\n');
  const before = await prepareDatabaseReviewComment(f.request);
  const result = await createDatabaseReviewComment(f.create);
  expect(result.counters.writeSequence).toBe(before.counters.writeSequence + 1);
  expect(result.counters.intentChangeCounter).toBe(before.counters.intentChangeCounter);
  const retained = await readDatabaseReviewComment({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    commentId: f.event.comment_id,
  });
  expect(retained.value!.revisions[0]!.bytes).toEqual(f.create.commentBytes);
  expect(retained.value!.revisions[0]!.source).toEqual({
    kind: 'authored',
    eventId: f.create.revisionId,
    fieldPath: 'comment',
    position: 0,
  });
  expect(retained.value!.revisions[0]!.operationId).toBe(f.create.operationId);
  expect(retained.value!.revisions[0]!.source.eventId).not.toBe(f.create.operationId);
  expect(retained.value!.revisions[0]!.basis.floorPublicationId).toBe(f.request.floorPublicationId);
  expect(retained.value!.comment.body).toBe(f.event.body);
  const projectDir = path.dirname(store.projectDatabasePath(f.request.authority));
  await rm(path.join(projectDir, 'evidence', f.request.floorPublicationId, 'floor.json'));
  await rm(f.request.gitRoot, { recursive: true });
  vi.clearAllMocks();
  expect((await createDatabaseReviewComment(f.create)).value).toEqual(result.value);
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  expect(
    (
      await readDatabaseReviewComment({
        authority: f.request.authority,
        reviewId: f.request.reviewId,
        commentId: f.event.comment_id,
        revisionId: f.create.revisionId,
      })
    ).counters
  ).toEqual(result.counters);
  await expect(
    createDatabaseReviewComment({
      ...f.create,
      commentBytes: bytes({ ...f.event, body: 'Changed authored content' }),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('permits independent comment additions and refuses a new operation reusing an existing identity', async () => {
  const f = await commentRequest();
  const other = {
    ...f.create,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    commentBytes: bytes({ ...f.event, comment_id: 'another-original-comment' }),
  };
  const results = await Promise.all([
    createDatabaseReviewComment(f.create),
    createDatabaseReviewComment(other),
  ]);
  expect(results.map((result) => result.value.commentId).sort()).toEqual(
    ['another-original-comment', f.event.comment_id].sort()
  );
  await expect(
    createDatabaseReviewComment({ ...f.create, operationId: uuidv7(), revisionId: uuidv7() })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});
it('refuses original comment content before any connection in the actual writer', async () => {
  const f = await commentRequest();
  const secret = 'ghp_' + 'A'.repeat(36);
  await expect(
    createDatabaseReviewComment({ ...f.create, commentBytes: bytes({ ...f.event, body: secret }) })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  const allowed = await createDatabaseReviewComment({
    ...f.create,
    commentBytes: bytes({ ...f.event, body: secret }),
    secretAllow: [secret],
  });
  const retained = await readDatabaseReviewComment({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    commentId: f.event.comment_id,
  });
  expect(retained.value!.comment.body).toBe(secret);
  expect(retained.counters).toEqual(allowed.counters);
});
it('rejects a membership selection changed after comment preparation before settlement', async () => {
  const f = await commentRequest();
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  let changed = false;
  vi.mocked(store.openProjectDatabase).mockImplementation(async (options) => {
    if (options.mode === 'writer' && !changed) {
      changed = true;
      await changeDatabaseReviewMembership({
        authority: f.request.authority,
        reviewId: f.request.reviewId,
        operationId: uuidv7(),
        secretAllow: [],
        membershipBytes: bytes({ revisionId: uuidv7(), members: [], source: null }),
        expected: { revisionId: f.request.expected.membershipRevisionId, version: 1 },
      });
    }
    return actual.openProjectDatabase(options);
  });
  try {
    await expect(createDatabaseReviewComment(f.create)).rejects.toMatchObject({
      code: 'STALE_CONTEXT',
    });
    expect(
      (
        await readDatabaseReviewComment({
          authority: f.request.authority,
          reviewId: f.request.reviewId,
          commentId: f.event.comment_id,
        })
      ).value
    ).toBeNull();
  } finally {
    vi.mocked(store.openProjectDatabase).mockImplementation(actual.openProjectDatabase);
  }
});
it('rolls back a late comment revision refusal and permits explicit original-operation retry', async () => {
  const f = await commentRequest();
  const Driver = createRequire(new URL('../../../storage/package.json', import.meta.url))(
    'better-sqlite3'
  ) as new (file: string) => { exec(sql: string): void; close(): void };
  const fixtureDb = new Driver(store.projectDatabasePath(f.request.authority));
  fixtureDb.exec(
    "CREATE TRIGGER refuse_comment BEFORE INSERT ON review_comment_revisions BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END"
  );
  const before = await prepareDatabaseReviewComment(f.request);
  try {
    await expect(createDatabaseReviewComment(f.create)).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      reason: 'constraint',
    });
    const missing = await readDatabaseReviewComment({
      authority: f.request.authority,
      reviewId: f.request.reviewId,
      commentId: f.event.comment_id,
    });
    expect(missing.value).toBeNull();
    expect(missing.counters).toEqual(before.counters);
    fixtureDb.exec('DROP TRIGGER refuse_comment');
    const result = await createDatabaseReviewComment(f.create);
    expect(result.replayed).toBe(false);
    expect(result.counters.writeSequence).toBe(before.counters.writeSequence + 1);
    expect((await createDatabaseReviewComment(f.create)).replayed).toBe(true);
  } finally {
    fixtureDb.close();
  }
});
async function commentBatch() {
  const f = await commentRequest();
  const added = await createDatabaseReviewComment(f.create);
  const request = {
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    commentId: f.event.comment_id,
    operationId: uuidv7(),
    expected: { revisionId: added.value.revisionId, version: 1 },
    membership: null,
    secretAllow: [],
    events: [
      {
        revisionId: uuidv7(),
        bytes: bytes({
          type: 'reply',
          comment_id: f.event.comment_id,
          ts: '2026-06-01T00:05:00.000Z',
          author: COMMENT_AUTHOR.AGENT,
          body: 'The retained result explains this.',
        }),
      },
      {
        revisionId: uuidv7(),
        bytes: bytes({
          type: 'status',
          comment_id: f.event.comment_id,
          ts: '2026-06-01T00:05:00.000Z',
          author: COMMENT_AUTHOR.REVIEWER,
          status: COMMENT_STATUS.RESOLVED,
        }),
      },
    ],
  };
  vi.clearAllMocks();
  return { f, added, request };
}
it('appends reply and resolve atomically with separate event identities and exact historical revisions', async () => {
  const f = await commentBatch();
  const result = await appendDatabaseReviewCommentEvents(f.request);
  expect(result.value).toMatchObject({ version: 3, revisionId: f.request.events[1]!.revisionId });
  expect(result.counters.writeSequence).toBe(f.added.counters.writeSequence + 1);
  expect(result.counters.intentChangeCounter).toBe(f.added.counters.intentChangeCounter);
  const read = await readDatabaseReviewComment({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    commentId: f.request.commentId,
  });
  expect(read.value!.comment.status).toBe(COMMENT_STATUS.RESOLVED);
  expect(read.value!.comment.replies[0]!.body).toBe('The retained result explains this.');
  expect(read.value!.revisions.slice(1).map((r) => r.bytes)).toEqual(
    f.request.events.map((e) => e.bytes)
  );
  expect(read.value!.revisions.slice(1).map((r) => r.source)).toEqual(
    f.request.events.map((e, position) => ({
      kind: 'authored',
      eventId: e.revisionId,
      fieldPath: 'events',
      position,
    }))
  );
  const old = await readDatabaseReviewComment({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    commentId: f.request.commentId,
    revisionId: f.request.events[0]!.revisionId,
  });
  expect(old.value!.comment.status).toBe(COMMENT_STATUS.OPEN);
  expect(old.value!.comment.replies).toHaveLength(1);
  vi.clearAllMocks();
  expect((await appendDatabaseReviewCommentEvents(f.request)).value).toEqual(result.value);
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  await expect(
    appendDatabaseReviewCommentEvents({ ...f.request, events: [f.request.events[0]!] })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('refuses all batch secrets and absent targets before opening a writer', async () => {
  const f = await commentBatch();
  const secret = 'ghp_' + 'A'.repeat(36);
  const last = f.request.events[1]!;
  await expect(
    appendDatabaseReviewCommentEvents({
      ...f.request,
      events: [
        f.request.events[0]!,
        {
          ...last,
          bytes: bytes({
            type: 'reply',
            comment_id: f.request.commentId,
            ts: '2026-06-01T00:05:00.000Z',
            author: COMMENT_AUTHOR.AGENT,
            body: secret,
          }),
        },
      ],
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  const missing = {
    ...f.request,
    commentId: 'missing',
    events: f.request.events.map((e) => ({
      ...e,
      bytes: bytes({ ...JSON.parse(e.bytes.toString()), comment_id: 'missing' }),
    })),
  };
  await expect(appendDatabaseReviewCommentEvents(missing)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(vi.mocked(store.openProjectDatabase).mock.calls.every(([v]) => v.mode === 'reader')).toBe(
    true
  );
});
it('does not make unrelated membership changes a reply or status conflict', async () => {
  const f = await commentBatch();
  await changeDatabaseReviewMembership({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    expected: { revisionId: f.f.request.expected.membershipRevisionId, version: 1 },
    membershipBytes: bytes({ revisionId: uuidv7(), members: [], source: null }),
  });
  await appendDatabaseReviewCommentEvents(f.request);
  const read = await readDatabaseReviewComment({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    commentId: f.request.commentId,
  });
  expect(read.value!.revisions[1]!.basis).toEqual(read.value!.revisions[0]!.basis);
  expect(read.value!.comment.status).toBe(COMMENT_STATUS.RESOLVED);
});
it('rejects a competing comment head while preserving the original batch for explicit reconsideration', async () => {
  const f = await commentBatch();
  await appendDatabaseReviewCommentEvents({
    ...f.request,
    operationId: uuidv7(),
    events: [{ ...f.request.events[0]!, revisionId: uuidv7() }],
  });
  await expect(appendDatabaseReviewCommentEvents(f.request)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const read = await readDatabaseReviewComment({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    commentId: f.request.commentId,
  });
  expect(read.value!.version).toBe(2);
  expect(read.value!.comment.status).toBe(COMMENT_STATUS.OPEN);
});
it('rolls back the entire comment batch when its second immutable revision is refused', async () => {
  const f = await commentBatch();
  const Driver = createRequire(new URL('../../../storage/package.json', import.meta.url))(
    'better-sqlite3'
  ) as new (file: string) => { exec(sql: string): void; close(): void };
  const raw = new Driver(store.projectDatabasePath(f.request.authority));
  raw.exec(
    "CREATE TRIGGER refuse_last_comment BEFORE INSERT ON review_comment_revisions WHEN NEW.version = 3 BEGIN SELECT RAISE(ABORT, 'fixture last event refusal'); END"
  );
  try {
    await expect(appendDatabaseReviewCommentEvents(f.request)).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      reason: 'constraint',
    });
    const read = await readDatabaseReviewComment({
      authority: f.request.authority,
      reviewId: f.request.reviewId,
      commentId: f.request.commentId,
    });
    expect(read.value!.revisions).toHaveLength(1);
    expect(read.counters).toEqual(f.added.counters);
    raw.exec('DROP TRIGGER refuse_last_comment');
    const settled = await appendDatabaseReviewCommentEvents(f.request);
    expect(settled.value.version).toBe(3);
    expect(settled.counters.writeSequence).toBe(f.added.counters.writeSequence + 1);
  } finally {
    raw.close();
  }
});
it('lists complete comment histories in original reducer order with exact selected heads', async () => {
  const f = await commentBatch();
  await appendDatabaseReviewCommentEvents(f.request);
  const other = await createDatabaseReviewComment({
    ...f.f.create,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    commentBytes: bytes({
      ...f.f.event,
      comment_id: 'another-original',
      ts: '2026-05-01T00:00:00.000Z',
    }),
  });
  vi.clearAllMocks();
  const listed = await listDatabaseReviewComments({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  expect(listed.value.comments.map((comment) => comment.commentId)).toEqual([
    'another-original',
    f.request.commentId,
  ]);
  expect(listed.value.comments[1]!.comment.status).toBe(COMMENT_STATUS.RESOLVED);
  expect(listed.value.comments[1]!.revisions).toHaveLength(3);
  expect(listed.value.heads).toEqual([
    { commentId: 'another-original', revisionId: other.value.revisionId, version: 1 },
    { commentId: f.request.commentId, revisionId: f.request.events[1]!.revisionId, version: 3 },
  ]);
  expect(listed.counters).toEqual(other.counters);
  expect(vi.mocked(store.openProjectDatabase).mock.calls.every(([v]) => v.mode === 'reader')).toBe(
    true
  );
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('returns an empty collection only when no comment history exists', async () => {
  const f = await commentRequest();
  const listed = await listDatabaseReviewComments({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  expect(listed.value.comments).toEqual([]);
  expect(listed.value.heads).toEqual([]);
});
it('preserves a copied comment snapshot while a later batch commits before hydration', async () => {
  const f = await commentBatch();
  const database = await store.openProjectDatabase({
    authority: f.request.authority,
    mode: 'reader',
  });
  try {
    const snapshot = database.read((view) => snapshotReviewComments(view, f.request.reviewId));
    const appended = await appendDatabaseReviewCommentEvents(f.request);
    const old = hydrateReviewComments(snapshot.value);
    expect(old.comments[0]!.comment.status).toBe(COMMENT_STATUS.OPEN);
    expect(old.comments[0]!.revisions).toHaveLength(1);
    expect(snapshot.counters).toEqual(f.added.counters);
    const current = await listDatabaseReviewComments({
      authority: f.request.authority,
      reviewId: f.request.reviewId,
    });
    expect(current.value.comments[0]!.comment.status).toBe(COMMENT_STATUS.RESOLVED);
    expect(current.counters).toEqual(appended.counters);
  } finally {
    database.close();
  }
});
it('refuses orphaned retained revisions in a review-wide collection without repairing headers', async () => {
  const f = await commentBatch();
  const Driver = createRequire(new URL('../../../storage/package.json', import.meta.url))(
    'better-sqlite3'
  ) as new (file: string) => { exec(sql: string): void; close(): void };
  const raw = new Driver(store.projectDatabasePath(f.request.authority));
  raw.exec('PRAGMA foreign_keys=OFF; DELETE FROM review_comments');
  raw.close();
  vi.clearAllMocks();
  await expect(
    listDatabaseReviewComments({ authority: f.request.authority, reviewId: f.request.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(vi.mocked(store.openProjectDatabase).mock.calls.every(([v]) => v.mode === 'reader')).toBe(
    true
  );
  const check = await store.openProjectDatabase({ authority: f.request.authority, mode: 'reader' });
  try {
    const retained = check.read((view) => ({
      headers: view.all('SELECT * FROM review_comments'),
      rows: view.get<{ count: number }>('SELECT count(*) AS count FROM review_comment_revisions'),
    }));
    expect(retained.value.headers).toEqual([]);
    expect(retained.value.rows!.count).toBe(1);
    expect(retained.counters).toEqual(f.added.counters);
  } finally {
    check.close();
  }
});

async function gapWorkflowRequest() {
  const f = await commentFixture();
  const floor = JSON.parse(f.floor.floorBytes.toString('utf8'));
  const rows = await buildCurrentGapRows(floor, f.floor.diffBytes.toString('utf8'));
  expect(rows.length).toBeGreaterThan(0);
  const event = {
    type: 'unassigned' as const,
    ts: f.f.input.generatedAt,
    action: 'MARK_INSPECTED' as const,
    target: {
      kind: 'GAP_ROWS' as const,
      coveredRows: [rows[0]!],
      coveredRowsDigest: await reviewedRowsDigest([rows[0]!]),
    },
  };
  const request = {
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    expected: {
      floor: { publicationId: f.request.floorPublicationId, version: 1 },
      targets: [
        { targetKey: workflowTarget(event), revisionId: null as string | null, version: 0 },
      ],
    },
    events: [
      { revisionId: uuidv7(), bytes: bytes(event) },
      { revisionId: uuidv7(), bytes: bytes(event) },
    ],
  };
  vi.clearAllMocks();
  return { f, request, event };
}

it('settles same-target workflow events atomically against actual retained gap rows', async () => {
  const { request, event } = await gapWorkflowRequest();
  const before = await readDatabaseReviewWorkflow({
    authority: request.authority,
    reviewId: request.reviewId,
  });
  const written = await appendDatabaseReviewWorkflowEvents(request);
  const read = await readDatabaseReviewWorkflow({
    authority: request.authority,
    reviewId: request.reviewId,
  });
  expect(written.replayed).toBe(false);
  expect(read.value.events).toEqual([event, event]);
  expect(read.value.revisions.map((revision) => revision.bytes)).toEqual(
    request.events.map((event) => event.bytes)
  );
  expect(read.value.revisions.map((revision) => revision.version)).toEqual([1, 2]);
  expect(read.counters.writeSequence).toBe(before.counters.writeSequence + 1);
  expect(read.counters.intentChangeCounter).toBe(before.counters.intentChangeCounter);
  const replay = await appendDatabaseReviewWorkflowEvents(request);
  expect(replay).toMatchObject({
    replayed: true,
    value: written.value,
    counters: written.counters,
  });
  await expect(
    appendDatabaseReviewWorkflowEvents({ ...request, operationId: uuidv7() })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

it('refuses forged gap content and nonexistent section targets before writer open', async () => {
  const { request, event } = await gapWorkflowRequest();
  const rows = [{ ...event.target.coveredRows[0]!, lineHash: 'different-content' }];
  const forged = {
    ...event,
    target: {
      ...event.target,
      coveredRows: rows,
      coveredRowsDigest: await reviewedRowsDigest(rows),
    },
  };
  const section = {
    type: 'section' as const,
    ts: event.ts,
    threadKey: 'nonexistent-section',
    action: 'VISIT' as const,
  };
  for (const invalidEvent of [forged, section]) {
    vi.clearAllMocks();
    await expect(
      appendDatabaseReviewWorkflowEvents({
        ...request,
        expected: {
          ...request.expected,
          targets: [{ targetKey: workflowTarget(invalidEvent), revisionId: null, version: 0 }],
        },
        events: [{ revisionId: uuidv7(), bytes: bytes(invalidEvent) }],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
    ).toBe(true);
  }
});

it('refuses stale floor selection and an unavailable Story question before writer open', async () => {
  const { request, event } = await gapWorkflowRequest();
  await expect(
    appendDatabaseReviewWorkflowEvents({
      ...request,
      expected: { ...request.expected, floor: { ...request.expected.floor, version: 0 } },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  const question = {
    type: 'prompt' as const,
    ts: event.ts,
    promptKey: 'missing-question',
    action: 'ACKNOWLEDGE' as const,
  };
  await expect(
    appendDatabaseReviewWorkflowEvents({
      ...request,
      expected: {
        ...request.expected,
        story: { publicationId: null, version: 0 },
        targets: [{ targetKey: workflowTarget(question), revisionId: null, version: 0 }],
      },
      events: [{ revisionId: uuidv7(), bytes: bytes(question) }],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
});

it('replays the original workflow receipt after its retained floor file disappears', async () => {
  const { request } = await gapWorkflowRequest();
  const accepted = await appendDatabaseReviewWorkflowEvents(request);
  const db = await store.openProjectDatabase({ authority: request.authority, mode: 'reader' });
  let relativePath: string;
  try {
    relativePath = db.read((view) =>
      view.get<{ relative_path: string }>(
        "SELECT relative_path FROM review_evidence_members WHERE publication_id = ? AND name = 'floor.json'",
        request.expected.floor.publicationId
      )
    ).value!.relative_path;
  } finally {
    db.close();
  }
  const missing = path.join(
    path.dirname(store.projectDatabasePath(request.authority)),
    relativePath
  );
  await rm(missing);
  vi.clearAllMocks();
  expect(await appendDatabaseReviewWorkflowEvents(request)).toEqual({
    ...accepted,
    replayed: true,
  });
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  const changed = {
    ...request,
    events: request.events.map((event) => ({
      ...event,
      bytes: Buffer.concat([event.bytes, Buffer.from(' ')]),
    })),
  };
  await expect(appendDatabaseReviewWorkflowEvents(changed)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  await expect(readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains the original workflow cancellation signal and refuses a later secret before opening', async () => {
  const { request, event } = await gapWorkflowRequest();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const pending = appendDatabaseReviewWorkflowEvents(request, options);
  options.signal = new AbortController().signal;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  const secret = 'ghp_' + 'A'.repeat(36);
  const unsafe = {
    type: 'section' as const,
    ts: event.ts,
    threadKey: 'section',
    action: 'PARTIAL' as const,
    reason: secret,
  };
  await expect(
    appendDatabaseReviewWorkflowEvents({
      ...request,
      events: [request.events[0]!, { revisionId: uuidv7(), bytes: bytes(unsafe) }],
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
});

it('rolls back appended workflow rows when a late current-head constraint fails', async () => {
  const { request } = await gapWorkflowRequest();
  const original = store.runProjectOperation;
  const injected = vi
    .spyOn(store, 'runProjectOperation')
    .mockImplementation((database, operation, settle, options) =>
      original(
        database,
        operation,
        (tx, prepared) =>
          settle(
            {
              ...tx,
              run(sql, ...parameters) {
                if (sql.startsWith('INSERT INTO review_workflow_current')) {
                  const broken = [...parameters];
                  broken[3] = -1;
                  return tx.run(sql, ...broken);
                }
                return tx.run(sql, ...parameters);
              },
            },
            prepared
          ),
        options
      )
    );
  const before = await readDatabaseReviewWorkflow({
    authority: request.authority,
    reviewId: request.reviewId,
  });
  try {
    await expect(appendDatabaseReviewWorkflowEvents(request)).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      reason: 'constraint',
    });
  } finally {
    injected.mockRestore();
  }
  const after = await readDatabaseReviewWorkflow({
    authority: request.authority,
    reviewId: request.reviewId,
  });
  expect(after).toEqual(before);
  const retried = await appendDatabaseReviewWorkflowEvents(request);
  expect(retried.replayed).toBe(false);
  expect(
    (await readDatabaseReviewWorkflow({ authority: request.authority, reviewId: request.reviewId }))
      .value.revisions
  ).toHaveLength(2);
});

it('allows an independent workflow target to commit during immutable floor hydration', async () => {
  const { f, request, event } = await gapWorkflowRequest();
  const floor = JSON.parse(f.floor.floorBytes.toString());
  const rows = await buildCurrentGapRows(floor, f.floor.diffBytes.toString());
  const otherRow = rows.find((row) => row.lineHash !== event.target.coveredRows[0]!.lineHash)!;
  expect(otherRow).toBeDefined();
  const otherEvent = {
    ...event,
    target: {
      ...event.target,
      coveredRows: [otherRow],
      coveredRowsDigest: await reviewedRowsDigest([otherRow]),
    },
  };
  const otherRequest = {
    ...request,
    operationId: uuidv7(),
    expected: {
      ...request.expected,
      targets: [{ targetKey: workflowTarget(otherEvent), revisionId: null, version: 0 }],
    },
    events: [{ revisionId: uuidv7(), bytes: bytes(otherEvent) }],
  };
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  let intervened = false;
  vi.mocked(store.readProjectEvidence).mockImplementationOnce(async (...args) => {
    const retained = await actual.readProjectEvidence(...args);
    await appendDatabaseReviewWorkflowEvents(otherRequest);
    intervened = true;
    return retained;
  });
  const accepted = await appendDatabaseReviewWorkflowEvents(request);
  expect(intervened).toBe(true);
  expect(accepted.value.revisions.map((revision) => revision.sequence)).toEqual([2, 3]);
  const read = await readDatabaseReviewWorkflow({
    authority: request.authority,
    reviewId: request.reviewId,
  });
  expect(read.value.events).toEqual([otherEvent, event, event]);
  expect(read.value.heads).toHaveLength(2);
});

async function workflowEventRequest(
  f: Awaited<ReturnType<typeof commentFixture>>,
  event: JournalEvent
) {
  const workflow = await readDatabaseReviewWorkflow({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  const targetKey = workflowTarget(event);
  const head = workflow.value.heads.find((head) => head.targetKey === targetKey);
  return {
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    expected: {
      floor: { publicationId: f.request.floorPublicationId, version: 1 },
      ...(event.type === 'review_lifecycle' ? { story: { publicationId: null, version: 0 } } : {}),
      targets: [{ targetKey, revisionId: head?.revisionId ?? null, version: head?.version ?? 0 }],
    },
    events: [{ revisionId: uuidv7(), bytes: bytes(event) }],
  };
}
async function lifecycleEventRequest(
  f: Awaited<ReturnType<typeof commentFixture>>,
  action: 'COMPLETE' | 'PARTIAL' | 'REOPEN'
) {
  const workflow = await readDatabaseReviewWorkflow({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  const event: JournalEvent = {
    type: 'review_lifecycle',
    ts: f.f.input.generatedAt,
    action,
    review_basis: 'FLOOR_ONLY',
    floor_input_hash: JSON.parse(f.floor.floorBytes.toString()).input_hash,
    story_generation: null,
    ledger_generation: workflow.value.ledgerGeneration,
    actor: 'REVIEWER',
    source: 'WATCH',
    ...(action === 'PARTIAL' ? { remaining_work: 'Inspect remaining rows.' } : {}),
  };
  return workflowEventRequest(f, event);
}
async function inspectGapRows(f: Awaited<ReturnType<typeof commentFixture>>) {
  const rows = await buildCurrentGapRows(
    JSON.parse(f.floor.floorBytes.toString()),
    f.floor.diffBytes.toString()
  );
  expect(rows.length).toBeGreaterThan(0);
  return appendDatabaseReviewWorkflowEvents(
    await workflowEventRequest(f, {
      type: 'unassigned',
      ts: f.f.input.generatedAt,
      action: 'MARK_INSPECTED',
      target: {
        kind: 'GAP_ROWS',
        coveredRows: rows,
        coveredRowsDigest: await reviewedRowsDigest(rows),
      },
    })
  );
}

it('enforces the actual floor completion gate and explicit lifecycle transitions', async () => {
  const f = await commentFixture();
  await expect(
    appendDatabaseReviewWorkflowEvents(await lifecycleEventRequest(f, 'COMPLETE'))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  await appendDatabaseReviewWorkflowEvents(await lifecycleEventRequest(f, 'PARTIAL'));
  await expect(
    appendDatabaseReviewWorkflowEvents(await lifecycleEventRequest(f, 'COMPLETE'))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await appendDatabaseReviewWorkflowEvents(await lifecycleEventRequest(f, 'REOPEN'));
  await expect(
    appendDatabaseReviewWorkflowEvents(await lifecycleEventRequest(f, 'REOPEN'))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await inspectGapRows(f);
  const request = await lifecycleEventRequest(f, 'COMPLETE');
  const accepted = await appendDatabaseReviewWorkflowEvents(request);
  const read = await readDatabaseReviewWorkflow({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  expect(read.value.events.map((event) => event.type)).toEqual([
    'review_lifecycle',
    'review_lifecycle',
    'unassigned',
    'review_lifecycle',
  ]);
  expect(read.value.revisions.at(-1)!.basis.comments).toEqual([]);
  expect(read.value.revisions.at(-1)!.basis.ledger!.sequence).toBe(3);
  expect(await appendDatabaseReviewWorkflowEvents(request)).toEqual({
    ...accepted,
    replayed: true,
  });
});

it('rejects a lifecycle operation when another journal event commits during preparation', async () => {
  const f = await commentFixture();
  const request = await lifecycleEventRequest(f, 'PARTIAL');
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  vi.mocked(store.readProjectEvidence).mockImplementationOnce(async (...args) => {
    const retained = await actual.readProjectEvidence(...args);
    await inspectGapRows(f);
    return retained;
  });
  await expect(appendDatabaseReviewWorkflowEvents(request)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const read = await readDatabaseReviewWorkflow({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  expect(read.value.events).toHaveLength(1);
  expect(read.value.events[0]!.type).toBe('unassigned');
  await expect(
    appendDatabaseReviewWorkflowEvents(await lifecycleEventRequest(f, 'PARTIAL'))
  ).resolves.toMatchObject({ replayed: false });
});

it('rejects a prepared completion when a reviewer comment arrives and requires its resolution', async () => {
  const f = await commentFixture();
  await inspectGapRows(f);
  const request = await lifecycleEventRequest(f, 'COMPLETE');
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  let added: Awaited<ReturnType<typeof createDatabaseReviewComment>>;
  vi.mocked(store.readProjectEvidence).mockImplementationOnce(async (...args) => {
    const retained = await actual.readProjectEvidence(...args);
    added = await createDatabaseReviewComment({
      ...f.request,
      operationId: uuidv7(),
      revisionId: uuidv7(),
    });
    return retained;
  });
  await expect(appendDatabaseReviewWorkflowEvents(request)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(
    (
      await readDatabaseReviewWorkflow({
        authority: f.request.authority,
        reviewId: f.request.reviewId,
      })
    ).value.events
  ).toHaveLength(1);
  vi.clearAllMocks();
  await expect(
    appendDatabaseReviewWorkflowEvents(await lifecycleEventRequest(f, 'COMPLETE'))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  await appendDatabaseReviewCommentEvents({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    commentId: added!.value.commentId,
    expected: { revisionId: added!.value.revisionId, version: 1 },
    membership: null,
    events: [
      {
        revisionId: uuidv7(),
        bytes: bytes({
          type: 'status',
          comment_id: added!.value.commentId,
          ts: f.f.input.generatedAt,
          author: COMMENT_AUTHOR.REVIEWER,
          status: COMMENT_STATUS.RESOLVED,
        }),
      },
    ],
  });
  await appendDatabaseReviewWorkflowEvents(await lifecycleEventRequest(f, 'COMPLETE'));
  const read = await readDatabaseReviewWorkflow({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  expect(read.value.revisions.at(-1)!.basis.comments).toEqual([
    expect.objectContaining({ commentId: added!.value.commentId, version: 2 }),
  ]);
});

it('refuses newly retained completion dependencies unless their historical secret identity is explicitly allowed', async () => {
  const f = await commentFixture();
  const secret = 'ghp_' + 'A'.repeat(36);
  const added = await createDatabaseReviewComment({
    ...f.request,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    secretAllow: [secret],
    commentBytes: bytes({ ...f.event, comment_id: secret }),
  });
  await appendDatabaseReviewCommentEvents({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    operationId: uuidv7(),
    secretAllow: [secret],
    commentId: secret,
    expected: { revisionId: added.value.revisionId, version: 1 },
    membership: null,
    events: [
      {
        revisionId: uuidv7(),
        bytes: bytes({
          type: 'status',
          comment_id: secret,
          ts: f.f.input.generatedAt,
          author: COMMENT_AUTHOR.REVIEWER,
          status: COMMENT_STATUS.RESOLVED,
        }),
      },
    ],
  });
  await inspectGapRows(f);
  const request = await lifecycleEventRequest(f, 'COMPLETE');
  vi.clearAllMocks();
  await expect(appendDatabaseReviewWorkflowEvents(request)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  await expect(
    appendDatabaseReviewWorkflowEvents({ ...request, secretAllow: [secret] })
  ).resolves.toMatchObject({ replayed: false });
});

it('prepares an authored explicit policy while retaining the original base selection and bytes', async () => {
  const f = await fixture(undefined, true);
  const selectedRevision = uuidv7();
  await changeDatabaseReviewBase({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    revisionId: selectedRevision,
    expectedVersion: 0,
    gitRoot: f.input.basis.gitRoot,
    baseBytes: bytes({
      kind: 'explicit',
      ref: 'original',
      oid: f.input.basis.baseSha,
      recordedAt: f.input.generatedAt,
      source: null,
    }),
    secretAllow: [],
  });
  const baseTree = await git(f.input.basis.gitRoot, [
    'rev-parse',
    `${f.input.basis.baseSha}^{tree}`,
  ]);
  const authored = Buffer.from(
    JSON.stringify(
      {
        kind: 'explicit',
        ref: 'résumé-ref',
        oid: baseTree,
        recordedAt: f.input.generatedAt,
        source: null,
      },
      null,
      3
    ) + '\n'
  );
  const revisionId = uuidv7();
  const input = {
    ...f.input,
    expected: { ...f.input.expected, baseRevisionId: selectedRevision, baseVersion: 1 },
    basis: { ...f.input.basis, baseSha: baseTree },
    base: { revisionId, bytes: authored },
  };
  const database = await store.openProjectDatabase({
    authority: f.input.authority,
    mode: 'reader',
  });
  const before = database.read((view) => view.all('SELECT * FROM review_selections'));
  database.close();
  const refs = await git(f.input.basis.gitRoot, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/orcaops/',
  ]);
  const expectedBytes = Buffer.from(authored);
  const preparing = prepareDatabaseReviewFloor(input);
  authored.fill(0);
  input.base.revisionId = uuidv7();
  const prepared = await preparing;
  expect(prepared.base?.revisionId).toBe(revisionId);
  expect(prepared.base?.bytes).toEqual(expectedBytes);
  expect(JSON.parse(prepared.floorBytes.toString()).scope.base_sha).toBe(baseTree);
  expect(prepared.retentionTarget).toEqual({
    kind: 'review',
    reviewId: f.input.reviewId,
    membershipRevisionId: f.input.expected.membershipRevisionId,
    membershipVersion: 1,
    baseRevisionId: selectedRevision,
    baseVersion: 1,
    floorPublicationId: null,
    floorVersion: 0,
    runId: null,
    runRevisionId: null,
    runSelectionVersion: 0,
  });
  expect(prepared.counters).toEqual(before.counters);
  const after = await store.openProjectDatabase({ authority: f.input.authority, mode: 'reader' });
  try {
    expect(after.read((view) => view.all('SELECT * FROM review_selections'))).toEqual(before);
  } finally {
    after.close();
  }
  expect(
    await git(f.input.basis.gitRoot, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/orcaops/',
    ])
  ).toBe(refs);
});
it('prepares an authored auto policy against the supplied resolved base without selecting it', async () => {
  const f = await fixture(undefined, true);
  const selectedRevision = uuidv7();
  await changeDatabaseReviewBase({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    revisionId: selectedRevision,
    expectedVersion: 0,
    gitRoot: f.input.basis.gitRoot,
    baseBytes: bytes({
      kind: 'explicit',
      ref: 'old-base',
      oid: f.input.basis.baseSha,
      recordedAt: f.input.generatedAt,
      source: null,
    }),
    secretAllow: [],
  });
  const input = {
    ...f.input,
    expected: { ...f.input.expected, baseRevisionId: selectedRevision, baseVersion: 1 },
    basis: { ...f.input.basis, baseSha: f.input.basis.pinnedTreeSha },
  };
  await expect(prepareDatabaseReviewFloor(input)).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  const original = bytes({ kind: 'auto', recordedAt: f.input.generatedAt, source: null });
  const prepared = await prepareDatabaseReviewFloor({
    ...input,
    base: { revisionId: uuidv7(), bytes: original },
  });
  expect(prepared.base?.bytes).toEqual(original);
  expect(JSON.parse(prepared.floorBytes.toString()).scope.base_sha).toBe(
    f.input.basis.pinnedTreeSha
  );
  expect(prepared.retentionTarget.baseRevisionId).toBe(selectedRevision);
  expect(prepared.diffBytes.toString()).toBe('');
});
it('rejects an authored floor base that differs from its exact resolved object', async () => {
  const f = await fixture();
  await expect(
    prepareDatabaseReviewFloor({
      ...f.input,
      base: {
        revisionId: uuidv7(),
        bytes: bytes({
          kind: 'explicit',
          ref: 'new-base',
          oid: f.input.basis.pinnedTreeSha,
          recordedAt: f.input.generatedAt,
          source: null,
        }),
      },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});
it('refuses a secret in proposed floor policy before opening the database', async () => {
  const f = await fixture();
  vi.clearAllMocks();
  await expect(
    prepareDatabaseReviewFloor({
      ...f.input,
      base: {
        revisionId: uuidv7(),
        bytes: bytes({
          kind: 'explicit',
          ref: 'sk-proj-' + 'x'.repeat(60),
          oid: f.input.basis.baseSha,
          recordedAt: f.input.generatedAt,
          source: null,
        }),
      },
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
});

it('validates the old selected base even when a new effective floor policy is supplied', async () => {
  const f = await fixture();
  const selectedRevision = uuidv7();
  await changeDatabaseReviewBase({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    revisionId: selectedRevision,
    expectedVersion: 0,
    baseBytes: bytes({ kind: 'auto', recordedAt: f.input.generatedAt, source: null }),
    secretAllow: [],
  });
  await exec(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { createRequire } from 'node:module';
    const Database = createRequire(process.argv[1])('better-sqlite3');
    const database = new Database(process.argv[2]);
    try {
      const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'review_base_revisions_no_update'").get();
      database.exec('DROP TRIGGER review_base_revisions_no_update');
      database.prepare('UPDATE review_base_revisions SET record_hash = ? WHERE revision_id = ?').run('0'.repeat(64), process.argv[3]);
      database.exec(trigger.sql);
    } finally { database.close(); }
  `,
    path.resolve(import.meta.dirname, '../../../storage/package.json'),
    store.projectDatabasePath(f.input.authority),
    selectedRevision,
  ]);
  await expect(
    prepareDatabaseReviewFloor({
      ...f.input,
      expected: { ...f.input.expected, baseRevisionId: selectedRevision, baseVersion: 1 },
      base: {
        revisionId: uuidv7(),
        bytes: bytes({ kind: 'auto', recordedAt: f.input.generatedAt, source: null }),
      },
    })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
});
it('retains historical floor inputs when later artifact checkpoints append before publication', async () => {
  const { f, artifactId, revision, membershipRevisionId } = await retainedCheckpointFixture();
  const prepared = await prepareDatabaseReviewFloor({
    ...f.input,
    expected: { ...f.input.expected, membershipRevisionId, membershipVersion: 2 },
  });
  const request = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    publicationId: uuidv7(),
    secretAllow: [],
    basis: prepared.basis,
    expected: prepared.expected,
    floorBytes: prepared.floorBytes,
    diffBytes: prepared.diffBytes,
  };
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  let appended: store.ArtifactRevision | null = null;
  vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (...args) => {
    const database = await store.openProjectDatabase({
      authority: f.input.authority,
      mode: 'writer',
    });
    try {
      const thread = store.readProjectArtifact(database, artifactId, revision)!.thread;
      const open = [...thread.events]
        .reverse()
        .find((event) => event.record.type === 'checkpoint_opened')!;
      const close = [...thread.events]
        .reverse()
        .find((event) => event.record.type === 'checkpoint_closed')!;
      const eventBytes = [open, close].map((event) => {
        const wire = {
          ...event.record,
          event_id: uuidv7(),
          idempotency_key: uuidv7(),
          ts: '2026-06-01T00:10:00.000Z',
          payload: {
            ...(event.payload as Record<string, unknown>),
            n: 2,
            ...(event.record.type === 'checkpoint_closed'
              ? { summary: 'Later retained outcome', completed_step_ids: [] }
              : {}),
          },
        };
        const { checksum: _checksum, ...body } = wire;
        return Buffer.from(
          JSON.stringify({
            ...body,
            checksum: createHash('sha256').update(canonicalJson(body)).digest('hex'),
          }) + '\n'
        );
      });
      appended = (
        await store.appendProjectArtifactEvents(database, {
          operationId: uuidv7(),
          artifactId,
          expectedRevision: revision,
          eventBytes: Buffer.concat(eventBytes),
          sidecarPayloads: [],
          secretAllow: [],
        })
      ).value.revision;
      expect(
        store
          .readProjectArtifact(database, artifactId)!
          .thread.checkpoints.filter((cp) => cp.status === 'closed')
      ).toHaveLength(2);
    } finally {
      database.close();
    }
    return actual.publishProjectEvidence(...args);
  });
  const result = await publishDatabaseReviewFloor(request);
  expect(appended).not.toBeNull();
  const read = await readDatabaseReviewFloor({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(read.value!.floorBytes).toEqual(prepared.floorBytes);
  expect(read.value!.membershipRevisionId).toBe(membershipRevisionId);
  expect(read.value!.floor.outline.threads[0]!.checkpoints).toHaveLength(1);
  expect(read.value!.sourceWriteSequence).toBe(prepared.counters.writeSequence);
  expect(result.counters.writeSequence).toBe(prepared.counters.writeSequence + 3);
  expect(read.counters).toEqual(result.counters);
  expect(read.value!.sourceWriteSequence).toBeLessThan(read.counters.writeSequence);
}, 15000);
it('reports unknown source provenance for an older row-only floor without replacing its read clock', async () => {
  const f = await fixture();
  const prepared = await prepareDatabaseReviewFloor(f.input);
  const publicationId = uuidv7();
  const operationId = uuidv7();
  const floor = JSON.parse(prepared.floorBytes.toString('utf8')) as Floor;
  const { gitRoot: _gitRoot, ...basis } = prepared.basis;
  const database = await store.openProjectDatabase({
    authority: f.input.authority,
    mode: 'writer',
  });
  try {
    const descriptors = await store.publishProjectEvidence(database, {
      publicationId,
      members: [
        { name: 'floor.json', bytes: prepared.floorBytes },
        { name: 'diff.patch', bytes: prepared.diffBytes },
      ],
      secretAllow: [],
    });
    await store.runProjectOperation(
      database,
      {
        operationId,
        kind: 'review.floor',
        target: { reviewId: f.input.reviewId },
        payload: {
          publicationId,
          basis,
          floorBytes: prepared.floorBytes.toString('base64'),
          diffBytes: prepared.diffBytes.toString('base64'),
        },
        expectedState: prepared.expected,
        intentChange: false,
      },
      (tx) => {
        tx.run(
          'INSERT INTO review_evidence_publications VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)',
          publicationId,
          f.input.reviewId,
          'floor',
          operationId,
          prepared.expected.membershipRevisionId,
          floor.input_hash,
          canonicalJson({ schemaVersion: floor.schema_version })
        );
        for (const member of descriptors) {
          const isFloor = member.relativePath.endsWith('/floor.json');
          tx.run(
            'INSERT INTO review_evidence_members VALUES (?, ?, ?, ?, ?, ?, ?)',
            publicationId,
            isFloor ? 'floor.json' : 'diff.patch',
            isFloor ? 'floor' : 'diff',
            isFloor ? floor.schema_version : null,
            member.relativePath,
            member.sha256,
            member.byteLength
          );
        }
        tx.run(
          'UPDATE review_selections SET floor_publication_id = ?, floor_version = 1 WHERE review_id = ?',
          publicationId,
          f.input.reviewId
        );
        return {
          reviewId: f.input.reviewId,
          publicationId,
          floorVersion: 1,
          floorInputHash: floor.input_hash,
        };
      }
    );
  } finally {
    database.close();
  }
  const read = await readDatabaseReviewFloor({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(read.value!.floorBytes).toEqual(prepared.floorBytes);
  expect(read.value!.sourceWriteSequence).toBeNull();
  expect(read.counters.writeSequence).toBeGreaterThan(prepared.counters.writeSequence);
}, 15000);
it('refuses a partially missing retained floor source instead of reporting unknown provenance', async () => {
  const f = await fixture();
  const prepared = await prepareDatabaseReviewFloor(f.input);
  const operationId = uuidv7();
  await publishDatabaseReviewFloor({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId,
    publicationId: uuidv7(),
    secretAllow: [],
    basis: prepared.basis,
    expected: prepared.expected,
    floorBytes: prepared.floorBytes,
    diffBytes: prepared.diffBytes,
  });
  const require = createRequire(import.meta.url);
  await exec(
    process.execPath,
    [
      '-e',
      `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2]);
    db.pragma('foreign_keys=OFF');
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='pending_review_floor_inputs'").all();
    db.exec('BEGIN IMMEDIATE');
    for (const trigger of triggers) db.exec('DROP TRIGGER "' + trigger.name.replaceAll('"','""') + '"');
    db.prepare('DELETE FROM pending_review_floor_inputs WHERE original_operation_id = ?').run(process.argv[3]);
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec('COMMIT');
    db.close();
  `,
      createRequire(require.resolve('@orcaops/storage/history/database')).resolve('better-sqlite3'),
      store.projectDatabasePath(f.input.authority),
      operationId,
    ],
    { env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } }
  );
  await expect(
    readDatabaseReviewFloor({ authority: f.input.authority, reviewId: f.input.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
}, 15000);
