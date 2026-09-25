import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { projectDatabasePath } from './connection.js';
import { publishProjectKnowledgeSource, readProjectKnowledgeSource } from './knowledge-sources.js';
import {
  capturePlan,
  counters,
  DETECTOR,
  discardKnowledgeStores,
  knowledgeStore,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const owner = { identity: 'owner@example.test', basis: 'agent_reported_user_instruction' } as const;
const agent = { identity: 'claude-code', basis: 'source_attributed' } as const;

async function store() {
  const { handle } = await knowledgeStore();
  const plan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [
      { stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: 'Capture works offline' }] },
    ],
  };
  await capturePlan(handle, plan);
  return { handle, plan };
}

const captureField = (plan: { artifactId: string; planEventId: string }, position = 0) => ({
  source_id: uuidv7(),
  occurrence: {
    kind: 'capture_field',
    artifact_id: plan.artifactId,
    event_id: plan.planEventId,
    field_path: 'plan_steps[0].acceptance_criteria[0].text',
    position,
  },
  source_author: owner,
  interpreted_by: null,
  access_restriction: null,
});

const instruction = (bytes: Buffer) => ({
  source_id: uuidv7(),
  occurrence: {
    kind: 'user_instruction',
    retention: { kind: 'bytes', content_sha256: digest(bytes) },
    location: 'session transcript, turn 4',
    source_time: '2026-09-17T10:00:00.000Z',
  },
  source_author: owner,
  interpreted_by: null,
  access_restriction: null,
});

const stored = (handle: Parameters<typeof rowCount>[0], sourceId: string) =>
  read(handle, (view) => readProjectKnowledgeSource(view, sourceId));

it('publishes one source per capture occurrence, with a payload that hashes to its row', async () => {
  const { handle, plan } = await store();
  const source = captureField(plan);
  const operationsBefore = rowCount(handle, 'operations') + 1;
  const first = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source,
    recordedBy: agent,
    secretAllow: [],
  });
  expect(first.value).toEqual({
    sourceId: source.source_id,
    recordSha256: expect.any(String),
    published: true,
  });
  const row = stored(handle, source.source_id)!;
  const bytes = Buffer.from(row.recordHex, 'hex');
  expect(digest(bytes)).toBe(row.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...source, recorded_by: agent });

  const before = counters(handle);
  const again = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: { ...source, source_id: uuidv7() },
    recordedBy: agent,
    secretAllow: [],
  });
  expect(again).toEqual({
    value: { sourceId: source.source_id, recordSha256: row.recordSha256, published: false },
    replayed: true,
    counters: before,
  });
  expect(rowCount(handle, 'knowledge_sources')).toBe(1);
  expect(rowCount(handle, 'operations')).toBe(operationsBefore);
});

it('replays the original result under the same operation id and refuses a changed field', async () => {
  const { handle, plan } = await store();
  const operationId = uuidv7();
  const source = captureField(plan);
  const first = await publishProjectKnowledgeSource(handle, {
    operationId,
    source,
    recordedBy: agent,
    secretAllow: [],
  });
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: { ...captureField(plan, 1) },
    recordedBy: agent,
    secretAllow: [],
  });
  const replayed = await publishProjectKnowledgeSource(handle, {
    operationId,
    source,
    recordedBy: agent,
    secretAllow: [],
  });
  expect(replayed).toEqual({ ...first, replayed: true });

  const before = rowCount(handle, 'knowledge_sources');
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId,
      source: { ...source, access_restriction: 'team only' },
      recordedBy: agent,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId,
      source,
      recordedBy: owner,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'knowledge_sources')).toBe(before);
});

it('refuses a second reading of a capture occurrence under a new operation id', async () => {
  const { handle, plan } = await store();
  const source = captureField(plan);
  const first = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source,
    recordedBy: agent,
    secretAllow: [],
  });
  // An unrelated later publication, so no receipt of the first one answers what follows.
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: captureField(plan, 1),
    recordedBy: agent,
    secretAllow: [],
  });

  const identical = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source,
    recordedBy: agent,
    secretAllow: [],
  });
  expect(identical.value).toEqual({
    sourceId: source.source_id,
    recordSha256: first.value.recordSha256,
    published: false,
  });

  const before = counters(handle);
  const rows = rowCount(handle, 'knowledge_sources');
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: {
        ...source,
        source_id: uuidv7(),
        interpreted_by: DETECTOR,
        access_restriction: 'private_to_owner',
      },
      recordedBy: agent,
      secretAllow: [],
    })
  ).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
    message: `That capture field is already source ${source.source_id}`,
  });
  expect(rowCount(handle, 'knowledge_sources')).toBe(rows);
  expect(counters(handle)).toEqual(before);
  expect(stored(handle, source.source_id)!.accessRestriction).toBeNull();
});

