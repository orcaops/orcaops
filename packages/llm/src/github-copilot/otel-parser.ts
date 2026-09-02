/**
 * GitHub Copilot CLI OTel usage parser.
 *
 * Reads the OpenTelemetry JSONL files Copilot CLI's file exporter writes —
 * `~/.copilot/otel/*.jsonl` (the conventional export dir) plus the single
 * file named by `COPILOT_OTEL_FILE_EXPORTER_PATH` — to recover the coding
 * agent's own token usage for a session.
 *
 * IMPORTANT: Copilot's OTel file export is OFF by default. It must be enabled
 * before the session runs (`COPILOT_OTEL_ENABLED=true`,
 * `COPILOT_OTEL_EXPORTER_TYPE=file`, `COPILOT_OTEL_FILE_EXPORTER_PATH=...`);
 * sessions exported nowhere produce no local usage data, and capture is then
 * a clean no-op.
 *
 * The exporter emits HETEROGENEOUS JSONL — spans, log records, and metrics in
 * one file — and the SAME LLM response can appear under several shapes.
 * Mirroring ccusage's `adapter/copilot/`, four shapes are recognized, in
 * precedence order: chat spans (`gen_ai.operation.name == "chat"`), inference
 * logs (`event.name == "gen_ai.client.inference.operation.details"`),
 * agent-turn logs (`copilot_chat.agent.turn`), and agent-summary spans
 * (`invoke_agent`); a lower shape is suppressed when a higher one shares its
 * `traceId` or `gen_ai.response.id`.
 *
 * Usage rides `gen_ai.usage.*` attributes (dotted names since CLI v1.0.56;
 * the older underscore-separated names are also accepted). Copilot reports
 * `input_tokens` INCLUSIVE of cache reads, so the cache-read count is
 * subtracted out of input (with `cache_read = min(cache_read, input)`) —
 * matching how ccusage prices Copilot. Reasoning output tokens are carried as
 * the open `reasoning_output_tokens` dimension (a refinement of
 * `output_tokens`).
 *
 * Session identity comes from span/log attributes with a priority scheme
 * (`gen_ai.conversation.id` / `copilot_chat.session_id` /
 * `copilot_chat.chat_session_id` / `session.id`, then
 * `github.copilot.interaction_id`, then `gen_ai.response.id`), with records
 * lacking a session attr inheriting one from a sibling record in the same
 * trace, then falling back to the `traceId`.
 *
 * Tokens only — never any pricing.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildUsageSnapshot, DIM_REASONING_OUTPUT, tokenField } from '../agent-usage/aggregate.js';
import type {
  AgentTokenUsage,
  AgentUsageReadOptions,
  AgentUsageSnapshot,
  AgentUsageSource,
  EnvLike,
} from '../agent-usage/source.js';

/** One resolved usage-carrying OTel record. */
export interface CopilotUsageRecord {
  usage: AgentTokenUsage;
  model: string;
  sessionId: string;
  ts: string;
  tsMs: number;
  dedupKey: string;
}

/** The four recognized record shapes, in suppression-precedence order. */
type UsageShape = 'chat_span' | 'inference_log' | 'agent_turn_log' | 'agent_summary_span';
const SHAPE_RANK: Record<UsageShape, number> = {
  chat_span: 0,
  inference_log: 1,
  agent_turn_log: 2,
  agent_summary_span: 3,
};

/** Session-identity attributes, highest priority wins (ties: later scanned). */
const SESSION_ATTRS: ReadonlyArray<readonly [string, number]> = [
  ['gen_ai.conversation.id', 3],
  ['copilot_chat.session_id', 3],
  ['copilot_chat.chat_session_id', 3],
  ['session.id', 3],
  ['github.copilot.interaction_id', 2],
  ['gen_ai.response.id', 1],
];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

function firstAttr(attrs: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const v = attrs[key];
    if (v !== undefined) return tokenField(v);
  }
  return 0;
}

interface RawOtelRecord {
  obj: Record<string, unknown>;
  attrs: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}

function parseRawRecord(line: string): RawOtelRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const obj = asObject(json);
  if (obj === undefined) return null;
  const attrs = asObject(obj.attributes);
  if (attrs === undefined) return null; // every usable shape carries attributes

  const spanContext = asObject(obj.spanContext);
  const rec: RawOtelRecord = { obj, attrs };
  const traceId =
    str(obj.traceId) ?? (spanContext !== undefined ? str(spanContext.traceId) : undefined);
  const spanId =
    str(obj.spanId) ?? (spanContext !== undefined ? str(spanContext.spanId) : undefined);
  if (traceId !== undefined) rec.traceId = traceId;
  if (spanId !== undefined) rec.spanId = spanId;
  return rec;
}

