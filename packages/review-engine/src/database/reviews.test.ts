import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import { prepareDatabaseReviewFloor } from './floor-preparation.js';
import { publishDatabaseReviewFloor, readDatabaseReviewFloor } from './floors.js';
import {
  changeDatabaseReviewBase,
  changeDatabaseReviewMembership,
  createDatabaseReview,
  listDatabaseReviews,
  readDatabaseReview,
} from './reviews.js';
import { normalizeHistoryRoot } from '../../../storage/dist/history/paths.js';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
} from '../../../storage/dist/schema/diff-fingerprint.js';

vi.mock('@orcaops/storage/history/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@orcaops/storage/history/database')>()),
  openProjectDatabase: vi.fn(
    (await importOriginal<typeof import('@orcaops/storage/history/database')>()).openProjectDatabase
  ),
  publishProjectEvidence: vi.fn(
    (await importOriginal<typeof import('@orcaops/storage/history/database')>())
      .publishProjectEvidence
  ),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function fixture(registered = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'database-review-'));
  roots.push(root);
  const normalized = await normalizeHistoryRoot({ root });
  let authority = {
    resolvedRoot: normalized.resolvedRoot,
    rootKey: normalized.rootKey,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const gitRoot = path.join(root, 'registered-repo');
  let baseOid = '';
  if (registered) {
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
    baseOid = (await exec('git', ['rev-parse', 'HEAD'], { cwd: gitRoot })).stdout.trim();
    authority = (
      await setupProjectDatabase({
        cwd: gitRoot,
        root: normalized.resolvedRoot,
        authoredPayloads: [],
        secretAllow: [],
      })
    ).initialization.authority;
  } else {
    await mkdir(path.dirname(store.projectDatabasePath(authority)), { recursive: true });
    const handle = await store.initializeProjectDatabase({
      authority,
      initializationOperationId: uuidv7(),
      initializedAt: new Date().toISOString(),
      authorize() {},
    });
    handle.close();
  }
  const operationId = uuidv7();
  const reviewId = uuidv7();
  const identity = {
    schema_version: 1,
    review_id: reviewId,
    project_id: authority.projectId,
    store_instance_id: authority.storeInstanceId,
    repository_instance_id: null,
    created_by_operation: operationId,
    initial_context: { worktree_id: null, branch: 'topic', base_sha: null, head_sha: null },
    artifact_ids: [],
    legacy_source_ids: ['original-stream:topic'],
  };
  const membership = { revisionId: uuidv7(), members: [], source: null };
  const request = {
    authority,
    operationId,
    secretAllow: [],
    identityBytes: bytes(identity),
    membershipBytes: bytes(membership),
  };
  return {
    authority,
    root: normalized.resolvedRoot,
    reviewId,
    identity,
    request,
    membership,
    gitRoot,
    baseOid,
  };
}
const exec = promisify(execFile);
async function floorInput(f: Awaited<ReturnType<typeof fixture>>) {
  const gitRoot = f.gitRoot;
  await mkdir(gitRoot, { recursive: true });
  const git = async (args: string[]) =>
    (
      await exec('git', args, {
        cwd: gitRoot,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        },
      })
    ).stdout.trim();
  await git(['init', '--quiet']);
  let baseSha: string;
  try {
    baseSha = await git(['rev-parse', '--verify', 'HEAD']);
  } catch {
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Retained floor base']);
    baseSha = await git(['rev-parse', 'HEAD']);
  }
  const pinnedTreeSha = await git(['rev-parse', `${baseSha}^{tree}`]);
  const current = (await readDatabaseReview({ authority: f.authority, reviewId: f.reviewId }))
    .value!.selection;
  const prepared = await prepareDatabaseReviewFloor({
    authority: f.authority,
    reviewId: f.reviewId,
    expected: {
      membershipRevisionId: current.membership_revision_id,
      membershipVersion: current.membership_version,
      baseRevisionId: current.base_revision_id,
      baseVersion: current.base_version,
      floorVersion: current.floor_version,
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
    generatedAt: '2026-01-01T00:00:00.000Z',
    secretAllow: [],
  });
  return {
    floorBytes: prepared.floorBytes,
    diffBytes: prepared.diffBytes,
    basis: prepared.basis,
    expected: prepared.expected,
  };
}
async function counters(authority: store.ProjectDatabaseAuthority) {
  const handle = await store.openProjectDatabase({ authority, mode: 'reader' });
  try {
    return handle.read((view) => ({
      reviews: view.all('SELECT review_id FROM reviews'),
      receipts: view.all('SELECT operation_id FROM operations'),
    }));
  } finally {
    handle.close();
  }
}

