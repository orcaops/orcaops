import { afterEach, expect, it } from 'vitest';

import { publishProjectContinuingDecisionRevision } from './knowledge-decisions.js';
import { createProjectRequirement } from './knowledge-requirements.js';
import { publishProjectSubject } from './knowledge-subjects.js';
import {
  BY_AGENT,
  BY_OWNER,
  captureFieldSource,
  counters,
  DETECTOR,
  discardKnowledgeStores,
  OWNER,
  plannedKnowledgeStore,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-17T13:00:00.000Z';

async function store() {
  const { handle, plan } = await plannedKnowledgeStore();
  const sourceId = await captureFieldSource(handle, plan);
  return { handle, plan, sourceId };
}

const PASSAGE = 'c'.repeat(64);
const LOCATION = 'paragraph 3';
const OTHER_LOCATION = 'paragraph 9';

const revision = (
  decisionId: string,
  sourceId: string,
  previous: string | null = null,
  chosen = 'Keep the retained bytes beside the database.'
) => ({
  decision_id: decisionId,
  revision_id: uuidv7(),
  previous_revision_id: previous,
  chosen_approach: chosen,
  rationale: 'A restore has to verify the copy on its own.',
  alternatives: [
    { option: 'Keep them in the database', rejected_because: 'A copy grows unbounded' },
  ],
  assumptions: [],
  reconsideration_conditions: [],
  subject: null,
  applicability: { all_of: [] },
  source_ids: [sourceId],
  passages: [
    { source_id: sourceId, location: LOCATION, passage_sha256: PASSAGE },
    { source_id: sourceId, location: OTHER_LOCATION, passage_sha256: PASSAGE },
  ],
  source_standing: 'explicit_instruction',
  derivation: null,
  recorded_at: AT,
});

const atItsPassage = (sourceId: string) => ({ source_id: sourceId, location: LOCATION });

const rows = (handle: Parameters<typeof rowCount>[0], decisionId: string) =>
  read(handle, (view) =>
    view.all<{
      revision_id: string;
      position: number;
      source_event_id: string;
      field_path: string;
      attributed_kind: string;
      attributed_basis: string | null;
      authored_by: string | null;
      alternative_count: number;
      record_hex: string;
      record_sha256: string;
    }>(
      'SELECT revision_id, position, source_event_id, field_path, attributed_kind, attributed_basis, authored_by, alternative_count, hex(record_bytes) AS record_hex, record_sha256 FROM decision_revisions WHERE decision_id=? ORDER BY rowid',
      decisionId
    )
  );

it('publishes a first decision revision outside a task and allocates its occurrence position', async () => {
  const { handle, sourceId } = await store();
  const first = revision(uuidv7(), sourceId);
  const before = counters(handle);
  const published = await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    revision: first,
    attributedTo: BY_OWNER,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  expect(published.value.occurrence).toEqual({
    sourceId,
    location: 'paragraph 3',
    position: 0,
  });
  const [row] = rows(handle, first.decision_id);
  expect(row!.source_event_id).toBe(sourceId);
  expect(row!.alternative_count).toBe(1);
  const bytes = Buffer.from(row!.record_hex, 'hex');
  expect(digest(bytes)).toBe(row!.record_sha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...first, attributed_to: BY_OWNER });
  expect(
    read(handle, (view) =>
      view.get('SELECT first_revision_id FROM decisions WHERE decision_id=?', first.decision_id)
    )
  ).toEqual({ first_revision_id: first.revision_id });
});

it('lets a successor restate the same statement from the same place without colliding', async () => {
  const { handle, sourceId } = await store();
  const first = revision(uuidv7(), sourceId);
  await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    revision: first,
    attributedTo: BY_OWNER,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  const restated = revision(first.decision_id, sourceId, first.revision_id);
  const successor = await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    revision: restated,
    attributedTo: BY_OWNER,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  expect(successor.value.occurrence.position).toBe(1);
  expect(rows(handle, first.decision_id).map((row) => row.position)).toEqual([0, 1]);
});

it('keeps two sibling revisions and refuses a second root, a foreign predecessor and a reused id', async () => {
  const { handle, sourceId } = await store();
  const root = revision(uuidv7(), sourceId);
  const other = revision(uuidv7(), sourceId);
  for (const first of [root, other])
    await publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: first,
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    });
  const tighter = revision(root.decision_id, sourceId, root.revision_id, 'Verify the copy twice.');
  const looser = revision(root.decision_id, sourceId, root.revision_id, 'Verify the copy once.');
  for (const sibling of [tighter, looser])
    await publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: sibling,
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    });
  expect(rows(handle, root.decision_id).map((row) => row.revision_id)).toEqual([
    root.revision_id,
    tighter.revision_id,
    looser.revision_id,
  ]);

  const before = rowCount(handle, 'decision_revisions');
  for (const refused of [
    revision(root.decision_id, sourceId),
    revision(root.decision_id, sourceId, other.revision_id),
  ])
    await expect(
      publishProjectContinuingDecisionRevision(handle, {
        operationId: uuidv7(),
        revision: refused,
        attributedTo: BY_OWNER,
        secretAllow: [],
        occurrence: atItsPassage(sourceId),
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...revision(root.decision_id, sourceId, root.revision_id),
        revision_id: tighter.revision_id,
      },
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'decision_revisions')).toBe(before);
});

it('refuses a cited source or a subject this history does not hold', async () => {
  const { handle, sourceId } = await store();
  const unheld = uuidv7();
  await expect(
    publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: revision(uuidv7(), unheld),
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(unheld),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(
    publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...revision(uuidv7(), sourceId),
        subject: { subject_id: uuidv7(), subject_revision_id: uuidv7() },
      },
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'decision_revisions')).toBe(0);
  expect(rowCount(handle, 'decisions')).toBe(0);
});

