import {
  buildInterpretationManifest,
  INTERPRETATION_DETECTOR,
  type InterpretationAttemptRequest,
  type InterpretationManifest,
  manifestRelatedKnowledge,
  planInterpretationRequest,
} from '@orcaops/core';
import { measurePreparedInputRequest } from '@orcaops/llm';
import {
  InterpretationAttemptScheduleBindingSchema,
  type InterpretationProcessingSchedule,
} from '@orcaops/storage';
import type {
  ProcessingAttempt,
  RelatedKnowledgeRetrieval,
} from '@orcaops/storage/history/database';

import { FIELD_INVENTORY_VERSION, type RetainedJobSource } from './job-source.js';
import { planSourceSchedule } from './schedule.js';

export interface ScheduledAttemptPlan {
  outcome: 'ready';
  schedule: InterpretationProcessingSchedule;
  scheduleAttemptId: string | null;
  unitIndex: number;
  request: InterpretationAttemptRequest;
}

export interface EmptySchedulePlan {
  outcome: 'empty';
  schedule: InterpretationProcessingSchedule;
  scheduleAttemptId: string | null;
}

export interface RefusedAttemptPlan {
  outcome:
    | 'source_schedule_limit'
    | 'retained_schedule_incompatible'
    | 'schedule_integrity_failure';
  detail: string;
}

export interface ExhaustedAttemptPlan {
  outcome: 'attempts_exhausted';
  detail: string;
}

export type AttemptPlan =
  | ScheduledAttemptPlan
  | EmptySchedulePlan
  | RefusedAttemptPlan
  | ExhaustedAttemptPlan;

function coverageLimits(source: RetainedJobSource, schedule: InterpretationProcessingSchedule) {
  return [
    ...(source.planAnchorLimit === null || source.planAnchorLimit === undefined
      ? []
      : [{ kind: 'retrieval_limit' as const, detail: source.planAnchorLimit }]),
    ...(schedule.omissions.length === 0
      ? []
      : [
          {
            kind: 'source_context_missing' as const,
            detail:
              `${schedule.omissions_total} authored field(s) are absent from this schedule ` +
              `because they were empty, restricted, or could not fit as context.`,
          },
        ]),
  ];
}

export function buildJobManifest(
  source: RetainedJobSource,
  projectId: string,
  schedule: InterpretationProcessingSchedule,
  unitIndex: number,
  retrieval: RelatedKnowledgeRetrieval
): InterpretationManifest {
  if (retrieval.boundary !== source.knowledgeBoundary) {
    throw new TypeError(
      `Retrieval was read at write sequence ${retrieval.boundary} and the source at ` +
        `${source.knowledgeBoundary}; one manifest names one boundary.`
    );
  }
  const unit = schedule.units[unitIndex];
  if (unit === undefined) throw new TypeError(`Schedule unit ${unitIndex} does not exist.`);
  const related = manifestRelatedKnowledge(retrieval);
  const sourceIds = [...new Set(unit.segments.map((segment) => segment.source_id))];
  const sources = sourceIds.map((sourceId) => {
    const field = source.fields.find(
      (candidate) => `${source.eventId}#${candidate.fieldPath}#${candidate.position}` === sourceId
    );
    if (field === undefined)
      throw new TypeError(`Scheduled source ${sourceId} is absent from the retained event.`);
    return { source_id: sourceId, text: field.originalText };
  });
  return buildInterpretationManifest({
    schedule_id: schedule.schedule_id,
    unit_id: unit.unit_id,
    project_id: projectId,
    source_event_id: source.eventId,
    task_context:
      source.planEventId === null
        ? null
        : { artifact_id: source.artifactId, plan_event_id: source.planEventId },
    sources,
    segments: unit.segments,
    attributed_to: { kind: 'detector', detector: INTERPRETATION_DETECTOR },
    knowledge_boundary: source.knowledgeBoundary,
    related_knowledge: related.related_knowledge,
    coverage_limits: [...related.coverage_limits, ...coverageLimits(source, schedule)],
  });
}

