/**
 * Claude Code transcript usage parser.
 *
 * Distinct from `stream-parser.ts` (which parses the live `--output-format
 * stream-json` *stdio* of an evaluator subprocess): this reads the **on-disk
 * session transcripts** Claude Code writes to
 * `<base>/projects/<encoded-cwd>/<sessionId>.jsonl`, to recover the *coding
 * agent's own* token usage for a session.
 *
 * Established facts (verified against a live transcript):
 *  - Only `assistant` lines carry `message.usage`; its token fields are
 *    `input_tokens` / `output_tokens` / `cache_creation_input_tokens` /
 *    `cache_read_input_tokens` (other nested fields are ignored).
 *  - `sessionId`, `requestId`, `uuid`, `timestamp` are top-level; `id` and
 *    `model` live under `message`.
 *  - Subagents share the parent `sessionId` but their transcripts live in a
 *    per-session `<sessionId>/subagents/agent-*.jsonl` SUBDIRECTORY (not a flat
 *    sibling), so we scan the flat project dir for the main `<sessionId>.jsonl`
 *    AND recurse the session's own `<sessionId>/` subtree, then filter every
 *    line by the `sessionId` field. The same logical message can appear in more
 *    than one file, so we de-dup by `(message.id, requestId)`.
 *
 * Tokens only — never any pricing.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ClaudeTranscriptLocator } from '@orcaops/agent-activity';

import { buildUsageSnapshot, recordTokenTotal, tokenField } from '../agent-usage/aggregate.js';
import type {
  AgentTokenUsage,
  AgentUsageReadOptions,
  AgentUsageSnapshot,
  AgentUsageSource,
  EnvLike,
} from '../agent-usage/source.js';

// Canonical `dimensions` keys — fixed HERE so parser, storage, wire, and cloud
// pricing agree exactly. The 1h/5m keys SPLIT `cache_creation_input_tokens`
// (they refine it, not add to it); the web_* keys are net-new per-request counts
// (`web_search_requests` is billable, `web_fetch_requests` is tokens-only).
const DIM_CACHE_1H = 'cache_creation_1h_input_tokens';
const DIM_CACHE_5M = 'cache_creation_5m_input_tokens';
const DIM_WEB_SEARCH = 'web_search_requests';
const DIM_WEB_FETCH = 'web_fetch_requests';

/**
 * Extract the OPEN numeric `dimensions` from a raw `usage` object, mapping the
 * nested raw fields to their canonical keys. Sparse: only `> 0` values are
 * included, and the whole map is omitted (undefined) when empty.
 */
function extractDimensions(usage: Record<string, unknown>): Record<string, number> | undefined {
  const dims: Record<string, number> = {};
  const cc = usage.cache_creation;
  if (typeof cc === 'object' && cc !== null) {
    const c = cc as Record<string, unknown>;
    const h1 = tokenField(c.ephemeral_1h_input_tokens);
    const m5 = tokenField(c.ephemeral_5m_input_tokens);
    if (h1 > 0) dims[DIM_CACHE_1H] = h1;
    if (m5 > 0) dims[DIM_CACHE_5M] = m5;
  }
  const stu = usage.server_tool_use;
  if (typeof stu === 'object' && stu !== null) {
    const s = stu as Record<string, unknown>;
    const ws = tokenField(s.web_search_requests);
    const wf = tokenField(s.web_fetch_requests);
    if (ws > 0) dims[DIM_WEB_SEARCH] = ws;
    if (wf > 0) dims[DIM_WEB_FETCH] = wf;
  }
  return Object.keys(dims).length > 0 ? dims : undefined;
}

function extractTokens(usage: Record<string, unknown>): AgentTokenUsage {
  const u: AgentTokenUsage = {
    input_tokens: tokenField(usage.input_tokens),
    output_tokens: tokenField(usage.output_tokens),
    cache_creation_input_tokens: tokenField(usage.cache_creation_input_tokens),
    cache_read_input_tokens: tokenField(usage.cache_read_input_tokens),
  };
  const dimensions = extractDimensions(usage);
  if (dimensions) u.dimensions = dimensions;
  return u;
}

// Price-determining rate classes (Claude: `message.usage.{speed,service_tier,
// inference_geo}`). A raw value absent/empty or equal to one of these no-premium
// defaults collapses to the default bucket and is OMITTED, so an all-standard
// session never splits; only a real premium class is carried.
const SPEED_DEFAULTS: readonly string[] = ['standard'];
const SERVICE_TIER_DEFAULTS: readonly string[] = ['standard'];
const INFERENCE_GEO_DEFAULTS: readonly string[] = ['global', 'not_available'];

