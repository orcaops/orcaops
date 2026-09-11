import { z } from 'zod';

import { CounterSchema, DigestSchema } from './event-integrity.js';
import { canonicalJson } from '../events/canonical-json.js';
import { UuidV7Schema } from '../ids/uuidv7.js';

export const ArtifactLifecycleRowSchema = z.object({
  fires_at: z.enum([
    'post-plan',
    'post-plan-revision',
    'checkpoint-open',
    'checkpoint-close',
    'pre-pr',
  ]),
  cp_n: CounterSchema,
  triggered_at: z.string().min(1),
  execution_context_hash: DigestSchema.optional(),
});
export type ArtifactLifecycleRow = z.infer<typeof ArtifactLifecycleRowSchema>;
export const ArtifactAttemptRowSchema = z.strictObject({
  artifact_id: UuidV7Schema,
  idempotency_key: z.string().min(1),
  event_type: z.string().min(1),
  outcome: z.enum(['soft_blocked', 'hard_rejected']),
  payload_hash: DigestSchema,
  evaluator_fingerprint: z.string().nullable(),
  envelope: z.string().nullable(),
  recorded_at: z.string().min(1),
});
export type ArtifactAttemptRow = z.infer<typeof ArtifactAttemptRowSchema>;

export function artifactLifecycleKey(row: Pick<ArtifactLifecycleRow, 'fires_at' | 'cp_n'>): string {
  return canonicalJson([row.fires_at, row.cp_n]);
}
