// A real project database holding what a consequence answer has to traverse: an adopted
// requirement, a decision that depends on it and records an assumption naming it, a suggested
// dependency a detector wrote, a second requirement about the same subject, an assessment of the
// requirement, and code the captured artifact recorded a touch of.
//
// Everything rests on its own writer except the touched-file rows, which are a derived index the
// capture path rebuilds and no knowledge writer owns.
import {
  acceptedSelection,
  AT,
  type AuthorityStore,
  authorityStore,
  BY_OWNER,
  instructedBy,
} from './knowledge-authority-store.js';
import { agentReportedObservation, counters, OWNER } from './knowledge-store.js';
import { type ProjectDatabase } from '../src/history/database/connection.js';
import { publishProjectKnowledgeAssessment } from '../src/history/database/knowledge-assessments.js';
import { publishProjectContinuingDecisionRevision } from '../src/history/database/knowledge-decisions.js';
import { publishProjectRelationship } from '../src/history/database/knowledge-relationships.js';
import {
  createProjectRequirement,
  publishProjectRequirementRevision,
} from '../src/history/database/knowledge-requirements.js';
import { publishProjectSelection } from '../src/history/database/knowledge-selections.js';
import { publishProjectSubject } from '../src/history/database/knowledge-subjects.js';
import { runProjectOperation } from '../src/history/database/transactions.js';
import { uuidv7 } from '../src/ids/uuidv7.js';
import type { ExpectationRevisionRef } from '../src/schema/knowledge-contract.js';

export const TOUCHED_FILE = 'packages/sync/src/queue.ts';
export const OTHER_TOUCHED_FILE = 'packages/sync/src/retry.ts';

export interface ConsequenceStore {
  readonly store: AuthorityStore;
  readonly handle: ProjectDatabase;
  /** The adopted requirement the change is about, which `authorityStore` already published. */
  readonly requirement: ExpectationRevisionRef;
  /** A decision that depends on the requirement and records an assumption naming it. */
  readonly decision: ExpectationRevisionRef;
  /** A requirement whose revision names the same subject as the requirement above. */
  readonly sibling: ExpectationRevisionRef;
  readonly subjectId: string;
  readonly dependencyId: string;
  readonly suggestedDependencyId: string;
  readonly assessmentId: string;
  /** The write sequence each step committed at. */
  readonly boundaries: {
    readonly adopted: number;
    readonly linked: number;
    readonly assessed: number;
  };
}

/** Touched-file rows as the capture path's derived index holds them. */
async function recordTouchedFiles(
  handle: ProjectDatabase,
  artifactId: string,
  files: readonly string[]
): Promise<void> {
  await runProjectOperation(
    handle,
    {
      operationId: uuidv7(),
      kind: 'history.query.metadata.rebuild',
      target: { artifactId },
      payload: { files: [...files] },
      expectedState: null,
      intentChange: false,
    },
    (transaction) => {
      for (const file of files)
        transaction.run(
          'INSERT INTO artifact_touched_files (artifact_id, file_path) VALUES (?,?)',
          artifactId,
          file
        );
      return { artifactId };
    }
  );
}

