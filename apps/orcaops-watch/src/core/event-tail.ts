import { open, stat } from 'node:fs/promises';

import { assertResolvedWithin } from '@orcaops/storage';

export interface TailEvent {
  ts: string;
  tsMs: number;
  type: string;
}

/** Read at most the trailing 64 KiB of an event log. */
const MAX_TAIL_BYTES = 64 * 1024;

interface CacheEntry {
  size: number;
  mtimeMs: number;
  events: TailEvent[];
}

/**
 * Tail-reads artifact `events.ndjson` logs, cached by (path, size, mtime_ms) so
 * an UNCHANGED file costs zero reads. On a change it reads the trailing ≤64 KiB,
 * drops a partial first line (we may start mid-record), and parses `{ ts, type }`
 * per line (a torn last line from a concurrent write is skipped). The reader is
 * long-lived: the engine keeps one across ticks; a one-shot snapshot makes a
 * fresh one (no cache benefit, same result).
 */
export class EventTailReader {
  private readonly cache = new Map<string, CacheEntry>();

  async read(
    path: string,
    containmentRoot?: string,
    failOnReadError = false
  ): Promise<TailEvent[]> {
    let size: number;
    let mtimeMs: number;
    try {
      const statPath = resolveReadPath(path, containmentRoot);
      const st = await stat(statPath);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch (error) {
      if (failOnReadError && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return []; // absent — sibling-worktree row whose log lives elsewhere, or not yet written
    }
    const key = `${path}\u0000${containmentRoot ?? ''}`;
    const cached = this.cache.get(key);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      return cached.events;
    }
    let events: TailEvent[];
    try {
      events = await readTail(path, size, containmentRoot);
    } catch (error) {
      if (failOnReadError && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
    this.cache.set(key, { size, mtimeMs, events });
    return events;
  }
}

async function readTail(
  path: string,
  size: number,
  containmentRoot?: string
): Promise<TailEvent[]> {
  const start = Math.max(0, size - MAX_TAIL_BYTES);
  const length = size - start;
  if (length === 0) return [];
  const buf = Buffer.alloc(length);
  const fh = await open(resolveReadPath(path, containmentRoot), 'r');
  try {
    await fh.read(buf, 0, length, start);
  } finally {
    await fh.close();
  }

  let text = buf.toString('utf8');
  // Started mid-file → the first line is a partial record; drop it.
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }

  const events: TailEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const rec = JSON.parse(line) as { ts?: unknown; type?: unknown };
      if (typeof rec.ts === 'string' && typeof rec.type === 'string') {
        const tsMs = Date.parse(rec.ts);
        if (!Number.isNaN(tsMs)) events.push({ ts: rec.ts, tsMs, type: rec.type });
      }
    } catch {
      // Malformed / torn line (e.g. the last record mid-append) — skip it.
    }
  }
  return events;
}

function resolveReadPath(file: string, containmentRoot?: string): string {
  return containmentRoot === undefined
    ? file
    : assertResolvedWithin(file, containmentRoot, 'watch event log', {
        rejectSymlinks: true,
      });
}
