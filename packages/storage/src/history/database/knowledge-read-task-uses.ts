// What a plan event's task uses said at a knowledge boundary, and what has become of each target.
//
// The uses a later operation connected are kept in a list of their own, never folded in with the
// uses the plan event's own settlement wrote, so an after-the-fact connection can never masquerade
// as an original task selection. Whether a use was an original selection is a fact about which
// operation wrote it; the store derived it when the row was written and this reader only reports
// the two apart.
import { type ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type KnowledgeBoundary,
  type KnowledgeReadCoverage,
  knowledgeReadCoverage,
  knowledgeReadRequest,
  type RevisionGoverningStanding,
  revisionGoverningState,
  writeSequencesOf,
} from './knowledge-read-boundary.js';
import { type GoverningStateReader, governingStateReader } from './knowledge-read-governing.js';
import { listProjectTaskUses, type ProjectTaskUseRow } from './knowledge-task-uses.js';
import type { RecordRevisionRef } from '../../schema/knowledge-contract.js';
import type {
  KnowledgeReadRequest,
  ResolvedKnowledge,
  RevisionStanding,
} from '../../schema/knowledge-resolution.js';

export interface ProjectTaskUseAtBoundary {
  readonly use: ProjectTaskUseRow;
  readonly writeSequence: number;
  readonly standing: RevisionGoverningStanding;
  /** The resolver's own entries for the target revision, one per scope it was acted on in. */
  readonly entries: readonly RevisionStanding[];
}

export interface ProjectTaskUsesAtBoundary {
  readonly planEventId: string;
  readonly coverage: KnowledgeReadCoverage;
  /** The uses the plan event's own operation wrote. */
  readonly selectedWithPlan: readonly ProjectTaskUseAtBoundary[];
  /** The uses a later operation connected, each naming who found the connection and when. */
  readonly connectedLater: readonly ProjectTaskUseAtBoundary[];
}

export interface ProjectArtifactTaskUses {
  readonly knowledgeBoundary: number;
  /** One entry per plan event of the artifact, in the order the events were appended. */
  readonly planEvents: readonly ProjectTaskUsesAtBoundary[];
}

const ARTIFACT_PLAN_EVENTS = `SELECT e.event_id FROM artifact_events e
  JOIN artifact_revisions r ON r.artifact_id=e.artifact_id AND r.event_count>=e.ordinal
  JOIN operations o ON o.operation_id=r.operation_id
  WHERE e.artifact_id=? AND e.event_type IN ('plan_captured','plan_revised')
  GROUP BY e.event_id,e.ordinal HAVING min(o.committed_write_sequence)<=? ORDER BY e.ordinal`;

/**
 * Every plan event of one artifact with its two lists, inside the caller's snapshot and under one
 * request. A surface that renders a whole thread takes it here rather than reading per checkpoint:
 * a checkpoint inherits the uses of the plan revision it pinned, so one read at one boundary
 * answers for the plan and for every checkpoint, and two reads would mix two observations of the
 * store into one account.
 */
export function readProjectArtifactTaskUses(
  view: ProjectReadView,
  artifactId: string,
  projectId: string,
  // A surface reading at an earlier boundary reads its uses at the same one; two bases in one
  // account would show a plan selecting revisions the answer beside it cannot see.
  boundary: KnowledgeBoundary = 'now'
): ProjectArtifactTaskUses {
  const request = knowledgeReadRequest(view, {
    scope: { kind: 'artifact', artifact_id: artifactId },
    mode: boundary === 'now' ? 'current' : 'historical',
    boundary,
  });
  const reader = governingStateReader(view, projectId, request);
  return {
    knowledgeBoundary: request.knowledge_boundary,
    planEvents: view
      .all<{ event_id: string }>(ARTIFACT_PLAN_EVENTS, artifactId, request.knowledge_boundary)
      .map((row) => readProjectTaskUsesAtBoundary(view, row.event_id, projectId, request, reader)),
  };
}

/**
 * A caller that already resolves identities at this boundary passes its own reader, so a target
 * it has asked about is not resolved a second time here. Every answer in one reader comes from one
 * snapshot and one boundary, so the caller that shares one shares its request too.
 */
export function readProjectTaskUsesAtBoundary(
  view: ProjectReadView,
  planEventId: string,
  projectId: string,
  request: KnowledgeReadRequest,
  reader?: GoverningStateReader
): ProjectTaskUsesAtBoundary {
  const uses = listProjectTaskUses(view, planEventId);
  const sequences = writeSequencesOf(
    view,
    uses.map((use) => use.operationId)
  );
  const governing = reader ?? governingStateReader(view, projectId, request);
  // The answers for the targets THIS read asked about, never every answer the reader holds: a
  // shared reader carries the identities its other callers asked about.
  const answers: ResolvedKnowledge[] = [];
  const selectedWithPlan: ProjectTaskUseAtBoundary[] = [];
  const connectedLater: ProjectTaskUseAtBoundary[] = [];
  for (const use of uses) {
    const writeSequence = sequences.get(use.operationId);
    if (writeSequence === undefined || writeSequence > request.knowledge_boundary) continue;
    const target = {
      kind: use.target.kind as RecordRevisionRef['kind'],
      entity_id: use.target.entityId,
    };
    const resolved = governing.at(target);
    answers.push(resolved);
    const state = revisionGoverningState(resolved, use.target.revisionId);
    const entry = { use, writeSequence, standing: state.standing, entries: state.entries };
    if (use.selectionKind === 'selected_with_plan') selectedWithPlan.push(entry);
    else if (use.selectionKind === 'connected_later') connectedLater.push(entry);
    // Neither list may quietly absorb a third kind: a use whose selection this build cannot read
    // would be a use nobody sees, and the two lists are the answer to "was this an original
    // selection?".
    else
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A retained task use records a selection this build does not understand; preserve history for explicit repair'
      );
  }
  return {
    planEventId,
    coverage: knowledgeReadCoverage(request, answers),
    selectedWithPlan,
    connectedLater,
  };
}