/** Span-vs-log discrimination: an explicit `type` decides; else a heuristic. */
function isSpanRecord(obj: Record<string, unknown>): boolean {
  const type = str(obj.type);
  if (type !== undefined) return type === 'span';
  return (
    str(obj.name) !== undefined &&
    (obj.spanId !== undefined ||
      obj.traceId !== undefined ||
      obj.startTime !== undefined ||
      obj.endTime !== undefined ||
      obj.duration !== undefined ||
      obj.kind !== undefined)
  );
}

function bodyOf(obj: Record<string, unknown>): string | undefined {
  return str(obj._body) ?? str(obj.body);
}

function classifyShape(rec: RawOtelRecord): UsageShape | null {
  const { obj, attrs } = rec;
  const opName = str(attrs['gen_ai.operation.name']);
  const name = str(obj.name);
  const eventName = str(attrs['event.name']);
  const body = bodyOf(obj);
  if (isSpanRecord(obj)) {
    if (opName === 'chat' || name?.startsWith('chat ') === true) return 'chat_span';
    if (opName === 'invoke_agent' || name?.startsWith('invoke_agent ') === true) {
      return 'agent_summary_span';
    }
    return null;
  }
  if (
    eventName === 'gen_ai.client.inference.operation.details' ||
    body?.startsWith('GenAI inference:') === true
  ) {
    return 'inference_log';
  }
  if (
    eventName === 'copilot_chat.agent.turn' ||
    body?.startsWith('copilot_chat.agent.turn') === true
  ) {
    return 'agent_turn_log';
  }
  return null;
}

/** The highest-priority session attr present, or undefined. */
function bestSessionAttr(
  attrs: Record<string, unknown>
): { value: string; prio: number } | undefined {
  let best: { value: string; prio: number } | undefined;
  for (const [key, prio] of SESSION_ATTRS) {
    const value = str(attrs[key]);
    if (value !== undefined && (best === undefined || prio >= best.prio)) {
      best = { value, prio };
    }
  }
  return best;
}

function modelAttr(attrs: Record<string, unknown>): string | undefined {
  return str(attrs['gen_ai.response.model']) ?? str(attrs['gen_ai.request.model']);
}

/** `[seconds, nanos]` array timestamp → ms. */
function tsFromParts(v: unknown): number | undefined {
  if (!Array.isArray(v) || v.length < 2) return undefined;
  const sec = v[0];
  const nanos = v[1];
  if (typeof sec !== 'number' || typeof nanos !== 'number') return undefined;
  return sec * 1000 + Math.floor(nanos / 1e6);
}

/** Scalar timestamp with magnitude-based unit autodetection (ns/µs/ms/s), or ISO string. */
function tsFromScalar(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  if (v >= 1e17) return Math.floor(v / 1e6); // nanoseconds
  if (v >= 1e14) return Math.floor(v / 1e3); // microseconds
  if (v >= 1e11) return Math.floor(v); // milliseconds
  return Math.floor(v * 1000); // seconds
}

/** The record's timestamp in ms, trying every encoding the exporter uses. */
function recordTsMs(obj: Record<string, unknown>): number | undefined {
  return (
    tsFromParts(obj.endTime) ??
    tsFromParts(obj.startTime) ??
    tsFromParts(obj.hrTime) ??
    tsFromParts(obj._hrTime) ??
    tsFromParts(obj.time) ??
    tsFromScalar(obj.timestamp) ??
    tsFromScalar(obj.observedTimestamp) ??
    (typeof obj.timeUnixNano === 'number' && Number.isFinite(obj.timeUnixNano)
      ? Math.floor(obj.timeUnixNano / 1e6)
      : undefined)
  );
}

/**
 * Extract the session-attributable usage records from one OTel JSONL file's
 * content. Pure. `fileMtimeMs` is the timestamp fallback for records carrying
 * no recognizable time encoding.
 *
 * Exported for testing the file-level contract directly.
 */
