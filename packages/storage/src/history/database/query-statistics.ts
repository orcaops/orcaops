import { z } from 'zod';

import type { EventWithPayload } from '../../events/rebuilders.js';
import type {
  AbandonedCheckpoint,
  ClosedCheckpoint,
  OpenCheckpoint,
} from '../../schema/checkpoint.js';
import { PlanSchema } from '../../schema/plan.js';
import { CounterSchema } from '../event-integrity.js';

const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const checkpointNumber = CounterSchema.refine((value) => value > 0);
export const ArtifactStatisticsSchema = z.strictObject({
  maximumPlanRevision: CounterSchema,
  checkpointCounts: z.strictObject({
    open: CounterSchema,
    closed: CounterSchema,
    abandoned: CounterSchema,
  }),
  closedIntervals: z.array(
    z.strictObject({ n: checkpointNumber, openedAt: timestamp, closedAt: timestamp })
  ),
  closedWithoutCompletedSteps: CounterSchema,
  closedWithoutUncertainty: CounterSchema,
  closedWithoutDecisions: CounterSchema,
  closedWithoutFiles: CounterSchema,
});

type StatisticsCheckpoint =
  | Pick<OpenCheckpoint, 'status'>
  | Pick<AbandonedCheckpoint, 'status'>
  | Pick<
      ClosedCheckpoint,
      | 'status'
      | 'n'
      | 'opened_at'
      | 'closed_at'
      | 'completed_step_ids'
      | 'uncertainty'
      | 'decisions'
      | 'files_changed'
    >;

export function prepareArtifactStatistics(source: {
  artifactId: string;
  events: readonly EventWithPayload[];
  checkpoints: readonly StatisticsCheckpoint[];
}) {
  const plans = source.events.flatMap((event) => {
    if (event.record.type !== 'plan_captured' && event.record.type !== 'plan_revised') return [];
    const plan = PlanSchema.parse({
      ...(event.payload as Record<string, unknown>),
      source_event_id: event.record.event_id,
    });
    if (plan.artifact_id !== source.artifactId) throw new Error('Plan belongs to another artifact');
    return [plan];
  });
  if (!plans.length) throw new Error('Retained artifact has no original plan');
  const stepIds = new Set(plans.flatMap((plan) => plan.plan_steps.map((step) => step.step_id)));
  const closed = source.checkpoints.filter((checkpoint) => checkpoint.status === 'closed');
  const statistics = ArtifactStatisticsSchema.parse({
    maximumPlanRevision: plans.reduce((maximum, plan) => Math.max(maximum, plan.revision_n), 0),
    checkpointCounts: {
      open: source.checkpoints.filter((checkpoint) => checkpoint.status === 'open').length,
      closed: closed.length,
      abandoned: source.checkpoints.filter((checkpoint) => checkpoint.status === 'abandoned')
        .length,
    },
    closedIntervals: closed.map((checkpoint) => ({
      n: checkpoint.n,
      openedAt: checkpoint.opened_at,
      closedAt: checkpoint.closed_at,
    })),
    closedWithoutCompletedSteps: closed.filter(
      (checkpoint) => !checkpoint.completed_step_ids.length
    ).length,
    closedWithoutUncertainty: closed.filter((checkpoint) => !checkpoint.uncertainty.length).length,
    closedWithoutDecisions: closed.filter((checkpoint) => !checkpoint.decisions.length).length,
    closedWithoutFiles: closed.filter((checkpoint) => !checkpoint.files_changed.length).length,
  });
  return { statistics, historicalPlanStepIds: [...stepIds].sort() };
}
