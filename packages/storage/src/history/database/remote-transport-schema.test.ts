import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { prepareProjectRemoteRequest, remoteRequestPreparation } from './remote-transport-input.js';
import { PROJECT_DATABASE_SCHEMA } from './schema.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
function fixture() {
  const database = new Database(':memory:');
  databases.push(database);
  database.pragma('foreign_keys = ON');
  database.pragma('recursive_triggers = OFF');
  database.exec(PROJECT_DATABASE_SCHEMA);
  const version = database.pragma('user_version', { simple: true });
  expect(database.pragma('user_version', { simple: true })).toBe(version);
  return database;
}
function receipt(database: Database.Database, operationId: string) {
  database
    .prepare(
      "INSERT INTO operations VALUES (?, 'remote.fixture', 0, '{}', '{}', ?, 'null', '{}', 1, 0)"
    )
    .run(operationId, 'a'.repeat(64));
}
function request(account = 'account', payload = ' {"original": true}\n') {
  const value = remoteRequestPreparation(
    prepareProjectRemoteRequest(
      {
        operationId: uuidv7(),
        requestId: uuidv7(),
        expectedSelection: null,
        scope: {
          target: { server_url: 'https://example.test/Api', org_id: 'org', account_id: account },
          artifactId: null,
          method: 'sourcePlan.create',
          targetExternalId: 'subject:exact',
          idempotencyKey: 'original-key',
        },
        payloadBytes: Buffer.from(payload),
        preparedAt: '2026-09-01T01:02:03.123Z',
      },
      { secretAllow: [] }
    )
  );
  return {
    request_id: value.requestId,
    operation_id: value.operationId,
    ...value.scope.target,
    artifact_id: value.scope.artifactId,
    artifact_scope: value.scope.artifactId ?? '',
    method: value.scope.method,
    target_external_id: value.scope.targetExternalId,
    idempotency_key: value.scope.idempotencyKey,
    payload_bytes: Buffer.from(value.payloadBase64, 'base64'),
    payload_sha256: value.payloadSha256,
    request_key: value.requestKey,
    prepared_at: value.preparedAt,
  };
}
type Request = ReturnType<typeof request>;
// A standalone request row carries the grouped-push owner columns at their defaults.
function standalone(value: Request) {
  return { ...value, owner_kind: 'standalone', push_id: null, call_ordinal: null };
}
function attempt(value: Request) {
  return {
    attempt_id: uuidv7(),
    request_id: value.request_id,
    operation_id: uuidv7(),
    attempted_at: value.prepared_at,
  };
}
type Attempt = ReturnType<typeof attempt>;
function outcome(value: Attempt, kind: 'ack_unknown' | 'acknowledged' = 'ack_unknown', n = 1) {
  const bytes = kind === 'acknowledged' ? Buffer.from(' {"accepted":true}\n') : null;
  return {
    outcome_id: uuidv7(),
    request_id: value.request_id,
    attempt_id: value.attempt_id,
    operation_id: uuidv7(),
    outcome_n: n,
    kind,
    observed_at: value.attempted_at,
    response_bytes: bytes,
    response_sha256: bytes === null ? null : digest(bytes),
    failure_kind: bytes === null ? 'unknown' : null,
    failure_message: bytes === null ? 'Connection interrupted' : null,
  };
}
function insert(database: Database.Database, table: string, value: object, replace = false) {
  const row = value as Record<string, unknown>;
  database
    .prepare(
      `INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(
        row
      )
        .map((key) => `@${key}`)
        .join(', ')})`
    )
    .run(row);
}
function retain(database: Database.Database, table: string, value: { operation_id: string }) {
  insert(database, table, value);
  receipt(database, value.operation_id);
}
function selection(value: Request) {
  return {
    server_url: value.server_url,
    org_id: value.org_id,
    account_id: value.account_id,
    artifact_scope: value.artifact_scope,
    method: value.method,
    target_external_id: value.target_external_id,
    idempotency_key: value.idempotency_key,
    request_id: value.request_id,
    attempt_id: null as string | null,
    outcome_id: null as string | null,
    version: 1,
  };
}
function prepared(database: Database.Database, account = 'account') {
  const value = request(account);
  database.transaction(() => {
    retain(database, 'remote_requests', value);
    insert(database, 'remote_current', selection(value));
  })();
  return value;
}
function admitted(database: Database.Database, value: Request) {
  const send = attempt(value);
  database.transaction(() => {
    retain(database, 'remote_attempts', send);
    database
      .prepare(
        'UPDATE remote_current SET attempt_id = ?, version = version + 1 WHERE request_id = ? AND version = 1'
      )
      .run(send.attempt_id, value.request_id);
  })();
  return send;
}
function observe(
  database: Database.Database,
  send: Attempt,
  kind: 'ack_unknown' | 'acknowledged',
  n: number
) {
  const value = outcome(send, kind, n);
  database.transaction(() => {
    retain(database, 'remote_outcomes', value);
    database
      .prepare(
        'UPDATE remote_current SET outcome_id = ?, version = version + 1 WHERE request_id = ?'
      )
      .run(value.outcome_id, send.request_id);
  })();
  return value;
}
function snapshot(database: Database.Database) {
  return Object.fromEntries(
    ['remote_requests', 'remote_attempts', 'remote_outcomes', 'remote_current', 'operations'].map(
      (table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]
    )
  );
}

