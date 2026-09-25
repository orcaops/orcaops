import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { openProjectDatabase, type ProjectDatabase } from './connection.js';
import {
  listProjectAdoptions,
  listProjectAssessments,
  listProjectRecordRelationships,
  publishProjectAdoption,
  publishProjectAssessment,
  publishProjectClaimRevision,
  publishProjectCriterionLineage,
  publishProjectDecisionRevision,
  publishProjectRecordRelationship,
  readProjectClaim,
  readProjectCriterionLineage,
  readProjectDecision,
} from './exact-revision-records.js';
import * as databaseBarrel from './index.js';
import {
  type RestoredFixture,
  restoreFixture,
  snapshot,
} from '../../../tests/database-fixture.mjs';
import { uuidv7 } from '../../ids/uuidv7.js';

const candidate = fileURLToPath(new URL('../../../../../', import.meta.url));
const opened: RestoredFixture[] = [];
const handles: ProjectDatabase[] = [];

afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(opened.splice(0).map((f) => f.cleanup()));
});

async function store() {
  const restored = await restoreFixture(
    candidate,
    path.join(candidate, 'packages/storage/src/history/database/fixtures/artifact-records.json')
  );
  opened.push(restored);
  const handle = await openProjectDatabase({ authority: restored.authority, mode: 'writer' });
  handles.push(handle);
  const event = handle.read((view) =>
    view.get<{ artifact_id: string; event_id: string }>(
      "SELECT artifact_id, event_id FROM artifact_events WHERE event_type='plan_captured' ORDER BY event_id LIMIT 1"
    )
  ).value!;
  return { ...restored, handle, event };
}

const counters = (handle: ProjectDatabase) => handle.read(() => null).counters;

async function claim(handle: ProjectDatabase, eventId: string) {
  const claimId = uuidv7();
  const first = uuidv7();
  await publishProjectClaimRevision(handle, {
    operationId: uuidv7(),
    claimId,
    revisionId: first,
    previousRevisionId: null,
    occurrence: { sourceEventId: eventId, fieldPath: 'checkpoint.claims', position: 0 },
    assertedBy: 'claude-code',
    assertionSource: { event_id: eventId, field: 'summary' },
    agentReportedVerification: { command: 'pnpm test', exit_code: 0 },
    record: { claim: 'the reader drops a retained row' },
  });
  const second = uuidv7();
  await publishProjectClaimRevision(handle, {
    operationId: uuidv7(),
    claimId,
    revisionId: second,
    previousRevisionId: first,
    occurrence: { sourceEventId: eventId, fieldPath: 'checkpoint.claims', position: 1 },
    assertedBy: 'claude-code',
    assertionSource: { event_id: eventId, field: 'summary' },
    agentReportedVerification: null,
    record: { claim: 'the reader drops a retained row on reopen only' },
  });
  return { claimId, first, second };
}

async function decision(handle: ProjectDatabase, eventId: string) {
  const decisionId = uuidv7();
  const first = uuidv7();
  await publishProjectDecisionRevision(handle, {
    operationId: uuidv7(),
    decisionId,
    revisionId: first,
    previousRevisionId: null,
    occurrence: { sourceEventId: eventId, fieldPath: 'plan.decisions', position: 0 },
    authoredBy: 'claude-code',
    alternativeCount: 1,
    record: {
      decision: 'rebuild the listing rows',
      reason: 'the claim above says a retained row disappears',
      alternatives: [{ option: 'repair on read', rejected_because: 'reads never repair' }],
    },
  });
  const second = uuidv7();
  await publishProjectDecisionRevision(handle, {
    operationId: uuidv7(),
    decisionId,
    revisionId: second,
    previousRevisionId: first,
    occurrence: { sourceEventId: eventId, fieldPath: 'plan.decisions', position: 1 },
    authoredBy: 'claude-code',
    alternativeCount: 2,
    record: {
      decision: 'rebuild the listing rows explicitly',
      reason: 'same claim, narrowed to an explicit command',
      alternatives: [
        { option: 'repair on read', rejected_because: 'reads never repair' },
        { option: 'rebuild on every open', rejected_because: 'an open is not a repair request' },
      ],
    },
  });
  return { decisionId, first, second };
}

