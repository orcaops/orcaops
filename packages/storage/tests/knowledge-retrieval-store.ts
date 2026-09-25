// A real project database holding one source and every way a record can be related to it: a task
// use of the plan it was captured under, records promoted from a passage of its own event, records
// promoted from another event of the same artifact, a record in another artifact whose captured
// text shares the source's words, a record behind an access-restricted source, and a record
// published after the boundary the source is read at.
//
// Each step records the write sequence it committed at, so a read at the recorded boundary sees
// exactly what stood then and a read at now sees the later record too.
import {
  acceptedSelection,
  AT,
  BY_OWNER,
  establishReplacement,
  instructedBy,
  instructionSource,
  requirementRevision,
} from './knowledge-authority-store.js';
import {
  AGENT,
  captureCheckpoint,
  type CapturedPlan,
  captureFieldSource,
  capturePlan,
  counters,
  knowledgeStore,
  OWNER,
} from './knowledge-store.js';
import { canonicalJson } from '../src/events/canonical-json.js';
import {
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
} from '../src/history/database/connection.js';
import { publishProjectContinuingDecisionRevision } from '../src/history/database/knowledge-decisions.js';
import {
  createProjectRequirement,
  publishProjectRequirementRevision,
} from '../src/history/database/knowledge-requirements.js';
import { publishProjectPassageRestatement } from '../src/history/database/knowledge-restatements.js';
import { publishProjectSelection } from '../src/history/database/knowledge-selections.js';
import { publishProjectKnowledgeSource } from '../src/history/database/knowledge-sources.js';
import { recordProjectTaskUses } from '../src/history/database/knowledge-task-uses.js';
import { runProjectOperation } from '../src/history/database/transactions.js';
import { digest } from '../src/history/event-integrity.js';
import { uuidv7 } from '../src/ids/uuidv7.js';
import type { AuthorityScope, ExpectationRevisionRef } from '../src/schema/knowledge-contract.js';

/** The distinctive word the source and the other artifact's captured plan both use. */
export const SHARED_TERM = 'telemetry';

export const OFFLINE_RULE = 'Inspection notes survive a device restart without being re-entered.';
export const FLUSH_RULE = 'Notes are flushed to disk before the screen reports them saved.';
export const STORAGE_APPROACH = 'Store queued notes in one SQLite file per device.';
export const CONFIDENTIAL_RULE = 'Uploads carry the technician identifier.';
/** A second criterion of the same plan, worded so that no term of the source reaches it. */
export const UNREACHED_RULE = 'Every note keeps the identifier of the device that wrote it.';
/** The second step's criterion, which nothing here promotes. */
const LOGGING_RULE = 'Nightly builds publish their logs to the shared folder.';
export const LATE_RULE = 'A cancelled upload leaves the note in the queue.';
export const OTHER_ARTIFACT_RULE =
  'The telemetry batch is uploaded only when the technician consents.';

/** The text of the source retrieval is taken for: it names the shared term once. */
export const SOURCE_TEXT =
  'Checkpoint summary\n\nThe queue drains after a restart, and the telemetry batch waits for consent.\n';

export interface RetrievalStore {
  readonly handle: ProjectDatabase;
  readonly authority: ProjectDatabaseAuthority;
  readonly project: AuthorityScope;
  readonly artifact: AuthorityScope;
  readonly plan: CapturedPlan;
  readonly otherPlan: CapturedPlan;
  /** The event the source being interpreted belongs to. */
  readonly sourceEventId: string;
  /** Reached through the task uses of the plan event. */
  readonly planCriterion: ExpectationRevisionRef;
  /** Reached through a passage of the source's own event. */
  readonly offline: ExpectationRevisionRef;
  /** A revision of `offline` whose record states nothing this store can read. */
  readonly offlineWithoutStatement: string;
  /** Reached through a passage of another event of the same artifact. */
  readonly storage: ExpectationRevisionRef;
  /** Reached through the search over the other artifact's captured plan. */
  readonly otherArtifact: ExpectationRevisionRef;
  /** Behind an access-restricted source, so no route reaches it. */
  readonly confidential: ExpectationRevisionRef;
  readonly restriction: string;
  /** Adopted before the boundary and reached by no route, until a later act names it. */
  readonly unreached: ExpectationRevisionRef;
  /** A source of the plan event that nothing cites at the boundary. */
  readonly unreachedSourceId: string;
  /** Published after `boundary`, so a read there does not see it. */
  readonly late: ExpectationRevisionRef;
  /** The write sequence the source is read at: everything but `late` is committed. */
  readonly boundary: number;
  /** The retained instruction every act in this store rests on. */
  readonly instructionId: string;
  /** The worktree the artifact's capture events are appended under. */
  readonly worktreeId: string;
}

/**
 * A requirement revision whose record states nothing this store can read, as an import or a build
 * older than the contract's statement field can leave one. Every lookup column is well formed and
 * the payload carries the applicability the resolver reads, so the resolver names the revision and
 * only its wording is missing.
 */
