import { z } from 'zod';

export const ArtifactOriginSchema = z.object({
  kind: z.literal('git-import'),
  imported_at: z.string().datetime(),
  tool_version: z.string().min(1),
  source_range: z.string().min(1),
  authors: z.array(z.string().min(1)),
  enriched_at: z.string().datetime().nullable(),
  cluster_key: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  member_shas_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  /**
   * The seed run that produced this artifact. Optional-absent so imports
   * written before the ledger existed keep their exact hashed content —
   * writers spread the key conditionally, never as a null.
   */
  job: z
    .object({
      job_id: z.string().min(1),
      kind: z.enum(['initial', 'importance', 'commit', 'path', 'resume']),
    })
    .optional(),
});

export type ArtifactOrigin = z.infer<typeof ArtifactOriginSchema>;
export type ArtifactOriginJob = NonNullable<ArtifactOrigin['job']>;
export type ArtifactOriginKind = ArtifactOrigin['kind'];
