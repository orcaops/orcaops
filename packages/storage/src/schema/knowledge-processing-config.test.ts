import { describe, expect, it } from 'vitest';

import {
  CONFIG_SCHEMA_VERSION,
  ConfigSchema,
  configVersionForWrite,
  FRESH_CONFIG_FILE_VERSION,
  getDefaultConfig,
  KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS,
  KNOWLEDGE_PROCESSING_TOOL_ACCESS_CONFIG_VERSION,
  resolveConfig,
} from './config.js';
import { ConfigValidationError } from './validation.js';

const DEFAULTS = {
  enabled: false,
  tool_access: 'none',
  provider: 'inherit',
  model: 'inherit',
  effort: 'inherit',
  timeout_ms: 300_000,
  max_attempts: 3,
  max_calls_per_hour: 60,
  max_input_bytes: 131_072,
  max_output_bytes: 65_536,
  max_cost_usd_per_call: 'inherit',
  idle_exit_ms: 30_000,
};

function section(values: Record<string, unknown>): Record<string, unknown> {
  return { knowledge_processing: values };
}

function validationError(partial: unknown): ConfigValidationError {
  try {
    resolveConfig(partial);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error('expected the configuration to be refused');
}

describe('knowledge_processing defaults', () => {
  it('preserves an explicitly configured shorter timeout', () => {
    expect(resolveConfig(section({ timeout_ms: 120_000 })).knowledge_processing.timeout_ms).toBe(
      120_000
    );
  });

  it('is off, inherits the llm settings, and leaves the optional limits absent', () => {
    const processing = getDefaultConfig().knowledge_processing;
    expect(processing).toEqual(DEFAULTS);
    expect(processing).not.toHaveProperty('max_output_tokens');
    expect(processing).not.toHaveProperty('max_cost_usd_per_day');
  });

  it('declares the same default on every field as the default config carries', () => {
    const { knowledge_processing: _section, ...withoutSection } = getDefaultConfig();
    const fromFieldDefaults = ConfigSchema.parse({ ...withoutSection, knowledge_processing: {} });
    const fromSectionDefault = ConfigSchema.parse(withoutSection);
    expect(fromFieldDefaults.knowledge_processing).toEqual(DEFAULTS);
    expect(fromSectionDefault.knowledge_processing).toEqual(DEFAULTS);
  });

  it('has no concurrency setting', () => {
    expect(Object.keys(getDefaultConfig().knowledge_processing)).not.toContain('max_concurrent');
  });

  it('fills every unset leaf of a partial section', () => {
    const processing = resolveConfig(section({ enabled: true, max_attempts: 2 }));
    expect(processing.knowledge_processing).toEqual({
      ...DEFAULTS,
      enabled: true,
      max_attempts: 2,
    });
  });

  it.each([5, 6, 7, CONFIG_SCHEMA_VERSION])(
    'loads a version %i document without the section as off with every default',
    (version) => {
      const loaded = resolveConfig({ schema_version: version, install: { agents: ['codex'] } });
      expect(loaded.schema_version).toBe(CONFIG_SCHEMA_VERSION);
      expect(loaded.knowledge_processing).toEqual(DEFAULTS);
    }
  );

  it('does not hand out the shared default object', () => {
    const first = resolveConfig({});
    first.knowledge_processing.enabled = true;
    expect(resolveConfig({}).knowledge_processing.enabled).toBe(false);
    expect(getDefaultConfig().knowledge_processing.enabled).toBe(false);
  });
});

describe('knowledge_processing accepted values', () => {
  it.each([
    ['provider', 'inherit'],
    ['provider', 'claude'],
    ['provider', 'codex'],
    ['tool_access', 'none'],
    ['tool_access', 'codex_restricted'],
    ['model', 'inherit'],
    ['model', 'claude-sonnet-4-6'],
    ['model', 'auto-router-large'],
    ['effort', 'inherit'],
    ['effort', 'low'],
    ['effort', 'max'],
    ['timeout_ms', KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS],
    ['timeout_ms', 3_600_000],
    ['max_attempts', 1],
    ['max_attempts', 10],
    ['max_calls_per_hour', 1],
    ['max_calls_per_hour', 3_600],
    ['max_input_bytes', 1_024],
    ['max_input_bytes', 8_388_608],
    ['max_output_bytes', 1_024],
    ['max_output_bytes', 8_388_608],
    ['max_output_tokens', 1],
    ['max_output_tokens', 1_000_000],
    ['max_cost_usd_per_call', 'inherit'],
    ['max_cost_usd_per_call', 'none'],
    ['max_cost_usd_per_call', 0.25],
    ['max_cost_usd_per_day', 5],
    ['idle_exit_ms', 1_000],
    ['idle_exit_ms', 3_600_000],
  ])('accepts %s = %j', (key, value) => {
    const processing = resolveConfig(section({ [key]: value })).knowledge_processing;
    expect(processing[key as keyof typeof processing]).toBe(value);
  });
});

describe('knowledge_processing refused values', () => {
  it.each([
    ['enabled', 'yes'],
    ['provider', 'auto'],
    ['provider', 'none'],
    ['provider', 'gemini'],
    ['tool_access', 'restricted'],
    ['tool_access', 'codex'],
    ['model', ''],
    ['model', ' claude-sonnet-4-6'],
    ['model', 'claude-sonnet-4-6\n'],
    ['model', 7],
    ['effort', 'extreme'],
    ['timeout_ms', 0],
    ['timeout_ms', 120],
    ['timeout_ms', 1_600],
    ['timeout_ms', KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS - 1],
    ['timeout_ms', 120_000.5],
    ['timeout_ms', 3_600_001],
    ['timeout_ms', '120000'],
    ['max_attempts', 0],
    ['max_attempts', 11],
    ['max_attempts', 2.5],
    ['max_calls_per_hour', 0],
    ['max_calls_per_hour', -60],
    ['max_calls_per_hour', 3_601],
    ['max_input_bytes', 1_023],
    ['max_input_bytes', 8_388_609],
    ['max_output_bytes', 0],
    ['max_output_bytes', 8_388_609],
    ['max_output_tokens', 0],
    ['max_output_tokens', 1_000_001],
    ['max_output_tokens', 'none'],
    ['max_cost_usd_per_call', 0],
    ['max_cost_usd_per_call', -1],
    ['max_cost_usd_per_call', 'unlimited'],
    ['max_cost_usd_per_call', '0.5'],
    ['max_cost_usd_per_day', 0],
    ['max_cost_usd_per_day', -5],
    ['max_cost_usd_per_day', 'none'],
    ['max_cost_usd_per_day', 'inherit'],
    ['idle_exit_ms', 30],
    ['idle_exit_ms', 3_600_001],
  ])('refuses %s = %j and names the key', (key, value) => {
    expect(validationError(section({ [key]: value }))).toMatchObject({
      code: 'INVALID_CONFIG',
      path: `knowledge_processing.${key}`,
    });
  });

  it('keeps the call timeout floor at ten seconds and leaves the idle exit its own', () => {
    expect(KNOWLEDGE_PROCESSING_MIN_TIMEOUT_MS).toBe(10_000);
    expect(resolveConfig(section({ idle_exit_ms: 1_000 })).knowledge_processing.idle_exit_ms).toBe(
      1_000
    );
  });

  it.each(['Inherit', 'INHERIT', 'iNhErIt'])(
    'refuses the model %j and says to write inherit in lowercase',
    (model) => {
      const error = validationError(section({ model }));
      expect(error.path).toBe('knowledge_processing.model');
      expect(error.message).toContain(`"${model}" would be sent to the provider as a model id`);
      expect(error.message).toContain('write "inherit" in lowercase');
    }
  );

  it.each(['Provider_Default', 'PROVIDER_DEFAULT'])(
    'refuses the model %j and says to write provider_default in lowercase',
    (model) => {
      const error = validationError(section({ model }));
      expect(error.path).toBe('knowledge_processing.model');
      expect(error.message).toContain('write "provider_default" in lowercase');
    }
  );

  it('loads provider_default as the word that leaves the model to the provider', () => {
    expect(resolveConfig(section({ model: 'provider_default' })).knowledge_processing.model).toBe(
      'provider_default'
    );
  });

  it.each(['none', 'None', 'default', 'DEFAULT', 'auto', 'Auto'])(
    'refuses the model %j and says what to write instead',
    (model) => {
      const error = validationError(section({ model }));
      expect(error.path).toBe('knowledge_processing.model');
      expect(error.message).toContain(`"${model}" is not a model id`);
      expect(error.message).toMatch(
        /write "inherit" to use llm\.model, "provider_default" to let the provider choose, or name a model/
      );
    }
  );

  it('refuses a section that is not an object', () => {
    expect(validationError({ knowledge_processing: true })).toMatchObject({
      path: 'knowledge_processing',
    });
  });

  it.each([
    'enabled',
    'tool_access',
    'provider',
    'model',
    'effort',
    'timeout_ms',
    'max_output_tokens',
    'max_cost_usd_per_call',
    'max_cost_usd_per_day',
  ])('refuses null for %s instead of reading it as the default', (key) => {
    const error = validationError(section({ [key]: null }));
    expect(error.path).toBe(`knowledge_processing.${key}`);
    expect(error.message).toMatch(/null is not a setting here.*"inherit" and "none"/s);
  });

  it('refuses a null section instead of reading it as the default', () => {
    expect(validationError({ knowledge_processing: null }).path).toBe('knowledge_processing');
  });

  it('still refuses a malformed unrelated value beside a valid section', () => {
    expect(
      validationError({ ...section({ enabled: true }), gc: { retention_days: 'soon' } })
    ).toMatchObject({ code: 'INVALID_CONFIG', path: 'gc.retention_days' });
  });

  it('refuses a malformed section beside valid unrelated values', () => {
    expect(
      validationError({ gc: { retention_days: 7 }, ...section({ max_attempts: 'three' }) })
    ).toMatchObject({ code: 'INVALID_CONFIG', path: 'knowledge_processing.max_attempts' });
  });
});

describe('a predecessor-stamped document carrying knowledge_processing', () => {
  it.each([5, 6, 7])('is refused under version %i and told to say 8', (version) => {
    const error = validationError({ schema_version: version, ...section({ enabled: true }) });
    expect(error.path).toBe('schema_version');
    expect(error.message).toMatch(
      new RegExp(`knowledge_processing needs schema_version 8, but the file says ${version}`)
    );
  });

  it('loads under the current version', () => {
    const loaded = resolveConfig({
      schema_version: CONFIG_SCHEMA_VERSION,
      ...section({ enabled: true }),
    });
    expect(loaded.knowledge_processing.enabled).toBe(true);
  });

  it('refuses tool_access under version 7 and names version 8', () => {
    const error = validationError({
      schema_version: 7,
      ...section({ tool_access: 'codex_restricted' }),
    });
    expect(error.path).toBe('schema_version');
    expect(error.message).toContain(
      `knowledge_processing needs schema_version ${KNOWLEDGE_PROCESSING_TOOL_ACCESS_CONFIG_VERSION}`
    );
  });

  it('still loads a version 5 document that carries the blocks version 6 introduced', () => {
    const loaded = resolveConfig({
      schema_version: 5,
      capture: { exclude: ['secrets/**'] },
      redact: { allow: ['AKIAIOSFODNN7EXAMPLE'] },
    });
    expect(loaded.capture.exclude).toEqual(['secrets/**']);
  });
});

describe('configVersionForWrite', () => {
  it.each([5, 6, 7, CONFIG_SCHEMA_VERSION])(
    'keeps version %i when the document gains no newer key',
    (existing) => {
      expect(configVersionForWrite({ naming: { prefix: 'oo' } }, existing)).toBe(existing);
    }
  );

  it.each([5, 6, 7])(
    'moves version %i to 8 in the write that adds knowledge_processing',
    (existing) => {
      expect(configVersionForWrite(section({ enabled: true }), existing)).toBe(8);
    }
  );

  it('uses the same version for knowledge processing with or without tool access', () => {
    expect(configVersionForWrite(section({ enabled: true }), 7)).toBe(8);
    expect(configVersionForWrite(section({ tool_access: 'codex_restricted' }), 7)).toBe(8);
  });

  it('stamps a fresh document with the oldest version that reads everything in it', () => {
    expect(FRESH_CONFIG_FILE_VERSION).toBe(6);
    expect(configVersionForWrite({})).toBe(6);
    expect(
      configVersionForWrite({
        install: { agents: ['claude-code'], scope: 'personal' },
        capture: { exclude: ['secrets/**'] },
        redact: { allow: ['AKIAIOSFODNN7EXAMPLE'] },
      })
    ).toBe(6);
  });

  it('stamps a fresh document that carries knowledge_processing with 8', () => {
    expect(configVersionForWrite(section({ enabled: true }))).toBe(8);
  });

  it('loads what it stamps on a fresh document as the current shape', () => {
    const document = { install: { agents: ['codex'] } };
    const loaded = resolveConfig({ schema_version: configVersionForWrite(document), ...document });
    expect(loaded.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(getDefaultConfig().schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('refuses to stamp over a version ahead of this build', () => {
    expect(() => configVersionForWrite({}, CONFIG_SCHEMA_VERSION + 1)).toThrow(/Upgrade orcaops/);
  });

  it.each([4, '6', null])(
    'refuses the existing version %j, which this build does not load',
    (existing) => {
      expect(() => configVersionForWrite({}, existing)).toThrow(ConfigValidationError);
    }
  );

  it('never lowers the current version when the section is absent', () => {
    expect(configVersionForWrite({ install: { agents: [] } }, CONFIG_SCHEMA_VERSION)).toBe(
      CONFIG_SCHEMA_VERSION
    );
  });
});