/**
 * Normalize a raw rate-class value: the trimmed string when it's a non-default
 * (premium) class, else `undefined` (absent / empty / default ⇒ omit).
 */
function rateClass(raw: unknown, defaults: readonly string[]): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  return v.length === 0 || defaults.includes(v) ? undefined : v;
}

interface ParsedUsageRecord {
  usage: AgentTokenUsage;
  model: string;
  ts: string;
  tsMs: number;
  dedupKey: string;
  // Non-default rate classes (undefined when default). The per-model breakdown
  // is partitioned by (model, speed, service_tier, inference_geo).
  speed?: string;
  service_tier?: string;
  inference_geo?: string;
}

/**
 * A monotone "richness" score used ONLY to break scalar-total ties between
 * duplicate records, so the more-complete record is kept rather than dropped:
 * count of populated scalar token fields + populated `dimensions` keys +
 * non-default rate-class fields, so a duplicate carrying the richer price facts
 * wins a scalar tie.
 */
function recordCompleteness(r: ParsedUsageRecord): number {
  const u = r.usage;
  let n = 0;
  if (u.input_tokens > 0) n++;
  if (u.output_tokens > 0) n++;
  if (u.cache_creation_input_tokens > 0) n++;
  if (u.cache_read_input_tokens > 0) n++;
  if (u.dimensions) n += Object.keys(u.dimensions).length;
  if (r.speed !== undefined) n++;
  if (r.service_tier !== undefined) n++;
  if (r.inference_geo !== undefined) n++;
  return n;
}

/**
 * Is `a` the more canonical of two duplicate records (same dedupKey)? Greatest
 * total tokens wins (a complete record dominates a streaming partial); on an
 * exact scalar-total tie the more-complete record wins (so a duplicate with
 * richer metadata is not dropped), then latest `ts`; a full tie keeps the
 * already-stored record — deterministic because files are scanned in sorted order.
 */
function isMoreCanonical(a: ParsedUsageRecord, b: ParsedUsageRecord): boolean {
  const at = recordTokenTotal(a.usage);
  const bt = recordTokenTotal(b.usage);
  if (at !== bt) return at > bt;
  const ac = recordCompleteness(a);
  const bc = recordCompleteness(b);
  if (ac !== bc) return ac > bc;
  return a.ts > b.ts;
}

/**
 * Parse one transcript line into a usage record, or `null` when the line is
 * blank, malformed, for another session, or carries no usage.
 *
 * Exported for testing the line-level contract directly.
 */
export function parseTranscriptUsageLine(
  line: string,
  sessionId: string
): ParsedUsageRecord | null {
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

  // Filter by the sessionId field — this is what scopes a record to the
  // session (subagents inline or in sibling files share the parent id).
  if (obj.sessionId !== sessionId) return null;

  const message = obj.message;
  if (typeof message !== 'object' || message === null) return null;
  const msg = message as Record<string, unknown>;
  const usageRaw = msg.usage;
  if (typeof usageRaw !== 'object' || usageRaw === null) return null;

  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;
  if (!ts) return null;
  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs)) return null;

  const usageObj = usageRaw as Record<string, unknown>;
  const usage = extractTokens(usageObj);
  const model = typeof msg.model === 'string' && msg.model.length > 0 ? msg.model : 'unknown';
  // Price-determining rate classes (siblings of the token fields under usage),
  // normalized so a default/absent value is omitted (no spurious bucket split).
  const speed = rateClass(usageObj.speed, SPEED_DEFAULTS);
  const service_tier = rateClass(usageObj.service_tier, SERVICE_TIER_DEFAULTS);
  const inference_geo = rateClass(usageObj.inference_geo, INFERENCE_GEO_DEFAULTS);

  // De-dup the same logical message across files by (message.id, requestId).
  // Fall back to uuid, then the raw line, so identical lines still collapse
  // and distinct lines never do — all deterministic (no randomness).
  const id = typeof msg.id === 'string' ? msg.id : undefined;
  const requestId = typeof obj.requestId === 'string' ? obj.requestId : undefined;
  const uuid = typeof obj.uuid === 'string' ? obj.uuid : undefined;
  const dedupKey = id
    ? JSON.stringify(['id', id, requestId ?? ''])
    : uuid
      ? JSON.stringify(['uuid', uuid])
      : JSON.stringify(['line', trimmed]);

  return { usage, model, ts, tsMs, dedupKey, speed, service_tier, inference_geo };
}