it('publishes each seeded record shape and reads every retained fact back', async () => {
  const f = await store();
  const before = counters(f.handle);
  const c = await claim(f.handle, f.event.event_id);
  const d = await decision(f.handle, f.event.event_id);

  const criterionId = uuidv7();
  await publishProjectCriterionLineage(f.handle, {
    operationId: uuidv7(),
    occurrence: {
      sourceEventId: f.event.event_id,
      fieldPath: 'plan_steps[0].acceptance_criteria[0]',
      position: 0,
    },
    criterionId,
    stepId: uuidv7(),
    artifactId: f.event.artifact_id,
    artifactGeneration: 1,
    lineage: 'added',
    priorCriterionId: null,
    scope: { kind: 'branch', branch: 'main' },
    record: { text: 'Every retained row survives' },
  });

  const edge = uuidv7();
  await publishProjectRecordRelationship(f.handle, {
    operationId: uuidv7(),
    relationshipId: edge,
    relation: 'challenges',
    from: { kind: 'claim', entityId: c.claimId, revisionId: c.first },
    to: { kind: 'decision', entityId: d.decisionId, revisionId: d.first },
    scope: { kind: 'project' },
    attribution: { kind: 'author', id: 'claude-code' },
    sourceRefs: ['checkpoint 3 summary'],
  });

  const adoption = uuidv7();
  await publishProjectAdoption(f.handle, {
    operationId: uuidv7(),
    adoptionId: adoption,
    target: { kind: 'decision', entityId: d.decisionId, revisionId: d.second },
    approver: 'owner',
    approvedAt: '2026-09-08T00:00:00.000Z',
    scope: { kind: 'branch', branch: 'history-database-gate-second-half' },
    sourceRefs: ['approval note'],
  });

  const beforeAssessment = counters(f.handle);
  const assessment = uuidv7();
  const published = await publishProjectAssessment(f.handle, {
    operationId: uuidv7(),
    assessmentId: assessment,
    claimId: c.claimId,
    claimRevisionId: c.first,
    assessedBy: 'claude-code',
    observed: beforeAssessment,
    verification: { command: 'pnpm test', exit_code: 0 },
    record: { assessment: 'eligible for reassessment' },
  });

  const read = f.handle.read((view) => ({
    claim: readProjectClaim(view, c.claimId),
    decision: readProjectDecision(view, d.decisionId),
    lineage: readProjectCriterionLineage(view, criterionId),
    relationships: listProjectRecordRelationships(view, { toRevisionId: d.first }),
    adoptions: listProjectAdoptions(view, { targetRevisionId: d.second }),
    assessments: listProjectAssessments(view, c.claimId),
  })).value;

  expect(read.claim!.firstRevisionId).toBe(c.first);
  expect(read.claim!.revisions.map((r) => r.revisionId)).toEqual([c.first, c.second]);
  expect(read.claim!.revisions[0]!.previousRevisionId).toBeNull();
  expect(read.claim!.revisions[1]!.previousRevisionId).toBe(c.first);
  // Verification is agent-supplied evidence and says so; it never claims to be proof.
  expect(read.claim!.revisions[0]!.verificationProvenance).toBe('agent_reported');
  expect(read.claim!.revisions[1]!.verificationJson).toBeNull();
  expect(read.claim!.revisions.map((r) => r.occurrence.position)).toEqual([0, 1]);

  expect(read.decision!.revisions.map((r) => r.revisionId)).toEqual([d.first, d.second]);
  expect(read.decision!.revisions.map((r) => r.alternativeCount)).toEqual([1, 2]);
  expect(
    JSON.parse(Buffer.from(read.decision!.revisions[1]!.recordHex, 'hex').toString())
  ).toMatchObject({ decision: 'rebuild the listing rows explicitly' });

  expect(read.lineage).toHaveLength(1);
  expect(read.lineage[0]).toMatchObject({
    criterionId,
    lineage: 'added',
    priorCriterionId: null,
    scopeKind: 'branch',
    scopeValue: 'main',
    artifactId: f.event.artifact_id,
  });

  expect(read.relationships).toHaveLength(1);
  expect(read.relationships[0]).toMatchObject({
    relationshipId: edge,
    relation: 'challenges',
    scopeKind: 'project',
    scopeValue: null,
    attribution: { kind: 'author', id: 'claude-code' },
    sourceRefs: ['checkpoint 3 summary'],
  });

  expect(read.adoptions).toHaveLength(1);
  expect(read.adoptions[0]).toMatchObject({
    adoptionId: adoption,
    approver: 'owner',
    scopeKind: 'branch',
    scopeValue: 'history-database-gate-second-half',
  });
  // Approval is a separate row; it never rewrites who authored the decision it approves.
  expect(read.decision!.revisions[1]!.attributedTo).toBe('claude-code');

  expect(read.assessments).toHaveLength(1);
  expect(read.assessments[0]).toMatchObject({
    assessmentId: assessment,
    observedIntentCounter: beforeAssessment.intentChangeCounter,
    observedWriteSequence: beforeAssessment.writeSequence,
  });
  expect(published.counters.intentChangeCounter).toBe(beforeAssessment.intentChangeCounter);
  expect(published.counters.writeSequence).toBe(beforeAssessment.writeSequence + 1);
  // Six intent-changing publications: two claim revisions, two decision revisions, a criterion
  // lineage row, a relationship and an adoption — seven — and the assessment is not one of them.
  expect(beforeAssessment.intentChangeCounter - before.intentChangeCounter).toBe(7);
});

