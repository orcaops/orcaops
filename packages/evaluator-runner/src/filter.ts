import {
  type EvaluatorContext,
  type EvaluatorRunPayload,
  matchesAnyGlob,
  type ResolvedEvaluator,
} from '@orcaops/evaluator-protocol';
import { scrubEvaluatorDiagnosticAndBound } from '@orcaops/evaluator-protocol/secrets';

const MAX_PERSISTED_SKIP_REASON_CHARS = 4096;

export interface ResolvedProviderAvailability {
  provider: 'claude' | 'codex';
  available: boolean;
  source: string;
}

/**
 * Filter gates. Each predicate returns the
 * skip reason as a human-readable string when the evaluator should
 * be filtered out, or `null` when it should run.
 *
 * The runtime composes these via `shouldSkipEvaluator` and packs
 * a `run_status: 'skipped'` payload when any gate fires.
 */

/**
 * Returns the skip reason for `filters.paths` (or null when the
 * evaluator should run on path grounds):
 *   - Empty / omitted `paths` → no path gating; evaluator runs.
 *   - Non-empty patterns + empty `changed_files` → skip (the
 *     evaluator declares it cares about changed files but there
 *     aren't any).
 *   - Non-empty patterns + at least one changed file matches any
 *     pattern → run.
 *   - Non-empty patterns + no changed file matches → skip.
 */
export function shouldSkipForPaths(
  evaluator: ResolvedEvaluator,
  changedFiles: readonly string[]
): string | null {
  const patterns = evaluator.filters.paths;
  if (patterns.length === 0) return null;
  if (changedFiles.length === 0) {
    return (
      `filters.paths declared (${patterns.length} pattern${patterns.length === 1 ? '' : 's'}) ` +
      `but no files changed`
    );
  }
  const anyMatch = changedFiles.some((f) => matchesAnyGlob(f, patterns));
  if (anyMatch) return null;
  return `no changed file matches filters.paths`;
}

/**
 * Returns the skip reason for `filters.scopes` (or null when the
 * evaluator should run). Skip iff the evaluator declares scopes
 * AND none of them appear in `plan.touched_scope`.
 */
export function shouldSkipForScopes(
  evaluator: ResolvedEvaluator,
  touchedScope: readonly string[]
): string | null {
  const scopes = evaluator.filters.scopes;
  if (scopes.length === 0) return null;
  const overlaps = scopes.some((s) => touchedScope.includes(s));
  if (overlaps) return null;
  return `filters.scopes [${scopes.join(', ')}] disjoint from plan.touched_scope`;
}

/**
 * Returns the skip reason for `filters.when_llm` (or null when the
 * evaluator should run on LLM-availability grounds):
 *   - LLM engine + no provider → always skip; no evaluator may receive a
 *     verdict without executing its declared engine.
 *   - `required` → skip when no LLM is configured (the
 *     LLMClient.isDeterministic flag is true). This also gates command
 *     evaluators that require LLM availability.
 *   - `absent` → skip when an LLM IS configured.
 *   - `optional` (default) → otherwise eligible.
 */
export function shouldSkipForLlmAvailability(
  evaluator: ResolvedEvaluator,
  llmIsDeterministic: boolean,
  providerAvailability?: ResolvedProviderAvailability
): string | null {
  if (evaluator.engine.kind === 'llm' && llmIsDeterministic) {
    return 'LLM evaluator skipped because no LLM provider executed';
  }
  if (
    providerAvailability?.available === false &&
    (evaluator.engine.kind === 'llm' || evaluator.filters.when_llm === 'required')
  ) {
    return (
      `resolved provider ${providerAvailability.provider} is not installed ` +
      `(${providerAvailability.source})`
    );
  }
  if (providerAvailability?.available === false && evaluator.filters.when_llm === 'absent') {
    return null;
  }
  const gate = evaluator.filters.when_llm;
  if (gate === 'optional') return null;
  if (gate === 'required' && llmIsDeterministic) {
    return 'filters.when_llm=required but no LLM provider is configured';
  }
  if (gate === 'absent' && !llmIsDeterministic) {
    return 'filters.when_llm=absent but an LLM provider is configured';
  }
  return null;
}

/**
 * Compose all three filter gates. Returns the skip reason on the
 * FIRST gate that fires (paths → scopes → LLM availability), or `null`
 * when the evaluator should run.
 */
export function shouldSkipEvaluator(
  evaluator: ResolvedEvaluator,
  context: EvaluatorContext,
  llmIsDeterministic: boolean,
  providerAvailability?: ResolvedProviderAvailability
): string | null {
  return (
    shouldSkipForPaths(evaluator, context.changed_files) ??
    shouldSkipForScopes(evaluator, context.plan.touched_scope) ??
    shouldSkipForLlmAvailability(evaluator, llmIsDeterministic, providerAvailability)
  );
}

/**
 * Pack a `run_status: 'skipped'` EvaluatorRunPayload for an
 * evaluator that didn't pass the filter gates. Skipped runs are
 * persisted with a body describing the skip reason so doctor
 * analytics can surface "evaluator X has been skipped 80% of the
 * time."
 */
export function makeSkippedRun(opts: {
  evaluator: ResolvedEvaluator;
  context: EvaluatorContext;
  run_id: string;
  reason: string;
  provider?: 'claude' | 'codex' | null;
  ts?: string;
}): EvaluatorRunPayload {
  const reason = scrubEvaluatorDiagnosticAndBound(opts.reason, MAX_PERSISTED_SKIP_REASON_CHARS);
  return {
    schema: 'orcaops.evaluator_run/v1',
    run_id: opts.run_id,
    artifact_id: opts.context.artifact_id,
    evaluator_ref: opts.evaluator.ref,
    package_id: opts.evaluator.package_id,
    evaluator_id: opts.evaluator.evaluator_id,
    phase: opts.context.phase,
    severity: opts.evaluator.severity,
    run_status: 'skipped',
    verdict: null,
    body: `SKIPPED\n\n${reason}`,
    ...(opts.provider !== undefined && opts.provider !== null ? { provider: opts.provider } : {}),
    ...(opts.context.checkpoint_n !== null ? { checkpoint_n: opts.context.checkpoint_n } : {}),
    ts: opts.ts ?? new Date().toISOString(),
  };
}
