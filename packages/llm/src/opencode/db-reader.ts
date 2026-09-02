/**
 * OpenCode usage reader.
 *
 * Reads the message store OpenCode keeps under
 * `${OPENCODE_DATA_DIR:-$XDG_DATA_HOME/opencode | ~/.local/share/opencode}`:
 * primarily the SQLite `opencode.db` (table `message(id, session_id, data)`
 * where `data` is a JSON blob), with the legacy per-message JSON files
 * (`storage/message/<sessionID>/<messageID>.json`) as a fallback — the DB row
 * wins when the same message id appears in both (mirroring ccusage's
 * `adapter/opencode/`).
 *
 * Assistant message `data` carries `tokens{input, output, reasoning,
 * cache{read, write}}`, `modelID`, `providerID`, and `time.created` (ms
 * epoch). Mapping to Claude-native fields: `tokens.input` → `input_tokens`,
 * `tokens.output` → `output_tokens`, `tokens.cache.read` →
 * `cache_read_input_tokens`, `tokens.cache.write` →
 * `cache_creation_input_tokens`, and `tokens.reasoning` carried as the open
 * `reasoning_output_tokens` dimension. The stored `cost` field is IGNORED —
 * it is known-unreliable upstream ($0 for custom providers, past cache
 * pricing bugs) and orcaops never prices locally anyway.
 *
 * OpenCode subagents run as CHILD SESSIONS (`parentID` linkage); a read for a
 * root session rolls its descendants up. The `session` table's exact shape is
 * unverified upstream, so everything touching it is defensive: any schema
 * surprise degrades to exact-session capture (still correct, just unrolled)
 * or a null discovery — never a throw.
 *
 * `better-sqlite3` is imported LAZILY inside a try/catch so a broken native
 * build degrades to the JSON fallback instead of failing a capture command.
 *
 * Tokens only — never any pricing.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildUsageSnapshot, DIM_REASONING_OUTPUT, tokenField } from '../agent-usage/aggregate.js';
import type {
  AgentSessionDiscoveryOptions,
  AgentTokenUsage,
  AgentUsageReadOptions,
  AgentUsageSnapshot,
  AgentUsageSource,
  EnvLike,
} from '../agent-usage/source.js';

type Database = BetterSqlite3.Database;

/**
 * Discovery recency window: a session counts as "active" only when its
 * `time.updated` falls within this window of `now`. Same rationale as the
 * Codex window — a capture verb runs mid-session, and a skipped stamp is
 * harmless (the next verb re-reads cumulatively).
 */
export const OPENCODE_DISCOVERY_RECENCY_MS = 30 * 60_000;