async function revisionWithoutStatement(
  handle: ProjectDatabase,
  requirement: ExpectationRevisionRef,
  sourceId: string
): Promise<string> {
  const revisionId = uuidv7();
  const bytes = Buffer.from(
    canonicalJson({
      applicability: { all_of: [] },
      revision_id: revisionId,
      source_ids: [sourceId],
      passages: [],
    }) as string
  );
  await runProjectOperation(
    handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.requirement.revision.imported',
      target: { revisionId },
      payload: { record: digest(bytes) },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      transaction.run(
        `INSERT INTO requirement_revisions (revision_id, requirement_id, previous_revision_id,
           source_standing, duration_kind, attributed_kind, attributed_to, attributed_basis,
           record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,'explicit_instruction','continuing','actor',?,?,?,?,?)`,
        revisionId,
        requirement.entity_id,
        requirement.revision_id,
        OWNER.identity,
        OWNER.basis,
        bytes,
        digest(bytes),
        settling.operationId
      );
      return { revisionId };
    }
  );
  return revisionId;
}

const passageOf = (sourceId: string, statement: string, location: string) => ({
  source_id: sourceId,
  location,
  passage_sha256: digest(Buffer.from(statement, 'utf8')),
});

export async function restrictedFieldSource(
  handle: ProjectDatabase,
  artifactId: string,
  eventId: string,
  restriction: string,
  position = 0
): Promise<string> {
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'capture_field',
        artifact_id: artifactId,
        event_id: eventId,
        field_path: 'uncertainty[0]',
        position,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: restriction,
    },
    recordedBy: AGENT,
    secretAllow: [],
  });
  return published.value.sourceId;
}

async function promoteRequirement(
  handle: ProjectDatabase,
  input: { sourceId: string; statement: string; location: string }
): Promise<ExpectationRevisionRef> {
  const requirementId = uuidv7();
  const revision = requirementRevision(requirementId, input.sourceId, {
    statement: input.statement,
    passages: [passageOf(input.sourceId, input.statement, input.location)],
  });
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: requirementId,
      origin: {
        kind: 'promoted_source',
        passage: passageOf(input.sourceId, input.statement, input.location),
        promoted_at: AT,
      },
    },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return { kind: 'requirement', entity_id: requirementId, revision_id: revision.revision_id };
}

async function publishDecision(
  handle: ProjectDatabase,
  input: { sourceId: string; approach: string; location: string }
): Promise<ExpectationRevisionRef> {
  const decisionId = uuidv7();
  const revisionId = uuidv7();
  await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    revision: {
      decision_id: decisionId,
      revision_id: revisionId,
      previous_revision_id: null,
      chosen_approach: input.approach,
      rationale: 'One file makes the flush and the restore one atomic operation.',
      alternatives: [],
      assumptions: [],
      reconsideration_conditions: [],
      subject: null,
      derivation: null,
      applicability: { all_of: [] },
      source_ids: [input.sourceId],
      passages: [passageOf(input.sourceId, input.approach, input.location)],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    occurrence: { source_id: input.sourceId, location: input.location },
    secretAllow: [],
  });
  return { kind: 'decision', entity_id: decisionId, revision_id: revisionId };
}