it('retains original unknown observations and acknowledgment without changing the installed schema version', () => {
  const database = fixture();
  const value = prepared(database);
  const send = admitted(database, value);
  const unknown = observe(database, send, 'ack_unknown', 1);
  const acknowledged = observe(database, send, 'acknowledged', 2);
  expect(database.prepare('SELECT * FROM remote_requests').get()).toEqual(standalone(value));
  expect(database.prepare('SELECT * FROM remote_outcomes ORDER BY outcome_n').all()).toEqual([
    unknown,
    acknowledged,
  ]);
  expect(database.prepare('SELECT * FROM remote_current').get()).toEqual({
    ...selection(value),
    attempt_id: send.attempt_id,
    outcome_id: acknowledged.outcome_id,
    version: 4,
  });
  expect(database.pragma('foreign_key_check')).toEqual([]);
});

it.each(['request_id', 'operation_id', 'request_key'] as const)(
  'protects the retained request %s key from replacement',
  (key) => {
    const database = fixture();
    const original = prepared(database);
    const changed = request('account', '{"different":true}');
    changed[key] = original[key];
    const before = snapshot(database);
    expect(() => insert(database, 'remote_requests', changed, true)).toThrow(
      'Remote requests are immutable'
    );
    expect(snapshot(database)).toEqual(before);
  }
);

it.each(['attempt_id', 'request_id', 'operation_id'] as const)(
  'protects the retained attempt %s key from replacement',
  (key) => {
    const database = fixture();
    const original = admitted(database, prepared(database));
    const changed = attempt(prepared(database, 'another'));
    changed[key] = original[key];
    const before = snapshot(database);
    expect(() => insert(database, 'remote_attempts', changed, true)).toThrow('one send admission');
    expect(snapshot(database)).toEqual(before);
  }
);

it.each(['outcome_id', 'operation_id', 'position', 'acknowledgment'] as const)(
  'protects the retained outcome %s key from replacement',
  (key) => {
    const database = fixture();
    const send = admitted(database, prepared(database));
    const original = observe(database, send, 'acknowledged', 1);
    const changed = outcome(admitted(database, prepared(database, 'another')), 'acknowledged');
    if (key === 'outcome_id' || key === 'operation_id') changed[key] = original[key];
    else {
      changed.request_id = original.request_id;
      changed.attempt_id = original.attempt_id;
      changed.outcome_n = key === 'position' ? 1 : 2;
    }
    const before = snapshot(database);
    expect(() => insert(database, 'remote_outcomes', changed, true)).toThrow('Remote observations');
    expect(snapshot(database)).toEqual(before);
  }
);

it.each(['remote_requests', 'remote_attempts', 'remote_outcomes'])(
  'rejects update and deletion of %s',
  (table) => {
    const database = fixture();
    observe(database, admitted(database, prepared(database)), 'ack_unknown', 1);
    const before = snapshot(database);
    expect(() => database.exec(`UPDATE ${table} SET operation_id = operation_id`)).toThrow(
      'immutable'
    );
    expect(() => database.exec(`DELETE FROM ${table}`)).toThrow('retained');
    expect(snapshot(database)).toEqual(before);
  }
);

it('allows one send admission and refuses stale unknown observations after acknowledgment', () => {
  const database = fixture();
  const value = prepared(database);
  const send = admitted(database, value);
  const unknown = observe(database, send, 'ack_unknown', 1);
  observe(database, send, 'acknowledged', 2);
  const before = snapshot(database);
  expect(() => insert(database, 'remote_attempts', attempt(value))).toThrow('one send admission');
  expect(() => insert(database, 'remote_outcomes', outcome(send, 'ack_unknown', 3))).toThrow(
    'immutable'
  );
  expect(() =>
    database
      .prepare('UPDATE remote_current SET outcome_id = ?, version = version + 1')
      .run(unknown.outcome_id)
  ).toThrow('next valid state');
  expect(snapshot(database)).toEqual(before);
});

