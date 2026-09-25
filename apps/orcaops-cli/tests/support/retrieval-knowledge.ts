// Continuing records over the retrieval-baseline corpus, published through the public writers.
//
// The corpus is captures and nothing else: no worker ran over it and no record was ever extracted
// from it. What a plan revision DOES record deterministically is its criterion lineage — which
// criterion was rewritten into which, and which was removed — and that is exactly what a
// requirement, a replacing revision and a withdrawal say. So these are published from the criterion
// lineage the capture path itself wrote, and from nothing else: a reworded non-goal and an amended
// summary carry no lineage record, so nothing here invents a relationship for them.
import { createHash } from 'node:crypto';

import { uuidv7 } from '@orcaops/storage';
import {
  type ProjectDatabase,
  publishProjectContinuingDecisionRevision,
  publishProjectKnowledgeSource,
  publishProjectRelationship,
  publishProjectSelection,
} from '@orcaops/storage/history/database';

import type { RetrievalCorpus } from './retrieval-corpus.js';
import type { CorpusEventRef } from '../fixtures/retrieval-corpus/cases.js';
import type { CorpusArtifactKey } from '../fixtures/retrieval-corpus/story.js';
import {
  adoptedRequirement,
  type AdoptedRequirement,
  AT,
  instructionSource,
  OWNER,
  replaceRequirement,
  withdrawRequirement,
} from '../helpers/knowledge-records.js';

const BY_OWNER = { kind: 'actor', actor: OWNER } as const;
const sha256 = (text: string) =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** One requirement the corpus's own criterion lineage supports, and what became of it. */
interface CorpusRule {
  readonly name: string;
  readonly artifact: CorpusArtifactKey;
  /** The event holding the wording an agent still half-remembers. */
  readonly supersededEvent: CorpusEventRef;
  readonly supersededPath: string;
  /** The revision that recorded the lineage, and where its replacing wording sits. */
  readonly standingEvent: CorpusEventRef;
  /** Null for a criterion the revision removed, which is a withdrawal and not a replacement. */
  readonly standingPath: string | null;
}

export const CORPUS_RULES: readonly CorpusRule[] = [
  {
    name: 'upload request ceiling',
    artifact: 'uploadRateLimit',
    supersededEvent: 'plan_captured',
    supersededPath: 'plan_steps.0.acceptance_criteria.0.text',
    standingEvent: 'plan_revised:1',
    standingPath: 'criterion_lineage.rewritten.0.new_text',
  },
  {
    name: 'throttling banner',
    artifact: 'uploadRateLimit',
    supersededEvent: 'plan_captured',
    supersededPath: 'plan_steps.0.acceptance_criteria.1.text',
    standingEvent: 'plan_revised:1',
    standingPath: null,
  },
  {
    name: 'consent per device',
    artifact: 'syncConsent',
    supersededEvent: 'plan_captured',
    supersededPath: 'plan_steps.0.acceptance_criteria.1.text',
    standingEvent: 'plan_revised:1',
    standingPath: 'criterion_lineage.rewritten.0.new_text',
  },
  {
    name: 'declining consent signs out',
    artifact: 'syncConsent',
    supersededEvent: 'plan_captured',
    supersededPath: 'plan_steps.1.acceptance_criteria.1.text',
    standingEvent: 'plan_revised:1',
    standingPath: null,
  },
];

/**
 * The one continuing decision the corpus's plan and its revision both record: one identity whose
 * two revisions were published from two captured events, so a query matching both events returns
 * two hits of the same record.
 */
const CORPUS_DECISION = {
  artifact: 'uploadRateLimit',
  path: 'decisions.0.decision',
  first: { event: 'plan_captured' as CorpusEventRef },
  second: { event: 'plan_revised:1' as CorpusEventRef },
} as const;

export interface PublishedCorpusRule {
  name: string;
  /** `<kind>:<entity id>`, the key a hit names its group by. */
  key: string;
  requirementId: string;
  /** The captured event whose passage the requirement was promoted from. */
  eventId: string;
  supersededWording: string;
  /** The wording that stands now, or null for a requirement the revision withdrew. */
  standingWording: string | null;
}

async function captureFieldSource(
  handle: ProjectDatabase,
  input: { artifactId: string; eventId: string; fieldPath: string }
): Promise<string> {
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'capture_field',
        artifact_id: input.artifactId,
        event_id: input.eventId,
        field_path: input.fieldPath,
        position: 0,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: OWNER,
    secretAllow: [],
  });
  return published.value.sourceId;
}

const recordAt = (
  corpus: RetrievalCorpus,
  artifact: CorpusArtifactKey,
  event: CorpusEventRef,
  path: string
) => corpus.resolve({ artifact, event, path, wording: '' });

const textAt = (
  corpus: RetrievalCorpus,
  artifact: CorpusArtifactKey,
  event: CorpusEventRef,
  path: string
) => recordAt(corpus, artifact, event, path).text;

const passageOf = (sourceId: string, statement: string, location: string) => ({
  source_id: sourceId,
  location,
  passage_sha256: sha256(statement),
});

const decisionRevision = (input: {
  decisionId: string;
  revisionId: string;
  previousRevisionId: string | null;
  approach: string;
  sourceId: string;
  location: string;
}) => ({
  decision_id: input.decisionId,
  revision_id: input.revisionId,
  previous_revision_id: input.previousRevisionId,
  chosen_approach: input.approach,
  rationale: 'Recorded with the plan it was captured in.',
  alternatives: [],
  assumptions: [],
  reconsideration_conditions: [],
  subject: null,
  derivation: null,
  applicability: { all_of: [] },
  source_ids: [input.sourceId],
  passages: [passageOf(input.sourceId, input.approach, input.location)],
  source_standing: 'explicit_instruction' as const,
  recorded_at: AT,
});