it('leaves an older edge on the revision it named after a later revision exists', async () => {
  const f = await store();
  const c = await claim(f.handle, f.event.event_id);
  const decisionId = uuidv7();
  const firstDecision = uuidv7();
  await publishProjectDecisionRevision(f.handle, {
    operationId: uuidv7(),
    decisionId,
    revisionId: firstDecision,
    previousRevisionId: null,
    occurrence: { sourceEventId: f.event.event_id, fieldPath: 'plan.decisions', position: 0 },
    authoredBy: 'claude-code',
    alternativeCount: 0,
    record: { decision: 'first' },
  });
  const edge = uuidv7();
  await publishProjectRecordRelationship(f.handle, {
    operationId: uuidv7(),
    relationshipId: edge,
    relation: 'challenges',
    from: { kind: 'claim', entityId: c.claimId, revisionId: c.first },
    to: { kind: 'decision', entityId: decisionId, revisionId: firstDecision },
    scope: { kind: 'project' },
    attribution: { kind: 'detector', id: 'similarity-detector' },
    sourceRefs: [],
  });
  const secondDecision = uuidv7();
  await publishProjectDecisionRevision(f.handle, {
    operationId: uuidv7(),
    decisionId,
    revisionId: secondDecision,
    previousRevisionId: firstDecision,
    occurrence: { sourceEventId: f.event.event_id, fieldPath: 'plan.decisions', position: 1 },
    authoredBy: 'claude-code',
    alternativeCount: 0,
    record: { decision: 'second' },
  });
  const edges = f.handle.read((view) => listProjectRecordRelationships(view)).value;
  expect(edges).toHaveLength(1);
  expect(edges[0]!.to.revisionId).toBe(firstDecision);
  // Nothing in this family can move an endpoint, including a direct write.
  const raw = new Database(f.file);
  try {
    expect(() =>
      raw
        .prepare('UPDATE record_relationships SET to_revision_id=? WHERE relationship_id=?')
        .run(secondDecision, edge)
    ).toThrow(/immutable/);
  } finally {
    raw.close();
  }
});

