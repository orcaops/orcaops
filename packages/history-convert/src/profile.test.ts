import { describe, expect, it } from 'vitest';

import {
  assertLegacySchemaVersion,
  LEGACY_PRODUCER_VERSION,
  LEGACY_SOURCE_REVISION,
  validateLegacyProducer,
} from './profile.js';

describe('legacy producer evidence', () => {
  it('keeps absent producer evidence unknown', () => {
    expect(validateLegacyProducer()).toEqual({
      version: null,
      sourceRevision: null,
      evidence: 'unknown',
    });
  });

  it('preserves recorded fields without inventing missing release provenance', () => {
    expect(validateLegacyProducer({ sourceRevision: LEGACY_SOURCE_REVISION })).toEqual({
      version: null,
      sourceRevision: LEGACY_SOURCE_REVISION,
      evidence: 'recorded',
    });
    expect(validateLegacyProducer({ version: LEGACY_PRODUCER_VERSION })).toEqual({
      version: LEGACY_PRODUCER_VERSION,
      sourceRevision: null,
      evidence: 'recorded',
    });
  });

  it.each(['0.1.0', '0.2.0-rc.1', '0.2.0', '0.3.0', '', null])(
    'rejects a recorded producer outside the frozen profile: %s',
    (version) => {
      expect(() => validateLegacyProducer({ version })).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_SOURCE_PROFILE' })
      );
    }
  );

  it('rejects contradictory source revision even with the supported version', () => {
    expect(() =>
      validateLegacyProducer({ version: LEGACY_PRODUCER_VERSION, sourceRevision: '0'.repeat(40) })
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SOURCE_PROFILE' }));
  });
});

describe('legacy resource version preconditions', () => {
  it('accepts only the explicitly supported SQLite and configuration versions', () => {
    for (const version of [20, 22, 23, 24, 25])
      expect(() => assertLegacySchemaVersion('sqlite_baseline', version)).not.toThrow();
    for (const version of [19, 21, 26])
      expect(() => assertLegacySchemaVersion('sqlite_baseline', version)).toThrow();
    for (const version of [4, 5, 6])
      expect(() => assertLegacySchemaVersion('config', version)).not.toThrow();
    expect(() => assertLegacySchemaVersion('config', 3)).toThrow();
  });

  it('accepts both journal representations read by the pinned producer', () => {
    for (const version of [1, 2])
      expect(() => assertLegacySchemaVersion('seed_journal', version)).not.toThrow();
    expect(() => assertLegacySchemaVersion('seed_journal', 3)).toThrow();
  });

  it('rejects unknown resource kinds and nonnumeric version coercion', () => {
    for (const [kind, version] of [
      ['future_resource', 1],
      ['plan', '4'],
      ['toString', 1],
    ])
      expect(() => assertLegacySchemaVersion(String(kind), version)).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_RESOURCE_SCHEMA' })
      );
  });
});
