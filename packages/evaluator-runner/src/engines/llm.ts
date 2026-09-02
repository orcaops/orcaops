import { run } from 'effection';
import { readFile } from 'node:fs/promises';

import {
  assertResolvedWithin,
  composeEvaluatorPrompt,
  type EvaluatorContext,
  EvaluatorResultEnvelopeSchema,
  type EvaluatorRunPayload,
  type EvaluatorVerdict,
  parseMarkdownVerdict,
  type ResolvedEvaluator,
} from '@orcaops/evaluator-protocol';
import {
  scrubEvaluatorDiagnosticAndBound,
  scrubEvaluatorOutput,
  scrubEvaluatorOutputInValue,
} from '@orcaops/evaluator-protocol/secrets';
import {
  type EvaluateOptions,
  type EvaluateResult,
  type LLMClient,
  ORCAOPS_EVALUATOR_SYSTEM_PROMPT,
} from '@orcaops/llm';

/**
 * Structured-error codes the LLM engine can surface. Extends the
 * command-engine set with two LLM-specific cases:
 *   - NO_VERDICT_LINE — markdown response had no PASS/VIOLATION/INFO line
 *   - LLM_ERROR — the provider returned a structured error envelope
 *     (timeout / budget / parse failure at the CLI subprocess layer)
 *   - LLM_UNAVAILABLE — no provider was configured or discovered
 */
export type LlmEngineErrorCode =
  | 'JSON_PARSE'
  | 'ENVELOPE_INVALID'
  | 'RAW_SCHEMA_INVALID'
  | 'NO_VERDICT_LINE'
  | 'LLM_ERROR'
  | 'LLM_UNAVAILABLE';

const MAX_PERSISTED_ERROR_MESSAGE_CHARS = 4096;
const MAX_PERSISTED_MODEL_CHARS = 256;

export interface RunLlmEngineOptions {
  /** Resolved evaluator (engine.kind must be `llm`). */
  evaluator: ResolvedEvaluator;
  /** Context handed to the LLM via the auto-prepended `## Context` block. */
  context: EvaluatorContext;
  /** Caller-supplied run_id (UUIDv7); stamped on the EvaluatorRunPayload. */
  run_id: string;
  /** LLM provider. The runner does not construct this — the caller does (the CLI wires `buildLLMClient`). */
  llm: LLMClient;
  /**
   * Working directory for the LLM subprocess. Defaults to context.repo.root so
   * relative inspection commands start in the repository. This is not a
   * confinement boundary.
   */
  cwd?: string;
  /**
   * For json output_format only. Number of retries on parse / schema
   * failure. Default 1.
   */
  jsonModeRetries?: number;
  /**
   * Optional JSON Schema validator for the envelope's `raw` field.
   * Injected by the CLI's lifecycle wiring (typically the same
   * ajv-backed validator used by the command engine).
   */
  validateRaw?: (raw: unknown, schema: Record<string, unknown>) => void;
  /**
   * Cancellation signal. Forwarded to `LLMClient.evaluate` via
   * `EvaluateOptions.signal` so a canceled checkpoint-open gate or
   * pre-pr dispatch actually stops in-flight LLM evaluators (not just
   * command evaluators).
   */
  signal?: AbortSignal;
}

/**
 * Dispatch a single LLM-engine evaluator. Builds the auto-prepended
 * `## Context` block, reads the prompt file,
 * composes the full prompt, calls `LLMClient.evaluate`, and parses
 * the response per `engine.output_format`.
 *
 * Markdown mode (default): reads the LAST ```orcaops-verdict sentinel
 * block, falling back to the LAST standalone PASS/VIOLATION/INFO line
 * when the response carries no sentinel. NO_VERDICT_LINE when neither
 * tier finds a verdict.
 *
 * JSON mode: parses the response as the
 * `orcaops.evaluator_result/v1` envelope. Validates `raw` against
 * `engine.output_schema` when both are set. Retries once on parse /
 * schema failure (default `json_mode_retries: 1`).
 *
 * Never throws on a user-correctable failure — every error mode
 * maps to `run_status: 'error'` with a structured `error.code`.
 */
