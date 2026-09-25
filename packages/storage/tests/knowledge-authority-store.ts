// A real project database holding what the records that carry authority need: a captured plan, a
// source, and a requirement with a first revision to select, except from and answer about.
//
// Everything an act here rests on is published through its own writer; only the rows no writer of
// this build can produce — a branch scope, a revocation whose scope reaches no further than the
// row it names — are written by hand, as an import or a sync would deliver them.
import { AGENT, type CapturedPlan, capturePlan, knowledgeStore, OWNER } from './knowledge-store.js';
import { canonicalJson } from '../src/events/canonical-json.js';
import {
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
} from '../src/history/database/connection.js';
import { publishProjectContinuingClaimRevision } from '../src/history/database/knowledge-claims.js';
import { appendProjectCorrection } from '../src/history/database/knowledge-corrections.js';
import { publishProjectRelationship } from '../src/history/database/knowledge-relationships.js';
import {
  createProjectRequirement,
  publishProjectRequirementRevision,
} from '../src/history/database/knowledge-requirements.js';
import { publishProjectKnowledgeSource } from '../src/history/database/knowledge-sources.js';
import { runProjectOperation } from '../src/history/database/transactions.js';
import { digest } from '../src/history/event-integrity.js';
import { uuidv7 } from '../src/ids/uuidv7.js';
import type {
  Actor,
  AuthorityScope,
  ExpectationRevisionRef,
  ExpectedState,
  RecordRevisionRef,
} from '../src/schema/knowledge-contract.js';

export const AT = '2026-09-17T10:00:00.000Z';

export interface AuthorityStore {
  readonly handle: ProjectDatabase;
  readonly authority: ProjectDatabaseAuthority;
  readonly plan: CapturedPlan;
  /** The capture field the requirement was promoted from. */
  readonly sourceId: string;
  /** A retained user instruction, for the acts that rest on one. */
  readonly instructionId: string;
  readonly requirementId: string;
  readonly revisionId: string;
  readonly target: ExpectationRevisionRef;
  readonly project: AuthorityScope;
  readonly artifact: AuthorityScope;
}

/** A requirement revision as authored, without the attribution the writer takes separately. */
export const requirementRevision = (
  requirementId: string,
  sourceId: string,
  change: {
    revisionId?: string;
    previousRevisionId?: string | null;
    statement?: string;
    passages?: { source_id: string; location: string; passage_sha256: string }[];
  } = {}
) => ({
  requirement_id: requirementId,
  revision_id: change.revisionId ?? uuidv7(),
  previous_revision_id: change.previousRevisionId ?? null,
  statement: change.statement ?? 'Local capture works with no Cloud connection.',
  rationale: 'Captures must never depend on network availability.',
  subject: null,
  applicability: { all_of: [] },
  duration: { kind: 'continuing' },
  source_ids: [sourceId],
  passages: change.passages ?? [],
  source_standing: 'explicit_instruction',
  recorded_at: AT,
});

export const BY_OWNER = { kind: 'actor', actor: OWNER } as const;
export const BY_AGENT = { kind: 'actor', actor: AGENT } as const;

/** A retained instruction, which is what an act embedding an instruction cites. */
export async function instructionSource(
  handle: ProjectDatabase,
  text = 'Adopt the offline capture requirement for the project.'
): Promise<string> {
  const bytes = Buffer.from(text);
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'user_instruction',
        retention: { kind: 'bytes', content_sha256: digest(bytes) },
        location: 'session transcript, turn 4',
        source_time: AT,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: AGENT,
    retainedBytes: bytes,
    secretAllow: [],
  });
  return published.value.sourceId;
}

export async function authorityStore(): Promise<AuthorityStore> {
  const { handle, authority } = await knowledgeStore();
  const plan: CapturedPlan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [
      { stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: 'Capture works offline' }] },
    ],
  };
  await capturePlan(handle, plan);
  const criterionId = plan.steps[0]!.criteria[0]!.criterionId;
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'capture_field',
        artifact_id: plan.artifactId,
        event_id: plan.planEventId,
        field_path: 'plan_steps[0].acceptance_criteria[0].text',
        position: 0,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: AGENT,
    secretAllow: [],
  });
  const sourceId = published.value.sourceId;
  const revision = requirementRevision(criterionId, sourceId);
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
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return {
    handle,
    authority,
    plan,
    sourceId,
    instructionId: await instructionSource(handle),
    requirementId: criterionId,
    revisionId: revision.revision_id,
    target: { kind: 'requirement', entity_id: criterionId, revision_id: revision.revision_id },
    project: { kind: 'project', project_id: authority.projectId },
    artifact: { kind: 'artifact', artifact_id: plan.artifactId },
  };
}

