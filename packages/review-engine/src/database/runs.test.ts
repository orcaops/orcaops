import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { uuidv7 } from '@orcaops/storage';
import { HistoryError } from '@orcaops/storage/history/authority';
import * as store from '@orcaops/storage/history/database';

import { runReview } from '../run.js';
import * as semantic from '../semanticAnchors.js';
import { storyReviewGeneration } from '../storyReviewModel.js';
import { freshSliceRunState } from '../twolaneSlice.js';
import { prepareDatabaseReviewFloor } from './floor-preparation.js';
import { publishDatabaseReviewFloor } from './floors.js';
import { readDatabaseReviewContext } from './read-context.js';
import { createDatabaseReview } from './reviews.js';
import { readDatabaseReviewAttempts } from './run-attempt-read.js';
import { prepareDatabaseReviewAttempt, publishDatabaseReviewAttempt } from './run-attempts.js';
import { readDatabaseReviewFinalization } from './run-finalization-read.js';
import { publishDatabaseReviewFinalization } from './run-finalization.js';
import {
  defaultRunInputPolicy,
  prepareDatabaseReviewRunInputs,
  prepareRunInputMembers,
  type RunInputMember,
} from './run-inputs.js';
import { recordDatabaseReviewInputsServed } from './run-progress.js';
import { readDatabaseReviewRun } from './run-read.js';
import { startDatabaseReviewRun } from './runs.js';
import { prepareDatabaseReviewFinalization } from './story-preparation.js';
import { decodeRetainedTerminalRecord, prepareTerminalRecordBytes } from './terminal-record.js';

// These integration tests publish durable Git and database evidence on real disk.
vi.setConfig({ testTimeout: 15_000 });