export function retainedSchedule(attempts: readonly ProcessingAttempt[]):
  | {
      ok: true;
      schedule: InterpretationProcessingSchedule | null;
      scheduleAttemptId: string | null;
    }
  | { ok: false; detail: string } {
  if (attempts.length === 0) return { ok: true, schedule: null, scheduleAttemptId: null };
  const ordered = [...attempts].sort((left, right) => left.attemptNumber - right.attemptNumber);
  const bindings = ordered.map((attempt) => {
    const configuration =
      attempt.configuration !== null &&
      typeof attempt.configuration === 'object' &&
      !Array.isArray(attempt.configuration)
        ? attempt.configuration
        : null;
    const parsed = InterpretationAttemptScheduleBindingSchema.safeParse(
      configuration?.schedule_binding
    );
    return { attempt, parsed };
  });
  const malformed = bindings.find((entry) => !entry.parsed.success);
  if (malformed !== undefined)
    return {
      ok: false,
      detail:
        `Attempt ${malformed.attempt.attemptId} is missing a valid current-format schedule ` +
        `binding. No schedule is inferred from older progress.`,
    };
  const full = bindings.filter(
    (entry) => entry.parsed.success && entry.parsed.data.schedule !== null
  );
  if (full.length !== 1)
    return {
      ok: false,
      detail: `The job retains ${full.length} full schedule definitions; exactly one is required.`,
    };
  const scheduleAttempt = full[0]!;
  if (
    !scheduleAttempt.parsed.success ||
    scheduleAttempt.parsed.data.schedule_attempt_id !== scheduleAttempt.attempt.attemptId
  )
    return {
      ok: false,
      detail: 'The schedule-bearing attempt does not name itself as the immutable schedule owner.',
    };
  const schedule = scheduleAttempt.parsed.data.schedule!;
  if (schedule.field_inventory_version !== FIELD_INVENTORY_VERSION)
    return {
      ok: false,
      detail:
        `The retained schedule uses field inventory ${schedule.field_inventory_version}; this ` +
        `worker supports ${FIELD_INVENTORY_VERSION}.`,
    };
  for (const entry of bindings) {
    if (!entry.parsed.success) continue;
    const binding = entry.parsed.data;
    if (binding.unit === null) {
      if (
        schedule.units.length === 0 &&
        entry.attempt.attemptId === scheduleAttempt.attempt.attemptId
      )
        continue;
      return {
        ok: false,
        detail: `Attempt ${entry.attempt.attemptId} has no selected unit for a non-empty schedule.`,
      };
    }
    if (
      binding.schedule_attempt_id !== scheduleAttempt.attempt.attemptId ||
      binding.unit.schedule_id !== schedule.schedule_id ||
      binding.unit.count !== schedule.units.length ||
      schedule.units[binding.unit.index]?.unit_id !== binding.unit.unit_id
    )
      return {
        ok: false,
        detail: `Attempt ${entry.attempt.attemptId} names a foreign or conflicting schedule unit.`,
      };
  }
  return {
    ok: true,
    schedule,
    scheduleAttemptId: scheduleAttempt.attempt.attemptId,
  };
}

export function contiguousCompletedUnits(
  schedule: InterpretationProcessingSchedule,
  completedUnitIds: readonly string[]
): { ok: true; nextIndex: number } | { ok: false; detail: string } {
  const seen = new Set<string>();
  for (const unitId of completedUnitIds) {
    if (seen.has(unitId)) continue;
    const index = seen.size;
    seen.add(unitId);
    if (schedule.units[index]?.unit_id !== unitId)
      return {
        ok: false,
        detail: `Completion receipt ${unitId} is foreign or leaves a hole before schedule unit ${index}.`,
      };
  }
  return { ok: true, nextIndex: seen.size };
}

export function planJobAttempt(input: {
  source: RetainedJobSource;
  projectId: string;
  configuration: {
    provider: { id: 'claude' | 'codex' };
    limits: { max_input_bytes: number };
  };
  attemptsRemaining: number;
  retained: readonly ProcessingAttempt[];
  completedUnitIds: readonly string[];
  retrieval: RelatedKnowledgeRetrieval | null;
}): AttemptPlan {
  const retained = retainedSchedule(input.retained);
  if (!retained.ok) return { outcome: 'schedule_integrity_failure', detail: retained.detail };
  let schedule = retained.schedule;
  if (schedule === null) {
    const planned = planSourceSchedule({
      source: input.source,
      projectId: input.projectId,
      provider: input.configuration.provider.id,
      maxInputBytes: input.configuration.limits.max_input_bytes,
    });
    if (planned.outcome !== 'scheduled') return planned;
    schedule = planned.schedule;
  }
  const progress = contiguousCompletedUnits(schedule, input.completedUnitIds);
  if (!progress.ok) return { outcome: 'schedule_integrity_failure', detail: progress.detail };
  if (progress.nextIndex === schedule.units.length)
    return {
      outcome: 'empty',
      schedule,
      scheduleAttemptId: retained.scheduleAttemptId,
    };
  const remaining = schedule.units.length - progress.nextIndex;
  if (input.attemptsRemaining === 0)
    return {
      outcome: 'attempts_exhausted',
      detail:
        `The retained schedule has ${remaining} unsettled unit(s), and this job has no ` +
        `attempt left. Completed receipts remain retained.`,
    };
  if (remaining > input.attemptsRemaining)
    return {
      outcome: 'source_schedule_limit',
      detail:
        `The retained schedule has ${remaining} unsettled unit(s), but this job has ` +
        `${input.attemptsRemaining} attempt(s) left. Completed receipts remain retained.`,
    };

  if (input.retrieval === null)
    return {
      outcome: 'schedule_integrity_failure',
      detail: 'A non-empty scheduled unit has no related-knowledge retrieval.',
    };
  let manifest: InterpretationManifest;
  try {
    manifest = buildJobManifest(
      input.source,
      input.projectId,
      schedule,
      progress.nextIndex,
      input.retrieval
    );
  } catch (error) {
    return {
      outcome: 'schedule_integrity_failure',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const request = planInterpretationRequest(manifest, {
    provider: input.configuration.provider.id,
    measure: { measurePreparedInputRequest },
    maxInputBytes: input.configuration.limits.max_input_bytes,
  });
  if (request.status !== 'ready')
    return {
      outcome:
        retained.schedule === null ? 'source_schedule_limit' : 'retained_schedule_incompatible',
      detail:
        request.status === 'too_large'
          ? request.detail
          : 'The exact scheduled unit would be split by the request planner; frozen units are never repacked.',
    };
  return {
    outcome: 'ready',
    schedule,
    scheduleAttemptId: retained.scheduleAttemptId,
    unitIndex: progress.nextIndex,
    request: request.attempt,
  };
}