/** A second revision of the store's requirement, so an act can point one at the other. */
export async function successorRevision(
  store: Pick<AuthorityStore, 'handle' | 'requirementId' | 'revisionId' | 'sourceId'>,
  statement = 'Local capture and local search work with no Cloud connection.'
): Promise<ExpectationRevisionRef> {
  const revision = requirementRevision(store.requirementId, store.sourceId, {
    previousRevisionId: store.revisionId,
    statement,
  });
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return {
    kind: 'requirement',
    entity_id: store.requirementId,
    revision_id: revision.revision_id,
  };
}

/** A finding that originates in the store's artifact, because its passage is a field of it. */
export async function findingRevision(
  store: Pick<AuthorityStore, 'handle' | 'sourceId'>,
  statement = 'The offline capture smoke test failed on the previous build.'
): Promise<RecordRevisionRef> {
  const claimId = uuidv7();
  const revisionId = uuidv7();
  const passage = {
    source_id: store.sourceId,
    location: 'plan_steps[0].acceptance_criteria[0].text',
    passage_sha256: digest(Buffer.from(statement, 'utf8')),
  };
  await publishProjectContinuingClaimRevision(store.handle, {
    operationId: uuidv7(),
    revision: {
      claim_id: claimId,
      revision_id: revisionId,
      previous_revision_id: null,
      statement,
      subject: null,
      applicability: { all_of: [] },
      source_ids: [store.sourceId],
      passages: [passage],
      source_standing: 'agent_proposal',
      observation_ids: [],
      verification: null,
      recorded_at: AT,
    },
    attributedTo: BY_AGENT,
    occurrence: { source_id: passage.source_id, location: passage.location },
    secretAllow: [],
  });
  return { kind: 'claim', entity_id: claimId, revision_id: revisionId };
}

export async function importClaimWithUnreadableApplicability(
  store: Pick<AuthorityStore, 'handle' | 'sourceId'>,
  statement = 'The retained claim has an applicability shape this reader cannot use.'
): Promise<RecordRevisionRef> {
  const claimId = uuidv7();
  const revisionId = uuidv7();
  const passage = {
    source_id: store.sourceId,
    location: 'imported.claim',
    passage_sha256: digest(Buffer.from(statement, 'utf8')),
  };
  const bytes = Buffer.from(
    canonicalJson({
      claim_id: claimId,
      revision_id: revisionId,
      previous_revision_id: null,
      statement,
      subject: null,
      applicability: { all_of: 'not-an-array' },
      source_ids: [store.sourceId],
      passages: [passage],
      source_standing: 'agent_proposal',
      observation_ids: [],
      verification: null,
      attributed_to: BY_AGENT,
      recorded_at: AT,
    })!
  );
  await runProjectOperation(
    store.handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.claim.revision.imported',
      target: { revisionId },
      payload: { record: digest(bytes) },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      transaction.run(
        `INSERT INTO claim_revisions (revision_id, claim_id, previous_revision_id,
           source_event_id, field_path, position, asserted_by, attributed_kind, attributed_basis,
           source_standing, subject_id, subject_revision_id, assertion_source_json,
           verification_json, verification_provenance, record_bytes, record_sha256, operation_id)
         VALUES (?,?,NULL,?,'imported.claim',0,?,'actor',?,'agent_proposal',NULL,NULL,?,NULL,NULL,?,?,?)`,
        revisionId,
        claimId,
        store.sourceId,
        AGENT.identity,
        AGENT.basis,
        canonicalJson([store.sourceId]),
        bytes,
        digest(bytes),
        settling.operationId
      );
      transaction.run(
        'INSERT INTO claims (claim_id, first_revision_id, operation_id) VALUES (?,?,?)',
        claimId,
        revisionId,
        settling.operationId
      );
      return { revisionId };
    }
  );
  return { kind: 'claim', entity_id: claimId, revision_id: revisionId };
}