export async function runLlmEngine(opts: RunLlmEngineOptions): Promise<EvaluatorRunPayload> {
  const { evaluator, context, run_id } = opts;
  if (evaluator.engine.kind !== 'llm') {
    throw new Error(
      `runLlmEngine called with engine.kind="${evaluator.engine.kind}" — expected "llm"`
    );
  }
  const engine = evaluator.engine;
  const provider = engine.provider ?? opts.llm.defaultProvider;
  const ts = new Date().toISOString();
  const retries = opts.jsonModeRetries ?? 1;

  if (opts.llm.isDeterministic) {
    return packErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'LLM_UNAVAILABLE',
      message: 'no LLM provider executed',
      duration_ms: 0,
      provider,
    });
  }

  let promptBody: string;
  try {
    const promptFile = assertResolvedWithin(
      engine.prompt_file,
      evaluator.package_root,
      'engine.prompt_file'
    );
    promptBody = await readFile(promptFile, 'utf8');
  } catch (err) {
    return packErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'LLM_ERROR',
      message: `failed to read prompt_file ${engine.prompt_file}: ${(err as Error).message}`,
      duration_ms: 0,
      provider,
    });
  }

  const fullPrompt = composeEvaluatorPrompt({
    context,
    additionalSections: engine.additional_context_sections,
    promptBody,
  });

  const evaluateOpts: EvaluateOptions = {
    prompt: fullPrompt,
    timeoutMs: engine.timeout_ms,
    // Markdown mode only: the shared protocol asks for prose and a fenced
    // verdict sentinel, which contradicts JSON mode's structured output. Not
    // every provider honors a system prompt, so this reinforces each pack's
    // own response format rather than replacing it.
    ...(engine.output_format === 'markdown'
      ? { systemPrompt: ORCAOPS_EVALUATOR_SYSTEM_PROMPT }
      : {}),
    ...(engine.model !== undefined ? { model: engine.model } : {}),
    ...(engine.effort !== undefined ? { effort: engine.effort } : {}),
    ...(engine.max_cost_usd !== undefined ? { maxBudgetUsd: engine.max_cost_usd } : {}),
    ...(engine.provider !== undefined ? { provider: engine.provider } : {}),
    ...(engine.tool_policy !== undefined ? { toolPolicy: engine.tool_policy } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : { cwd: context.repo.root }),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    outputSchema:
      engine.output_format === 'json' && engine.output_schema !== undefined
        ? engine.output_schema
        : null,
  };

  if (engine.output_format === 'markdown') {
    return runMarkdownMode({ ...opts, evaluator, engine, provider, ts, evaluateOpts });
  }
  return runJsonMode({ ...opts, evaluator, engine, provider, ts, evaluateOpts, retries });
}

// ── markdown mode ───────────────────────────────────────────────────

async function runMarkdownMode(
  opts: RunLlmEngineOptions & {
    evaluator: ResolvedEvaluator;
    engine: ResolvedEvaluator['engine'] & { kind: 'llm' };
    provider: 'claude' | 'codex' | null;
    ts: string;
    evaluateOpts: EvaluateOptions;
  }
): Promise<EvaluatorRunPayload> {
  const { evaluator, context, run_id, provider, ts, evaluateOpts, llm } = opts;
  const result = await runEvaluateOperation(llm, evaluateOpts);

  if (result.error) {
    return packErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'LLM_ERROR',
      message: `${result.error.code}: ${result.error.message}`,
      duration_ms: result.durationMs,
      provider,
      model: result.model,
      tokens: result.tokens,
      cost_usd: result.costUsd,
    });
  }
  const verdict = parseMarkdownVerdict(result.body);
  if (verdict === null) {
    return packErrorRun({
      evaluator,
      run_id,
      context,
      ts,
      code: 'NO_VERDICT_LINE',
      message:
        'response carried no verdict: no ```orcaops-verdict sentinel block, ' +
        'and no standalone PASS / VIOLATION / INFO line to fall back on ' +
        '(when several of either appear, the last one wins; none found)',
      duration_ms: result.durationMs,
      provider,
      model: result.model,
      tokens: result.tokens,
      cost_usd: result.costUsd,
    });
  }
  return packCompletedRun({
    evaluator,
    run_id,
    context,
    ts,
    verdict,
    body: result.body,
    raw: undefined,
    metrics: undefined,
    duration_ms: result.durationMs,
    provider,
    model: result.model,
    tokens: result.tokens,
    cost_usd: result.costUsd,
  });
}