/** One usage-carrying OpenCode message, resolved for aggregation. */
export interface OpenCodeUsageRecord {
  /** The message id — the cross-source (DB vs legacy JSON) dedup key. */
  id: string;
  sessionId?: string;
  usage: AgentTokenUsage;
  model: string;
  ts: string;
  tsMs: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * Map one OpenCode message-data JSON value to a usage record, or `null` when
 * the message carries no usage (user messages, zero-usage rows) or no
 * resolvable id. `fallbackId` / `fallbackSessionId` come from the DB row
 * columns or the legacy file layout when the JSON omits them.
 *
 * Exported for testing the message-level contract directly.
 */
export function parseOpenCodeMessage(
  data: unknown,
  fallbackId?: string,
  fallbackSessionId?: string
): OpenCodeUsageRecord | null {
  const obj = asObject(data);
  const id = (obj !== undefined ? str(obj.id) : undefined) ?? fallbackId;
  if (obj === undefined || id === undefined) return null;

  const tokens = asObject(obj.tokens);
  if (tokens === undefined) return null; // no tokens object → not a usage-carrying message

  const input = tokenField(tokens.input);
  const output = tokenField(tokens.output);
  const reasoning = tokenField(tokens.reasoning);
  // `cache` is tolerated as a non-object (observed upstream) — reads as 0/0.
  const cache = asObject(tokens.cache);
  const cacheRead = cache !== undefined ? tokenField(cache.read) : 0;
  const cacheWrite = cache !== undefined ? tokenField(cache.write) : 0;
  if (input + output + reasoning + cacheRead + cacheWrite === 0) return null;

  const usage: AgentTokenUsage = {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
  if (reasoning > 0) usage.dimensions = { [DIM_REASONING_OUTPUT]: reasoning };

  // Composite `provider/model` key: the same modelID is billed differently
  // per provider (anthropic vs openrouter vs copilot), and the composite
  // rides the existing model string with zero schema change.
  const providerID = str(obj.providerID);
  const modelID = str(obj.modelID);
  const model =
    providerID !== undefined && modelID !== undefined
      ? `${providerID}/${modelID}`
      : (modelID ?? 'unknown');

  const time = asObject(obj.time);
  const createdMs = time !== undefined ? num(time.created) : undefined;
  const tsMs = createdMs ?? 0;
  const ts = createdMs !== undefined ? new Date(createdMs).toISOString() : '';

  const rec: OpenCodeUsageRecord = { id, usage, model, ts, tsMs };
  const sessionId = str(obj.sessionID) ?? fallbackSessionId;
  if (sessionId !== undefined) rec.sessionId = sessionId;
  return rec;
}

interface MessageRow {
  id: unknown;
  session_id: unknown;
  data: unknown;
}

/**
 * {@link AgentUsageSource} for OpenCode. Reads the local message store.
 *
 * `env` is injected (defaults to `process.env`) so the data dirs are
 * overridable for tests and alternate installs: `OPENCODE_DATA_DIR` is a
 * comma-separated list of data dirs (with `~` expanded); unset, BOTH
 * `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`) and
 * `~/.local/share/opencode` are scanned, deduped.
 */
export class OpenCodeUsageSource implements AgentUsageSource {
  readonly agent = 'opencode';

  constructor(private readonly env: EnvLike = process.env) {}

  /**
   * ASPIRATIONAL env channel: OpenCode is not known to set
   * `OPENCODE_SESSION_ID` for spawned shell commands today. It costs nothing
   * and becomes load-bearing the day upstream ships it; discovery is the
   * real path.
   */
  resolveActiveSessionId(env: EnvLike = this.env): string | null {
    const id = env.OPENCODE_SESSION_ID;
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
  }

  async readUsage(
    sessionId: string,
    opts: AgentUsageReadOptions = {}
  ): Promise<AgentUsageSnapshot | null> {
    const sid = sessionId?.trim();
    if (!sid) return null;

    const untilMs = opts.until ? Date.parse(opts.until) : undefined;
    // Keyed by message id — DB rows are inserted before the legacy JSON pass,
    // so the DB always wins for a message present in both.
    const canonical = new Map<string, OpenCodeUsageRecord>();

    for (const dir of this.dataDirs()) {
      const sessionSet = new Set<string>([sid]);

      const db = await this.openDb(dir);
      if (db !== null) {
        try {
          for (const s of collectSessionSet(db, sid)) sessionSet.add(s);
          const ids = [...sessionSet];
          const placeholders = ids.map(() => '?').join(',');
          const rows = db
            .prepare(
              `SELECT id, session_id, data FROM message WHERE session_id IN (${placeholders})`
            )
            .all(...ids) as MessageRow[];
          for (const row of rows) {
            let data: unknown;
            try {
              data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
            } catch {
              continue; // unparseable row — skip it
            }
            const rec = parseOpenCodeMessage(data, str(row.id), str(row.session_id));
            if (rec !== null && !canonical.has(rec.id)) canonical.set(rec.id, rec);
          }
        } catch {
          // corrupt/locked DB or schema surprise → the JSON pass still runs
        } finally {
          try {
            db.close();
          } catch {
            // already closed — nothing to release
          }
        }
      }

      // Legacy JSON fallback: storage/message/<sessionID>/<messageID>.json.
      // Also covers descendant sessions discovered from the DB's session table.
      for (const s of [...sessionSet]) {
        const msgDir = path.join(dir, 'storage', 'message', s);
        let entries: string[];
        try {
          entries = await readdir(msgDir);
        } catch {
          continue; // no legacy store for this session — normal
        }
        for (const name of entries.sort()) {
          if (!name.endsWith('.json')) continue;
          const msgId = name.slice(0, -'.json'.length);
          if (canonical.has(msgId)) continue; // DB wins
          let data: unknown;
          try {
            data = JSON.parse(await readFile(path.join(msgDir, name), 'utf8'));
          } catch {
            continue;
          }
          const rec = parseOpenCodeMessage(data, msgId, s);
          if (rec !== null && !canonical.has(rec.id)) canonical.set(rec.id, rec);
        }
      }
    }

    const counted = [...canonical.values()].filter(
      (r) => untilMs === undefined || Number.isNaN(untilMs) || r.tsMs <= untilMs
    );
    return buildUsageSnapshot(counted, opts.until);
  }

  /**
   * Discover the active session for `opts.cwd`: the ROOT session (no parent)
   * whose recorded `directory` resolves equal to the invocation cwd and whose
   * `time.updated` falls within {@link OPENCODE_DISCOVERY_RECENCY_MS} of
   * `now`; the most-recently-updated match wins. Reads only the DB (a
   * legacy-JSON-only install predates active use). Any schema surprise →
   * `null`, never a guess.
   */
  async discoverActiveSessionId(opts: AgentSessionDiscoveryOptions = {}): Promise<string | null> {
    const cwd = opts.cwd?.trim();
    if (!cwd) return null;
    const nowMs = opts.now !== undefined ? Date.parse(opts.now) : Date.now();
    if (Number.isNaN(nowMs)) return null;

    for (const dir of this.dataDirs()) {
      const db = await this.openDb(dir);
      if (db === null) continue;
      try {
        const rows = db.prepare('SELECT * FROM session').all() as Record<string, unknown>[];
        let best: { id: string; updatedMs: number } | null = null;
        for (const row of rows) {
          const parsed = sessionRowFacts(row);
          if (parsed === null || parsed.parentId !== undefined) continue; // children never win discovery
          if (parsed.directory === undefined || parsed.updatedMs === undefined) continue;
          if (path.resolve(parsed.directory) !== path.resolve(cwd)) continue;
          if (parsed.updatedMs < nowMs - OPENCODE_DISCOVERY_RECENCY_MS) continue;
          if (best === null || parsed.updatedMs > best.updatedMs) {
            best = { id: parsed.id, updatedMs: parsed.updatedMs };
          }
        }
        if (best !== null) return best.id;
      } catch {
        // schema surprise / locked DB → try the next data dir
      } finally {
        try {
          db.close();
        } catch {
          // already closed — nothing to release
        }
      }
    }
    return null;
  }

  /**
   * The ordered, deduped data dirs to scan. Pure and synchronous — never
   * stats the disk and never throws.
   */
  private dataDirs(): string[] {
    const home = this.env.HOME ?? os.homedir();
    const configured = this.env.OPENCODE_DATA_DIR;
    if (configured && configured.trim().length > 0) {
      const dirs = configured
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((raw) => expandHome(raw, home));
      return dedupe(dirs);
    }
    const xdgHome = this.env.XDG_DATA_HOME;
    const xdg = xdgHome && xdgHome.trim().length > 0 ? xdgHome : path.join(home, '.local', 'share');
    return dedupe([path.join(xdg, 'opencode'), path.join(home, '.local', 'share', 'opencode')]);
  }

  /**
   * Open the dir's message DB read-only: `opencode.db`, else the
   * lexicographically-first `opencode-<channel>.db` (mirroring ccusage).
   * Returns `null` when no DB exists, the native module can't load, or the
   * open fails — capture then degrades to the legacy JSON pass.
   */
  private async openDb(dir: string): Promise<Database | null> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }
    const dbName = entries.includes('opencode.db')
      ? 'opencode.db'
      : entries.filter((e) => /^opencode-.+\.db$/.test(e)).sort()[0];
    if (dbName === undefined) return null;

    try {
      // Lazy import: consumers that never touch OpenCode pay no native-module
      // load, and a broken native build degrades to null instead of throwing.
      const { default: DatabaseCtor } = await import('better-sqlite3');
      return new DatabaseCtor(path.join(dir, dbName), { readonly: true, fileMustExist: true });
    } catch {
      return null;
    }
  }
}

