import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import {
  artifactActivityPredicate,
  ArtifactActivitySchema,
  prepareArtifactActivity,
} from './query-activity.js';
import { registerQueryFunctions } from './query-functions.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
const ts = (day: number) => `2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const original = {
  plan: { started_at: ts(1) },
  summary: { ts: ts(12) },
  checkpoints: [
    { status: 'closed' as const, opened_at: ts(2), closed_at: ts(3) },
    { status: 'abandoned' as const, opened_at: ts(5), abandoned_at: ts(6) },
    { status: 'open' as const, opened_at: ts(9) },
  ],
};
function matches(
  activity: ReturnType<typeof prepareArtifactActivity>,
  lower?: number,
  upper?: number
) {
  const db = new Database(':memory:');
  databases.push(db);
  registerQueryFunctions(db);
  db.exec(
    'CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY); CREATE TABLE artifact_query_metadata(artifact_id TEXT PRIMARY KEY,details_json TEXT);'
  );
  db.prepare('INSERT INTO artifacts VALUES (?)').run('artifact');
  db.prepare('INSERT INTO artifact_query_metadata VALUES (?,?)').run(
    'artifact',
    JSON.stringify({ activity })
  );
  const predicate = artifactActivityPredicate(
    lower === undefined ? undefined : Date.parse(ts(lower)),
    upper === undefined ? undefined : Date.parse(ts(upper))
  );
  return (
    db
      .prepare(`SELECT artifact_id FROM artifacts a WHERE ${predicate?.sql ?? '1'}`)
      .all(...(predicate?.parameters ?? [])).length === 1
  );
}
it.each([
  [1, 1, true],
  [2, 2, true],
  [3, 3, true],
  [4, 4, false],
  [5, 6, true],
  [7, 8, false],
  [10, 11, true],
  [13, undefined, true],
  [undefined, 1, true],
] as const)(
  'matches exact original activity window %s through %s as %s',
  (lower, upper, expected) => {
    expect(matches(prepareArtifactActivity(original), lower, upper)).toBe(expected);
  }
);
it('keeps a plan without checkpoints and a summary as point activity', () => {
  const activity = prepareArtifactActivity({ ...original, checkpoints: [] });
  expect(matches(activity, 1, 1)).toBe(true);
  expect(matches(activity, 12, 12)).toBe(true);
  expect(matches(activity, 2, 11)).toBe(false);
  expect(matches(activity, 13)).toBe(false);
});
it('copies complete current intervals without a bounded event preview', () => {
  const source = structuredClone(original);
  source.checkpoints = Array.from({ length: 300 }, () => ({ ...source.checkpoints[0] }));
  const prepared = prepareArtifactActivity(source);
  expect(prepared.checkpoints).toHaveLength(300);
  source.checkpoints[0].opened_at = ts(20);
  expect(prepared.checkpoints[0].openedAt).toBe(ts(2));
  expect(ArtifactActivitySchema.safeParse({ ...prepared, summaryAt: 'invalid' }).success).toBe(
    false
  );
});
it('uses only the supplied current interval without retaining a prior terminal shape', () => {
  const old = prepareArtifactActivity({
    ...original,
    summary: null,
    checkpoints: [original.checkpoints[0]],
  });
  const current = prepareArtifactActivity({
    ...original,
    summary: null,
    checkpoints: [{ status: 'open', opened_at: ts(9) }],
  });
  expect(matches(old, 2, 3)).toBe(true);
  expect(matches(current, 2, 3)).toBe(false);
  expect(matches(current, 10)).toBe(true);
});