/**
 * A relationship row written by hand, as an import or a sync delivers one: no writer of this build
 * publishes a replacement that closes a cycle, and inconsistent history has to stay readable.
 */
export async function importRelationship(
  handle: ProjectDatabase,
  input: { from: RecordRevisionRef; to: RecordRevisionRef; scope: AuthorityScope }
) {
  const relationshipId = uuidv7();
  await runProjectOperation(
    handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.released.relationship',
      target: { relationshipId },
      payload: { relationshipId },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      transaction.run(
        `INSERT INTO record_relationships (relationship_id, relation, from_entity_kind, from_entity_id,
           from_revision_id, to_entity_kind, to_entity_id, to_revision_id, scope_kind, scope_value,
           attributed_kind, attributed_to, attributed_basis, standing, explanation, source_refs_json,
           operation_id)
         VALUES (?,'supersedes',?,?,?,?,?,?,?,?,'author',?,'unknown','established',NULL,'[]',?)`,
        relationshipId,
        input.from.kind,
        input.from.entity_id,
        input.from.revision_id,
        input.to.kind,
        input.to.entity_id,
        input.to.revision_id,
        input.scope.kind,
        input.scope.kind === 'project' ? null : input.scope.artifact_id,
        OWNER.identity,
        settling.operationId
      );
      return { relationshipId };
    }
  );
  return relationshipId;
}

/**
 * A correction row whose payload is JSON and not a contract record, as an import or a build that
 * wrote something else could leave one. No writer here can produce it.
 */
export async function importUnreadableCorrection(
  handle: ProjectDatabase,
  input: { target: RecordRevisionRef }
) {
  const actionId = uuidv7();
  const bytes = Buffer.from(canonicalJson({ action_id: actionId, kind: 'withdrawal' }) as string);
  await runProjectOperation(
    handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.imported.correction',
      target: { actionId },
      payload: { actionId },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      transaction.run(
        `INSERT INTO correction_actions (action_id, action_kind, scope_kind, scope_value, attributed_kind,
           attributed_to, attributed_basis, change_class, changed_what_stands, record_bytes, record_sha256,
           operation_id)
         VALUES (?,'withdrawal','project',NULL,'actor',?,?,'intent_change',1,?,?,?)`,
        actionId,
        OWNER.identity,
        OWNER.basis,
        bytes,
        digest(bytes),
        settling.operationId
      );
      transaction.run(
        `INSERT INTO correction_targets (action_id, position, target_kind, target_id, target_revision_id, operation_id)
         VALUES (?,0,?,?,?,?)`,
        actionId,
        input.target.kind,
        input.target.entity_id,
        input.target.revision_id,
        settling.operationId
      );
      return { actionId };
    }
  );
  return actionId;
}

export const informedBy = (
  instructionId: string,
  acknowledged: readonly ExpectationRevisionRef[],
  scope: AuthorityScope
) =>
  ({
    kind: 'informed_instruction',
    instruction_source_id: instructionId,
    acknowledged: [...acknowledged],
    scope,
  }) as const;

export const instructedBy = (instructionId: string, scope: AuthorityScope) =>
  ({ kind: 'explicit_instruction', instruction_source_id: instructionId, scope }) as const;

export const observing = (
  selectionIds: string[] = [],
  actionIds: string[] = []
): ExpectedState => ({
  kind: 'observed',
  selection_ids: selectionIds,
  correction_action_ids: actionIds,
});

/** A selection as authored, without the actor the writer takes separately. */
export const acceptedSelection = (
  target: ExpectationRevisionRef,
  scope: AuthorityScope,
  authorization: unknown,
  change: {
    selectionId?: string;
    designation?: 'adopted' | 'background';
    expectedState?: ExpectedState;
  } = {}
) => ({
  selection_id: change.selectionId ?? uuidv7(),
  kind: 'accepted' as const,
  target,
  scope,
  designation: change.designation ?? ('adopted' as const),
  authorization,
  expected_state: change.expectedState ?? ({ kind: 'initial' } as ExpectedState),
});