/** The defensively-extracted facts of one `session` table row. */
function sessionRowFacts(
  row: Record<string, unknown>
): { id: string; parentId?: string; directory?: string; updatedMs?: number } | null {
  const id = str(row.id);
  if (id === undefined) return null;
  let data: Record<string, unknown> | undefined;
  if (typeof row.data === 'string') {
    try {
      data = asObject(JSON.parse(row.data));
    } catch {
      data = undefined;
    }
  } else {
    data = asObject(row.data);
  }
  const time = data !== undefined ? asObject(data.time) : undefined;
  const out: { id: string; parentId?: string; directory?: string; updatedMs?: number } = { id };
  const parentId =
    str(row.parentID) ??
    str(row.parent_id) ??
    str(row.parentId) ??
    (data !== undefined ? str(data.parentID) : undefined);
  if (parentId !== undefined) out.parentId = parentId;
  const directory = str(row.directory) ?? (data !== undefined ? str(data.directory) : undefined);
  if (directory !== undefined) out.directory = directory;
  const updatedMs =
    num(row.time_updated) ??
    num(row.updated) ??
    (time !== undefined ? num(time.updated) : undefined);
  if (updatedMs !== undefined) out.updatedMs = updatedMs;
  return out;
}

/**
 * BFS the `session` table's parent links from `rootId` down, so a root
 * session's read rolls its descendant (subagent) sessions up. Defensive by
 * construction: any schema surprise throws inside the caller's try/catch and
 * capture proceeds with the exact session only.
 */
function collectSessionSet(db: Database, rootId: string): Set<string> {
  const set = new Set<string>([rootId]);
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare('SELECT * FROM session').all() as Record<string, unknown>[];
  } catch {
    return set; // no session table — exact-session capture only
  }
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    const facts = sessionRowFacts(row);
    if (facts === null || facts.parentId === undefined) continue;
    const siblings = childrenOf.get(facts.parentId) ?? [];
    siblings.push(facts.id);
    childrenOf.set(facts.parentId, siblings);
  }
  const queue = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (!set.has(child)) {
        set.add(child);
        queue.push(child);
      }
    }
  }
  return set;
}

/**
 * Expand a leading `~` against `home`: `~` → `home`, `~/x` → `home/x`. Any
 * other value is returned unchanged. Mirrors the Claude source's helper.
 */
function expandHome(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return raw;
}

/** Order-preserving dedupe. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
