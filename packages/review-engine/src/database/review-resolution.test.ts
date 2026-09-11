import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import {
  readDatabaseReviewResolution,
  resolveDatabaseReviewForBranch,
} from './review-resolution.js';
import { createDatabaseReview } from './reviews.js';
import { normalizeHistoryRoot } from '../../../storage/dist/history/paths.js';
import { buildDefaultSkippedSnapshotBoundary } from '../../../storage/dist/schema/diff-fingerprint.js';

vi.mock('@orcaops/storage/history/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@orcaops/storage/history/database')>()),
  openProjectDatabase: vi.fn(
    (await importOriginal<typeof import('@orcaops/storage/history/database')>()).openProjectDatabase
  ),
}));

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const initialContext = { worktreeId: null, baseSha: null, headSha: null };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'review-resolution-'));
  roots.push(root);
  const normalized = await normalizeHistoryRoot({ root });
  const gitRoot = path.join(root, 'repo');
  await mkdir(gitRoot);
  await exec('git', ['init', '--quiet'], { cwd: gitRoot });
  await exec(
    'git',
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Original base',
    ],
    { cwd: gitRoot }
  );
  const authority = (
    await setupProjectDatabase({
      cwd: gitRoot,
      root: normalized.resolvedRoot,
      authoredPayloads: [],
      secretAllow: [],
    })
  ).initialization.authority;
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
        event_id: string;
        ordinal: number;
        record_bytes: { blobHex: string };
        sidecar_payload_bytes: { blobHex: string } | null;
      }[];
    };
  };
  const artifactId = saved.rows.artifacts[0]!.artifact_id;
  const events = saved.rows.artifact_events
    .filter((event) => event.artifact_id === artifactId)
    .sort((a, b) => a.ordinal - b.ordinal);
  const handle = await store.openProjectDatabase({ authority, mode: 'writer' });
  let revision: store.ArtifactRevision;
  try {
    revision = (
      await store.appendProjectArtifactEvents(handle, {
        operationId: uuidv7(),
        artifactId,
        expectedRevision: null,
        eventBytes: Buffer.concat(
          events.map((event) => Buffer.from(event.record_bytes.blobHex, 'hex'))
        ),
        sidecarPayloads: events
          .filter((event) => event.sidecar_payload_bytes !== null)
          .map((event) => ({
            eventId: event.event_id,
            bytes: Buffer.from(event.sidecar_payload_bytes!.blobHex, 'hex'),
          })),
        secretAllow: [],
      })
    ).value.revision;
  } finally {
    handle.close();
  }
  const member = {
    artifactId,
    generation: revision.generation,
    orderedHash: revision.orderedHash,
  };
  return { authority, root: normalized.resolvedRoot, artifactId, revision, member, events };
}

/** Append one more closed checkpoint so the artifact carries a later retained revision. */
async function advance(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = buildDefaultSkippedSnapshotBoundary();
  const originalPlan = JSON.parse(
    Buffer.from(f.events[0]!.record_bytes.blobHex, 'hex').toString('utf8')
  ).payload as { plan_steps: { step_id: string }[] };
  const record = {
    event_id: uuidv7(),
    type: 'checkpoint_opened',
    ts: '2026-06-01T00:02:00.000Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: {
      artifact_id: f.artifactId,
      n: 1,
      declared_step_ids: [originalPlan.plan_steps[0]!.step_id],
      agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: f.events[0]!.event_id,
      opened_at: '2026-06-01T00:02:00.000Z',
      head_sha: 'a'.repeat(40),
      open_snapshot: snapshot,
    },
  };
  const checksum = createHash('sha256').update(canonicalJson(record)).digest('hex');
  const writer = await store.openProjectDatabase({ authority: f.authority, mode: 'writer' });
  try {
    return (
      await store.appendProjectArtifactEvents(writer, {
        operationId: uuidv7(),
        artifactId: f.artifactId,
        expectedRevision: f.revision,
        eventBytes: Buffer.from(JSON.stringify({ ...record, checksum }) + '\n'),
        sidecarPayloads: [],
        secretAllow: [],
      })
    ).value.revision;
  } finally {
    writer.close();
  }
}