/** The occurrence and the attribution a retained source record states, as the row copies them. */
interface StoredSource {
  occurrence:
    | {
        kind: 'capture_field';
        artifact_id: string;
        event_id: string;
        field_path: string;
        position: number;
      }
    | { kind: 'user_instruction'; retention: { kind: string; content_sha256: string } };
  source_author: { identity: string; basis: string };
  recorded_by: { identity: string; basis: string };
  interpreted_by: { kind: string; detector: string } | null;
  access_restriction: string | null;
}

it('keeps every lookup column of a source agreeing with the record beside it', async () => {
  const { handle, plan } = await store();
  const bytes = Buffer.from('The owner asked for offline capture.', 'utf8');
  const field = {
    ...captureField(plan),
    interpreted_by: DETECTOR,
    access_restriction: 'team only',
  };
  const retained = instruction(bytes);
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: field,
    recordedBy: agent,
    secretAllow: [],
  });
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: retained,
    recordedBy: agent,
    retainedBytes: bytes,
    secretAllow: [],
  });

  // Every column the writer kept beside the payload says what the payload says.
  for (const authored of [field, retained]) {
    const row = read(handle, (view) =>
      view.get<Record<string, unknown>>(
        `SELECT source_kind, artifact_id, event_id, field_path, position, retention_kind,
           retained_reference, content_sha256, source_author, source_author_basis,
           recorded_by, recorded_by_basis, interpreted_kind, interpreted_by, interpreted_by_basis,
           access_restriction, CAST(record_bytes AS TEXT) AS payload
         FROM knowledge_sources WHERE source_id=?`,
        authored.source_id
      )
    )!;
    const record = JSON.parse(row.payload as string) as StoredSource;
    expect(record).toEqual({ ...authored, recorded_by: agent });
    const capture = record.occurrence.kind === 'capture_field' ? record.occurrence : null;
    const retention =
      record.occurrence.kind === 'capture_field' ? null : record.occurrence.retention;
    expect(row, record.occurrence.kind).toMatchObject({
      source_kind: record.occurrence.kind,
      artifact_id: capture?.artifact_id ?? null,
      event_id: capture?.event_id ?? null,
      field_path: capture?.field_path ?? null,
      position: capture?.position ?? null,
      retention_kind: retention?.kind ?? null,
      retained_reference: null,
      content_sha256: retention?.content_sha256 ?? null,
      source_author: record.source_author.identity,
      source_author_basis: record.source_author.basis,
      recorded_by: record.recorded_by.identity,
      recorded_by_basis: record.recorded_by.basis,
      interpreted_kind: record.interpreted_by === null ? null : record.interpreted_by.kind,
      interpreted_by: record.interpreted_by === null ? null : record.interpreted_by.detector,
      interpreted_by_basis: null,
      access_restriction: record.access_restriction,
    });
  }
});

it('refuses a capture event this history does not hold and writes nothing', async () => {
  const { handle, plan } = await store();
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: {
        ...captureField(plan),
        occurrence: { ...captureField(plan).occurrence, event_id: uuidv7() },
      },
      recordedBy: agent,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'knowledge_sources')).toBe(0);
});

it('refuses a source whose retained bytes do not hash to the content identity it states', async () => {
  const { handle } = await store();
  const bytes = Buffer.from('Keep local capture working with no Cloud connection.');
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: instruction(bytes),
      recordedBy: agent,
      secretAllow: [],
      retainedBytes: Buffer.from('something else entirely'),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: instruction(bytes),
      recordedBy: agent,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_sources')).toBe(0);
});

it('retains the bytes an instruction keeps and leaves the intent counter alone', async () => {
  const { handle } = await store();
  const bytes = Buffer.from('Keep local capture working with no Cloud connection.');
  const before = counters(handle);
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: instruction(bytes),
    recordedBy: agent,
    secretAllow: [],
    retainedBytes: bytes,
  });
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  expect(stored(handle, published.value.sourceId)!.retainedBytesHex).toBe(
    bytes.toString('hex').toUpperCase()
  );
  expect(stored(handle, published.value.sourceId)!.accessRestriction).toBeNull();
});

