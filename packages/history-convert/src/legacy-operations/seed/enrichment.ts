import { z } from 'zod';

import { ARTIFACT_LABEL_MAX } from '../storage/schema/plan.js';
const EnrichmentDecisionSchema = z.strictObject({
  decision: z.string().min(1),
  reason: z.string().min(1),
  alternatives_considered: z
    .array(
      z.strictObject({
        option: z.string().min(1),
        rejected_because: z.string().min(1),
      })
    )
    .optional(),
});
const NominationDispositionSchema = z
  .strictObject({
    nomination_id: z.string().regex(/^[0-9a-f]{64}$/u),
    disposition: z.enum(['decision', 'skipped']),
    reason: z.string().min(1).optional(),
  })
  .refine((value) => value.disposition !== 'skipped' || value.reason !== undefined, {
    message: 'a skipped nomination requires a reason',
  });
export const SeedEnrichmentSchema = z.strictObject({
  schema_version: z.literal(2),
  cluster_key: z.string().min(1),
  options_hash: z.string().min(1),
  used_pr_context: z.boolean(),
  label: z.string().min(1).max(ARTIFACT_LABEL_MAX),
  task: z.string().min(1),
  steps: z.array(
    z.strictObject({
      label: z.string().min(1).max(ARTIFACT_LABEL_MAX),
      text: z.string().min(1),
    })
  ),
  checkpoint_summaries: z.array(z.string().min(1)),
  outcome: z.string().min(1),
  decisions: z.array(EnrichmentDecisionSchema),
  nomination_dispositions: z.array(NominationDispositionSchema).optional(),
});
export const PersistedSeedEnrichmentSchema = SeedEnrichmentSchema.extend({
  enriched_at: z.string().datetime(),
});
const SeedSelectionRecordSchema = z.strictObject({
  since: z.string().min(1),
  since_explicit: z.boolean(),
  max_commits: z.number().int().positive(),
  author: z.string().nullable(),
  include_bots: z.boolean(),
  path: z.string().nullable(),
  commit: z.string().nullable(),
  importance: z.boolean(),
});
const SeedEnrichmentBundleManifestEntrySchema = z.strictObject({
  filename: z.string().min(1),
  artifact_id: z.string().min(1),
  cluster_key: z.string().min(1),
  kind: z.enum(['merge', 'squash', 'run', 'release']),
  label: z.string().min(1),
  date: z.string().datetime(),
  commit_count: z.number().int().positive(),
  checkpoint_count: z.number().int().positive(),
  warnings: z.array(z.string()),
  nomination_count: z.number().int().nonnegative(),
  distinct_task_count: z.number().int().positive(),
});
export const SeedEnrichmentManifestSchema = z.strictObject({
  schema_version: z.literal(2),
  options_hash: z.string().min(1),
  selection: SeedSelectionRecordSchema.optional(),
  amendment: z
    .strictObject({
      artifact_id: z.string().min(1),
      prior_enrichment_event_id: z.string().min(1).nullable(),
      member_shas_hash: z.string().regex(/^[0-9a-f]{64}$/u),
      decision_mode: z.enum(['preserve', 'replace']),
      pr_context_consented: z.boolean(),
    })
    .optional(),
  bundles: z.array(SeedEnrichmentBundleManifestEntrySchema),
});
