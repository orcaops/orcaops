// What the resolver is told about one identity is read from rows here, so a column read wrongly
// would under-report what stands without any writer refusing anything.
import { afterEach, expect, it } from 'vitest';

import { publishProjectAuthorization } from './knowledge-authorizations.js';
import { publishProjectConflictAnswer } from './knowledge-conflict-answers.js';
import { appendProjectCorrection } from './knowledge-corrections.js';
import { publishProjectContinuingDecisionRevision } from './knowledge-decisions.js';
import { readProjectGoverningState } from './knowledge-read-governing.js';
import { publishProjectRequirementRevision } from './knowledge-requirements.js';
import { publishProjectSelection } from './knowledge-selections.js';
import {
  knowledgeRecordsOf,
  resolveProjectKnowledge,
  type UnreadableKnowledgeRecord,
} from './knowledge-standing.js';
import { runProjectOperation } from './transactions.js';
import {
  acceptedSelection,
  adoptOnBranch,
  AT,
  authorityStore,
  BY_OWNER,
  findingRevision,
  importRelationship,
  importUnreadableCorrection,
  informedBy,
  instructedBy,
  observing,
  requirementRevision,
  successorRevision,
} from '../../../tests/knowledge-authority-store.js';
import {
  AGENT,
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { AuthorityScope, ExpectationRevisionRef } from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const standing = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  target: { kind: 'requirement' | 'decision' | 'claim'; entity_id: string },
  scope: AuthorityScope = store.project
) =>
  read(store.handle, (view) =>
    resolveProjectKnowledge(view, target, store.authority.projectId, scope, {})
  );

const importReplacementStar = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  relationshipStanding: 'suggested' | 'established'
) =>
  runProjectOperation(
    store.handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.imported.relationship.graph',
      target: { requirementId: store.requirementId },
      payload: { shape: 'star', edges: 10_001, standing: relationshipStanding },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      const foreignRequirement = 'bounded-graph-requirement';
      const firstForeignRevision = 'bounded-graph-revision-0';
      const recordBytes = Buffer.from('{}');
      const recordSha256 = '0'.repeat(64);
      transaction.run(
        `INSERT INTO requirements (requirement_id, first_revision_id, origin_kind, record_bytes,
           record_sha256, operation_id)
         VALUES (?,?,'authored',?,?,?)`,
        foreignRequirement,
        firstForeignRevision,
        recordBytes,
        recordSha256,
        settling.operationId
      );
      for (let index = 0; index < 10_001; index += 1) {
        const revisionId = `bounded-graph-revision-${index}`;
        transaction.run(
          `INSERT INTO requirement_revisions (revision_id, requirement_id, previous_revision_id,
             source_standing, duration_kind, attributed_kind, attributed_to, attributed_basis,
             record_bytes, record_sha256, operation_id)
           VALUES (?,?,?,'explicit_instruction','continuing','actor',?,'unknown',?,?,?)`,
          revisionId,
          foreignRequirement,
          index === 0 ? null : firstForeignRevision,
          null,
          recordBytes,
          recordSha256,
          settling.operationId
        );
        transaction.run(
          `INSERT INTO record_relationships (relationship_id, relation, from_entity_kind,
             from_entity_id, from_revision_id, to_entity_kind, to_entity_id, to_revision_id,
             scope_kind, scope_value, attributed_kind, attributed_to, attributed_basis, standing,
             explanation, source_refs_json, operation_id)
           VALUES (?,'supersedes','requirement',?,?,'requirement',?,?,'project',NULL,
             'author',?,'unknown',?,NULL,'[]',?)`,
          `replacement-${index}`,
          foreignRequirement,
          revisionId,
          store.target.entity_id,
          store.target.revision_id,
          OWNER.identity,
          relationshipStanding,
          settling.operationId
        );
      }
      return { imported: 10_001 };
    }
  );

