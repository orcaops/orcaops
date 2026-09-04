import { createHash } from 'node:crypto';
import { z } from 'zod';

const FullGitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export function canonicalMemberShas(shas: readonly string[]): string[] {
  return [...new Set(shas.map((sha) => FullGitShaSchema.parse(sha.toLowerCase())))].sort();
}

export function computeMemberShasHash(shas: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalMemberShas(shas)))
    .digest('hex');
}

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
  member_shas: z
    .array(FullGitShaSchema)
    .min(1)
    .refine(
      (shas) => JSON.stringify(shas) === JSON.stringify(canonicalMemberShas(shas)),
      'must be unique and sorted'
    )
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