async function rows(authority: store.ProjectDatabaseAuthority) {
  const database = await store.openProjectDatabase({ authority, mode: 'reader' });
  try {
    return database.read((view) => ({
      reviews: view.all<{ review_id: string; branch: string | null }>(
        'SELECT review_id, branch FROM reviews ORDER BY review_id'
      ),
      memberships: view.all<{ revision_id: string; previous_revision_id: string | null }>(
        'SELECT revision_id, previous_revision_id FROM review_membership_revisions ORDER BY rowid'
      ),
      selection: view.get<{ membership_revision_id: string; membership_version: number }>(
        'SELECT membership_revision_id, membership_version FROM review_selections'
      ),
      operations: view.all<{ operation_id: string; operation_kind: string }>(
        'SELECT operation_id, operation_kind FROM operations ORDER BY rowid'
      ),
      members: view.all<{ artifact_id: string; artifact_generation: number }>(
        'SELECT artifact_id, artifact_generation FROM review_members ORDER BY rowid'
      ),
    })).value;
  } finally {
    database.close();
  }
}

it('mints one review whose identity artifact set equals its branch membership', async () => {
  const f = await fixture();
  const resolved = await resolveDatabaseReviewForBranch({
    authority: f.authority,
    operationId: uuidv7(),
    branch: 'topic',
    members: [f.member],
    initialContext,
    secretAllow: [],
  });
  expect(resolved.outcome).toBe('created');
  expect(resolved.replayed).toBe(false);
  expect(resolved.membershipVersion).toBe(1);
  const after = await rows(f.authority);
  expect(after.reviews).toEqual([{ review_id: resolved.reviewId, branch: 'topic' }]);
  expect(after.members).toEqual([
    { artifact_id: f.artifactId, artifact_generation: f.revision.generation },
  ]);
  expect(after.selection).toEqual({
    membership_revision_id: resolved.membershipRevisionId,
    membership_version: 1,
  });
  const database = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  try {
    const identity = database.read((view) =>
      view.get<{ bytes: string }>(
        'SELECT hex(identity_bytes) AS bytes FROM reviews WHERE review_id = ?',
        resolved.reviewId
      )
    ).value!;
    const decoded = JSON.parse(Buffer.from(identity.bytes, 'hex').toString('utf8')) as {
      artifact_ids: string[];
      initial_context: { branch: string };
    };
    expect(decoded.artifact_ids).toEqual([f.artifactId]);
    expect(decoded.initial_context.branch).toBe('topic');
  } finally {
    database.close();
  }
});

it('replays the original result under the same operation id instead of minting a second review', async () => {
  const f = await fixture();
  const operationId = uuidv7();
  const first = await resolveDatabaseReviewForBranch({
    authority: f.authority,
    operationId,
    branch: 'topic',
    members: [f.member],
    initialContext,
    secretAllow: [],
  });
  const replay = await resolveDatabaseReviewForBranch({
    authority: f.authority,
    operationId,
    branch: 'topic',
    members: [f.member],
    initialContext,
    secretAllow: [],
  });
  expect(replay).toEqual({ ...first, replayed: true });
  const after = await rows(f.authority);
  expect(after.reviews).toHaveLength(1);
  expect(after.operations.filter((row) => row.operation_kind === 'review.create')).toEqual([
    { operation_id: operationId, operation_kind: 'review.create' },
  ]);
});

it('writes nothing when the branch membership is unchanged', async () => {
  const f = await fixture();
  const created = await resolveDatabaseReviewForBranch({
    authority: f.authority,
    operationId: uuidv7(),
    branch: 'topic',
    members: [f.member],
    initialContext,
    secretAllow: [],
  });
  const before = await rows(f.authority);
  const unchanged = await resolveDatabaseReviewForBranch({
    authority: f.authority,
    operationId: uuidv7(),
    branch: 'topic',
    members: [f.member],
    initialContext,
    secretAllow: [],
  });
  expect(unchanged).toEqual({
    reviewId: created.reviewId,
    membershipRevisionId: created.membershipRevisionId,
    membershipVersion: created.membershipVersion,
    outcome: 'retained',
    replayed: false,
  });
  expect(await rows(f.authority)).toEqual(before);
});