it('returns the access restriction the writer recorded', async () => {
  const { handle, plan } = await store();
  const source = { ...captureField(plan), access_restriction: 'owner only' };
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source,
    recordedBy: agent,
    secretAllow: [],
  });
  expect(stored(handle, source.source_id)!.accessRestriction).toBe('owner only');
});

it('retains the checked source bytes when the caller changes its buffer during a writer wait', async () => {
  const { handle } = await store();
  const bytes = Buffer.from('The user asked for offline capture.'.padEnd(80, ' '));
  const checked = Buffer.from(bytes);
  const source = instruction(bytes);
  const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzA';
  const competing = new Database(projectDatabasePath(handle.authority));
  let waited = false;
  competing.exec('BEGIN IMMEDIATE');
  try {
    await publishProjectKnowledgeSource(
      handle,
      { operationId: uuidv7(), source, recordedBy: agent, retainedBytes: bytes, secretAllow: [] },
      {
        onWait() {
          waited = true;
          bytes.fill(' ');
          bytes.write(token);
          competing.exec('ROLLBACK');
        },
      }
    );
  } finally {
    if (competing.inTransaction) competing.exec('ROLLBACK');
    competing.close();
  }

  expect(waited).toBe(true);
  const retained = stored(handle, source.source_id)!;
  const retainedBytes = Buffer.from(retained.retainedBytesHex!, 'hex');
  expect(retainedBytes).toEqual(checked);
  expect(digest(retainedBytes)).toBe(source.occurrence.retention.content_sha256);
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: instruction(bytes),
      recordedBy: agent,
      retainedBytes: bytes,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
});

it('refuses a secret in retained source text, and keeps one the caller allows', async () => {
  const { handle } = await store();
  const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzA';
  const leaked = Buffer.from(`the user wrote: ${token}`);
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: instruction(leaked),
      recordedBy: agent,
      retainedBytes: leaked,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(rowCount(handle, 'knowledge_sources')).toBe(0);

  const allowed = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: instruction(leaked),
    recordedBy: agent,
    retainedBytes: leaked,
    secretAllow: [token],
  });
  expect(allowed.value.published).toBe(true);
});

it('retains bytes that are not text without reading a secret out of them', async () => {
  const { handle } = await store();
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]);
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: instruction(binary),
    recordedBy: agent,
    retainedBytes: binary,
    secretAllow: [],
  });
  expect(stored(handle, published.value.sourceId)!.retainedBytesHex).toBe(
    binary.toString('hex').toUpperCase()
  );
});

it('keeps a source nobody interpreted apart from one a detector interpreted', async () => {
  const { handle, plan } = await store();
  const untouched = captureField(plan);
  const detected = { ...captureField(plan, 1), interpreted_by: DETECTOR };
  const read = { ...captureField(plan, 2), interpreted_by: { kind: 'actor', actor: owner } };
  for (const source of [untouched, detected, read])
    await publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source,
      recordedBy: agent,
      secretAllow: [],
    });
  expect(
    [untouched, detected, read].map((source) => stored(handle, source.source_id)!.interpretedBy)
  ).toEqual([
    null,
    { kind: 'detector', name: DETECTOR.detector, basis: null },
    { kind: 'actor', name: owner.identity, basis: owner.basis },
  ]);
});

it('refuses a detector named as the interpreting actor', async () => {
  const { handle, plan } = await store();
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: {
        ...captureField(plan),
        interpreted_by: { identity: DETECTOR.detector, basis: 'other_assertion' },
      },
      recordedBy: agent,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_sources')).toBe(0);
});

it('refuses an acting attribution named inside the record', async () => {
  const { handle, plan } = await store();
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: { ...captureField(plan), recorded_by: owner },
      recordedBy: agent,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('refuses a source id a different occurrence already holds', async () => {
  const { handle, plan } = await store();
  const source = captureField(plan);
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source,
    recordedBy: agent,
    secretAllow: [],
  });
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: { ...captureField(plan, 1), source_id: source.source_id },
      recordedBy: agent,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'knowledge_sources')).toBe(1);
});
