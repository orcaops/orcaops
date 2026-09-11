import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { openProjectDatabase } from './connection.js';
import { validateProjectSchema } from './schema-validation.js';
import { PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import {
  type RestoredFixture,
  restoreFixture,
  snapshot,
} from '../../../tests/database-fixture.mjs';
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
it('uses the fixed receipt indexes for the existing absence predicates', async () => {
  const f = await fixture();
  const db = new Database(f.file, { readonly: true, fileMustExist: true });
  try {
    validateProjectSchema(db, PROJECT_DATABASE_SCHEMA_VERSION);
    const controls = [
      [
        "SELECT 1 FROM operations WHERE operation_kind='review.semantic.submit' LIMIT 1",
        [],
        'operations_(artifact_target_lookup|review_scope)',
      ],
      [
        "SELECT 1 FROM operations WHERE operation_kind='review.semantic.submit' AND json_extract(target_json,'$.reviewId')=? AND json_extract(target_json,'$.runId')=? LIMIT 1",
        ['review', 'run'],
        'operations_review_scope',
      ],
      [
        "SELECT 1 FROM operations WHERE operation_kind='review.create' AND json_extract(target_json,'$.reviewId')=? LIMIT 1",
        ['review'],
        'operations_review_scope',
      ],
      [
        "SELECT operation_id FROM operations WHERE operation_kind='source_plan.record' AND json_extract(target_json,'$.namespaceId')=? AND json_extract(target_json,'$.kind')=? AND json_extract(target_json,'$.subjectId')=? AND (? <> 'approved' OR json_extract(target_json,'$.approvedVersion')=?) LIMIT 1",
        ['namespace', 'approved', 'subject', 'approved', 1],
        'operations_source_plan_record_scope',
      ],
      [
        "SELECT operation_id FROM operations WHERE operation_kind='source_plan.locator' AND json_extract(target_json,'$.namespaceId')=? AND json_extract(target_json,'$.kind')=? AND json_extract(target_json,'$.realPath')=? LIMIT 1",
        ['namespace', 'path', '/original'],
        'operations_source_plan_locator_scope',
      ],
    ] as const;
    for (const [sql, parameters, index] of controls) {
      const rows = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters) as {
        detail: string;
      }[];
      expect(rows.map((r) => r.detail).join('\n')).toMatch(new RegExp(index));
      expect(rows.map((r) => r.detail).join('\n')).not.toMatch(/SCAN operations/);
    }
  } finally {
    db.close();
  }
});

it('does not repair a missing required receipt index during an ordinary read', async () => {
  const f = await fixture();
  const db = new Database(f.file);
  db.exec('DROP INDEX operations_review_scope');
  db.close();
  const before = snapshot(Database, f.file);
  await expect(
    openProjectDatabase({ authority: f.authority, mode: 'reader' })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(snapshot(Database, f.file)).toEqual(before);
});
