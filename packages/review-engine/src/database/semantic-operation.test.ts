import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import {
  decode,
  type RestoredFixture,
  restoreFixture,
  snapshot,
} from '../../../storage/tests/database-fixture.mjs';
import { SEMANTIC_ANCHOR_PROFILE } from '../semanticAnchors.js';
import { readDatabaseSemanticOperation } from './semantic-operation.js';
import {
  type PublishDatabaseSemanticGeneration,
  publishDatabaseSemanticGeneration,
} from './semantic-publish.js';

const candidate = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtureFile = path.join(
  candidate,
  'packages/storage/src/history/database/fixtures/semantic-review.json'
);
const active: RestoredFixture[] = [];
afterEach(async () => {
  for (const fixture of active.splice(0)) await fixture.cleanup();
});
async function published() {
  const f = await restoreFixture(candidate, fixtureFile);
  active.push(f);
  const saved = JSON.parse(await readFile(fixtureFile, 'utf8'));
  const source = decode(saved.semanticInput) as {
    reviewId: string;
    runId: string;
    generationId: string;
    expected: PublishDatabaseSemanticGeneration['expected'];
    submissionBytes: Uint8Array;
  };
  const input: PublishDatabaseSemanticGeneration = {
    ...source,
    authority: f.authority,
    operationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
    secretAllow: [],
    expected: { ...source.expected, semanticGenerationId: null, semanticVersion: 0 },
    authored: {
      profile: SEMANTIC_ANCHOR_PROFILE,
      startedAt: '2026-09-07T00:00:00.000Z',
      submittedAt: '2026-09-07T00:00:01.000Z',
      runtimeIdentity: null,
    },
    attempt: { kind: 'initial' },
  };
  const result = await publishDatabaseSemanticGeneration(input);
  expect(result.value.status).toBe('VALID');
  return { f, input, result };
}
function alterReceipt(
  f: RestoredFixture,
  change: (db: InstanceType<RestoredFixture['Database']>) => void
) {
  const db = new f.Database(f.file);
  try {
    db.pragma('foreign_keys=OFF');
    const triggers = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='operations'")
      .all() as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${JSON.stringify(trigger.name)}`);
    change(db);
    for (const trigger of triggers) db.exec(trigger.sql);
  } finally {
    db.close();
  }
}

describe('original semantic operation lookup', () => {
  it('refuses an unsupported database without changing retained history', async () => {
    const f = await restoreFixture(candidate, fixtureFile);
    active.push(f);
    const database = new f.Database(f.file);
    database.pragma('user_version = 28');
    database.close();
    const before = snapshot(f.Database, f.file);
    await expect(
      readDatabaseSemanticOperation({ authority: f.authority, operationId: uuidv7() })
    ).rejects.toMatchObject({ code: 'HISTORY_FORMAT_UNSUPPORTED' });
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });

  it('reads an actual installed-store publication without changing its retained rows', async () => {
    const { f, input, result } = await published();
    const before = snapshot(f.Database, f.file);
    const found = await readDatabaseSemanticOperation({
      authority: input.authority,
      operationId: input.operationId,
    });
    expect(found.value).toMatchObject({
      operationId: input.operationId,
      target: {
        reviewId: input.reviewId,
        runId: 'retained-account-run',
        generationId: input.generationId,
      },
      payload: { attemptRevisionId: input.attemptRevisionId, authored: input.authored },
      expected: input.expected,
      result: result.value,
    });
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });

  it('retains the original result after a newer selection and missing evidence', async () => {
    const { f, input, result } = await published();
    const newer = {
      ...input,
      operationId: uuidv7(),
      generationId: uuidv7(),
      attemptRevisionId: uuidv7(),
      modelPublicationId: uuidv7(),
      expected: { ...input.expected, semanticGenerationId: input.generationId, semanticVersion: 1 },
    };
    await publishDatabaseSemanticGeneration(newer);
    await rm(path.join(path.dirname(f.file), 'evidence'), { recursive: true });
    const before = snapshot(f.Database, f.file);
    const found = await readDatabaseSemanticOperation({
      authority: input.authority,
      operationId: input.operationId,
    });
    expect(found.value!.result).toEqual(result.value);
    expect(await publishDatabaseSemanticGeneration(input)).toEqual({ ...result, replayed: true });
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });

  it('distinguishes genuine absence from another original action', async () => {
    const { f, input } = await published();
    expect(
      (await readDatabaseSemanticOperation({ authority: f.authority, operationId: uuidv7() })).value
    ).toBeNull();
    const db = new f.Database(f.file, { readonly: true });
    const original = db
      .prepare("SELECT operation_id FROM operations WHERE operation_kind='review.create'")
      .get() as { operation_id: string };
    db.close();
    await expect(
      readDatabaseSemanticOperation({ authority: f.authority, operationId: original.operation_id })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      (
        await readDatabaseSemanticOperation({
          authority: f.authority,
          operationId: input.operationId,
        })
      ).value
    ).not.toBeNull();
  });

  it('refuses a missing receipt still owned by retained semantic rows', async () => {
    const { f, input } = await published();
    alterReceipt(f, (db) => {
      db.prepare('DELETE FROM operations WHERE operation_id=?').run(input.operationId);
    });
    const before = snapshot(f.Database, f.file);
    await expect(
      readDatabaseSemanticOperation({ authority: f.authority, operationId: input.operationId })
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });

  it('refuses corrupted original receipt bytes without repairing them', async () => {
    const { f, input } = await published();
    alterReceipt(f, (db) => {
      db.prepare("UPDATE operations SET payload_json='{}' WHERE operation_id=?").run(
        input.operationId
      );
    });
    const before = snapshot(f.Database, f.file);
    await expect(
      readDatabaseSemanticOperation({ authority: f.authority, operationId: input.operationId })
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(snapshot(f.Database, f.file)).toEqual(before);
  });
});