it('refuses a missing endpoint, an unknown relation and a duplicate identity without writing', async () => {
  const f = await store();
  const c = await claim(f.handle, f.event.event_id);
  const d = await decision(f.handle, f.event.event_id);
  const before = snapshot(Database, f.file);

  await expect(
    publishProjectRecordRelationship(f.handle, {
      operationId: uuidv7(),
      relationshipId: uuidv7(),
      relation: 'supersedes',
      from: { kind: 'claim', entityId: c.claimId, revisionId: c.second },
      to: { kind: 'decision', entityId: d.decisionId, revisionId: uuidv7() },
      scope: { kind: 'project' },
      attribution: { kind: 'author', id: 'claude-code' },
      sourceRefs: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });

  await expect(
    publishProjectRecordRelationship(f.handle, {
      operationId: uuidv7(),
      relationshipId: uuidv7(),
      relation: 'depends_on' as never,
      from: { kind: 'claim', entityId: c.claimId, revisionId: c.first },
      to: { kind: 'decision', entityId: d.decisionId, revisionId: d.first },
      scope: { kind: 'project' },
      attribution: { kind: 'author', id: 'claude-code' },
      sourceRefs: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  await expect(
    publishProjectClaimRevision(f.handle, {
      operationId: uuidv7(),
      claimId: c.claimId,
      revisionId: uuidv7(),
      previousRevisionId: c.second,
      occurrence: { sourceEventId: f.event.event_id, fieldPath: 'checkpoint.claims', position: 0 },
      assertedBy: 'claude-code',
      assertionSource: {},
      agentReportedVerification: null,
      record: {},
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  await expect(
    publishProjectClaimRevision(f.handle, {
      operationId: uuidv7(),
      claimId: c.claimId,
      revisionId: uuidv7(),
      previousRevisionId: c.first,
      occurrence: { sourceEventId: f.event.event_id, fieldPath: 'checkpoint.claims', position: 9 },
      assertedBy: 'claude-code',
      assertionSource: {},
      agentReportedVerification: null,
      record: {},
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  await expect(
    publishProjectAdoption(f.handle, {
      operationId: uuidv7(),
      adoptionId: uuidv7(),
      target: { kind: 'claim', entityId: c.claimId, revisionId: uuidv7() },
      approver: 'owner',
      approvedAt: '2026-09-08T00:00:00.000Z',
      scope: { kind: 'project' },
      sourceRefs: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });

  await expect(
    publishProjectAssessment(f.handle, {
      operationId: uuidv7(),
      assessmentId: uuidv7(),
      claimId: c.claimId,
      claimRevisionId: uuidv7(),
      assessedBy: 'claude-code',
      observed: counters(f.handle),
      verification: {},
      record: {},
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });

  expect(snapshot(Database, f.file)).toEqual(before);
});

it('replays an original publication by its operation ID without writing a second row', async () => {
  const f = await store();
  const claimId = uuidv7();
  const revisionId = uuidv7();
  const input = {
    operationId: uuidv7(),
    claimId,
    revisionId,
    previousRevisionId: null,
    occurrence: {
      sourceEventId: f.event.event_id,
      fieldPath: 'checkpoint.claims',
      position: 0,
    },
    assertedBy: 'claude-code',
    assertionSource: { event_id: f.event.event_id },
    agentReportedVerification: { command: 'pnpm test', exit_code: 0 },
    record: { claim: 'the reader drops a retained row' },
  } as const;
  const original = await publishProjectClaimRevision(f.handle, input);
  expect(original.replayed).toBe(false);
  const after = snapshot(Database, f.file);
  const replay = await publishProjectClaimRevision(f.handle, input);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(original.value);
  expect(replay.counters).toEqual(original.counters);
  expect(snapshot(Database, f.file)).toEqual(after);
});

it('stays private to storage rather than reaching a package barrel', async () => {
  const base: Record<string, unknown> = await import('../../index.js');
  const exported = [...Object.keys(databaseBarrel), ...Object.keys(base)];
  for (const name of [
    'publishProjectCriterionLineage',
    'publishProjectClaimRevision',
    'publishProjectDecisionRevision',
    'publishProjectRecordRelationship',
    'publishProjectAdoption',
    'publishProjectAssessment',
    // A runner-established execution is reachable only from the runner and the settlement beside
    // it; a barrel export would make it something any caller can state about a process nothing ran.
    'publishProjectObservedRun',
    'insertObservation',
    'readProjectClaim',
    'readProjectDecision',
    'readProjectCriterionLineage',
    'listProjectRecordRelationships',
    'listProjectAdoptions',
    'listProjectAssessments',
  ])
    expect(exported, name).not.toContain(name);
});

it('conflicts on a retry that alters any authored field and replays an identical one, per writer', async () => {
  const f = await store();

  const claimId = uuidv7();
  const claimRevisionId = uuidv7();
  await publishProjectClaimRevision(f.handle, {
    operationId: uuidv7(),
    claimId,
    revisionId: claimRevisionId,
    previousRevisionId: null,
    occurrence: { sourceEventId: f.event.event_id, fieldPath: 'checkpoint.claims', position: 0 },
    assertedBy: 'claude-code',
    assertionSource: { event_id: f.event.event_id },
    agentReportedVerification: { command: 'pnpm test', exit_code: 0 },
    record: { claim: 'a retained claim used as a relationship and assessment endpoint' },
  });
  const decisionId = uuidv7();
  const decisionRevisionId = uuidv7();
  await publishProjectDecisionRevision(f.handle, {
    operationId: uuidv7(),
    decisionId,
    revisionId: decisionRevisionId,
    previousRevisionId: null,
    occurrence: { sourceEventId: f.event.event_id, fieldPath: 'plan.decisions', position: 0 },
    authoredBy: 'claude-code',
    alternativeCount: 1,
    record: { decision: 'a retained decision used as a relationship and adoption endpoint' },
  });

  async function retryComparison<
    I,
    R extends { replayed: boolean; value: unknown; counters: unknown },
  >(publish: (input: I) => Promise<R>, base: I, altered: I[]) {
    const original = await publish(base);
    expect(original.replayed).toBe(false);
    const after = snapshot(Database, f.file);
    // Same operation id, one field changed each time: the receipt comparison must conflict, not
    // replay the prior success, and no second row lands.
    for (const variant of altered) {
      await expect(publish(variant)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(snapshot(Database, f.file)).toEqual(after);
    }
    // The identical retry replays byte-for-byte with no new row.
    const replay = await publish(base);
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual(original.value);
    expect(replay.counters).toEqual(original.counters);
    expect(snapshot(Database, f.file)).toEqual(after);
  }

  // criterion lineage — altered applicability scope
  const criterionOperationId = uuidv7();
  const criterionId = uuidv7();
  const criterionBase = {
    operationId: criterionOperationId,
    occurrence: {
      sourceEventId: f.event.event_id,
      fieldPath: 'plan_steps[0].acceptance_criteria[0]',
      position: 0,
    },
    criterionId,
    stepId: uuidv7(),
    artifactId: f.event.artifact_id,
    artifactGeneration: 1,
    lineage: 'added' as const,
    priorCriterionId: null,
    scope: { kind: 'branch' as const, branch: 'main' },
    record: { text: 'Every retained row survives' },
  };
  await retryComparison(
    (input: typeof criterionBase) => publishProjectCriterionLineage(f.handle, input),
    criterionBase,
    [{ ...criterionBase, scope: { kind: 'branch' as const, branch: 'other' } }]
  );

  // claim revision — altered assertion source
  const claimOperationId = uuidv7();
  const claimBase = {
    operationId: claimOperationId,
    claimId: uuidv7(),
    revisionId: uuidv7(),
    previousRevisionId: null,
    occurrence: { sourceEventId: f.event.event_id, fieldPath: 'checkpoint.claims', position: 1 },
    assertedBy: 'claude-code',
    assertionSource: { event_id: f.event.event_id, field: 'summary' },
    agentReportedVerification: { command: 'pnpm test', exit_code: 0 },
    record: { claim: 'the reader drops a retained row' },
  };
  await retryComparison(
    (input: typeof claimBase) => publishProjectClaimRevision(f.handle, input),
    claimBase,
    [{ ...claimBase, assertionSource: { event_id: f.event.event_id, field: 'body' } }]
  );

  // decision revision — altered alternative count
  const decisionBase = {
    operationId: uuidv7(),
    decisionId: uuidv7(),
    revisionId: uuidv7(),
    previousRevisionId: null,
    occurrence: { sourceEventId: f.event.event_id, fieldPath: 'plan.decisions', position: 1 },
    authoredBy: 'claude-code',
    alternativeCount: 2,
    record: { decision: 'store exact revisions' },
  };
  await retryComparison(
    (input: typeof decisionBase) => publishProjectDecisionRevision(f.handle, input),
    decisionBase,
    [{ ...decisionBase, alternativeCount: 3 }]
  );

  // relationship — altered source references
  const relationshipBase = {
    operationId: uuidv7(),
    relationshipId: uuidv7(),
    relation: 'challenges' as const,
    from: { kind: 'claim' as const, entityId: claimId, revisionId: claimRevisionId },
    to: { kind: 'decision' as const, entityId: decisionId, revisionId: decisionRevisionId },
    scope: { kind: 'project' as const },
    attribution: { kind: 'author' as const, id: 'claude-code' },
    sourceRefs: ['comment:one'],
  };
  await retryComparison(
    (input: typeof relationshipBase) => publishProjectRecordRelationship(f.handle, input),
    relationshipBase,
    [{ ...relationshipBase, sourceRefs: ['comment:two'] }]
  );

  // adoption — altered source references and, critically, an altered adoption id: the adoption's
  // own primary key is not part of its approval target, so it has to be in the retry comparison too
  const adoptionBase = {
    operationId: uuidv7(),
    adoptionId: uuidv7(),
    target: {
      kind: 'decision' as const,
      entityId: decisionId,
      revisionId: decisionRevisionId,
    },
    approver: 'owner',
    approvedAt: '2026-09-08T00:00:00.000Z',
    scope: { kind: 'project' as const },
    sourceRefs: ['approval:one'],
  };
  await retryComparison(
    (input: typeof adoptionBase) => publishProjectAdoption(f.handle, input),
    adoptionBase,
    [
      { ...adoptionBase, sourceRefs: ['approval:two'] },
      { ...adoptionBase, adoptionId: uuidv7() },
    ]
  );

  // assessment — altered reported verification
  const observed = counters(f.handle);
  const assessmentBase = {
    operationId: uuidv7(),
    assessmentId: uuidv7(),
    claimId,
    claimRevisionId,
    assessedBy: 'claude-code',
    observed,
    verification: { command: 'pnpm test', exit_code: 0 },
    record: { assessment: 'eligible' },
  };
  await retryComparison(
    (input: typeof assessmentBase) => publishProjectAssessment(f.handle, input),
    assessmentBase,
    [{ ...assessmentBase, verification: { command: 'pnpm test', exit_code: 1 } }]
  );
});
