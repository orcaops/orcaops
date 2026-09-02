import {
  type EvaluatorContext,
  type EvaluatorRunPayload,
  type ResolvedEvaluator,
} from '@orcaops/evaluator-protocol';
import { scrubEvaluatorDiagnosticAndBound } from '@orcaops/evaluator-protocol/secrets';
import type { LLMClient } from '@orcaops/llm';

import { runCommandEngine } from './engines/command.js';
import { runLlmEngine } from './engines/llm.js';
import { makeSkippedRun, shouldSkipEvaluator } from './filter.js';
import { evaluateConsentGate, type PackTrustDecision } from './trust-capability.js';

/**
 * Generate a fresh run_id. Defaults to `crypto.randomUUID()` but
 * the caller can inject a UUIDv7 minter when one is available (the
 * CLI wires `uuidv7()` from @orcaops/storage). The default is the
 * standard randomUUID — order_key takes care of deterministic
 * projection ordering, so the UUID only needs to be unique.
 */
export type RunIdFactory = () => string;

export type { ClassifiableEngine, PackTrustDecision, TrustCapability } from './trust-capability.js';

const MAX_PERSISTED_ERROR_MESSAGE_CHARS = 4096;

export interface DispatchOptions {
  evaluators: readonly ResolvedEvaluator[];
  context: EvaluatorContext;
  llm: LLMClient;
  /**
   * Trust decisions keyed by `package_id`. REQUIRED and fail-closed: a
   * capability-requiring evaluator whose package is absent, refused, or
   * granted without the required capability never reaches an engine — it
   * records a `run_status: 'error'` payload (code `CONSENT_DENIED`) so the
   * refusal is loud and satisfies the lifecycle inventory (which flags
   * enabled refs with no run). Error runs are deliberately not
   * blocking-eligible; see makeConsentRefusedRun.
   */
  trust: ReadonlyMap<string, PackTrustDecision>;
  /**
   * Pool size. Defaults to 4. Capped at the number of evaluators
   * (no point spinning up more workers than tasks).
   */
  maxConcurrent?: number;
  /** Cancellation. SIGTERM fires on every in-flight subprocess. */
  signal?: AbortSignal;
  /** Override the run_id factory (defaults to crypto.randomUUID). */
  runIdFactory?: RunIdFactory;
  /**
   * Optional JSON Schema validator for engine.output_schema. Threaded
   * through to both engines.
   */
  validateRaw?: (raw: unknown, schema: Record<string, unknown>) => void;
  /**
   * Optional retries for the LLM engine's JSON mode. Defaults to
   * the engine's own default (1).
   */
  jsonModeRetries?: number;
  /** Override parent env for command-engine subprocesses (test injection). */
  parentEnv?: NodeJS.ProcessEnv;
}

export interface DispatchResult {
  /**
   * EvaluatorRunPayload[] in the SAME order as the input
   * `evaluators[]`. Completion order across workers is
   * non-deterministic; the result array reorders by input index so
   * callers can `zip(evaluators, results)` without surprises.
   */
  runs: EvaluatorRunPayload[];
}

/**
 * Bounded-parallel evaluator dispatch. The pool
 * runs up to `maxConcurrent` evaluators concurrently; slots advance
 * independently through the input queue. Filter-skipped evaluators
 * produce `run_status: 'skipped'` payloads without engine dispatch
 * (no subprocess / no LLM call).
 *
 * Cancellation: when `signal` aborts, every in-flight subprocess
 * gets SIGTERM via the engine layer; the AbortSignal is also threaded
 * into the LLM engine's evaluate() call. Pending evaluators are not
 * dropped from the queue — each still enters dispatch, observes the
 * aborted signal at engine entry, and short-circuits with
 * `error.code: 'CANCELED'` (command engine) or carries through.
 */