describe('database review identity and retained floor', () => {
  it('retains exact identity and legacy ownership while listing without decoding the corpus', async () => {
    const f = await fixture();
    const before = await counters(f.authority);
    const written = await createDatabaseReview(f.request);
    expect(written.replayed).toBe(false);
    expect(written.counters).toEqual({
      writeSequence: before.counters.writeSequence + 1,
      intentChangeCounter: before.counters.intentChangeCounter,
    });
    const read = await readDatabaseReview({ authority: f.authority, reviewId: f.reviewId });
    expect(read.value!.identityBytes).toEqual(f.request.identityBytes);
    expect(read.value!.membershipBytes).toEqual(f.request.membershipBytes);
    expect(read.value!.identity.repository_instance_id).toBeNull();
    expect(read.value!.identityHash).toBe(
      createHash('sha256').update(f.request.identityBytes).digest('hex')
    );
    expect(
      (await listDatabaseReviews({ authority: f.authority, branch: 'topic', limit: 1 })).value
    ).toEqual([{ review_id: f.reviewId, branch: 'topic', repository_instance_id: null }]);
    expect(
      (await readDatabaseReview({ authority: f.authority, reviewId: uuidv7() })).value
    ).toBeNull();
  });
  it('replays original creation without advancing counters and refuses changed operation content', async () => {
    const f = await fixture();
    const first = await createDatabaseReview(f.request);
    const again = await createDatabaseReview(f.request);
    expect(again).toEqual({ ...first, replayed: true });
    await expect(
      createDatabaseReview({
        ...f.request,
        identityBytes: bytes({ ...f.identity, legacy_source_ids: ['changed'] }),
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await counters(f.authority)).counters).toEqual(first.counters);
  });
  it.each([false, true])(
    'refuses discarded identity secret before any writer open with escaped bytes %s',
    async (escaped) => {
      const f = await fixture();
      const before = await counters(f.authority);
      vi.clearAllMocks();
      const secret = 'ghp_' + 'A'.repeat(36);
      const encoded = escaped
        ? Array.from(secret)
            .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
            .join('')
        : secret;
      const raw = f.request.identityBytes
        .toString('utf8')
        .replace('"legacy_source_ids":', `"legacy_source_ids":["${encoded}"],"legacy_source_ids":`);
      await expect(
        createDatabaseReview({ ...f.request, identityBytes: Buffer.from(raw) })
      ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
      expect(store.openProjectDatabase).not.toHaveBeenCalled();
      expect(store.publishProjectEvidence).not.toHaveBeenCalled();
      expect(await counters(f.authority)).toEqual(before);
    }
  );
  it.each([false, true])(
    'refuses a discarded membership source secret before writer open with escapes %s',
    async (escaped) => {
      const f = await fixture();
      const secret = 'ghp_' + 'A'.repeat(36);
      const encoded = escaped
        ? Array.from(secret)
            .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
            .join('')
        : secret;
      const membershipBytes = Buffer.from(
        f.request.membershipBytes
          .toString('utf8')
          .replace('"source":', `"source":"${encoded}","source":`)
      );
      vi.clearAllMocks();
      await expect(createDatabaseReview({ ...f.request, membershipBytes })).rejects.toMatchObject({
        code: 'SECRET_IN_PAYLOAD',
      });
      expect(store.openProjectDatabase).not.toHaveBeenCalled();
      expect(store.publishProjectEvidence).not.toHaveBeenCalled();
    }
  );
  it('accepts an exact retained artifact revision and preserves the authored membership bytes', async () => {
    // Several durable revision and floor publications must finish before this test settles.
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
    const handle = await store.openProjectDatabase({ authority: f.authority, mode: 'writer' });
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
    const membershipBytes = bytes({
      ...f.membership,
      members: [{ artifactId, generation: revision.generation, orderedHash: revision.orderedHash }],
      source: { streamId: 'original-membership', ordinal: 7, eventId: null },
    });
    await createDatabaseReview({
      ...f.request,
      identityBytes: bytes({ ...f.identity, artifact_ids: [artifactId] }),
      membershipBytes,
    });
    const read = await readDatabaseReview({ authority: f.authority, reviewId: f.reviewId });
    expect(read.value!.membershipBytes).toEqual(membershipBytes);
    expect(read.value!.membership.members).toEqual([
      { artifactId, generation: revision.generation, orderedHash: revision.orderedHash },
    ]);
    expect(read.value!.membership.source).toEqual({
      streamId: 'original-membership',
      ordinal: 7,
      eventId: null,
    });
    const preparedFloor = await floorInput(f);
    const selectedFloor = JSON.parse(preparedFloor.floorBytes.toString('utf8'));
    expect(selectedFloor.scope.threads[0].branch).toBe('main');
    const floorRequest = {
      authority: f.authority,
      reviewId: f.reviewId,
      operationId: uuidv7(),
      publicationId: uuidv7(),
      secretAllow: [],
      ...preparedFloor,
    };
    await expect(publishDatabaseReviewFloor(floorRequest)).resolves.toMatchObject({
      replayed: false,
    });
    const snapshot = buildDefaultSkippedSnapshotBoundary();
    const originalPlan = JSON.parse(
      Buffer.from(events[0]!.record_bytes.blobHex, 'hex').toString('utf8')
    ).payload as { plan_steps: { step_id: string }[] };
    const opened = {
      artifact_id: artifactId,
      n: 1,
      declared_step_ids: [originalPlan.plan_steps[0]!.step_id],
      agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: events[0]!.event_id,
      opened_at: '2026-06-01T00:02:00.000Z',
      head_sha: 'a'.repeat(40),
      open_snapshot: snapshot,
    };
    const closed = {
      artifact_id: artifactId,
      n: 1,
      summary: 'Retained outcome',
      files_changed: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      closed_by_agent: 'codex',
      head_sha: 'b'.repeat(40),
      ts: '2026-06-01T00:03:00.000Z',
      close_snapshot: snapshot,
      diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
    };
    const recordBytes = [
      ['checkpoint_opened', opened],
      ['checkpoint_closed', closed],
    ].map(([type, payload]) => {
      const record = {
        event_id: uuidv7(),
        type,
        ts: '2026-06-01T00:03:00.000Z',
        schema_version: 1,
        idempotency_key: uuidv7(),
        payload,
      };
      const checksum = createHash('sha256').update(canonicalJson(record)).digest('hex');
      return Buffer.from(JSON.stringify({ ...record, checksum }) + '\n');
    });
    const writer = await store.openProjectDatabase({ authority: f.authority, mode: 'writer' });
    let newer: store.ArtifactRevision;
    let openRevision: store.ArtifactRevision;
    try {
      openRevision = (
        await store.appendProjectArtifactEvents(writer, {
          operationId: uuidv7(),
          artifactId,
          expectedRevision: revision,
          eventBytes: recordBytes[0]!,
          sidecarPayloads: [],
          secretAllow: [],
        })
      ).value.revision;
      newer = (
        await store.appendProjectArtifactEvents(writer, {
          operationId: uuidv7(),
          artifactId,
          expectedRevision: openRevision,
          eventBytes: recordBytes[1]!,
          sidecarPayloads: [],
          secretAllow: [],
        })
      ).value.revision;
      expect(
        store.readProjectArtifact(writer, artifactId, newer)!.thread.checkpoints[0]!.status
      ).toBe('closed');
    } finally {
      writer.close();
    }
    const referenced = {
      ...selectedFloor,
      integrity: [{ artifact: artifactId, cp: 1, verified: null }],
    };
    vi.mocked(store.publishProjectEvidence).mockClear();
    await expect(
      publishDatabaseReviewFloor({
        ...floorRequest,
        operationId: uuidv7(),
        publicationId: uuidv7(),
        floorBytes: bytes(referenced),
        expected: { ...floorRequest.expected, floorVersion: 1 },
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(store.publishProjectEvidence).not.toHaveBeenCalled();
    const openMembershipId = uuidv7();
    await changeDatabaseReviewMembership({
      authority: f.authority,
      reviewId: f.reviewId,
      operationId: uuidv7(),
      secretAllow: [],
      membershipBytes: bytes({
        revisionId: openMembershipId,
        members: [
          {
            artifactId,
            generation: openRevision.generation,
            orderedHash: openRevision.orderedHash,
          },
        ],
        source: null,
      }),
      expected: { revisionId: f.membership.revisionId, version: 1 },
    });
    vi.mocked(store.publishProjectEvidence).mockClear();
    await expect(
      publishDatabaseReviewFloor({
        ...floorRequest,
        operationId: uuidv7(),
        publicationId: uuidv7(),
        floorBytes: bytes(referenced),
        expected: {
          ...floorRequest.expected,
          membershipRevisionId: openMembershipId,
          membershipVersion: 2,
          floorVersion: 1,
        },
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(store.publishProjectEvidence).not.toHaveBeenCalled();
    const nextMembershipId = uuidv7();
    await changeDatabaseReviewMembership({
      authority: f.authority,
      reviewId: f.reviewId,
      operationId: uuidv7(),
      secretAllow: [],
      membershipBytes: bytes({
        revisionId: nextMembershipId,
        members: [{ artifactId, generation: newer.generation, orderedHash: newer.orderedHash }],
        source: null,
      }),
      expected: { revisionId: openMembershipId, version: 2 },
    });
    await expect(
      publishDatabaseReviewFloor({
        ...floorRequest,
        operationId: uuidv7(),
        publicationId: uuidv7(),
        ...(await floorInput(f)),
      })
    ).resolves.toMatchObject({ replayed: false });
  }, 15000);
  it('refuses membership endpoints absent from retained artifact history and rolls back creation', async () => {
    const f = await fixture();
    const before = await counters(f.authority);
    const artifactId = uuidv7();
    await expect(
      createDatabaseReview({
        ...f.request,
        identityBytes: bytes({ ...f.identity, artifact_ids: [artifactId] }),
        membershipBytes: bytes({
          ...f.membership,
          members: [{ artifactId, generation: 1, orderedHash: 'a'.repeat(64) }],
        }),
      })
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    expect(await counters(f.authority)).toEqual(before);
  });
  it('keeps base transitions and rejects a stale base while unrelated membership changes survive', async () => {
    const f = await fixture(true);
    await createDatabaseReview(f.request);
    const explicit = {
      authority: f.authority,
      operationId: uuidv7(),
      secretAllow: [],
      reviewId: f.reviewId,
      revisionId: uuidv7(),
      expectedVersion: 0,
      baseBytes: bytes({
        kind: 'explicit' as const,
        ref: 'original-base-ref',
        oid: f.baseOid,
        recordedAt: '2026-01-01T00:00:00.000Z',
        source: null,
      }),
    };
    await changeDatabaseReviewBase({ ...explicit, gitRoot: f.gitRoot });
    await changeDatabaseReviewMembership({
      authority: f.authority,
      operationId: uuidv7(),
      secretAllow: [],
      reviewId: f.reviewId,
      membershipBytes: bytes({
        revisionId: uuidv7(),
        members: [],
        source: { streamId: 'original-log', ordinal: 7, eventId: null },
      }),
      expected: { revisionId: f.membership.revisionId, version: 1 },
    });
    await expect(
      changeDatabaseReviewBase({ ...explicit, operationId: uuidv7(), revisionId: uuidv7() })
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    const reset = await changeDatabaseReviewBase({
      ...explicit,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      expectedVersion: 1,
      baseBytes: bytes({ kind: 'auto', recordedAt: '2026-01-01T00:00:01.000Z', source: null }),
    });
    expect(reset.value.baseVersion).toBe(2);
    const handle = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
    try {
      expect(
        handle.read((view) =>
          view.all('SELECT hex(record_bytes) AS record_hex FROM review_base_revisions')
        ).value
      ).toHaveLength(2);
    } finally {
      handle.close();
    }
  });
  it('retains complete floor and diff files before selecting rows, then replays without the producer', async () => {
    const f = await fixture();
    await createDatabaseReview(f.request);
    const request = {
      authority: f.authority,
      operationId: uuidv7(),
      secretAllow: [],
      reviewId: f.reviewId,
      publicationId: uuidv7(),
      ...(await floorInput(f)),
    };
    const first = await publishDatabaseReviewFloor(request);
    const retained = await readDatabaseReviewFloor({
      authority: f.authority,
      reviewId: f.reviewId,
    });
    expect(retained.value!.floorBytes).toEqual(request.floorBytes);
    expect(retained.value!.diffBytes).toEqual(request.diffBytes);
    vi.mocked(store.publishProjectEvidence).mockClear();
    expect(
      await publishDatabaseReviewFloor({
        ...request,
        basis: { ...request.basis, gitRoot: path.join(f.root, 'missing-checkout') },
      })
    ).toEqual({ ...first, replayed: true });
    expect(store.publishProjectEvidence).not.toHaveBeenCalled();
    await expect(
      publishDatabaseReviewFloor({ ...request, operationId: uuidv7(), publicationId: uuidv7() })
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    expect(
      (await readDatabaseReviewFloor({ authority: f.authority, reviewId: f.reviewId })).value!
        .publicationId
    ).toBe(request.publicationId);
  });
  it('refuses a secret in a later diff member before any writer open or evidence publication', async () => {
    const f = await fixture();
    await createDatabaseReview(f.request);
    const prepared = await floorInput(f);
    vi.clearAllMocks();
    await expect(
      publishDatabaseReviewFloor({
        authority: f.authority,
        operationId: uuidv7(),
        secretAllow: [],
        reviewId: f.reviewId,
        publicationId: uuidv7(),
        ...prepared,
        diffBytes: Buffer.from('ghp_' + 'A'.repeat(36)),
      })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(store.openProjectDatabase).not.toHaveBeenCalled();
    expect(store.publishProjectEvidence).not.toHaveBeenCalled();
    expect(await readdir(path.dirname(store.projectDatabasePath(f.authority)))).not.toContain(
      'evidence'
    );
  });
  it('copies caller bytes and metadata before asynchronous writer admission', async () => {
    const f = await fixture();
    const original = Buffer.from(f.request.identityBytes);
    const promise = createDatabaseReview(f.request);
    f.request.identityBytes.fill(65);
    f.request.membershipBytes.fill(65);
    await promise;
    expect(
      (await readDatabaseReview({ authority: f.authority, reviewId: f.reviewId })).value!
        .identityBytes
    ).toEqual(original);
  });
  it('honors cancellation before writer open and after evidence without publishing a selection', async () => {
    const f = await fixture();
    const canceled = new AbortController();
    canceled.abort();
    vi.clearAllMocks();
    await expect(
      createDatabaseReview(f.request, { signal: canceled.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(store.openProjectDatabase).not.toHaveBeenCalled();
    await createDatabaseReview(f.request);
    const before = await counters(f.authority);
    const request = {
      authority: f.authority,
      operationId: uuidv7(),
      secretAllow: [],
      reviewId: f.reviewId,
      publicationId: uuidv7(),
      ...(await floorInput(f)),
    };
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import('@orcaops/storage/history/database')>(
      '@orcaops/storage/history/database'
    );
    vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (...args) => {
      const result = await actual.publishProjectEvidence(...args);
      controller.abort();
      return result;
    });
    await expect(
      publishDatabaseReviewFloor(request, { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await counters(f.authority)).toEqual(before);
    expect(
      (await readDatabaseReviewFloor({ authority: f.authority, reviewId: f.reviewId })).value
    ).toBeNull();
    expect(
      await readFile(
        path.join(
          path.dirname(store.projectDatabasePath(f.authority)),
          'evidence',
          request.publicationId,
          'floor.json'
        )
      )
    ).toEqual(request.floorBytes);
    expect((await publishDatabaseReviewFloor(request)).replayed).toBe(false);
  });
  it('never regenerates missing selected floor evidence or creates a missing database', async () => {
    const f = await fixture();
    await createDatabaseReview(f.request);
    const publicationId = uuidv7();
    await publishDatabaseReviewFloor({
      authority: f.authority,
      operationId: uuidv7(),
      secretAllow: [],
      reviewId: f.reviewId,
      publicationId,
      ...(await floorInput(f)),
    });
    const file = path.join(
      path.dirname(store.projectDatabasePath(f.authority)),
      'evidence',
      publicationId,
      'floor.json'
    );
    await unlink(file);
    await expect(
      readDatabaseReviewFloor({ authority: f.authority, reviewId: f.reviewId })
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await unlink(store.projectDatabasePath(f.authority));
    await expect(createDatabaseReview(f.request)).rejects.toMatchObject({
      code: 'HISTORY_MISSING',
    });
    await expect(readFile(store.projectDatabasePath(f.authority))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

it('retains nullable branch identity in create, exact reads and unfiltered listing', async () => {
  const f = await fixture();
  const identity = {
    ...f.identity,
    initial_context: { ...f.identity.initial_context, branch: null },
  };
  const request = { ...f.request, identityBytes: bytes(identity) };
  await createDatabaseReview(request);
  const read = await readDatabaseReview({ authority: f.authority, reviewId: f.reviewId });
  expect(read.value!.identity.initial_context.branch).toBeNull();
  expect(read.value!.identityBytes).toEqual(request.identityBytes);
  expect((await listDatabaseReviews({ authority: f.authority, limit: 10 })).value).toEqual([
    { review_id: f.reviewId, branch: null, repository_instance_id: null },
  ]);
  expect(
    (await listDatabaseReviews({ authority: f.authority, branch: 'topic', limit: 10 })).value
  ).toEqual([]);
  vi.clearAllMocks();
  await expect(
    prepareDatabaseReviewFloor({
      authority: f.authority,
      reviewId: f.reviewId,
      expected: {
        membershipRevisionId: f.membership.revisionId,
        membershipVersion: 1,
        baseRevisionId: null,
        baseVersion: 0,
        floorVersion: 0,
      },
      basis: {
        gitRoot: f.root,
        baseSha: 'a'.repeat(40),
        pinnedTreeSha: 'b'.repeat(40),
        worktreeHead: null,
        defaultBranch: null,
        fingerprintMaxDiffBytes: 100000,
        reviewMaxDiffBytes: 100000,
        reviewIncludedUntracked: [],
      },
      generatedAt: '2026-06-01T00:00:00.000Z',
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect(
    (await readDatabaseReview({ authority: f.authority, reviewId: f.reviewId })).counters
  ).toEqual(read.counters);
});
