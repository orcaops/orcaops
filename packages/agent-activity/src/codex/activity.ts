import { open } from 'node:fs/promises';

import type { AgentActivitySource, EnvLike } from '../source.js';
import {
  CodexRolloutLocator,
  type CodexRolloutLocatorOptions,
  type CodexRolloutRecord,
} from './locator.js';

const TAIL_BYTES = 64 * 1024;

interface CachedActivity {
  size: number;
  mtimeMs: number;
  activityMs: number;
}

export interface CodexActivitySourceOptions extends CodexRolloutLocatorOptions {
  locator?: CodexRolloutLocator;
  onTailRead?: (file: string) => void;
}

export class CodexActivitySource implements AgentActivitySource {
  readonly agent = 'codex';
  private readonly locator: CodexRolloutLocator;
  private readonly tailCache = new Map<string, CachedActivity>();
  private readonly onTailRead?: (file: string) => void;

  constructor(env: EnvLike = process.env, options: CodexActivitySourceOptions = {}) {
    this.locator = options.locator ?? new CodexRolloutLocator(env, options);
    this.onTailRead = options.onTailRead;
  }

  async readLastActivity(sessionIds: ReadonlySet<string>): Promise<Map<string, number>> {
    const activity = new Map<string, number>();
    const located = await this.locator.locateSessions(sessionIds);
    for (const [sessionId, session] of located) {
      let latest: number | null = null;
      for (const rollout of session.rollouts) {
        const timestamp = await this.readRolloutActivity(rollout);
        if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp;
      }
      if (latest !== null) activity.set(sessionId, latest);
    }
    return activity;
  }

  private async readRolloutActivity(record: CodexRolloutRecord): Promise<number | null> {
    const cached = this.tailCache.get(record.path);
    if (cached && cached.size === record.size && cached.mtimeMs === record.mtimeMs) {
      return cached.activityMs;
    }

    let handle;
    try {
      handle = await open(record.path, 'r');
    } catch {
      return null;
    }

    let activityMs: number;
    try {
      this.onTailRead?.(record.path);
      const length = Math.min(record.size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, record.size - length);
      const lines = buffer.toString('utf8').split('\n');
      if (record.size > length) lines.shift();
      activityMs = newestTimestamp(lines) ?? record.mtimeMs;
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => {});
    }

    this.tailCache.set(record.path, {
      size: record.size,
      mtimeMs: record.mtimeMs,
      activityMs,
    });
    return activityMs;
  }
}

function newestTimestamp(lines: readonly string[]): number | null {
  let latest: number | null = null;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof json !== 'object' || json === null) continue;
    const timestamp = (json as Record<string, unknown>).timestamp;
    if (typeof timestamp !== 'string') continue;
    const timestampMs = Date.parse(timestamp);
    if (Number.isNaN(timestampMs)) continue;
    if (latest === null || timestampMs > latest) latest = timestampMs;
  }
  return latest;
}
