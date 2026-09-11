import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import type { AgentUsageSnapshotPayload } from '../../schema/usage-ledger.js';
import { deriveUsageLedgerRecord } from '../../usage/record.js';
import { digest, recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { runProjectOperation } from './transactions.js';
import {
  type AppendProjectUsageEvents,
  appendProjectUsageEvents,
  readProjectUsage,
} from './usage.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-usage-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
  });
  handles.push(handle);
  return { handle, authority };
}
function snapshot(count = 12, changes: Partial<AgentUsageSnapshotPayload> = {}) {
  const counters = {
    input_tokens: count,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const payload: AgentUsageSnapshotPayload = {
    snapshot_id: uuidv7(),
    idempotency_key: uuidv7(),
    agent: 'codex',
    session_id: 'session',
    artifact_id: 'artifact',
    source_plan_ref_id: null,
    lifecycle_event: 'checkpoint_close',
    checkpoint_n: 2,
    cumulative_usage: counters,
    delta_usage: null,
    baseline_kind: 'first_observation',
    model_breakdown: [{ model: 'model', cumulative: counters, delta: null }],
    record_count: 1,
    as_of: '2026-09-05T00:00:00.000Z',
    ...changes,
  };
  const { record } = deriveUsageLedgerRecord({
    type: 'agent_usage_snapshot_recorded',
    ts: payload.as_of,
    idempotency_key: payload.idempotency_key,
    payload,
  });
  return { record, payload };
}
function request(count = 12): AppendProjectUsageEvents {
  return {
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify(snapshot(count).record) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  };
}
function state(handle: ProjectDatabase) {
  return handle.read((view) => ({
    events: view.get<{ n: number }>('SELECT count(*) AS n FROM usage_events')!.n,
    operations: view.get<{ n: number }>('SELECT count(*) AS n FROM operations')!.n,
    revisions: view.get<{ n: number }>('SELECT count(*) AS n FROM usage_revisions')!.n,
  }));
}
describe('usage publications', () => {
  it('retains exact bytes and historical publication identities independently of event count', async () => {
    const { handle } = await fixture();
    const a = snapshot();
    const b = snapshot(20);
    const bytes = Buffer.from(
      '  ' + JSON.stringify(a.record) + '\n' + JSON.stringify(b.record) + ' \n'
    );
    const first = await appendProjectUsageEvents(handle, { ...request(), eventBytes: bytes });
    expect(first.value.revision).toMatchObject({
      generation: 1,
      eventCount: 2,
      byteLength: bytes.length,
      tailEventId: b.record.event_id,
    });
    expect(first.counters).toEqual({ writeSequence: 2, intentChangeCounter: 0 });
    const second = await appendProjectUsageEvents(handle, {
      ...request(25),
      expectedRevision: first.value.revision,
    });
    expect(second.value.revision).toMatchObject({ generation: 2, eventCount: 3 });
    expect(readProjectUsage(handle, first.value.revision)?.eventBytes).toEqual(bytes);
    expect(readProjectUsage(handle)?.revision).toEqual(second.value.revision);
    expect(
      handle.read((view) => view.all('SELECT snapshot_id FROM usage_snapshots')).value
    ).toHaveLength(3);
  });
  it('replays the original outcome after later usage and conflicts on changed input', async () => {
    const { handle } = await fixture();
    const input = request();
    const first = await appendProjectUsageEvents(handle, input);
    await appendProjectUsageEvents(handle, {
      ...request(24),
      expectedRevision: first.value.revision,
    });
    const before = state(handle);
    expect(await appendProjectUsageEvents(handle, input)).toEqual({ ...first, replayed: true });
    expect(state(handle)).toEqual(before);
    await expect(
      appendProjectUsageEvents(handle, { ...request(30), operationId: input.operationId })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(state(handle)).toEqual(before);
  });
  it('preserves divergent snapshot identities as separate retained observations', async () => {
    const { handle } = await fixture();
    const original = snapshot();
    const repeated = snapshot(30, { snapshot_id: original.payload.snapshot_id });
    await appendProjectUsageEvents(handle, {
      ...request(),
      eventBytes: Buffer.from(
        JSON.stringify(original.record) + '\n' + JSON.stringify(repeated.record) + '\n'
      ),
    });
    expect(
      handle.read((view) => view.all('SELECT snapshot_id FROM usage_snapshots')).value
    ).toEqual([
      { snapshot_id: original.payload.snapshot_id },
      { snapshot_id: original.payload.snapshot_id },
    ]);
    expect(readProjectUsage(handle)?.events).toHaveLength(2);
  });
  it('detaches bytes and revision values before yielding to transaction admission', async () => {
    const { handle } = await fixture();
    const input = request();
    const original = Buffer.from(input.eventBytes);
    const pending = appendProjectUsageEvents(handle, input);
    input.eventBytes.fill(0);
    const result = await pending;
    expect(readProjectUsage(handle)?.eventBytes).toEqual(original);
    expect(result.value.eventIds).toHaveLength(1);
  });
  it('refuses stale selection and retained event identity without receipts', async () => {
    const { handle } = await fixture();
    const input = request();
    const first = await appendProjectUsageEvents(handle, input);
    const before = state(handle);
    await expect(appendProjectUsageEvents(handle, request())).rejects.toMatchObject({
      code: 'STALE_CONTEXT',
    });
    await expect(
      appendProjectUsageEvents(handle, {
        ...input,
        operationId: uuidv7(),
        expectedRevision: first.value.revision,
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(state(handle)).toEqual(before);
  });
  it('retains exact noncanonical sidecar bytes and refuses wrong hashes or unreferenced bytes', async () => {
    const { handle } = await fixture();
    const { record, payload } = snapshot();
    const sidecar = Buffer.from(' ' + JSON.stringify(payload) + '\n');
    const unsigned = {
      event_id: record.event_id,
      type: record.type,
      ts: record.ts,
      schema_version: 1 as const,
      idempotency_key: record.idempotency_key,
      sidecar_sha256: digest(sidecar),
      sidecar_size: sidecar.length,
    };
    const wire = { ...unsigned, checksum: recordChecksum(unsigned) };
    const input = {
      ...request(),
      eventBytes: Buffer.from(JSON.stringify(wire) + '\n'),
      sidecarPayloads: [{ eventId: record.event_id, bytes: sidecar }],
    };
    await expect(
      appendProjectUsageEvents(handle, {
        ...input,
        sidecarPayloads: [{ eventId: record.event_id, bytes: Buffer.from('{}') }],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      appendProjectUsageEvents(handle, {
        ...request(),
        sidecarPayloads: [{ eventId: uuidv7(), bytes: sidecar }],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await appendProjectUsageEvents(handle, input);
    expect(readProjectUsage(handle)?.sidecarPayloads).toEqual(input.sidecarPayloads);
  });
  it('rolls back the whole publication on accounting row failure', async () => {
    const { handle, authority } = await fixture();
    const db = new Database(projectDatabasePath(authority));
    db.exec(
      "CREATE TRIGGER deny_usage BEFORE INSERT ON usage_snapshots BEGIN SELECT RAISE(ABORT, 'denied'); END"
    );
    const before = state(handle);
    try {
      await expect(appendProjectUsageEvents(handle, request())).rejects.toMatchObject({
        code: 'TRANSACTION_FAILED',
        reason: 'constraint',
      });
    } finally {
      db.exec('DROP TRIGGER deny_usage');
      db.close();
    }
    expect(state(handle)).toEqual(before);
    await expect(appendProjectUsageEvents(handle, request())).resolves.toMatchObject({
      replayed: false,
    });
  });
  it('enforces immutable events, revisions and exact selected revision references', async () => {
    const { handle } = await fixture();
    await appendProjectUsageEvents(handle, request());
    const before = state(handle);
    for (const sql of [
      "UPDATE usage_events SET recorded_at = 'changed'",
      'DELETE FROM usage_revisions',
      'DELETE FROM usage_selection',
      'UPDATE usage_selection SET current_generation = 999',
    ]) {
      await expect(
        runProjectOperation(
          handle,
          {
            operationId: uuidv7(),
            kind: 'test.invalid',
            target: {},
            payload: {},
            expectedState: null,
            intentChange: false,
          },
          (tx) => {
            tx.run(sql);
            return null;
          }
        )
      ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED', reason: 'constraint' });
    }
    expect(state(handle)).toEqual(before);
  });
  it('refuses cancellation without a usage receipt or counter change', async () => {
    const { handle } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const before = state(handle);
    await expect(
      appendProjectUsageEvents(handle, request(), { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(state(handle)).toEqual(before);
  });
  it.each([
    ['inline', false],
    ['inline', true],
    ['sidecar', false],
    ['sidecar', true],
  ] as const)(
    'refuses concealed exact %s bytes with unicode escaping %s',
    async (representation, escaped) => {
      const { handle } = await fixture();
      const { record, payload } = snapshot();
      const secret = 'ghp_' + 'A'.repeat(36);
      const hidden = escaped
        ? Array.from(secret)
            .map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
            .join('')
        : secret;
      const payloadText = JSON.stringify(payload).replace(
        '"agent":',
        '"agent":"' + hidden + '","agent":'
      );
      const unsigned = {
        event_id: record.event_id,
        type: record.type,
        ts: record.ts,
        schema_version: 1 as const,
        idempotency_key: record.idempotency_key,
        sidecar_sha256: digest(payloadText),
        sidecar_size: Buffer.byteLength(payloadText),
      };
      const wire = { ...unsigned, checksum: recordChecksum(unsigned) };
      const before = state(handle);
      await expect(
        appendProjectUsageEvents(handle, {
          ...request(),
          eventBytes: Buffer.from(
            (representation === 'inline'
              ? JSON.stringify(record).replace(JSON.stringify(payload), payloadText)
              : JSON.stringify(wire)) + '\n'
          ),
          sidecarPayloads:
            representation === 'sidecar'
              ? [{ eventId: record.event_id, bytes: Buffer.from(payloadText) }]
              : [],
        })
      ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
      expect(state(handle)).toEqual(before);
    }
  );
  it('reads retained allowed evidence without applying current authored refusal', async () => {
    const { handle } = await fixture();
    const knownDead = 'ghp_' + 'A'.repeat(36);
    const { record } = snapshot(12, { agent: knownDead });
    const input = {
      ...request(),
      eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
      secretAllow: [knownDead],
    };
    await appendProjectUsageEvents(handle, input);
    expect(readProjectUsage(handle)?.eventBytes).toEqual(input.eventBytes);
  });
  it('rejects malformed payloads, envelope keys and unsafe publication counters', async () => {
    const { handle } = await fixture();
    const { record, payload } = snapshot();
    for (const modified of [
      { ...payload, idempotency_key: 'different' },
      { ...payload, cumulative_usage: { input_tokens: -1 } },
    ]) {
      const unsigned = { ...record, payload: modified };
      const wire = { ...unsigned, checksum: recordChecksum(unsigned) };
      await expect(
        appendProjectUsageEvents(handle, {
          ...request(),
          eventBytes: Buffer.from(JSON.stringify(wire) + '\n'),
        })
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(
      appendProjectUsageEvents(handle, {
        ...request(),
        expectedRevision: {
          generation: Number.MAX_SAFE_INTEGER,
          eventCount: 1,
          byteLength: 1,
          orderedHash: 'a'.repeat(64),
          tailEventId: uuidv7(),
        },
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(state(handle).value).toEqual({ events: 0, operations: 0, revisions: 0 });
  });
});
