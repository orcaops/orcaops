import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { openProjectDatabase } from './connection.js';
import { validateProjectSchema } from './schema-validation.js';
import { PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { runProjectOperation } from './transactions.js';
import {
  type RestoredFixture,
  restoreFixture,
  snapshot,
} from '../../../tests/database-fixture.mjs';
import { uuidv7 } from '../../ids/uuidv7.js';
const opened: RestoredFixture[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((f) => f.cleanup()));
});
async function fixture() {
  const restored = await restoreFixture(
    new URL('../../../../../', import.meta.url).pathname,
    new URL('./fixtures/current.json', import.meta.url).pathname
  );
  opened.push(restored);
  return restored;
}
it('uses the fixed artifact and semantic operation indexes without forcing query plans', async () => {
  const f = await fixture();
  const db = new Database(f.file);
  try {
    validateProjectSchema(db, PROJECT_DATABASE_SCHEMA_VERSION);
    const artifact = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT o.operation_id FROM operations o
      WHERE o.operation_kind='lifecycle.publish' AND json_extract(o.target_json,'$.artifactId')=?
      AND NOT EXISTS (SELECT 1 FROM artifact_lifecycle_revisions r WHERE r.publication_operation_id=o.operation_id AND r.artifact_id=?)`
      )
      .all('artifact', 'artifact');
    expect(JSON.stringify(artifact)).toContain('operations_artifact_target_lookup');
    const semantic = db
      .prepare(
        `EXPLAIN QUERY PLAN
      SELECT 1 FROM review_semantic_generations WHERE created_operation_id=?
      UNION ALL SELECT 1 FROM review_semantic_attempts WHERE operation_id=?
      UNION ALL SELECT 1 FROM review_semantic_terminals WHERE operation_id=?
      UNION ALL SELECT 1 FROM review_semantic_current WHERE operation_id=? LIMIT 1`
      )
      .all('original', 'original', 'original', 'original');
    for (const table of ['generations', 'attempts', 'terminals', 'current'])
      expect(JSON.stringify(semantic)).toContain(`review_semantic_${table}_operation`);
  } finally {
    db.close();
  }
});
it.each(['lifecycle.publish', 'remote.request', 'artifact.push.complete'])(
  'refuses %s consuming a pending push terminal ID with a typed rollback',
  async (kind) => {
    const f = await fixture();
    const handle = await openProjectDatabase({ authority: f.authority, mode: 'writer' });
    const terminal = uuidv7(),
      admission = uuidv7(),
      push = uuidv7();
    try {
      const artifact = f.saved.rows.artifact_revisions[0];
      // A real operation installs a constrained header; the fixed push admission writer is a later gate.
      await runProjectOperation(
        handle,
        {
          operationId: admission,
          kind: 'constraint.fixture',
          target: {},
          payload: {},
          expectedState: {},
          intentChange: false,
        },
        (tx) => {
          tx.run(
            `INSERT INTO artifact_push_requests (push_id,admission_operation_id,terminal_operation_id,
        artifact_id,server_url,org_id,account_id,artifact_generation,cloud_acknowledgement_id,
        prepared_at,result_checkpoints,result_summary,result_evaluators,request_sha256,call_count,artifact_payload_hash)
        VALUES (?,?,?,?,'https://example.test','org','account',?,?,'original preparation',0,0,0,?,2,?)`,
            push,
            admission,
            terminal,
            artifact.artifact_id,
            artifact.generation,
            uuidv7(),
            'a'.repeat(64),
            'b'.repeat(64)
          );
          return { push };
        }
      );
      const before = snapshot(Database, f.file);
      await expect(
        runProjectOperation(
          handle,
          {
            operationId: terminal,
            kind,
            target: {},
            payload: {},
            expectedState: {},
            intentChange: true,
          },
          () => ({ consumed: true })
        )
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(snapshot(Database, f.file)).toEqual(before);
    } finally {
      handle.close();
    }
  }
);

it.each([
  'operations_artifact_target_lookup',
  'remote_requests_group_owner',
  'session_branch_current',
])('refuses ordinary access when the installed %s definition disappears', async (name) => {
  const f = await fixture();
  const db = new Database(f.file);
  const row = db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(name) as {
    type: string;
  };
  db.exec(`DROP ${row.type} ${name}`);
  db.close();
  const before = snapshot(Database, f.file);
  for (const mode of ['reader', 'writer'] as const)
    await expect(openProjectDatabase({ authority: f.authority, mode })).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
  expect(snapshot(Database, f.file)).toEqual(before);
});
