import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';
import {
  appendEvent,
  type EventRecord,
  flushEventLog,
  INLINE_PAYLOAD_BUDGET_BYTES,
  loadEventPayload,
  readEventLog,
  type SidecarEventRecord,
} from './event-log.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { PathContainmentError } from '../paths/containment.js';

describe('event log (events.ndjson)', () => {
  let tmpRoot: string;
  let eventLogPath: string;
  let sidecarsDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-event-log-'));
    eventLogPath = path.join(tmpRoot, 'events.ndjson');
    sidecarsDir = path.join(tmpRoot, 'sidecars');
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function fixedNow(s: string): string {
    return s;
  }

  // ─── appendEvent ─────────────────────────────────────────────────

  describe('appendEvent', () => {
    it('writes an inline event for a small payload, no sidecar', async () => {
      const rec = await appendEvent(
        {
          type: 'plan_captured',
          ts: fixedNow('2026-04-26T12:00:00.000Z'),
          idempotency_key: 'plan-init-1',
          payload: { task: 'add rate limit', steps: ['a', 'b'] },
        },
        { eventLogPath, sidecarsDir }
      );

      expect('payload' in rec).toBe(true);
      expect('sidecar_sha256' in rec).toBe(false);

      // Sidecars dir was not created (no spill happened)
      await expect(stat(sidecarsDir)).rejects.toThrow();

      // Log file exists with one line + trailing newline
      const raw = await readFile(eventLogPath, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('flushes a deferred multi-event append as one durability batch', async () => {
      for (const index of [1, 2]) {
        await appendEvent(
          {
            type: 'plan_captured',
            ts: fixedNow(`2026-04-26T12:00:0${index}.000Z`),
            idempotency_key: `deferred-${index}`,
            payload: { index },
          },
          { eventLogPath, sidecarsDir, deferSync: true }
        );
      }

      await flushEventLog(eventLogPath);
      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.corrupt).toEqual([]);
      expect(result.events.map((event) => event.idempotency_key)).toEqual([
        'deferred-1',
        'deferred-2',
      ]);
    });

    it('throws on an empty idempotency_key, writing nothing (write-side guard)', async () => {
      await expect(
        appendEvent(
          {
            type: 'plan_captured',
            ts: fixedNow('2026-04-26T12:00:00.000Z'),
            idempotency_key: '',
            payload: { task: 'x' },
          },
          { eventLogPath, sidecarsDir }
        )
      ).rejects.toThrow(/missing or empty idempotency_key/);

      // Guard fires before any write — the log file was never created.
      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toEqual([]);
      expect(result.corrupt).toEqual([]);
    });

    it('throws on a missing idempotency_key (typed-required, constructed via cast)', async () => {
      // `AppendEventInput.idempotency_key` is typed required, so the
      // truly-missing case is a runtime-invalid input — construct it via a
      // cast rather than fighting the type.
      const missingKeyInput = {
        type: 'plan_captured',
        ts: fixedNow('2026-04-26T12:00:00.000Z'),
        payload: { task: 'x' },
      } as unknown as Parameters<typeof appendEvent>[0];

      await expect(appendEvent(missingKeyInput, { eventLogPath, sidecarsDir })).rejects.toThrow(
        /missing or empty idempotency_key/
      );
    });

    it('readEventLog flags an empty idempotency_key line as corrupt (read-side symmetry)', async () => {
      // The strict read schema requires idempotency_key.min(1); a keyless
      // line that somehow reached disk must be rejected on read too, so the
      // write-guard and read-guard stay symmetric. Plant a structurally
      // valid record whose ONLY violation is the empty key (schema is
      // checked before the checksum, so the dummy checksum is never reached).
      await mkdir(path.dirname(eventLogPath), { recursive: true });
      const keylessLine = JSON.stringify({
        event_id: 'ev-keyless-1',
        type: 'plan_captured',
        ts: '2026-04-26T12:00:00.000Z',
        schema_version: 1,
        idempotency_key: '',
        payload: { task: 'x' },
        checksum: 'a'.repeat(64),
      });
      await writeFile(eventLogPath, keylessLine + '\n', 'utf8');

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toEqual([]);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].reason).toMatch(/schema/);
      expect(result.corrupt[0].kind).toBe('schema_mismatch');
    });

    it('spills to a sidecar when canonical-JSON payload exceeds the inline budget', async () => {
      const big = 'x'.repeat(INLINE_PAYLOAD_BUDGET_BYTES + 100);
      const rec = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: fixedNow('2026-04-26T12:30:00.000Z'),
          idempotency_key: 'cp-1',
          payload: { blob: big },
        },
        { eventLogPath, sidecarsDir }
      );

      expect('sidecar_sha256' in rec).toBe(true);
      expect('payload' in rec).toBe(false);
      const sc = rec as SidecarEventRecord;

      // Sidecar file landed and matches the recorded hash + size
      const sidecarFile = path.join(sidecarsDir, `${rec.event_id}.json`);
      const sidecarBytes = await readFile(sidecarFile);
      expect(sidecarBytes.byteLength).toBe(sc.sidecar_size);
      const recomputed = createHash('sha256').update(sidecarBytes).digest('hex');
      expect(recomputed).toBe(sc.sidecar_sha256);
    });

    it('mints a fresh UUIDv7 event_id when the caller does not supply one', async () => {
      const rec = await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: { x: 1 },
        },
        { eventLogPath, sidecarsDir }
      );
      expect(rec.event_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    });

    it('produces a checksum that round-trips: read sees the event as valid', async () => {
      await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: { task: 't' },
        },
        { eventLogPath, sidecarsDir }
      );
      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toHaveLength(1);
      expect(result.corrupt).toEqual([]);
    });

    it('appends multiple events in order', async () => {
      const a = await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: { n: 0 },
        },
        { eventLogPath, sidecarsDir }
      );
      const b = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:30:00.000Z',
          idempotency_key: 'cp-1',
          payload: { n: 1 },
        },
        { eventLogPath, sidecarsDir }
      );
      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events.map((e) => e.event_id)).toEqual([a.event_id, b.event_id]);
    });
  });

  // ─── readEventLog: happy paths ───────────────────────────────────

  describe('readEventLog', () => {
    it('returns empty when the log file does not exist', async () => {
      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result).toEqual({ events: [], corrupt: [], lineByEventId: new Map() });
    });

    it('round-trips an inline event end-to-end', async () => {
      const written = await appendEvent(
        {
          type: 'summary_captured',
          ts: '2026-04-26T13:00:00.000Z',
          idempotency_key: 'sum-1',
          payload: { outcome: 'shipped' },
        },
        { eventLogPath, sidecarsDir }
      );
      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual(written);
    });

    it('round-trips a sidecar event and verifies the sidecar', async () => {
      const big = 'y'.repeat(INLINE_PAYLOAD_BUDGET_BYTES + 50);
      const written = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:30:00.000Z',
          idempotency_key: 'cp-1',
          payload: { blob: big },
        },
        { eventLogPath, sidecarsDir }
      );
      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toEqual([written]);
      // loadEventPayload reconstructs the payload from the sidecar
      const payload = await loadEventPayload(result.events[0], { sidecarsDir });
      expect(payload).toEqual({ blob: big });
    });
  });

  // ─── readEventLog: corruption / recovery cases ───────────────────

  describe('readEventLog — corruption detection', () => {
    it('flags a tampered field as a checksum mismatch and skips the event', async () => {
      const ev = await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: { task: 'original' },
        },
        { eventLogPath, sidecarsDir }
      );
      // Surgically change the payload AFTER write — checksum no longer matches.
      const original = await readFile(eventLogPath, 'utf8');
      const tampered = original.replace('"original"', '"tampered"');
      await writeFile(eventLogPath, tampered, 'utf8');

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toEqual([]);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].reason).toMatch(/checksum mismatch/);
      expect(result.corrupt[0].kind).toBe('checksum_mismatch');
      expect(result.corrupt[0].event_id).toBe(ev.event_id);
    });

    it('flags a checksum-valid line reusing an existing event_id as duplicate-id corruption', async () => {
      const ev = await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: { task: 'original' },
        },
        { eventLogPath, sidecarsDir }
      );
      // Append a MODIFIED copy reusing the same id with a freshly
      // recomputed (valid) checksum — the replay/tamper shape a checksum
      // alone cannot catch.
      const copy: Record<string, unknown> = {
        event_id: ev.event_id,
        type: 'plan_captured',
        ts: '2026-04-26T12:05:00.000Z',
        schema_version: 1,
        idempotency_key: 'plan-1-copy',
        payload: { task: 'rolled back' },
      };
      copy.checksum = createHash('sha256').update(canonicalJson(copy), 'utf8').digest('hex');
      const { appendFile } = await import('node:fs/promises');
      await appendFile(eventLogPath, `${JSON.stringify(copy)}\n`, 'utf8');

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].idempotency_key).toBe('plan-1');
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].kind).toBe('duplicate_id');
      expect(result.corrupt[0].event_id).toBe(ev.event_id);
      expect(result.corrupt[0].reason).toMatch(/line 1/);
    });

    it('a schema-invalid first occurrence still reserves its id against a later reuse', async () => {
      const id = uuidv7();
      // Line 1: valid JSON with a parseable id but an unknown key the
      // strict record schema rejects — reservation must happen anyway.
      const invalid: Record<string, unknown> = {
        event_id: id,
        type: 'plan_captured',
        ts: '2026-04-26T12:00:00.000Z',
        schema_version: 1,
        idempotency_key: 'first',
        payload: { task: 'one' },
        smuggled: true,
      };
      invalid.checksum = createHash('sha256').update(canonicalJson(invalid), 'utf8').digest('hex');
      // Line 2: a fully valid record reusing the same id.
      const reuse: Record<string, unknown> = {
        event_id: id,
        type: 'plan_captured',
        ts: '2026-04-26T12:05:00.000Z',
        schema_version: 1,
        idempotency_key: 'second',
        payload: { task: 'two' },
      };
      reuse.checksum = createHash('sha256').update(canonicalJson(reuse), 'utf8').digest('hex');
      const { appendFile } = await import('node:fs/promises');
      await appendFile(
        eventLogPath,
        `${JSON.stringify(invalid)}\n${JSON.stringify(reuse)}\n`,
        'utf8'
      );

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toHaveLength(0);
      expect(result.corrupt).toHaveLength(2);
      expect(result.corrupt[0].kind).toBe('schema_mismatch');
      expect(result.corrupt[0].event_id).toBe(id);
      expect(result.corrupt[1].kind).toBe('duplicate_id');
      expect(result.corrupt[1].event_id).toBe(id);
    });

    it('flags a reuse of a sidecar-corrupt first occurrence — corrupt lines still reserve their id', async () => {
      const big = 'z'.repeat(INLINE_PAYLOAD_BUDGET_BYTES + 50);
      const ev = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-1',
          payload: { blob: big },
        },
        { eventLogPath, sidecarsDir }
      );
      // Destroy the sidecar so the first occurrence is corrupt (never a
      // survivor), then append a checksum-valid inline line reusing its id.
      const { rm, appendFile } = await import('node:fs/promises');
      await rm(path.join(sidecarsDir, `${ev.event_id}.json`));
      const reuse: Record<string, unknown> = {
        event_id: ev.event_id,
        type: 'checkpoint_closed',
        ts: '2026-04-26T12:10:00.000Z',
        schema_version: 1,
        idempotency_key: 'cp-1-reuse',
        payload: { forged: true },
      };
      reuse.checksum = createHash('sha256').update(canonicalJson(reuse), 'utf8').digest('hex');
      await appendFile(eventLogPath, `${JSON.stringify(reuse)}\n`, 'utf8');

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toHaveLength(0);
      expect(result.corrupt).toHaveLength(2);
      expect(result.corrupt[0].kind).toBe('sidecar_corrupt');
      expect(result.corrupt[1].kind).toBe('duplicate_id');
      expect(result.corrupt[1].event_id).toBe(ev.event_id);
    });

    it('terminates a valid-but-unterminated tail instead of merging the next append into it', async () => {
      const first = await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: { task: 'one' },
        },
        { eventLogPath, sidecarsDir }
      );
      // Simulate a crash that flushed every byte EXCEPT the trailing
      // newline: the line is fully valid, just unterminated.
      const { readFile, writeFile } = await import('node:fs/promises');
      const raw = await readFile(eventLogPath, 'utf8');
      await writeFile(eventLogPath, raw.replace(/\n$/, ''), 'utf8');

      const second = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T12:05:00.000Z',
          idempotency_key: 'cp-open',
          payload: { n: 1 },
        },
        { eventLogPath, sidecarsDir }
      );
      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.corrupt).toEqual([]);
      expect(result.events.map((e) => e.event_id)).toEqual([first.event_id, second.event_id]);
    });

    it('flags a truncated tail line as corrupt without losing valid earlier lines', async () => {
      const a = await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: { ok: true },
        },
        { eventLogPath, sidecarsDir }
      );
      // Append a partial line (no trailing \n) — simulates a crash mid-write.
      await appendFile(eventLogPath, '{"event_id":"halfwritten', 'utf8');

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events.map((e) => e.event_id)).toEqual([a.event_id]);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].reason).toMatch(/truncated tail/);
      expect(result.corrupt[0].kind).toBe('truncated_tail');
    });

    it('flags an event whose sidecar is missing as corrupt', async () => {
      const big = 'z'.repeat(INLINE_PAYLOAD_BUDGET_BYTES + 50);
      const ev = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:30:00.000Z',
          idempotency_key: 'cp-1',
          payload: { blob: big },
        },
        { eventLogPath, sidecarsDir }
      );
      // Delete the sidecar after write
      await rm(path.join(sidecarsDir, `${ev.event_id}.json`));

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toEqual([]);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].reason).toMatch(/sidecar.*missing/);
      expect(result.corrupt[0].kind).toBe('sidecar_corrupt');
      expect(result.corrupt[0].event_id).toBe(ev.event_id);
    });

    it('flags a sidecar whose contents have been modified (sha256 mismatch)', async () => {
      const big = 'q'.repeat(INLINE_PAYLOAD_BUDGET_BYTES + 50);
      const ev = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:30:00.000Z',
          idempotency_key: 'cp-1',
          payload: { blob: big },
        },
        { eventLogPath, sidecarsDir }
      );
      // Replace the sidecar content with same byte length but different bytes.
      const sidecar = path.join(sidecarsDir, `${ev.event_id}.json`);
      const tampered = Buffer.alloc((ev as SidecarEventRecord).sidecar_size, 0x40); // '@'
      await writeFile(sidecar, tampered);

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toEqual([]);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].reason).toMatch(/SHA-256 does not match/);
    });

    it('flags a sidecar whose size differs from the embedded sidecar_size', async () => {
      const big = 'p'.repeat(INLINE_PAYLOAD_BUDGET_BYTES + 50);
      const ev = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:30:00.000Z',
          idempotency_key: 'cp-1',
          payload: { blob: big },
        },
        { eventLogPath, sidecarsDir }
      );
      // Truncate the sidecar to half its size — caught by the size check
      // before SHA is even attempted.
      const sidecar = path.join(sidecarsDir, `${ev.event_id}.json`);
      await truncate(sidecar, Math.floor((ev as SidecarEventRecord).sidecar_size / 2));

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toEqual([]);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].reason).toMatch(/sidecar size .* does not match/);
    });

    it('refuses a final sidecar symlink before reading its target', async () => {
      const externalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-event-external-'));
      try {
        const containedLog = path.join(tmpRoot, 'managed', 'events.ndjson');
        const containedSidecars = path.join(tmpRoot, 'managed', 'sidecars');
        const event = await appendEvent(
          {
            type: 'checkpoint_closed',
            ts: '2026-04-26T12:30:00.000Z',
            idempotency_key: 'cp-symlink',
            payload: { blob: 'p'.repeat(INLINE_PAYLOAD_BUDGET_BYTES + 50) },
          },
          {
            eventLogPath: containedLog,
            sidecarsDir: containedSidecars,
            containmentRoot: tmpRoot,
          }
        );
        const sidecar = path.join(containedSidecars, `${event.event_id}.json`);
        const external = path.join(externalRoot, 'payload.json');
        await writeFile(external, await readFile(sidecar));
        await unlink(sidecar);
        await symlink(external, sidecar);

        await expect(
          readEventLog({
            eventLogPath: containedLog,
            sidecarsDir: containedSidecars,
            containmentRoot: tmpRoot,
          })
        ).rejects.toBeInstanceOf(PathContainmentError);
      } finally {
        await rm(externalRoot, { recursive: true, force: true });
      }
    });

    it('preserves the original line in the corrupt entry for diagnostics', async () => {
      // Plant a line that's valid JSON but fails schema validation
      await mkdir(path.dirname(eventLogPath), { recursive: true });
      await writeFile(eventLogPath, JSON.stringify({ not: 'an event' }) + '\n', 'utf8');

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toEqual([]);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].raw).toContain('"not":"an event"');
      expect(result.corrupt[0].line).toBe(1);
    });

    it('skips one corrupt line and continues reading the rest', async () => {
      const before = await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: { task: 'first' },
        },
        { eventLogPath, sidecarsDir }
      );
      // Inject a malformed JSON line in the middle
      await appendFile(eventLogPath, 'not-json{\n', 'utf8');
      const after = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:30:00.000Z',
          idempotency_key: 'cp-1',
          payload: { task: 'after' },
        },
        { eventLogPath, sidecarsDir }
      );

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events.map((e) => e.event_id)).toEqual([before.event_id, after.event_id]);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].line).toBe(2);
    });
  });

  // ─── concurrency expectation (paired with ArtifactLock) ───────────

  describe('concurrency contract', () => {
    it('two same-FS appends without a lock can produce torn lines (motivates ArtifactLock)', async () => {
      // This isn't an assertion that we intend to ship vulnerable; it's a
      // regression marker that documents WHY appendEvent demands the
      // caller hold ArtifactLock. If a future rewrite ever serializes
      // appendFile internally and makes this test pass, that change has
      // implications worth examining (for example, removing the
      // ArtifactLock requirement at this layer would be a contract break
      // for callers that already serialize coarser units of work like
      // event-write + projection-write through the lock).
      const ops: Array<Promise<EventRecord>> = [];
      for (let i = 0; i < 5; i++) {
        ops.push(
          appendEvent(
            {
              type: 'plan_captured',
              ts: '2026-04-26T12:00:00.000Z',
              idempotency_key: `plan-${i}`,
              payload: { i },
            },
            { eventLogPath, sidecarsDir }
          )
        );
      }
      await Promise.all(ops);
      const result = await readEventLog({ eventLogPath, sidecarsDir });
      // Every event we wrote should be readable IFF appendFile serialized
      // them (Node's appendFile uses O_APPEND on POSIX so it does, in
      // practice). Either way we got 5 valid events or some are corrupt;
      // the assertion that holds is "events + corrupt >= 5 attempts."
      expect(result.events.length + result.corrupt.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ─── event ID validation (IDs become sidecar/mirror path segments) ──

  describe('event ID validation', () => {
    const APPEND_BASE = {
      type: 'plan_captured' as const,
      ts: '2026-04-26T12:00:00.000Z',
      idempotency_key: 'id-k1',
      payload: { ok: true },
    };

    it('refuses a traversing event_id override at the write ingress', async () => {
      await expect(
        appendEvent({ ...APPEND_BASE, event_id: '../../victim' }, { eventLogPath, sidecarsDir })
      ).rejects.toThrow(/not a canonical UUIDv7/);
    });

    it('refuses a merely non-UUIDv7 override too', async () => {
      await expect(
        appendEvent({ ...APPEND_BASE, event_id: 'e-1' }, { eventLogPath, sidecarsDir })
      ).rejects.toThrow(/not a canonical UUIDv7/);
    });

    it('accepts a caller-minted UUIDv7 override', async () => {
      const id = uuidv7();
      const rec = await appendEvent(
        { ...APPEND_BASE, event_id: id },
        { eventLogPath, sidecarsDir }
      );
      expect(rec.event_id).toBe(id);
    });

    it('rejects a stored record whose event_id is not a UUIDv7 at read', async () => {
      const ev = await appendEvent(APPEND_BASE, { eventLogPath, sidecarsDir });
      const original = await readFile(eventLogPath, 'utf8');
      const tampered = original.replace(ev.event_id, '../../../etc/passwd');
      await writeFile(eventLogPath, tampered, 'utf8');

      const result = await readEventLog({ eventLogPath, sidecarsDir });
      expect(result.events).toEqual([]);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].reason).toMatch(/fails schema/);
    });
  });
});