/**
 * {@link AgentUsageSource} for Claude Code. Reads on-disk session transcripts.
 *
 * `env` is injected for tests and alternate installs. Claude-specific root
 * normalization and anchor lookup are owned by {@link ClaudeTranscriptLocator}.
 */
export class ClaudeCodeUsageSource implements AgentUsageSource {
  readonly agent = 'claude-code';

  constructor(private readonly env: EnvLike = process.env) {}

  resolveActiveSessionId(env: EnvLike = this.env): string | null {
    const id = env.CLAUDE_CODE_SESSION_ID;
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
  }

  async readUsage(
    sessionId: string,
    opts: AgentUsageReadOptions = {}
  ): Promise<AgentUsageSnapshot | null> {
    const sid = sessionId?.trim();
    if (!sid) return null;

    const location = await new ClaudeTranscriptLocator(this.env).locateSession(sid, opts.cwd);
    if (!location) return null;

    const files = await this.listTranscriptFiles(location.projectDir, sid);
    if (files.length === 0) return null;

    const untilMs = opts.until ? Date.parse(opts.until) : undefined;

    // Collect candidates, then resolve duplicates DETERMINISTICALLY. The same
    // logical message can appear in more than one file (subagent inline +
    // sibling), so among records sharing a dedupKey we keep ONE canonical
    // record — the greatest total tokens (a complete record dominates a
    // streaming partial), tie-broken by latest `ts` then scan order. Files are
    // scanned in sorted order, so the result is independent of dir-scan order.
    const canonical = new Map<string, ParsedUsageRecord>();
    for (const file of files) {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        continue; // a sibling vanished mid-scan — skip it
      }
      for (const line of raw.split('\n')) {
        const rec = parseTranscriptUsageLine(line, sid);
        if (!rec) continue;
        if (untilMs !== undefined && !Number.isNaN(untilMs) && rec.tsMs > untilMs) continue;
        const cur = canonical.get(rec.dedupKey);
        if (cur === undefined || isMoreCanonical(rec, cur)) canonical.set(rec.dedupKey, rec);
      }
    }

    // Aggregate the resolved records via the shared snapshot builder (see
    // `agent-usage/aggregate.ts`) — partitioned by rate class, zero rows
    // dropped, byte-order sorted, `null` when nothing was counted.
    return buildUsageSnapshot([...canonical.values()], opts.until);
  }

  /**
   * List the session's `*.jsonl` transcripts (full paths, sorted by name for a
   * deterministic scan order): the flat `*.jsonl` in the project dir (the main
   * `<sessionId>.jsonl`) UNIONed with every `*.jsonl` found recursively under the
   * session's own `<sessionId>/` subtree (`subagents/agent-*.jsonl`, depth-robust).
   * Scoped to `<sessionId>/` so sibling sessions' large files aren't read; the
   * per-line `sessionId` filter remains the authoritative safety net. No mtime
   * pruning. Only `.jsonl` is returned, so `agent-*.meta.json` and
   * `tool-results/*.txt` are excluded.
   */
  private async listTranscriptFiles(dir: string, sessionId: string): Promise<string[]> {
    const files: string[] = [];

    // Flat `*.jsonl` in the project dir — the main `<sessionId>.jsonl` lives here.
    try {
      for (const name of await readdir(dir)) {
        if (name.endsWith('.jsonl')) files.push(path.join(dir, name));
      }
    } catch {
      return []; // project dir vanished — nothing to read
    }

    // Plus the session's own subtree (`<sessionId>/subagents/...`). Disjoint from
    // the flat scan (different path prefix), so no double-count; the subtree is
    // absent for sessions with no subagents, which the helper treats as empty.
    files.push(...(await collectJsonlRecursive(path.join(dir, sessionId))));

    return files.sort();
  }
}

/**
 * Collect `*.jsonl` files recursively under `dir` (full paths, unsorted — the
 * caller sorts the union). A missing `dir` (the session has no `<sessionId>/`
 * subtree) is normal and yields `[]`. Symlinks are not followed (avoids cycles);
 * `isFile()` is false for a symlink, so only real `.jsonl` files are returned.
 */
async function collectJsonlRecursive(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectJsonlRecursive(full)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}
