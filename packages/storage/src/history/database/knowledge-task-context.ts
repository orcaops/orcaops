import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  projectKnowledgeContext,
  type ProjectKnowledgeContext,
  type ProjectKnowledgeContextRequest,
} from './knowledge-context.js';
import {
  type ProjectTaskUsesAtBoundary,
  readProjectTaskUsesAtBoundary,
} from './knowledge-read-task-uses.js';
import { type ProcessingQueue, readProcessingQueueAtBoundary } from './processing-reader.js';
import type { SelectedImplementation } from '../../schema/knowledge-resolution.js';

interface PublishedEventRow {
  eventId: string;
  eventType: string;
  writeSequence: number;
}

function publishedEvents(
  view: ProjectReadView,
  artifactId: string,
  boundary: number
): PublishedEventRow[] {
  return view.all<PublishedEventRow>(
    `SELECT e.event_id AS eventId,e.event_type AS eventType,
       min(o.committed_write_sequence) AS writeSequence
     FROM artifact_events e
     JOIN artifact_revisions r ON r.artifact_id=e.artifact_id AND r.event_count>=e.ordinal
     JOIN operations o ON o.operation_id=r.operation_id
     WHERE e.artifact_id=?
     GROUP BY e.event_id,e.event_type,e.ordinal
     HAVING min(o.committed_write_sequence)<=?
     ORDER BY e.ordinal`,
    artifactId,
    boundary
  );
}

export type TaskPlanSelection =
  | { readonly kind: 'latest_visible' }
  | { readonly kind: 'exact'; readonly planEventId: string };

export interface ProjectTaskKnowledgeRequest extends Pick<
  ProjectKnowledgeContextRequest,
  | 'projectId'
  | 'boundary'
  | 'assessments'
  | 'reconsideration'
  | 'assignments'
  | 'acting'
  | 'applicability'
  | 'exceptionsJudgedAt'
  | 'exceptionConditions'
> {
  readonly artifactId: string;
  readonly plan: TaskPlanSelection;
  readonly implementation?: SelectedImplementation;
}

export interface SelectedTaskPlan {
  readonly artifactId: string;
  readonly planEventId: string;
  readonly writeSequence: number;
  readonly uses: ProjectTaskUsesAtBoundary;
}

export interface ProjectTaskKnowledgeContext {
  readonly artifactId: string;
  readonly selectedPlan: SelectedTaskPlan | null;
  readonly knowledge: ProjectKnowledgeContext;
  readonly processing: ProcessingQueue;
}

function selectPlan(
  rows: readonly PublishedEventRow[],
  artifactId: string,
  selection: TaskPlanSelection
): Omit<SelectedTaskPlan, 'uses'> | null {
  const plans = rows.filter(
    (row) => row.eventType === 'plan_captured' || row.eventType === 'plan_revised'
  );
  if (selection.kind === 'latest_visible') {
    const row = plans.at(-1);
    return row === undefined
      ? null
      : { artifactId, planEventId: row.eventId, writeSequence: row.writeSequence };
  }
  const row = plans.find((candidate) => candidate.eventId === selection.planEventId);
  if (row === undefined)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      `Plan event ${selection.planEventId} is not a plan of artifact ${artifactId} visible at this knowledge boundary`
    );
  return { artifactId, planEventId: row.eventId, writeSequence: row.writeSequence };
}

/**
 * One task-facing answer. The plan, its uses, governing knowledge and queue cohort are all read
 * from the caller's view at the numeric boundary the knowledge reader resolved.
 */
export function projectTaskKnowledgeContext(
  view: ProjectReadView,
  input: ProjectTaskKnowledgeRequest
): ProjectTaskKnowledgeContext {
  const knowledge = projectKnowledgeContext(view, {
    projectId: input.projectId,
    scope: { kind: 'artifact', artifact_id: input.artifactId },
    boundary: input.boundary,
    mode: input.boundary === 'now' ? 'current' : 'historical',
    subject: { kind: 'task', artifactIds: [input.artifactId] },
    ...(input.implementation === undefined ? {} : { implementation: input.implementation }),
    ...(input.assessments === undefined ? {} : { assessments: input.assessments }),
    ...(input.reconsideration === undefined ? {} : { reconsideration: input.reconsideration }),
    ...(input.assignments === undefined ? {} : { assignments: input.assignments }),
    ...(input.acting === undefined ? {} : { acting: input.acting }),
    ...(input.applicability === undefined ? {} : { applicability: input.applicability }),
    ...(input.exceptionsJudgedAt === undefined
      ? {}
      : { exceptionsJudgedAt: input.exceptionsJudgedAt }),
    ...(input.exceptionConditions === undefined
      ? {}
      : { exceptionConditions: input.exceptionConditions }),
  });
  const boundary = knowledge.request.knowledge_boundary;
  const selected = selectPlan(
    publishedEvents(view, input.artifactId, boundary),
    input.artifactId,
    input.plan
  );
  return {
    artifactId: input.artifactId,
    selectedPlan:
      selected === null
        ? null
        : {
            ...selected,
            uses: readProjectTaskUsesAtBoundary(
              view,
              selected.planEventId,
              input.projectId,
              knowledge.request
            ),
          },
    knowledge,
    processing: readProcessingQueueAtBoundary(view, boundary),
  };
}

export type ActiveTaskSelection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ambiguous'; readonly artifactIds: readonly string[] }
  | { readonly kind: 'selected'; readonly artifactId: string; readonly planEventId: string };

/** Selects an unfinished captured task as it existed at the requested boundary. */
export function activeTaskSelectionAtBoundary(
  view: ProjectReadView,
  branch: string,
  boundary: number
): ActiveTaskSelection {
  const artifactIds = view
    .all<{ artifactId: string }>(
      `SELECT DISTINCT a.artifact_id AS artifactId
       FROM artifacts a
       JOIN artifact_metadata m ON m.artifact_id=a.artifact_id AND m.origin_kind='captured'
       WHERE EXISTS (
         SELECT 1 FROM artifact_branches b WHERE b.artifact_id=a.artifact_id AND b.branch=?
       ) OR EXISTS (
         SELECT 1 FROM execution_query_branches b WHERE b.artifact_id=a.artifact_id AND b.branch=?
       )
       ORDER BY a.artifact_id`,
      branch,
      branch
    )
    .map((row) => row.artifactId)
    .filter((artifactId) => {
      const events = publishedEvents(view, artifactId, boundary);
      return (
        events.some(
          (event) => event.eventType === 'plan_captured' || event.eventType === 'plan_revised'
        ) && !events.some((event) => event.eventType === 'summary_captured')
      );
    });
  if (artifactIds.length === 0) return { kind: 'absent' };
  if (artifactIds.length > 1) return { kind: 'ambiguous', artifactIds };
  const artifactId = artifactIds[0]!;
  const selected = selectPlan(publishedEvents(view, artifactId, boundary), artifactId, {
    kind: 'latest_visible',
  });
  return selected === null
    ? { kind: 'absent' }
    : { kind: 'selected', artifactId, planEventId: selected.planEventId };
}

export function latestVisiblePlanEventId(
  view: ProjectReadView,
  artifactId: string,
  boundary: number
): string | null {
  return (
    selectPlan(publishedEvents(view, artifactId, boundary), artifactId, {
      kind: 'latest_visible',
    })?.planEventId ?? null
  );
}