it('refreshes membership against the exact expected revision when the artifact set moves', async () => {
  const f = await fixture();
  const created = await resolveDatabaseReviewForBranch({
    authority: f.authority,
    operationId: uuidv7(),
    branch: 'topic',
    members: [f.member],
    initialContext,
    secretAllow: [],
  });
  const later = await advance(f);
  const refreshed = await resolveDatabaseReviewForBranch({
    authority: f.authority,
    operationId: uuidv7(),
    branch: 'topic',
    members: [
      { artifactId: f.artifactId, generation: later.generation, orderedHash: later.orderedHash },
    ],
    initialContext,
    secretAllow: [],
  });
  expect(refreshed.outcome).toBe('refreshed');
  expect(refreshed.reviewId).toBe(created.reviewId);
  expect(refreshed.membershipVersion).toBe(2);
  const after = await rows(f.authority);
  expect(after.memberships).toEqual([
    { revision_id: created.membershipRevisionId, previous_revision_id: null },
    {
      revision_id: refreshed.membershipRevisionId,
      previous_revision_id: created.membershipRevisionId,
    },
  ]);
  expect(after.members.map((row) => row.artifact_generation)).toEqual([
    f.revision.generation,
    later.generation,
  ]);
});

it('refuses a repeated artifact before opening any database connection', async () => {
  const f = await fixture();
  vi.mocked(store.openProjectDatabase).mockClear();
  await expect(
    resolveDatabaseReviewForBranch({
      authority: f.authority,
      operationId: uuidv7(),
      branch: 'topic',
      members: [f.member, f.member],
      initialContext,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
});

it('requires an explicit selection when the branch carries several reviews', async () => {
  const f = await fixture();
  for (const _ of [0, 1]) {
    const operationId = uuidv7();
    await createDatabaseReview({
      authority: f.authority,
      operationId,
      secretAllow: [],
      identityBytes: bytes({
        schema_version: 1,
        review_id: uuidv7(),
        project_id: f.authority.projectId,
        store_instance_id: f.authority.storeInstanceId,
        repository_instance_id: f.authority.repositoryInstanceId,
        created_by_operation: operationId,
        initial_context: { worktree_id: null, branch: 'topic', base_sha: null, head_sha: null },
        artifact_ids: [],
        legacy_source_ids: [],
      }),
      membershipBytes: bytes({ revisionId: uuidv7(), members: [], source: null }),
    });
  }
  await expect(
    resolveDatabaseReviewForBranch({
      authority: f.authority,
      operationId: uuidv7(),
      branch: 'topic',
      members: [f.member],
      initialContext,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'REVIEW_SELECTION_REQUIRED' });
});

it('refuses an operation identity that belongs to another authored action', async () => {
  const f = await fixture();
  const operationId = uuidv7();
  await createDatabaseReview({
    authority: f.authority,
    operationId,
    secretAllow: [],
    identityBytes: bytes({
      schema_version: 1,
      review_id: uuidv7(),
      project_id: f.authority.projectId,
      store_instance_id: f.authority.storeInstanceId,
      repository_instance_id: f.authority.repositoryInstanceId,
      created_by_operation: operationId,
      initial_context: { worktree_id: null, branch: 'other', base_sha: null, head_sha: null },
      artifact_ids: [],
      legacy_source_ids: [],
    }),
    membershipBytes: bytes({ revisionId: uuidv7(), members: [], source: null }),
  });
  const receipt = await readDatabaseReviewResolution({
    authority: f.authority,
    operationId,
  });
  expect(receipt.value).toMatchObject({ kind: 'review.create' });
  const foreign = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  let artifactOperation: string;
  try {
    artifactOperation = foreign.read((view) =>
      view.get<{ operation_id: string }>(
        "SELECT operation_id FROM operations WHERE operation_kind != 'review.create' LIMIT 1"
      )
    ).value!.operation_id;
  } finally {
    foreign.close();
  }
  await expect(
    resolveDatabaseReviewForBranch({
      authority: f.authority,
      operationId: artifactOperation,
      branch: 'topic',
      members: [f.member],
      initialContext,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
