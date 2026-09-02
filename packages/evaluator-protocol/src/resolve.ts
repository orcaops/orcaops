import { existsSync } from 'node:fs';
import path from 'node:path';

import { assertResolvedWithin, PathContainmentError } from './containment.js';
import type {
  ContextSection,
  EvaluatorEngineKind,
  EvaluatorPhase,
  EvaluatorSeverity,
  LlmEffort,
  LlmOutputFormat,
  LlmProvider,
  WhenLlm,
} from './schemas/common.js';
import type { EvaluatorConfig, EvaluatorOverride } from './schemas/config.js';
import type { EvaluatorPackage } from './schemas/package.js';
import type { Evaluator } from './schemas/spec.js';

/**
 * The merged, validated, immutable view of an evaluator after
 * combining its spec, the pack manifest defaults, and the repo
 * config overrides. Returned by `resolveEvaluator()`.
 *
 * Companion paths (`engine.command[0]` when relative,
 * `engine.prompt_file`) are joined against the pack root but NOT
 * stat'd here — the resolution layer is a pure transform. The
 * runner's discovery stage verifies file existence before dispatch.
 */
export interface ResolvedEvaluator {
  /** `<pack-id>/<evaluator-id>`. */
  ref: string;
  package_id: string;
  evaluator_id: string;
  /** Absolute path to the pack root (directory containing `package.yaml`). */
  package_root: string;
  /** Absolute path to the spec file (`<id>.eval.yaml`). */
  spec_path: string;

  phase: EvaluatorPhase;
  severity: EvaluatorSeverity;
  description: string;
  on_block_message?: string;

  engine: ResolvedCommandEngine | ResolvedLlmEngine;

  params_schema?: Record<string, unknown>;
  params: Record<string, unknown>;

  filters: ResolvedFilters;
  resolution: ResolvedResolution;

  /**
   * Glob patterns from `fingerprint.include`, NOT yet expanded to
   * absolute file paths — that requires fs access and happens in the
   * runner's fingerprinting stage. The pack root is provided
   * separately as `package_root` so the runner can resolve these
   * against it.
   */
  fingerprint_include: string[];

  /**
   * Whether the evaluator runs (per the repo config). False when the
   * config has no entry for this ref OR when the entry sets
   * `enabled: false`.
   */
  enabled: boolean;
}

export interface ResolvedCommandEngine {
  kind: 'command';
  /**
   * Argv array. `command[0]` is resolved to an absolute path against
   * the pack root iff it began with `./` or `../`. Bare commands
   * (e.g. `python3`) and absolute paths pass through unchanged.
   */
  command: string[];
  cwd: 'package' | 'repo';
  timeout_ms: number;
  max_output_bytes: number;
  env: { inherit: string[]; set: Record<string, string> };
  output_schema?: Record<string, unknown>;
}

export interface ResolvedLlmEngine {
  kind: 'llm';
  /** Absolute path to the prompt file. */
  prompt_file: string;
  output_format: LlmOutputFormat;
  provider?: LlmProvider;
  model?: string | null;
  effort?: LlmEffort;
  timeout_ms: number;
  max_cost_usd?: number;
  /** Tool-access policy for the LLM run; absent ⇒ deny-all (`none`). */
  tool_policy?: { mode: 'none' | 'command-filtered' };
  /**
   * Context sections beyond the baseline this evaluator's prompt receives.
   * Pack-author-owned like `tool_policy`: there is deliberately no consumer
   * override for it, so it carries no `selection_sources` entry.
   */
  additional_context_sections: ContextSection[];
  output_schema?: Record<string, unknown>;
  selection_sources?: {
    provider: 'user-override' | 'pack-spec' | 'global';
    model: 'user-override' | 'pack-spec' | 'global';
    timeout_ms: 'user-override' | 'pack-spec' | 'pack-default';
  };
}

export interface ResolvedFilters {
  paths: string[];
  scopes: string[];
  when_llm: WhenLlm;
}

