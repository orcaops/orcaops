import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import type { ProjectDatabase } from './connection.js';
import { publishProjectClaimRevision } from './exact-revision-records.js';
import { createProjectRequirement } from './knowledge-requirements.js';
import {
  publishProjectPassageRestatement,
  readProjectPassageRestatements,
} from './knowledge-restatements.js';
import {
  BY_AGENT,
  BY_OWNER,
  captureFieldSource,
  capturePlan,
  counters,
  DETECTOR,
  discardKnowledgeStores,
  plannedKnowledgeStore,
  read,
  referencedSource,
  retainedTextSource,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-18T08:00:00.000Z';
const STATEMENT = 'Local capture works with no Cloud connection.';
const CITED_LOCATION = 'plan_steps[0].acceptance_criteria[0].text';

/**
 * A requirement whose first revision cites one passage and states these exact words, and a later
 * source whose retained text really does repeat them.
 */
async function store(wording = STATEMENT) {
  const { handle, plan } = await plannedKnowledgeStore();
  const sourceId = await captureFieldSource(handle, plan);
  const restatingSourceId = await retainedTextSource(handle, `The owner wrote: ${wording}`);
  const criterionId = plan.steps[0]!.criteria[0]!.criterionId;
  const revisionId = uuidv7();
  const citedPassage = {
    source_id: sourceId,
    location: CITED_LOCATION,
    passage_sha256: digest(Buffer.from(wording, 'utf8')),
  };
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: criterionId,
      origin: {
        kind: 'promoted_criterion',
        criterion: {
          artifact_id: plan.artifactId,
          plan_event_id: plan.planEventId,
          criterion_id: criterionId,
        },
      },
    },
    revision: {
      requirement_id: criterionId,
      revision_id: revisionId,
      previous_revision_id: null,
      statement: wording,
      rationale: null,
      subject: null,
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [sourceId],
      passages: [citedPassage],
      source_standing: 'explicit_instruction',
      recorded_at: '2026-09-17T09:00:00.000Z',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return {
    handle,
    plan,
    sourceId,
    citedPassage,
    restatingSourceId,
    restates: {
      kind: 'requirement' as const,
      entity_id: criterionId,
      revision_id: revisionId,
    },
  };
}

const restatement = (
  restates: { kind: 'requirement' | 'claim'; entity_id: string; revision_id: string },
  sourceId: string,
  location = 'message 9',
  wording = STATEMENT
) => ({
  restatement_id: uuidv7(),
  passage: {
    source_id: sourceId,
    location,
    passage_sha256: digest(Buffer.from(wording, 'utf8')),
  },
  restates,
  recorded_at: AT,
});

async function capturedRestatementSource(
  handle: ProjectDatabase,
  text = STATEMENT,
  fieldPath = 'task'
) {
  const plan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    task: text,
    label: 'Captured restatement',
    steps: [
      {
        stepId: uuidv7(),
        criteria: [{ criterionId: uuidv7(), text: 'The unrelated criterion is satisfied.' }],
      },
    ],
  };
  await capturePlan(handle, plan);
  return { plan, sourceId: await captureFieldSource(handle, plan, fieldPath) };
}

const publicationState = (handle: ProjectDatabase) => ({
  restatements: rowCount(handle, 'passage_restatements'),
  operations: rowCount(handle, 'operations'),
  counters: counters(handle),
});

it('reads quoted multiline Unicode words from a decoded inline capture field', async () => {
  const wording = 'Save "café" notes before reporting success.\nPreserve 日本語 and 🐋.';
  const { handle, restates } = await store(wording);
  const { sourceId } = await capturedRestatementSource(handle, wording);

  const published = await publishProjectPassageRestatement(handle, {
    operationId: uuidv7(),
    restatement: restatement(restates, sourceId, 'task', wording),
    attributedTo: DETECTOR,
    secretAllow: [],
  });

  expect(published.value.published).toBe(true);
  expect(read(handle, (view) => readProjectPassageRestatements(view, restates)).occurrences).toBe(
    1
  );
  expect(rowCount(handle, 'requirement_revisions')).toBe(1);
});

