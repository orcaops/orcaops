import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { PROJECT_DATABASE_BASE_SCHEMA } from './schema.js';
import { PROJECT_SESSION_BRANCH_SCHEMA } from './session-branch-schema.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const scope = {
  target_server_url: 'https://example.test',
  target_org_id: 'org',
  target_account_id: 'account',
  repo_url: 'original repo',
  working_dir: '/original checkout',
};
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  db.exec(PROJECT_DATABASE_BASE_SCHEMA);
  // The future push owner is a constraint fixture, not an admitted push or installed upgrade.
  db.exec(`CREATE TABLE artifact_push_requests (
    push_id TEXT PRIMARY KEY, terminal_operation_id TEXT UNIQUE,
    session_acknowledgement_id TEXT, session_result_revision_id TEXT,
    server_url TEXT, org_id TEXT, account_id TEXT, session_repo_url TEXT,
    session_working_dir TEXT, session_revision_id TEXT, session_version INTEGER,
    UNIQUE (push_id, terminal_operation_id)
  ) STRICT;`);
  db.exec(PROJECT_SESSION_BRANCH_SCHEMA);
  return db;
}
function insert(
  db: Database.Database,
  table: string,
  row: Record<string, unknown>,
  replace = false
) {
  db.prepare(
    `INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(
      row
    )
      .map(() => '?')
      .join(',')})`
  ).run(...Object.values(row));
}
function operation(db: Database.Database, id = uuidv7()) {
  db.prepare(
    "INSERT INTO operations VALUES (?, 'session.fixture', 0, '{}', '{}', ?, 'null', '{}', 1, 0)"
  ).run(id, 'a'.repeat(64));
  return id;
}
function revision(db: Database.Database) {
  const bytes = Buffer.from(' {"original":"state bytes"}\n');
  const row = {
    revision_id: uuidv7(),
    publication_operation_id: operation(db),
    state_bytes: bytes,
    origin_kind: 'observation',
    acknowledgement_id: null,
    ...scope,
    state_sha256: digest(bytes),
    current_branch: 'main',
    base_commit_sha: null,
    last_acked_at: null,
  };
  insert(db, 'session_branch_revisions', row);
  return row;
}
function acknowledgement(db: Database.Database, prior: ReturnType<typeof revision>) {
  const owner = {
    push_id: uuidv7(),
    terminal_operation_id: operation(db),
    session_acknowledgement_id: uuidv7(),
    session_result_revision_id: uuidv7(),
    server_url: scope.target_server_url,
    org_id: scope.target_org_id,
    account_id: scope.target_account_id,
    session_repo_url: scope.repo_url,
    session_working_dir: scope.working_dir,
    session_revision_id: prior.revision_id,
    session_version: 1,
  };
  insert(db, 'artifact_push_requests', owner);
  return {
    acknowledgement_id: owner.session_acknowledgement_id,
    operation_id: owner.terminal_operation_id,
    ...scope,
    expected_revision_id: prior.revision_id,
    expected_version: 1,
    push_id: owner.push_id,
    acked_at: 'original acknowledgement time',
    applied: 0,
    result_revision_id: null as string | null,
  };
}

