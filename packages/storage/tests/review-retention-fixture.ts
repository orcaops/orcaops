import Database from 'better-sqlite3';

import { restoreFixture, snapshot } from './database-fixture.mjs';
export const reviewRetentionFixtureRoots: string[] = [];
export async function reviewRetentionFixture() {
  const restored = await restoreFixture(
    new URL('../../../', import.meta.url).pathname,
    new URL('../src/history/database/fixtures/pending-review.json', import.meta.url).pathname
  );
  reviewRetentionFixtureRoots.push(restored.temporary);
  return restored;
}
export function reviewRetentionSnapshot(file: string) {
  const { definitions, ...rest } = snapshot(Database, file);
  return { ...rest, schema: definitions };
}
