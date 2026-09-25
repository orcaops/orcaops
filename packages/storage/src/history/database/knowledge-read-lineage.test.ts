// The tips of a lineage are the revisions nothing visible at the boundary succeeds, several when
// the lineage branched, each with what stands and what restates it.
import { afterEach, expect, it } from 'vitest';

import { type KnowledgeBoundary, knowledgeReadRequest } from './knowledge-read-boundary.js';
import { readProjectLineageTips } from './knowledge-read-lineage.js';
import { publishProjectRequirementRevision } from './knowledge-requirements.js';
import { publishProjectPassageRestatement } from './knowledge-restatements.js';
import {
  type AuthorityStore,
  authorityStore,
  BY_OWNER,
  requirementRevision,
} from '../../../tests/knowledge-authority-store.js';
import {
  requirementThatMoved,
  revisionWithUnreadableRecord,
} from '../../../tests/knowledge-read-store.js';
import {
  BY_AGENT,
  counters,
  discardKnowledgeStores,
  read,
  retainedTextSource,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const STATEMENT = 'Local capture works with no Cloud connection.';

const tips = (store: AuthorityStore, boundary: KnowledgeBoundary) =>
  read(store.handle, (view) =>
    readProjectLineageTips(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      knowledgeReadRequest(view, {
        scope: store.project,
        mode: boundary === 'now' ? 'current' : 'historical',
        boundary,
      })
    )
  );

const successor = async (store: AuthorityStore, previousRevisionId: string, statement: string) => {
  const revision = requirementRevision(store.requirementId, store.sourceId, {
    previousRevisionId,
    statement,
  });
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return revision.revision_id;
};

it('names the one revision nothing succeeds as the tip, with what stands for it', async () => {
  const moved = await requirementThatMoved();
  const now = tips(moved.store, 'now');
  expect(now.revisions.map((entry) => entry.revisionId)).toEqual(
    expect.arrayContaining([moved.adopted.revision_id, moved.replacement.revision_id])
  );
  expect(now.tips).toEqual([
    expect.objectContaining({
      revisionId: moved.replacement.revision_id,
      previousRevisionId: moved.adopted.revision_id,
      standing: 'not_standing',
    }),
  ]);
  expect(now.coverage.boundary).toBe(moved.boundaries.withdrawn);
});

it('names the revision that was the tip at an earlier boundary, standing as it stood then', async () => {
  const moved = await requirementThatMoved();
  const then = tips(moved.store, moved.boundaries.adopted);
  expect(then.tips).toEqual([
    expect.objectContaining({ revisionId: moved.adopted.revision_id, standing: 'adopted' }),
  ]);
  expect(then.revisions.map((entry) => entry.revisionId)).toEqual([moved.adopted.revision_id]);
  const replaced = tips(moved.store, moved.boundaries.replaced);
  expect(replaced.tips).toEqual([
    expect.objectContaining({ revisionId: moved.replacement.revision_id, standing: 'adopted' }),
  ]);
});

it('names every tip when the lineage branched', async () => {
  const store = await authorityStore();
  const left = await successor(
    store,
    store.revisionId,
    'Local capture works offline, and says so.'
  );
  const right = await successor(
    store,
    store.revisionId,
    'Local capture works offline, and retries.'
  );
  const answer = tips(store, 'now');
  expect(answer.tips.map((tip) => tip.revisionId).sort()).toEqual([left, right].sort());
  expect(answer.tips.every((tip) => tip.previousRevisionId === store.revisionId)).toBe(true);
  expect(answer.revisions).toHaveLength(3);
});

it('leaves a revision published after the boundary out of the lineage', async () => {
  const store = await authorityStore();
  const before = counters(store.handle).writeSequence;
  const later = await successor(
    store,
    store.revisionId,
    'Local capture works offline, and says so.'
  );
  expect(tips(store, before).revisions.map((entry) => entry.revisionId)).toEqual([
    store.revisionId,
  ]);
  expect(tips(store, 'now').tips.map((tip) => tip.revisionId)).toEqual([later]);
});

it('attaches the restatement counts apart, and changes nothing that stands', async () => {
  const store = await authorityStore();
  const restatingSourceId = await retainedTextSource(store.handle, `The owner wrote: ${STATEMENT}`);
  const beforeRestatement = counters(store.handle).writeSequence;
  await publishProjectPassageRestatement(store.handle, {
    operationId: uuidv7(),
    restatement: {
      restatement_id: uuidv7(),
      passage: {
        source_id: restatingSourceId,
        location: 'message 9',
        passage_sha256: digest(Buffer.from(STATEMENT, 'utf8')),
      },
      restates: {
        kind: 'requirement',
        entity_id: store.requirementId,
        revision_id: store.revisionId,
      },
      recorded_at: '2026-09-18T08:00:00.000Z',
    },
    attributedTo: BY_AGENT,
    secretAllow: [],
  });
  const [tip] = tips(store, 'now').tips;
  expect(tip?.restatements).toMatchObject({
    occurrences: 1,
    distinctSources: 1,
    distinctTexts: 1,
  });
  expect(tip?.standing).toBe('not_standing');
  const [earlier] = tips(store, beforeRestatement).tips;
  expect(earlier?.restatements).toMatchObject({
    occurrences: 0,
    distinctSources: 0,
    distinctTexts: 0,
  });
});

it('reports a revision whose record it cannot read as not supplied, and still returns the lineage', async () => {
  const store = await authorityStore();
  const unreadable = await revisionWithUnreadableRecord(
    store.handle,
    store.requirementId,
    store.revisionId
  );
  const answer = tips(store, 'now');
  expect(answer.tips.map((tip) => tip.revisionId)).toEqual([unreadable]);
  expect(answer.coverage.unresolved).toEqual(
    expect.arrayContaining([
      { about: 'revision', record_ids: [unreadable], reason: 'revision_not_supplied' },
    ])
  );
  expect(answer.revisions.map((entry) => entry.revisionId).sort()).toEqual(
    [store.revisionId, unreadable].sort()
  );
});

it('answers nothing for an identity whose revisions this store keeps no table of', async () => {
  const store = await authorityStore();
  const answer = read(store.handle, (view) =>
    readProjectLineageTips(
      view,
      { kind: 'relationship', entity_id: uuidv7() },
      store.authority.projectId,
      knowledgeReadRequest(view, { scope: store.project, mode: 'current', boundary: 'now' })
    )
  );
  expect(answer.revisions).toEqual([]);
  expect(answer.tips).toEqual([]);
});
