import { z } from 'zod';

import { ArtifactOriginSchema } from './origin.js';
import { SourcePlanPinSchema } from './source-plan.js';
export const ArtifactStateSchema = z.enum(['planned', 'active', 'blocked', 'summarized']);
export type ArtifactState = z.infer<typeof ArtifactStateSchema>;
export const BranchLineageEventSchema = z.enum(['created', 'rebased', 'merged']);
export type BranchLineageEvent = z.infer<typeof BranchLineageEventSchema>;
export const BranchLineageEntrySchema = z.object({
  branch: z.string().min(1),
  head_sha: z.string().min(1),
  ts: z.string().datetime(),
  event: BranchLineageEventSchema,
});
export type BranchLineageEntry = z.infer<typeof BranchLineageEntrySchema>;
export const ArtifactJsonSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  state: ArtifactStateSchema,
  branch_lineage: z.array(BranchLineageEntrySchema).min(1),
  created_by_session_id: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  checkpoint_count: z.number().int().min(0),
  plan_revision_count: z.number().int().min(0),
  plan_last_revised_at: z.string().datetime().nullable(),
  source_event_id: z.string().min(1),
  source_plan: SourcePlanPinSchema.nullable(),
  pre_pr_checked_head_sha: z.string().nullable(),
  pre_pr_checked_source_event_id: z.string().min(1).nullable(),
  baseline_seed_tree_sha: z.string().nullable(),
  superseded_artifact_id: z.string().nullable(),
  origin: ArtifactOriginSchema.optional(),
});
export type ArtifactJson = z.infer<typeof ArtifactJsonSchema>;
