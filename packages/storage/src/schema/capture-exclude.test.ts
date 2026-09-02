import { describe, expect, it } from 'vitest';

import { resolveCaptureExcludes, selectExcludedPaths } from './capture-exclude.js';
import {
  assertConfigVersionCurrent,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CAPTURE_EXCLUDE,
  resolveConfig,
} from './config.js';

describe('capture.exclude resolution', () => {
  it('applies the built-in set with no configuration', () => {
    const { patterns } = resolveCaptureExcludes({ exclude: [], exclude_builtins: true });
    expect(patterns).toEqual([...DEFAULT_CAPTURE_EXCLUDE]);
  });

  it('adds repo patterns without displacing the built-ins', () => {
    const { patterns } = resolveCaptureExcludes({
      exclude: ['**/*.secret'],
      exclude_builtins: true,
    });
    expect(patterns).toContain('**/.env');
    expect(patterns).toContain('**/*.secret');
  });

  it('drops an unusable pattern rather than throwing, and reports it', () => {
    // The schema's min(1) blocks this via config; the guard exists for a
    // programmatic caller, and snapshot capture is fail-open by contract.
    const { patterns, invalid } = resolveCaptureExcludes({
      exclude: ['**/*.secret', ''],
      exclude_builtins: true,
    });
    expect(invalid).toEqual(['']);
    expect(patterns).toContain('**/*.secret');
  });

  it('honours the built-in opt-out', () => {
    const { patterns } = resolveCaptureExcludes({
      exclude: ['**/*.secret'],
      exclude_builtins: false,
    });
    expect(patterns).toEqual(['**/*.secret']);
  });
});

describe('selectExcludedPaths', () => {
  const { patterns } = resolveCaptureExcludes({ exclude: [], exclude_builtins: true });

  it('selects credential files at any depth and leaves ordinary source alone', () => {
    expect(
      selectExcludedPaths(
        ['.env', 'packages/app/.env.local', 'src/index.ts', 'keys/id_rsa', 'README.md'],
        patterns
      )
    ).toEqual(['.env', 'keys/id_rsa', 'packages/app/.env.local']);
  });

  it('selects .env.example too — a documented consequence of matching .env.*', () => {
    expect(selectExcludedPaths(['.env.example'], patterns)).toEqual(['.env.example']);
  });

  it('selects nothing when no pattern is in effect', () => {
    expect(selectExcludedPaths(['.env'], [])).toEqual([]);
  });
});

describe('config schema version', () => {
  it('accepts the current version', () => {
    expect(() =>
      assertConfigVersionCurrent({ schema_version: CONFIG_SCHEMA_VERSION })
    ).not.toThrow();
  });

  it('accepts a v5 config, whose only delta is a fully-defaulted block', () => {
    expect(() => assertConfigVersionCurrent({ schema_version: 5 })).not.toThrow();
  });

  it('loads a v5 config to the current shape, capture defaults included', () => {
    const loaded = resolveConfig({ schema_version: 5 });
    expect(loaded.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(loaded.capture).toEqual({ exclude: [], exclude_builtins: true });
  });

  it('still refuses a version ahead of this build', () => {
    expect(() => assertConfigVersionCurrent({ schema_version: 99 })).toThrow(/Upgrade orcaops/);
  });

  it('still refuses a stringified version rather than coercing it', () => {
    expect(() => assertConfigVersionCurrent({ schema_version: '6' })).toThrow(/must be the number/);
  });

  it('still refuses a version below the accepted predecessor', () => {
    expect(() => assertConfigVersionCurrent({ schema_version: 4 })).toThrow(/requires/);
  });
});
