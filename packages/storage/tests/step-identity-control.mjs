import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const candidate = path.resolve(process.argv[2]);
const load = (file) => import(pathToFileURL(path.join(candidate, 'packages/storage/dist', file)));
const api = await load('history/database/index.js');
const { normalizeHistoryRoot } = await load('history/paths.js');
const { recordChecksum } = await load('history/event-integrity.js');
const { uuidv7 } = await load('ids/uuidv7.js');
const { buildDefaultSkippedSnapshotBoundary, buildDefaultSkippedFingerprintSummary } = await load(
  'schema/diff-fingerprint.js'
);
const saved = JSON.parse(
  await readFile(
    path.join(candidate, 'packages/storage/src/history/database/fixtures/artifact-history.json'),
    'utf8'
  )
);
const first = saved.rows.artifact_events[0];
const record = JSON.parse(Buffer.from(first.record_bytes.blobHex, 'hex').toString());
const template =
  record.payload ?? JSON.parse(Buffer.from(first.sidecar_payload_bytes.blobHex, 'hex').toString());
const temporary = await mkdtemp(path.join(tmpdir(), 'statistics-identity-'));
let handle;
try {
  const root = await normalizeHistoryRoot({ root: temporary });
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(api.projectDatabasePath(authority)), { recursive: true });
  handle = await api.initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  const artifactId = uuidv7();
  const stepId = 'original non-UUID step';
  const plan = {
    ...template,
    artifact_id: artifactId,
    plan_steps: [{ ...template.plan_steps[0], step_id: stepId }],
  };
  delete plan.source_event_id;
  const event = (type, payload) => {
    const value = {
      event_id: uuidv7(),
      type,
      ts: '2026-06-01T00:00:00.000Z',
      schema_version: 1,
      idempotency_key: uuidv7(),
      payload,
    };
    return { ...value, checksum: recordChecksum(value) };
  };
  const initial = event('plan_captured', plan);
  const request = {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: null,
    eventBytes: Buffer.from(`${JSON.stringify(initial)}\n`),
    sidecarPayloads: [],
    secretAllow: [],
  };
  const published = await api.appendProjectArtifactEvents(handle, request);
  const open = event('checkpoint_opened', {
    schema_version: 4,
    artifact_id: artifactId,
    n: 1,
    declared_step_ids: [stepId],
    agent: 'codex',
    policy_exceptions: [],
    plan_revision_id: initial.event_id,
    open_plan_revision_event_id: initial.event_id,
    opened_at: '2026-06-01T00:01:00.000Z',
    head_sha: 'original-head',
    open_snapshot: buildDefaultSkippedSnapshotBoundary(),
  });
  const close = event('checkpoint_closed', {
    artifact_id: artifactId,
    n: 1,
    ts: '2026-06-01T00:02:00.000Z',
    closed_by_agent: 'codex',
    head_sha: 'original-head',
    summary: 'Retain original step completion',
    files_changed: [],
    decisions: [],
    uncertainty: [],
    done_criteria: [],
    completed_step_ids: [stepId],
    close_snapshot: buildDefaultSkippedSnapshotBoundary(),
    diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
  });
  await api.appendProjectArtifactEvents(handle, {
    ...request,
    operationId: uuidv7(),
    expectedRevision: published.value.revision,
    eventBytes: Buffer.from([open, close].map((value) => `${JSON.stringify(value)}\n`).join('')),
  });
  const read = api.readProjectArtifact(handle, artifactId);
  assert.equal(read.thread.plan.plan_steps[0].step_id, stepId);
  assert.deepEqual(read.thread.checkpoints[0].completed_step_ids, [stepId]);
  const details = handle.read((view) =>
    view.get('SELECT details_json FROM artifact_query_metadata WHERE artifact_id=?', artifactId)
  ).value;
  assert.deepEqual(JSON.parse(details.details_json).planStepIds, [stepId]);
  assert.deepEqual(JSON.parse(details.details_json).closedCheckpoints[0].completed_step_ids, [
    stepId,
  ]);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      schema: handle.read((view) => view.get('SELECT user_version FROM pragma_user_version')).value,
      originalStepId: stepId,
      checks: [
        'actual initial non-UUID identity publication',
        'actual closed non-UUID completion',
        'retained thread and metadata exact identities',
      ],
    }) + '\n'
  );
} finally {
  handle?.close();
  await rm(temporary, { recursive: true, force: true });
}
