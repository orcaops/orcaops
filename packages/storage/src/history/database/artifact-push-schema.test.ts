import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { PROJECT_ARTIFACT_PUSH_SCHEMA } from './artifact-push-schema.js';
import { PROJECT_CLOUD_SYNC_SCHEMA } from './cloud-sync-schema.js';
import { PROJECT_GROUPED_REMOTE_TRANSPORT_SCHEMA } from './grouped-remote-schema.js';
import { PROJECT_SESSION_BRANCH_SCHEMA } from './session-branch-schema.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const scope = {
  artifact_id: uuidv7(),
  server_url: 'https://example.test',
  org_id: 'org',
  account_id: 'account',
};
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  // Minimal original owner tables make this a constraint fixture, not a migrated database.
  db.exec(`CREATE TABLE operations(operation_id TEXT PRIMARY KEY, operation_kind TEXT, payload_json TEXT);
    CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY);
    CREATE TABLE artifact_revisions(artifact_id TEXT, generation INTEGER, PRIMARY KEY(artifact_id,generation));
    CREATE TABLE usage_revisions(generation INTEGER PRIMARY KEY);
    CREATE TABLE git_retention_operations(original_operation_id TEXT PRIMARY KEY);`);
  db.prepare('INSERT INTO artifacts VALUES (?)').run(scope.artifact_id);
  db.prepare('INSERT INTO artifact_revisions VALUES (?,1)').run(scope.artifact_id);
  db.exec(
    PROJECT_GROUPED_REMOTE_TRANSPORT_SCHEMA +
      PROJECT_SESSION_BRANCH_SCHEMA +
      PROJECT_CLOUD_SYNC_SCHEMA +
      PROJECT_ARTIFACT_PUSH_SCHEMA
  );
  return db;
}
function put(db: Database.Database, table: string, row: Record<string, unknown>, replace = false) {
  db.prepare(
    `INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(
      row
    )
      .map(() => '?')
      .join(',')})`
  ).run(...Object.values(row));
}
function operation(
  db: Database.Database,
  operationId = uuidv7(),
  kind = 'constraint.fixture',
  payload = {}
) {
  db.prepare('INSERT INTO operations VALUES (?,?,?)').run(
    operationId,
    kind,
    JSON.stringify(payload)
  );
  return operationId;
}
function header() {
  return {
    push_id: uuidv7(),
    admission_operation_id: uuidv7(),
    terminal_operation_id: uuidv7(),
    ...scope,
    artifact_generation: 1,
    usage_generation: null,
    previous_push_id: null as string | null,
    previous_push_version: null as number | null,
    expected_cloud_revision_id: null as string | null,
    expected_cloud_version: null as number | null,
    session_repo_url: null,
    session_working_dir: null,
    session_revision_id: null,
    session_version: null,
    session_acknowledgement_id: null,
    session_result_revision_id: null,
    cloud_acknowledgement_id: uuidv7(),
    prepared_at: 'original preparation time',
    result_checkpoints: 0,
    result_summary: 0,
    result_evaluators: 0,
    result_source_plan_pinned: null,
    request_sha256: 'a'.repeat(64),
    call_count: 2,
    artifact_payload_hash: 'b'.repeat(64),
  };
}
type Header = ReturnType<typeof header>;
function request(h: Header, ordinal = 1) {
  const bytes = Buffer.from(' {"original":"wire bytes"}\n');
  return {
    request_id: uuidv7(),
    operation_id: h.admission_operation_id,
    owner_kind: 'artifact_push',
    push_id: h.push_id,
    call_ordinal: ordinal,
    ...scope,
    artifact_scope: scope.artifact_id,
    method: ordinal === 1 ? 'captureThread.start' : 'captureThread.attachPlan',
    target_external_id: scope.artifact_id,
    idempotency_key: h.push_id,
    payload_bytes: bytes,
    payload_sha256: digest(bytes),
    request_key: 'operation:' + 'c'.repeat(64),
    prepared_at: h.prepared_at,
  };
}
type Request = ReturnType<typeof request>;
function admit(db: Database.Database, h = header()) {
  const calls = [request(h, 1), request(h, 2)];
  db.transaction(() => {
    put(db, 'artifact_push_requests', h);
    calls.forEach((r) => put(db, 'remote_requests', r));
    operation(db, h.admission_operation_id, 'artifact.push.begin');
    put(db, 'artifact_push_current', { ...scope, push_id: h.push_id, version: 1 });
  })();
  return { h, calls };
}
function outcome(db: Database.Database, r: Request, kind = 'acknowledged') {
  const attemptId = uuidv7();
  put(db, 'remote_attempts', {
    attempt_id: attemptId,
    request_id: r.request_id,
    operation_id: operation(db),
    attempted_at: 'original send time',
  });
  const bytes = kind === 'acknowledged' ? Buffer.from(' {"accepted":true}\n') : null;
  const row = {
    outcome_id: uuidv7(),
    request_id: r.request_id,
    attempt_id: attemptId,
    operation_id: operation(db),
    outcome_n: 1,
    kind,
    observed_at: 'original observation time',
    response_bytes: bytes,
    response_sha256: bytes ? digest(bytes) : null,
    failure_kind: null,
    failure_message: null,
  };
  put(db, 'remote_outcomes', row);
  return row;
}
function terminalCall(db: Database.Database, h: Header, r: Request, o: ReturnType<typeof outcome>) {
  put(db, 'artifact_push_terminal_calls', {
    push_id: h.push_id,
    ordinal: r.call_ordinal,
    request_id: r.request_id,
    attempt_id: o.attempt_id,
    outcome_id: o.outcome_id,
  });
}
function cloud(db: Database.Database, h: Header) {
  put(db, 'cloud_sync_records', {
    revision_id: h.cloud_acknowledgement_id,
    operation_id: h.terminal_operation_id,
    kind: 'acknowledgement',
    ...scope,
    previous_revision_id: h.expected_cloud_revision_id,
    previous_version: h.expected_cloud_version,
    applied: 1,
    push_id: h.push_id,
    artifact_generation: 1,
    usage_generation: null,
    acknowledged_at: 'original terminal time',
    failure_kind: null,
    failure_message: null,
    attempted_at: null,
    attempt_started_at: null,
    record_sha256: 'd'.repeat(64),
  });
  put(db, 'cloud_sync_current', { ...scope, revision_id: h.cloud_acknowledgement_id, version: 1 });
}
function terminal(db: Database.Database, h: Header) {
  put(db, 'artifact_push_terminals', {
    push_id: h.push_id,
    operation_id: h.terminal_operation_id,
    acknowledged_at: 'original terminal time',
    session_applied: null,
    cloud_applied: 1,
    outcome_count: 2,
  });
}
function complete(db: Database.Database, admitted: ReturnType<typeof admit>) {
  const { h, calls } = admitted;
  const outcomes = calls.map((r) => outcome(db, r));
  db.transaction(() => {
    calls.forEach((r, i) => terminalCall(db, h, r, outcomes[i]!));
    cloud(db, h);
    terminal(db, h);
    operation(db, h.terminal_operation_id, 'artifact.push.complete');
  })();
}

