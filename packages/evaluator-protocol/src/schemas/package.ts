import { z } from 'zod';

import { IdPatternRegex } from './common.js';

/**
 * Env policy applied at the engine layer. `inherit` is the allowlist
 * of process env vars that pass through to subprocesses; `set` adds
 * explicit values.
 *
 * Fields are intentionally `.optional()` (no schema-level defaults)
 * so the resolution layer can distinguish "spec didn't set this"
 * from "spec set it to empty" — that's the seam that lets pack
 * manifest defaults cascade only when the spec is silent.
 */
export const EngineEnvPolicySchema = z
  .object({
    inherit: z.array(z.string().min(1)).optional(),
    set: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type EngineEnvPolicy = z.infer<typeof EngineEnvPolicySchema>;

/**
 * Pack-level defaults that flow into every evaluator in the pack
 * when the spec doesn't override the matching field. Currently
 * `timeout_ms` and `env.inherit`.
 */
export const EvaluatorPackageDefaultsSchema = z
  .object({
    timeout_ms: z.number().int().positive().optional(),
    env: z
      .object({
        inherit: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EvaluatorPackageDefaults = z.infer<typeof EvaluatorPackageDefaultsSchema>;

/**
 * Free-form pack metadata. `owner`, `tags`, `homepage` are
 * conventional but not validated beyond shape; packs can ship
 * additional keys (recorded as-is) — `strict: false`.
 */
export const EvaluatorPackageMetadataSchema = z
  .object({
    owner: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    homepage: z.string().url().optional(),
  })
  .loose();
export type EvaluatorPackageMetadata = z.infer<typeof EvaluatorPackageMetadataSchema>;

/**
 * Zod schema for a pack's `package.yaml`. Pinned to
 * `orcaops.evaluator_package/v1`; future schema bumps are explicit.
 */
export const EvaluatorPackageSchema = z
  .object({
    schema: z.literal('orcaops.evaluator_package/v1'),
    id: z.string().regex(IdPatternRegex, 'id must be kebab-case (lowercase alphanumeric + hyphen)'),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    evaluator_dir: z.string().min(1).default('./evaluators'),
    defaults: EvaluatorPackageDefaultsSchema.prefault({}),
    metadata: EvaluatorPackageMetadataSchema.prefault({}),
  })
  .strict();
export type EvaluatorPackage = z.infer<typeof EvaluatorPackageSchema>;
