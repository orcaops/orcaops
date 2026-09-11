import { z } from 'zod';
export const SourceRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    locator: z.string().min(1),
    version: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('cloud'),
    locator: z.string().min(1),
    version: z.string().min(1),
    base_url: z.string().min(1),
    org_id: z.string().min(1),
  }),
]);
export type SourceRef = z.infer<typeof SourceRefSchema>;
export const SourcePlanBaselineSchema = z.object({
  repo_url: z.string().nullable(),
  branch: z.string().nullable(),
  head_sha: z.string().nullable(),
});
export type SourcePlanBaseline = z.infer<typeof SourcePlanBaselineSchema>;
function normalizeBaseline(b: SourcePlanBaseline | null): SourcePlanBaseline | null {
  if (b === null) return null;
  const emptyToNull = (v: string | null): string | null =>
    v !== null && v.trim().length > 0 ? v : null;
  const norm = {
    repo_url: emptyToNull(b.repo_url),
    branch: emptyToNull(b.branch),
    head_sha: emptyToNull(b.head_sha),
  };
  if (norm.repo_url === null && norm.branch === null && norm.head_sha === null) return null;
  return norm;
}
export const SourcePlanPinSchema = z.object({
  source_ref: SourceRefSchema,
  content: z.string().refine((s) => s.trim().length > 0, {
    message: 'source plan content must not be empty',
  }),
  hash: z.string().min(1),
  baseline: SourcePlanBaselineSchema.nullable().transform(normalizeBaseline),
});
export type SourcePlanPin = z.infer<typeof SourcePlanPinSchema>;
