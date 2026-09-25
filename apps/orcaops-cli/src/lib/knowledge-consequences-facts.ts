// The rows one consequence traversal is given, read inside one snapshot at one boundary.
//
// The traversal itself is pure, so somebody has to read what it walks. This does that and nothing
// else: it writes nothing, opens nothing for writing, starts no worker and calls no model. It
// reaches new identities in rounds — a round per link the bounds allow — so every identity the
// walk can reach has been read under THIS request rather than reported as an identity this store
// holds no record of, which is a different and much worse answer.
import {
  type ConsequenceAssessmentFact,
  type ConsequenceAssumptionFact,
  type ConsequenceBounds,
  type ConsequenceChange,
  type ConsequenceCodeAssociationFact,
  type ConsequenceFacts,
  type ConsequenceLimit,
  type ConsequencePlanEventFact,
  type ConsequenceRelationshipFact,
  type ConsequenceSubjectFact,
  type KnowledgeContextAnswer,
  knowledgeContextAnswer,
  type KnowledgeProcessingCoverage,
} from '@orcaops/core';
import type {
  AuthorityScope,
  ExpectationRevisionRef,
  KnowledgeTarget,
  RecordRevisionRef,
} from '@orcaops/storage';
import {
  knowledgeReadRequest,
  projectKnowledgeContext,
  type ProjectReadView,
  readProjectArtifactsTouching,
  readProjectAssessmentsNaming,
  readProjectAssumptionsNaming,
  readProjectFilesTouchedBy,
  readProjectIdentitiesSharingSubject,
  readProjectPlanEventsOf,
  readProjectRelationshipsOfIdentity,
  readProjectTaskUsesAtBoundary,
} from '@orcaops/storage/history/database';

/** Enough for a page of statements; the identity cap is what a person's `--limit` moves. */
const MAX_STATEMENT_BYTES = 65_536;

/** How many artifacts' recorded files one answer reads, which each cost an indexed seek. */
const ARTIFACT_BUDGET = 200;

export interface ConsequenceFactsRequest {
  readonly projectId: string;
  readonly scope: AuthorityScope;
  /** A write sequence, or `now`. Never defaulted here: the caller names the question it asked. */
  readonly boundary: number | 'now';
  readonly mode: 'current' | 'historical';
  readonly change: ConsequenceChange;
  readonly bounds: ConsequenceBounds;
  readonly processing: KnowledgeProcessingCoverage | null;
}

const identityKey = (target: KnowledgeTarget) => `${target.kind}:${target.entity_id}`;

const EXPECTATION_KINDS = new Set(['requirement', 'decision']);

