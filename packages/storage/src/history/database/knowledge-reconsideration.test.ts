// Reconsideration items and their dispositions through real project databases and the public
// writers. The rules the tables hold on their own are in
// `knowledge-reconsideration-schema.test.ts`; what is here is what a caller actually reaches.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { publishProjectKnowledgeAssessment } from './knowledge-assessments.js';
import { knowledgeReadRequest } from './knowledge-read-boundary.js';
import {
  disposeProjectReconsiderationItem,
  openProjectReconsiderationItems,
  readProjectReconsiderationItem,
  readProjectReconsiderationItems,
  reconsiderationItemId,
  type ReconsiderationSource,
} from './knowledge-reconsideration.js';
import { publishProjectRelationship } from './knowledge-relationships.js';
import { consequenceStore } from '../../../tests/knowledge-consequence-store.js';
import {
  agentReportedObservation,
  BY_OWNER,
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-18T09:00:00.000Z';

const CAUSE_KEY = '{"identity":{"entity_id":"r-1","kind":"requirement"},"kind":"revision"}';

const signal = (over: Partial<ReconsiderationSource> = {}): ReconsiderationSource =>
  ({
    affected: { kind: 'plan_event', id: 'plan-event-1' },
    cause: {
      kind: 'revision',
      key: CAUSE_KEY,
      change: {
        kind: 'revision',
        identity: { kind: 'requirement', entity_id: 'r-1' },
        revision_id: null,
        moved: 'unstated',
      },
    },
    reason: 'Plan event plan-event-1 records a preserve use of revision rev-1.',
    basis: 'explicit',
    path: [{ relation: 'task_use', basis: 'explicit' }],
    owner: {
      name: 'owner@example.test',
      basis: 'agent_reported_user_instruction',
      from: 'the actor recorded as finding this connection',
    },
    opened_at_boundary: 12,
    ...over,
  }) as ReconsiderationSource;

const open = (handle: ProjectDatabase, items: readonly unknown[], operationId = uuidv7()) =>
  openProjectReconsiderationItems(handle, { operationId, items, secretAllow: [] });

const requestAt = (view: ProjectReadView, boundary: number | 'now' = 'now') =>
  knowledgeReadRequest(view, {
    scope: {
      kind: 'project',
      project_id: view.get<{ project_id: string }>('SELECT project_id FROM store_identity')!
        .project_id,
    },
    mode: boundary === 'now' ? 'current' : 'historical',
    boundary,
  });

const itemAt = (handle: ProjectDatabase, itemId: string, boundary: number | 'now' = 'now') =>
  read(handle, (view) => readProjectReconsiderationItem(view, itemId, requestAt(view, boundary)))!;

const itemsAt = (handle: ProjectDatabase, boundary: number | 'now' = 'now', openOnly = true) =>
  read(handle, (view) =>
    readProjectReconsiderationItems(view, requestAt(view, boundary), { openOnly })
  );

it('retains one item however many times the same signal is offered', async () => {
  const { handle } = await consequenceStore();

  const first = await open(handle, [signal()]);
  const second = await open(handle, [signal()]);
  const third = await open(handle, [signal()]);

  expect(first.value.opened).toBe(1);
  expect(first.replayed).toBe(false);
  for (const later of [second, third]) {
    expect(later.value.opened).toBe(0);
    expect(later.value.retained).toBe(1);
    expect(later.replayed).toBe(true);
  }
  expect(rowCount(handle, 'reconsideration_items')).toBe(1);
  expect(first.value.items[0]!.itemId).toBe(reconsiderationItemId(signal()));
});

it('opens a second item for the same work under a different cause', async () => {
  const { handle } = await consequenceStore();

  await open(handle, [signal()]);
  const other = await open(handle, [
    signal({
      cause: {
        kind: 'implementation',
        key: '{"kind":"implementation","paths":["packages/sync/src/queue.ts"]}',
        change: { kind: 'implementation', paths: ['packages/sync/src/queue.ts'] },
      },
    }),
  ]);

  expect(other.value.opened).toBe(1);
  expect(rowCount(handle, 'reconsideration_items')).toBe(2);
});

it('deduplicates repeated signals inside one call', async () => {
  const { handle } = await consequenceStore();

  const written = await open(handle, [signal(), signal(), signal()]);

  expect(written.value.items).toHaveLength(1);
  expect(rowCount(handle, 'reconsideration_items')).toBe(1);
});

it('retains a disposition beside the item while the item’s own facts are unchanged', async () => {
  const { handle } = await consequenceStore();
  const written = await open(handle, [signal()]);
  const itemId = written.value.items[0]!.itemId;
  const before = itemAt(handle, itemId);

  await disposeProjectReconsiderationItem(handle, {
    operationId: uuidv7(),
    itemId,
    decision: { disposition: 'acknowledged', disposed_at: AT },
    disposedBy: OWNER,
    secretAllow: [],
  });

  const after = itemAt(handle, itemId);
  expect(after.recordSha256).toBe(before.recordSha256);
  expect(after.source).toEqual(before.source);
  expect(after.openedAtBoundary).toBe(before.openedAtBoundary);
  expect(after.dispositions).toEqual([
    expect.objectContaining({
      position: 0,
      disposition: 'acknowledged',
      disposedBy: OWNER.identity,
      disposedByBasis: OWNER.basis,
      disposedAt: AT,
    }),
  ]);
  // Acknowledging is not deciding, so the item is still open.
  expect(after.open).toBe(true);
});

it('appends a second disposition with the first still readable, then closes the item', async () => {
  const store = await consequenceStore();
  const { handle } = store;
  const written = await open(handle, [signal()]);
  const itemId = written.value.items[0]!.itemId;
  await disposeProjectReconsiderationItem(handle, {
    operationId: uuidv7(),
    itemId,
    decision: { disposition: 'acknowledged', disposed_at: AT },
    disposedBy: OWNER,
    secretAllow: [],
  });

  await disposeProjectReconsiderationItem(handle, {
    operationId: uuidv7(),
    itemId,
    decision: {
      disposition: 'reconsidered',
      outcome: { kind: 'revision', revision_id: store.requirement.revision_id },
      disposed_at: '2026-09-18T10:00:00.000Z',
    },
    disposedBy: OWNER,
    secretAllow: [],
  });

  const item = itemAt(handle, itemId);
  expect(item.dispositions.map((entry) => entry.disposition)).toEqual([
    'acknowledged',
    'reconsidered',
  ]);
  expect(item.dispositions[1]!.outcome).toEqual({
    kind: 'revision',
    revision_id: store.requirement.revision_id,
  });
  expect(item.open).toBe(false);
  await expect(
    disposeProjectReconsiderationItem(handle, {
      operationId: uuidv7(),
      itemId,
      decision: { disposition: 'declined', reason: 'too late', disposed_at: AT },
      disposedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toThrow(/already been reconsidered, declined or superseded/);
});

it('records an assessment or nothing at all as what came of a reconsideration', async () => {
  const store = await consequenceStore();
  const { handle } = store;
  const written = await open(handle, [
    signal(),
    signal({ affected: { kind: 'artifact', id: 'a-1' } }),
  ]);
  const [first, second] = written.value.items.map((entry) => entry.itemId);

  await disposeProjectReconsiderationItem(handle, {
    operationId: uuidv7(),
    itemId: first!,
    decision: {
      disposition: 'reconsidered',
      outcome: { kind: 'assessment', assessment_id: store.assessmentId },
      disposed_at: AT,
    },
    disposedBy: OWNER,
    secretAllow: [],
  });
  await disposeProjectReconsiderationItem(handle, {
    operationId: uuidv7(),
    itemId: second!,
    decision: {
      disposition: 'reconsidered',
      outcome: { kind: 'unchanged' },
      disposed_at: AT,
    },
    disposedBy: OWNER,
    secretAllow: [],
  });

  const items = itemsAt(handle, 'now', false).items;
  expect(items.flatMap((item) => item.dispositions.map((entry) => entry.outcome))).toEqual(
    expect.arrayContaining([
      { kind: 'assessment', assessment_id: store.assessmentId },
      { kind: 'unchanged' },
    ])
  );
});

it('refuses a disposition of an item this history does not hold', async () => {
  const { handle } = await consequenceStore();

  await expect(
    disposeProjectReconsiderationItem(handle, {
      operationId: uuidv7(),
      itemId: 'f'.repeat(64),
      decision: { disposition: 'acknowledged', disposed_at: AT },
      disposedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toThrow(/not one this history holds/);
  expect(rowCount(handle, 'reconsideration_dispositions')).toBe(0);
});

it('refuses an outcome, a superseding item and a self-supersession this history cannot stand behind', async () => {
  const { handle } = await consequenceStore();
  const written = await open(handle, [signal()]);
  const itemId = written.value.items[0]!.itemId;

  for (const [decision, message] of [
    [
      {
        disposition: 'reconsidered',
        outcome: { kind: 'revision', revision_id: uuidv7() },
        disposed_at: AT,
      },
      /outcome revision is not one this history holds/,
    ],
    [
      {
        disposition: 'reconsidered',
        outcome: { kind: 'assessment', assessment_id: uuidv7() },
        disposed_at: AT,
      },
      /outcome assessment is not one this history holds/,
    ],
    [
      { disposition: 'superseded', superseded_by_item_id: 'a'.repeat(64), disposed_at: AT },
      /superseding reconsideration item is not one this history holds/,
    ],
    [
      { disposition: 'superseded', superseded_by_item_id: itemId, disposed_at: AT },
      /superseded by another item, never by itself/,
    ],
  ] as const)
    await expect(
      disposeProjectReconsiderationItem(handle, {
        operationId: uuidv7(),
        itemId,
        decision,
        disposedBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toThrow(message);
  expect(rowCount(handle, 'reconsideration_dispositions')).toBe(0);
});

it('supersedes one item by another', async () => {
  const { handle } = await consequenceStore();
  const written = await open(handle, [
    signal(),
    signal({ affected: { kind: 'artifact', id: 'a-1' } }),
  ]);
  const [first, second] = written.value.items.map((entry) => entry.itemId);

  await disposeProjectReconsiderationItem(handle, {
    operationId: uuidv7(),
    itemId: first!,
    decision: { disposition: 'superseded', superseded_by_item_id: second!, disposed_at: AT },
    disposedBy: OWNER,
    secretAllow: [],
  });

  const open_ = itemsAt(handle).items.map((item) => item.itemId);
  expect(open_).toEqual([second]);
  const all = itemsAt(handle, 'now', false).items;
  expect(all.find((item) => item.itemId === first)!.dispositions[0]!.supersededByItemId).toBe(
    second
  );
});

it('replays an identical retry and refuses a changed one under the same operation', async () => {
  const { handle } = await consequenceStore();
  const operationId = uuidv7();
  const first = await open(handle, [signal()], operationId);

  const retry = await open(handle, [signal()], operationId);
  expect(retry.replayed).toBe(true);
  expect(retry.value).toEqual(first.value);

  await expect(
    open(handle, [signal({ reason: 'something else entirely' })], operationId)
  ).rejects.toThrow(/already identifies different content/);
  expect(rowCount(handle, 'reconsideration_items')).toBe(1);
});

it('replays a disposition retry and refuses a changed one under the same operation', async () => {
  const { handle } = await consequenceStore();
  const written = await open(handle, [signal()]);
  const itemId = written.value.items[0]!.itemId;
  const operationId = uuidv7();
  const decision = { disposition: 'declined', reason: 'the queue was removed', disposed_at: AT };
  const first = await disposeProjectReconsiderationItem(handle, {
    operationId,
    itemId,
    decision,
    disposedBy: OWNER,
    secretAllow: [],
  });

  const retry = await disposeProjectReconsiderationItem(handle, {
    operationId,
    itemId,
    decision,
    disposedBy: OWNER,
    secretAllow: [],
  });
  expect(retry.replayed).toBe(true);
  expect(retry.value).toEqual(first.value);

  await expect(
    disposeProjectReconsiderationItem(handle, {
      operationId,
      itemId,
      decision: { ...decision, reason: 'a different reason' },
      disposedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toThrow(/already identifies different content/);
  expect(rowCount(handle, 'reconsideration_dispositions')).toBe(1);
});

it('refuses a refused credential before anything is written, in the item and in the decision', async () => {
  const { handle } = await consequenceStore();
  const secret = `ghp_${'A'.repeat(36)}`;

  await expect(open(handle, [signal({ reason: `Reached through ${secret}` })])).rejects.toThrow(
    /Secret refusal/
  );
  expect(rowCount(handle, 'reconsideration_items')).toBe(0);

  const written = await open(handle, [signal()]);
  await expect(
    disposeProjectReconsiderationItem(handle, {
      operationId: uuidv7(),
      itemId: written.value.items[0]!.itemId,
      decision: { disposition: 'declined', reason: `covered by ${secret}`, disposed_at: AT },
      disposedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toThrow(/Secret refusal/);
  expect(rowCount(handle, 'reconsideration_dispositions')).toBe(0);
});

it('moves the write sequence and never the intent counter', async () => {
  const store = await consequenceStore();
  const { handle } = store;
  const before = counters(handle);

  const written = await open(handle, [signal()]);
  const opened = counters(handle);
  await disposeProjectReconsiderationItem(handle, {
    operationId: uuidv7(),
    itemId: written.value.items[0]!.itemId,
    decision: { disposition: 'acknowledged', disposed_at: AT },
    disposedBy: OWNER,
    secretAllow: [],
  });
  const disposed = counters(handle);
  // A repeat writes nothing, so it moves neither.
  await open(handle, [signal()]);
  const repeated = counters(handle);

  expect(opened.writeSequence).toBeGreaterThan(before.writeSequence);
  expect(disposed.writeSequence).toBeGreaterThan(opened.writeSequence);
  expect(repeated.writeSequence).toBe(disposed.writeSequence);
  for (const state of [opened, disposed, repeated])
    expect(state.intentChangeCounter).toBe(before.intentChangeCounter);
});

it('shows an item at an earlier boundary without the disposition that came later', async () => {
  const { handle } = await consequenceStore();
  const written = await open(handle, [signal()]);
  const itemId = written.value.items[0]!.itemId;
  const beforeDisposition = counters(handle).writeSequence;
  await disposeProjectReconsiderationItem(handle, {
    operationId: uuidv7(),
    itemId,
    decision: { disposition: 'declined', reason: 'the queue was removed', disposed_at: AT },
    disposedBy: OWNER,
    secretAllow: [],
  });

  const then = itemAt(handle, itemId, beforeDisposition);
  const now = itemAt(handle, itemId);

  expect(then.dispositions).toEqual([]);
  expect(then.open).toBe(true);
  expect(now.dispositions).toHaveLength(1);
  expect(now.open).toBe(false);
  expect(then.recordSha256).toBe(now.recordSha256);
});

it('leaves an item opened after the boundary out of an earlier read and counts it', async () => {
  const { handle } = await consequenceStore();
  const before = counters(handle).writeSequence;
  await open(handle, [signal()]);

  const then = itemsAt(handle, before);
  expect(then.items).toEqual([]);
  expect(then.later).toBe(1);
  expect(itemsAt(handle).items).toHaveLength(1);
});

it('lists the items about one affected identity and nothing else', async () => {
  const store = await consequenceStore();
  const { handle } = store;
  await open(handle, [
    signal({ affected: { kind: 'requirement', id: store.requirement.entity_id } }),
    signal({ affected: { kind: 'artifact', id: 'a-1' } }),
  ]);

  const found = read(handle, (view) =>
    readProjectReconsiderationItems(view, requestAt(view), {
      affected: { kind: 'requirement', id: store.requirement.entity_id },
    })
  );

  expect(found.items.map((item) => item.affected.id)).toEqual([store.requirement.entity_id]);
});

it('opens no item from any other writer in this family', async () => {
  const store = await consequenceStore();
  const { handle } = store;
  // The fixture has already published a source, a subject, a requirement and its revisions, a
  // decision revision, an adoption, two relationships, an observation, an assessment and a
  // captured plan, and none of them opened an item.
  expect(rowCount(handle, 'reconsideration_items')).toBe(0);

  await publishProjectRelationship(handle, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: uuidv7(),
      relation: 'depends_on',
      from: store.sibling,
      to: store.requirement,
      scope: store.store.project,
      standing: 'established',
      authorization: null,
      source_ids: [store.store.sourceId],
      explanation: 'Recorded after the fact.',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const observationId = await agentReportedObservation(handle, store.store.sourceId);
  const before = counters(handle);
  await publishProjectKnowledgeAssessment(handle, {
    operationId: uuidv7(),
    assessment: {
      assessment_id: uuidv7(),
      expectations: [store.requirement],
      exception_ids: [],
      implementation: { kind: 'none_selected' },
      evidence: [
        {
          source: { kind: 'observation', observation_id: observationId },
          role: 'context',
          limitations: 'none stated',
        },
      ],
      method: { name: 'review', configuration_sha256: null },
      conclusions: [
        { expectation: store.requirement, conclusion: 'unresolved', reason: 'no software named' },
      ],
      check_states: [],
      coverage_limits: [],
      observed_write_sequence: before.writeSequence,
      observed_intent_counter: before.intentChangeCounter,
    },
    assessedBy: OWNER,
    secretAllow: [],
  });

  expect(rowCount(handle, 'reconsideration_items')).toBe(0);
  expect(rowCount(handle, 'reconsideration_dispositions')).toBe(0);
});

/**
 * The cascade rule is about the whole product, not about one settlement, so it is checked over the
 * source rather than over one store: a correction, a capture or the interpretation worker that
 * opened an item would start exactly the unlimited cascade §5 forbids, and no test that runs one
 * writer at a time would see it. The command that a person or a skill runs is the only caller.
 */
it('has one caller outside this family, and it is the verb a person runs', async () => {
  const repo = path.resolve(new URL('.', import.meta.url).pathname, '../../../../..');
  const callers: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const here = path.join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests')
          continue;
        await walk(here);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        if ((await readFile(here, 'utf8')).includes('openProjectReconsiderationItems'))
          callers.push(path.relative(repo, here));
      }
    }
  };
  for (const root of ['packages', 'apps']) await walk(path.join(repo, root));

  expect(callers.sort()).toEqual([
    'apps/orcaops-cli/src/commands/knowledge/reconsider.ts',
    'packages/storage/src/history/database/index.ts',
    'packages/storage/src/history/database/knowledge-reconsideration.ts',
  ]);
});
