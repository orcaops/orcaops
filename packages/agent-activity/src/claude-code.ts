import type { Dirent } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

import { type ClaudeTranscriptLocation, ClaudeTranscriptLocator } from './claude-code/locator.js';
import type { AgentActivitySource, EnvLike } from './source.js';

const TAIL_BYTES = 64 * 1024;

interface TranscriptTailActivity {
  meaningfulMs: number | null;
  fallbackMs: number;
}

async function transcriptTailActivity(file: string): Promise<TranscriptTailActivity | null> {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size, mtimeMs } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift();

    let latestTurn: number | null = null;
    let latestEntry: number | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: { type?: unknown; timestamp?: unknown };
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object' || typeof entry.timestamp !== 'string') continue;

      const timestamp = Date.parse(entry.timestamp);
      if (Number.isNaN(timestamp)) continue;
      if (latestEntry === null || timestamp > latestEntry) latestEntry = timestamp;
      if (
        (entry.type === 'user' || entry.type === 'assistant') &&
        (latestTurn === null || timestamp > latestTurn)
      ) {
        latestTurn = timestamp;
      }
    }
    return { meaningfulMs: latestTurn, fallbackMs: latestEntry ?? mtimeMs };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function activityTranscriptFiles(location: ClaudeTranscriptLocation): Promise<string[]> {
  const subagentsDir = path.join(location.projectDir, location.sessionId, 'subagents');
  const subagents = await collectJsonlFiles(subagentsDir);
  return [location.transcriptPath, ...subagents.sort()];
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function claudeTranscriptActivity(
  sessionIds: ReadonlySet<string>,
  env: EnvLike = process.env
): Promise<Map<string, number>> {
  const activity = new Map<string, number>();
  if (sessionIds.size === 0) return activity;

  const locator = new ClaudeTranscriptLocator(env);
  for (const [sessionId, location] of await locator.locateSessions(sessionIds)) {
    let meaningfulMs: number | null = null;
    let fallbackMs: number | null = null;
    for (const file of await activityTranscriptFiles(location)) {
      const tail = await transcriptTailActivity(file);
      if (tail === null) continue;
      if (tail.meaningfulMs !== null) {
        meaningfulMs = Math.max(meaningfulMs ?? tail.meaningfulMs, tail.meaningfulMs);
      }
      fallbackMs = Math.max(fallbackMs ?? tail.fallbackMs, tail.fallbackMs);
    }
    const timestamp = meaningfulMs ?? fallbackMs;
    if (timestamp !== null) activity.set(sessionId, timestamp);
  }
  return activity;
}

export class ClaudeCodeActivitySource implements AgentActivitySource {
  readonly agent = 'claude-code';

  constructor(private readonly env: EnvLike = process.env) {}

  readLastActivity(sessionIds: ReadonlySet<string>): Promise<Map<string, number>> {
    return claudeTranscriptActivity(sessionIds, this.env);
  }
}
