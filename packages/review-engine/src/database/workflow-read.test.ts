import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { type JournalEvent, reviewLedgerGeneration } from '@orcaops/review-core';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import { createDatabaseReview } from './reviews.js';
import { workflowTarget } from './workflow-events.js';
import {
  hydrateReviewWorkflow,
  readDatabaseReviewWorkflow,
  snapshotReviewWorkflow,
  workflowBasisSchema,
} from './workflow-read.js';
import { normalizeHistoryRoot } from '../../../storage/dist/history/paths.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'workflow-history-'));
  roots.push(root);
  const authority = {
    ...(await normalizeHistoryRoot({ root })),
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(store.projectDatabasePath(authority)), { recursive: true });
  (
    await store.initializeProjectDatabase({
      authority,
      initializationOperationId: uuidv7(),
      initializedAt: new Date().toISOString(),
      authorize() {},
    })
  ).close();
  const operationId = uuidv7();
  const reviewId = uuidv7();
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
    membershipBytes: bytes({ revisionId: uuidv7(), members: [], source: null }),
  });
  return {
    authority,
    reviewId,
    basis: { floor: { publicationId: uuidv7(), version: 1, inputHash: 'retained-floor' } },
  };
}
async function seed(
  f: Awaited<ReturnType<typeof fixture>>,
  events: JournalEvent[],
  basis: ReturnType<typeof workflowBasisSchema.parse> = f.basis
) {
  const database = await store.openProjectDatabase({ authority: f.authority, mode: 'writer' });
  const operationId = uuidv7();
  const originals = events.map((event) => ({ event, bytes: bytes(event), revisionId: uuidv7() }));
  try {
    return await store.runProjectOperation(
      database,
      {
        operationId,
        kind: 'fixture.workflow',
        target: { reviewId: f.reviewId },
        payload: {},
        expectedState: {},
        intentChange: false,
      },
      (tx) => {
        let sequence = tx.get<{ sequence: number }>(
          'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM review_workflow_transitions WHERE review_id = ?',
          f.reviewId
        )!.sequence;
        for (const [position, original] of originals.entries()) {
          const target = workflowTarget(original.event);
          const previous = tx.get<{ revision_id: string; version: number }>(
            'SELECT revision_id, version FROM review_workflow_current WHERE review_id = ? AND target_key = ?',
            f.reviewId,
            target
          );
          tx.run(
            'INSERT INTO review_workflow_transitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            original.revisionId,
            f.reviewId,
            target,
            previous?.revision_id ?? null,
            (previous?.version ?? 0) + 1,
            ++sequence,
            operationId,
            original.bytes,
            createHash('sha256').update(original.bytes).digest('hex'),
            canonicalJson(basis),
            canonicalJson({
              kind: 'authored',
              eventId: original.revisionId,
              fieldPath: 'events',
              position,
            })
          );
          tx.run(
            'INSERT INTO review_workflow_current VALUES (?, ?, ?, ?) ON CONFLICT(review_id, target_key) DO UPDATE SET revision_id = excluded.revision_id, version = excluded.version',
            f.reviewId,
            target,
            original.revisionId,
            (previous?.version ?? 0) + 1
          );
        }
        return { revisionIds: originals.map((record) => record.revisionId) };
      }
    );
  } finally {
    database.close();
  }
}
const events: JournalEvent[] = [
  { type: 'section', ts: '2026-01-02T00:00:00.000Z', threadKey: 'part', action: 'VISIT' },
  {
    type: 'prompt',
    ts: '2026-01-01T00:00:00.000Z',
    promptKey: 'original-prompt',
    action: 'ACKNOWLEDGE',
  },
  {
    type: 'section',
    ts: '2026-01-02T00:00:00.000Z',
    threadKey: 'part',
    action: 'PARTIAL',
    reason: 'Continue later.',
  },
];
function damage(f: Awaited<ReturnType<typeof fixture>>, sql: string) {
  const require = createRequire(new URL('../../../storage/package.json', import.meta.url));
  const Database = require('better-sqlite3') as new (file: string) => {
    pragma(sql: string): unknown;
    exec(sql: string): void;
    close(): void;
  };
  const db = new Database(store.projectDatabasePath(f.authority));
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(sql);
  } finally {
    db.close();
  }
}

it('reads a genuinely empty workflow without creating target selections', async () => {
  const f = await fixture();
  const read = await readDatabaseReviewWorkflow({ authority: f.authority, reviewId: f.reviewId });
  expect(read.value).toMatchObject({
    heads: [],
    revisions: [],
    events: [],
    sequence: 0,
    ledgerGeneration: await reviewLedgerGeneration([]),
  });
});

