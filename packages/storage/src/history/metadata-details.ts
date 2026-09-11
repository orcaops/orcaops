import { z } from 'zod';

import { type ExecutionState, ExecutionStateSchema } from './execution-schema.js';
import { historyWatchMetadata, HistoryWatchMetadataSchema } from './metadata-watch.js';
import type { ArtifactThread } from '../events/artifact-thread.js';
import { BranchLineageEntrySchema } from '../schema/artifact-json.js';
import { OpenCheckpointSchema } from '../schema/checkpoint.js';
import { ArtifactOriginSchema } from '../schema/origin.js';
import { PlanStepSchema } from '../schema/plan.js';
import { SourcePlanPinSchema } from '../schema/source-plan.js';

export const HistoryMetadataDetailsSchema = z.strictObject({
  watch: HistoryWatchMetadataSchema,
  anchors: z.array(
    z.strictObject({
      source: z.enum(['checkpoint', 'summary', 'pre_pr']),
      n: z.number().int().positive().optional(),
      head_sha: z.string(),
    })
  ),
  task: z.string(),
  branch: z.string(),
  baseSha: z.string(),
  origin: ArtifactOriginSchema.nullable(),
  branchLineage: z.array(BranchLineageEntrySchema),
  sourcePlan: SourcePlanPinSchema.nullable(),
  openCheckpoints: z.array(OpenCheckpointSchema),
  closedCheckpoints: z.array(
    z.strictObject({
      n: z.number().int().positive(),
      completed_step_ids: z.array(PlanStepSchema.shape.step_id),
    })
  ),
  planStepIds: z.array(PlanStepSchema.shape.step_id),
  evaluatorRuns: z.array(
    z.strictObject({
      evaluator_ref: z.string(),
      run_id: z.string(),
      phase: z.string(),
      severity: z.string(),
      run_status: z.string(),
      verdict: z.string().nullable(),
      disposition: z.string().nullable(),
      checkpoint_n: z.number().int().nullable(),
    })
  ),
  execution: ExecutionStateSchema.nullable(),
  artifactSourceEventId: z.string().nullable(),
  prePrCheckedHeadSha: z.string().nullable(),
  prePrCheckedSourceEventId: z.string().nullable(),
});
export type HistoryMetadataDetails = z.infer<typeof HistoryMetadataDetailsSchema>;

export function historyMetadataDetails(
  thread: ArtifactThread,
  execution: ExecutionState | null
): HistoryMetadataDetails {
  const artifact = thread.artifactJson!;
  const plan = thread.plan!;
  const runs = [...(thread.evaluatorLog?.runs ?? [])].sort(
    (a, b) =>
      a.source_event_index - b.source_event_index ||
      a.local_kind_rank - b.local_kind_rank ||
      a.local_index - b.local_index
  );
  return HistoryMetadataDetailsSchema.parse({
    watch: historyWatchMetadata(thread),
    anchors: [
      ...thread.checkpoints.map((cp) => ({ source: 'checkpoint', n: cp.n, head_sha: cp.head_sha })),
      ...(thread.summary ? [{ source: 'summary', head_sha: thread.summary.head_sha }] : []),
      ...(artifact.pre_pr_checked_head_sha
        ? [{ source: 'pre_pr', head_sha: artifact.pre_pr_checked_head_sha }]
        : []),
    ],
    task: plan.task,
    branch: plan.branch,
    baseSha: plan.base_sha,
    origin: plan.origin ?? null,
    branchLineage: artifact.branch_lineage,
    sourcePlan: artifact.source_plan ?? null,
    openCheckpoints: thread.checkpoints.filter((checkpoint) => checkpoint.status === 'open'),
    closedCheckpoints: thread.checkpoints.flatMap((checkpoint) =>
      checkpoint.status === 'closed'
        ? [{ n: checkpoint.n, completed_step_ids: checkpoint.completed_step_ids }]
        : []
    ),
    planStepIds: plan.plan_steps.map((step) => step.step_id),
    evaluatorRuns: runs.map((run) => ({
      evaluator_ref: run.evaluator_ref,
      run_id: run.run_id,
      phase: run.phase,
      severity: run.severity,
      run_status: run.run_status,
      verdict: run.verdict,
      disposition: run.disposition,
      checkpoint_n: run.checkpoint_n ?? null,
    })),
    execution,
    artifactSourceEventId: artifact.source_event_id ?? null,
    prePrCheckedHeadSha: artifact.pre_pr_checked_head_sha ?? null,
    prePrCheckedSourceEventId: artifact.pre_pr_checked_source_event_id ?? null,
  });
}