vi.mock('@orcaops/storage/history/database', async (importOriginal) => {
  const actual = await importOriginal<typeof store>();
  return {
    ...actual,
    openProjectDatabase: vi.fn(actual.openProjectDatabase),
    publishProjectEvidence: vi.fn(actual.publishProjectEvidence),
    readProjectEvidence: vi.fn(actual.readProjectEvidence),
  };
});
vi.mock('../semanticAnchors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof semantic>();
  return { ...actual, prepareSemanticAnchorInput: vi.fn(actual.prepareSemanticAnchorInput) };
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
async function fixture(content = 'const value = 2;\n') {
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
  const authority = (
    await setupProjectDatabase({
      cwd: gitRoot,
      root: path.join(root, 'history'),
      authoredPayloads: [],
      secretAllow: [],
    })
  ).initialization.authority;
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

async function runFixture(
  options: { content?: string; maxDiffBytes?: number; transportCeiling?: number } = {}
) {
  const f = await fixture(options.content);
  if (options.maxDiffBytes !== undefined) {
    f.input.basis.fingerprintMaxDiffBytes = options.maxDiffBytes;
    f.input.basis.reviewMaxDiffBytes = options.maxDiffBytes;
  }
  const prepared = await prepareDatabaseReviewFloor(f.input);
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
  const input = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    expected: { ...prepared.expected, floorVersion: 1, floorPublicationId: publicationId },
    policy: {
      ...defaultRunInputPolicy(),
      ...(options.transportCeiling === undefined
        ? {}
        : { forensicTransportCeilingBytes: options.transportCeiling }),
    },
    generatedAt: f.input.generatedAt,
    secretAllow: [],
  };
  const pinned = await prepareDatabaseReviewRunInputs(input);
  const forensic = pinned.values['forensic-input-v1.json'] as { diff: string };
  const run = {
    schema_version: 2,
    run_id: 'original-run:topic',
    branch: 'topic',
    mode: 'routine',
    created_at: f.input.generatedAt,
    input_shas: pinned.inputShas,
    slice_state: freshSliceRunState(),
    lane_inputs_served: {},
    attempts: [],
    account_lineage: null,
    latency_input_bytes: Buffer.byteLength(forensic.diff),
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
  const request = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    publicationId: uuidv7(),
    runBytes: bytes(run),
    inputs: pinned.members,
    policy: input.policy,
    expected: { ...input.expected, currentRunId: null, runSelectionVersion: 0 },
    secretAllow: [],
  };
  vi.clearAllMocks();
  return { f, input, pinned, run, request };
}
async function rows(authority: store.ProjectDatabaseAuthority) {
  const db = await store.openProjectDatabase({ authority, mode: 'reader' });
  try {
    return db.read((view) => ({
      runs: view.all('SELECT * FROM review_runs'),
      revisions: view.all<{ record_bytes: string; record_hash: string }>(
        'SELECT hex(record_bytes) AS record_bytes, record_hash FROM review_run_revisions'
      ),
      members: view.all<{ relative_path: string; record_hash: string; byte_length: number }>(
        'SELECT * FROM review_evidence_members WHERE kind = ?',
        'run-input'
      ),
    }));
  } finally {
    db.close();
  }
}
it('retains original run identity, bytes and pinned inputs with one settlement and exact replay', async () => {
  const f = await runFixture();
  const before = await rows(f.request.authority);
  vi.clearAllMocks();
  const first = await startDatabaseReviewRun(f.request);
  expect(first.value).toMatchObject({ runId: f.run.run_id, version: 1, runSelectionVersion: 1 });
  const after = await rows(f.request.authority);
  expect(after.value.runs).toHaveLength(1);
  expect(Buffer.from(after.value.revisions[0]!.record_bytes, 'hex')).toEqual(f.request.runBytes);
  expect(after.value.revisions[0]!.record_hash).toBe(
    createHash('sha256').update(f.request.runBytes).digest('hex')
  );
  expect(after.value.members).toHaveLength(5);
  expect(after.counters.writeSequence).toBe(before.counters.writeSequence + 1);
  expect(after.counters.intentChangeCounter).toBe(before.counters.intentChangeCounter);
  for (const member of f.request.inputs) {
    const retained = await readFile(
      path.join(
        path.dirname(store.projectDatabasePath(f.request.authority)),
        'evidence',
        f.request.publicationId,
        member.name
      )
    );
    expect(retained).toEqual(member.bytes);
  }
  vi.clearAllMocks();
  expect((await startDatabaseReviewRun(f.request)).value).toEqual(first.value);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  await expect(
    startDatabaseReviewRun({ ...f.request, runBytes: Buffer.from(JSON.stringify(f.run, null, 2)) })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await rows(f.request.authority)).counters).toEqual(after.counters);
});
it('prepares the same run inputs from the same floor whatever was written in between', async () => {
  const f = await runFixture();
  await startDatabaseReviewRun(f.request);
  const again = await prepareDatabaseReviewRunInputs(f.input);
  expect(again.members).toEqual(f.pinned.members);
  const projection = again.values['account-projection-v1.json'] as {
    taskKnowledge: {
      schema_version: number;
      tasks: { knowledge: { boundary: number; mode: string } }[];
    };
  };
  const db = await store.openProjectDatabase({ authority: f.input.authority, mode: 'reader' });
  try {
    const floor = db.read((view) =>
      view.get<{ committed_write_sequence: number }>(
        `SELECT o.committed_write_sequence FROM review_evidence_publications p
           JOIN operations o ON o.operation_id = p.operation_id
          WHERE p.publication_id = ?`,
        f.input.expected.floorPublicationId
      )
    ).value!;
    expect(projection.taskKnowledge.schema_version).toBe(1);
    for (const task of projection.taskKnowledge.tasks)
      expect(task.knowledge).toMatchObject({
        boundary: floor.committed_write_sequence,
        mode: 'historical',
      });
    expect(floor.committed_write_sequence).toBeLessThan(db.read(() => null).counters.writeSequence);
  } finally {
    db.close();
  }
  const second = await startDatabaseReviewRun({
    ...f.request,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    publicationId: uuidv7(),
    runBytes: bytes({ ...f.run, run_id: 'second-run-same-floor' }),
    expected: { ...f.request.expected, currentRunId: f.run.run_id, runSelectionVersion: 1 },
  });
  expect(second.value).toMatchObject({ runId: 'second-run-same-floor', version: 1 });
});
it('refuses actual forensic input beyond the routine latency ceiling before any connection', async () => {
  const f = await runFixture({
    content: '// ' + 'review '.repeat(290_000) + '\n',
    maxDiffBytes: 2_500_000,
    transportCeiling: 2_500_000,
  });
  expect(f.run.latency_input_bytes).toBeGreaterThan(2_000_000);
  expect(f.run.latency_input_bytes).toBeLessThan(f.request.policy.forensicTransportCeilingBytes);
  await expect(startDatabaseReviewRun(f.request)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect((await rows(f.request.authority)).value.runs).toHaveLength(0);
}, 15000);
it('retains a larger declared transport policy when actual input fits the routine latency ceiling', async () => {
  const f = await runFixture({ transportCeiling: 2_500_000 });
  expect(f.run.latency_input_bytes).toBeLessThan(2_000_000);
  const result = await startDatabaseReviewRun(f.request);
  expect(result.value.runId).toBe(f.run.run_id);
  expect((await startDatabaseReviewRun(f.request)).value).toEqual(result.value);
});
it('refuses escaped secrets across the full input batch before any connection', async () => {
  const f = await runFixture();
  const secret = 'ghp_' + 'A'.repeat(36);
  const encoded = secret
    .split('')
    .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('');
  const inputs: RunInputMember[] = f.request.inputs.map((m) =>
    m.name === 'diff.patch' ? { name: m.name, bytes: Buffer.from('"' + encoded + '"') } : m
  );
  await expect(startDatabaseReviewRun({ ...f.request, inputs })).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  await startDatabaseReviewRun(f.request);
});
it('rejects fresh-state, byte-count and input-manifest forgery before any connection', async () => {
  const f = await runFixture();
  for (const changed of [
    { ...f.run, latency_input_bytes: f.run.latency_input_bytes + 1 },
    { ...f.run, input_shas: {} },
    { ...f.run, lane_inputs_served: { account: f.run.created_at } },
  ]) {
    await expect(
      startDatabaseReviewRun({ ...f.request, runBytes: bytes(changed) })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('rejects a schema-valid forged dossier against its retained floor before writer admission', async () => {
  const f = await runFixture();
  const inputs = f.request.inputs.map((m) =>
    m.name === 'dossier-v1.json'
      ? {
          name: m.name,
          bytes: bytes({ ...JSON.parse(m.bytes.toString()), floor_input_hash: 'forged' }),
        }
      : m
  );
  const changed = prepareRunInputMembers(inputs, []);
  await expect(
    startDatabaseReviewRun({
      ...f.request,
      inputs,
      runBytes: bytes({ ...f.run, input_shas: changed.inputShas }),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('refuses a stale current-run selection and retains only the selected original run', async () => {
  const f = await runFixture();
  await startDatabaseReviewRun(f.request);
  vi.clearAllMocks();
  await expect(
    startDatabaseReviewRun({
      ...f.request,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      publicationId: uuidv7(),
      runBytes: bytes({ ...f.run, run_id: 'next-run' }),
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect((await rows(f.request.authority)).value.runs).toHaveLength(1);
});
it('leaves canceled evidence unused and retries the original operation idempotently', async () => {
  const f = await runFixture();
  const controller = new AbortController();
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (...args) => {
    const value = await actual.publishProjectEvidence(...args);
    controller.abort();
    return value;
  });
  const before = await rows(f.request.authority);
  await expect(
    startDatabaseReviewRun(f.request, { signal: controller.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  const canceled = await rows(f.request.authority);
  expect(canceled.value.runs).toHaveLength(0);
  expect(canceled.counters).toEqual(before.counters);
  expect(
    await readFile(
      path.join(
        path.dirname(store.projectDatabasePath(f.request.authority)),
        'evidence',
        f.request.publicationId,
        'diff.patch'
      )
    )
  ).toEqual(f.pinned.members.find((m) => m.name === 'diff.patch')!.bytes);
  await startDatabaseReviewRun(f.request);
  expect((await rows(f.request.authority)).value.runs).toHaveLength(1);
});
it('rejects a concurrent run selected after evidence preparation without making stale inputs current', async () => {
  const f = await runFixture();
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  const winner = {
    ...f.request,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    publicationId: uuidv7(),
    runBytes: bytes({ ...f.run, run_id: 'concurrent-run' }),
  };
  vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (...args) => {
    const files = await actual.publishProjectEvidence(...args);
    await startDatabaseReviewRun(winner);
    return files;
  });
  const before = await rows(f.request.authority);
  await expect(startDatabaseReviewRun(f.request)).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  const after = await rows(f.request.authority);
  expect(after.value.runs).toHaveLength(1);
  expect(after.value.runs[0]).toMatchObject({ run_id: 'concurrent-run' });
  expect(after.counters.writeSequence).toBe(before.counters.writeSequence + 1);
  expect(after.value.members).toHaveLength(5);
  expect(
    await readFile(
      path.join(
        path.dirname(store.projectDatabasePath(f.request.authority)),
        'evidence',
        f.request.publicationId,
        'diff.patch'
      )
    )
  ).toEqual(f.pinned.members.find((m) => m.name === 'diff.patch')!.bytes);
});
it('preserves authored input formatting and records hashes of those exact bytes', async () => {
  const f = await runFixture();
  const inputs = f.request.inputs.map((m) =>
    m.name === 'diff.patch'
      ? m
      : {
          name: m.name,
          bytes: Buffer.from(JSON.stringify(JSON.parse(m.bytes.toString()), null, 4) + '\n\n'),
        }
  );
  const manifest = prepareRunInputMembers(inputs, []);
  const request = {
    ...f.request,
    inputs,
    runBytes: bytes({ ...f.run, input_shas: manifest.inputShas }),
  };
  await startDatabaseReviewRun(request);
  for (const m of inputs)
    expect(
      await readFile(
        path.join(
          path.dirname(store.projectDatabasePath(request.authority)),
          'evidence',
          request.publicationId,
          m.name
        )
      )
    ).toEqual(m.bytes);
});

async function servedFixture() {
  const f = await runFixture();
  await startDatabaseReviewRun(f.request);
  const run = { ...f.run, lane_inputs_served: { forensic: '2026-06-01T00:01:00.000Z' } };
  const request = {
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    runId: f.run.run_id,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    expected: { revisionId: f.request.revisionId, version: 1, runSelectionVersion: 1 },
    lane: 'forensic' as const,
    runBytes: bytes(run),
    secretAllow: [],
  };
  vi.clearAllMocks();
  return { f, run, request };
}
it('reads exact original input bytes without writer admission or regeneration', async () => {
  const f = await runFixture();
  expect(
    (await readDatabaseReviewRun({ authority: f.request.authority, reviewId: f.request.reviewId }))
      .value
  ).toBeNull();
  await startDatabaseReviewRun(f.request);
  vi.clearAllMocks();
  const read = await readDatabaseReviewRun({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  expect(read.value!.runBytes).toEqual(f.request.runBytes);
  expect(read.value!.run).toEqual(f.run);
  expect(read.value!.inputs).toHaveLength(5);
  for (const member of f.request.inputs)
    expect(read.value!.inputs.find((m) => m.name === member.name)!.bytes).toEqual(member.bytes);
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect((await rows(f.request.authority)).counters).toEqual(read.counters);
});
it('appends first-served progress and reads the original immutable run revision', async () => {
  const f = await servedFixture();
  const before = await readDatabaseReviewRun({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  const result = await recordDatabaseReviewInputsServed(f.request);
  expect(result.value).toMatchObject({ revisionId: f.request.revisionId, version: 2 });
  const current = await readDatabaseReviewRun({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  expect(current.value!.runBytes).toEqual(f.request.runBytes);
  expect(current.value!.version).toBe(2);
  expect(current.counters.writeSequence).toBe(before.counters.writeSequence + 1);
  expect(current.counters.intentChangeCounter).toBe(before.counters.intentChangeCounter);
  expect(current.value!.selection.run_selection_version).toBe(1);
  const original = await readDatabaseReviewRun({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    runId: f.request.runId,
    revisionId: f.f.request.revisionId,
  });
  expect(original.value!.runBytes).toEqual(f.f.request.runBytes);
  expect(original.value!.version).toBe(1);
  expect(current.value!.inputPublicationId).toBe(original.value!.inputPublicationId);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect((await recordDatabaseReviewInputsServed(f.request)).value).toEqual(result.value);
  expect((await rows(f.request.authority)).counters).toEqual(current.counters);
});
it('rejects stale copied run progress before writer admission', async () => {
  const f = await servedFixture();
  await recordDatabaseReviewInputsServed(f.request);
  vi.clearAllMocks();
  await expect(
    recordDatabaseReviewInputsServed({ ...f.request, operationId: uuidv7(), revisionId: uuidv7() })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect((await rows(f.request.authority)).value.revisions).toHaveLength(2);
});
it('rejects progress for a previously selected run without retargeting the newer run', async () => {
  const f = await servedFixture();
  await startDatabaseReviewRun({
    ...f.f.request,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    publicationId: uuidv7(),
    runBytes: bytes({ ...f.f.run, run_id: 'new-selected-run' }),
    expected: { ...f.f.request.expected, currentRunId: f.request.runId, runSelectionVersion: 1 },
  });
  vi.clearAllMocks();
  await expect(recordDatabaseReviewInputsServed(f.request)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  const current = await readDatabaseReviewRun({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
  });
  expect(current.value!.runId).toBe('new-selected-run');
  expect(current.value!.version).toBe(1);
  const old = await readDatabaseReviewRun({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    runId: f.request.runId,
  });
  expect(old.value!.run.lane_inputs_served).toEqual({});
});
it('rejects unrelated authored progress and account serving before the forensic lane is terminal', async () => {
  const f = await servedFixture();
  await expect(
    recordDatabaseReviewInputsServed({
      ...f.request,
      runBytes: bytes({ ...f.run, branch: 'retargeted' }),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    recordDatabaseReviewInputsServed({
      ...f.request,
      lane: 'account',
      runBytes: bytes({ ...f.f.run, lane_inputs_served: { account: '2026-06-01T00:01:00.000Z' } }),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect((await rows(f.request.authority)).value.revisions).toHaveLength(1);
});
it('reports missing retained run input evidence without recreating it', async () => {
  const f = await servedFixture();
  const filename = path.join(
    path.dirname(store.projectDatabasePath(f.request.authority)),
    'evidence',
    f.f.request.publicationId,
    'dossier-v1.json'
  );
  await unlink(filename);
  const before = await rows(f.request.authority);
  vi.clearAllMocks();
  await expect(
    readDatabaseReviewRun({ authority: f.request.authority, reviewId: f.request.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  await expect(recordDatabaseReviewInputsServed(f.request)).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await rows(f.request.authority)).counters).toEqual(before.counters);
});

it('rejects progress committed after preparation without overwriting its newer timestamp', async () => {
  const f = await servedFixture();
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  const winningRun = { ...f.run, lane_inputs_served: { forensic: '2026-06-01T00:02:00.000Z' } };
  let intervened = false;
  vi.mocked(store.openProjectDatabase).mockImplementation(async (input) => {
    const database = await actual.openProjectDatabase(input);
    if (input.mode === 'writer' && !intervened) {
      intervened = true;
      await recordDatabaseReviewInputsServed({
        ...f.request,
        operationId: uuidv7(),
        revisionId: uuidv7(),
        runBytes: bytes(winningRun),
      });
    }
    return database;
  });
  try {
    await expect(recordDatabaseReviewInputsServed(f.request)).rejects.toMatchObject({
      code: 'STALE_CONTEXT',
    });
    const current = await readDatabaseReviewRun({
      authority: f.request.authority,
      reviewId: f.request.reviewId,
    });
    expect(current.value!.version).toBe(2);
    expect(current.value!.run.lane_inputs_served).toEqual(winningRun.lane_inputs_served);
    expect((await rows(f.request.authority)).value.revisions).toHaveLength(2);
  } finally {
    vi.mocked(store.openProjectDatabase).mockImplementation(actual.openProjectDatabase);
  }
});
it('refuses escaped authored run progress before opening a connection', async () => {
  const f = await servedFixture();
  const secret = 'ghp_' + 'A'.repeat(36);
  const raw = JSON.stringify(f.run).replace(
    '"mode":',
    JSON.stringify(secret) + ':"discarded","mode":'
  );
  const escaped = raw.replace(
    secret,
    secret
      .split('')
      .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('')
  );
  await expect(
    recordDatabaseReviewInputsServed({ ...f.request, runBytes: Buffer.from(escaped) })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  await recordDatabaseReviewInputsServed(f.request);
});

async function attemptFixture(rawSubmissionBytes = bytes({ findings: [], questions: [] })) {
  const f = await runFixture();
  await startDatabaseReviewRun(f.request);
  const input = {
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    runId: f.run.run_id,
    expected: { revisionId: f.request.revisionId, version: 1, runSelectionVersion: 1 },
    authored: {
      lane: 'forensic' as const,
      at: '2026-06-01T00:01:00.000Z',
      isolation: 'subagent-fresh' as const,
      usageTokens: null,
      usageSource: null,
      runtimeIdentity: null,
    },
    rawSubmissionBytes,
    secretAllow: [],
  };
  vi.clearAllMocks();
  return { f, input };
}
async function attemptRequest(input: Parameters<typeof prepareDatabaseReviewAttempt>[0]) {
  const prepared = await prepareDatabaseReviewAttempt(input);
  return {
    prepared,
    request: {
      ...input,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      publicationId: uuidv7(),
      runBytes: prepared.runBytes,
    },
  };
}
it('retains exact wrapped submission, normalization hashes and accepted forensic evidence', async () => {
  const raw = bytes(JSON.stringify({ findings: [], questions: [] }));
  const f = await attemptFixture(raw);
  const { prepared, request } = await attemptRequest(f.input);
  expect(prepared.accepted).toBe(true);
  expect(prepared.run.attempts[0]!.normalization_code).toBe('JSON_STRING_UNWRAPPED');
  expect(prepared.run.attempts[0]!.raw_submission_sha256).toBe(
    createHash('sha256').update(raw).digest('hex')
  );
  const before = await rows(f.input.authority);
  const result = await publishDatabaseReviewAttempt(request);
  expect(result.value).toMatchObject({ accepted: true, version: 2 });
  const current = await readDatabaseReviewRun({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(current.value!.runBytes).toEqual(request.runBytes);
  expect(current.value!.run.slice_state.lanes.forensic.outcome).toBe(
    'ACCEPTED_NORMALIZED_FIRST_PASS'
  );
  const evidence = path.join(
    path.dirname(store.projectDatabasePath(f.input.authority)),
    'evidence',
    request.publicationId
  );
  expect(await readFile(path.join(evidence, 'submission.txt'))).toEqual(raw);
  expect(
    JSON.parse((await readFile(path.join(evidence, 'accepted-forensic.json'))).toString())
  ).toEqual({ findings: [], questions: [] });
  expect(current.counters.writeSequence).toBe(before.counters.writeSequence + 1);
  expect(current.counters.intentChangeCounter).toBe(before.counters.intentChangeCounter);
  vi.clearAllMocks();
  expect((await publishDatabaseReviewAttempt(request)).value).toEqual(result.value);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('retains invalid lane JSON as a diagnostic attempt and applies the existing one-repair state machine', async () => {
  const f = await attemptFixture(Buffer.from('unfinished {'));
  const first = await attemptRequest(f.input);
  expect(first.prepared.accepted).toBe(false);
  await publishDatabaseReviewAttempt(first.request);
  const repaired = await attemptRequest({
    ...f.input,
    rawSubmissionBytes: bytes({ findings: [], questions: [] }),
    expected: { ...f.input.expected, revisionId: first.request.revisionId, version: 2 },
  });
  expect(repaired.prepared.accepted).toBe(true);
  expect(repaired.prepared.run.slice_state.lanes.forensic.outcome).toBe('ACCEPTED_REPAIRED');
  expect(repaired.prepared.run.slice_state.lanes.forensic.repairCredit).toBe(0);
  await publishDatabaseReviewAttempt(repaired.request);
  const current = await readDatabaseReviewRun({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(current.value!.run.attempts).toHaveLength(2);
  expect(current.value!.run.attempts[0]!.normalization_code).toBe('INVALID_JSON');
  const original = await readDatabaseReviewRun({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    revisionId: first.request.revisionId,
  });
  expect(original.value!.run.slice_state.lanes.forensic.outcome).toBe('REJECTED_FIRST_PASS');
});
it('refuses forged prepared run acceptance before writer admission', async () => {
  const f = await attemptFixture(Buffer.from('invalid'));
  const { prepared, request } = await attemptRequest(f.input);
  vi.clearAllMocks();
  await expect(
    publishDatabaseReviewAttempt({
      ...request,
      runBytes: bytes({
        ...prepared.run,
        attempts: [{ ...prepared.run.attempts[0], accepted: true }],
      }),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('refuses secret submission bytes before any connection and preserves the valid control', async () => {
  const f = await attemptFixture();
  const { request } = await attemptRequest(f.input);
  vi.clearAllMocks();
  const secret = 'ghp_' + 'A'.repeat(36);
  const escaped = secret
    .split('')
    .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('');
  await expect(
    publishDatabaseReviewAttempt({
      ...request,
      rawSubmissionBytes: Buffer.from('"' + escaped + '"'),
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  await publishDatabaseReviewAttempt(request);
});
it('keeps a competing run revision and leaves stale attempt evidence unused', async () => {
  const f = await attemptFixture();
  const { request } = await attemptRequest(f.input);
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  const winner = {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    runId: f.input.runId,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    expected: f.input.expected,
    lane: 'forensic' as const,
    runBytes: bytes({ ...f.f.run, lane_inputs_served: { forensic: '2026-06-01T00:03:00.000Z' } }),
    secretAllow: [],
  };
  vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (...args) => {
    const files = await actual.publishProjectEvidence(...args);
    await recordDatabaseReviewInputsServed(winner);
    return files;
  });
  await expect(publishDatabaseReviewAttempt(request)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const current = await readDatabaseReviewRun({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(current.value!.revisionId).toBe(winner.revisionId);
  expect(current.value!.run.attempts).toHaveLength(0);
  expect(
    await readFile(
      path.join(
        path.dirname(store.projectDatabasePath(f.input.authority)),
        'evidence',
        request.publicationId,
        'submission.txt'
      )
    )
  ).toEqual(f.input.rawSubmissionBytes);
});
it('refuses account attempts before terminal forensic progress without consuming an attempt', async () => {
  const f = await attemptFixture();
  vi.clearAllMocks();
  await expect(
    prepareDatabaseReviewAttempt({ ...f.input, authored: { ...f.input.authored, lane: 'account' } })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  const current = await readDatabaseReviewRun({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(current.value!.run.attempts).toHaveLength(0);
});

it('reads exact retained attempt proofs and original accepted payload without writer admission', async () => {
  const f = await attemptFixture();
  const { request } = await attemptRequest(f.input);
  await publishDatabaseReviewAttempt(request);
  vi.clearAllMocks();
  const read = await readDatabaseReviewAttempts({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(read.value!.accepted.forensic).toEqual({ findings: [], questions: [] });
  expect(read.value!.accepted.account).toBeNull();
  expect(read.value!.attempts).toHaveLength(1);
  expect(read.value!.attempts[0]!.members.find((m) => m.name === 'submission.txt')!.bytes).toEqual(
    f.input.rawSubmissionBytes
  );
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  const old = await readDatabaseReviewAttempts({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    revisionId: f.input.expected.revisionId,
  });
  expect(old.value!.attempts).toHaveLength(0);
  expect(old.value!.accepted.forensic).toBeNull();
});
it('reads explicitly exempted accepted historical text without authoring refusal', async () => {
  const allowed = 'ghp_' + 'A'.repeat(36);
  const f = await attemptFixture(bytes({ findings: [], questions: [allowed] }));
  const { request } = await attemptRequest({ ...f.input, secretAllow: [allowed] });
  await publishDatabaseReviewAttempt(request);
  vi.clearAllMocks();
  const read = await readDatabaseReviewAttempts({
    authority: f.input.authority,
    reviewId: f.input.reviewId,
  });
  expect(read.value!.accepted.forensic!.questions).toEqual([allowed]);
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
});
it('reports missing accepted attempt evidence without regenerating its bundle', async () => {
  const f = await attemptFixture();
  const { request } = await attemptRequest(f.input);
  await publishDatabaseReviewAttempt(request);
  const filename = path.join(
    path.dirname(store.projectDatabasePath(f.input.authority)),
    'evidence',
    request.publicationId,
    'accepted-forensic.json'
  );
  await unlink(filename);
  const before = await rows(f.input.authority);
  vi.clearAllMocks();
  await expect(
    readDatabaseReviewAttempts({ authority: f.input.authority, reviewId: f.input.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await rows(f.input.authority)).counters).toEqual(before.counters);
});
it('holds one selected row snapshot while immutable evidence is validated after a concurrent selection', async () => {
  const f = await attemptFixture();
  const { request } = await attemptRequest(f.input);
  await publishDatabaseReviewAttempt(request);
  const before = await rows(f.input.authority);
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  let intervened = false;
  vi.mocked(store.readProjectEvidence).mockImplementation(async (...args) => {
    if (!intervened) {
      intervened = true;
      await startDatabaseReviewRun({
        ...f.f.request,
        operationId: uuidv7(),
        revisionId: uuidv7(),
        publicationId: uuidv7(),
        expected: { ...f.f.request.expected, currentRunId: f.input.runId, runSelectionVersion: 1 },
        runBytes: bytes({ ...f.f.run, run_id: 'selected-during-read' }),
      });
    }
    return actual.readProjectEvidence(...args);
  });
  try {
    const read = await readDatabaseReviewAttempts({
      authority: f.input.authority,
      reviewId: f.input.reviewId,
    });
    expect(read.value!.runId).toBe(f.input.runId);
    expect(read.value!.attempts).toHaveLength(1);
    expect(read.counters).toEqual(before.counters);
    expect(
      (await readDatabaseReviewRun({ authority: f.input.authority, reviewId: f.input.reviewId }))
        .value!.runId
    ).toBe('selected-during-read');
  } finally {
    vi.mocked(store.readProjectEvidence).mockImplementation(actual.readProjectEvidence);
  }
});

function finalizationInput(
  f: Awaited<ReturnType<typeof attemptFixture>>,
  revisionId = f.input.expected.revisionId,
  version = 1
) {
  return {
    authority: f.input.authority,
    reviewId: f.input.reviewId,
    runId: f.input.runId,
    expected: {
      revisionId,
      version,
      runSelectionVersion: 1,
      floorPublicationId: f.f.request.expected.floorPublicationId,
      membershipRevisionId: f.f.request.expected.membershipRevisionId,
      storyVersion: 0,
    },
    finalizedAt: '2026-06-01T00:03:00.000Z',
    runtimeIdentity: null,
    secretAllow: [],
  };
}
async function terminalFixture(accepted = true) {
  const f = await attemptFixture();
  let input = finalizationInput(f);
  if (accepted) {
    const { request } = await attemptRequest(f.input);
    await publishDatabaseReviewAttempt(request);
    input = finalizationInput(f, request.revisionId, 2);
  }
  const prepared = await prepareDatabaseReviewFinalization(input);
  return {
    f,
    prepared,
    request: {
      ...input,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      publicationId: accepted ? uuidv7() : null,
      runBytes: prepared.runBytes,
      members: prepared.requiredMembers.map(({ name, bytes }) => ({ name, bytes })),
    },
  };
}
async function terminalRows(authority: store.ProjectDatabaseAuthority) {
  const db = await store.openProjectDatabase({ authority, mode: 'reader' });
  try {
    return db.read((view) => ({
      terminals: view.all<{
        run_id: string;
        run_revision_id: string;
        operation_id: string;
        bytes: string;
        record_hash: string;
      }>(
        'SELECT run_id, run_revision_id, operation_id, hex(record_bytes) AS bytes, record_hash FROM review_run_finalizations'
      ),
      selections: view.all<{
        story_publication_id: string | null;
        semantic_publication_id: string | null;
        story_version: number;
      }>('SELECT * FROM review_selections'),
      publications: view.all<{ kind: string; publication_id: string; record_json: string }>(
        'SELECT * FROM review_evidence_publications'
      ),
    }));
  } finally {
    db.close();
  }
}
it('seals a failed run with its complete retained receipt and no invented Story selection', async () => {
  const f = await terminalFixture(false);
  const before = await terminalRows(f.request.authority);
  const result = await publishDatabaseReviewFinalization(f.request);
  expect(result.value).toMatchObject({
    outcome: 'FAILED',
    publicationId: null,
    generation: null,
    version: 2,
  });
  const after = await terminalRows(f.request.authority);
  expect(after.value.terminals).toHaveLength(1);
  const row = after.value.terminals[0]!;
  expect(Buffer.from(row.bytes, 'hex')).toEqual(Buffer.from(result.value.terminalBytes, 'base64'));
  expect(row.record_hash).toBe(result.value.terminalHash);
  expect(decodeRetainedTerminalRecord(Buffer.from(row.bytes, 'hex')).value.outcome).toBe('FAILED');
  expect(after.value.selections).toEqual(before.value.selections);
  expect(after.counters.writeSequence).toBe(before.counters.writeSequence + 1);
  expect(after.counters.intentChangeCounter).toBe(before.counters.intentChangeCounter);
});
it('publishes optional evidence before exact core Story and replays the original receipt without files', async () => {
  const f = await terminalFixture();
  const before = await terminalRows(f.request.authority);
  vi.clearAllMocks();
  const result = await publishDatabaseReviewFinalization(f.request);
  const calls = vi.mocked(store.publishProjectEvidence).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]![1].members.some((m) => m.name === semantic.SEMANTIC_ANCHOR_RECEIPT_FILE)).toBe(
    true
  );
  expect(calls[1]![1].publicationId).toBe(f.request.publicationId);
  expect(calls[1]![1].members).toEqual(f.request.members);
  expect(result.value).toMatchObject({
    outcome: 'DEGRADED',
    generation: f.prepared.generation,
    publicationId: f.request.publicationId,
  });
  const after = await terminalRows(f.request.authority);
  expect(
    JSON.parse(after.value.publications.find((p) => p.kind === 'story')!.record_json)
      .observedWriteSequence
  ).toBe(before.counters.writeSequence);
  expect(after.value.selections[0]).toMatchObject({
    story_publication_id: f.request.publicationId,
    semantic_publication_id: result.value.semanticPublicationId,
    story_version: 1,
  });
  expect(after.counters.writeSequence).toBe(before.counters.writeSequence + 1);
  const { dirname, join } = path;
  await rm(join(dirname(store.projectDatabasePath(f.request.authority)), 'evidence'), {
    recursive: true,
  });
  vi.clearAllMocks();
  const replay = await publishDatabaseReviewFinalization(f.request);
  expect(replay.value).toEqual(result.value);
  expect(replay.replayed).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  await expect(
    publishDatabaseReviewFinalization({
      ...f.request,
      finalizedAt: '2026-06-01T00:04:00.000Z',
      runBytes: bytes({
        ...JSON.parse(f.request.runBytes.toString()),
        finalized: { at: '2026-06-01T00:04:00.000Z', outcome: 'DEGRADED' },
      }),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('refuses complete core content before any connection and rejects forged synthesis before a writer', async () => {
  const f = await terminalFixture();
  vi.clearAllMocks();
  const secret = 'ghp_' + 'A'.repeat(36);
  await expect(
    publishDatabaseReviewFinalization({
      ...f.request,
      members: [...f.request.members, { name: 'extra.json', bytes: bytes(secret) }],
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  await expect(
    publishDatabaseReviewFinalization({
      ...f.request,
      members: f.request.members.map((m, i) => (i ? m : { ...m, bytes: Buffer.from('forged') })),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(vi.mocked(store.openProjectDatabase).mock.calls.every(([v]) => v.mode === 'reader')).toBe(
    true
  );
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('retains optional write unavailability in the terminal row while core publication succeeds', async () => {
  const f = await terminalFixture();
  vi.mocked(store.publishProjectEvidence).mockRejectedValueOnce(
    new HistoryError('HISTORY_UNWRITABLE', 'fixture optional write failure')
  );
  const result = await publishDatabaseReviewFinalization(f.request);
  const terminal = decodeRetainedTerminalRecord(
    Buffer.from(result.value.terminalBytes, 'base64')
  ).value;
  expect(terminal.semantic_anchor_input).toMatchObject({
    status: 'UNAVAILABLE',
    reason: 'PREPARED_INPUT_WRITE_FAILED',
    receipt_file: null,
    payload_file: null,
  });
  expect(result.value.semanticPublicationId).toBeNull();
  expect(result.value.publicationId).toBe(f.request.publicationId);
  expect(terminal.semantic_anchor_input.error_message).not.toContain('fixture');
  vi.clearAllMocks();
  expect((await publishDatabaseReviewFinalization(f.request)).value).toEqual(result.value);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('retries the same authored operation across optional availability changes after core failure', async () => {
  const f = await terminalFixture();
  const before = await terminalRows(f.request.authority);
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  const ids: string[] = [];
  vi.mocked(store.publishProjectEvidence)
    .mockImplementationOnce(async (_db, input) => {
      ids.push(input.publicationId);
      throw new HistoryError('HISTORY_UNWRITABLE', 'fixture optional');
    })
    .mockRejectedValueOnce(new HistoryError('HISTORY_UNWRITABLE', 'fixture core'));
  await expect(publishDatabaseReviewFinalization(f.request)).rejects.toMatchObject({
    code: 'HISTORY_UNWRITABLE',
  });
  expect((await terminalRows(f.request.authority)).counters).toEqual(before.counters);
  vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (db, input, options) => {
    ids.push(input.publicationId);
    return actual.publishProjectEvidence(db, input, options);
  });
  const result = await publishDatabaseReviewFinalization(f.request);
  expect(new Set(ids).size).toBe(2);
  expect(result.value.semanticPublicationId).toBe(ids[1]);
  expect(
    decodeRetainedTerminalRecord(Buffer.from(result.value.terminalBytes, 'base64')).value
      .semantic_anchor_input.receipt_file
  ).toBe(semantic.SEMANTIC_ANCHOR_RECEIPT_FILE);
  expect((await terminalRows(f.request.authority)).value.terminals).toHaveLength(1);
});
it('rejects a stale run publication after a new run wins during immutable evidence preparation', async () => {
  const f = await terminalFixture();
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (db, input, options) => {
    const winner = {
      ...f.f.f.request,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      publicationId: uuidv7(),
      runBytes: bytes({ ...f.f.f.run, run_id: 'new-current-run' }),
      expected: {
        ...f.f.f.request.expected,
        currentRunId: f.request.runId,
        runSelectionVersion: 1,
      },
    };
    await startDatabaseReviewRun(winner);
    return actual.publishProjectEvidence(db, input, options);
  });
  await expect(publishDatabaseReviewFinalization(f.request)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const state = await terminalRows(f.request.authority);
  expect(state.value.terminals).toEqual([]);
  expect(state.value.selections[0]!.story_publication_id).toBeNull();
  expect(
    (await readDatabaseReviewRun({ authority: f.request.authority, reviewId: f.request.reviewId }))
      .value!.runId
  ).toBe('new-current-run');
});
it('preserves cancellation and required authority errors during optional publication', async () => {
  const f = await terminalFixture();
  const before = await terminalRows(f.request.authority);
  for (const code of [
    'CANCELLED',
    'STALE_CONTEXT',
    'HISTORY_MISSING',
    'SECRET_IN_PAYLOAD',
    'HISTORY_INTEGRITY_REQUIRED',
  ] as const) {
    vi.mocked(store.publishProjectEvidence).mockRejectedValueOnce(
      new store.ProjectDatabaseError(code, 'fixture refusal')
    );
    await expect(publishDatabaseReviewFinalization(f.request)).rejects.toMatchObject({ code });
    expect((await terminalRows(f.request.authority)).counters).toEqual(before.counters);
  }
  await publishDatabaseReviewFinalization(f.request);
});
it('rolls back a late terminal-row refusal and reuses exact core files on original-operation retry', async () => {
  const f = await terminalFixture();
  const before = await terminalRows(f.request.authority);
  const Driver = createRequire(new URL('../../../storage/package.json', import.meta.url))(
    'better-sqlite3'
  ) as new (file: string) => { exec(sql: string): void; close(): void };
  const fixtureWriter = new Driver(store.projectDatabasePath(f.request.authority));
  fixtureWriter.exec(
    "CREATE TRIGGER reject_terminal BEFORE INSERT ON review_run_finalizations BEGIN SELECT RAISE(ABORT, 'fixture terminal refusal'); END"
  );
  fixtureWriter.close();
  vi.clearAllMocks();
  await expect(publishDatabaseReviewFinalization(f.request)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'constraint',
  });
  const firstSemanticId = vi.mocked(store.publishProjectEvidence).mock.calls[0]![1].publicationId;
  const failed = await terminalRows(f.request.authority);
  expect(failed).toEqual(before);
  expect(
    (await readDatabaseReviewRun({ authority: f.request.authority, reviewId: f.request.reviewId }))
      .value!.run.finalized
  ).toBeNull();
  const corePath = path.join(
    path.dirname(store.projectDatabasePath(f.request.authority)),
    'evidence',
    f.request.publicationId!,
    'review.md'
  );
  const retainedCore = await readFile(corePath);
  expect(retainedCore).toEqual(f.request.members[0]!.bytes);
  const repair = new Driver(store.projectDatabasePath(f.request.authority));
  repair.exec('DROP TRIGGER reject_terminal');
  repair.close();
  const result = await publishDatabaseReviewFinalization(f.request);
  expect(result.value.semanticPublicationId).not.toBe(firstSemanticId);
  expect(await readFile(corePath)).toEqual(retainedCore);
  const after = await terminalRows(f.request.authority);
  expect(after.value.terminals).toHaveLength(1);
  expect(after.counters.writeSequence).toBe(before.counters.writeSequence + 1);
  expect(
    (
      await readDatabaseReviewAttempts({
        authority: f.request.authority,
        reviewId: f.request.reviewId,
      })
    ).value!.run.finalized!.outcome
  ).toBe('DEGRADED');
});
it('keeps the original finalization cancellation signal when caller options are replaced', async () => {
  const f = await terminalFixture();
  const before = await terminalRows(f.request.authority);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  vi.clearAllMocks();
  const pending = publishDatabaseReviewFinalization(f.request, options);
  options.signal = new AbortController().signal;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect((await terminalRows(f.request.authority)).counters).toEqual(before.counters);
});
it.each([false, true])(
  'reads exact terminal receipt and immutable publication members, accepted=%s',
  async (accepted) => {
    const f = await terminalFixture(accepted);
    const settled = await publishDatabaseReviewFinalization(f.request);
    const before = await terminalRows(f.request.authority);
    vi.clearAllMocks();
    const read = await readDatabaseReviewFinalization({
      authority: f.request.authority,
      reviewId: f.request.reviewId,
      runId: f.request.runId,
    });
    expect(read.value!.bytes).toEqual(Buffer.from(settled.value.terminalBytes, 'base64'));
    expect(read.value!.hash).toBe(settled.value.terminalHash);
    expect(read.value!.runBytes).toEqual(f.request.runBytes);
    expect(read.value!.operationId).toBe(f.request.operationId);
    expect(read.value!.publications.find((p) => p.kind === 'story')?.publicationId ?? null).toBe(
      f.request.publicationId
    );
    expect(read.counters).toEqual(before.counters);
    expect(
      vi.mocked(store.openProjectDatabase).mock.calls.every(([v]) => v.mode === 'reader')
    ).toBe(true);
    expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  }
);
it('returns no terminal receipt for an existing unsealed run', async () => {
  const f = await terminalFixture();
  const before = await terminalRows(f.request.authority);
  vi.clearAllMocks();
  const read = await readDatabaseReviewFinalization({
    authority: f.request.authority,
    reviewId: f.request.reviewId,
    runId: f.request.runId,
  });
  expect(read.value).toBeNull();
  expect(read.counters).toEqual(before.counters);
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
});
it('reports missing required Story bytes without repairing a committed terminal', async () => {
  const f = await terminalFixture();
  await publishDatabaseReviewFinalization(f.request);
  const file = path.join(
    path.dirname(store.projectDatabasePath(f.request.authority)),
    'evidence',
    f.request.publicationId!,
    'review.md'
  );
  await unlink(file);
  const before = await terminalRows(f.request.authority);
  vi.clearAllMocks();
  await expect(
    readDatabaseReviewFinalization({
      authority: f.request.authority,
      reviewId: f.request.reviewId,
      runId: f.request.runId,
    })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect(vi.mocked(store.openProjectDatabase).mock.calls.every(([v]) => v.mode === 'reader')).toBe(
    true
  );
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await terminalRows(f.request.authority)).counters).toEqual(before.counters);
});
it('keeps one terminal snapshot while another run becomes current during evidence reads', async () => {
  const f = await terminalFixture();
  const settled = await publishDatabaseReviewFinalization(f.request);
  const before = await terminalRows(f.request.authority);
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  let intervened = false;
  vi.mocked(store.readProjectEvidence).mockImplementation(async (...args) => {
    if (!intervened) {
      intervened = true;
      await startDatabaseReviewRun({
        ...f.f.f.request,
        operationId: uuidv7(),
        revisionId: uuidv7(),
        publicationId: uuidv7(),
        expected: {
          ...f.f.f.request.expected,
          currentRunId: f.request.runId,
          runSelectionVersion: 1,
        },
        runBytes: bytes({ ...f.f.f.run, run_id: 'current-during-terminal-read' }),
      });
    }
    return actual.readProjectEvidence(...args);
  });
  try {
    const read = await readDatabaseReviewFinalization({
      authority: f.request.authority,
      reviewId: f.request.reviewId,
      runId: f.request.runId,
    });
    expect(read.value!.bytes).toEqual(Buffer.from(settled.value.terminalBytes, 'base64'));
    expect(read.value!.selection.current_run_id).toBe(f.request.runId);
    expect(read.counters).toEqual(before.counters);
    expect(
      (
        await readDatabaseReviewRun({
          authority: f.request.authority,
          reviewId: f.request.reviewId,
        })
      ).value!.runId
    ).toBe('current-during-terminal-read');
  } finally {
    vi.mocked(store.readProjectEvidence).mockImplementation(actual.readProjectEvidence);
  }
});
it('refuses a sealed run whose retained terminal row was lost', async () => {
  const f = await terminalFixture();
  await publishDatabaseReviewFinalization(f.request);
  const Driver = createRequire(new URL('../../../storage/package.json', import.meta.url))(
    'better-sqlite3'
  ) as new (file: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): { get(): { sql: string } };
  };
  const raw = new Driver(store.projectDatabasePath(f.request.authority));
  const definition = raw
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'review_run_finalizations_no_delete'")
    .get().sql;
  raw.exec('DROP TRIGGER review_run_finalizations_no_delete; DELETE FROM review_run_finalizations');
  raw.exec(definition);
  raw.close();
  const before = await terminalRows(f.request.authority);
  await expect(
    readDatabaseReviewFinalization({
      authority: f.request.authority,
      reviewId: f.request.reviewId,
      runId: f.request.runId,
    })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect((await terminalRows(f.request.authority)).counters).toEqual(before.counters);
});
it('prepares a failed terminal record without inventing a Story generation', async () => {
  const f = await attemptFixture();
  const before = await rows(f.input.authority);
  vi.clearAllMocks();
  const prepared = await prepareDatabaseReviewFinalization(finalizationInput(f));
  expect(prepared.outcome).toBe('FAILED');
  expect(prepared.generation).toBeNull();
  expect(prepared.requiredMembers).toEqual([]);
  expect(prepared.terminalPreview).toMatchObject({
    run_id: f.input.runId,
    outcome: 'FAILED',
    outputs: null,
    ownership_summary: null,
    range_validation: 'NOT_APPLICABLE',
    submission_count: 0,
    elapsed_ms: 180000,
    latency_status: 'PASS',
    usage: { status: 'UNKNOWN', entries: [] },
  });
  expect(JSON.parse(prepared.runBytes.toString()).finalized).toEqual({
    at: '2026-06-01T00:03:00.000Z',
    outcome: 'FAILED',
  });
  const authored = Buffer.from(JSON.stringify(prepared.terminalPreview, null, 4) + '\n\n');
  expect(prepareTerminalRecordBytes({ bytes: authored, secretAllow: [] }).bytes).toEqual(authored);
  expect(decodeRetainedTerminalRecord(authored).bytes).toEqual(authored);
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect((await rows(f.input.authority)).counters).toEqual(before.counters);
});
it('prepares degraded Story output with the existing model generation and complete terminal receipt', async () => {
  const f = await attemptFixture();
  const { request } = await attemptRequest(f.input);
  await publishDatabaseReviewAttempt(request);
  vi.clearAllMocks();
  const prepared = await prepareDatabaseReviewFinalization(
    finalizationInput(f, request.revisionId, 2)
  );
  expect(prepared.outcome).toBe('DEGRADED');
  expect(prepared.generation).not.toBeNull();
  expect(prepared.requiredMembers.map((member) => member.name)).toEqual([
    'review.md',
    'brief.json',
    'composed-story-v2.json',
    'story-review-model-v4.json',
  ]);
  const model = prepared.requiredMembers.find(
    (member) => member.name === 'story-review-model-v4.json'
  )!;
  expect(prepared.generation).toBe(await storyReviewGeneration(JSON.parse(model.bytes.toString())));
  expect(prepared.terminalPreview.outputs!.story_review_model_sha256).toBe(
    createHash('sha256').update(model.bytes).digest('hex')
  );
  expect(prepared.terminalPreview).toMatchObject({
    submission_count: 1,
    range_validation: 'PERFORMED',
    isolation: {
      per_lane: { account: null, forensic: 'SUBAGENT_FRESH' },
      aggregate: 'SUBAGENT_FRESH',
    },
    semantic_anchor_input: { run_id: f.input.runId, receipt_file: null },
  });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('validates every retained terminal field and refuses authored secrets', async () => {
  const f = await attemptFixture();
  const prepared = await prepareDatabaseReviewFinalization(finalizationInput(f));
  for (const key of Object.keys(prepared.terminalPreview)) {
    const partial = { ...prepared.terminalPreview } as Record<string, unknown>;
    delete partial[key];
    expect(() => prepareTerminalRecordBytes({ bytes: bytes(partial), secretAllow: [] })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  }
  expect(() =>
    prepareTerminalRecordBytes({
      bytes: bytes({ ...prepared.terminalPreview, unknown: true }),
      secretAllow: [],
    })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() =>
    prepareTerminalRecordBytes({
      bytes: bytes({ ...prepared.terminalPreview, submission_count: 1 }),
      secretAllow: [],
    })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  const allowed = 'ghp_' + 'A'.repeat(36);
  const record = {
    ...prepared.terminalPreview,
    execution_profile: {
      ...prepared.terminalPreview.execution_profile,
      host: { value: allowed, provenance: 'CALLER_DECLARED' },
    },
  };
  expect(() => prepareTerminalRecordBytes({ bytes: bytes(record), secretAllow: [] })).toThrow(
    expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
  );
  expect(
    decodeRetainedTerminalRecord(
      prepareTerminalRecordBytes({ bytes: bytes(record), secretAllow: [allowed] }).bytes
    ).value.execution_profile.host!.value
  ).toBe(allowed);
});
it('rejects stale run and Story selection before preparing terminal outputs', async () => {
  const f = await attemptFixture();
  vi.clearAllMocks();
  const expected = finalizationInput(f);
  await expect(
    prepareDatabaseReviewFinalization({
      ...expected,
      expected: { ...expected.expected, storyVersion: 1 },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  const { request } = await attemptRequest(f.input);
  await publishDatabaseReviewAttempt(request);
  vi.clearAllMocks();
  await expect(prepareDatabaseReviewFinalization(expected)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});

it('retains optional preparation unavailability without exposing arbitrary failure text', async () => {
  const f = await attemptFixture();
  const { request } = await attemptRequest(f.input);
  await publishDatabaseReviewAttempt(request);
  const actual = await vi.importActual<typeof semantic>('../semanticAnchors.js');
  vi.mocked(semantic.prepareSemanticAnchorInput).mockImplementation((input) => {
    if (input.storyModel !== null) throw new Error('internal producer detail');
    return actual.prepareSemanticAnchorInput(input);
  });
  try {
    const prepared = await prepareDatabaseReviewFinalization(
      finalizationInput(f, request.revisionId, 2)
    );
    expect(prepared.outcome).toBe('DEGRADED');
    expect(prepared.requiredMembers).toHaveLength(4);
    expect(prepared.semanticPreparation.receipt).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'PREPARATION_FAILED',
    });
    expect(JSON.stringify(prepared.terminalPreview)).not.toContain('internal producer detail');
  } finally {
    vi.mocked(semantic.prepareSemanticAnchorInput).mockImplementation(
      actual.prepareSemanticAnchorInput
    );
  }
});
it('never demotes secret refusal, stale context or cancellation into optional unavailability', async () => {
  const f = await attemptFixture();
  const { request } = await attemptRequest(f.input);
  await publishDatabaseReviewAttempt(request);
  vi.clearAllMocks();
  const actual = await vi.importActual<typeof semantic>('../semanticAnchors.js');
  const abort = new Error('cancelled');
  abort.name = 'AbortError';
  try {
    for (const [cause, code] of [
      [new store.ProjectDatabaseError('SECRET_IN_PAYLOAD', 'refused'), 'SECRET_IN_PAYLOAD'],
      [new store.ProjectDatabaseError('STALE_CONTEXT', 'stale'), 'STALE_CONTEXT'],
      [new store.ProjectDatabaseError('HISTORY_MISSING', 'missing'), 'HISTORY_MISSING'],
      [abort, 'CANCELLED'],
    ] as const) {
      vi.mocked(semantic.prepareSemanticAnchorInput).mockImplementation((input) => {
        if (input.storyModel !== null) throw cause;
        return actual.prepareSemanticAnchorInput(input);
      });
      await expect(
        prepareDatabaseReviewFinalization(finalizationInput(f, request.revisionId, 2))
      ).rejects.toMatchObject({ code });
    }
  } finally {
    vi.mocked(semantic.prepareSemanticAnchorInput).mockImplementation(
      actual.prepareSemanticAnchorInput
    );
  }
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});

it('retains the original wait callback when caller options change during preparation', async () => {
  const f = await runFixture();
  const Driver = createRequire(new URL('../../../storage/package.json', import.meta.url))(
    'better-sqlite3'
  ) as new (file: string) => { exec(sql: string): void; close(): void };
  const holder = new Driver(store.projectDatabasePath(f.request.authority));
  holder.exec('BEGIN IMMEDIATE');
  const original = vi.fn(() => holder.exec('ROLLBACK'));
  const replacement = vi.fn(() => holder.exec('ROLLBACK'));
  const options = { onWait: original };
  try {
    const pending = startDatabaseReviewRun(f.request, options);
    options.onWait = replacement;
    await pending;
    expect(original).toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
  } finally {
    holder.close();
  }
});

it('reads the original selected Story owner separately from a newer current run', async () => {
  const f = await terminalFixture();
  const settled = await publishDatabaseReviewFinalization(f.request);
  const newerRunId = 'new-current-retained-story';
  await startDatabaseReviewRun({
    ...f.f.f.request,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    publicationId: uuidv7(),
    expected: { ...f.f.f.request.expected, currentRunId: f.request.runId, runSelectionVersion: 1 },
    runBytes: bytes({ ...f.f.f.run, run_id: newerRunId }),
  });
  const before = await terminalRows(f.request.authority);
  vi.clearAllMocks();
  const context = await readDatabaseReviewContext({
    dataRoot: f.request.authority.resolvedRoot,
    cwd: f.request.authority.resolvedRoot,
    projectId: f.request.authority.projectId,
    reviewId: f.request.reviewId,
  });
  expect(context.run!.runId).toBe(newerRunId);
  expect(context.selection.current_run_id).toBe(newerRunId);
  expect(context.story!.runId).toBe(f.request.runId);
  expect(context.story!.bytes).toEqual(Buffer.from(settled.value.terminalBytes, 'base64'));
  expect(context.story!.publications.find((p) => p.kind === 'story')!.publicationId).toBe(
    f.request.publicationId
  );
  expect(context.counters).toEqual(before.counters);
  expect(context.storyMatchesSelectedFloor).toBe(true);
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect((await terminalRows(f.request.authority)).counters).toEqual(before.counters);
  const output: string[] = [];
  const writing = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const argv = [
    'review',
    'state',
    'health',
    '--project',
    f.request.authority.projectId,
    '--review',
    f.request.reviewId,
    '--json',
  ];
  const env = {
    ORCAOPS_DATA_DIR: f.request.authority.resolvedRoot,
    ORCAOPS_ROOT: f.request.authority.resolvedRoot,
  };
  try {
    expect(await runReview(argv, env)).toBe(0);
    const healthy = JSON.parse(output.at(-1)!);
    expect(healthy.states.find((state: { kind: string }) => state.kind === 'STORY')).toMatchObject({
      status: 'HEALTHY',
      run_id: f.request.runId,
      publication_id: f.request.publicationId,
    });
    const originalFloor = f.f.f.f.input;
    const replacement = await prepareDatabaseReviewFloor({
      ...originalFloor,
      expected: { ...originalFloor.expected, floorVersion: 1 },
      generatedAt: '2026-06-01T00:01:00.000Z',
    });
    await publishDatabaseReviewFloor({
      authority: f.request.authority,
      reviewId: f.request.reviewId,
      operationId: uuidv7(),
      publicationId: uuidv7(),
      secretAllow: [],
      basis: replacement.basis,
      expected: replacement.expected,
      floorBytes: replacement.floorBytes,
      diffBytes: replacement.diffBytes,
    });
    const changed = (await terminalRows(f.request.authority)).counters;
    expect(await runReview(argv, env)).toBe(1);
    const stale = JSON.parse(output.at(-1)!);
    expect(stale.status).toBe('BLOCKED');
    expect(stale.states.find((state: { kind: string }) => state.kind === 'STORY')).toMatchObject({
      status: 'STALE',
      run_id: f.request.runId,
      publication_id: f.request.publicationId,
      matches_selected_floor: false,
    });
    expect((await terminalRows(f.request.authority)).counters).toEqual(changed);
  } finally {
    writing.mockRestore();
  }
}, 20_000);