async function adopt(
  handle: ProjectDatabase,
  target: ExpectationRevisionRef,
  scope: AuthorityScope,
  instructionId: string
): Promise<void> {
  await publishProjectSelection(handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(target, scope, instructedBy(instructionId, scope)),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
}

export async function retrievalStore(): Promise<RetrievalStore> {
  const { handle, authority } = await knowledgeStore();
  const project: AuthorityScope = { kind: 'project', project_id: authority.projectId };

  const plan: CapturedPlan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [
      {
        stepId: uuidv7(),
        criteria: [
          { criterionId: uuidv7(), text: FLUSH_RULE },
          { criterionId: uuidv7(), text: UNREACHED_RULE },
        ],
      },
      // A second step, so a second checkpoint of this artifact has one of its own to declare.
      { stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: LOGGING_RULE }] },
    ],
    task: 'Drain the upload queue after a restart',
  };
  const { worktreeId } = await capturePlan(handle, plan);
  const sourceEventId = await captureCheckpoint(handle, plan, worktreeId);

  const otherPlan: CapturedPlan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: OTHER_ARTIFACT_RULE }] }],
    task: `Ask before the ${SHARED_TERM} upload`,
  };
  await capturePlan(handle, otherPlan);

  const instructionId = await instructionSource(handle);

  // The criterion of this artifact's plan, promoted as the requirement it is and used by the task.
  const criterionId = plan.steps[0]!.criteria[0]!.criterionId;
  const planCriterionRevision = requirementRevision(
    criterionId,
    await captureFieldSource(handle, plan),
    { statement: FLUSH_RULE }
  );
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
    revision: planCriterionRevision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const planCriterion: ExpectationRevisionRef = {
    kind: 'requirement',
    entity_id: criterionId,
    revision_id: planCriterionRevision.revision_id,
  };
  await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [
      {
        artifact_id: plan.artifactId,
        plan_event_id: plan.planEventId,
        target: planCriterion,
        role: 'preserve',
        local: null,
        exception_id: null,
      },
    ],
    discovery: { discovered_at: AT, discovered_by: BY_OWNER },
    secretAllow: [],
  });

  const offlineSourceId = await captureFieldSource(
    handle,
    { artifactId: plan.artifactId, planEventId: sourceEventId },
    'summary',
    0
  );
  const offline = await promoteRequirement(handle, {
    sourceId: offlineSourceId,
    statement: OFFLINE_RULE,
    location: 'bytes:0-63',
  });

  const offlineWithoutStatement = await revisionWithoutStatement(handle, offline, offlineSourceId);

  const storage = await publishDecision(handle, {
    sourceId: await captureFieldSource(
      handle,
      plan,
      'plan_steps[0].acceptance_criteria[0].text',
      1
    ),
    approach: STORAGE_APPROACH,
    location: 'bytes:0-45',
  });

  const otherArtifact = await promoteRequirement(handle, {
    sourceId: await captureFieldSource(
      handle,
      otherPlan,
      'plan_steps[0].acceptance_criteria[0].text',
      0
    ),
    statement: OTHER_ARTIFACT_RULE,
    location: 'bytes:0-60',
  });

  // A retained source of the plan event, which this read follows and no record cites yet.
  const unreachedSourceId = await captureFieldSource(
    handle,
    plan,
    'plan_steps[0].acceptance_criteria[1].text',
    0
  );

  const restriction = 'customer-confidential';
  const confidential = await promoteRequirement(handle, {
    sourceId: await restrictedFieldSource(handle, plan.artifactId, sourceEventId, restriction),
    statement: CONFIDENTIAL_RULE,
    location: 'bytes:0-40',
  });

  // The plan's second criterion: promoted as the requirement it is, so no lookup column leads to
  // it, adopted, and used by no task. Nothing this source says reaches it.
  const unreachedId = plan.steps[0]!.criteria[1]!.criterionId;
  const unreachedRevision = requirementRevision(unreachedId, unreachedSourceId, {
    statement: UNREACHED_RULE,
  });
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: unreachedId,
      origin: {
        kind: 'promoted_criterion',
        criterion: {
          artifact_id: plan.artifactId,
          plan_event_id: plan.planEventId,
          criterion_id: unreachedId,
        },
      },
    },
    revision: unreachedRevision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const unreached: ExpectationRevisionRef = {
    kind: 'requirement',
    entity_id: unreachedId,
    revision_id: unreachedRevision.revision_id,
  };

  for (const target of [planCriterion, offline, storage, otherArtifact, confidential, unreached])
    await adopt(handle, target, project, instructionId);

  const boundary = counters(handle).writeSequence;

  const late = await promoteRequirement(handle, {
    sourceId: await captureFieldSource(
      handle,
      { artifactId: plan.artifactId, planEventId: sourceEventId },
      'summary',
      1
    ),
    statement: LATE_RULE,
    location: 'bytes:64-105',
  });
  await adopt(handle, late, project, instructionId);

  return {
    handle,
    authority,
    project,
    artifact: { kind: 'artifact', artifact_id: plan.artifactId },
    plan,
    otherPlan,
    sourceEventId,
    planCriterion,
    offline,
    offlineWithoutStatement,
    storage,
    otherArtifact,
    confidential,
    restriction,
    unreached,
    unreachedSourceId,
    late,
    boundary,
    instructionId,
    worktreeId,
  };
}

/**
 * One later act of every kind this build can publish on identities the store already holds: a
 * retained source of the source's own event, a restatement pointing an earlier requirement at it, a
 * revision of that requirement, and a relationship over the two revisions. An answer already given
 * at `boundary` must carry none of them.
 */
export async function laterActsOfEveryKind(store: RetrievalStore): Promise<void> {
  const sourceId = await captureFieldSource(store.handle, store.plan);
  await restateThroughSource(store, sourceId, store.planCriterion, FLUSH_RULE);
  const successor = requirementRevision(store.planCriterion.entity_id, sourceId, {
    previousRevisionId: store.planCriterion.revision_id,
    statement: 'Notes are flushed to disk and fsynced before the screen reports them saved.',
  });
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision: successor,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  await establishReplacement(store.handle, {
    from: {
      kind: 'requirement',
      entity_id: store.planCriterion.entity_id,
      revision_id: successor.revision_id,
    },
    to: store.planCriterion,
    scope: store.project,
    sourceId: store.instructionId,
  });
}

/**
 * A restatement saying that a passage of one retained source states, word for word, what a revision
 * states. The source's own text has to hold the statement, so the passage is always a field of the
 * capture event the statement was written in.
 */
export async function restateThroughSource(
  store: Pick<RetrievalStore, 'handle'>,
  sourceId: string,
  restates: ExpectationRevisionRef,
  statement: string
): Promise<void> {
  await publishProjectPassageRestatement(store.handle, {
    operationId: uuidv7(),
    restatement: {
      restatement_id: uuidv7(),
      passage: passageOf(sourceId, statement, `restated:${statement.length}`),
      restates,
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
}