const importRelationshipWithRequirementId = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  relation: 'depends_on' | 'supersedes',
  relationshipStanding: 'suggested' | 'established'
) =>
  runProjectOperation(
    store.handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.imported.relationship.shared-id',
      target: { relationshipId: store.requirementId },
      payload: { relation, relationshipStanding },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      const bytes = Buffer.from('{}');
      const sha256 = digest(bytes);
      for (const id of ['other-a', 'other-b']) {
        transaction.run(
          `INSERT INTO requirements (requirement_id, first_revision_id, origin_kind, record_bytes,
             record_sha256, operation_id) VALUES (?,?, 'authored',?,?,?)`,
          id,
          `${id}-v1`,
          bytes,
          sha256,
          settling.operationId
        );
        transaction.run(
          `INSERT INTO requirement_revisions (revision_id, requirement_id, previous_revision_id,
             source_standing, duration_kind, attributed_kind, attributed_to, attributed_basis,
             record_bytes, record_sha256, operation_id)
           VALUES (?,?,NULL,'explicit_instruction','continuing','actor',NULL,'unknown',?,?,?)`,
          `${id}-v1`,
          id,
          bytes,
          sha256,
          settling.operationId
        );
      }
      transaction.run(
        `INSERT INTO record_relationships (relationship_id, relation, from_entity_kind,
           from_entity_id, from_revision_id, to_entity_kind, to_entity_id, to_revision_id,
           scope_kind, scope_value, attributed_kind, attributed_to, attributed_basis, standing,
           explanation, source_refs_json, operation_id)
         VALUES (?,?, 'requirement','other-a','other-a-v1','requirement','other-b','other-b-v1',
           'project',NULL,'author',?,'unknown',?,NULL,'[]',?)`,
        store.requirementId,
        relation,
        OWNER.identity,
        relationshipStanding,
        settling.operationId
      );
      return { relationshipId: store.requirementId };
    }
  );

it('reads a requirement revision back with the standing and attribution its columns hold', async () => {
  const store = await authorityStore();
  const selection = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const resolved = standing(store, { kind: 'requirement', entity_id: store.requirementId });
  expect(resolved.revisions).toEqual([
    expect.objectContaining({
      standing: 'stands',
      designation: 'adopted',
      applicability: 'applies',
      source_standing: 'explicit_instruction',
      attributed_to: { kind: 'actor', actor: OWNER },
      stood_by: [selection.selection_id],
    }),
  ]);
  expect(resolved.governing_state).toEqual({
    selection_ids: [selection.selection_id],
    correction_action_ids: [],
  });
});

it.each([
  ['depends_on', 'established'],
  ['supersedes', 'suggested'],
  ['supersedes', 'established'],
] as const)(
  'does not load an unrelated %s relationship whose id equals the requirement id',
  async (relation, relationshipStanding) => {
    const store = await authorityStore();
    await importRelationshipWithRequirementId(store, relation, relationshipStanding);

    const resolved = standing(store, {
      kind: 'requirement',
      entity_id: store.requirementId,
    });

    expect(resolved.relationships).toEqual([]);
  }
);