it('requires exact request and attempt parents and original receipts at commit', () => {
  const database = fixture();
  const first = admitted(database, prepared(database));
  const second = admitted(database, prepared(database, 'another'));
  const before = snapshot(database);
  for (const missing of ['receipt', 'parent']) {
    database.exec('BEGIN IMMEDIATE');
    const value = outcome(first);
    if (missing === 'parent') value.attempt_id = second.attempt_id;
    insert(database, 'remote_outcomes', value);
    if (missing === 'parent') receipt(database, value.operation_id);
    expect(() => database.exec('COMMIT')).toThrow('FOREIGN KEY constraint failed');
    database.exec('ROLLBACK');
    expect(snapshot(database)).toEqual(before);
  }
});

it('requires current selections to reference the complete request namespace and exact outcome parents', () => {
  const database = fixture();
  const first = prepared(database);
  const second = prepared(database, 'another');
  const send = admitted(database, first);
  const other = observe(database, admitted(database, second), 'ack_unknown', 1);
  const unsent = prepared(database, 'unsent');
  const before = snapshot(database);
  database.exec('BEGIN IMMEDIATE');
  database
    .prepare('UPDATE remote_current SET outcome_id = ?, version = version + 1 WHERE request_id = ?')
    .run(other.outcome_id, send.request_id);
  expect(() => database.exec('COMMIT')).toThrow('FOREIGN KEY constraint failed');
  database.exec('ROLLBACK');
  expect(snapshot(database)).toEqual(before);
  database.exec('BEGIN IMMEDIATE');
  insert(database, 'remote_current', { ...selection(unsent), account_id: 'foreign' });
  expect(() => database.exec('COMMIT')).toThrow('FOREIGN KEY constraint failed');
  database.exec('ROLLBACK');
  expect(snapshot(database)).toEqual(before);
});

it('retains full slot identities and only advances an acknowledged slot to a new prepared request', () => {
  const database = fixture();
  const first = prepared(database, 'shared-prefix-' + 'a'.repeat(200) + 'one');
  prepared(database, 'shared-prefix-' + 'a'.repeat(200) + 'two');
  const next = request(first.account_id, '{"next":true}');
  const before = snapshot(database);
  expect(() =>
    database.transaction(() => {
      retain(database, 'remote_requests', next);
      database
        .prepare('UPDATE remote_current SET request_id = ?, version = 2 WHERE request_id = ?')
        .run(next.request_id, first.request_id);
    })()
  ).toThrow('next valid state');
  expect(snapshot(database)).toEqual(before);
  observe(database, admitted(database, first), 'acknowledged', 1);
  database.transaction(() => {
    retain(database, 'remote_requests', next);
    database
      .prepare(
        'UPDATE remote_current SET request_id = ?, attempt_id = NULL, outcome_id = NULL, version = version + 1 WHERE request_id = ?'
      )
      .run(next.request_id, first.request_id);
  })();
  expect(
    database.prepare('SELECT * FROM remote_current WHERE request_id = ?').get(next.request_id)
  ).toEqual({ ...selection(next), version: 4 });
  expect(database.prepare('SELECT count(*) AS n FROM remote_requests').get()).toEqual({ n: 3 });
});

it('rejects replacement, deletion, namespace changes and invalid versions of current selections', () => {
  const database = fixture();
  const value = prepared(database);
  const before = snapshot(database);
  expect(() => insert(database, 'remote_current', selection(value), true)).toThrow(
    'exact version update'
  );
  expect(() => database.exec('DELETE FROM remote_current')).toThrow('retained');
  for (const update of [
    "account_id = 'foreign', version = 2",
    'version = 3',
    'version = 2',
    'attempt_id = NULL, version = 0',
  ]) {
    expect(() => database.exec(`UPDATE remote_current SET ${update}`)).toThrow('next valid state');
  }
  expect(snapshot(database)).toEqual(before);
});

