import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

import { gitRetentionPreparation, prepareProjectGitRetention } from './retention-input.js';
import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
function database() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  return db;
}
function receipt(db: Database.Database, id = uuidv7()) {
  db.prepare(
    "INSERT INTO operations VALUES (?, 'retention.fixture', 0, '{}', '{}', ?, 'null', '{}', 1, 0)"
  ).run(id, 'a'.repeat(64));
  return id;
}
function prepared(
  db: Database.Database,
  artifactId = uuidv7(),
  repositoryId = uuidv7(),
  expectedBaseline: string | null = null
) {
  const operationId = uuidv7(),
    admissionId = receipt(db),
    transitionId = uuidv7();
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    "INSERT INTO git_retention_operations VALUES (?, ?, ?, 'capture', ?, NULL, 'sha1', '2026-09-01T00:00:00.000Z', ?)"
  ).run(operationId, admissionId, repositoryId, operationId, 'a'.repeat(64));
  db.prepare(
    "INSERT INTO git_retention_capture_targets VALUES (?, 'capture', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)"
  ).run(operationId, artifactId, expectedBaseline);
  db.prepare(
    "INSERT INTO git_retention_transitions VALUES (?, ?, NULL, 0, 'prepared', ?, NULL)"
  ).run(transitionId, operationId, admissionId);
  db.prepare('INSERT INTO git_retention_current VALUES (?, ?)').run(operationId, transitionId);
  db.exec('COMMIT');
  return { operationId, admissionId, transitionId, artifactId, repositoryId };
}
function publication(db: Database.Database, value: ReturnType<typeof prepared>) {
  const publicationId = uuidv7(),
    targetId = uuidv7();
  const input = {
    operationId: value.operationId,
    admissionOperationId: value.admissionId,
    preparedTransitionId: value.transitionId,
    repositoryInstanceId: value.repositoryId,
    objectFormat: 'sha1' as const,
    createdAt: '2026-09-01T00:00:00.000Z',
    target: {
      kind: 'capture' as const,
      artifactId: value.artifactId,
      expectedRevision: null,
      expectedExecutionVersion: null,
      expectedBindingGeneration: null,
      expectedBaselinePublicationId: null,
    },
    publications: [
      {
        publicationId,
        targetId,
        role: 'checkpoint' as const,
        checkpointNumber: 1,
        checkpointPhase: 'open' as const,
        objectOid: 'a'.repeat(40),
        treeOid: 'b'.repeat(40),
      },
    ],
    secretAllow: [],
  };
  const fullRef = gitRetentionPreparation(prepareProjectGitRetention(input)).publications[0]!
    .fullRef;
  db.prepare(
    "INSERT INTO git_retention_publications VALUES (?, ?, ?, 'checkpoint', ?, 1, 'open', ?, ?, ?)"
  ).run(
    publicationId,
    value.operationId,
    value.repositoryId,
    targetId,
    fullRef,
    'a'.repeat(40),
    'b'.repeat(40)
  );
  return publicationId;
}
function transition(
  db: Database.Database,
  value: ReturnType<typeof prepared>,
  kind: 'selected' | 'retired'
) {
  const id = uuidv7();
  const command = receipt(db, kind === 'selected' ? value.operationId : uuidv7());
  db.prepare('INSERT INTO git_retention_transitions VALUES (?, ?, ?, 1, ?, ?, ?)').run(
    id,
    value.operationId,
    value.transitionId,
    kind,
    command,
    kind === 'retired' ? 'Explicit authorized cancellation' : null
  );
  db.prepare(
    'UPDATE git_retention_current SET transition_id = ? WHERE original_operation_id = ?'
  ).run(id, value.operationId);
  return id;
}
it('requires complete same-operation typed target ownership at commit', () => {
  const db = database();
  const admission = receipt(db),
    operation = uuidv7();
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    "INSERT INTO git_retention_operations VALUES (?, ?, ?, 'capture', ?, NULL, 'sha1', 'time', 'hash')"
  ).run(operation, admission, uuidv7(), operation);
  expect(() => db.exec('COMMIT')).toThrow();
  db.exec('ROLLBACK');
  expect(db.prepare('SELECT * FROM git_retention_operations').all()).toEqual([]);
  expect(prepared(db)).toHaveProperty('operationId');
});
it('refuses legacy full refs as invented authored publications', () => {
  const db = database(),
    value = prepared(db);
  const legacyRef = `refs/orcaops/snap/${value.artifactId}/1/open`;
  expect(() =>
    db
      .prepare(
        "INSERT INTO git_retention_publications VALUES (?, ?, ?, 'checkpoint', ?, 1, 'open', ?, ?, ?)"
      )
      .run(
        uuidv7(),
        value.operationId,
        value.repositoryId,
        uuidv7(),
        legacyRef,
        'a'.repeat(40),
        'b'.repeat(40)
      )
  ).toThrow('exact owner');
  expect(db.prepare('SELECT * FROM git_retention_publications').all()).toEqual([]);
  expect(() => publication(db, value)).not.toThrow();
});
it('admits a new checkpoint publication after pending input was retired without its event', () => {
  const db = database(),
    first = prepared(db);
  const originalPublication = publication(db, first);
  transition(db, first, 'retired');
  expect(db.prepare('SELECT * FROM artifact_events').all()).toEqual([]);
  const next = prepared(db, first.artifactId, first.repositoryId);
  expect(() => publication(db, next)).not.toThrow();
  const rows = db
    .prepare(
      'SELECT publication_id, checkpoint_number, checkpoint_phase, full_ref FROM git_retention_publications ORDER BY publication_id'
    )
    .all() as Array<{
    publication_id: string;
    checkpoint_number: number;
    checkpoint_phase: string;
    full_ref: string;
  }>;
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.checkpoint_number === 1 && row.checkpoint_phase === 'open')).toBe(
    true
  );
  expect(new Set(rows.map((row) => row.full_ref)).size).toBe(2);
  expect(rows.some((row) => row.publication_id === originalPublication)).toBe(true);
  expect(() => publication(db, next)).toThrow('immutable');
});
it.each(['wrong-owner', 'wrong-role', 'wrong-format', 'zero-object'] as const)(
  'rejects a %s publication',
  (kind) => {
    const db = database(),
      value = prepared(db),
      publicationId = uuidv7();
    const ref = `refs/orcaops/snap/${kind === 'wrong-owner' ? uuidv7() : value.artifactId}/1/open`;
    expect(() =>
      db
        .prepare('INSERT INTO git_retention_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          publicationId,
          value.operationId,
          value.repositoryId,
          kind === 'wrong-role' ? 'review-floor' : 'checkpoint',
          uuidv7(),
          kind === 'wrong-role' ? null : 1,
          kind === 'wrong-role' ? null : 'open',
          ref,
          kind === 'zero-object' ? '0'.repeat(40) : 'a'.repeat(kind === 'wrong-format' ? 64 : 40),
          'b'.repeat(40)
        )
    ).toThrow();
    expect(() => publication(db, value)).not.toThrow();
  }
);
it.each([
  'git_retention_operations',
  'git_retention_capture_targets',
  'git_retention_publications',
  'git_retention_transitions',
])('protects %s from replacement and deletion with recursive triggers off', (table) => {
  const db = database(),
    value = prepared(db);
  publication(db, value);
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  const row = rows[0] as Record<string, unknown>;
  expect(() =>
    db
      .prepare(
        `INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
          .map(() => '?')
          .join(',')})`
      )
      .run(...Object.values(row))
  ).toThrow();
  expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('retained');
  expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
});
it('retires without allowing a stale publisher to select itself', () => {
  const db = database(),
    value = prepared(db);
  publication(db, value);
  const retired = transition(db, value, 'retired');
  expect(() => transition(db, value, 'selected')).toThrow();
  expect(() =>
    db
      .prepare('UPDATE git_retention_current SET transition_id = ? WHERE original_operation_id = ?')
      .run(value.transitionId, value.operationId)
  ).toThrow('predecessor');
  expect(db.prepare('SELECT transition_id FROM git_retention_current').get()).toEqual({
    transition_id: retired,
  });
  expect(db.prepare('SELECT COUNT(*) AS n FROM git_retention_publications').get()).toEqual({
    n: 1,
  });
});
it('retains a selected publication when an authorized later operation retires it', () => {
  const db = database(),
    value = prepared(db);
  publication(db, value);
  const selected = transition(db, value, 'selected'),
    retired = uuidv7();
  db.prepare(
    "INSERT INTO git_retention_transitions VALUES (?, ?, ?, 2, 'retired', ?, 'No new selection permitted')"
  ).run(retired, value.operationId, selected, receipt(db));
  db.prepare(
    'UPDATE git_retention_current SET transition_id = ? WHERE original_operation_id = ?'
  ).run(retired, value.operationId);
  expect(db.prepare('SELECT kind FROM git_retention_transitions ORDER BY ordinal').all()).toEqual([
    { kind: 'prepared' },
    { kind: 'selected' },
    { kind: 'retired' },
  ]);
  expect(() =>
    db
      .prepare('INSERT OR REPLACE INTO git_retention_current VALUES (?, ?)')
      .run(value.operationId, value.transitionId)
  ).toThrow();
});
it('cannot use cancellation to consume an original terminal receipt identity', () => {
  const db = database(),
    value = prepared(db);
  receipt(db, value.operationId);
  expect(() =>
    db
      .prepare("INSERT INTO git_retention_transitions VALUES (?, ?, ?, 1, 'retired', ?, 'cancel')")
      .run(uuidv7(), value.operationId, value.transitionId, value.operationId)
  ).toThrow('terminal');
});
it('retains exact review membership ownership and protects its original target', () => {
  const db = database();
  const reviewId = uuidv7(),
    membershipId = uuidv7(),
    operationId = uuidv7(),
    admissionId = receipt(db);
  db.prepare("INSERT INTO reviews VALUES (?, ?, ?, ?, 'main', NULL)").run(
    reviewId,
    Buffer.from('{}'),
    'a'.repeat(64),
    admissionId
  );
  db.prepare('INSERT INTO review_membership_revisions VALUES (?, ?, NULL, ?, ?, ?)').run(
    membershipId,
    reviewId,
    admissionId,
    Buffer.from('{}'),
    'a'.repeat(64)
  );
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    "INSERT INTO git_retention_operations VALUES (?, ?, ?, 'review', NULL, ?, 'sha1', 'time', 'hash')"
  ).run(operationId, admissionId, uuidv7(), operationId);
  db.prepare(
    "INSERT INTO git_retention_review_targets VALUES (?, 'review', ?, ?, NULL, NULL, NULL, NULL, 1, 0, 0, 0)"
  ).run(operationId, reviewId, membershipId);
  db.exec('COMMIT');
  const row = db.prepare('SELECT * FROM git_retention_review_targets').get() as Record<
    string,
    unknown
  >;
  expect(() =>
    db
      .prepare(
        `INSERT OR REPLACE INTO git_retention_review_targets (${Object.keys(row).join(',')}) VALUES (${Object.keys(
          row
        )
          .map(() => '?')
          .join(',')})`
      )
      .run(...Object.values(row))
  ).toThrow('immutable');
  const other = uuidv7();
  db.prepare("INSERT INTO reviews VALUES (?, ?, ?, ?, 'other', NULL)").run(
    other,
    Buffer.from('{}'),
    'a'.repeat(64),
    admissionId
  );
  const otherOperation = uuidv7(),
    otherAdmission = receipt(db);
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    "INSERT INTO git_retention_operations VALUES (?, ?, ?, 'review', NULL, ?, 'sha1', 'time', 'hash')"
  ).run(otherOperation, otherAdmission, uuidv7(), otherOperation);
  expect(() =>
    db
      .prepare(
        "INSERT INTO git_retention_review_targets VALUES (?, 'review', ?, ?, NULL, NULL, NULL, NULL, 1, 0, 0, 0)"
      )
      .run(otherOperation, other, membershipId)
  ).toThrow('FOREIGN KEY');
  db.exec('ROLLBACK');
});
it('retains pending authored bytes without publishing effective artifact history', () => {
  const db = database(),
    value = prepared(db);
  const eventId = uuidv7(),
    original = Buffer.from('  {"authored":"original input"}\n');
  db.prepare(
    "INSERT INTO pending_capture_requests VALUES (?, 'create', ?, ?, 'main', NULL, '2026-09-01T00:00:00.000Z', NULL, 0)"
  ).run(value.operationId, value.repositoryId, uuidv7());
  db.prepare(
    "INSERT INTO pending_capture_events VALUES (?, 1, ?, 'plan_captured', ?, NULL, 'checksum', 'hash', NULL)"
  ).run(value.operationId, eventId, original);
  expect(db.prepare('SELECT event_bytes FROM pending_capture_events').get()).toEqual({
    event_bytes: original,
  });
  expect(db.prepare('SELECT * FROM artifact_events').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM artifacts').all()).toEqual([]);
  transition(db, value, 'retired');
  expect(db.prepare('SELECT event_bytes FROM pending_capture_events').get()).toEqual({
    event_bytes: original,
  });
  for (const table of ['pending_capture_requests', 'pending_capture_events']) {
    const row = db.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>;
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(
            row
          )
            .map(() => '?')
            .join(',')})`
        )
        .run(...Object.values(row))
    ).toThrow('immutable');
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('retained');
  }
});
it('refuses partial pending context and mismatched sidecar presence', () => {
  const db = database(),
    value = prepared(db);
  expect(() =>
    db
      .prepare(
        "INSERT INTO pending_capture_requests VALUES (?, 'task', ?, ?, 'main', NULL, NULL, 1, 0)"
      )
      .run(value.operationId, value.repositoryId, uuidv7())
  ).toThrow('creation');
  db.prepare(
    "INSERT INTO pending_capture_requests VALUES (?, 'create', ?, ?, 'main', NULL, 'time', NULL, 0)"
  ).run(value.operationId, value.repositoryId, uuidv7());
  expect(() =>
    db
      .prepare(
        "INSERT INTO pending_capture_events VALUES (?, 1, ?, 'plan_captured', ?, NULL, 'checksum', 'hash', 'unmatched')"
      )
      .run(value.operationId, uuidv7(), Buffer.from('{}'))
  ).toThrow();
});
it('records reclamation only after exact permanent retirement without deleting retained input', () => {
  const db = database(),
    value = prepared(db),
    published = publication(db, value);
  const cleanup = receipt(db);
  const insert = (transitionId: string, oid = 'a'.repeat(40)) =>
    db
      .prepare("INSERT INTO git_retention_reclamations VALUES (?, ?, ?, ?, ?, 'removed')")
      .run(cleanup, published, value.operationId, transitionId, oid);
  expect(() => insert(value.transitionId)).toThrow('retired');
  const retired = transition(db, value, 'retired');
  expect(() => insert(retired, 'c'.repeat(40))).toThrow('retired');
  expect(() => insert(retired)).not.toThrow();
  expect(db.prepare('SELECT * FROM git_retention_publications').all()).toHaveLength(1);
  expect(() => insert(retired)).toThrow('immutable');
});
function retainedRows(db: Database.Database) {
  const saved = JSON.parse(
    readFileSync(new URL('./fixtures/retention-inputs.json', import.meta.url), 'utf8')
  ) as {
    rows: Record<string, Array<Record<string, string | number | null | { blobHex: string }>>>;
  };
  db.exec('BEGIN IMMEDIATE');
  db.pragma('defer_foreign_keys = ON');
  for (const [table, rows] of Object.entries(saved.rows))
    for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
      ).run(
        ...Object.values(row).map((value) =>
          value && typeof value === 'object' ? Buffer.from(value.blobHex, 'hex') : value
        )
      );
    }
  db.exec('COMMIT');
  return saved.rows;
}
it('binds an exact artifact event and preserves its baseline dependency after retirement', () => {
  const db = database(),
    rows = retainedRows(db);
  const artifactId = rows.artifacts![0]!.artifact_id as string;
  const eventId = rows.artifact_events![0]!.event_id as string;
  const value = prepared(db, artifactId),
    publicationId = uuidv7();
  db.prepare(
    "INSERT INTO git_retention_publications VALUES (?, ?, ?, 'baseline', ?, NULL, NULL, ?, ?, ?)"
  ).run(
    publicationId,
    value.operationId,
    value.repositoryId,
    eventId,
    `refs/orcaops/baseline/${artifactId}-${publicationId}`,
    'a'.repeat(40),
    'b'.repeat(40)
  );
  const bind = (owner: string, generation = 1) =>
    db
      .prepare("INSERT INTO artifact_retention_selections VALUES (?, ?, ?, ?, ?, 'baseline')")
      .run(publicationId, value.operationId, owner, generation, eventId);
  expect(() => bind(artifactId)).toThrow('exact owner');
  const selected = transition(db, value, 'selected');
  expect(() => bind(uuidv7())).toThrow('exact owner');
  expect(() => bind(artifactId, 900)).toThrow('exact owner');
  expect(() => bind(artifactId)).not.toThrow();
  db.prepare("INSERT INTO artifact_baseline_current VALUES (?, ?, 'baseline')").run(
    artifactId,
    publicationId
  );
  expect(() => bind(artifactId)).toThrow('immutable');
  const retired = uuidv7();
  db.prepare(
    "INSERT INTO git_retention_transitions VALUES (?, ?, ?, 2, 'retired', ?, 'No future selection')"
  ).run(retired, value.operationId, selected, receipt(db));
  db.prepare(
    'UPDATE git_retention_current SET transition_id = ? WHERE original_operation_id = ?'
  ).run(retired, value.operationId);
  expect(() =>
    db
      .prepare('UPDATE artifact_baseline_current SET publication_id = ? WHERE artifact_id = ?')
      .run(publicationId, artifactId)
  ).toThrow();
  expect(() =>
    db
      .prepare("INSERT INTO git_retention_reclamations VALUES (?, ?, ?, ?, ?, 'removed')")
      .run(receipt(db), publicationId, value.operationId, retired, 'a'.repeat(40))
  ).toThrow('dependencies');
  expect(() => db.exec('DELETE FROM artifact_retention_selections')).toThrow('retained');
  expect(db.prepare('SELECT * FROM artifact_baseline_current').all()).toHaveLength(1);
});
it('compares every baseline selection with its retained original nullable expectation', () => {
  const db = database(),
    rows = retainedRows(db);
  const artifactId = rows.artifacts![0]!.artifact_id as string;
  const eventId = rows.artifact_events![0]!.event_id as string;
  const repositoryId = uuidv7();
  function attempt(expected: string | null) {
    const value = prepared(db, artifactId, repositoryId, expected);
    const publicationId = uuidv7();
    db.prepare(
      "INSERT INTO git_retention_publications VALUES (?, ?, ?, 'baseline', ?, NULL, NULL, ?, ?, ?)"
    ).run(
      publicationId,
      value.operationId,
      repositoryId,
      eventId,
      `refs/orcaops/baseline/${artifactId}-${publicationId}`,
      'a'.repeat(40),
      'b'.repeat(40)
    );
    return { value, publicationId };
  }
  const settle = db.transaction((input: ReturnType<typeof attempt>, create = false) => {
    transition(db, input.value, 'selected');
    db.prepare("INSERT INTO artifact_retention_selections VALUES (?, ?, ?, 1, ?, 'baseline')").run(
      input.publicationId,
      input.value.operationId,
      artifactId,
      eventId
    );
    if (create)
      db.prepare("INSERT INTO artifact_baseline_current VALUES (?, ?, 'baseline')").run(
        artifactId,
        input.publicationId
      );
    else
      db.prepare(
        'UPDATE artifact_baseline_current SET publication_id = ? WHERE artifact_id = ?'
      ).run(input.publicationId, artifactId);
  });
  const original = attempt(null),
    staleEmpty = attempt(null);
  settle(original, true);
  const first = attempt(original.publicationId),
    stalePrior = attempt(original.publicationId);
  settle(first);
  const before = db.serialize();
  expect(() => settle(staleEmpty)).toThrow('original expectation');
  expect(db.serialize().equals(before)).toBe(true);
  expect(() => settle(stalePrior)).toThrow('original expectation');
  expect(db.serialize().equals(before)).toBe(true);
  expect(
    db
      .prepare(
        'SELECT expected_baseline_publication_id FROM git_retention_capture_targets WHERE original_operation_id = ?'
      )
      .get(stalePrior.value.operationId)
  ).toEqual({ expected_baseline_publication_id: original.publicationId });
  const matching = attempt(first.publicationId);
  settle(matching);
  expect(db.prepare('SELECT publication_id FROM artifact_baseline_current').get()).toEqual({
    publication_id: matching.publicationId,
  });
  expect(
    db.prepare('SELECT * FROM artifact_retention_selections WHERE event_id = ?').all(eventId)
  ).toHaveLength(3);
  const settled = db.serialize();
  expect(() => settle(matching)).toThrow();
  expect(db.serialize().equals(settled)).toBe(true);
});
it('rejects an expected prior baseline from another artifact', () => {
  const db = database(),
    rows = retainedRows(db);
  const artifactId = rows.artifacts![0]!.artifact_id as string;
  const value = prepared(db, artifactId),
    publicationId = uuidv7();
  db.prepare(
    "INSERT INTO git_retention_publications VALUES (?, ?, ?, 'baseline', ?, NULL, NULL, ?, ?, ?)"
  ).run(
    publicationId,
    value.operationId,
    value.repositoryId,
    rows.artifact_events![0]!.event_id,
    `refs/orcaops/baseline/${artifactId}-${publicationId}`,
    'a'.repeat(40),
    'b'.repeat(40)
  );
  expect(() => prepared(db, uuidv7(), value.repositoryId, publicationId)).toThrow('baseline');
  db.exec('ROLLBACK');
  expect(() => prepared(db, artifactId, value.repositoryId, publicationId)).not.toThrow();
});
it('binds review floor retention to original floor evidence without changing current review selection', () => {
  const db = database(),
    rows = retainedRows(db);
  const reviewId = rows.reviews![0]!.review_id as string;
  const membershipId = rows.review_membership_revisions![0]!.revision_id as string;
  const floorId = rows.review_evidence_publications!.find((row) => row.kind === 'floor')!
    .publication_id as string;
  const operationId = uuidv7(),
    admissionId = receipt(db),
    transitionId = uuidv7(),
    repositoryId = uuidv7(),
    publicationId = uuidv7();
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    "INSERT INTO git_retention_operations VALUES (?, ?, ?, 'review', NULL, ?, 'sha1', 'time', 'hash')"
  ).run(operationId, admissionId, repositoryId, operationId);
  db.prepare(
    "INSERT INTO git_retention_review_targets VALUES (?, 'review', ?, ?, NULL, ?, NULL, NULL, 1, 0, 1, 0)"
  ).run(operationId, reviewId, membershipId, floorId);
  db.prepare(
    "INSERT INTO git_retention_transitions VALUES (?, ?, NULL, 0, 'prepared', ?, NULL)"
  ).run(transitionId, operationId, admissionId);
  db.prepare('INSERT INTO git_retention_current VALUES (?, ?)').run(operationId, transitionId);
  db.exec('COMMIT');
  db.prepare(
    "INSERT INTO git_retention_publications VALUES (?, ?, ?, 'review-floor', ?, NULL, NULL, ?, ?, ?)"
  ).run(
    publicationId,
    operationId,
    repositoryId,
    floorId,
    `refs/orcaops/review/${reviewId}-${publicationId}`,
    'a'.repeat(40),
    'b'.repeat(40)
  );
  const before = db.prepare('SELECT * FROM review_selections').all();
  const bind = (target = floorId) =>
    db
      .prepare("INSERT INTO review_retention_bindings VALUES (?, ?, ?, 'review-floor', ?, ?, NULL)")
      .run(publicationId, operationId, reviewId, target, target);
  expect(() => bind()).toThrow('exact owner');
  transition(
    db,
    { operationId, admissionId, transitionId, repositoryId, artifactId: '' },
    'selected'
  );
  expect(() => bind(uuidv7())).toThrow('exact owner');
  expect(() => bind()).not.toThrow();
  expect(() => bind()).toThrow('immutable');
  expect(db.prepare('SELECT * FROM review_selections').all()).toEqual(before);
});

it('rejects a checkpoint suffix that names another publication', () => {
  const db = database(),
    value = prepared(db),
    publicationId = uuidv7();
  expect(() =>
    db
      .prepare(
        "INSERT INTO git_retention_publications VALUES (?, ?, ?, 'checkpoint', ?, 1, 'open', ?, ?, ?)"
      )
      .run(
        publicationId,
        value.operationId,
        value.repositoryId,
        uuidv7(),
        `refs/orcaops/snap/${value.artifactId}/1/open-${uuidv7()}`,
        'a'.repeat(40),
        'b'.repeat(40)
      )
  ).toThrow('exact owner');
  expect(() => publication(db, value)).not.toThrow();
});
