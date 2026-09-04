import { describe, expect, it } from 'vitest';

import { SchemaAheadError, UnsupportedSchemaVersionError } from '@orcaops/storage';

import {
  parseSidecarSchemaError,
  ReviewCacheBehindError,
  ReviewSidecarSchemaError,
  serializeSidecarSchemaError,
} from './sidecarError.js';

describe('Watch sidecar schema errors', () => {
  it('round-trips an older cache as a typed recoverable error', () => {
    const line = serializeSidecarSchemaError(new UnsupportedSchemaVersionError('23', 24));
    const parsed = parseSidecarSchemaError(`diagnostic before failure\n${line}`);

    expect(parsed).toBeInstanceOf(ReviewCacheBehindError);
    expect(parsed).toMatchObject({
      code: 'CACHE_BEHIND',
      cacheVersion: 23,
      currentVersion: 24,
    });
  });

  it('keeps schema-ahead distinct from the recoverable path', () => {
    const line = serializeSidecarSchemaError(new SchemaAheadError(25, 24));
    const parsed = parseSidecarSchemaError(line ?? '');

    expect(parsed).toBeInstanceOf(ReviewSidecarSchemaError);
    expect(parsed).not.toBeInstanceOf(ReviewCacheBehindError);
    expect(parsed).toMatchObject({ code: 'SCHEMA_AHEAD', cacheVersion: 25, currentVersion: 24 });
  });

  it('does not classify malformed or missing versions as cache-behind', () => {
    for (const version of [null, 'legacy']) {
      const line = serializeSidecarSchemaError(new UnsupportedSchemaVersionError(version, 24));
      expect(parseSidecarSchemaError(line ?? '')).toMatchObject({ code: 'CACHE_UNSUPPORTED' });
    }
  });

  it('ignores unstructured stderr', () => {
    expect(parseSidecarSchemaError('Error: ordinary sidecar failure')).toBeNull();
  });
});
