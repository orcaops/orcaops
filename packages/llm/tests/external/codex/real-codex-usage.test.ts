import type { Dirent } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CodexUsageSource, parseRolloutMetaLine } from '../../../src/codex/rollout-parser.js';

/**
 * Real-data smoke: parse THIS machine's newest ~/.codex rollout end-to-end.
 * Read-only and free (no API calls), but machine-dependent — gated behind its
 * own flag, and skipped (not failed) when no local codex sessions exist:
 *
 *   RUN_REAL_USAGE_TESTS=1 pnpm --filter @orcaops/llm test
 */
const describeReal = process.env.RUN_REAL_USAGE_TESTS === '1' ? describe : describe.skip;

async function collectRollouts(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectRollouts(full)));
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'))
      out.push(full);
  }
  return out;
}

async function firstLine(file: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    await fh.close().catch(() => {});
  }
}

describeReal('CodexUsageSource against real ~/.codex data', () => {
  it('reads the newest local session with plausible, until-respecting output', async () => {
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    const files = await collectRollouts(sessionsDir);
    if (files.length === 0) return; // no local codex data — nothing to smoke

    // Newest by mtime, then find one whose meta parses and carries usage.
    const byMtime = await Promise.all(
      files.map(async (f) => ({ f, mtimeMs: (await stat(f)).mtimeMs }))
    );
    byMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const source = new CodexUsageSource();
    let verified = 0;
    for (const { f } of byMtime.slice(0, 25)) {
      const line = await firstLine(f);
      const meta = line === null ? null : parseRolloutMetaLine(line);
      if (meta === null) continue;
      const snap = await source.readUsage(meta.rootSessionId);
      if (snap === null) continue; // usage-free session (e.g. instant exit)

      expect(snap.recordCount).toBeGreaterThan(0);
      expect(snap.modelBreakdown.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(snap.asOf))).toBe(false);
      const t = snap.total;
      expect(
        t.input_tokens + t.output_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens
      ).toBeGreaterThan(0);
      for (const row of snap.modelBreakdown) {
        expect(row.model.length).toBeGreaterThan(0);
      }
      // A cutoff far in the past excludes everything.
      expect(
        await source.readUsage(meta.rootSessionId, { until: '2000-01-01T00:00:00Z' })
      ).toBeNull();
      verified++;
      if (verified >= 3) break;
    }
    expect(verified, 'no recent rollout with parseable usage found').toBeGreaterThan(0);
  }, 120_000);
});