it('retains one admission owner for ordered calls and one wire-byte owner', () => {
  const db = fixture();
  const { h, calls } = admit(db);
  expect(
    db.prepare('SELECT operation_id,payload_bytes FROM remote_requests ORDER BY call_ordinal').all()
  ).toEqual(
    calls.map((r) => ({ operation_id: h.admission_operation_id, payload_bytes: r.payload_bytes }))
  );
  expect(db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 1 });
  expect(
    (db.pragma('table_info(artifact_push_requests)') as { name: string }[]).map((r) => r.name)
  ).not.toContain('payload_bytes');
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('keeps standalone operation uniqueness and exact original bytes', () => {
  const db = fixture();
  const row = {
    ...request(header()),
    operation_id: operation(db),
    owner_kind: 'standalone',
    push_id: null,
    call_ordinal: null,
  };
  put(db, 'remote_requests', row);
  expect(() =>
    put(db, 'remote_requests', { ...row, request_id: uuidv7(), method: 'captureThread.attachPlan' })
  ).toThrow('immutable');
  expect(db.prepare('SELECT payload_bytes FROM remote_requests').get()).toEqual({
    payload_bytes: row.payload_bytes,
  });
});

it('refuses changed group scope, owner, ordering and an unrelated remote method', () => {
  const db = fixture();
  const h = header();
  db.transaction(() => {
    put(db, 'artifact_push_requests', h);
    operation(db, h.admission_operation_id);
  })();
  const r = request(h);
  for (const change of [
    { account_id: 'other' },
    { operation_id: uuidv7() },
    { call_ordinal: 3 },
    { method: 'sourcePlan.create' },
    { method: 'captureThread.attachPlan' },
    { prepared_at: 'changed' },
  ]) {
    expect(() => put(db, 'remote_requests', { ...r, ...change })).toThrow(
      'original push scope and order'
    );
  }
  put(db, 'remote_requests', r);
  expect(() => put(db, 'remote_requests', { ...r, request_id: uuidv7() }, true)).toThrow();
});

it.each(['usage.append', 'source_plan.record', 'remote.request', 'arbitrary.original.kind'])(
  'protects a pending terminal against operation family %s',
  (kind) => {
    const db = fixture();
    const { h } = admit(db);
    expect(() => operation(db, h.terminal_operation_id, kind)).toThrow('original artifact push');
    expect(db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 1 });
  }
);