it('records the subject a released row never had and keeps a detector out of the intent counter', async () => {
  const { handle, sourceId } = await store();
  const subject = {
    subject_id: uuidv7(),
    revision_id: uuidv7(),
    previous_revision_id: null,
    label: 'Database upgrade',
    kind: 'workflow' as const,
    description: 'Moving a released store to the current schema.',
    source_ids: [sourceId],
    recorded_at: AT,
  };
  await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision: subject,
    authoredBy: OWNER,
    secretAllow: [],
  });
  const before = counters(handle);
  const candidate = {
    ...revision(uuidv7(), sourceId),
    subject: { subject_id: subject.subject_id, subject_revision_id: subject.revision_id },
    source_standing: 'extracted_candidate',
  };
  const published = await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    revision: candidate,
    attributedTo: DETECTOR,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const [row] = rows(handle, candidate.decision_id);
  expect(row).toMatchObject({
    attributed_kind: 'detector',
    attributed_basis: null,
    authored_by: DETECTOR.detector,
  });
  await expect(
    publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: { ...revision(uuidv7(), sourceId), source_standing: 'explicit_instruction' },
      attributedTo: DETECTOR,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('replays the original result and refuses a changed authored field under one operation id', async () => {
  const { handle, sourceId } = await store();
  const operationId = uuidv7();
  const first = revision(uuidv7(), sourceId);
  const published = await publishProjectContinuingDecisionRevision(handle, {
    operationId,
    revision: first,
    attributedTo: BY_OWNER,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    revision: revision(uuidv7(), sourceId),
    attributedTo: BY_OWNER,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  expect(
    await publishProjectContinuingDecisionRevision(handle, {
      operationId,
      revision: first,
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).toEqual({ ...published, replayed: true });

  const before = rowCount(handle, 'decision_revisions');
  for (const changed of [
    {
      revision: { ...first, rationale: 'Another reason' },
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    },
    {
      revision: first,
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    },
    {
      revision: first,
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: { ...atItsPassage(sourceId), location: OTHER_LOCATION },
    },
  ])
    await expect(
      publishProjectContinuingDecisionRevision(handle, { operationId, ...changed })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'decision_revisions')).toBe(before);
});

it('records where a derived decision came from, and refuses one that takes its parent identity', async () => {
  const { handle, sourceId } = await store();
  const parent = revision(uuidv7(), sourceId);
  await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    revision: parent,
    attributedTo: BY_OWNER,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  const derivation = {
    derived_from: {
      kind: 'decision' as const,
      entity_id: parent.decision_id,
      revision_id: parent.revision_id,
    },
    explanation: 'The parent fixed where the bytes land; this one fixes how they are verified.',
    source_id: sourceId,
    derived_at: AT,
  };
  const derived = { ...revision(uuidv7(), sourceId), derivation };
  await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    revision: derived,
    attributedTo: BY_OWNER,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  expect(
    read(handle, (view) =>
      view.get(
        'SELECT derived_from_kind, derived_from_id, derived_from_revision_id FROM decision_revisions WHERE revision_id=?',
        derived.revision_id
      )
    )
  ).toEqual({
    derived_from_kind: 'decision',
    derived_from_id: parent.decision_id,
    derived_from_revision_id: parent.revision_id,
  });

  // A requirement whose identity a decision could take, so the refusal is the identity rule and
  // not the lineage one a second first revision of the parent would hit first.
  const shared = uuidv7();
  const requirementRevisionId = uuidv7();
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: { requirement_id: shared, origin: { kind: 'authored', source_id: sourceId } },
    revision: {
      requirement_id: shared,
      revision_id: requirementRevisionId,
      previous_revision_id: null,
      statement: 'A restore verifies the copy before it replaces anything.',
      rationale: null,
      subject: null,
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [sourceId],
      passages: [],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });

  const before = rowCount(handle, 'decision_revisions');
  const refused = [
    { ...revision(parent.decision_id, sourceId, parent.revision_id), derivation },
    {
      ...revision(shared, sourceId),
      derivation: {
        ...derivation,
        derived_from: {
          kind: 'requirement' as const,
          entity_id: shared,
          revision_id: requirementRevisionId,
        },
      },
    },
  ];
  for (const revisionOfIts of refused)
    await expect(
      publishProjectContinuingDecisionRevision(handle, {
        operationId: uuidv7(),
        revision: revisionOfIts,
        attributedTo: BY_OWNER,
        secretAllow: [],
        occurrence: atItsPassage(sourceId),
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...revision(uuidv7(), sourceId),
        derivation: {
          ...derivation,
          derived_from: { ...derivation.derived_from, revision_id: uuidv7() },
        },
      },
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'decision_revisions')).toBe(before);
});

it('refuses a revision that restates no exact passage, so its occurrence is always authored', async () => {
  const { handle, sourceId } = await store();
  await expect(
    publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: { ...revision(uuidv7(), sourceId), passages: [] },
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'decision_revisions')).toBe(0);
});

it('refuses an occurrence that is not one of the passages the revision restates', async () => {
  const { handle, plan, sourceId } = await store();
  const other = await captureFieldSource(
    handle,
    plan,
    'plan_steps[0].acceptance_criteria[0].text',
    1
  );
  for (const occurrence of [
    { source_id: sourceId, location: 'paragraph 4' },
    { source_id: other, location: LOCATION },
  ])
    await expect(
      publishProjectContinuingDecisionRevision(handle, {
        operationId: uuidv7(),
        revision: revision(uuidv7(), sourceId),
        attributedTo: BY_OWNER,
        secretAllow: [],
        occurrence,
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'decision_revisions')).toBe(0);
});