it('reads an adopted decision revision the same way', async () => {
  const store = await authorityStore();
  const decisionId = uuidv7();
  const chosen = 'Capture writes to SQLite before any network call.';
  const passage = {
    source_id: store.instructionId,
    location: 'turn 4, sentence 2',
    passage_sha256: digest(Buffer.from(chosen)),
  };
  const revisionId = uuidv7();
  await publishProjectContinuingDecisionRevision(store.handle, {
    operationId: uuidv7(),
    revision: {
      decision_id: decisionId,
      revision_id: revisionId,
      previous_revision_id: null,
      chosen_approach: chosen,
      rationale: 'Local durability first.',
      alternatives: [],
      assumptions: [],
      reconsideration_conditions: [],
      subject: null,
      applicability: { all_of: [] },
      source_ids: [store.instructionId],
      passages: [passage],
      derivation: null,
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    occurrence: { source_id: store.instructionId, location: passage.location },
    secretAllow: [],
  });
  const target: ExpectationRevisionRef = {
    kind: 'decision',
    entity_id: decisionId,
    revision_id: revisionId,
  };
  const selection = acceptedSelection(
    target,
    store.project,
    informedBy(store.instructionId, [target], store.project)
  );
  const adopted = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(adopted.value.recordedIn).toBe('adoptions');
  const resolved = standing(store, { kind: 'decision', entity_id: decisionId });
  expect(resolved.revisions).toEqual([
    expect.objectContaining({
      revision: target,
      standing: 'stands',
      designation: 'adopted',
      source_standing: 'explicit_instruction',
      attributed_to: { kind: 'actor', actor: OWNER },
    }),
  ]);
  expect(resolved.governing_state.selection_ids).toEqual([selection.selection_id]);
});

it('reads a claim revision without granting it authority', async () => {
  const store = await authorityStore();
  const target = await findingRevision(store);
  const resolved = standing(store, { kind: 'claim', entity_id: target.entity_id });
  expect(resolved.revisions).toEqual([
    expect.objectContaining({
      revision: target,
      standing: 'unadopted',
      designation: null,
      source_standing: 'agent_proposal',
      attributed_to: { kind: 'actor', actor: AGENT },
      stood_by: [],
    }),
  ]);
  expect(resolved.governing_state).toEqual({ selection_ids: [], correction_action_ids: [] });
});

/**
 * Two adopted revisions of one identity, which is the one conflict a read can hold, with two
 * authorized answers to it given at the same instant. The contract picks the latest answer, and of
 * two at one instant the refusal, so two authorized ones leave the row order to decide.
 */
async function answeredAtOneInstant(answerIds: readonly string[]) {
  const store = await authorityStore();
  const first = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: first,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const successor = await successorRevision(store);
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      successor,
      store.project,
      informedBy(store.instructionId, [store.target], store.project),
      { expectedState: observing([first.selection_id]) }
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  for (const answerId of answerIds) {
    const authorizationId = uuidv7();
    await publishProjectAuthorization(store.handle, {
      operationId: uuidv7(),
      authorization: {
        authorization_id: authorizationId,
        instruction: informedBy(store.instructionId, [store.target], store.project),
        adopts: [],
        departs_from: [
          { rule: store.target, how: 'withdraws', exception_id: null, replaced_by: null },
        ],
        restates: [],
        context: null,
        recorded_at: AT,
      },
      grantedBy: OWNER,
      secretAllow: [],
    });
    await publishProjectConflictAnswer(store.handle, {
      operationId: uuidv7(),
      answer: {
        answer_id: answerId,
        rule: store.target,
        outcome: 'authorized',
        context: { all_of: [] },
        scope: store.project,
        source_id: store.instructionId,
        answered_at: AT,
        authorization_id: authorizationId,
      },
      answeredBy: OWNER,
      secretAllow: [],
    });
  }
  return standing(store, { kind: 'requirement', entity_id: store.requirementId });
}

it('names the same one of two authorized answers at one instant, published either way round', async () => {
  const answerIds = [uuidv7(), uuidv7()].sort();
  const published = await answeredAtOneInstant(answerIds);
  const reversed = await answeredAtOneInstant([...answerIds].reverse());
  expect(published.conflicts[0]!.disposition!.answer_ids).toEqual([answerIds[0]]);
  expect(reversed.conflicts[0]!.disposition!.answer_ids).toEqual([answerIds[0]]);
});

it('reports a branch-scoped adoption as itself and lets it govern nothing', async () => {
  const store = await authorityStore();
  const branchAdoption = await adoptOnBranch(store.handle, {
    target: store.target,
    branch: 'main',
  });
  const sibling = requirementRevision(store.requirementId, store.sourceId, {
    previousRevisionId: store.revisionId,
    statement: 'Local capture works offline, always.',
  });
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision: sibling,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const beside: ExpectationRevisionRef = {
    kind: 'requirement',
    entity_id: store.requirementId,
    revision_id: sibling.revision_id,
  };
  // The branch row stands beside nothing, so an instruction that acknowledges only its own
  // revision is enough for the sibling.
  const published = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      beside,
      store.project,
      informedBy(store.instructionId, [beside], store.project)
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(published.value.recordedIn).toBe('adoptions');

  const resolved = standing(store, { kind: 'requirement', entity_id: store.requirementId });
  expect(resolved.branch_scoped).toEqual([
    {
      record_id: branchAdoption,
      record: 'selection',
      branch: 'main',
      target: store.target,
      designation: 'adopted',
    },
  ]);
  expect(resolved.omissions).toContainEqual({
    record: 'branch_scoped_row',
    record_id: branchAdoption,
    reason: 'branch_scope',
  });
  expect(resolved.governing_state.selection_ids).toEqual([published.value.selectionId]);
  expect(
    resolved.revisions.find((entry) => entry.revision.revision_id === store.revisionId)!.standing
  ).toBe('unadopted');
});

it('stops a writer at a retained correction that will not read as its contract record', async () => {
  const store = await authorityStore();
  await importUnreadableCorrection(store.handle, { target: store.target });
  expect(() =>
    standing(store, { kind: 'requirement', entity_id: store.requirementId })
  ).toThrowError(/does not read as its contract record/);
});

it('names what it could not read and answers with the rest for a passive read', async () => {
  const store = await authorityStore();
  const actionId = await importUnreadableCorrection(store.handle, { target: store.target });
  const unreadable: UnreadableKnowledgeRecord[] = [];
  const records = read(store.handle, (view) =>
    knowledgeRecordsOf(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      {
        scope: store.project,
        mode: 'current',
        knowledge_boundary: Number.MAX_SAFE_INTEGER,
        implementation: { kind: 'none_selected' },
        applicability: {},
        exceptions_judged_at: null,
        exception_conditions: {},
      },
      { unreadable }
    )
  );
  expect(unreadable).toEqual([{ record: 'correction', record_id: actionId }]);
  expect(records.corrections).toEqual([]);
  expect(records.revisions.map((entry) => entry.record.revision.revision_id)).toEqual([
    store.revisionId,
  ]);
});

it('retains direct replacements from another scope and after a historical boundary', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const otherScope = await importRelationship(store.handle, {
    from: successor,
    to: store.target,
    scope: store.artifact,
  });
  expect(
    standing(store, { kind: 'requirement', entity_id: store.requirementId }).omissions
  ).toContainEqual({
    record: 'relationship',
    record_id: otherScope,
    reason: 'another_scope',
  });

  const boundary = counters(store.handle).writeSequence;
  const later = await importRelationship(store.handle, {
    from: successor,
    to: store.target,
    scope: store.project,
  });
  const historical = read(store.handle, (view) =>
    readProjectGoverningState(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      {
        scope: store.project,
        mode: 'historical',
        knowledge_boundary: boundary,
        implementation: { kind: 'none_selected' },
        applicability: {},
        exceptions_judged_at: null,
        exception_conditions: {},
      }
    )
  ).resolved;
  expect(historical.later_annotations).toContainEqual(
    expect.objectContaining({ record: 'relationship', record_id: later })
  );
});