it('retains original bytes and nullable scalars without installing a version', () => {
  const db = fixture();
  const before = db.pragma('user_version', { simple: true });
  const row = revision(db);
  expect(
    db
      .prepare('SELECT state_bytes, base_commit_sha, last_acked_at FROM session_branch_revisions')
      .get()
  ).toEqual({ state_bytes: row.state_bytes, base_commit_sha: null, last_acked_at: null });
  expect(db.pragma('user_version', { simple: true })).toBe(before);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('protects original revisions against replacement and operation reuse', () => {
  const db = fixture();
  const row = revision(db);
  expect(() =>
    insert(db, 'session_branch_revisions', { ...row, state_bytes: Buffer.from('{}') }, true)
  ).toThrow('cannot be replaced');
  expect(() =>
    insert(db, 'session_branch_revisions', { ...row, revision_id: uuidv7() }, true)
  ).toThrow('cannot be replaced');
  expect(() =>
    db.prepare('UPDATE session_branch_revisions SET current_branch = ?').run('other')
  ).toThrow('immutable');
  expect(() => db.exec('DELETE FROM session_branch_revisions')).toThrow('retained');
  expect(db.prepare('SELECT state_bytes FROM session_branch_revisions').get()).toEqual({
    state_bytes: row.state_bytes,
  });
});

it('keeps current scope exact and advances only to a different revision', () => {
  const db = fixture();
  const first = revision(db);
  const selected = { ...scope, revision_id: first.revision_id, version: 1 };
  expect(() =>
    insert(db, 'session_branch_current', { ...selected, target_account_id: 'other' })
  ).toThrow('FOREIGN KEY');
  insert(db, 'session_branch_current', selected);
  expect(() => insert(db, 'session_branch_current', selected, true)).toThrow('start once');
  expect(() => db.exec('UPDATE session_branch_current SET version = version + 1')).toThrow(
    'advance'
  );
  const next = revision(db);
  db.prepare('UPDATE session_branch_current SET revision_id = ?, version = 2').run(
    next.revision_id
  );
  expect(db.prepare('SELECT revision_id, version FROM session_branch_current').get()).toEqual({
    revision_id: next.revision_id,
    version: 2,
  });
  expect(() => db.exec('DELETE FROM session_branch_current')).toThrow('retained');
});

it('binds acknowledgment to original push scope, version and reserved identities', () => {
  const db = fixture();
  const original = revision(db);
  const row = acknowledgement(db, original);
  for (const change of [
    { acknowledgement_id: uuidv7() },
    { operation_id: operation(db) },
    { target_account_id: 'other' },
    { expected_version: 2 },
    { expected_revision_id: uuidv7() },
  ]) {
    expect(() => insert(db, 'session_branch_acknowledgements', { ...row, ...change })).toThrow(
      'original push target'
    );
  }
  insert(db, 'session_branch_acknowledgements', row);
  expect(() => insert(db, 'session_branch_acknowledgements', row, true)).toThrow(
    'cannot be replaced'
  );
  expect(() => db.exec('UPDATE session_branch_acknowledgements SET applied = 1')).toThrow(
    'immutable'
  );
  expect(() => db.exec('DELETE FROM session_branch_acknowledgements')).toThrow('retained');
});

it('retains a stale acknowledgment without a fabricated result revision', () => {
  const db = fixture();
  const prior = revision(db);
  const row = acknowledgement(db, prior);
  expect(() =>
    insert(db, 'session_branch_acknowledgements', { ...row, result_revision_id: uuidv7() })
  ).toThrow('CHECK');
  insert(db, 'session_branch_acknowledgements', row);
  expect(
    db.prepare('SELECT applied, result_revision_id FROM session_branch_acknowledgements').get()
  ).toEqual({ applied: 0, result_revision_id: null });
  expect(db.prepare('SELECT count(*) AS n FROM session_branch_revisions').get()).toEqual({ n: 1 });
});

it('requires an applied acknowledgment and its exact result revision to commit together', () => {
  const db = fixture();
  const prior = revision(db);
  const row = acknowledgement(db, prior);
  const owner = db
    .prepare('SELECT session_result_revision_id FROM artifact_push_requests WHERE push_id = ?')
    .get(row.push_id) as { session_result_revision_id: string };
  const applied = { ...row, applied: 1, result_revision_id: owner.session_result_revision_id };
  expect(() => insert(db, 'session_branch_acknowledgements', applied)).toThrow('FOREIGN KEY');
  db.transaction(() => {
    insert(db, 'session_branch_acknowledgements', applied);
    insert(db, 'session_branch_revisions', {
      ...prior,
      revision_id: applied.result_revision_id,
      publication_operation_id: row.operation_id,
      origin_kind: 'acknowledgement',
      acknowledgement_id: row.acknowledgement_id,
      last_acked_at: row.acked_at,
    });
  })();
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
