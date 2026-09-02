/**
 * Agent usage provider seam.
 *
 * A coding agent (Claude Code today, others later) burns tokens authoring
 * plans, implementing checkpoints, and driving the capture lifecycle. This
 * seam reads that **token usage** for a given agent session — raw token
 * facts only, **never pricing** (the cloud prices). Each agent that can
 * report its own usage implements {@link AgentUsageSource}; the registry
 * resolves one by agent id.
 *
 * Token field names are deliberately **Claude-native** ({@link AgentTokenUsage})
 * — truest to the raw transcript facts. Any rename to the cloud-wire shape
 * (`in`/`out`/`cache_read`/`cache_write`) happens only at the wire boundary,
 * not here.
 */

// Imported for the registry only. The source impls import our *types* with
// `import type` (erased at runtime), so there is no runtime import cycle.
import { ClaudeCodeUsageSource } from '../claude-code/transcript-parser.js';
import { CodexUsageSource } from '../codex/rollout-parser.js';
import { CopilotUsageSource } from '../github-copilot/otel-parser.js';
import { OpenCodeUsageSource } from '../opencode/db-reader.js';

/**
 * Raw token counts for an agent's work, using Claude-native field names.
 * The four scalar fields are always present (zero when absent). `dimensions`
 * is an OPEN, additive map of provider-/billing-specific raw counters. No USD,
 * no pricing (the cloud prices) — `dimensions` carries raw counts only.
 */
export interface AgentTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /**
   * Open, additive raw NUMERIC counters — never priced here, never pruned;
   * sparse (omitted when empty). Two kinds of key (canonical names fixed in
   * `transcript-parser.ts`):
   *  - refinements that SPLIT a first-class total: `cache_creation_1h_input_tokens`
   *    + `cache_creation_5m_input_tokens` === `cache_creation_input_tokens`;
   *  - net-new per-request counts: `web_search_requests` (billable) and
   *    `web_fetch_requests` (captured but non-billable — tokens-only).
   */
  dimensions?: Record<string, number>;
}

/**
 * Per-model slice of an {@link AgentUsageSnapshot}'s total, partitioned by the
 * price-determining rate class.
 */
export interface AgentUsageModelBreakdown {
  /** The model id reported by the agent (e.g. `claude-opus-4-8`). */
  model: string;
  /**
   * Price-determining rate classes that vary WITHIN a session (Claude:
   * `message.usage.{speed,service_tier,inference_geo}`). Canonicalized at
   * capture: a value equal to the no-premium default is OMITTED, so an
   * all-standard session stays clean and equivalents never split into separate
   * buckets. Present only for a non-default (premium) class.
   */
  speed?: string;
  service_tier?: string;
  inference_geo?: string;
  usage: AgentTokenUsage;
}

/**
 * A point-in-time read of an agent session's cumulative token usage, from
 * session start up to {@link AgentUsageReadOptions.until}. Returned by
 * {@link AgentUsageSource.readUsage}; `null` there means "no usage found".
 */
export interface AgentUsageSnapshot {
  /** Sum across every counted record (== sum of {@link modelBreakdown} usages). */
  total: AgentTokenUsage;
  /** Per-model breakdown, sorted by model id for deterministic output. */
  modelBreakdown: AgentUsageModelBreakdown[];
  /**
   * The read cutoff (ISO-8601). Equals `until` when one was supplied;
   * otherwise the latest record timestamp actually counted. This is a
   * transcript read-cutoff marker only — never idempotency material.
   */
  asOf: string;
  /** Number of de-duplicated usage records summed into {@link total}. */
  recordCount: number;
}

/** Options for {@link AgentUsageSource.readUsage}. */
export interface AgentUsageReadOptions {
  /**
   * Upper bound (ISO-8601) on record timestamps — records with
   * `timestamp <= until` are counted. Omit to count the whole session.
   * There is intentionally no `since`: usage is read cumulatively from
   * session start (the same-session delta baseline is the ledger's job).
   */
  until?: string;
  /**
   * The session's working directory, used as a fast-path hint to locate the
   * transcript directory. Locating is robust without it (the source scans
   * for `<sessionId>.jsonl`), so it is purely an optimization.
   */
  cwd?: string;
}

/** Options for {@link AgentUsageSource.discoverActiveSessionId}. */
export interface AgentSessionDiscoveryOptions {
  /**
   * The invocation working directory, matched against the working dir the
   * agent recorded on its session (e.g. Codex `session_meta.payload.cwd`).
   * Discovery with no cwd to match against returns `null` — never a guess.
   */
  cwd?: string;
  /**
   * ISO-8601 "now" anchor for the recency window (defaults to wall clock).
   * Only sessions active within the source's recency window of `now` are
   * candidates, so a stale session in the same directory is never attributed.
   */
  now?: string;
}

/** A read-only view of the process environment. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Reads one agent's own token usage. Implementations are pure readers — they
 * never mutate state and never price.
 */
export interface AgentUsageSource {
  /** Stable agent id, e.g. `claude-code`. */
  readonly agent: string;
  /**
   * Resolve the agent's active session id from the environment, or `null`
   * when none is set (e.g. headless invocations). For Claude Code this is
   * `CLAUDE_CODE_SESSION_ID`.
   */
  resolveActiveSessionId(env?: EnvLike): string | null;
  /**
   * Canonicalize a directly resolved id before it is persisted. Returns `null`
   * when the provider cannot verify the identity locally.
   */
  canonicalizeSessionId?(sessionId: string, env?: EnvLike): Promise<string | null>;
  /**
   * Discover the agent's active session id from its on-disk state — the
   * fallback when no direct session channel is available (older Codex,
   * OpenCode).
   * Resolves the most-recently-active session matching `opts.cwd`, or `null`
   * when none is fresh enough. OPTIONAL: sources with a reliable env channel
   * (Claude Code) omit it. Best-effort and side-effect-free.
   */
  discoverActiveSessionId?(opts?: AgentSessionDiscoveryOptions): Promise<string | null>;
  /**
   * Read cumulative token usage for `sessionId`, from session start up to
   * `opts.until`. Resolves `null` when the session's transcript can't be
   * found or carries no usage records. Best-effort and side-effect-free.
   */
  readUsage(sessionId: string, opts?: AgentUsageReadOptions): Promise<AgentUsageSnapshot | null>;
}

/**
 * Resolve the {@link AgentUsageSource} for an agent id, or `null` for an
 * agent with no usage source (cursor / aider have no reliable local token
 * data today).
 */
export function resolveAgentUsageSource(
  agent: string,
  env: EnvLike = process.env
): AgentUsageSource | null {
  switch (agent) {
    case 'claude-code':
      return new ClaudeCodeUsageSource(env);
    case 'codex':
      return new CodexUsageSource(env);
    case 'opencode':
      return new OpenCodeUsageSource(env);
    case 'github-copilot':
      return new CopilotUsageSource(env);
    default:
      return null;
  }
}