it('fails closed when a reachable replacement graph exceeds its row bound', async () => {
  const store = await authorityStore();
  await importReplacementStar(store, 'established');

  const resolved = standing(store, {
    kind: 'requirement',
    entity_id: store.requirementId,
  });
  expect(resolved.relationships).toHaveLength(10_000);
  expect(resolved.unresolved).toContainEqual(
    expect.objectContaining({ reason: 'replacement_graph_incomplete' })
  );
  expect(resolved.relationships.every((relationship) => !relationship.applied)).toBe(true);
}, 15_000);

it('does not spend the replacement graph bound on suggested edges', async () => {
  const store = await authorityStore();
  await importReplacementStar(store, 'suggested');

  const resolved = standing(store, {
    kind: 'requirement',
    entity_id: store.requirementId,
  });
  expect(resolved.relationships).toHaveLength(10_001);
  expect(resolved.unresolved).not.toContainEqual(
    expect.objectContaining({ reason: 'replacement_graph_incomplete' })
  );
  expect(
    resolved.relationships.every((relationship) => relationship.not_applied === 'suggested')
  ).toBe(true);
}, 15_000);

it('leaves every proposing correction out of the governing state it computes', async () => {
  const store = await authorityStore();
  const proposing = [
    { kind: 'challenge', explanation: 'Offline capture may be unaffordable.' },
    {
      kind: 'factual_correction',
      corrected_account: 'The instruction came from the support lead.',
    },
    {
      kind: 'identity_correction',
      mistaken_predecessor: store.target,
      intended_interpretation: 'The rule continued the wrong record.',
    },
    {
      kind: 'use_correction',
      mistaken_use: {
        artifact_id: store.plan.artifactId,
        plan_event_id: store.plan.planEventId,
        target: store.target,
      },
      intended_interpretation: 'The export task never relied on offline capture.',
    },
  ];
  const appended: string[] = [];
  for (const proposal of proposing) {
    const action = {
      action_id: uuidv7(),
      targets: [store.target],
      scope: store.project,
      source_id: store.instructionId,
      authorization: null,
      expected_state: { kind: 'initial' as const },
      ...proposal,
    };
    await appendProjectCorrection(store.handle, {
      operationId: uuidv7(),
      action,
      attributedTo: BY_OWNER,
      secretAllow: [],
    });
    appended.push(action.action_id);
  }
  // The premise the writer's own guard defends: a proposal governs nothing, so none of these is in
  // the state a later act observes, and none of them is recorded as having changed what stands.
  const resolved = standing(store, { kind: 'requirement', entity_id: store.requirementId });
  expect(resolved.governing_state.correction_action_ids).toEqual([]);
  expect(resolved.proposals.map((entry) => entry.action_id).sort()).toEqual([...appended].sort());
});
