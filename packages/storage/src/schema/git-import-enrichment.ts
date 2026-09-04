import { z } from 'zod';

import { DecisionBaseSchema, GitCommitDecisionEvidenceSchema } from './decision.js';
import { PlanLabelSchema, PlanStepLabelSchema } from './plan.js';
import { proseText } from '../text/control-chars.js';

export const GitImportEnrichmentDecisionSchema = z.strictObject({
  ...DecisionBaseSchema.shape,
  revision_n: z.literal(0),
  evidence: GitCommitDecisionEvidenceSchema,
});

export const GitImportEnrichmentDecisionModeSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('preserve') }),
  z.strictObject({
    mode: z.literal('replace'),
    decisions: z.array(GitImportEnrichmentDecisionSchema),
  }),
]);

export const GitImportEnrichmentPayloadSchema = z.strictObject({
  provenance_version: z.literal(1),
  artifact_id: z.string().min(1),
  cluster_key: z.string().regex(/^[0-9a-f]{64}$/u),
  member_shas_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  enriched_at: z.string().datetime(),
  prior_enrichment_event_id: z.string().min(1).nullable(),
  label: PlanLabelSchema,
  task: proseText(),
  steps: z.array(
    z.strictObject({
      label: PlanStepLabelSchema,
      text: proseText(),
    })
  ),
  checkpoint_summaries: z.array(
    z.strictObject({
      n: z.number().int().positive(),
      summary: proseText(),
    })
  ),
  outcome: proseText(),
  decisions: GitImportEnrichmentDecisionModeSchema,
});

export type GitImportEnrichmentPayload = z.infer<typeof GitImportEnrichmentPayloadSchema>;
