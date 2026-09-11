import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '@orcaops/storage';
import { type ProjectDatabase, queryProjectArtifacts } from '@orcaops/storage/history/database';

import { authoritySchema, text, validate, withReviewDatabase } from './request.js';

const requestSchema = z.strictObject({
  authority: authoritySchema,
  branch: text.refine((value) => value.trim().length > 0 && !/[\0\r\n]/u.test(value)),
});
export type ReadDatabaseReviewSourceVersions = z.infer<typeof requestSchema>;

export async function readDatabaseReviewSourceVersions(raw: ReadDatabaseReviewSourceVersions) {
  const input = validate(requestSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    observeDatabaseReviewSourceVersions(database, input.branch)
  );
}

export function observeDatabaseReviewSourceVersions(database: ProjectDatabase, branch: string) {
  const selected = queryProjectArtifacts(database, { profile: 'versions' });
  const artifacts = selected.rows
    .map((row) => ({
      artifactId: row.artifactId,
      state: row.state,
      branch: row.branch,
      generation: row.generation,
      orderedHash: row.orderedHash,
      eventCount: row.eventCount,
      byteLength: row.byteLength,
      tailEventId: row.tailEventId,
      executionVersion: row.executionVersion,
      bindingGeneration: row.bindingGeneration,
    }))
    .sort((left, right) =>
      left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0
    );
  const value = { authority: { ...database.authority }, branch, artifacts };
  return {
    value,
    digest: createHash('sha256').update(canonicalJson(value)).digest('hex'),
    counters: selected.counters,
    sourceObservation: 'metadata-only' as const,
  };
}
