import { appendFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventTailReader } from './event-tail.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'orcaops-tail-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function line(ts: string, type: string): string {
  return `${JSON.stringify({ event_id: 'e', type, ts, schema_version: 1, idempotency_key: 'k' })}\n`;
}

describe('EventTailReader', () => {
  it('parses {ts, type} from ndjson lines', async () => {
    const p = path.join(dir, 'events.ndjson');
    await writeFile(
      p,
      line('2026-07-01T00:00:00.000Z', 'plan_captured') +
        line('2026-07-01T00:01:00.000Z', 'checkpoint_opened')
    );
    const evs = await new EventTailReader().read(p);
    expect(evs.map((e) => e.type)).toEqual(['plan_captured', 'checkpoint_opened']);
    expect(evs[0].tsMs).toBe(Date.parse('2026-07-01T00:00:00.000Z'));
  });

  it('drops the partial first line on a >64KiB log', async () => {
    const p = path.join(dir, 'big.ndjson');
    // A 70 KiB first line pushes the 64 KiB tail window to start mid-record.
    const huge = `${JSON.stringify({ event_id: 'e0', type: 'plan_captured', ts: '2026-07-01T00:00:00.000Z', pad: 'x'.repeat(70 * 1024) })}\n`;
    const rest =
      line('2026-07-01T00:05:00.000Z', 'checkpoint_opened') +
      line('2026-07-01T00:06:00.000Z', 'checkpoint_closed');
    await writeFile(p, huge + rest);
    const evs = await new EventTailReader().read(p);
    // The huge first line is beyond the tail window → dropped as partial.
    expect(evs.map((e) => e.type)).toEqual(['checkpoint_opened', 'checkpoint_closed']);
  });

  it('caches by (size, mtime): unchanged → same array; a change re-reads', async () => {
    const p = path.join(dir, 'cache.ndjson');
    await writeFile(p, line('2026-07-01T00:00:00.000Z', 'plan_captured'));
    const r = new EventTailReader();
    const first = await r.read(p);
    expect(await r.read(p)).toBe(first); // cache hit — same reference
    await appendFile(p, line('2026-07-01T00:01:00.000Z', 'checkpoint_opened'));
    const third = await r.read(p);
    expect(third).not.toBe(first); // cache miss — size changed
    expect(third.length).toBe(2);
  });

  it('skips malformed / torn lines and returns [] for an absent file', async () => {
    const p = path.join(dir, 'torn.ndjson');
    await writeFile(p, `${line('2026-07-01T00:00:00.000Z', 'plan_captured')}{"partial":`);
    expect((await new EventTailReader().read(p)).map((e) => e.type)).toEqual(['plan_captured']);
    expect(await new EventTailReader().read(path.join(dir, 'nope.ndjson'))).toEqual([]);
    expect(await new EventTailReader().read(path.join(dir, 'nope.ndjson'), dir, true)).toEqual([]);
  });

  it('refuses a final hot event-log symlink before tailing it', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-tail-outside-'));
    try {
      const external = path.join(outside, 'events.ndjson');
      const redirected = path.join(dir, 'events.ndjson');
      await writeFile(external, line('2026-07-01T00:00:00.000Z', 'plan_captured'));
      await symlink(external, redirected);

      expect(await new EventTailReader().read(redirected, dir)).toEqual([]);
      await expect(new EventTailReader().read(redirected, dir, true)).rejects.toThrow(
        /must not contain symlinks/
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