export function extractOtelUsageRecords(
  content: string,
  fileMtimeMs: number
): CopilotUsageRecord[] {
  const raw: RawOtelRecord[] = [];
  for (const line of content.split('\n')) {
    const rec = parseRawRecord(line);
    if (rec !== null) raw.push(rec);
  }
  if (raw.length === 0) return [];

  // Pass 1 — trace contexts: a usage record lacking a session attr or model
  // inherits them from a sibling record in the same trace.
  const traceCtx = new Map<string, { session?: { value: string; prio: number }; model?: string }>();
  for (const rec of raw) {
    if (rec.traceId === undefined) continue;
    const ctx = traceCtx.get(rec.traceId) ?? {};
    const session = bestSessionAttr(rec.attrs);
    if (session !== undefined && (ctx.session === undefined || session.prio > ctx.session.prio)) {
      ctx.session = session;
    }
    if (ctx.model === undefined) {
      const model = modelAttr(rec.attrs);
      if (model !== undefined) ctx.model = model;
    }
    traceCtx.set(rec.traceId, ctx);
  }

  // Pass 2 — candidates.
  interface Candidate extends CopilotUsageRecord {
    shape: UsageShape;
    traceId?: string;
    responseId?: string;
  }
  const candidates: Candidate[] = [];
  raw.forEach((rec, index) => {
    const shape = classifyShape(rec);
    if (shape === null) return;
    const { attrs } = rec;

    const inputRaw = firstAttr(attrs, ['gen_ai.usage.input_tokens']);
    const output = firstAttr(attrs, ['gen_ai.usage.output_tokens']);
    const cacheReadRaw = firstAttr(attrs, [
      'gen_ai.usage.cache_read.input_tokens',
      'gen_ai.usage.cache_read_input_tokens',
    ]);
    const cacheWrite = firstAttr(attrs, [
      'gen_ai.usage.cache_write.input_tokens',
      'gen_ai.usage.cache_creation.input_tokens',
      'gen_ai.usage.cache_write_input_tokens',
      'gen_ai.usage.cache_creation_input_tokens',
    ]);
    const reasoning = firstAttr(attrs, [
      'gen_ai.usage.reasoning.output_tokens',
      'gen_ai.usage.reasoning_tokens',
      'gen_ai.usage.reasoning_output_tokens',
    ]);
    if (inputRaw + output + cacheReadRaw + cacheWrite + reasoning === 0) return;

    // Copilot input is cache-inclusive — subtract the cache read back out.
    const cacheRead = Math.min(cacheReadRaw, inputRaw);
    const usage: AgentTokenUsage = {
      input_tokens: inputRaw - cacheRead,
      output_tokens: output,
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
    };
    if (reasoning > 0) usage.dimensions = { [DIM_REASONING_OUTPUT]: reasoning };

    const ctx = rec.traceId !== undefined ? traceCtx.get(rec.traceId) : undefined;
    const sessionId =
      bestSessionAttr(attrs)?.value ?? ctx?.session?.value ?? rec.traceId ?? 'unknown-session';
    const model = modelAttr(attrs) ?? ctx?.model ?? 'unknown';
    const tsMs = recordTsMs(rec.obj) ?? fileMtimeMs;
    const ts = new Date(tsMs).toISOString();
    const responseId = str(attrs['gen_ai.response.id']);

    let dedupKey: string;
    if (shape === 'chat_span' || shape === 'agent_summary_span') {
      dedupKey =
        rec.traceId !== undefined && rec.spanId !== undefined
          ? `${rec.traceId}:${rec.spanId}`
          : `span:${sessionId}:${tsMs}:${index}`;
    } else if (shape === 'inference_log') {
      dedupKey =
        rec.traceId !== undefined && rec.spanId !== undefined
          ? `log:${rec.traceId}:${rec.spanId}`
          : `log:${sessionId}:${tsMs}:${index}`;
    } else {
      const turn =
        str(attrs['turn.index']) ?? str(attrs['copilot_chat.turn.index']) ?? `idx-${index}`;
      dedupKey =
        rec.traceId !== undefined
          ? `agent-turn:${rec.traceId}:${turn}`
          : `agent-turn:${sessionId}:${turn}:${index}`;
    }

    const candidate: Candidate = { usage, model, sessionId, ts, tsMs, dedupKey, shape };
    if (rec.traceId !== undefined) candidate.traceId = rec.traceId;
    if (responseId !== undefined) candidate.responseId = responseId;
    candidates.push(candidate);
  });

  // Pass 3 — cross-shape suppression: the same LLM response is exported under
  // several shapes; a candidate is dropped when a strictly-higher-precedence
  // shape shares its traceId or response id.
  const traceIdsByRank = new Map<number, Set<string>>();
  const responseIdsByRank = new Map<number, Set<string>>();
  const addToRank = (map: Map<number, Set<string>>, rank: number, value: string): void => {
    let set = map.get(rank);
    if (set === undefined) {
      set = new Set();
      map.set(rank, set);
    }
    set.add(value);
  };
  for (const c of candidates) {
    const rank = SHAPE_RANK[c.shape];
    if (c.traceId !== undefined) addToRank(traceIdsByRank, rank, c.traceId);
    if (c.responseId !== undefined) addToRank(responseIdsByRank, rank, c.responseId);
  }
  return candidates.filter((c) => {
    const rank = SHAPE_RANK[c.shape];
    for (let higher = 0; higher < rank; higher++) {
      if (c.traceId !== undefined && traceIdsByRank.get(higher)?.has(c.traceId) === true) {
        return false;
      }
      if (c.responseId !== undefined && responseIdsByRank.get(higher)?.has(c.responseId) === true) {
        return false;
      }
    }
    return true;
  });
}

