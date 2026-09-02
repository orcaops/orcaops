/**
 * Codex CLI rollout usage parser.
 *
 * Distinct from `one-shot.ts` (the codex *evaluator* client): this reads the
 * **on-disk session rollouts** Codex CLI writes to
 * `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 * (plus `archived_sessions/`), to recover the *coding agent's own* token
 * usage for a session.
 *
 * Established facts (verified against real rollouts, codex-cli 0.142.x,
 * vintages 2026/04–07, cross-checked with ccusage's `adapter/codex/`):
 *  - The first line is `session_meta`; `payload.id` is the rollout's thread id
 *    and equals the filename uuid (`payload.session_id` exists only in newer
 *    files — for subagent rollouts it names the ROOT session, and
 *    `payload.parent_thread_id` / `thread_source: "subagent"` mark the link).
 *  - Usage lives on `event_msg` lines with `payload.type == "token_count"`:
 *    `payload.info.total_token_usage` is CUMULATIVE per file and
 *    `payload.info.last_token_usage` is the per-turn delta. `info` can be
 *    `null` (first event of older sessions) — guarded. Counter fields:
 *    `input_tokens`, `cached_input_tokens` (⊆ input), `output_tokens`,
 *    `reasoning_output_tokens` (⊆ output), `total_tokens`.
 *  - The model rides `turn_context.payload.model` (stable across versions)
 *    and can change mid-session.
 *  - Every line carries a top-level ISO `timestamp`.
 *
 * Mapping to Claude-native fields, matching how ccusage prices Codex (with
 * `cached = min(cached_input_tokens, input_tokens)`): `input_tokens = input −
 * cached`, `cache_read_input_tokens = cached`, `cache_creation_input_tokens =
 * 0` (OpenAI caching has no write charge), `output_tokens` unchanged, and
 * `reasoning_output_tokens` carried as an open dimension (a REFINEMENT of
 * `output_tokens` — reasoning is billed inside output).
 *
 * Tokens only — never any pricing.
 */

import { readFile } from 'node:fs/promises';

import {
  CodexRolloutLocator,
  type CodexRolloutMeta,
  parseCodexRolloutMetaLine,
} from '@orcaops/agent-activity';

import { buildUsageSnapshot, DIM_REASONING_OUTPUT, tokenField } from '../agent-usage/aggregate.js';
import type {
  AgentSessionDiscoveryOptions,
  AgentTokenUsage,
  AgentUsageReadOptions,
  AgentUsageSnapshot,
  AgentUsageSource,
  EnvLike,
} from '../agent-usage/source.js';

/**
 * Discovery recency window: a rollout counts as "active" only when its file
 * was modified within this window of `now`. A capture verb runs mid-session
 * (codex wrote to its rollout seconds ago when it invoked the CLI), so 30
 * minutes is generous — while yesterday's session in the same repo can never
 * be mis-attributed. A stamp skipped by a false negative is harmless: the
 * next lifecycle verb re-reads cumulatively from session start.
 */
export const CODEX_DISCOVERY_RECENCY_MS = 30 * 60_000;

/** The `session_meta` facts a rollout file's first line declares. */
export type RolloutMeta = CodexRolloutMeta;

/** One resolved per-turn usage delta extracted from a rollout file. */
export interface CodexUsageEvent {
  usage: AgentTokenUsage;
  model: string;
  ts: string;
  tsMs: number;
  dedupKey: string;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export const parseRolloutMetaLine = parseCodexRolloutMetaLine;

/** The five raw codex counters, read alias-tolerantly (older builds drifted). */
interface RawCodexCounters {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

function firstCounter(obj: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined) return tokenField(v);
  }
  return 0;
}

function readCounters(v: unknown): RawCodexCounters | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return {
    input: firstCounter(o, ['input_tokens', 'prompt_tokens', 'input']),
    cached: firstCounter(o, ['cached_input_tokens', 'cache_read_input_tokens', 'cached_tokens']),
    output: firstCounter(o, ['output_tokens', 'completion_tokens', 'output']),
    reasoning: firstCounter(o, ['reasoning_output_tokens', 'reasoning_tokens']),
    total: firstCounter(o, ['total_tokens', 'total']),
  };
}