it('refuses malformed response pairs, skipped observation positions and malformed request columns', () => {
  const database = fixture();
  const send = admitted(database, prepared(database));
  const original = snapshot(database);
  for (const patch of [
    { response_bytes: Buffer.from('{}') },
    { response_sha256: 'a'.repeat(64) },
    { failure_kind: 'arbitrary' },
    { failure_kind: null },
    { failure_message: null },
    { kind: 'acknowledged', failure_kind: null, failure_message: null },
    { outcome_n: 2 },
  ])
    expect(() => insert(database, 'remote_outcomes', { ...outcome(send), ...patch })).toThrow();
  for (const patch of [
    { method: 'arbitrary' },
    { account_id: '' },
    { artifact_scope: 'foreign' },
    { payload_bytes: Buffer.from('invalid') },
    { payload_sha256: 'wrong' },
    { request_key: 'wrong' },
  ]) {
    expect(() =>
      insert(database, 'remote_requests', { ...request('another'), ...patch })
    ).toThrow();
  }
  expect(snapshot(database)).toEqual(original);
});

it.each(['remote_requests', 'remote_attempts'])(
  'keeps %s provisional until its original receipt commits',
  (table) => {
    const database = fixture();
    const parent = table === 'remote_attempts' ? prepared(database) : null;
    const before = snapshot(database);
    const value = parent === null ? request() : attempt(parent);
    database.exec('BEGIN IMMEDIATE');
    insert(database, table, value);
    expect(() => database.exec('COMMIT')).toThrow('FOREIGN KEY constraint failed');
    database.exec('ROLLBACK');
    expect(snapshot(database)).toEqual(before);
    database.transaction(() => retain(database, table, value))();
    expect(database.prepare(`SELECT * FROM ${table}`).all()).toContainEqual(
      parent === null ? standalone(value as Request) : value
    );
  }
);

it('preserves every full namespace field as a distinct slot and begins each slot prepared', () => {
  const database = fixture();
  const original = request();
  const fieldChanges = [
    { server_url: 'https://example.test/api' },
    { org_id: 'other-org' },
    { account_id: 'other-account' },
    { artifact_id: uuidv7() },
    { method: 'sourcePlan.reviewPush' },
    { target_external_id: 'other:subject' },
    { idempotency_key: 'other-key' },
  ];
  database.transaction(() => {
    for (const patch of [{}, ...fieldChanges]) {
      const value = { ...original, ...patch, request_id: uuidv7(), operation_id: uuidv7() };
      value.artifact_scope = value.artifact_id ?? '';
      retain(database, 'remote_requests', value);
      insert(database, 'remote_current', selection(value));
    }
  })();
  expect(database.prepare('SELECT count(*) AS n FROM remote_current').get()).toEqual({ n: 8 });
  const before = snapshot(database);
  database.exec('BEGIN IMMEDIATE');
  const value = request('next');
  retain(database, 'remote_requests', value);
  expect(() => insert(database, 'remote_current', { ...selection(value), version: 2 })).toThrow(
    'begins with a prepared request'
  );
  expect(() =>
    insert(database, 'remote_current', { ...selection(value), attempt_id: uuidv7() })
  ).toThrow('begins with a prepared request');
  database.exec('ROLLBACK');
  expect(snapshot(database)).toEqual(before);
});

it('never reselects an already admitted request as a new prepared request', () => {
  const database = fixture();
  const first = prepared(database);
  observe(database, admitted(database, first), 'acknowledged', 1);
  const next = request(first.account_id, '{"next":true}');
  database.transaction(() => {
    retain(database, 'remote_requests', next);
    database
      .prepare(
        'UPDATE remote_current SET request_id = ?, attempt_id = NULL, outcome_id = NULL, version = version + 1'
      )
      .run(next.request_id);
  })();
  observe(database, admittedAtCurrent(database, next), 'acknowledged', 1);
  const before = snapshot(database);
  expect(() =>
    database
      .prepare(
        'UPDATE remote_current SET request_id = ?, attempt_id = NULL, outcome_id = NULL, version = version + 1'
      )
      .run(first.request_id)
  ).toThrow('next valid state');
  expect(snapshot(database)).toEqual(before);
});

function admittedAtCurrent(database: Database.Database, value: Request) {
  const send = attempt(value);
  database.transaction(() => {
    retain(database, 'remote_attempts', send);
    database
      .prepare(
        'UPDATE remote_current SET attempt_id = ?, version = version + 1 WHERE request_id = ?'
      )
      .run(send.attempt_id, value.request_id);
  })();
  return send;
}

it('refuses to invent a prepared selection for a retained admitted request', () => {
  const database = fixture();
  const value = request();
  database.transaction(() => {
    retain(database, 'remote_requests', value);
    retain(database, 'remote_attempts', attempt(value));
  })();
  const before = snapshot(database);
  expect(() => insert(database, 'remote_current', selection(value))).toThrow(
    'begins with a prepared request'
  );
  expect(snapshot(database)).toEqual(before);
});
