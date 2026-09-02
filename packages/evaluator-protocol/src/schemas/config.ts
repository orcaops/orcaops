import { z } from 'zod';

import { EvaluatorSeveritySchema, IdPatternRegex } from './common.js';

/**
 * Zod schema for `.orcaops/evaluators.yaml`. Pinned to
 * `orcaops.evaluator_config/v2`. This file is the authoritative list
 * of what runs — an evaluator runs iff it has an `evaluators[<ref>]`
 * entry with `enabled: true`.
 */

const RuntimeSchema = z
  .object({
    max_concurrent: z.number().int().positive().default(4),
  })
  .strict();
export type EvaluatorConfigRuntime = z.infer<typeof RuntimeSchema>;

/**
 * Permissive npm package specifier (e.g., `@orcaops/evaluator-pack`,
 * `@acme/orcaops-pack`, `my-pack`). Not a full npm-name regex — just
 * non-empty and free of obvious garbage. The resolver does the real
 * validation when it tries to `require.resolve` the package.
 */
const PackageSpecifierSchema = z
  .string()
  .min(1)
  .regex(
    /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/i,
    'must be an npm package specifier (e.g., "@orcaops/evaluator-pack" or "my-pack")'
  );

/**
 * Pack source descriptor. Three kinds:
 *   - bundled: resolved from @orcaops/cli's own dependencies
 *     (first-party packs ship with the CLI; no install step at
 *     `eval add-pack` time)
 *   - path: resolved from a local directory (explicit fork via
 *     `eval fork-pack`; editable; user owns updates)
 *   - package: resolved from the user's project dependency graph
 *     (third-party packs; install via `pnpm add -D` first)
 */
const BundledSourceSchema = z
  .object({
    kind: z.literal('bundled'),
    package: PackageSpecifierSchema,
    pack: z
      .string()
      .regex(IdPatternRegex, 'pack must be kebab-case (lowercase alphanumeric + hyphen)'),
  })
  .strict();

const PathSourceSchema = z
  .object({
    kind: z.literal('path'),
    path: z.string().min(1),
  })
  .strict();

const PackageSourceSchema = z
  .object({
    kind: z.literal('package'),
    package: PackageSpecifierSchema,
    pack: z
      .string()
      .regex(IdPatternRegex, 'pack must be kebab-case (lowercase alphanumeric + hyphen)'),
  })
  .strict();

export const PackSourceSchema = z.discriminatedUnion('kind', [
  BundledSourceSchema,
  PathSourceSchema,
  PackageSourceSchema,
]);
export type PackSource = z.infer<typeof PackSourceSchema>;

const PackageEntrySchema = z
  .object({
    id: z.string().regex(IdPatternRegex, 'id must be kebab-case (lowercase alphanumeric + hyphen)'),
    source: PackSourceSchema,
  })
  .strict();
export type EvaluatorConfigPackageEntry = z.infer<typeof PackageEntrySchema>;

/**
 * Per-ref override entry under `evaluators:`. `enabled` is required
 * (the explicit signal — there is no implicit default). `severity`,
 * `params`, and `engine` are optional overrides on top of the pack-shipped
 * spec. Engine fields are validated against the resolved evaluator kind.
 */
const EvaluatorEngineOverrideSchema = z
  .object({
    provider: z.enum(['claude', 'codex']).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const EvaluatorOverrideSchema = z
  .object({
    enabled: z.boolean(),
    severity: EvaluatorSeveritySchema.optional(),
    engine: EvaluatorEngineOverrideSchema.optional(),
    /**
     * Replace semantics — the resolution layer substitutes the entire
     * `params` object, not a deep-merge.
     */
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type EvaluatorOverride = z.infer<typeof EvaluatorOverrideSchema>;

/**
 * Reference key shape: `<pack-id>/<evaluator-id>`. Both sides match
 * the kebab-case `IdPatternRegex` from common.ts.
 */
export const EvaluatorRefRegex = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/**
 * Branded `EvaluatorRef` type. A plain `string` whose value has been
 * validated against `EvaluatorRefRegex`. Use this in API surfaces
 * that consume a resolved ref to make ref/non-ref confusions a
 * compile-time error.
 *
 * The brand is structural-only (TypeScript erases at runtime); use
 * `EvaluatorRefRegex.test(s)` to runtime-validate, then cast through
 * `as EvaluatorRef` if you're certain.
 */
export type EvaluatorRef = string & { readonly __brand: 'EvaluatorRef' };

const EvaluatorsRecordSchema = z.record(
  z.string().regex(EvaluatorRefRegex, 'evaluator key must be "<pack-id>/<evaluator-id>"'),
  EvaluatorOverrideSchema
);

export const EvaluatorConfigSchema = z
  .object({
    schema: z.literal('orcaops.evaluator_config/v2'),
    runtime: RuntimeSchema.prefault({}),
    packages: z.array(PackageEntrySchema).default([]),
    evaluators: EvaluatorsRecordSchema.default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Package IDs must be unique within the config.
    const seenIds = new Map<string, number>();
    for (const [i, entry] of cfg.packages.entries()) {
      const prior = seenIds.get(entry.id);
      if (prior !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['packages', i, 'id'],
          message: `duplicate package id "${entry.id}" (first declared at packages[${prior}])`,
        });
      } else {
        seenIds.set(entry.id, i);
      }
    }
    // Every evaluator-ref's pack-id prefix must reference a declared
    // package. Catches typos at parse time instead of letting them
    // surface as silent "evaluator not found" during a capture.
    const declaredPackIds = new Set(cfg.packages.map((p) => p.id));
    for (const ref of Object.keys(cfg.evaluators)) {
      const slash = ref.indexOf('/');
      if (slash === -1) continue; // regex above already caught it
      const packId = ref.slice(0, slash);
      if (!declaredPackIds.has(packId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evaluators', ref],
          message:
            `evaluator ref "${ref}" references undeclared pack "${packId}" ` +
            `(known: [${[...declaredPackIds].join(', ')}])`,
        });
      }
    }
  });
export type EvaluatorConfig = z.infer<typeof EvaluatorConfigSchema>;