export interface PublishedCorpusDecision {
  key: string;
  decisionId: string;
  /** The event each revision was published from, oldest first. */
  events: [string, string];
  wordings: [string, string];
}

/**
 * One continuing decision, its first revision published from the plan event and its second from
 * the revision event, adopted in turn with the established replacement that stops the first.
 */
async function publishCorpusDecision(
  handle: ProjectDatabase,
  corpus: RetrievalCorpus,
  projectId: string
): Promise<PublishedCorpusDecision> {
  const scope = { kind: 'project' as const, project_id: projectId };
  const instructionId = await instructionSource(
    handle,
    'Adopt the plan decisions for the project.'
  );
  const decisionId = uuidv7();
  const published: string[] = [];
  const events: string[] = [];
  const wordings: string[] = [];
  let previousRevisionId: string | null = null;
  let previousSelectionId: string | null = null;
  for (const step of [CORPUS_DECISION.first, CORPUS_DECISION.second]) {
    const record = recordAt(corpus, CORPUS_DECISION.artifact, step.event, CORPUS_DECISION.path);
    const sourceId = await captureFieldSource(handle, {
      artifactId: record.artifactId,
      eventId: record.eventId,
      fieldPath: CORPUS_DECISION.path,
    });
    const revisionId = uuidv7();
    await publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: decisionRevision({
        decisionId,
        revisionId,
        previousRevisionId,
        approach: record.text,
        sourceId,
        location: CORPUS_DECISION.path,
      }),
      attributedTo: BY_OWNER,
      occurrence: { source_id: sourceId, location: CORPUS_DECISION.path },
      secretAllow: [],
    });
    const target = { kind: 'decision' as const, entity_id: decisionId, revision_id: revisionId };
    const selectionId = uuidv7();
    await publishProjectSelection(handle, {
      operationId: uuidv7(),
      selection: {
        selection_id: selectionId,
        kind: 'accepted',
        target,
        scope,
        designation: 'adopted',
        authorization:
          previousRevisionId === null
            ? { kind: 'explicit_instruction', instruction_source_id: instructionId, scope }
            : {
                kind: 'informed_instruction',
                instruction_source_id: instructionId,
                acknowledged: [
                  {
                    kind: 'decision' as const,
                    entity_id: decisionId,
                    revision_id: previousRevisionId,
                  },
                ],
                scope,
              },
        expected_state:
          previousSelectionId === null
            ? { kind: 'initial' }
            : {
                kind: 'observed',
                selection_ids: [previousSelectionId],
                correction_action_ids: [],
              },
      },
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    });
    if (previousRevisionId !== null)
      await publishProjectRelationship(handle, {
        operationId: uuidv7(),
        relationship: {
          relationship_id: uuidv7(),
          relation: 'supersedes',
          from: target,
          to: { kind: 'decision' as const, entity_id: decisionId, revision_id: previousRevisionId },
          scope,
          standing: 'established',
          authorization: {
            kind: 'informed_instruction',
            instruction_source_id: instructionId,
            acknowledged: [
              { kind: 'decision' as const, entity_id: decisionId, revision_id: previousRevisionId },
            ],
            scope,
          },
          source_ids: [instructionId],
          explanation: 'The revised plan replaces the decision the original plan recorded.',
        },
        attributedTo: BY_OWNER,
        recordedAt: AT,
        secretAllow: [],
      });
    published.push(revisionId);
    events.push(record.eventId);
    wordings.push(record.text);
    previousRevisionId = revisionId;
    previousSelectionId = selectionId;
  }
  return {
    key: `decision:${decisionId}`,
    decisionId,
    events: [events[0]!, events[1]!],
    wordings: [wordings[0]!, wordings[1]!],
  };
}

/**
 * Publishes one continuing requirement per rule into the corpus's own project database, adopted for
 * the project, and then either replaced by the wording the revision rewrote it into or withdrawn
 * where the revision removed it.
 */
export interface PublishedCorpusKnowledge {
  rules: PublishedCorpusRule[];
  decision: PublishedCorpusDecision;
}

export async function publishCorpusKnowledge(
  corpus: RetrievalCorpus
): Promise<PublishedCorpusKnowledge> {
  const handle = await corpus.openDatabase('writer');
  const projectId = handle.authority.projectId;
  try {
    const published: PublishedCorpusRule[] = [];
    for (const rule of CORPUS_RULES) {
      const superseded = corpus.resolve({
        artifact: rule.artifact,
        event: rule.supersededEvent,
        path: rule.supersededPath,
        wording: '',
      });
      const sourceId = await captureFieldSource(handle, {
        artifactId: superseded.artifactId,
        eventId: superseded.eventId,
        fieldPath: rule.supersededPath,
      });
      const adopted: AdoptedRequirement = await adoptedRequirement(handle, {
        projectId,
        statement: superseded.text,
        promotedFrom: { sourceId, location: rule.supersededPath },
      });
      const standingWording =
        rule.standingPath === null
          ? null
          : textAt(corpus, rule.artifact, rule.standingEvent, rule.standingPath);
      if (standingWording === null)
        await withdrawRequirement(handle, {
          projectId,
          adopted,
          revisionId: adopted.revisionId,
          selectionId: adopted.selectionId,
        });
      else await replaceRequirement(handle, { projectId, adopted, statement: standingWording });
      published.push({
        name: rule.name,
        key: `requirement:${adopted.requirementId}`,
        requirementId: adopted.requirementId,
        eventId: superseded.eventId,
        supersededWording: superseded.text,
        standingWording,
      });
    }
    return { rules: published, decision: await publishCorpusDecision(handle, corpus, projectId) };
  } finally {
    handle.close();
  }
}