/** A withdrawal of one revision, through the writer that appends a correction. */
export async function withdrawRevision(
  handle: ProjectDatabase,
  input: {
    target: ExpectationRevisionRef;
    scope: AuthorityScope;
    sourceId: string;
    instructionId: string;
    expectedState: ExpectedState;
    actor?: Actor;
  }
) {
  const published = await appendProjectCorrection(handle, {
    operationId: uuidv7(),
    action: {
      action_id: uuidv7(),
      kind: 'withdrawal',
      targets: [input.target],
      scope: input.scope,
      source_id: input.sourceId,
      authorization: informedBy(input.instructionId, [input.target], input.scope),
      expected_state: input.expectedState,
      reason: 'Offline capture is no longer a product promise.',
    },
    attributedTo: { kind: 'actor', actor: input.actor ?? OWNER },
    recordedAt: AT,
    secretAllow: [],
  });
  return published.value.actionId;
}

/**
 * A revocation written as a row, whatever its scope reaches: what a store receives by sync or
 * import, or what a build older than the scope rule wrote.
 */
export async function revokeDirectly(
  handle: ProjectDatabase,
  input: {
    revokes: { kind: 'authorization' | 'exception' | 'conflict_answer' | 'assignment'; id: string };
    scope: AuthorityScope;
    sourceId: string;
  }
) {
  const revocation = {
    revocation_id: uuidv7(),
    revokes: input.revokes,
    scope: input.scope,
    revoked_by: OWNER,
    source_id: input.sourceId,
    instruction: instructedBy(input.sourceId, input.scope),
    recorded_at: AT,
  };
  const bytes = Buffer.from(canonicalJson(revocation) as string);
  await runProjectOperation(
    handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.revocation.append',
      target: { revocationId: revocation.revocation_id },
      payload: { record: digest(bytes) },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      transaction.run(
        `INSERT INTO knowledge_revocations (revocation_id, revoked_kind, revoked_id, scope_kind, scope_value,
           revoked_by, revoked_by_basis, instruction_kind, record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,?,?,?,?,'explicit_instruction',?,?,?)`,
        revocation.revocation_id,
        input.revokes.kind,
        input.revokes.id,
        input.scope.kind,
        input.scope.kind === 'project' ? null : input.scope.artifact_id,
        OWNER.identity,
        OWNER.basis,
        bytes,
        digest(bytes),
        settling.operationId
      );
      return { revocationId: revocation.revocation_id };
    }
  );
  return revocation.revocation_id;
}

/** An established replacement pointing at a revision, through the relationship writer. */
export async function establishReplacement(
  handle: ProjectDatabase,
  input: {
    from: ExpectationRevisionRef;
    to: ExpectationRevisionRef;
    scope: AuthorityScope;
    sourceId: string;
  }
) {
  const published = await publishProjectRelationship(handle, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: uuidv7(),
      relation: 'supersedes',
      from: input.from,
      to: input.to,
      scope: input.scope,
      standing: 'established',
      authorization: informedBy(input.sourceId, [input.to], input.scope),
      source_ids: [input.sourceId],
      explanation: 'The newer revision replaces the older one.',
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  return published.value.relationshipId;
}

/**
 * An adoption scoped to a branch, as a released row carries it: a branch grants no authority, so
 * nothing this store writes could produce one.
 */
export async function adoptOnBranch(
  handle: ProjectDatabase,
  input: { target: ExpectationRevisionRef; branch: string }
) {
  const adoptionId = uuidv7();
  await runProjectOperation(
    handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.released.adoption',
      target: { adoptionId },
      payload: { adoptionId },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      transaction.run(
        `INSERT INTO adoptions (adoption_id, target_kind, target_id, target_revision_id, approver,
           approver_basis, approved_at, scope_kind, scope_value, designation, source_refs_json, operation_id)
         VALUES (?,?,?,?,NULL,'unknown',?,'branch',?,'adopted','[]',?)`,
        adoptionId,
        input.target.kind,
        input.target.entity_id,
        input.target.revision_id,
        AT,
        input.branch,
        settling.operationId
      );
      return { adoptionId };
    }
  );
  return adoptionId;
}
