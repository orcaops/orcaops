import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

import type { ProjectDatabase } from './connection.js';
import {
  insertReviewRetentionAdmission,
  readPendingReviewSnapshot,
  readProjectPendingReview,
  restorePendingReviewSnapshot,
} from './pending-review.js';
import { prepareProjectGitRetention, type PrepareProjectGitRetention } from './retention-input.js';
import { advanceRetentionRecords } from './retention-records.js';
import {
  type PrepareReviewRetention,
  prepareReviewRetention,
  reviewRetentionPreparation,
} from './review-retention-input.js';
import type { ProjectSettlement } from './transactions.js';
import { digest } from '../event-integrity.js';
import { requireReviewRetentionSettlement, selectReviewRetentionRows } from './review-retention.js';
import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/retention-inputs.json', import.meta.url), 'utf8')
) as { rows: Record<string, Record<string, string | number | null | { blobHex: string }>[]> };
function database() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  db.exec('BEGIN IMMEDIATE');
  db.pragma('defer_foreign_keys = ON');
  for (const [table, rows] of Object.entries(fixture.rows))
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
  return db;
}
function view(db: Database.Database): ProjectSettlement {
  return {
    get: <T>(sql: string, ...parameters: unknown[]) =>
      (db.prepare(sql).get(...parameters) ?? null) as T | null,
    all: <T>(sql: string, ...parameters: unknown[]) => db.prepare(sql).all(...parameters) as T[],
    run: (sql: string, ...parameters: unknown[]) => ({
      changes: db.prepare(sql).run(...parameters).changes,
    }),
  };
}
function prepared(
  db: Database.Database,
  baseKind: 'auto' | 'explicit' | null = null,
  withFloor = true
) {
  const floorId = uuidv7(),
    baseId = uuidv7();
  const reviewId = fixture.rows.reviews![0]!.review_id as string;
  const selection = db
    .prepare(
      'SELECT membership_revision_id AS membershipRevisionId, base_revision_id AS baseRevisionId, floor_publication_id AS floorPublicationId, current_run_id AS runId, membership_version AS membershipVersion, base_version AS baseVersion, floor_version AS floorVersion, run_selection_version AS runSelectionVersion FROM review_selections WHERE review_id = ?'
    )
    .get(reviewId) as Omit<
    Extract<PrepareProjectGitRetention['target'], { kind: 'review' }>,
    'kind' | 'reviewId' | 'runRevisionId'
  >;
  const run =
    selection.runId === null
      ? null
      : (db
          .prepare('SELECT current_revision_id AS id FROM review_runs WHERE run_id = ?')
          .get(selection.runId) as { id: string });
  const publication = (
    role: 'review-floor' | 'review-floor-base' | 'review-base',
    targetId: string
  ) => ({
    publicationId: uuidv7(),
    role,
    targetId,
    checkpointNumber: null,
    checkpointPhase: null,
    objectOid: 'a'.repeat(40),
    treeOid: 'b'.repeat(40),
  });
  const retention: PrepareProjectGitRetention = {
    operationId: uuidv7(),
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: uuidv7(),
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:00:00.000Z',
    target: { kind: 'review', reviewId, ...selection, runRevisionId: run?.id ?? null },
    publications: [
      ...(withFloor
        ? [publication('review-floor', floorId), publication('review-floor-base', floorId)]
        : []),
      ...(baseKind === 'explicit' ? [publication('review-base', baseId)] : []),
    ],
    secretAllow: [],
  };
  const bytes = Buffer.from('{ "kind":"' + (baseKind ?? 'auto') + '", "source":null }\n');
  const base = baseKind ? { revisionId: baseId, bytes } : null;
  const input: PrepareReviewRetention = {
    retention: prepareProjectGitRetention(retention),
    secretAllow: [],
    request: withFloor
      ? {
          kind: 'floor',
          selectedTransitionId: uuidv7(),
          base,
          floor: {
            publicationId: floorId,
            observedWriteSequence: 12,
            basis: {
              baseSha: 'a'.repeat(40),
              pinnedTreeSha: 'b'.repeat(40),
              worktreeHead: null,
              defaultBranch: 'main',
              fingerprintMaxDiffBytes: 1024,
              reviewMaxDiffBytes: 2048,
              reviewIncludedUntracked: ['z.ts', 'a.ts'],
            },
            members: [
              {
                name: 'floor.json',
                kind: 'floor',
                schemaVersion: 4,
                relativePath: `evidence/${floorId}/floor.json`,
                sha256: 'a'.repeat(64),
                byteLength: 200,
              },
              {
                name: 'diff.patch',
                kind: 'diff',
                schemaVersion: null,
                relativePath: `evidence/${floorId}/diff.patch`,
                sha256: 'b'.repeat(64),
                byteLength: 0,
              },
            ],
          },
        }
      : { kind: 'base', selectedTransitionId: uuidv7(), base: base! },
  };
  return { handle: prepareReviewRetention(input), input, retention, bytes };
}
function receipt(db: Database.Database, id: string, sequence = 50) {
  const payload = '{ "original":true }';
  db.prepare(
    "INSERT INTO operations VALUES (?, 'review.fixture', 0, '{}', ?, ?, 'null', '{}', ?, 0)"
  ).run(id, payload, digest(Buffer.from(payload)), sequence);
}
function admitted(
  db: Database.Database,
  baseKind: 'auto' | 'explicit' | null = null,
  withFloor = true
) {
  const f = prepared(db, baseKind, withFloor);
  db.exec('BEGIN IMMEDIATE');
  insertReviewRetentionAdmission(view(db), f.handle);
  receipt(db, f.retention.admissionOperationId);
  db.exec('COMMIT');
  return f;
}
function read(db: Database.Database, id: string) {
  return restorePendingReviewSnapshot(readPendingReviewSnapshot(view(db), id));
}
it.each([null, 'auto', 'explicit'] as const)(
  'retains exact floor input with %s policy and leaves domain selectors and counters unchanged',
  (kind) => {
    const db = database(),
      before = db.prepare('SELECT * FROM review_selections').all(),
      counters = db.prepare('SELECT * FROM project_counters').all();
    const f = admitted(db, kind),
      result = read(db, f.retention.operationId)!;
    expect(reviewRetentionPreparation(result.prepared)).toEqual(
      reviewRetentionPreparation(f.handle)
    );
    expect(result.admission.operationId).toBe(f.retention.admissionOperationId);
    expect(result.admission.payloadJson).toBe('{ "original":true }');
    expect(result.terminal).toBeNull();
    expect(db.prepare('SELECT * FROM review_selections').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM project_counters').all()).toEqual(counters);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  }
);
it('retains an explicit standalone base with exact whitespace and original selected identity', () => {
  const db = database(),
    f = admitted(db, 'explicit', false),
    result = read(db, f.retention.operationId)!;
  const restored = reviewRetentionPreparation(result.prepared);
  expect(Buffer.from(restored.base!.bytesHex, 'hex')).toEqual(f.bytes);
  expect(restored.selectedTransitionId).toBe(f.input.request.selectedTransitionId);
  expect(restored.floor).toBeNull();
  expect(db.prepare('SELECT * FROM pending_review_evidence_members').all()).toEqual([]);
});
it('copies a consistent snapshot before decoding after the reader has closed', () => {
  const db = database(),
    f = admitted(db, 'explicit');
  const snapshot = readPendingReviewSnapshot(view(db), f.retention.operationId)!;
  db.close();
  opened.splice(opened.indexOf(db), 1);
  expect(reviewRetentionPreparation(restorePendingReviewSnapshot(snapshot)!.prepared)).toEqual(
    reviewRetentionPreparation(f.handle)
  );
});
it('returns true absence and rejects forged database handles before calling supplied reads', () => {
  const db = database();
  expect(read(db, uuidv7())).toBeNull();
  let called = false;
  expect(() =>
    readProjectPendingReview(
      {
        read: () => {
          called = true;
          throw Error('forged');
        },
      } as unknown as ProjectDatabase,
      uuidv7()
    )
  ).toThrow();
  expect(called).toBe(false);
});
it.each(['original', 'admission', 'retained'] as const)(
  'rejects an occupied %s identity before inserting pending rows',
  (which) => {
    const db = database(),
      f = which === 'retained' ? admitted(db) : prepared(db);
    if (which !== 'retained')
      receipt(
        db,
        which === 'original' ? f.retention.operationId : f.retention.admissionOperationId
      );
    const before = db.prepare('SELECT * FROM pending_review_requests').all();
    db.exec('BEGIN IMMEDIATE');
    expect(() => insertReviewRetentionAdmission(view(db), f.handle)).toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })
    );
    db.exec('ROLLBACK');
    expect(db.prepare('SELECT * FROM pending_review_requests').all()).toEqual(before);
  }
);
it('rejects changed original review selection without inserting retention or pending rows', () => {
  const db = database(),
    f = prepared(db);
  db.prepare('UPDATE review_selections SET floor_version = floor_version + 1').run();
  db.exec('BEGIN IMMEDIATE');
  expect(() => insertReviewRetentionAdmission(view(db), f.handle)).toThrow(
    expect.objectContaining({ code: 'STALE_CONTEXT' })
  );
  db.exec('ROLLBACK');
  expect(db.prepare('SELECT * FROM pending_review_requests').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM git_retention_operations').all()).toEqual([]);
});
it('rolls back admission and all pending families together on a late insert failure', () => {
  const db = database(),
    f = prepared(db, 'explicit');
  db.exec(
    "CREATE TRIGGER reject_member BEFORE INSERT ON pending_review_evidence_members BEGIN SELECT RAISE(ABORT,'late member'); END; BEGIN IMMEDIATE;"
  );
  expect(() => insertReviewRetentionAdmission(view(db), f.handle)).toThrow('late member');
  db.exec('ROLLBACK');
  for (const table of [
    'git_retention_operations',
    'git_retention_current',
    'git_retention_publications',
    'pending_review_requests',
    'pending_review_base_records',
    'pending_review_floor_inputs',
    'pending_review_untracked_paths',
    'pending_review_evidence_members',
  ])
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
});
it.each([
  'base-hash',
  'missing-base',
  'missing-floor',
  'missing-member',
  'path-gap',
  'extra-path',
  'selected-id',
  'receipt-hash',
  'receipt-json',
  'receipt-counter',
  'terminal-without-selection',
] as const)('rejects copied %s inconsistency without repairing the store', (kind) => {
  const db = database(),
    f = admitted(db, 'explicit'),
    snapshot = readPendingReviewSnapshot(view(db), f.retention.operationId)!;
  switch (kind) {
    case 'base-hash':
      snapshot.base!.sha256 = 'f'.repeat(64);
      break;
    case 'missing-base':
      snapshot.base = null;
      break;
    case 'missing-floor':
      snapshot.floor = null;
      break;
    case 'missing-member':
      snapshot.members.pop();
      break;
    case 'path-gap':
      snapshot.paths[1]!.ordinal = 3;
      break;
    case 'extra-path':
      snapshot.paths.push({ ordinal: 3, path: 'extra' });
      break;
    case 'selected-id':
      snapshot.request!.selectedTransitionId = f.retention.preparedTransitionId;
      break;
    case 'receipt-hash':
      snapshot.admission!.payloadHash = 'f'.repeat(64);
      break;
    case 'receipt-json':
      snapshot.admission!.resultJson = '{';
      break;
    case 'receipt-counter':
      snapshot.admission!.writeSequence = 0;
      break;
    case 'terminal-without-selection':
      snapshot.terminal = { ...snapshot.admission!, operationId: f.retention.operationId };
      break;
  }
  expect(() => restorePendingReviewSnapshot(snapshot)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(read(db, f.retention.operationId)).not.toBeNull();
});
it('distinguishes an entirely missing request from orphaned retained children', () => {
  const db = database(),
    f = admitted(db, 'explicit', false);
  const snapshot = readPendingReviewSnapshot(view(db), f.retention.operationId)!;
  snapshot.request = null;
  expect(() => restorePendingReviewSnapshot(snapshot)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  snapshot.base = null;
  expect(() => restorePendingReviewSnapshot(snapshot)).toThrow(
    expect.objectContaining({ code: 'HISTORY_MISSING' })
  );
});
it('detects orphaned pending rows even when the retention header is missing', () => {
  const db = database(),
    f = admitted(db);
  db.pragma('foreign_keys = OFF');
  for (const row of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN ('git_retention_operations','git_retention_current','git_retention_publications')"
    )
    .all() as { name: string }[])
    db.exec(`DROP TRIGGER ${row.name}`);
  for (const table of [
    'git_retention_current',
    'git_retention_publications',
    'git_retention_operations',
  ])
    db.prepare(`DELETE FROM ${table} WHERE original_operation_id = ?`).run(f.retention.operationId);
  expect(() => read(db, f.retention.operationId)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
});
it('retains original terminal receipt and selected identity after later retirement', () => {
  const db = database(),
    f = admitted(db),
    original = read(db, f.retention.operationId)!;
  db.exec('BEGIN IMMEDIATE');
  advanceRetentionRecords(view(db), original.retention, {
    transitionId: f.input.request.selectedTransitionId,
    kind: 'selected',
    commandOperationId: f.retention.operationId,
    retirementReason: null,
  });
  receipt(db, f.retention.operationId, 51);
  db.exec('COMMIT');
  const selected = read(db, f.retention.operationId)!;
  expect(selected.terminal!.operationId).toBe(f.retention.operationId);
  const retirement = uuidv7();
  db.exec('BEGIN IMMEDIATE');
  advanceRetentionRecords(view(db), selected.retention, {
    transitionId: uuidv7(),
    kind: 'retired',
    commandOperationId: retirement,
    retirementReason: 'superseded',
  });
  receipt(db, retirement, 52);
  db.exec('COMMIT');
  const retired = read(db, f.retention.operationId)!;
  expect(retired.terminal).toEqual(selected.terminal);
  expect(retired.retention.current.kind).toBe('retired');
  const snapshot = readPendingReviewSnapshot(view(db), f.retention.operationId)!;
  snapshot.request!.selectedTransitionId = uuidv7();
  expect(() => restorePendingReviewSnapshot(snapshot)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
});

function domainRows(db: Database.Database, f: ReturnType<typeof prepared>) {
  const input = reviewRetentionPreparation(f.handle),
    target = input.retention.target;
  if (target.kind !== 'review') throw Error('review fixture');
  if (input.base)
    db.prepare('INSERT INTO review_base_revisions VALUES (?, ?, ?, ?, ?, ?)').run(
      input.base.revisionId,
      target.reviewId,
      target.baseRevisionId,
      input.retention.operationId,
      Buffer.from(input.base.bytesHex, 'hex'),
      input.base.sha256
    );
  if (input.floor) {
    db.prepare(
      "INSERT INTO review_evidence_publications VALUES (?, ?, 'floor', ?, ?, NULL, 'fixture-input', NULL, NULL, NULL, '{}')"
    ).run(
      input.floor.publicationId,
      target.reviewId,
      input.retention.operationId,
      target.membershipRevisionId
    );
    for (const member of input.floor.members)
      db.prepare('INSERT INTO review_evidence_members VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        input.floor.publicationId,
        member.name,
        member.kind,
        member.schemaVersion,
        member.relativePath,
        member.sha256,
        member.byteLength
      );
  }
}
it.each([null, 'auto', 'explicit'] as const)(
  'selects the exact floor pins with %s policy in the caller transaction',
  (kind) => {
    const db = database(),
      f = admitted(db, kind),
      before = db.prepare('SELECT * FROM review_selections').all(),
      counters = db.prepare('SELECT * FROM project_counters').all();
    db.exec('BEGIN IMMEDIATE');
    requireReviewRetentionSettlement(view(db), f.handle, f.retention.preparedTransitionId);
    domainRows(db, f);
    selectReviewRetentionRows(view(db), f.handle, f.retention.preparedTransitionId);
    expect(
      db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(f.retention.operationId)
    ).toBeUndefined();
    receipt(db, f.retention.operationId, 51);
    db.exec('COMMIT');
    const result = read(db, f.retention.operationId)!;
    expect(result.retention.current).toMatchObject({
      kind: 'selected',
      transitionId: f.input.request.selectedTransitionId,
      commandOperationId: f.retention.operationId,
    });
    const bindings = db
      .prepare(
        'SELECT role, target_id AS target, floor_publication_id AS floor, base_revision_id AS base FROM review_retention_bindings ORDER BY role'
      )
      .all();
    const input = reviewRetentionPreparation(f.handle);
    expect(bindings).toEqual([
      ...(kind === 'explicit'
        ? [
            {
              role: 'review-base',
              target: input.base!.revisionId,
              floor: null,
              base: input.base!.revisionId,
            },
          ]
        : []),
      {
        role: 'review-floor',
        target: input.floor!.publicationId,
        floor: input.floor!.publicationId,
        base: null,
      },
      {
        role: 'review-floor-base',
        target: input.floor!.publicationId,
        floor: input.floor!.publicationId,
        base: null,
      },
    ]);
    expect(db.prepare('SELECT * FROM review_selections').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM project_counters').all()).toEqual(counters);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  }
);
it('selects a standalone base with only its original explicit policy pin', () => {
  const db = database(),
    f = admitted(db, 'explicit', false);
  db.exec('BEGIN IMMEDIATE');
  domainRows(db, f);
  selectReviewRetentionRows(view(db), f.handle, f.retention.preparedTransitionId);
  receipt(db, f.retention.operationId, 51);
  db.exec('COMMIT');
  expect(
    db
      .prepare(
        'SELECT role, floor_publication_id AS floor, base_revision_id AS base FROM review_retention_bindings'
      )
      .all()
  ).toEqual([{ role: 'review-base', floor: null, base: f.input.request.base!.revisionId }]);
});
it('requires missing original admission history without inserting any rows', () => {
  const db = database(),
    f = prepared(db);
  expect(() =>
    requireReviewRetentionSettlement(view(db), f.handle, f.retention.preparedTransitionId)
  ).toThrow(expect.objectContaining({ code: 'HISTORY_MISSING' }));
  expect(db.prepare('SELECT * FROM git_retention_operations').all()).toEqual([]);
});
it.each(['selected', 'retired', 'wrong-transition'] as const)(
  'rejects %s state before a stale publisher can select rows',
  (state) => {
    const db = database(),
      f = admitted(db),
      r = read(db, f.retention.operationId)!;
    if (state !== 'wrong-transition') {
      db.exec('BEGIN IMMEDIATE');
      advanceRetentionRecords(view(db), r.retention, {
        transitionId: state === 'selected' ? f.input.request.selectedTransitionId : uuidv7(),
        kind: state,
        commandOperationId: state === 'selected' ? f.retention.operationId : uuidv7(),
        retirementReason: state === 'retired' ? 'unused' : null,
      });
      const command = (
        db
          .prepare(
            'SELECT command_operation_id AS id FROM git_retention_transitions ORDER BY ordinal DESC LIMIT 1'
          )
          .get() as { id: string }
      ).id;
      receipt(db, command, 51);
      db.exec('COMMIT');
    }
    expect(() =>
      requireReviewRetentionSettlement(
        view(db),
        f.handle,
        state === 'wrong-transition' ? uuidv7() : f.retention.preparedTransitionId
      )
    ).toThrow(expect.objectContaining({ code: 'STALE_CONTEXT' }));
    expect(db.prepare('SELECT * FROM review_retention_bindings').all()).toEqual([]);
  }
);
it.each(['payload', 'selected-identity', 'retention'] as const)(
  'rejects changed %s under the original operation identity',
  (kind) => {
    const db = database(),
      f = admitted(db, 'explicit');
    if (kind === 'payload')
      f.input.request.base!.bytes = Buffer.from('{"kind":"explicit","source":"changed"}');
    if (kind === 'selected-identity') f.input.request.selectedTransitionId = uuidv7();
    if (kind === 'retention') {
      f.retention.publications[0]!.objectOid = 'c'.repeat(40);
      f.input.retention = prepareProjectGitRetention(f.retention);
    }
    const changed = prepareReviewRetention(f.input);
    expect(() =>
      requireReviewRetentionSettlement(view(db), changed, f.retention.preparedTransitionId)
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(db.prepare('SELECT * FROM review_retention_bindings').all()).toEqual([]);
  }
);
it('rechecks the original domain selection between require and selection', () => {
  const db = database(),
    f = admitted(db);
  db.exec('BEGIN IMMEDIATE');
  requireReviewRetentionSettlement(view(db), f.handle, f.retention.preparedTransitionId);
  domainRows(db, f);
  db.prepare('UPDATE review_selections SET floor_version = floor_version + 1').run();
  expect(() =>
    selectReviewRetentionRows(view(db), f.handle, f.retention.preparedTransitionId)
  ).toThrow(expect.objectContaining({ code: 'STALE_CONTEXT' }));
  db.exec('ROLLBACK');
  expect(read(db, f.retention.operationId)!.retention.current.kind).toBe('prepared');
});
it.each([
  'missing-floor',
  'missing-base',
  'missing-member',
  'wrong-member',
  'wrong-base-bytes',
  'wrong-operation',
] as const)('refuses %s domain rows before making a publication selected', (kind) => {
  const db = database(),
    f = admitted(db, 'explicit');
  db.exec('BEGIN IMMEDIATE');
  if (kind === 'missing-floor') {
    const original = reviewRetentionPreparation(f.handle),
      target = original.retention.target;
    if (target.kind !== 'review') throw Error('review');
    db.prepare('INSERT INTO review_base_revisions VALUES (?, ?, ?, ?, ?, ?)').run(
      original.base!.revisionId,
      target.reviewId,
      target.baseRevisionId,
      f.retention.operationId,
      Buffer.from(original.base!.bytesHex, 'hex'),
      original.base!.sha256
    );
  } else if (kind !== 'missing-base') domainRows(db, f);
  if (kind === 'missing-member' || kind === 'wrong-member') {
    db.exec(
      'DROP TRIGGER review_evidence_members_no_delete; DROP TRIGGER review_evidence_members_no_update'
    );
    const publication = reviewRetentionPreparation(f.handle).floor!.publicationId;
    if (kind === 'missing-member')
      db.prepare(
        "DELETE FROM review_evidence_members WHERE publication_id = ? AND name = 'diff.patch'"
      ).run(publication);
    else
      db.prepare(
        "UPDATE review_evidence_members SET sha256 = ? WHERE publication_id = ? AND name = 'diff.patch'"
      ).run('c'.repeat(64), publication);
  }
  if (kind === 'wrong-base-bytes' || kind === 'wrong-operation') {
    db.exec('DROP TRIGGER review_base_revisions_no_update');
    if (kind === 'wrong-base-bytes')
      db.prepare('UPDATE review_base_revisions SET record_bytes = ? WHERE revision_id = ?').run(
        Buffer.from('{"kind":"auto"}'),
        f.input.request.base!.revisionId
      );
    else
      db.prepare('UPDATE review_base_revisions SET operation_id = ? WHERE revision_id = ?').run(
        f.retention.admissionOperationId,
        f.input.request.base!.revisionId
      );
  }
  expect(() =>
    selectReviewRetentionRows(view(db), f.handle, f.retention.preparedTransitionId)
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(db.prepare('SELECT * FROM review_retention_bindings').all()).toEqual([]);
  db.exec('ROLLBACK');
});
it('rolls back selected transition and domain rows together if the second binding fails', () => {
  const db = database(),
    f = admitted(db, 'explicit'),
    before = db.prepare('SELECT * FROM review_base_revisions').all();
  db.exec(
    "CREATE TRIGGER reject_binding BEFORE INSERT ON review_retention_bindings WHEN NEW.role = 'review-floor-base' BEGIN SELECT RAISE(ABORT,'late binding'); END; BEGIN IMMEDIATE;"
  );
  domainRows(db, f);
  expect(() =>
    selectReviewRetentionRows(view(db), f.handle, f.retention.preparedTransitionId)
  ).toThrow('late binding');
  db.exec('ROLLBACK');
  expect(read(db, f.retention.operationId)!.retention.current.kind).toBe('prepared');
  expect(db.prepare('SELECT * FROM review_retention_bindings').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM review_base_revisions').all()).toEqual(before);
  expect(
    db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(f.retention.operationId)
  ).toBeUndefined();
});

it('does not decode original JSON payloads during fixed settlement', () => {
  const db = database(),
    f = admitted(db, 'explicit');
  db.exec('BEGIN IMMEDIATE');
  domainRows(db, f);
  const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
    throw Error('payload decoded inside settlement');
  });
  try {
    requireReviewRetentionSettlement(view(db), f.handle, f.retention.preparedTransitionId);
    selectReviewRetentionRows(view(db), f.handle, f.retention.preparedTransitionId);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
    db.exec('ROLLBACK');
  }
});

it.each([true, false])(
  'exposes exact original base input independently of its opaque token with floor %s',
  (withFloor) => {
    const db = database(),
      f = admitted(db, 'explicit', withFloor);
    const restored = read(db, f.retention.operationId)!;
    const token = reviewRetentionPreparation(restored.prepared);
    expect(restored.original.kind).toBe(withFloor ? 'floor' : 'base');
    expect(restored.original.selectedTransitionId).toBe(f.input.request.selectedTransitionId);
    expect(Buffer.from(restored.original.base!.bytesHex, 'hex')).toEqual(f.bytes);
    expect(restored.original.base!.sha256).toBe(digest(f.bytes));
    expect(restored.original.base).toEqual(token.base);
    expect(restored.original.base).not.toBe(token.base);
    expect(Object.isFrozen(restored.original)).toBe(true);
    expect(Object.isFrozen(restored.original.base)).toBe(true);
    const copied = Buffer.from(restored.original.base!.bytesHex, 'hex');
    copied.fill(0);
    expect(
      Buffer.from(reviewRetentionPreparation(restored.prepared).base!.bytesHex, 'hex')
    ).toEqual(f.bytes);
    expect(() => Object.assign(restored.original.base!, { bytesHex: '00' })).toThrow(TypeError);
    expect(() => Object.assign(restored.original, { selectedTransitionId: uuidv7() })).toThrow(
      TypeError
    );
    if (withFloor) {
      expect(restored.original.floor).toEqual(token.floor);
      expect(restored.original.floor).not.toBe(token.floor);
      expect(restored.original.floor!.basis).not.toBe(token.floor!.basis);
      expect(restored.original.floor!.basis.reviewIncludedUntracked).toEqual(['z.ts', 'a.ts']);
      expect(restored.original.floor!.members.map((member) => member.kind).sort()).toEqual([
        'diff',
        'floor',
      ]);
      expect(restored.original.floor!.observedWriteSequence).toBe(12);
      expect(() =>
        Object.assign(restored.original.floor!.basis, { baseSha: 'c'.repeat(40) })
      ).toThrow(TypeError);
      expect(() =>
        Object.assign(restored.original.floor!.members[0]!, { sha256: 'c'.repeat(64) })
      ).toThrow(TypeError);
      expect(() =>
        Object.assign(restored.original.floor!.basis.reviewIncludedUntracked, { 0: 'changed' })
      ).toThrow(TypeError);
      expect(() =>
        Object.assign(restored.original.floor!.members, { 0: { kind: 'changed' } })
      ).toThrow(TypeError);
    } else expect(restored.original.floor).toBeNull();
    expect(reviewRetentionPreparation(restored.prepared)).toEqual(token);
    db.exec('BEGIN IMMEDIATE');
    try {
      requireReviewRetentionSettlement(
        view(db),
        restored.prepared,
        f.retention.preparedTransitionId
      );
      domainRows(db, f);
      selectReviewRetentionRows(view(db), restored.prepared, f.retention.preparedTransitionId);
      const selected = db
        .prepare(
          'SELECT transition_id AS id FROM git_retention_current WHERE original_operation_id=?'
        )
        .get(f.retention.operationId) as { id: string };
      expect(selected.id).toBe(f.input.request.selectedTransitionId);
    } finally {
      db.exec('ROLLBACK');
    }
    expect(read(db, f.retention.operationId)!.original).toEqual(restored.original);
  }
);
