import type { Dirent } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { EnvLike } from '../source.js';

const FIRST_LINE_MAX_BYTES = 256 * 1024;
const DEFAULT_INDEX_REFRESH_MS = 60_000;

export interface CodexRolloutMeta {
  id: string;
  rootSessionId: string;
  cwd?: string;
  isSubagent: boolean;
  parentThreadId?: string;
}

export interface CodexRolloutRecord {
  path: string;
  size: number;
  mtimeMs: number;
  meta: CodexRolloutMeta | null;
}

export interface CodexLocatedSession {
  requestedSessionId: string;
  rootSessionId: string;
  rollouts: readonly CodexRolloutRecord[];
}

export interface CodexRolloutLocatorOptions {
  home?: string;
  indexRefreshMs?: number;
  now?: () => number;
  onScan?: () => void;
}

interface RolloutIndex {
  byPath: Map<string, CodexRolloutRecord>;
  byId: Map<string, CodexRolloutRecord[]>;
}

interface CachedMeta {
  size: number;
  mtimeMs: number;
  meta: CodexRolloutMeta | null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseCodexRolloutMetaLine(line: string): CodexRolloutMeta | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (obj.type !== 'session_meta') return null;
  if (typeof obj.payload !== 'object' || obj.payload === null) return null;
  const payload = obj.payload as Record<string, unknown>;

  const id = nonEmptyString(payload.id);
  if (!id) return null;
  const sessionId = nonEmptyString(payload.session_id);
  const parentThreadId = nonEmptyString(payload.parent_thread_id);
  const cwd = nonEmptyString(payload.cwd);
  const meta: CodexRolloutMeta = {
    id,
    rootSessionId: sessionId ?? id,
    isSubagent: payload.thread_source === 'subagent' || parentThreadId !== undefined,
  };
  if (cwd !== undefined) meta.cwd = cwd;
  if (parentThreadId !== undefined) meta.parentThreadId = parentThreadId;
  return meta;
}

export function codexSessionRoots(env: EnvLike, home: string = homedir()): string[] {
  const configured = env.CODEX_HOME;
  if (configured?.trim()) {
    return dedupe(
      configured
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => expandHome(entry, home))
    );
  }
  return [path.join(home, '.codex')];
}

export class CodexRolloutLocator {
  private index: RolloutIndex | null = null;
  private indexedAt = Number.NEGATIVE_INFINITY;
  private readonly metaCache = new Map<string, CachedMeta>();
  private readonly absentSessionIds = new Set<string>();
  private readonly home: string;
  private readonly indexRefreshMs: number;
  private readonly now: () => number;
  private readonly onScan?: () => void;

  constructor(
    private readonly env: EnvLike = process.env,
    options: CodexRolloutLocatorOptions = {}
  ) {
    this.home = options.home ?? env.HOME ?? homedir();
    this.indexRefreshMs = options.indexRefreshMs ?? DEFAULT_INDEX_REFRESH_MS;
    this.now = options.now ?? Date.now;
    this.onScan = options.onScan;
  }

  async locateSession(sessionId: string): Promise<CodexLocatedSession | null> {
    const found = await this.locateSessions(new Set([sessionId]));
    return found.get(sessionId.trim()) ?? null;
  }

  async canonicalizeSessionId(sessionId: string): Promise<string | null> {
    const located = await this.locateSession(sessionId);
    if (!located || !this.index?.byId.has(located.rootSessionId)) return null;
    return located.rootSessionId;
  }

  async locateSessions(sessionIds: ReadonlySet<string>): Promise<Map<string, CodexLocatedSession>> {
    const requested = [...sessionIds].map((id) => id.trim()).filter(Boolean);
    const located = new Map<string, CodexLocatedSession>();
    if (requested.length === 0) return located;

    const scanned = await this.ensureIndex(false);
    let associations = this.associate(requested);
    if (
      !scanned &&
      requested.some((id) => !associations.has(id) && !this.absentSessionIds.has(id))
    ) {
      await this.ensureIndex(true);
      associations = this.associate(requested);
    }
    const vanished = await this.refreshAssociatedRecords(associations);
    if (vanished) {
      await this.ensureIndex(true);
      associations = this.associate(requested);
      await this.refreshAssociatedRecords(associations);
    }

    for (const id of requested) {
      if (associations.has(id)) this.absentSessionIds.delete(id);
      else this.absentSessionIds.add(id);
    }

    for (const [id, association] of associations) located.set(id, association);
    return located;
  }