export function readConsequenceFacts(
  view: ProjectReadView,
  input: ConsequenceFactsRequest
): ConsequenceFacts {
  const request = knowledgeReadRequest(view, {
    scope: input.scope,
    mode: input.mode,
    boundary: input.boundary,
  });
  const limits: ConsequenceLimit[] = [];
  const answers: KnowledgeContextAnswer[] = [];
  const relationships: ConsequenceRelationshipFact[] = [];
  const assessments: ConsequenceAssessmentFact[] = [];
  const codeAssociations: ConsequenceCodeAssociationFact[] = [];
  const subjects: ConsequenceSubjectFact[] = [];
  const planEvents: ConsequencePlanEventFact[] = [];
  const artifacts = new Set<string>();
  const decisionRevisionIds = new Set<string>();
  // What a recorded assumption may name, and the identity each name belongs to: an entity id for
  // every identity this read reached, and the exact revision id of the change itself.
  const namedTo = new Map<string, KnowledgeTarget>();

  const fileInputs: { kind: 'file'; identity: string }[] = [];
  let frontier: KnowledgeTarget[] = [];
  if (input.change.kind === 'implementation') {
    for (const path of [...new Set(input.change.paths)].sort()) {
      fileInputs.push({ kind: 'file', identity: path });
      const found = readProjectArtifactsTouching(view, path);
      limits.push(...found.limits);
      for (const association of found.associations) {
        codeAssociations.push({
          artifact_id: association.artifactId,
          file_path: association.filePath,
          asked: association.asked,
          recorded_touch: association.recordedTouch,
        });
        artifacts.add(association.artifactId);
      }
    }
    for (const event of readProjectPlanEventsOf(view, [...artifacts])) {
      planEvents.push({ artifact_id: event.artifactId, plan_event_id: event.planEventId });
      const uses = readProjectTaskUsesAtBoundary(view, event.planEventId, input.projectId, request);
      for (const use of [...uses.selectedWithPlan, ...uses.connectedLater])
        frontier.push({
          kind: use.use.target.kind as KnowledgeTarget['kind'],
          entity_id: use.use.target.entityId,
        });
    }
  } else {
    const { identity, revision_id: revisionId } = input.change;
    if (revisionId !== null) namedTo.set(revisionId, identity);
    frontier = [identity];
  }

  const read = new Set<string>();
  let beyondBudget = 0;
  for (let round = 0; round <= input.bounds.maxDepth && frontier.length > 0; round += 1) {
    const targets: KnowledgeTarget[] = [];
    for (const target of frontier) {
      const key = identityKey(target);
      if (read.has(key)) continue;
      if (read.size + targets.length >= input.bounds.maxItems) {
        beyondBudget += 1;
        continue;
      }
      targets.push(target);
    }
    if (targets.length === 0) break;
    for (const target of targets) {
      read.add(identityKey(target));
      namedTo.set(target.entity_id, target);
    }
    const answer = knowledgeContextAnswer(
      projectKnowledgeContext(view, {
        projectId: input.projectId,
        scope: input.scope,
        boundary: request.knowledge_boundary,
        mode: input.mode,
        subject: { kind: 'identities', targets },
      }),
      input.processing,
      { maxEntries: input.bounds.maxItems, maxStatementBytes: MAX_STATEMENT_BYTES }
    );
    answers.push(answer);
    const revisions: RecordRevisionRef[] = [];
    for (const entry of answer.entries) {
      for (const revision of entry.revisions) {
        revisions.push(revision.revision);
        if (revision.revision.kind === 'decision')
          decisionRevisionIds.add(revision.revision.revision_id);
      }
      for (const use of [...entry.selected_with_plan, ...entry.connected_later])
        artifacts.add(use.artifact_id);
    }

    const next: KnowledgeTarget[] = [];
    for (const target of targets) {
      const found = readProjectRelationshipsOfIdentity(view, target, request);
      if (found.later > 0)
        limits.push({
          kind: 'later_than_boundary',
          detail:
            `${found.later} relationship row(s) naming ${identityKey(target)} were published ` +
            `after write sequence ${request.knowledge_boundary} and were not followed.`,
        });
      for (const relationship of [...found.established, ...found.suggested]) {
        relationships.push({
          relationship_id: relationship.relationshipId,
          relation: relationship.relation,
          standing: relationship.standing,
          from: relationship.from,
          to: relationship.to,
          explanation: relationship.explanation,
          attributed_to: {
            kind: relationship.attributedTo.kind,
            name: relationship.attributedTo.identity,
            basis: relationship.attributedTo.basis,
          },
        });
        for (const end of [relationship.from, relationship.to])
          next.push({ kind: end.kind, entity_id: end.entity_id });
      }
    }
    const near = readProjectIdentitiesSharingSubject(view, revisions);
    limits.push(...near.limits);
    for (const neighbour of near.neighbours) {
      subjects.push({
        subject_id: neighbour.subjectId,
        of: neighbour.of,
        identity: neighbour.identity,
      });
      next.push(neighbour.identity);
    }
    const weighed = readProjectAssessmentsNaming(
      view,
      {
        expectations: revisions.filter((revision): revision is ExpectationRevisionRef =>
          EXPECTATION_KINDS.has(revision.kind)
        ),
        // A file input is a question about the code, so it is asked once rather than again for
        // every identity a later round reaches.
        inputs: round === 0 ? fileInputs : [],
      },
      request
    );
    limits.push(...weighed.limits);
    if (weighed.later.length > 0)
      limits.push({
        kind: 'later_than_boundary',
        detail:
          `${weighed.later.length} assessment(s) naming what this change reaches were published ` +
          `after write sequence ${request.knowledge_boundary} and were not followed.`,
      });
    for (const entry of weighed.assessments)
      assessments.push({
        assessment_id: entry.assessment.assessmentId,
        assessed_by: {
          kind: 'actor',
          name: entry.assessment.assessedBy,
          basis: entry.assessment.assessedByBasis,
        },
        expectation: entry.expectation,
        conclusion: entry.conclusion,
        selected_inputs:
          entry.assessment.implementation.kind === 'selected'
            ? entry.assessment.implementation.inputs
            : [],
      });
    frontier = next;
  }
  if (beyondBudget > 0 || frontier.some((target) => !read.has(identityKey(target))))
    limits.push({
      kind: 'identity_read_budget',
      detail:
        `This answer reads at most ${input.bounds.maxItems} identit(y/ies) from the store, and ` +
        `${read.size} were read. Identities past that were neither read nor traversed.`,
    });

  const reachedArtifacts = [...artifacts].sort();
  if (reachedArtifacts.length > ARTIFACT_BUDGET)
    limits.push({
      kind: 'artifact_read_budget',
      detail:
        `${reachedArtifacts.length - ARTIFACT_BUDGET} artifact(s) this change reaches had their ` +
        `recorded files left unread: this answer reads at most ${ARTIFACT_BUDGET}.`,
    });
  for (const event of readProjectPlanEventsOf(view, reachedArtifacts.slice(0, ARTIFACT_BUDGET)))
    planEvents.push({ artifact_id: event.artifactId, plan_event_id: event.planEventId });
  for (const association of readProjectFilesTouchedBy(
    view,
    reachedArtifacts.slice(0, ARTIFACT_BUDGET)
  ))
    codeAssociations.push({
      artifact_id: association.artifactId,
      file_path: association.filePath,
      asked: association.filePath,
      recorded_touch: true,
    });

  const mentions = readProjectAssumptionsNaming(
    view,
    { names: [...namedTo.keys()], decisionRevisionIds: [...decisionRevisionIds] },
    request
  );
  limits.push(...mentions.limits);
  const assumptions: ConsequenceAssumptionFact[] = mentions.mentions.flatMap((mention) => {
    const names = namedTo.get(mention.names);
    return names === undefined
      ? []
      : [
          {
            decision: mention.decision,
            where: mention.where,
            text: mention.text,
            names,
            authored_by: {
              kind: mention.authoredBy.kind,
              name: mention.authoredBy.identity,
              basis: mention.authoredBy.basis,
            },
          },
        ];
  });

  return {
    boundary: request.knowledge_boundary,
    answers,
    relationships,
    assumptions,
    assessments,
    code_associations: codeAssociations,
    subjects,
    plan_events: planEvents,
    limits,
  };
}