it('refuses reciprocal Git and cleanup reservations and a second push terminal claim', () => {
  const db = fixture();
  const { h } = admit(db);
  expect(() =>
    db.prepare('INSERT INTO git_retention_operations VALUES (?)').run(h.terminal_operation_id)
  ).toThrow('original artifact push');
  expect(() =>
    operation(db, uuidv7(), 'git.retention.cleanup.begin', {
      terminalOperationId: h.terminal_operation_id,
    })
  ).toThrow('original artifact push');
  const another = { ...header(), terminal_operation_id: h.terminal_operation_id };
  expect(() => db.transaction(() => put(db, 'artifact_push_requests', another))()).toThrow(
    'cannot be replaced'
  );
});

it('preserves existing committed and pending owners when admitting a push', () => {
  const db = fixture();
  const committed = operation(db);
  const git = uuidv7();
  const cleanup = uuidv7();
  db.prepare('INSERT INTO git_retention_operations VALUES (?)').run(git);
  operation(db, uuidv7(), 'git.retention.cleanup.begin', { terminalOperationId: cleanup });
  for (const id of [committed, git, cleanup]) {
    expect(() =>
      put(db, 'artifact_push_requests', { ...header(), terminal_operation_id: id })
    ).toThrow('retained original history');
  }
  expect(db.prepare('SELECT count(*) AS n FROM artifact_push_requests').get()).toEqual({ n: 0 });
  admit(db);
});

it('refuses unknown or missing outcomes without a local terminal', () => {
  const db = fixture();
  const { h, calls } = admit(db);
  const unknown = outcome(db, calls[0]!, 'ack_unknown');
  expect(() => db.transaction(() => terminalCall(db, h, calls[0]!, unknown))()).toThrow(
    'acknowledged outcome'
  );
  expect(() => terminal(db, h)).toThrow('all original outcomes');
  expect(db.prepare('SELECT count(*) AS n FROM artifact_push_terminals').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT kind FROM remote_outcomes').get()).toEqual({ kind: 'ack_unknown' });
});

it('requires local cloud result with all acknowledgments and retains the exact terminal identity', () => {
  const db = fixture();
  const admitted = admit(db);
  const { h, calls } = admitted;
  const outcomes = calls.map((r) => outcome(db, r));
  expect(() =>
    db.transaction(() => {
      calls.forEach((r, i) => terminalCall(db, h, r, outcomes[i]!));
      terminal(db, h);
    })()
  ).toThrow('all original outcomes');
  expect(db.prepare('SELECT count(*) AS n FROM artifact_push_terminal_calls').get()).toEqual({
    n: 0,
  });
  db.transaction(() => {
    calls.forEach((r, i) => terminalCall(db, h, r, outcomes[i]!));
    cloud(db, h);
    terminal(db, h);
    operation(db, h.terminal_operation_id, 'artifact.push.complete');
  })();
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(
    db.prepare('SELECT operation_id,acknowledged_at FROM artifact_push_terminals').get()
  ).toEqual({ operation_id: h.terminal_operation_id, acknowledged_at: 'original terminal time' });
  expect(() => db.exec('DELETE FROM artifact_push_terminals')).toThrow('retained');
});

it('requires a completed predecessor before a new push can advance selection', () => {
  const db = fixture();
  const admitted = admit(db);
  const { h } = admitted;
  const next = { ...header(), previous_push_id: h.push_id, previous_push_version: 1 };
  expect(() => put(db, 'artifact_push_requests', next)).toThrow('completed predecessor');
  complete(db, admitted);
  next.expected_cloud_revision_id = h.cloud_acknowledgement_id;
  next.expected_cloud_version = 1;
  expect(() => put(db, 'artifact_push_requests', { ...next, expected_cloud_version: 2 })).toThrow(
    'cloud selection version'
  );
  db.transaction(() => {
    put(db, 'artifact_push_requests', next);
    operation(db, next.admission_operation_id, 'artifact.push.begin');
    db.prepare('UPDATE artifact_push_current SET push_id=?,version=2').run(next.push_id);
  })();
  expect(db.prepare('SELECT push_id,version FROM artifact_push_current').get()).toEqual({
    push_id: next.push_id,
    version: 2,
  });
});
