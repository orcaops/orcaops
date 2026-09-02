import type { Operation } from 'effection';

/**
 * The orcaops LLM provider interface. Implementations make one-shot evaluator
 * calls and return Effection `Operation`s; capture commands bridge into
 * Effection at their boundary via `await run(...)`.
 *
 * Never throws on user-correctable errors — those become a structured result
 * with `error` set so evaluator dispatch can record `status: 'error'`
 * without crashing the agent.
 */
export interface LLMClient {
  /**
   * True iff no real LLM is configured or available. The runner reads
   * this to skip LLM-engine evaluators and evaluate `when_llm` filters on
   * command evaluators. Set on the client because
   * `buildLLMClient` already encodes the resolution path (auto-detect,
   * `tool: 'none'`, `--no-llm` flag); recomputing it elsewhere would
   * duplicate that logic.
   */
  readonly isDeterministic: boolean;

  /**
   * The CLI tool an evaluator reaches when it declares no `provider` —
   * resolved by the same build path as `isDeterministic` (config `llm.tool`,
   * or `auto` detection), `null` when no real LLM runs. Exposed for the same
   * reason: re-deriving it at a consumer would duplicate the resolution.
   *
   * The consent gate reads this because provider selection is a CAPABILITY
   * decision, not a cosmetic one — codex exposes file-reading tools, so an
   * evaluator that declares nothing still reaches a file-reading engine when
   * the default resolves to codex.
   */
  readonly defaultProvider: 'claude' | 'codex' | null;

  /** Invocation-scoped availability snapshot for provider-aware evaluator routing. */
  readonly isProviderAvailable?: (provider: 'claude' | 'codex') => boolean;

  /**
   * One-shot evaluator call. Use for singleton invocations (e.g. `orcaops
   * eval run --name X`) or lifecycles that have only one matching evaluator
   * after filtering.
   */
  evaluate(opts: EvaluateOptions): Operation<EvaluateResult>;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A minimal JSON Schema object — passed through to the underlying tool. */
export type JsonSchema = Record<string, unknown>;

export interface EvaluateOptions {
  /** Evaluator prompt (the post-context-injected `## prompt` body). */
  prompt: string;
  /**
   * System prompt to install for this call. Nothing defaults it — a caller
   * that wants the shared evaluator protocol passes
   * `ORCAOPS_EVALUATOR_SYSTEM_PROMPT` explicitly, as the runner does for
   * markdown-mode evaluators.
   *
   * Provider support is asymmetric: Claude forwards it as `--system-prompt`,
   * Codex has no equivalent and drops it. Treat it as reinforcement, never as
   * the only place a response contract is stated — an evaluator's own prompt
   * must stand alone.
   */
  systemPrompt?: string;
  /** Model id; null lets the underlying tool pick its default. */
  model?: string | null;
  /** Effort level for tools that support it (Claude only). */
  effort?: Effort;
  /** When set, request structured output matching this JSON schema. */
  outputSchema?: JsonSchema | null;
  /** Hard timeout for the call (ms). */
  timeoutMs?: number;
  /** Per-call USD budget cap (passed through where supported). */
  maxBudgetUsd?: number;
  /** Working directory for the spawned tool. */
  cwd?: string;
  /**
   * Per-call provider override. Forces dispatch to a specific CLI.
   * Single-CLI clients (claude OR codex direct) ignore this; the
   * router built by `buildLLMClient` honors it. Undefined means "use
   * the configured default provider" (the global config.llm.tool).
   */
  provider?: 'claude' | 'codex';
  /**
   * Tool-access policy. Absent / `none` denies all tools — the default
   * posture for evaluators that need no tools. `command-filtered` offers
   * Read/Grep/Glob plus selected git inspection commands under a secret-path
   * denylist. This filters Claude tool commands; it does not sandbox the
   * process or confine reads to the working directory. Honored by the Claude
   * path; Codex configures its own tools.
   */
  toolPolicy?: { mode: 'none' | 'command-filtered' };
  /**
   * Cancellation signal. When aborted (before or during the call) the
   * provider terminates its subprocess (SIGTERM) and resolves with a
   * `CANCELLED` EvaluateResult.error. Already-aborted signals
   * short-circuit before spawning. The runner's `dispatchEvaluators`
   * forwards this through `RunLlmEngineOptions.signal` so a canceled
   * checkpoint-open gate or pre-pr dispatch actually stops in-flight
   * LLM evaluators.
   */
  signal?: AbortSignal;
}

export type EvaluateErrorCode =
  | 'TIMEOUT'
  | 'BUDGET'
  | 'PARSE'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_ERROR'
  | 'CANCELLED';

export interface EvaluateError {
  code: EvaluateErrorCode;
  message: string;
}

export interface EvaluateResult {
  /** Canonical markdown body. Successful evaluations start with a verdict; errors carry diagnostics. */
  body: string;
  /** Model id reported by the tool, or the explicitly requested model when the tool cannot report it. */
  model: string | null;
  /**
   * Per-call token usage if reported. `in`/`out` are fresh I/O;
   * `cacheRead`/`cacheWrite` reflect Anthropic prompt-cache activity
   * (read = served from cache, write = wrote to cache for future reuse).
   * Reporting only `in` under-counts true cost when the prompt is cached.
   */
  tokens?: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  /** Per-call cost in USD. */
  costUsd?: number;
  /** Wall-clock duration of this call. */
  durationMs: number;
  /** Session id this call ran in (synthesized for one-shots). */
  sessionId: string;
  /** Set when the call failed in a structured way. Body still populated with diagnostic text. */
  error?: EvaluateError;
}

/**
 * The shared response protocol for MARKDOWN-mode evaluators, so a pack author
 * does not have to re-teach the verdict shape in every prompt.
 *
 * Passed by the runner for `output_format: markdown` only — it asks for
 * markdown prose and a fenced sentinel, which would fight JSON mode's
 * structured-output contract. Codex drops system prompts entirely, so this is
 * reinforcement rather than the contract itself; the shipped prompts state
 * their own response format and must keep doing so.
 */
export const ORCAOPS_EVALUATOR_SYSTEM_PROMPT = `\
You are an evaluator running inside the orcaops capture/evaluate/digest \
layer. You receive a single evaluator prompt with injected context (plan, \
checkpoint, and/or diff). Respond in markdown.

Write your prose first, then END your response with a verdict sentinel: a
fenced block whose info string is \`orcaops-verdict\` and whose only content is
one of PASS / VIOLATION / INFO.

\`\`\`orcaops-verdict
PASS
\`\`\`

  PASS         — the evaluation passed; no concerns
  VIOLATION    — concerns detected; explain in the body
  INFO         — informational only; not a pass/fail signal

Emit exactly one sentinel of your own, last. If your prompt quotes an example
sentinel and you echo it, your own sentinel must come after it — when several
appear, the LAST one is read as the verdict. If you emit no sentinel at all,
the last standalone PASS / VIOLATION / INFO line in your response is used
instead, which is why a bare verdict token should never appear in your prose.

Keep the prose itself unfenced. If your evaluator's prompt asks for a
\`## findings\` section, include it.
`;
