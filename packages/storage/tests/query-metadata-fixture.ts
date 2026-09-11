import Database from 'better-sqlite3';

import { restoreFixture, snapshot } from './database-fixture.mjs';
export const queryFixtureRoots: string[] = [];
export async function queryFixture() {
  const restored = await restoreFixture(
    new URL('../../../', import.meta.url).pathname,
    new URL('../src/history/database/fixtures/pending-review.json', import.meta.url).pathname
  );
  queryFixtureRoots.push(restored.temporary);
  return restored;
}
export function querySnapshot(file: string) {
  const { definitions, ...rest } = snapshot(Database, file);
  return { ...rest, schema: definitions };
}