/**
 * {@link AgentUsageSource} for GitHub Copilot CLI. Reads local OTel JSONL.
 *
 * `env` is injected (defaults to `process.env`) so the export locations are
 * overridable for tests: `$HOME/.copilot/otel/*.jsonl` plus the file at
 * `COPILOT_OTEL_FILE_EXPORTER_PATH`, deduped.
 *
 * Session resolution is env-based: Copilot CLI (≥ v1.0.29) injects
 * `COPILOT_AGENT_SESSION_ID` into the shell commands it runs — the same
 * pattern as Claude Code. There is no filesystem discovery: the OTel data
 * carries no working-directory fact to match against, and the env channel is
 * reliable on any Copilot recent enough to also emit usage telemetry.
 */
export class CopilotUsageSource implements AgentUsageSource {
  readonly agent = 'github-copilot';

  constructor(private readonly env: EnvLike = process.env) {}

  resolveActiveSessionId(env: EnvLike = this.env): string | null {
    const id = env.COPILOT_AGENT_SESSION_ID;
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
  }

  async readUsage(
    sessionId: string,
    opts: AgentUsageReadOptions = {}
  ): Promise<AgentUsageSnapshot | null> {
    const sid = sessionId?.trim();
    if (!sid) return null;

    const files = await this.otelFiles();
    if (files.length === 0) return null;

    const untilMs = opts.until ? Date.parse(opts.until) : undefined;
    const canonical = new Map<string, CopilotUsageRecord>();
    for (const file of files) {
      let content: string;
      let mtimeMs: number;
      try {
        content = await readFile(file, 'utf8');
        mtimeMs = (await stat(file)).mtimeMs;
      } catch {
        continue; // a file vanished mid-scan — skip it
      }
      for (const rec of extractOtelUsageRecords(content, mtimeMs)) {
        if (rec.sessionId !== sid) continue;
        if (untilMs !== undefined && !Number.isNaN(untilMs) && rec.tsMs > untilMs) continue;
        if (!canonical.has(rec.dedupKey)) canonical.set(rec.dedupKey, rec);
      }
    }
    return buildUsageSnapshot([...canonical.values()], opts.until);
  }

  /**
   * The sorted, deduped OTel JSONL files: the conventional export dir
   * (`~/.copilot/otel`, non-recursive) plus the explicit exporter path.
   */
  private async otelFiles(): Promise<string[]> {
    const home = this.env.HOME ?? os.homedir();
    const files = new Set<string>();
    const dir = path.join(home, '.copilot', 'otel');
    try {
      for (const name of await readdir(dir)) {
        if (name.endsWith('.jsonl')) files.add(path.join(dir, name));
      }
    } catch {
      // export dir absent — normal for a Copilot install without OTel export
    }
    const override = this.env.COPILOT_OTEL_FILE_EXPORTER_PATH?.trim();
    if (override !== undefined && override.length > 0) {
      try {
        if ((await stat(override)).isFile()) files.add(path.resolve(override));
      } catch {
        // exporter path not created yet — normal early in a session
      }
    }
    return [...files].sort();
  }
}
