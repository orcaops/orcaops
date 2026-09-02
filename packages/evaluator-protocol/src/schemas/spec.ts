import { z } from 'zod';

import {
  ContextSectionSchema,
  EngineCwdSchema,
  EvaluatorPhaseSchema,
  EvaluatorSeveritySchema,
  IdPatternRegex,
  LlmEffortSchema,
  LlmOutputFormatSchema,
  LlmProviderSchema,
  WhenLlmSchema,
} from './common.js';
import { EngineEnvPolicySchema } from './package.js';
import { isValidGlobSyntax } from '../glob.js';

/**
 * Zod schema for a single evaluator spec file (`*.eval.yaml`).
 *
 * Pinned to `orcaops.evaluator/v1`. Cross-field validation enforces
 * every invariant that can be decided from the spec alone — fields
 * that need pack-manifest defaults to resolve (e.g., a hard
 * requirement on `engine.timeout_ms`) are enforced in the resolution
 * layer, not here.
 */

const GlobPatternSchema = z
  .string()
  .refine(isValidGlobSyntax, { message: 'must be a valid glob pattern' });

/**
 * Per-stream cap for command evaluators. The default remains 1 MiB; 8 MiB is
 * enough for unusually verbose diagnostics while bounding two retained
 * streams and every downstream redaction pass.
 */
export const MAX_EVALUATOR_OUTPUT_BYTES = 8 * 1024 * 1024;