export async function consequenceStore(): Promise<ConsequenceStore> {
  const store = await authorityStore();
  const { handle, project } = store;
  await publishProjectSelection(handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(store.target, project, instructedBy(store.instructionId, project)),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const adopted = counters(handle).writeSequence;

  const subjectId = uuidv7();
  const subjectRevisionId = uuidv7();
  await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision: {
      subject_id: subjectId,
      revision_id: subjectRevisionId,
      previous_revision_id: null,
      label: 'offline capture',
      kind: 'capability',
      description: 'What the product does with no network.',
      source_ids: [store.sourceId],
      recorded_at: AT,
    },
    authoredBy: OWNER,
    secretAllow: [],
  });
  const subject = { subject_id: subjectId, subject_revision_id: subjectRevisionId };

  const siblingId = uuidv7();
  const siblingRevisionId = uuidv7();
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: siblingId,
      origin: { kind: 'authored', source_id: store.sourceId },
    },
    revision: {
      requirement_id: siblingId,
      revision_id: siblingRevisionId,
      previous_revision_id: null,
      statement: 'A report can be exported with no Cloud connection.',
      rationale: 'Field work happens where there is no signal.',
      subject,
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [store.sourceId],
      passages: [],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  // The requirement the change is about gets a revision naming the same subject, which is the
  // only way a subject question reaches the sibling.
  const subjectRevision = {
    requirement_id: store.requirementId,
    revision_id: uuidv7(),
    previous_revision_id: store.revisionId,
    statement: 'Local capture works with no Cloud connection, and says when it cannot reach one.',
    rationale: 'Captures must never depend on network availability.',
    subject,
    applicability: { all_of: [] },
    duration: { kind: 'continuing' as const },
    source_ids: [store.sourceId],
    passages: [],
    source_standing: 'explicit_instruction' as const,
    recorded_at: AT,
  };
  await publishProjectRequirementRevision(handle, {
    operationId: uuidv7(),
    revision: subjectRevision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });

  const decisionId = uuidv7();
  const decisionRevisionId = uuidv7();
  await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    revision: {
      decision_id: decisionId,
      revision_id: decisionRevisionId,
      previous_revision_id: null,
      chosen_approach: 'Hold unsent captures in a local queue.',
      rationale: 'A capture must survive a machine with no network.',
      alternatives: [{ option: 'Fail the capture', rejected_because: 'It loses the work' }],
      assumptions: [`Assumes ${store.requirementId} still stands.`],
      reconsideration_conditions: [`Reconsider if ${store.requirementId} is withdrawn.`],
      subject: null,
      applicability: { all_of: [] },
      source_ids: [store.sourceId],
      passages: [
        {
          source_id: store.sourceId,
          location: 'plan_steps[0].acceptance_criteria[0].text',
          passage_sha256: 'c'.repeat(64),
        },
      ],
      source_standing: 'explicit_instruction',
      derivation: null,
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    occurrence: {
      source_id: store.sourceId,
      location: 'plan_steps[0].acceptance_criteria[0].text',
    },
    secretAllow: [],
  });
  const decision: ExpectationRevisionRef = {
    kind: 'decision',
    entity_id: decisionId,
    revision_id: decisionRevisionId,
  };

  const dependencyId = uuidv7();
  await publishProjectRelationship(handle, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: dependencyId,
      relation: 'depends_on',
      from: decision,
      to: store.target,
      scope: project,
      standing: 'established',
      authorization: null,
      source_ids: [store.sourceId],
      explanation: 'The queue exists because capture must work offline.',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const suggestedDependencyId = uuidv7();
  await publishProjectRelationship(handle, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: suggestedDependencyId,
      relation: 'motivates',
      from: store.target,
      to: {
        kind: 'requirement',
        entity_id: siblingId,
        revision_id: siblingRevisionId,
      },
      scope: project,
      standing: 'suggested',
      authorization: null,
      source_ids: [store.sourceId],
      explanation: 'Proposed by background processing.',
    },
    attributedTo: { kind: 'detector', detector: 'knowledge-processor' },
    secretAllow: [],
  });
  const linked = counters(handle).writeSequence;

  const observationId = await agentReportedObservation(handle, store.sourceId);
  const before = counters(handle);
  const assessmentId = uuidv7();
  await publishProjectKnowledgeAssessment(handle, {
    operationId: uuidv7(),
    assessment: {
      assessment_id: assessmentId,
      expectations: [store.target],
      exception_ids: [],
      implementation: {
        kind: 'selected',
        inputs: [
          { kind: 'release', identity: '0.2.1' },
          { kind: 'file', identity: TOUCHED_FILE },
        ],
        environment: 'macOS 15.3 arm64',
      },
      evidence: [
        {
          source: { kind: 'observation', observation_id: observationId },
          role: 'supports',
          limitations: 'the smoke suite only, on one platform',
        },
      ],
      method: { name: 'release review', configuration_sha256: null },
      conclusions: [
        {
          expectation: store.target,
          conclusion: 'supported',
          reason: 'Capture completed with the network down.',
        },
      ],
      check_states: [],
      coverage_limits: [],
      observed_write_sequence: before.writeSequence,
      observed_intent_counter: before.intentChangeCounter,
    },
    assessedBy: OWNER,
    secretAllow: [],
  });
  await recordTouchedFiles(handle, store.plan.artifactId, [TOUCHED_FILE, OTHER_TOUCHED_FILE]);
  const assessed = counters(handle).writeSequence;

  return {
    store,
    handle,
    requirement: store.target,
    decision,
    sibling: {
      kind: 'requirement',
      entity_id: siblingId,
      revision_id: siblingRevisionId,
    },
    subjectId,
    dependencyId,
    suggestedDependencyId,
    assessmentId,
    boundaries: { adopted, linked, assessed },
  };
}