export async function dispatchEvaluators(opts: DispatchOptions): Promise<DispatchResult> {
  const { evaluators, context, llm } = opts;
  const concurrency = Math.max(1, Math.min(opts.maxConcurrent ?? 4, evaluators.length));
  const runIdFactory = opts.runIdFactory ?? defaultRunIdFactory;

  // Results array indexed by input position. Workers fill in slots
  // independently; this preserves input order for the caller.
  const results: EvaluatorRunPayload[] = new Array(evaluators.length);
  let nextIdx = 0;
  const takeNext = (): number => {
    if (nextIdx >= evaluators.length) return -1;
    return nextIdx++;
  };

  async function worker(): Promise<void> {
    for (;;) {
      const i = takeNext();
      if (i < 0) return;
      const ev = evaluators[i];
      results[i] = await dispatchOne(ev, context, llm, opts, runIdFactory);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { runs: results };
}

/**
 * Pack a `run_status: 'error'` payload for an evaluator refused by the
 * consent gate. Deliberately an error (not a skip): the refusal stays loud
 * in every run listing and satisfies the lifecycle inventory. The row is not
 * disposition-eligible because it is not an evaluator-authored violation.
 * Block-severity refusals still halt lifecycle progression until consent is
 * granted; warn/info refusals remain advisory.
 */
export function makeConsentRefusedRun(opts: {
  evaluator: ResolvedEvaluator;
  context: EvaluatorContext;
  run_id: string;
  reason: string;
  ts?: string;
}): EvaluatorRunPayload {
  const reason = scrubEvaluatorDiagnosticAndBound(opts.reason, MAX_PERSISTED_ERROR_MESSAGE_CHARS);
  return {
    schema: 'orcaops.evaluator_run/v1',
    run_id: opts.run_id,
    artifact_id: opts.context.artifact_id,
    evaluator_ref: opts.evaluator.ref,
    package_id: opts.evaluator.package_id,
    evaluator_id: opts.evaluator.evaluator_id,
    phase: opts.context.phase,
    severity: opts.evaluator.severity,
    run_status: 'error',
    verdict: null,
    body: `CONSENT DENIED\n\n${reason}`,
    error: { code: 'CONSENT_DENIED', message: reason },
    ...(opts.context.checkpoint_n !== null ? { checkpoint_n: opts.context.checkpoint_n } : {}),
    ts: opts.ts ?? new Date().toISOString(),
  };
}

/**
 * Dispatch a single evaluator. Consent gate first (fail-closed), then the
 * filter check; if the evaluator is filtered out, return a skipped payload
 * without engine dispatch. Otherwise route to the matching engine.
 *
 * Exported so the CLI's `eval run <ref>` command can dispatch one
 * evaluator directly without spinning up the pool.
 */
export async function dispatchOne(
  evaluator: ResolvedEvaluator,
  context: EvaluatorContext,
  llm: LLMClient,
  opts: Pick<DispatchOptions, 'trust' | 'signal' | 'validateRaw' | 'jsonModeRetries' | 'parentEnv'>,
  runIdFactory: RunIdFactory = defaultRunIdFactory
): Promise<EvaluatorRunPayload> {
  const run_id = runIdFactory();
  // The context an evaluator consumes carries its own resolved
  // params, ref, and run_id. The bridge passes a base
  // context shared across the batch; we specialize it here so the
  // command engine's subprocess JSON sees the right params and the
  // LLM engine sees the right ref in error envelopes.
  const evalContext: EvaluatorContext = {
    ...context,
    run_id,
    evaluator_ref: evaluator.ref,
    params: evaluator.params,
  };
  // Consent gate BEFORE the filter: a refusal must be recorded loudly even
  // for evaluators a filter would have skipped this run, so the artifact
  // trail shows the pack was unconsented rather than quietly filtered.
  const consent = evaluateConsentGate(
    evaluator.engine,
    evaluator.package_id,
    opts.trust.get(evaluator.package_id),
    llm.defaultProvider
  );
  if (!consent.allowed) {
    return makeConsentRefusedRun({
      evaluator,
      context: evalContext,
      run_id,
      reason: consent.reason,
    });
  }
  const effectiveProvider =
    evaluator.engine.kind === 'llm'
      ? (evaluator.engine.provider ?? llm.defaultProvider)
      : llm.defaultProvider;
  const providerAvailability =
    effectiveProvider !== null
      ? {
          provider: effectiveProvider,
          available: llm.isProviderAvailable?.(effectiveProvider) ?? true,
          source: providerSelectionDescription(evaluator),
        }
      : undefined;
  const skipReason = shouldSkipEvaluator(
    evaluator,
    evalContext,
    llm.isDeterministic,
    providerAvailability
  );
  if (skipReason !== null) {
    return makeSkippedRun({
      evaluator,
      context: evalContext,
      run_id,
      reason: skipReason,
      ...(evaluator.engine.kind === 'llm' ? { provider: effectiveProvider } : {}),
    });
  }
  if (evaluator.engine.kind === 'command') {
    return runCommandEngine({
      evaluator,
      context: evalContext,
      run_id,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.parentEnv !== undefined ? { parentEnv: opts.parentEnv } : {}),
      ...(opts.validateRaw !== undefined ? { validateRaw: opts.validateRaw } : {}),
    });
  }
  return runLlmEngine({
    evaluator,
    context: evalContext,
    run_id,
    llm,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.validateRaw !== undefined ? { validateRaw: opts.validateRaw } : {}),
    ...(opts.jsonModeRetries !== undefined ? { jsonModeRetries: opts.jsonModeRetries } : {}),
  });
}

export function providerSelectionDescription(evaluator: ResolvedEvaluator): string {
  if (evaluator.engine.kind !== 'llm') return 'from global llm.tool';
  switch (evaluator.engine.selection_sources?.provider) {
    case 'user-override':
      return evaluator.engine.provider === undefined
        ? 'provider pin cleared by your .orcaops/evaluators.yaml override; selected from global llm.tool'
        : 'selected by your .orcaops/evaluators.yaml override';
    case 'pack-spec':
      return `pinned by pack ${evaluator.package_id}`;
    default:
      return 'from global llm.tool';
  }
}

/**
 * Default run_id minter. Uses crypto.randomUUID which is monotonic
 * enough for projection ordering (the order_key triple is the real
 * sort key). The CLI injects @orcaops/storage's uuidv7 for stronger
 * time-ordering when the dispatch path is wired into capture
 * commands.
 */
function defaultRunIdFactory(): string {
  return globalThis.crypto.randomUUID();
}