export interface ResolvedResolution {
  acknowledge: { enabled: boolean; label?: string };
  policy_exception: { enabled: boolean };
}

/**
 * Thrown by `resolveEvaluator()` when a cross-source invariant
 * fails. Carries the spec path and the dotted field path so the
 * runner can surface a precise diagnostic.
 */
export class EvaluatorResolveError extends Error {
  override readonly name = 'EvaluatorResolveError';
  readonly spec_path: string;
  readonly field_path: string;
  /**
   * Stable diagnostic code. Propagates through
   * `EvaluatorDiscoveryError.code` for `eval list --strict` / `doctor`
   * surfaces. Known codes:
   *   - `params_schema_invalid` — repo-config override params failed
   *     Ajv validation against the spec's `params_schema`.
   */
  readonly code?: string;
  override readonly cause?: unknown;

  constructor(opts: {
    spec_path: string;
    field_path: string;
    message: string;
    code?: string;
    cause?: unknown;
  }) {
    super(`${path.basename(opts.spec_path)}: ${opts.field_path}: ${opts.message}`);
    this.spec_path = opts.spec_path;
    this.field_path = opts.field_path;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export interface ResolveEvaluatorInput {
  /** Parsed spec from `<pack>/evaluators/<id>.eval.yaml`. */
  spec: Evaluator;
  /** Parsed manifest from `<pack>/package.yaml`. */
  package_manifest: EvaluatorPackage;
  /** Absolute path to the pack root (directory containing `package.yaml`). */
  package_root: string;
  /** Absolute path to the spec file. */
  spec_path: string;
  /**
   * Resolved description string. Caller resolves `spec.description`
   * (inline) or reads `spec.description_file` from disk before
   * invoking the resolver — keeps this transform pure.
   */
  description: string;
  /**
   * Override entry from `.orcaops/evaluators.yaml` for this ref.
   * Undefined when the config has no entry — un-listed evaluators are
   * disabled, so the resolved evaluator is then `enabled: false`.
   */
  override?: EvaluatorOverride;
  /**
   * Optional injected JSON Schema validator. Called with the
   * resolved `params` and the spec's `params_schema` when both are
   * present. Should throw on validation failure (the resolver
   * wraps the throw in EvaluatorResolveError). When omitted,
   * params-schema validation is skipped — the runner package
   * supplies an ajv-backed validator.
   */
  validate_params?: (params: Record<string, unknown>, schema: Record<string, unknown>) => void;
}

/**
 * Spec → ResolvedEvaluator transform. It performs no network access, but
 * canonicalizes pack-file paths against the current filesystem so symlink
 * containment is part of the resolved evaluator.
 *
 * Resolution order:
 *   1. Start with spec values.
 *   2. Apply pack manifest defaults for `timeout_ms` and `env.inherit`.
 *   3. Apply repo config overrides for `severity`, `params`, and supported
 *      LLM engine fields
 *      (replace semantics — `params` is one atomic value, not a
 *      deep merge).
 *   4. Validate `params` against `params_schema` (post-override) via
 *      the injected validator.
 *   5. Resolve companion paths against the pack root.
 */
export function resolveEvaluator(input: ResolveEvaluatorInput): ResolvedEvaluator {
  const { spec, package_manifest, package_root, spec_path, override } = input;

  const ref = `${package_manifest.id}/${spec.id}`;
  const enabled = override?.enabled === true;
  const severity = override?.severity ?? spec.severity;
  const params = override?.params ?? spec.params;

  if (spec.params_schema !== undefined && input.validate_params !== undefined) {
    try {
      input.validate_params(params, spec.params_schema);
    } catch (err) {
      throw new EvaluatorResolveError({
        spec_path,
        field_path: 'params',
        message:
          'params failed validation against `params_schema`: ' +
          (err instanceof Error ? err.message : String(err)),
        code: 'params_schema_invalid',
        cause: err,
      });
    }
  }

  if (spec.engine.kind === 'command' && override?.engine !== undefined) {
    throw new EvaluatorResolveError({
      spec_path,
      field_path: 'engine',
      message: 'repo config `engine` overrides are only valid for LLM evaluators',
    });
  }

  const engine =
    spec.engine.kind === 'command'
      ? resolveCommandEngine(spec, package_manifest, package_root, spec_path)
      : resolveLlmEngine(spec, package_manifest, package_root, spec_path, override?.engine);

  return {
    ref,
    package_id: package_manifest.id,
    evaluator_id: spec.id,
    package_root,
    spec_path,
    phase: spec.phase,
    severity,
    description: input.description,
    ...(spec.on_block_message !== undefined ? { on_block_message: spec.on_block_message } : {}),
    engine,
    ...(spec.params_schema !== undefined ? { params_schema: spec.params_schema } : {}),
    params,
    filters: {
      paths: [...spec.filters.paths],
      scopes: [...spec.filters.scopes],
      when_llm: spec.filters.when_llm,
    },
    resolution: {
      acknowledge: {
        enabled: spec.resolution.acknowledge.enabled,
        ...(spec.resolution.acknowledge.label !== undefined
          ? { label: spec.resolution.acknowledge.label }
          : {}),
      },
      policy_exception: { enabled: spec.resolution.policy_exception.enabled },
    },
    fingerprint_include: [...spec.fingerprint.include],
    enabled,
  };
}

function resolveCommandEngine(
  spec: Evaluator,
  manifest: EvaluatorPackage,
  package_root: string,
  spec_path: string
): ResolvedCommandEngine {
  if (spec.engine.kind !== 'command') {
    // Type-narrow — caller already branched on kind. Defense in depth.
    throw new Error('resolveCommandEngine called with non-command engine');
  }
  const e = spec.engine;
  const timeout_ms = e.timeout_ms ?? manifest.defaults.timeout_ms;
  if (timeout_ms === undefined) {
    throw new EvaluatorResolveError({
      spec_path,
      field_path: 'engine.timeout_ms',
      message:
        'no `timeout_ms` on the engine and no `defaults.timeout_ms` on the pack manifest — one of them is required',
    });
  }

  const inherit = e.env?.inherit ?? manifest.defaults.env?.inherit ?? [];
  const set = e.env?.set ?? {};

  const command = [
    resolveExecutableArg(e.command[0], package_root, spec_path),
    ...e.command.slice(1),
  ];

  return {
    kind: 'command',
    command,
    cwd: e.cwd,
    timeout_ms,
    max_output_bytes: e.max_output_bytes,
    env: {
      inherit: [...inherit],
      set: { ...set },
    },
    ...(e.output_schema !== undefined ? { output_schema: e.output_schema } : {}),
  };
}

function resolveLlmEngine(
  spec: Evaluator,
  manifest: EvaluatorPackage,
  package_root: string,
  spec_path: string,
  override?: EvaluatorOverride['engine']
): ResolvedLlmEngine {
  if (spec.engine.kind !== 'llm') {
    throw new Error('resolveLlmEngine called with non-llm engine');
  }
  const e = spec.engine;
  const timeout_ms = override?.timeout_ms ?? e.timeout_ms ?? manifest.defaults.timeout_ms;
  if (timeout_ms === undefined) {
    throw new EvaluatorResolveError({
      spec_path,
      field_path: 'engine.timeout_ms',
      message:
        'no `timeout_ms` on the engine and no `defaults.timeout_ms` on the pack manifest — one of them is required',
    });
  }

  const prompt_file = resolvePackInput(
    e.prompt_file,
    package_root,
    spec_path,
    'engine.prompt_file'
  );

  return {
    kind: 'llm',
    prompt_file,
    output_format: e.output_format,
    ...(override !== undefined && Object.hasOwn(override, 'provider')
      ? override.provider !== null
        ? { provider: override.provider }
        : {}
      : e.provider !== undefined
        ? { provider: e.provider }
        : {}),
    ...(override !== undefined && Object.hasOwn(override, 'model')
      ? { model: override.model ?? null }
      : e.model !== undefined
        ? { model: e.model }
        : {}),
    ...(e.effort !== undefined ? { effort: e.effort } : {}),
    timeout_ms,
    ...(e.max_cost_usd !== undefined ? { max_cost_usd: e.max_cost_usd } : {}),
    ...(e.tool_policy !== undefined ? { tool_policy: e.tool_policy } : {}),
    additional_context_sections: [...e.additional_context_sections],
    ...(e.output_schema !== undefined ? { output_schema: e.output_schema } : {}),
    selection_sources: {
      provider:
        override !== undefined && Object.hasOwn(override, 'provider')
          ? 'user-override'
          : e.provider !== undefined
            ? 'pack-spec'
            : 'global',
      model:
        override !== undefined && Object.hasOwn(override, 'model')
          ? 'user-override'
          : e.model !== undefined
            ? 'pack-spec'
            : 'global',
      timeout_ms:
        override?.timeout_ms !== undefined
          ? 'user-override'
          : e.timeout_ms !== undefined
            ? 'pack-spec'
            : 'pack-default',
    },
  };
}

/**
 * Resolve `command[0]` against the pack root iff it's an explicit
 * relative path (`./...` or `../...`). Bare commands like `python3`
 * (PATH-resolved at exec time) and absolute paths pass through
 * unchanged.
 */
function resolveExecutableArg(arg: string, package_root: string, spec_path: string): string {
  if (path.isAbsolute(arg)) return arg;
  if (arg.startsWith('./') || arg.startsWith('../')) {
    return resolvePackInput(arg, package_root, spec_path, 'engine.command.0');
  }
  return arg;
}

function resolvePackInput(
  value: string,
  packageRoot: string,
  specPath: string,
  fieldPath: string
): string {
  const target = path.isAbsolute(value) ? value : path.resolve(packageRoot, value);
  if (!existsSync(packageRoot)) {
    const rel = path.relative(path.resolve(packageRoot), target);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new EvaluatorResolveError({
        spec_path: specPath,
        field_path: fieldPath,
        message: `${fieldPath} resolves outside the pack root (${packageRoot})`,
        code: 'path_escapes_pack',
      });
    }
    return target;
  }
  try {
    return assertResolvedWithin(target, packageRoot, fieldPath);
  } catch (err) {
    if (!(err instanceof PathContainmentError)) throw err;
    throw new EvaluatorResolveError({
      spec_path: specPath,
      field_path: fieldPath,
      message: err.message,
      code: 'path_escapes_pack',
      cause: err,
    });
  }
}

/**
 * Aggregate-level invariants checked across a config + pack list.
 * The runner's discovery stage calls this once it has the full
 * (config, packs, specs) tuple in hand.
 *
 * Currently flags:
 *   - resolved-ref uniqueness across all packs (a tautology if pack
 *     IDs are unique and evaluator IDs are unique within each pack,
 *     but worth a defense-in-depth check)
 */
export function assertUniqueRefs(refs: readonly string[]): void {
  const seen = new Map<string, number>();
  for (const [i, ref] of refs.entries()) {
    const prior = seen.get(ref);
    if (prior !== undefined) {
      throw new EvaluatorResolveError({
        spec_path: '<aggregate>',
        field_path: `evaluators[${i}].ref`,
        message: `duplicate evaluator ref "${ref}" (first declared at index ${prior})`,
      });
    }
    seen.set(ref, i);
  }
}

/**
 * Build a quick `ref → override?` lookup from a parsed config. Used
 * by the runner discovery stage to pair each spec with its override
 * (or undefined) before calling `resolveEvaluator`.
 */
export function overridesByRef(config: EvaluatorConfig): ReadonlyMap<string, EvaluatorOverride> {
  return new Map(Object.entries(config.evaluators));
}

/**
 * Re-export common engine-kind tag for callers that want to branch
 * on the engine without importing from `./schemas/common.js`
 * directly.
 */
export type { EvaluatorEngineKind };