/** Per-field saturating subtraction — a cumulative reset clamps to 0, never negative. */
function saturatingSub(a: RawCodexCounters, b: RawCodexCounters): RawCodexCounters {
  return {
    input: Math.max(0, a.input - b.input),
    cached: Math.max(0, a.cached - b.cached),
    output: Math.max(0, a.output - b.output),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
    total: Math.max(0, a.total - b.total),
  };
}

function counterSum(c: RawCodexCounters): number {
  return c.input + c.cached + c.output + c.reasoning + c.total;
}

/** The ISO second (YYYY-MM-DDTHH:MM:SS) of a timestamp — replay-burst granularity. */
function tsSecond(ts: string): string {
  return ts.slice(0, 19);
}

/**
 * Extract per-turn usage deltas from one rollout file's content. A pure
 * sequential state machine: `turn_context` lines update the current model;
 * `token_count` events emit deltas — preferring the per-turn
 * `last_token_usage`, else a saturating diff against the previous cumulative
 * totals (immune to resets). Null `info` and all-zero deltas are skipped.
 *
 * Replay-burst guard (subagent rollouts, ccusage #950): older codex builds
 * replayed the parent's token_counts into a subagent's rollout as a leading
 * same-second burst. When a subagent file's first two events share a
 * timestamp second, the whole leading same-second run is skipped — but its
 * cumulative totals still feed `previousTotals` so later diffs stay correct.
 *
 * Exported for testing the file-level contract directly.
 */
export function extractRolloutUsageEvents(
  content: string,
  meta: RolloutMeta | null
): CodexUsageEvent[] {
  interface RawEvent {
    ts: string;
    tsMs: number;
    model: string;
    totals: RawCodexCounters | null;
    last: RawCodexCounters | null;
  }

  // Pass 1: walk lines tracking the current model; collect raw token_counts.
  const raw: RawEvent[] = [];
  let currentModel = 'unknown';
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof json !== 'object' || json === null) continue;
    const obj = json as Record<string, unknown>;
    const payload =
      typeof obj.payload === 'object' && obj.payload !== null
        ? (obj.payload as Record<string, unknown>)
        : undefined;

    if (obj.type === 'turn_context') {
      const model = payload ? nonEmptyString(payload.model) : undefined;
      if (model !== undefined) currentModel = model;
      continue;
    }
    if (obj.type !== 'event_msg' || payload === undefined || payload.type !== 'token_count') {
      continue;
    }
    const info = payload.info;
    if (typeof info !== 'object' || info === null) continue; // older sessions: leading null-info event
    const i = info as Record<string, unknown>;

    const ts = nonEmptyString(obj.timestamp);
    if (ts === undefined) continue;
    const tsMs = Date.parse(ts);
    if (Number.isNaN(tsMs)) continue;

    // Rare newer builds stamp the model on the info itself — prefer it.
    const model = nonEmptyString(i.model) ?? nonEmptyString(i.model_name) ?? currentModel;
    raw.push({
      ts,
      tsMs,
      model,
      totals: readCounters(i.total_token_usage),
      last: readCounters(i.last_token_usage),
    });
  }
  if (raw.length === 0) return [];

  // Replay-burst guard — see the function doc.
  let skipLeading = 0;
  if (meta?.isSubagent && raw.length >= 2 && tsSecond(raw[0].ts) === tsSecond(raw[1].ts)) {
    const burstSecond = tsSecond(raw[0].ts);
    while (skipLeading < raw.length && tsSecond(raw[skipLeading].ts) === burstSecond) {
      skipLeading++;
    }
  }

  // Pass 2: sequential delta extraction.
  const events: CodexUsageEvent[] = [];
  let prev: RawCodexCounters = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
  raw.forEach((ev, idx) => {
    const delta = ev.last ?? (ev.totals ? saturatingSub(ev.totals, prev) : null);
    if (ev.totals) prev = ev.totals;
    if (idx < skipLeading) return; // replayed burst: totals consumed above, nothing emitted
    if (delta === null || counterSum(delta) === 0) return;

    const cached = Math.min(delta.cached, delta.input);
    const usage: AgentTokenUsage = {
      input_tokens: delta.input - cached,
      output_tokens: delta.output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached,
    };
    if (delta.reasoning > 0) usage.dimensions = { [DIM_REASONING_OUTPUT]: delta.reasoning };

    events.push({
      usage,
      model: ev.model,
      ts: ev.ts,
      tsMs: ev.tsMs,
      // The raw delta counters + the ms timestamp: byte-identical file copies
      // (sessions/ vs archived_sessions/, replayed histories) collapse, while
      // genuine distinct events never collide (an all-zero delta is already
      // dropped above, so equal cumulative totals can't alias).
      dedupKey: JSON.stringify([
        'tc',
        ev.ts,
        delta.input,
        delta.cached,
        delta.output,
        delta.reasoning,
        delta.total,
      ]),
    });
  });
  return events;
}