it('refuses words found only in a different capture field without publishing', async () => {
  const { handle, restates } = await store();
  const { sourceId } = await capturedRestatementSource(handle, STATEMENT, CITED_LOCATION);
  const before = publicationState(handle);

  await expect(
    publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: restatement(restates, sourceId, CITED_LOCATION),
      attributedTo: DETECTOR,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(publicationState(handle)).toEqual(before);
});

it.each(['missing', 'plan_steps', 'plan_steps[9].text'])(
  'refuses an unresolved capture field %s without publishing',
  async (fieldPath) => {
    const { handle, restates } = await store();
    const { sourceId } = await capturedRestatementSource(handle, STATEMENT, fieldPath);
    const before = publicationState(handle);

    await expect(
      publishProjectPassageRestatement(handle, {
        operationId: uuidv7(),
        restatement: restatement(restates, sourceId, fieldPath),
        attributedTo: DETECTOR,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(publicationState(handle)).toEqual(before);
  }
);

it.each(['inline', 'sidecar', 'empty sidecar'])(
  'refuses malformed retained %s payloads without publishing',
  async (representation) => {
    const { handle, restates } = await store();
    const { plan, sourceId } = await capturedRestatementSource(handle);
    const corrupted = new Database(handle.databasePath);
    try {
      corrupted.exec('DROP TRIGGER artifact_events_no_update');
      if (representation === 'inline') {
        corrupted
          .prepare('UPDATE artifact_events SET record_bytes=? WHERE event_id=?')
          .run(Buffer.from(`{"payload":{"task":"${STATEMENT}"`), plan.planEventId);
      } else {
        corrupted
          .prepare('UPDATE artifact_events SET sidecar_payload_bytes=? WHERE event_id=?')
          .run(
            Buffer.from(representation === 'empty sidecar' ? '' : `{"task":"${STATEMENT}"`),
            plan.planEventId
          );
      }
    } finally {
      corrupted.close();
    }
    const before = publicationState(handle);

    await expect(
      publishProjectPassageRestatement(handle, {
        operationId: uuidv7(),
        restatement: restatement(restates, sourceId, 'task'),
        attributedTo: DETECTOR,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(publicationState(handle)).toEqual(before);
  }
);

it('records another occurrence of the same words and moves neither counter', async () => {
  const { handle, restates, restatingSourceId } = await store();
  const record = restatement(restates, restatingSourceId);
  const before = counters(handle);
  const published = await publishProjectPassageRestatement(handle, {
    operationId: uuidv7(),
    restatement: record,
    attributedTo: DETECTOR,
    secretAllow: [],
  });
  expect(published.value).toEqual({
    restatementId: record.restatement_id,
    recordSha256: expect.any(String),
    published: true,
  });
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const [row] = read(handle, (view) => readProjectPassageRestatements(view, restates)).restatements;
  expect(row).toMatchObject({
    restatementId: record.restatement_id,
    passage: record.passage,
    restates: {
      kind: 'requirement',
      entityId: restates.entity_id,
      revisionId: restates.revision_id,
    },
    attribution: { kind: 'detector', name: DETECTOR.detector, basis: null },
  });
  const bytes = Buffer.from(row!.recordHex, 'hex');
  expect(digest(bytes)).toBe(row!.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...record, attributed_to: DETECTOR });
  expect(rowCount(handle, 'requirement_revisions')).toBe(1);
});

it('records one row per passage and revision, whatever the repeat says', async () => {
  const { handle, restates, restatingSourceId } = await store();
  const record = restatement(restates, restatingSourceId);
  const first = await publishProjectPassageRestatement(handle, {
    operationId: uuidv7(),
    restatement: record,
    attributedTo: DETECTOR,
    secretAllow: [],
  });
  const before = counters(handle);
  const receipts = rowCount(handle, 'operations');
  const again = await publishProjectPassageRestatement(handle, {
    operationId: uuidv7(),
    restatement: record,
    attributedTo: DETECTOR,
    secretAllow: [],
  });
  expect(again).toEqual({
    value: { ...first.value, published: false },
    replayed: true,
    counters: before,
  });
  expect(rowCount(handle, 'operations')).toBe(receipts);

  // A second act over the same two immutable things could only repeat the first, so it is
  // refused by the name of the restatement that pair already has.
  await expect(
    publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: { ...record, restatement_id: uuidv7() },
      attributedTo: BY_AGENT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'passage_restatements')).toBe(1);

  // Another passage of the same source is another occurrence, so it is another row.
  await publishProjectPassageRestatement(handle, {
    operationId: uuidv7(),
    restatement: restatement(restates, restatingSourceId, 'message 14'),
    attributedTo: BY_AGENT,
    secretAllow: [],
  });
  expect(rowCount(handle, 'passage_restatements')).toBe(2);
});

it('counts occurrences, sources and texts apart, so a carried copy corroborates once', async () => {
  const { handle, restates } = await store();
  const copies: string[] = [];
  for (let capture = 0; capture < 3; capture += 1)
    copies.push(await retainedTextSource(handle, STATEMENT, 'document_revision'));
  for (const source of copies)
    await publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: restatement(restates, source, 'whole'),
      attributedTo: DETECTOR,
      secretAllow: [],
    });
  // Three source ids, one unchanged document: three occurrences, three sources, one text.
  expect(read(handle, (view) => readProjectPassageRestatements(view, restates))).toMatchObject({
    occurrences: 3,
    distinctSources: 3,
    distinctTexts: 1,
  });

  const different = await retainedTextSource(handle, `Also: ${STATEMENT}`, 'document_revision');
  await publishProjectPassageRestatement(handle, {
    operationId: uuidv7(),
    restatement: restatement(restates, different, 'whole'),
    attributedTo: DETECTOR,
    secretAllow: [],
  });
  expect(read(handle, (view) => readProjectPassageRestatements(view, restates))).toMatchObject({
    occurrences: 4,
    distinctSources: 4,
    distinctTexts: 2,
  });
});

it('refuses a source that does not state the words, and one retained only by reference', async () => {
  const { handle, restates } = await store();
  const unrelated = await retainedTextSource(
    handle,
    'Completely unrelated text about the weather.'
  );
  const byReference = await referencedSource(handle, STATEMENT);
  for (const source of [unrelated, byReference])
    await expect(
      publishProjectPassageRestatement(handle, {
        operationId: uuidv7(),
        restatement: restatement(restates, source),
        attributedTo: DETECTOR,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'passage_restatements')).toBe(0);
});

it('reads a nested capture field’s words from the event it names', async () => {
  const { handle, plan, sourceId, restates } = await store();
  const criterionText = plan.steps[0]!.criteria[0]!.text;
  await expect(
    publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: restatement(restates, sourceId, 'plan_steps[0].text'),
      attributedTo: DETECTOR,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  const criterionId = uuidv7();
  const criterionRevision = uuidv7();
  const inTheEvent = {
    source_id: sourceId,
    location: 'plan_steps[0].acceptance_criteria[0].text',
    passage_sha256: digest(Buffer.from(criterionText, 'utf8')),
  };
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: { requirement_id: criterionId, origin: { kind: 'authored', source_id: sourceId } },
    revision: {
      requirement_id: criterionId,
      revision_id: criterionRevision,
      previous_revision_id: null,
      statement: criterionText,
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
  const criterion = {
    kind: 'requirement' as const,
    entity_id: criterionId,
    revision_id: criterionRevision,
  };
  await publishProjectPassageRestatement(handle, {
    operationId: uuidv7(),
    restatement: {
      restatement_id: uuidv7(),
      passage: inTheEvent,
      restates: criterion,
      recorded_at: AT,
    },
    attributedTo: DETECTOR,
    secretAllow: [],
  });
  expect(read(handle, (view) => readProjectPassageRestatements(view, criterion)).occurrences).toBe(
    1
  );
});

it('refuses the passage a promoted requirement’s own identity was promoted from', async () => {
  const { handle, restatingSourceId } = await store();
  const promoted = {
    source_id: restatingSourceId,
    location: 'the whole instruction',
    passage_sha256: digest(Buffer.from(STATEMENT, 'utf8')),
  };
  const requirementId = uuidv7();
  const revisionId = uuidv7();
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: requirementId,
      origin: { kind: 'promoted_source', passage: promoted, promoted_at: AT },
    },
    revision: {
      requirement_id: requirementId,
      revision_id: revisionId,
      previous_revision_id: null,
      statement: STATEMENT,
      rationale: null,
      subject: null,
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [restatingSourceId],
      // The revision cites none: the exact passage lives in the identity's origin.
      passages: [],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const restates = {
    kind: 'requirement' as const,
    entity_id: requirementId,
    revision_id: revisionId,
  };
  await expect(
    publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: {
        restatement_id: uuidv7(),
        passage: promoted,
        restates,
        recorded_at: AT,
      },
      attributedTo: DETECTOR,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  // Another passage of the same source is still a second occurrence.
  await publishProjectPassageRestatement(handle, {
    operationId: uuidv7(),
    restatement: restatement(restates, restatingSourceId, 'a later turn'),
    attributedTo: DETECTOR,
    secretAllow: [],
  });
  expect(rowCount(handle, 'passage_restatements')).toBe(1);
});

it('refuses a paraphrase, the revision’s own passage, and a passage with no source', async () => {
  const { handle, restates, restatingSourceId, citedPassage } = await store();
  const before = publicationState(handle);
  const paraphrase = restatement(restates, restatingSourceId);
  for (const refused of [
    { ...paraphrase, passage: { ...paraphrase.passage, passage_sha256: 'e'.repeat(64) } },
    { ...paraphrase, passage: citedPassage },
  ])
    await expect(
      publishProjectPassageRestatement(handle, {
        operationId: uuidv7(),
        restatement: refused,
        attributedTo: DETECTOR,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: restatement(restates, uuidv7()),
      attributedTo: DETECTOR,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'passage_restatements')).toBe(0);
  expect(publicationState(handle)).toEqual(before);
});

it('refuses a retained payload that states nothing, including a bare null', async () => {
  const { handle, restatingSourceId } = await store();
  const payloads = [null, 'a bare string', { asserted: STATEMENT }];
  for (const [position, record] of payloads.entries()) {
    const claimId = uuidv7();
    const revisionId = uuidv7();
    await publishProjectClaimRevision(handle, {
      operationId: uuidv7(),
      claimId,
      revisionId,
      previousRevisionId: null,
      occurrence: { sourceEventId: restatingSourceId, fieldPath: 'released', position },
      assertedBy: 'someone',
      assertionSource: { kind: 'released' },
      agentReportedVerification: null,
      record,
    });
    await expect(
      publishProjectPassageRestatement(handle, {
        operationId: uuidv7(),
        restatement: restatement(
          { kind: 'claim', entity_id: claimId, revision_id: revisionId },
          restatingSourceId,
          `released ${position}`
        ),
        attributedTo: DETECTOR,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(rowCount(handle, 'passage_restatements')).toBe(0);
});

it('refuses a revision this history does not hold and a relationship as the thing restated', async () => {
  const { handle, restates, restatingSourceId } = await store();
  await expect(
    publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: restatement({ ...restates, revision_id: uuidv7() }, restatingSourceId),
      attributedTo: DETECTOR,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(
    publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: {
        ...restatement(restates, restatingSourceId),
        restates: {
          kind: 'relationship',
          entity_id: restates.entity_id,
          revision_id: restates.entity_id,
        },
      },
      attributedTo: DETECTOR,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'passage_restatements')).toBe(0);
});

it('replays the original result and refuses a changed authored field under one operation id', async () => {
  const { handle, restates, restatingSourceId } = await store();
  const operationId = uuidv7();
  const record = restatement(restates, restatingSourceId);
  const published = await publishProjectPassageRestatement(handle, {
    operationId,
    restatement: record,
    attributedTo: DETECTOR,
    secretAllow: [],
  });
  expect(
    await publishProjectPassageRestatement(handle, {
      operationId,
      restatement: record,
      attributedTo: DETECTOR,
      secretAllow: [],
    })
  ).toEqual({ ...published, replayed: true });
  await expect(
    publishProjectPassageRestatement(handle, {
      operationId,
      restatement: { ...record, recorded_at: '2026-09-19T08:00:00.000Z' },
      attributedTo: DETECTOR,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'passage_restatements')).toBe(1);
});

it('refuses an acting attribution named inside the record', async () => {
  const { handle, restates, restatingSourceId } = await store();
  await expect(
    publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: { ...restatement(restates, restatingSourceId), attributed_to: BY_OWNER },
      attributedTo: DETECTOR,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'passage_restatements')).toBe(0);
});
