import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventType } from '../../events/event-log.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest, orderedHash, recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import { artifactEventsChangeIntent } from './artifact-events.js';
import {
  appendProjectArtifactEvents,
  type AppendProjectArtifactEvents,
  listProjectArtifacts,
  readProjectArtifact,
} from './artifacts.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-artifacts-')),
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
function plan(artifactId: string, branch = 'topic', startedAt = '2026-06-01T00:00:00.000Z') {
  return {
    schema_version: 4,
    artifact_id: artifactId,
    branch,
    base_sha: 'original-base',
    agent: 'codex',
    agent_session_id: null,
    task: 'Retain original bytes',
    label: 'Original plan',
    plan_steps: [
      {
        step_id: uuidv7(),
        text: 'Keep identities',
        label: 'Keep identities',
        acceptance_criteria: [],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: startedAt,
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  };
}
function event(type: EventType, payload: unknown, sidecar = false) {
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const record = {
    event_id: uuidv7(),
    type,
    ts: '2026-06-01T00:01:00.000Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    ...(sidecar
      ? { sidecar_sha256: digest(payloadBytes), sidecar_size: payloadBytes.length }
      : { payload }),
  };
  const checked = { ...record, checksum: recordChecksum(record) };
  return { record: checked, bytes: Buffer.from(` ${JSON.stringify(checked)} \n`), payloadBytes };
}
function input(artifactId = uuidv7(), branch?: string): AppendProjectArtifactEvents {
  return {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: null,
    eventBytes: event('plan_captured', plan(artifactId, branch)).bytes,
    sidecarPayloads: [],
    secretAllow: [],
  };
}
function counts(handle: ProjectDatabase) {
  return handle.read((view) => ({
    events: view.get<{ n: number }>('SELECT count(*) AS n FROM artifact_events')!.n,
    operations: view.get<{ n: number }>('SELECT count(*) AS n FROM operations')!.n,
    artifacts: view.get<{ n: number }>('SELECT count(*) AS n FROM artifacts')!.n,
  }));
}
describe('canonical artifact events', () => {
  it('retains exact inline and sidecar bytes with independent publication and event order', async () => {
    const { handle } = await fixture();
    const artifactId = uuidv7();
    const initial = event('plan_captured', plan(artifactId), true);
    const lineage = event('branch_lineage_updated', {
      artifact_id: artifactId,
      branch: 'rebased',
      head_sha: 'next-head',
      ts: '2026-06-01T00:02:00.000Z',
      event: 'rebased',
    });
    const bytes = Buffer.concat([initial.bytes, lineage.bytes]);
    const result = await appendProjectArtifactEvents(handle, {
      operationId: uuidv7(),
      artifactId,
      expectedRevision: null,
      eventBytes: bytes,
      sidecarPayloads: [{ eventId: initial.record.event_id, bytes: initial.payloadBytes }],
      secretAllow: [],
    });
    expect(result.value.revision).toEqual({
      generation: 1,
      eventCount: 2,
      byteLength: bytes.length,
      orderedHash: orderedHash([initial.record, lineage.record]),
      tailEventId: lineage.record.event_id,
    });
    const read = readProjectArtifact(handle, artifactId)!;
    expect(read.eventBytes).toEqual(bytes);
    expect(read.sidecarPayloads).toEqual([
      { eventId: initial.record.event_id, bytes: initial.payloadBytes },
    ]);
    expect(read.thread.plan?.revision_n).toBe(0);
    expect(read.thread.plan?.source_event_id).toBe(initial.record.event_id);
    expect(listProjectArtifacts(handle, { branch: 'topic', limit: 1 }).artifacts).toHaveLength(1);
    expect(listProjectArtifacts(handle, { branch: 'rebased', limit: 1 }).artifacts).toHaveLength(1);
    expect(result.counters).toEqual({ writeSequence: 2, intentChangeCounter: 1 });
  });

  it('replays original results after later appends without duplicating rows or counters', async () => {
    const { handle } = await fixture();
    const original = input();
    const first = await appendProjectArtifactEvents(handle, original);
    const bytes = event('pin_displaced', { artifact_id: original.artifactId }).bytes;
    const next = {
      ...original,
      operationId: uuidv7(),
      expectedRevision: first.value.revision,
      eventBytes: bytes,
    };
    const second = await appendProjectArtifactEvents(handle, next);
    const before = counts(handle);
    const replay = await appendProjectArtifactEvents(handle, original);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await appendProjectArtifactEvents(handle, next)).toEqual({ ...second, replayed: true });
    expect(counts(handle)).toEqual(before);
    expect(
      readProjectArtifact(handle, original.artifactId, first.value.revision)?.eventBytes
    ).toEqual(original.eventBytes);
    expect(second.counters).toEqual({ writeSequence: 3, intentChangeCounter: 1 });
  });

  it('refuses same-operation changed content and a stale new operation atomically', async () => {
    const { handle } = await fixture();
    const original = input();
    await appendProjectArtifactEvents(handle, original);
    const before = counts(handle);
    await expect(
      appendProjectArtifactEvents(handle, {
        ...input(original.artifactId),
        operationId: original.operationId,
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      appendProjectArtifactEvents(handle, { ...original, operationId: uuidv7() })
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    expect(counts(handle)).toEqual(before);
  });

  it('keeps plan revisions and source event identities distinct from publication generation', async () => {
    const { handle } = await fixture();
    const original = input();
    const first = await appendProjectArtifactEvents(handle, original);
    const snapshot = readProjectArtifact(handle, original.artifactId)!;
    const revised = {
      ...snapshot.thread.plan!,
      label: 'Revised plan',
      revision_n: 1,
      revised_at: '2026-06-01T00:02:00.000Z',
      rationale: 'Clarified intent',
      prior_plan_event_id: snapshot.thread.plan!.source_event_id,
    };
    const changed = event('plan_revised', revised);
    const result = await appendProjectArtifactEvents(handle, {
      ...original,
      operationId: uuidv7(),
      expectedRevision: first.value.revision,
      eventBytes: changed.bytes,
    });
    const read = readProjectArtifact(handle, original.artifactId)!;
    expect(read.thread.plan).toMatchObject({
      revision_n: 1,
      source_event_id: changed.record.event_id,
      prior_plan_event_id: snapshot.thread.plan!.source_event_id,
    });
    expect(result.value.revision.generation).toBe(2);
    expect(result.counters.intentChangeCounter).toBe(2);
  });

  it.each(['missing', 'wrong-hash', 'unreferenced', 'inline-sidecar', 'invalid-json'])(
    'refuses %s sidecar representation before settlement',
    async (kind) => {
      const { handle } = await fixture();
      const original = input();
      const encoded = event('plan_captured', plan(original.artifactId), kind !== 'inline-sidecar');
      let bytes = encoded.payloadBytes;
      let record = encoded.record;
      if (kind === 'wrong-hash') bytes = Buffer.from('different');
      if (kind === 'invalid-json') {
        bytes = Buffer.from('invalid JSON');
        const changed = { ...record, sidecar_sha256: digest(bytes), sidecar_size: bytes.length };
        record = { ...changed, checksum: recordChecksum(changed) };
      }
      const before = counts(handle);
      await expect(
        appendProjectArtifactEvents(handle, {
          ...original,
          eventBytes: Buffer.from(`${JSON.stringify(record)}\n`),
          sidecarPayloads:
            kind === 'missing'
              ? []
              : [{ eventId: kind === 'unreferenced' ? uuidv7() : record.event_id, bytes }],
        })
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(counts(handle)).toEqual(before);
    }
  );

  it('refuses secrets without events, operation receipts or counter changes', async () => {
    const { handle } = await fixture();
    const original = input();
    const before = counts(handle);
    const secret = 'ghp_' + 'A'.repeat(36);
    await expect(
      appendProjectArtifactEvents(handle, {
        ...original,
        eventBytes: event('plan_captured', { ...plan(original.artifactId), task: secret }).bytes,
      })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(counts(handle)).toEqual(before);
  });

  it.each([
    ['inline', false],
    ['inline', true],
    ['sidecar', false],
    ['sidecar', true],
  ] as const)(
    'refuses concealed secret bytes in %s with unicode escaping %s',
    async (representation, escaped) => {
      const { handle } = await fixture();
      const original = input();
      const payload = plan(original.artifactId);
      const secret = 'ghp_' + 'A'.repeat(36);
      const hidden = escaped
        ? Array.from(secret)
            .map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
            .join('')
        : secret;
      const payloadText = JSON.stringify(payload).replace(
        '"task":',
        '"task":"' + hidden + '","task":'
      );
      const encoded = event('plan_captured', payload, representation === 'sidecar');
      let record = encoded.record;
      if (representation === 'sidecar') {
        const changed = {
          ...record,
          sidecar_sha256: digest(payloadText),
          sidecar_size: Buffer.byteLength(payloadText),
        };
        record = { ...changed, checksum: recordChecksum(changed) };
      }
      const bytes =
        representation === 'inline'
          ? Buffer.from(JSON.stringify(record).replace(JSON.stringify(payload), payloadText) + '\n')
          : Buffer.from(JSON.stringify(record) + '\n');
      const before = counts(handle);
      await expect(
        appendProjectArtifactEvents(handle, {
          ...original,
          eventBytes: bytes,
          sidecarPayloads:
            representation === 'sidecar'
              ? [{ eventId: record.event_id, bytes: Buffer.from(payloadText) }]
              : [],
        })
      ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
      expect(counts(handle)).toEqual(before);
    }
  );

  it('preserves explicitly allowed exact sidecar bytes and does not reapply authoring refusal on read', async () => {
    const { handle } = await fixture();
    const original = input();
    const knownDead = 'ghp_' + 'A'.repeat(36);
    const payload = { ...plan(original.artifactId), task: knownDead };
    const sidecar = Buffer.from(' \n' + JSON.stringify(payload, null, 2) + '\n ');
    const encoded = event('plan_captured', payload, true);
    const changed = {
      ...encoded.record,
      sidecar_sha256: digest(sidecar),
      sidecar_size: sidecar.length,
    };
    const record = { ...changed, checksum: recordChecksum(changed) };
    const bytes = Buffer.from(' ' + JSON.stringify(record) + ' \n');
    await appendProjectArtifactEvents(handle, {
      ...original,
      eventBytes: bytes,
      sidecarPayloads: [{ eventId: record.event_id, bytes: sidecar }],
      secretAllow: [knownDead],
    });
    const read = readProjectArtifact(handle, original.artifactId)!;
    expect(read.eventBytes).toEqual(bytes);
    expect(read.sidecarPayloads).toEqual([{ eventId: record.event_id, bytes: sidecar }]);
    expect(read.thread.plan?.task).toBe(knownDead);
  });

  it('refuses a hidden value behind an escaped duplicate property name before publication', async () => {
    const { handle } = await fixture();
    const original = input();
    const payload = plan(original.artifactId);
    const secret = 'ghp_' + 'A'.repeat(36);
    const escaped = Array.from(secret)
      .map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('');
    const text = JSON.stringify(payload).replace(
      '"task":',
      '"\\u0074ask":"' + escaped + '","task":'
    );
    const encoded = event('plan_captured', payload);
    const bytes = Buffer.from(
      JSON.stringify(encoded.record).replace(JSON.stringify(payload), text) + '\n'
    );
    const before = counts(handle);
    await expect(
      appendProjectArtifactEvents(handle, { ...original, eventBytes: bytes })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(counts(handle)).toEqual(before);
  });

  it('refuses corrupted wire bytes and malformed semantic payloads without writes', async () => {
    const { handle } = await fixture();
    const original = input();
    const before = counts(handle);
    for (const bytes of [
      Buffer.from('invalid\n'),
      Buffer.from('{}'),
      event('plan_captured', { artifact_id: original.artifactId }).bytes,
    ]) {
      await expect(
        appendProjectArtifactEvents(handle, { ...original, eventBytes: bytes })
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(counts(handle)).toEqual(before);
    }
  });

  it('lists with SQL limits and branch selection without decoding unrelated corrupt events', async () => {
    const { handle } = await fixture();
    const first = input(undefined, 'a');
    const second = input(undefined, 'b');
    await appendProjectArtifactEvents(handle, first);
    await appendProjectArtifactEvents(handle, second);
    const raw = new Database(handle.databasePath);
    raw.exec('DROP TRIGGER artifact_events_no_update');
    raw
      .prepare('UPDATE artifact_events SET record_bytes = ? WHERE artifact_id = ?')
      .run(Buffer.from('broken\n'), second.artifactId);
    raw.close();
    const prepare = vi.spyOn(Database.prototype, 'prepare');
    expect(
      listProjectArtifacts(handle, { branch: 'a', limit: 1 }).artifacts.map((row) => row.artifactId)
    ).toEqual([first.artifactId]);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('LIMIT ? OFFSET ?'))).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('FROM artifact_events'))).toBe(false);
    expect(readProjectArtifact(handle, first.artifactId)?.eventBytes).toEqual(first.eventBytes);
    expect(() => readProjectArtifact(handle, second.artifactId)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  });

  it('rejects invalid selected and cross-artifact references at commit and rolls back', async () => {
    const { handle } = await fixture();
    const first = input();
    const second = input();
    const a = await appendProjectArtifactEvents(handle, first);
    const b = await appendProjectArtifactEvents(handle, second);
    const raw = new Database(handle.databasePath);
    raw.pragma('foreign_keys = ON');
    try {
      raw.exec('BEGIN IMMEDIATE');
      raw
        .prepare('UPDATE artifacts SET current_generation = 50 WHERE artifact_id = ?')
        .run(first.artifactId);
      expect(() => raw.exec('COMMIT')).toThrow();
      expect(raw.inTransaction).toBe(true);
      raw.exec('ROLLBACK');
      raw.exec('BEGIN IMMEDIATE');
      expect(() =>
        raw
          .prepare('INSERT INTO artifact_revisions VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(
            first.artifactId,
            2,
            first.operationId,
            a.value.revision.orderedHash,
            1,
            1,
            b.value.revision.tailEventId
          )
      ).toThrow();
      raw.exec('ROLLBACK');
      expect(readProjectArtifact(handle, first.artifactId)?.revision).toEqual(a.value.revision);
    } finally {
      if (raw.inTransaction) raw.exec('ROLLBACK');
      raw.close();
    }
  });

  it('detects a changed exact record representation even when the wire checksum still matches', async () => {
    const { handle } = await fixture();
    const original = input();
    await appendProjectArtifactEvents(handle, original);
    const raw = new Database(handle.databasePath);
    raw.exec('DROP TRIGGER artifact_events_no_update');
    const old = Buffer.from(original.eventBytes).toString('utf8');
    const changed = Buffer.from(old.replace(/^ /, '\t'));
    raw.prepare('UPDATE artifact_events SET record_bytes = ?').run(changed);
    raw.close();
    expect(() => readProjectArtifact(handle, original.artifactId)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  });

  it('conflicts a changed operation target before looking up its nonexistent prior publication', async () => {
    const { handle } = await fixture();
    const original = input();
    const result = await appendProjectArtifactEvents(handle, original);
    const other = input();
    await expect(
      appendProjectArtifactEvents(handle, {
        ...other,
        operationId: original.operationId,
        expectedRevision: result.value.revision,
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(counts(handle).value).toEqual({ events: 1, operations: 1, artifacts: 1 });
  });

  it('enforces immutable event/revision rows in the database', async () => {
    const { handle } = await fixture();
    await appendProjectArtifactEvents(handle, input());
    const raw = new Database(handle.databasePath);
    try {
      for (const table of ['artifact_events', 'artifact_revisions']) {
        expect(() => raw.exec(`DELETE FROM ${table}`)).toThrow();
        expect(() => raw.exec(`UPDATE ${table} SET artifact_id = artifact_id`)).toThrow();
      }
    } finally {
      raw.close();
    }
  });

  it.each([
    ['plan_captured', {}, true],
    ['plan_revised', {}, true],
    ['git_import_enriched', { decisions: { mode: 'preserve' } }, true],
    ['checkpoint_closed', { decisions: [{ decision: 'Retain intent', reason: 'Required' }] }, true],
    ['checkpoint_closed', { decisions: [] }, false],
    ['summary_captured', {}, false],
    ['evaluator_run_recorded', {}, false],
    ['pin_displaced', {}, false],
  ] as const)(
    'classifies intent for %s with its explicit authored fields',
    (type, payload, expected) => {
      const encoded = event(type, payload);
      expect(artifactEventsChangeIntent([{ record: encoded.record as never, payload }])).toBe(
        expected
      );
    }
  );
});