// ── json mode ───────────────────────────────────────────────────────

async function runJsonMode(
  opts: RunLlmEngineOptions & {
    evaluator: ResolvedEvaluator;
    engine: ResolvedEvaluator['engine'] & { kind: 'llm' };
    provider: 'claude' | 'codex' | null;
    ts: string;
    evaluateOpts: EvaluateOptions;
    retries: number;
  }
): Promise<EvaluatorRunPayload> {
  const { evaluator, context, run_id, provider, ts, llm, retries, validateRaw } = opts;
  const engine = opts.engine;

  let attempt = 0;
  let lastResult: EvaluateResult | null = null;
  let lastError: { code: LlmEngineErrorCode; message: string } | null = null;
  let promptOpts: EvaluateOptions = opts.evaluateOpts;

  while (attempt <= retries) {
    const result = await runEvaluateOperation(llm, promptOpts);
    lastResult = result;

    if (result.error) {
      return packErrorRun({
        evaluator,
        run_id,
        context,
        ts,
        code: 'LLM_ERROR',
        message: `${result.error.code}: ${result.error.message}`,
        duration_ms: result.durationMs,
        provider,
        model: result.model,
        tokens: result.tokens,
        cost_usd: result.costUsd,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body);
    } catch (err) {
      lastError = {
        code: 'JSON_PARSE',
        message:
          (err instanceof Error ? err.message : String(err)) +
          ` — response body: ${truncate(scrubEvaluatorOutput(result.body), 256)}`,
      };
      attempt += 1;
      if (attempt <= retries) {
        promptOpts = nudgeForJson(promptOpts);
        continue;
      }
      break;
    }

    const envelopeResult = EvaluatorResultEnvelopeSchema.safeParse(parsed);
    if (!envelopeResult.success) {
      const issue = envelopeResult.error.issues[0];
      lastError = {
        code: 'ENVELOPE_INVALID',
        message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      };
      attempt += 1;
      if (attempt <= retries) {
        promptOpts = nudgeForJson(promptOpts);
        continue;
      }
      break;
    }
    const envelope = envelopeResult.data;

    if (validateRaw && engine.output_schema && envelope.raw !== undefined) {
      try {
        validateRaw(envelope.raw, engine.output_schema);
      } catch (err) {
        lastError = {
          code: 'RAW_SCHEMA_INVALID',
          message: err instanceof Error ? err.message : String(err),
        };
        attempt += 1;
        if (attempt <= retries) {
          promptOpts = nudgeForJson(promptOpts);
          continue;
        }
        break;
      }
    }

    return packCompletedRun({
      evaluator,
      run_id,
      context,
      ts,
      verdict: envelope.verdict,
      body: envelope.body,
      raw: envelope.raw,
      metrics: envelope.metrics,
      duration_ms: result.durationMs,
      provider,
      model: result.model,
      tokens: result.tokens,
      cost_usd: result.costUsd,
    });
  }

  // Exhausted retries.
  return packErrorRun({
    evaluator,
    run_id,
    context,
    ts,
    code: lastError?.code ?? 'JSON_PARSE',
    message:
      `JSON-mode failed after ${retries + 1} attempt(s). Last error: ` +
      (lastError?.message ?? 'unknown'),
    duration_ms: lastResult?.durationMs ?? 0,
    provider,
    ...(lastResult?.model !== undefined ? { model: lastResult.model } : {}),
    ...(lastResult?.tokens !== undefined ? { tokens: lastResult.tokens } : {}),
    ...(lastResult?.costUsd !== undefined ? { cost_usd: lastResult.costUsd } : {}),
  });
}

function nudgeForJson(opts: EvaluateOptions): EvaluateOptions {
  // On retry, remind the model to produce ONLY the envelope JSON
  // (mirrors the existing core runner's nudge text). The retry
  // budget is bounded by json_mode_retries.
  const reminder =
    '\n\nREMINDER: respond with ONLY valid JSON matching the orcaops.evaluator_result/v1 envelope. No prose, no markdown fences.';
  return { ...opts, prompt: opts.prompt + reminder };
}

// ── helpers ─────────────────────────────────────────────────────────

async function runEvaluateOperation(
  llm: LLMClient,
  opts: EvaluateOptions
): Promise<EvaluateResult> {
  return run(function* () {
    return yield* llm.evaluate(opts);
  });
}

interface CompletedFields {
  evaluator: ResolvedEvaluator;
  run_id: string;
  context: EvaluatorContext;
  ts: string;
  verdict: EvaluatorVerdict;
  body: string;
  raw: unknown;
  metrics: Record<string, number> | undefined;
  duration_ms: number;
  provider: 'claude' | 'codex' | null;
  model: string | null;
  tokens?: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  cost_usd?: number;
}

function packCompletedRun(opts: CompletedFields): EvaluatorRunPayload {
  return {
    schema: 'orcaops.evaluator_run/v1',
    run_id: opts.run_id,
    artifact_id: opts.context.artifact_id,
    evaluator_ref: opts.evaluator.ref,
    package_id: opts.evaluator.package_id,
    evaluator_id: opts.evaluator.evaluator_id,
    phase: opts.context.phase,
    severity: opts.evaluator.severity,
    run_status: 'completed',
    verdict: opts.verdict,
    body: scrubEvaluatorOutput(opts.body),
    ...(opts.raw !== undefined ? { raw: scrubEvaluatorOutputInValue(opts.raw) } : {}),
    ...(opts.metrics !== undefined ? { metrics: scrubEvaluatorOutputInValue(opts.metrics) } : {}),
    ...(opts.provider !== null ? { provider: opts.provider } : {}),
    ...(opts.model !== null ? { model: scrubModel(opts.model) } : {}),
    ...(opts.tokens !== undefined
      ? {
          tokens: {
            in: opts.tokens.in,
            out: opts.tokens.out,
            ...(opts.tokens.cacheRead !== undefined ? { cache_read: opts.tokens.cacheRead } : {}),
            ...(opts.tokens.cacheWrite !== undefined
              ? { cache_write: opts.tokens.cacheWrite }
              : {}),
          },
        }
      : {}),
    ...(opts.cost_usd !== undefined ? { cost_usd: opts.cost_usd } : {}),
    duration_ms: opts.duration_ms,
    ...(opts.context.checkpoint_n !== null ? { checkpoint_n: opts.context.checkpoint_n } : {}),
    ts: opts.ts,
  };
}

interface ErrorFields {
  evaluator: ResolvedEvaluator;
  run_id: string;
  context: EvaluatorContext;
  ts: string;
  code: LlmEngineErrorCode;
  message: string;
  duration_ms: number;
  provider?: 'claude' | 'codex' | null;
  model?: string | null;
  tokens?: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  cost_usd?: number;
}

function packErrorRun(opts: ErrorFields): EvaluatorRunPayload {
  const message = scrubEvaluatorDiagnosticAndBound(opts.message, MAX_PERSISTED_ERROR_MESSAGE_CHARS);
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
    body: `ERROR (${opts.code})\n\n${message}`,
    error: { code: opts.code, message },
    ...(opts.provider !== undefined && opts.provider !== null ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined && opts.model !== null ? { model: scrubModel(opts.model) } : {}),
    ...(opts.tokens !== undefined
      ? {
          tokens: {
            in: opts.tokens.in,
            out: opts.tokens.out,
            ...(opts.tokens.cacheRead !== undefined ? { cache_read: opts.tokens.cacheRead } : {}),
            ...(opts.tokens.cacheWrite !== undefined
              ? { cache_write: opts.tokens.cacheWrite }
              : {}),
          },
        }
      : {}),
    ...(opts.cost_usd !== undefined ? { cost_usd: opts.cost_usd } : {}),
    duration_ms: opts.duration_ms,
    ...(opts.context.checkpoint_n !== null ? { checkpoint_n: opts.context.checkpoint_n } : {}),
    ts: opts.ts,
  };
}

function scrubModel(model: string): string {
  const scrubbed = scrubEvaluatorDiagnosticAndBound(model, MAX_PERSISTED_MODEL_CHARS)
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
  return scrubbed.length > 0 ? scrubbed : '[unknown model]';
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…[${s.length - n} more]`;
}
