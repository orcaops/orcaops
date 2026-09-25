// What a retained plan revision says it uses, for the surfaces that read a thread back.
//
// A use is keyed to the immutable plan event, so a checkpoint needs nothing of its own: it already
// pins the plan revision it opened against, and the uses of that revision ARE the inputs it opened
// against. Nothing is written at open, and nothing here re-derives which list a use belongs in —
// the store did that when the row was written, from the operation that wrote it.
import {
  activeTaskSelectionAtBoundary,
  type KnowledgeBoundary,
  knowledgeReadRequest,
  type ProjectArtifactTaskUses,
  type ProjectDatabase,
  type ProjectReadView,
  type ProjectTaskUseAtBoundary,
  readProjectTaskUsesAtBoundary,
} from '@orcaops/storage/history/database';

const PLAN_EVENTS =
  "SELECT event_id FROM artifact_events WHERE artifact_id=? AND event_type IN ('plan_captured','plan_revised') ORDER BY ordinal";

export function planEventIdsOf(view: ProjectReadView, artifactId: string): string[] {
  return view.all<{ event_id: string }>(PLAN_EVENTS, artifactId).map((row) => row.event_id);
}

export const latestPlanEventId = (view: ProjectReadView, artifactId: string): string | null =>
  planEventIdsOf(view, artifactId).at(-1) ?? null;

export interface PlanKnowledgeUseReport {
  artifact_id: string;
  plan_event_id: string;
  target: { kind: string; entity_id: string; revision_id: string };
  role: string;
  step_id: string | null;
  criterion_id: string | null;
  exception_id: string | null;
  standing: string;
  write_sequence: number;
  discovered_at: string | null;
  discovered_by: { kind: string; name: string | null; basis: string | null } | null;
}

export interface PlanEventKnowledgeUses {
  plan_event_id: string;
  selected_with_plan: PlanKnowledgeUseReport[];
  connected_later: PlanKnowledgeUseReport[];
}

const report = (entry: ProjectTaskUseAtBoundary): PlanKnowledgeUseReport => ({
  artifact_id: entry.use.artifactId,
  plan_event_id: entry.use.planEventId,
  target: {
    kind: entry.use.target.kind,
    entity_id: entry.use.target.entityId,
    revision_id: entry.use.target.revisionId,
  },
  role: entry.use.role,
  step_id: entry.use.stepId,
  criterion_id: entry.use.criterionId,
  exception_id: entry.use.exceptionId,
  standing: entry.standing,
  write_sequence: entry.writeSequence,
  discovered_at: entry.use.discoveredAt,
  discovered_by: entry.use.discoveredBy,
});

export interface ArtifactKnowledgeUses {
  knowledge_boundary: number;
  plan_events: PlanEventKnowledgeUses[];
}

/**
 * The uses an artifact overview already read, as a surface renders them. The read happened in the
 * snapshot the overview was resolved in; taking it again here would put two observations of the
 * store in one account, which is what `show` renders from a resolved overview to avoid.
 */
export function artifactKnowledgeUses(uses: ProjectArtifactTaskUses): ArtifactKnowledgeUses {
  return {
    knowledge_boundary: uses.knowledgeBoundary,
    plan_events: uses.planEvents.map((entry) => ({
      plan_event_id: entry.planEventId,
      selected_with_plan: entry.selectedWithPlan.map(report),
      connected_later: entry.connectedLater.map(report),
    })),
  };
}

/**
 * One plan event's two lists, read back from the store after a capture settles. The response says
 * what the store holds rather than echoing what the caller asked for, so a use already recorded
 * and a use just written read the same and neither is claimed without a row behind it.
 */
export function readPlanEventKnowledgeUses(
  handle: ProjectDatabase,
  input: { planEventId: string; projectId: string }
): PlanEventKnowledgeUses {
  return handle.read((view) => {
    const request = knowledgeReadRequest(view, {
      scope: { kind: 'project', project_id: input.projectId },
      mode: 'current',
      boundary: 'now',
    });
    const uses = readProjectTaskUsesAtBoundary(view, input.planEventId, input.projectId, request);
    return {
      plan_event_id: input.planEventId,
      selected_with_plan: uses.selectedWithPlan.map(report),
      connected_later: uses.connectedLater.map(report),
    };
  }).value;
}

export interface ActivePlanSelection {
  artifactId: string;
  planEventId: string;
}

/**
 * The plan a passive read diffs against: the one active captured artifact on this branch, and its
 * newest plan event. Ambiguity and absence are both `null` rather than a guess — a diff against
 * the wrong plan would report rules as unselected that another task selected.
 */
export function activePlanSelection(
  handle: ProjectDatabase,
  branch: string | null,
  boundary: KnowledgeBoundary = 'now'
): ActivePlanSelection | null {
  if (branch === null) return null;
  return handle.read((view) => {
    const request = knowledgeReadRequest(view, {
      scope: { kind: 'project', project_id: handle.authority.projectId },
      mode: boundary === 'now' ? 'current' : 'historical',
      boundary,
    });
    const selected = activeTaskSelectionAtBoundary(view, branch, request.knowledge_boundary);
    return selected.kind === 'selected'
      ? { artifactId: selected.artifactId, planEventId: selected.planEventId }
      : null;
  }).value;
}