  async discoverActiveSessionId(
    cwd: string,
    nowMs: number,
    recencyMs: number
  ): Promise<string | null> {
    const targetCwd = cwd.trim();
    if (!targetCwd || Number.isNaN(nowMs)) return null;

    const dateDirs = new Set<string>();
    for (const root of codexSessionRoots(this.env, this.home)) {
      for (const ms of [nowMs, nowMs - 24 * 60 * 60_000]) {
        for (const [year, month, day] of [dateParts(ms, 'utc'), dateParts(ms, 'local')]) {
          dateDirs.add(path.join(root, 'sessions', year, month, day));
        }
      }
    }

    let best: { rootSessionId: string; mtimeMs: number } | null = null;
    for (const dir of [...dateDirs].sort()) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries.sort()) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        let fileStat;
        try {
          fileStat = await stat(file);
        } catch {
          continue;
        }
        if (fileStat.mtimeMs < nowMs - recencyMs) continue;
        if (best !== null && fileStat.mtimeMs <= best.mtimeMs) continue;
        const meta = await this.readMeta(file, fileStat.size, fileStat.mtimeMs);
        if (!meta?.cwd || path.resolve(meta.cwd) !== path.resolve(targetCwd)) continue;
        best = { rootSessionId: meta.rootSessionId, mtimeMs: fileStat.mtimeMs };
      }
    }
    return best?.rootSessionId ?? null;
  }

  private async ensureIndex(force: boolean): Promise<boolean> {
    if (!force && this.index && this.now() - this.indexedAt < this.indexRefreshMs) return false;

    this.onScan?.();
    const files: string[] = [];
    for (const root of codexSessionRoots(this.env, this.home)) {
      for (const subdir of ['sessions', 'archived_sessions']) {
        files.push(...(await collectRollouts(path.join(root, subdir))));
      }
    }

    const byPath = new Map<string, CodexRolloutRecord>();
    const byId = new Map<string, CodexRolloutRecord[]>();
    for (const file of dedupe(files).sort()) {
      let fileStat;
      try {
        fileStat = await stat(file);
      } catch {
        continue;
      }
      const record: CodexRolloutRecord = {
        path: file,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        meta: await this.readMeta(file, fileStat.size, fileStat.mtimeMs),
      };
      byPath.set(file, record);
      for (const id of recordIds(record)) {
        const records = byId.get(id) ?? [];
        records.push(record);
        byId.set(id, records);
      }
    }

    this.index = { byPath, byId };
    this.indexedAt = this.now();
    for (const id of this.absentSessionIds) {
      if (byId.has(id)) this.absentSessionIds.delete(id);
    }
    for (const file of [...this.metaCache.keys()]) {
      if (!byPath.has(file)) this.metaCache.delete(file);
    }
    return true;
  }

  private associate(requested: readonly string[]): Map<string, CodexLocatedSession> {
    const associations = new Map<string, CodexLocatedSession>();
    const index = this.index;
    if (!index) return associations;

    for (const sessionId of requested) {
      if (!index.byId.has(sessionId)) continue;
      const rootSessionId = resolveRootSessionId(sessionId, index.byId);
      const rootDate = (index.byId.get(rootSessionId) ?? [])
        .map((record) => rolloutDate(record.path))
        .filter((date): date is string => date !== undefined)
        .sort()[0];
      const rollouts = [...index.byPath.values()]
        .filter((record) => {
          const date = rolloutDate(record.path);
          if (rootDate !== undefined && date !== undefined && date < rootDate) return false;
          const ids = recordIds(record);
          return ids.some((id) => resolveRootSessionId(id, index.byId) === rootSessionId);
        })
        .sort((left, right) => left.path.localeCompare(right.path));
      associations.set(sessionId, { requestedSessionId: sessionId, rootSessionId, rollouts });
    }
    return associations;
  }

  private async refreshAssociatedRecords(
    associations: ReadonlyMap<string, CodexLocatedSession>
  ): Promise<boolean> {
    const unique = new Map<string, CodexRolloutRecord>();
    for (const association of associations.values()) {
      for (const record of association.rollouts) unique.set(record.path, record);
    }

    for (const record of unique.values()) {
      let fileStat;
      try {
        fileStat = await stat(record.path);
      } catch {
        return true;
      }
      if (record.size === fileStat.size && record.mtimeMs === fileStat.mtimeMs) continue;
      record.size = fileStat.size;
      record.mtimeMs = fileStat.mtimeMs;
    }
    return false;
  }

  private async readMeta(
    file: string,
    size: number,
    mtimeMs: number
  ): Promise<CodexRolloutMeta | null> {
    const cached = this.metaCache.get(file);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.meta;
    const line = await readFirstLine(file, FIRST_LINE_MAX_BYTES);
    const meta = line === null ? null : parseCodexRolloutMetaLine(line);
    this.metaCache.set(file, { size, mtimeMs, meta });
    return meta;
  }
}

function resolveRootSessionId(
  sessionId: string,
  byId: ReadonlyMap<string, readonly CodexRolloutRecord[]>
): string {
  let current = sessionId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const meta = byId.get(current)?.find((record) => record.meta)?.meta;
    if (!meta) return current;
    const parent = meta.rootSessionId !== meta.id ? meta.rootSessionId : meta.parentThreadId;
    if (!parent || parent === current) return current;
    current = parent;
  }
  return current;
}

function recordIds(record: CodexRolloutRecord): string[] {
  const ids: string[] = [];
  const filenameId = rolloutIdFromFilename(record.path);
  if (filenameId) ids.push(filenameId);
  if (record.meta) ids.push(record.meta.id);
  return dedupe(ids);
}

function rolloutIdFromFilename(file: string): string | null {
  const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    path.basename(file)
  );
  return match?.[1] ?? null;
}

function rolloutDate(file: string): string | undefined {
  const match = /(\d{4})[/\\](\d{2})[/\\](\d{2})[/\\][^/\\]+$/.exec(file);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

async function readFirstLine(file: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    if (newline !== -1) return text.slice(0, newline);
    return bytesRead < maxBytes ? text : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function collectRollouts(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectRollouts(full)));
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}

function dateParts(ms: number, zone: 'utc' | 'local'): [string, string, string] {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return zone === 'utc'
    ? [String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())]
    : [String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())];
}

function expandHome(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return raw;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