/**
 * {@link AgentUsageSource} for Codex CLI. Reads on-disk session rollouts.
 *
 * `env` is injected (defaults to `process.env`) so the rollout base dirs are
 * overridable for tests and alternate installs. Discovery mirrors ccusage's
 * codex paths: `CODEX_HOME` is a comma-separated list of codex homes (each
 * scanned as `<home>/sessions` AND `<home>/archived_sessions`, with `~`
 * expanded); unset, it defaults to `~/.codex`.
 */
export class CodexUsageSource implements AgentUsageSource {
  readonly agent = 'codex';
  private readonly locator: CodexRolloutLocator;

  constructor(private readonly env: EnvLike = process.env) {
    this.locator = new CodexRolloutLocator(env);
  }

  /**
   * `CODEX_SESSION_ID` is a wrapper/upstream root channel; released Codex
   * versions inject `CODEX_THREAD_ID`, which is canonicalized before use.
   */
  resolveActiveSessionId(env: EnvLike = this.env): string | null {
    return nonEmptyString(env.CODEX_SESSION_ID) ?? nonEmptyString(env.CODEX_THREAD_ID) ?? null;
  }

  async canonicalizeSessionId(sessionId: string, env: EnvLike = this.env): Promise<string | null> {
    const sid = sessionId.trim();
    if (!sid) return null;
    if (nonEmptyString(env.CODEX_SESSION_ID) === sid) return sid;
    return this.locator.canonicalizeSessionId(sid);
  }

  async readUsage(
    sessionId: string,
    opts: AgentUsageReadOptions = {}
  ): Promise<AgentUsageSnapshot | null> {
    const sid = sessionId?.trim();
    if (!sid) return null;

    const session = await this.locator.locateSession(sid);
    if (!session) return null;

    const untilMs = opts.until ? Date.parse(opts.until) : undefined;

    // First-wins per dedupKey in sorted-file order — deterministic, and the
    // archived copy of a file contributes nothing new.
    const canonical = new Map<string, CodexUsageEvent>();
    for (const rollout of session.rollouts) {
      let raw: string;
      try {
        raw = await readFile(rollout.path, 'utf8');
      } catch {
        continue; // a file vanished mid-scan — skip it
      }
      for (const ev of extractRolloutUsageEvents(raw, rollout.meta)) {
        if (untilMs !== undefined && !Number.isNaN(untilMs) && ev.tsMs > untilMs) continue;
        if (!canonical.has(ev.dedupKey)) canonical.set(ev.dedupKey, ev);
      }
    }

    return buildUsageSnapshot([...canonical.values()], opts.until);
  }

  /**
   * Discover the active session for `opts.cwd`: the freshest rollout (by file
   * mtime, within {@link CODEX_DISCOVERY_RECENCY_MS} of `now`) whose
   * `session_meta.payload.cwd` resolves equal to the invocation cwd. Only the
   * date dirs for `now` and `now − 24h` are scanned — in both local time and
   * UTC, covering midnight/TZ boundaries — and only under `sessions/` (an
   * active session is never archived). A subagent candidate resolves to its
   * ROOT session id. No cwd, no fresh match → `null`, never a guess.
   */
  async discoverActiveSessionId(opts: AgentSessionDiscoveryOptions = {}): Promise<string | null> {
    const cwd = opts.cwd?.trim();
    if (!cwd) return null;
    const nowMs = opts.now !== undefined ? Date.parse(opts.now) : Date.now();
    if (Number.isNaN(nowMs)) return null;
    return this.locator.discoverActiveSessionId(cwd, nowMs, CODEX_DISCOVERY_RECENCY_MS);
  }
}
