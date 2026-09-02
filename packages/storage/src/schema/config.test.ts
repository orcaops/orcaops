import { describe, expect, it } from 'vitest';

import {
  assertConfigVersionCurrent,
  CONFIG_SCHEMA_VERSION,
  getDefaultConfig,
  resolveConfig,
} from './config.js';
import { ConfigValidationError } from './validation.js';

describe('config schema — naming / bootstrap / workflow + install fields', () => {
  it('getDefaultConfig includes the naming / bootstrap / workflow / install defaults', () => {
    const c = getDefaultConfig();
    expect(c.naming.prefix).toBe('orcaops');
    expect(c.bootstrap).toBe('managed');
    expect(c.workflow.hints).toEqual({ keys: [], custom: [] });
    expect(c.install.agents).toEqual(['claude-code']);
    expect(c.generated_files).toBe('commit');
    expect(c.review.include_untracked).toEqual([]);
    expect(c.review.stub_paths).toEqual([]);
  });

  it('review.stub_paths defaults empty, accepts a glob array, rejects non-strings', () => {
    expect(getDefaultConfig().review.stub_paths).toEqual([]);
    const c = resolveConfig({ review: { stub_paths: ['fixtures/**', 'db/migrations/*.sql'] } });
    expect(c.review.stub_paths).toEqual(['fixtures/**', 'db/migrations/*.sql']);
    // Empty strings pass the permissive schema (rejected LOUDLY at routine-start
    // instead), but a non-string is a config-parse error.
    expect(resolveConfig({ review: { stub_paths: [''] } }).review.stub_paths).toEqual(['']);
    expect(() => resolveConfig({ review: { stub_paths: [42] } })).toThrow();
  });

  it('resolveConfig fills the additive fields for a partial config (default-merge)', () => {
    // naming / bootstrap / workflow are additive — filled by the default-merge.
    // schema_version comes from DEFAULT_CONFIG; an on-disk config must already
    // carry the current version (assertConfigVersionCurrent gates the load).
    const c = resolveConfig({ generated_files: 'ignore' });
    expect(c.naming.prefix).toBe('orcaops');
    expect(c.bootstrap).toBe('managed');
    expect(c.workflow.hints).toEqual({ keys: [], custom: [] });
    expect(c.schema_version).toBe(6);
    expect(c.review.include_untracked).toEqual([]);
  });

  it('accepts a custom prefix, manual bootstrap, and selected + custom hints', () => {
    const c = resolveConfig({
      naming: { prefix: 'oo' },
      bootstrap: 'manual',
      workflow: { hints: { keys: ['commit-on-checkpoint-close'], custom: ['Run pnpm -r test.'] } },
    });
    expect(c.naming.prefix).toBe('oo');
    expect(c.bootstrap).toBe('manual');
    expect(c.workflow.hints.keys).toEqual(['commit-on-checkpoint-close']);
    expect(c.workflow.hints.custom).toEqual(['Run pnpm -r test.']);
  });

  it('rejects a non lowercase / hyphen-safe prefix', () => {
    for (const bad of ['Oo', '-x', 'x--y', 'x-', '1x']) {
      expect(() => resolveConfig({ naming: { prefix: bad } }), bad).toThrow();
    }
  });

  it('rejects an unknown curated hint key', () => {
    expect(() => resolveConfig({ workflow: { hints: { keys: ['nope'], custom: [] } } })).toThrow();
  });

  it('is at config schema version 6 (capture exclude set)', () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(6);
  });

  it('assertConfigVersionCurrent: exactly the number 6 passes', () => {
    expect(() => assertConfigVersionCurrent({ schema_version: 6 })).not.toThrow();
  });

  it('accepts version 5, whose only delta is a fully-defaulted block', () => {
    expect(() => assertConfigVersionCurrent({ schema_version: 5 })).not.toThrow();
  });

  it('rejects non-current versions with regeneration guidance', () => {
    for (const v of [1, 2, 3, 4]) {
      expect(() => assertConfigVersionCurrent({ schema_version: v })).toThrow(
        /requires 6.*orcaops init --force --reset-config/s
      );
    }
    expect(() => assertConfigVersionCurrent({})).toThrow(/missing.*requires 6/s);
  });

  it('rejects a STRINGIFIED version naming the type error instead of coercing', () => {
    expect(() => assertConfigVersionCurrent({ schema_version: '6' })).toThrow(
      /number 6.*string "6".*--reset-config/s
    );
  });

  it('keeps the newer-orcaops message for a version ahead of this build', () => {
    expect(() => assertConfigVersionCurrent({ schema_version: 7 })).toThrow(/Upgrade orcaops/);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the reserved unknown root key %s without prototype pollution',
    (key) => {
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      const raw = JSON.parse(`{"${key}":{"polluted":"yes"}}`);
      let error: unknown;
      try {
        resolveConfig(raw);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({ code: 'INVALID_CONFIG', path: key });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  );
});

describe('config schema — skills block', () => {
  it('defaults to an empty override map through default merging', () => {
    expect(getDefaultConfig().skills).toEqual({ enabled: {} });
    // An omitted `skills` key resolves through the same default merge as `install`.
    expect(resolveConfig({}).skills).toEqual({ enabled: {} });
  });

  it('accepts per-id boolean overrides from the current skill catalog', () => {
    const c = resolveConfig({
      skills: { enabled: { digest: false, recap: true, seed: false, 'seed-discovery': true } },
    });
    expect(c.skills.enabled).toEqual({
      digest: false,
      recap: true,
      seed: false,
      'seed-discovery': true,
    });
  });

  it('rejects unknown skill ids with the full config path', () => {
    expect(() => resolveConfig({ skills: { enabled: { 'future-skill': true } } })).toThrowError(
      expect.objectContaining({ path: 'skills.enabled.future-skill' })
    );
  });

  it('rejects non-boolean override values', () => {
    expect(() => resolveConfig({ skills: { enabled: { digest: 'off' } } })).toThrow();
  });
});

describe('config schema — closed nested sections', () => {
  it.each([
    ['install.extra', { install: { extra: true } }],
    ['llm.extra', { llm: { extra: true } }],
    ['llm.json_mode', { llm: { json_mode: 'auto' } }],
    ['llm.default_session_max_cost_usd', { llm: { default_session_max_cost_usd: 2 } }],
    [
      'llm.session',
      {
        llm: {
          session: {
            persist: false,
            max_age_minutes: 120,
            invalidate_on_model_change: true,
          },
        },
      },
    ],
    ['artifacts.extra', { artifacts: { extra: true } }],
    ['cache.extra', { cache: { extra: true } }],
    ['evaluators.extra', { evaluators: { extra: true } }],
    ['digest.extra', { digest: { extra: true } }],
    ['gc.extra', { gc: { extra: true } }],
    ['diff_fingerprint.extra', { diff_fingerprint: { extra: true } }],
    ['review.extra', { review: { extra: true } }],
    ['archive.extra', { archive: { extra: true } }],
    ['skills.extra', { skills: { extra: true } }],
    ['naming.extra', { naming: { extra: true } }],
    ['workflow.extra', { workflow: { extra: true } }],
    ['workflow.hints.extra', { workflow: { hints: { extra: true } } }],
  ])('rejects %s', (path, partial) => {
    expect(() => resolveConfig(partial)).toThrowError(expect.objectContaining({ path }));
  });

  it('round-trips the complete current config', () => {
    const current = getDefaultConfig();
    expect(resolveConfig(current)).toEqual(current);
  });
});

describe('config schema — archive block', () => {
  it('defaults an omitted archive block to durable mirroring with fidelity', () => {
    const c = resolveConfig({});
    expect(c.archive).toEqual({ enabled: true, redact_secrets: false });
    expect(c.schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('accepts explicit overrides', () => {
    const c = resolveConfig({ archive: { enabled: true, redact_secrets: true } });
    expect(c.archive).toEqual({ enabled: true, redact_secrets: true });
  });

  it('rejects non-boolean values', () => {
    expect(() => resolveConfig({ archive: { enabled: 'yes' } })).toThrow();
  });

  it('getDefaultConfig carries the block', () => {
    expect(getDefaultConfig().archive).toEqual({ enabled: true, redact_secrets: false });
  });
});

describe('config schema — project-local Watch preferences', () => {
  it('rejects an unknown root key instead of silently stripping it', () => {
    expect(() => resolveConfig({ watch: { theme: 'ayu-dark' } })).toThrow(/Unrecognized key/);
  });
});

describe('config schema — session hooks block', () => {
  it('defaults to disabled static project entries', () => {
    expect(resolveConfig({}).session_hooks).toEqual({
      enabled: false,
      payload: 'static',
      entries: 'project',
    });
    expect(getDefaultConfig().session_hooks).toEqual({
      enabled: false,
      payload: 'static',
      entries: 'project',
    });
  });

  it('accepts explicit overrides', () => {
    const c = resolveConfig({
      session_hooks: { enabled: true, payload: 'state-aware', entries: 'none' },
    });
    expect(c.session_hooks).toEqual({ enabled: true, payload: 'state-aware', entries: 'none' });
  });

  it('rejects an unknown key inside session_hooks instead of silently stripping it', () => {
    expect(() => resolveConfig({ session_hooks: { enabled: true, mode: 'eager' } })).toThrow(
      /Unrecognized key/
    );
  });

  it('rejects values outside the payload and entries enums', () => {
    expect(() => resolveConfig({ session_hooks: { payload: 'dynamic' } })).toThrow();
    expect(() => resolveConfig({ session_hooks: { entries: 'machine' } })).toThrow();
  });
});

describe('config schema — storage path containment', () => {
  it('accepts the default repo-relative paths', () => {
    const c = resolveConfig({});
    expect(c.artifacts.path).toBeTruthy();
    expect(c.cache.path).toBeTruthy();
  });

  it.each([
    ['absolute artifacts.path', { artifacts: { path: '/tmp/evil', gitignore: false } }],
    ['escaping artifacts.path', { artifacts: { path: '../outside', gitignore: false } }],
    ['normalized-escape artifacts.path', { artifacts: { path: 'a/../../b', gitignore: false } }],
    ['absolute cache.path', { cache: { path: '/tmp/evil.db' } }],
    ['escaping cache.path', { cache: { path: '../../x.db' } }],
  ])('refuses %s with a clear error', (_label, overrides) => {
    expect(() => resolveConfig(overrides as Record<string, unknown>)).toThrow(
      /inside the repository/
    );
  });
});