const CommandEngineSchema = z
  .object({
    kind: z.literal('command'),
    command: z.array(z.string().min(1)).min(1),
    cwd: EngineCwdSchema.default('package'),
    timeout_ms: z.number().int().positive().optional(),
    max_output_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_EVALUATOR_OUTPUT_BYTES)
      .default(1024 * 1024),
    env: EngineEnvPolicySchema.optional(),
    /**
     * Optional JSON Schema. When set, validates the OPTIONAL `raw`
     * field of the result envelope — never the envelope itself.
     */
    output_schema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const LlmEngineSchema = z
  .object({
    kind: z.literal('llm'),
    prompt_file: z.string().min(1),
    output_format: LlmOutputFormatSchema.default('markdown'),
    provider: LlmProviderSchema.optional(),
    model: z.string().min(1).optional(),
    effort: LlmEffortSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_cost_usd: z.number().positive().optional(),
    /**
     * Tool-access policy for the LLM run. Default `none` is a deny-all
     * posture; `command-filtered` offers Read/Grep/Glob plus selected git
     * inspection commands so a delivery-coverage evaluator can inspect a
     * diff. The Claude spawn boundary (`@orcaops/llm` arg builder) applies an
     * allowlist and a secret-path denylist. This is command filtering, not OS
     * sandboxing or workspace confinement. Reading files into a prompt sent
     * to an external API is a privacy-relevant capability, so a
     * `command-filtered` evaluator trips the
     * `file_reading_llm_evaluator_present` pack-trust warning.
     */
    tool_policy: z
      .object({ mode: z.enum(['none', 'command-filtered']).default('none') })
      .strict()
      .optional(),
    /**
     * Context sections this evaluator's prompt needs BEYOND the baseline.
     *
     * `[]` does NOT mean "no context leaves the repo" — every LLM evaluator
     * receives the baseline block (plan task, branch, phase, touched scope,
     * non-goals, plan steps, checkpoint summaries, changed files, summary
     * outcome). `[]` means "the baseline is enough."
     *
     * Required with no default, deliberately. A default-all would widen
     * egress for every evaluator without changing any pack fingerprint, so no
     * trust re-prompt would fire; a default-none would silently starve
     * evaluators that need the data. Both fail quietly. Requiring the field
     * makes each author choose, and each declared section is content sent to
     * the resolved effective provider.
     */
    additional_context_sections: z.array(ContextSectionSchema),
    /**
     * Optional JSON Schema. **Required** when `output_format: json` —
     * passed through to the LLM provider's structured-output mechanism
     * and validates the envelope's `raw` field after parse.
     */
    output_schema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  // Same contract as `EvaluatorSchema`'s superRefine below: a rule added here
  // needs a row in the refinement contract table and a line in the
  // author-evaluator skill body, because the emitted JSON Schema drops it.
  .superRefine((engine, ctx) => {
    if (engine.output_format === 'json' && engine.output_schema === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['output_schema'],
        message: '`output_schema` is required when `output_format: json`',
      });
    }
  });

export const EvaluatorEngineSchema = z.discriminatedUnion('kind', [
  CommandEngineSchema,
  LlmEngineSchema,
]);
export type EvaluatorEngine = z.infer<typeof EvaluatorEngineSchema>;

export const EvaluatorFiltersSchema = z
  .object({
    paths: z.array(GlobPatternSchema).default([]),
    scopes: z.array(z.string().min(1)).default([]),
    when_llm: WhenLlmSchema.default('optional'),
  })
  .strict();
export type EvaluatorFilters = z.infer<typeof EvaluatorFiltersSchema>;

export const EvaluatorResolutionSchema = z
  .object({
    acknowledge: z
      .object({
        enabled: z.boolean().default(false),
        label: z.string().min(1).optional(),
      })
      .strict()
      .prefault({}),
    policy_exception: z
      .object({
        enabled: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type EvaluatorResolution = z.infer<typeof EvaluatorResolutionSchema>;

export const EvaluatorFingerprintSchema = z
  .object({
    include: z.array(GlobPatternSchema).default([]),
  })
  .strict();
export type EvaluatorFingerprint = z.infer<typeof EvaluatorFingerprintSchema>;

export const EvaluatorSchema = z
  .object({
    schema: z.literal('orcaops.evaluator/v1'),
    id: z.string().regex(IdPatternRegex, 'id must be kebab-case (lowercase alphanumeric + hyphen)'),
    phase: EvaluatorPhaseSchema,
    severity: EvaluatorSeveritySchema,
    /**
     * When `false`, `eval add-pack` seeds this evaluator DISABLED even
     * under a profile that would otherwise enable it (e.g. `--profile
     * llm/all`). Turning it on then becomes its own explicit act. Ships a
     * file-reading evaluator (`step-coverage`) off by default so "opted
     * into core" never silently means "opted into an LLM that reads the
     * worktree into a prompt sent to an external API." Defaults to `true`
     * — an evaluator is enable-eligible unless it opts out.
     */
    default_enabled: z.boolean().default(true),
    description: z.string().min(1).optional(),
    description_file: z.string().min(1).optional(),
    engine: EvaluatorEngineSchema,
    params_schema: z.record(z.string(), z.unknown()).optional(),
    params: z.record(z.string(), z.unknown()).default({}),
    filters: EvaluatorFiltersSchema.prefault({}),
    resolution: EvaluatorResolutionSchema.prefault({}),
    fingerprint: EvaluatorFingerprintSchema.prefault({}),
    on_block_message: z.string().min(1).optional(),
  })
  .strict()
  // ADDING A RULE HERE? Add a row to the refinement contract table in
  // `apps/orcaops-cli/tests/integration/author-evaluator-skill-contract.test.ts`
  // and teach it in the author-evaluator skill body. None of these survive
  // `z.toJSONSchema`, so `orcaops eval schema spec` cannot show an author a
  // rule that lives only here — and zod cannot enumerate superRefine bodies, so
  // a new rule with no table row and no skill coverage passes every test.
  .superRefine((spec, ctx) => {
    // Description: exactly one of `description` / `description_file`.
    const hasInline = spec.description !== undefined;
    const hasFile = spec.description_file !== undefined;
    if (!hasInline && !hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['description'],
        message:
          'exactly one of `description` or `description_file` must be set (inline string or path to a markdown file)',
      });
    } else if (hasInline && hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['description_file'],
        message:
          'set exactly one of `description` (inline) or `description_file` (path) — not both',
      });
    }

    // severity=block ⇒ on_block_message required.
    if (spec.severity === 'block' && (spec.on_block_message ?? '').length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['on_block_message'],
        message: '`on_block_message` is required when severity is `block`',
      });
    }
    // severity != block ⇒ on_block_message must be absent. Surfacing a
    // block-only field on an info/warn evaluator usually indicates a
    // copy-paste bug; reject loudly.
    if (spec.severity !== 'block' && spec.on_block_message !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['on_block_message'],
        message:
          '`on_block_message` is only allowed when severity is `block` (got severity=' +
          spec.severity +
          ')',
      });
    }

    // checkpoint-open evaluators must use the command engine.
    if (spec.phase === 'checkpoint-open' && spec.engine.kind !== 'command') {
      ctx.addIssue({
        code: 'custom',
        path: ['engine', 'kind'],
        message:
          "`phase: checkpoint-open` requires `engine.kind: command` — open is on the agent's hot path and cannot afford an LLM call",
      });
    }
  });
export type Evaluator = z.infer<typeof EvaluatorSchema>;
