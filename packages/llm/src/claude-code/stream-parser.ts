/**
 * Narrowed Claude `--output-format stream-json` parser.
 *
 * The full event stream emits `system.init`, `assistant` (text + tool_use),
 * and `result` events. Evaluators run with `--disallowed-tools '*'` so we
 * don't expect tool_use blocks; we only need the `result` event to extract
 * body, cost, tokens, and error state.
 */

export interface ClaudeResultEvent {
  /** The model's response text (the evaluator body). */
  body: string;
  /** Exact sole modelUsage key, including variant suffixes such as `[1m]`. */
  model?: string;
  /** Cumulative session cost in USD if reported. Caller computes per-turn delta for sessions. */
  cumulativeCostUsd?: number;
  /**
   * Token usage for this turn.
   *
   * `in` is fresh (uncached) input — what Anthropic bills at the full
   * input rate. `cacheRead` is input served from prompt cache (billed
   * at ~10% of full rate). `cacheWrite` is input written to the cache
   * (billed at ~125% on the write turn, then near-free on subsequent
   * reads). `out` is the model's response.
   *
   * Total tokens billed for input on this turn = in + cacheRead +
   * cacheWrite (with their respective multipliers). Reporting only `in`
   * under-counts evaluator cost dramatically when the prompt is cached —
   * e.g. a cached evaluator run can report `in: 6` because the entire
   * structured prompt was served from cache, leaving only the per-call
   * delta as fresh input.
   */
  tokens?: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  /** True when Claude reports `is_error: true` for this result. */
  isError: boolean;
  /**
   * Error subtype when `isError: true`. Notable values:
   *   - `error_max_budget_usd` — budget cap reached
   *   - other values pass through; treated as TOOL_ERROR
   */
  errorSubtype?: string;
  /**
   * Free-text error messages reported by the CLI (only present when isError).
   * The CLI's `errors` field is an array of strings.
   */
  errorMessages?: string[];
  /** Total turns reported (for sessions). */
  numTurns?: number;
  /** Session id reported by the CLI (matches what we passed in). */
  sessionId?: string;
}

/**
 * Parse a single NDJSON line. Returns a result event when the line is a
 * complete `result` payload; null for any other event type, malformed JSON,
 * or empty lines.
 *
 * Robust against partial/extra fields: missing optional values default to
 * `undefined`, and unexpected types are silently dropped.
 */
export function parseClaudeStreamLine(line: string): ClaudeResultEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;

  const obj = json as Record<string, unknown>;
  if (obj.type !== 'result') return null;

  const body = typeof obj.result === 'string' ? obj.result : '';
  const cumulativeCostUsd = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined;
  let model: string | undefined;
  if (obj.modelUsage && typeof obj.modelUsage === 'object' && !Array.isArray(obj.modelUsage)) {
    const keys = Object.keys(obj.modelUsage);
    if (keys.length === 1 && keys[0].length > 0) {
      const metadata = (obj.modelUsage as Record<string, unknown>)[keys[0]];
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) model = keys[0];
    }
  }

  let tokens: ClaudeResultEvent['tokens'];
  if (obj.usage && typeof obj.usage === 'object') {
    const usage = obj.usage as Record<string, unknown>;
    const tIn = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const tOut = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    const tCacheRead =
      typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
    const tCacheWrite =
      typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
    if (tIn > 0 || tOut > 0 || tCacheRead > 0 || tCacheWrite > 0) {
      tokens = {
        in: tIn,
        out: tOut,
        ...(tCacheRead > 0 ? { cacheRead: tCacheRead } : {}),
        ...(tCacheWrite > 0 ? { cacheWrite: tCacheWrite } : {}),
      };
    }
  }

  const isError = obj.is_error === true;
  const errorSubtype = isError && typeof obj.subtype === 'string' ? obj.subtype : undefined;
  let errorMessages: string[] | undefined;
  if (isError && Array.isArray(obj.errors)) {
    const collected = obj.errors.filter((e): e is string => typeof e === 'string');
    if (collected.length > 0) errorMessages = collected;
  }
  const numTurns = typeof obj.num_turns === 'number' ? obj.num_turns : undefined;
  const sessionId = typeof obj.session_id === 'string' ? obj.session_id : undefined;

  return {
    body,
    model,
    cumulativeCostUsd,
    tokens,
    isError,
    errorSubtype,
    errorMessages,
    numTurns,
    sessionId,
  };
}

/**
 * Map a Claude error result event to an EvaluateError envelope.
 * Returns undefined when the event is not an error.
 */
export function eventToEvaluateError(
  event: ClaudeResultEvent
): { code: 'BUDGET' | 'TOOL_ERROR'; message: string } | undefined {
  if (!event.isError) return undefined;
  const code = event.errorSubtype === 'error_max_budget_usd' ? 'BUDGET' : 'TOOL_ERROR';
  const message = event.errorMessages?.[0] ?? (event.body || 'Claude reported is_error=true');
  return { code, message };
}

/**
 * Stateful line-splitter for streaming stdout. Feed chunks via `push`;
 * each call returns the complete lines that arrived in this chunk.
 * Holds an internal buffer for the trailing partial line.
 */
export class LineBuffer {
  private buffer = '';

  push(chunk: string | Buffer): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines;
  }

  /** Drain any trailing buffered content (call on stream close). */
  flush(): string {
    const remainder = this.buffer;
    this.buffer = '';
    return remainder;
  }
}
