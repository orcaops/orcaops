import { createHash } from 'node:crypto';

import type { PullCacheRecord } from '@orcaops/storage';

/**
 * Shared pull-cache fixture for source-plan tests: one typed builder so
 * a `PullCacheRecord` schema change is a single compile error here
 * rather than a hand-edit hunt across test files (the CLI e2e and the
 * resolver unit tests both seed the same record shape). `content_hash`
 * tracks `body` unless explicitly overridden.
 */
export function cloudRecord(over: Partial<PullCacheRecord> = {}): PullCacheRecord {
  const body = over.body ?? '# Cloud Plan\n\nbody';
  return {
    schema_version: 1,
    external_id: 'ext-1',
    slug: 'cloud-plan',
    version_number: 3,
    title: 'Cloud Plan',
    body,
    content_hash: createHash('sha256').update(body, 'utf8').digest('hex'),
    source_ref: null,
    base_url: 'https://cloud.example',
    org_id: 'org_1',
    pulled_at: '2026-06-08T00:00:00.000Z',
    ...over,
  };
}
