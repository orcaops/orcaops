import { z } from 'zod';

import { CAPTURE_AGENT_IDS } from './config.js';
import { DecisionBaseSchema } from './decision.js';
import {
  CheckpointSnapshotBoundarySchema,
  DiffFingerprintSummarySchema,
} from './diff-fingerprint.js';
import { identifierText, proseText } from '../text/control-chars.js';
export const DoneCriterionSchema = z
  .object({
    criterion_id: identifierText(),
    evidence: proseText(),
  })
  .strict();
export type DoneCriterion = z.infer<typeof DoneCriterionSchema>;
export const VerificationEntrySchema = z
  .object({
    command: proseText(),
    exit_code: z.number().int(),
    output_digest: proseText(z.string().min(1)).optional(),
    note: proseText(z.string().min(1)).optional(),
  })
  .strict();
export type VerificationEntry = z.infer<typeof VerificationEntrySchema>;
export const CheckpointDecisionSchema = DecisionBaseSchema;
export type CheckpointDecision = z.infer<typeof CheckpointDecisionSchema>;
export const PolicyExceptionSchema = z.object({
  evaluator: identifierText(),
  reason: proseText(),
});
export type PolicyException = z.infer<typeof PolicyExceptionSchema>;
const CommonCheckpointFields = {
  schema_version: z.literal(4),
  artifact_id: z.string().min(1),
  n: z.number().int().positive(),
  declared_step_ids: z.array(z.string().min(1)).min(1),
  agent_session_id: z.string().min(1).optional(),
  agent: z.enum(CAPTURE_AGENT_IDS),
  policy_exceptions: z.array(PolicyExceptionSchema),
  plan_revision_id: z.string().min(1).nullable(),
  open_plan_revision_event_id: z.string().min(1),
  opened_at: z.string().datetime(),
  head_sha: z.string().min(1),
  open_snapshot: CheckpointSnapshotBoundarySchema,
};
export const OpenCheckpointSchema = z.object({
  ...CommonCheckpointFields,
  status: z.literal('open'),
  source_event_id: z.string().min(1),
});
export type OpenCheckpoint = z.infer<typeof OpenCheckpointSchema>;
export const WindowOverlapFileSchema = z.object({
  file_before: z.string().nullable(),
  file_after: z.string().nullable(),
});
export type WindowOverlapFile = z.infer<typeof WindowOverlapFileSchema>;
export const WindowOverlapDroppedFileSchema = z.object({
  file_before: z.string().nullable(),
  file_after: z.string().nullable(),
  status: z.enum(['sibling-claimed', 'sibling_pending', 'unclaimed']),
});
export type WindowOverlapDroppedFile = z.infer<typeof WindowOverlapDroppedFileSchema>;
export const WindowOverlapSchema = z.object({
  siblings: z.array(z.number().int()),
  cross_artifact_siblings: z.array(
    z.object({ artifact_id: z.string().min(1), n: z.number().int() })
  ),
  pending: z.boolean(),
  dropped_files: z.array(WindowOverlapDroppedFileSchema),
  rejected_claims: z.array(z.string()),
  ambiguous_files: z.array(WindowOverlapFileSchema),
  mixed_segment: z.array(WindowOverlapFileSchema),
  own_claim_pending: z.array(WindowOverlapFileSchema),
  segment_attributed: z.array(z.string()),
  unattributed_in_window: z.array(z.string()),
  degradations: z.array(z.string()),
});
export type WindowOverlap = z.infer<typeof WindowOverlapSchema>;
export const AttributionDegradedSchema = z
  .object({
    unmerged_paths: z.array(z.string().min(1)),
    probe_failed: z.literal(true).optional(),
  })
  .refine((r) => r.unmerged_paths.length > 0 || r.probe_failed === true, {
    message: 'attribution_degraded requires a non-empty unmerged_paths or probe_failed: true',
  });
export type AttributionDegraded = z.infer<typeof AttributionDegradedSchema>;
export const ClosedCheckpointSchema = z.object({
  ...CommonCheckpointFields,
  status: z.literal('closed'),
  open_head_sha: z.string().min(1).optional(),
  closed_at: z.string().datetime(),
  closed_by_agent: z.enum(CAPTURE_AGENT_IDS),
  summary: z.string().min(1),
  files_changed: z.array(z.string()),
  decisions: z.array(CheckpointDecisionSchema),
  uncertainty: z.array(z.string()),
  done_criteria: z.array(DoneCriterionSchema),
  verification: z.array(VerificationEntrySchema).optional(),
  window_overlap: WindowOverlapSchema.optional(),
  attribution_degraded: AttributionDegradedSchema.optional(),
  completed_step_ids: z.array(z.string().min(1)),
  close_snapshot: CheckpointSnapshotBoundarySchema,
  diff_fingerprint_summary: DiffFingerprintSummarySchema,
  source_event_ids: z.object({
    opened: z.string().min(1),
    closed: z.string().min(1),
  }),
  source_event_id: z.string().min(1),
});
export type ClosedCheckpoint = z.infer<typeof ClosedCheckpointSchema>;
export const AbandonedCheckpointSchema = z.object({
  ...CommonCheckpointFields,
  status: z.literal('abandoned'),
  abandoned_at: z.string().datetime(),
  abandoned_by_agent: z.enum(CAPTURE_AGENT_IDS),
  reason: z.string().min(1),
  abandon_snapshot: CheckpointSnapshotBoundarySchema,
  source_event_ids: z.object({
    opened: z.string().min(1),
    abandoned: z.string().min(1),
  }),
  source_event_id: z.string().min(1),
});
export type AbandonedCheckpoint = z.infer<typeof AbandonedCheckpointSchema>;
export const CheckpointSchema = z.discriminatedUnion('status', [
  OpenCheckpointSchema,
  ClosedCheckpointSchema,
  AbandonedCheckpointSchema,
]);
export type Checkpoint = z.infer<typeof CheckpointSchema>;