it('retains append order, exact bytes and target-local predecessor versions', async () => {
  const f = await fixture();
  await seed(f, events);
  const read = await readDatabaseReviewWorkflow({ authority: f.authority, reviewId: f.reviewId });
  expect(read.value.events).toEqual(events);
  expect(read.value.revisions.map((record) => record.bytes)).toEqual(events.map(bytes));
  expect(read.value.revisions.map((record) => record.version)).toEqual([1, 1, 2]);
  expect(read.value.revisions.map((record) => record.sequence)).toEqual([1, 2, 3]);
  expect(read.value.revisions[2]!.previousRevisionId).toBe(read.value.revisions[0]!.revisionId);
  expect(read.value.ledgerGeneration).toBe(await reviewLedgerGeneration(events));
});

it('hydrates an original snapshot after another connection appends without holding its transaction', async () => {
  const f = await fixture();
  await seed(f, events.slice(0, 1));
  const db = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  try {
    const snapshot = db.read((view) => snapshotReviewWorkflow(view, f.reviewId));
    await seed(f, events.slice(1));
    const old = await hydrateReviewWorkflow(snapshot.value);
    const current = await readDatabaseReviewWorkflow({
      authority: f.authority,
      reviewId: f.reviewId,
    });
    expect(old.events).toEqual(events.slice(0, 1));
    expect(current.value.events).toEqual(events);
    expect(current.counters.writeSequence).toBe(snapshot.counters.writeSequence + 1);
  } finally {
    db.close();
  }
});

it.each([
  'DELETE FROM review_workflow_current',
  'UPDATE review_workflow_current SET version = version + 1',
])('refuses damaged target selections without repairing them: %s', async (sql) => {
  const f = await fixture();
  await seed(f, events);
  damage(f, sql);
  await expect(
    readDatabaseReviewWorkflow({ authority: f.authority, reviewId: f.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
});

it.each(['sequence', 'previous', 'target', 'hash', 'source'])(
  'refuses a copied history with inconsistent %s',
  async (field) => {
    const f = await fixture();
    await seed(f, events);
    const db = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
    let snapshot;
    try {
      snapshot = db.read((view) => snapshotReviewWorkflow(view, f.reviewId)).value;
    } finally {
      db.close();
    }
    const last = snapshot.rows[2]!;
    if (field === 'sequence') last.sequence++;
    if (field === 'previous') last.previous_revision_id = snapshot.rows[1]!.revision_id;
    if (field === 'target') last.target_key = snapshot.rows[1]!.target_key;
    if (field === 'hash') last.record_hash = '0'.repeat(64);
    if (field === 'source')
      last.source_json = canonicalJson({
        kind: 'authored',
        eventId: uuidv7(),
        fieldPath: 'events',
        position: 2,
      });
    await expect(hydrateReviewWorkflow(snapshot)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
  }
);

it('reads historically retained allowed text without applying new-author refusal', async () => {
  const f = await fixture();
  const historical: JournalEvent = {
    ...events[2]!,
    type: 'section',
    threadKey: 'part',
    action: 'PARTIAL',
    reason: 'ghp_' + 'A'.repeat(36),
  };
  await seed(f, [historical]);
  const result = await readDatabaseReviewWorkflow({ authority: f.authority, reviewId: f.reviewId });
  expect(result.value.events).toEqual([historical]);
});

it('retains an aggregate original ledger dependency and rejects mismatched lifecycle basis', async () => {
  const f = await fixture();
  await seed(f, events);
  const generation = await reviewLedgerGeneration(events);
  const event: JournalEvent = {
    type: 'review_lifecycle',
    ts: '2026-01-03T00:00:00.000Z',
    action: 'PARTIAL',
    review_basis: 'FLOOR_ONLY',
    floor_input_hash: f.basis.floor.inputHash,
    story_generation: null,
    ledger_generation: generation,
    actor: 'REVIEWER',
    source: 'WATCH',
    remaining_work: 'Continue the review.',
  };
  await seed(f, [event], {
    ...f.basis,
    story: { publicationId: null, version: 0, generation: null },
    ledger: { generation, sequence: events.length },
  });
  const good = await readDatabaseReviewWorkflow({ authority: f.authority, reviewId: f.reviewId });
  expect(good.value.events).toEqual([...events, event]);
  const db = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  let snapshot;
  try {
    snapshot = db.read((view) => snapshotReviewWorkflow(view, f.reviewId)).value;
  } finally {
    db.close();
  }
  const original = snapshot.rows.at(-1)!.basis_json;
  for (const change of ['ledger', 'floor', 'story'] as const) {
    const basis = workflowBasisSchema.parse(JSON.parse(original));
    if (change === 'ledger') basis.ledger!.sequence--;
    if (change === 'floor') basis.floor.inputHash = 'different-floor';
    if (change === 'story') basis.story!.generation = 'different-story';
    snapshot.rows.at(-1)!.basis_json = canonicalJson(basis);
    await expect(hydrateReviewWorkflow(snapshot)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
  }
});
