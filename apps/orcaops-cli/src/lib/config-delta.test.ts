import { describe, expect, it } from 'vitest';

import {
  CONFIG_SCHEMA_VERSION,
  FRESH_CONFIG_FILE_VERSION,
  getDefaultConfig,
  resolveConfig,
} from '@orcaops/storage';

import { buildConfigDelta } from './config-delta.js';

describe('buildConfigDelta', () => {
  it('an all-default config reduces to the three pinned anchors', () => {
    const delta = buildConfigDelta(getDefaultConfig());
    expect(delta).toEqual({
      schema_version: FRESH_CONFIG_FILE_VERSION,
      install: {
        agents: getDefaultConfig().install.agents,
        scope: getDefaultConfig().install.scope,
      },
      bootstrap: getDefaultConfig().bootstrap,
    });
  });

  it('non-default leaves survive; default subtrees are dropped', () => {
    const config = getDefaultConfig();
    config.llm.tool = 'none';
    config.install.scope = 'personal';
    config.bootstrap = 'manual';
    config.session_hooks = { enabled: true, payload: 'static', entries: 'project' };
    const delta = buildConfigDelta(config);
    expect(delta.llm).toEqual({ tool: 'none' });
    expect(delta.install).toEqual({ agents: config.install.agents, scope: 'personal' });
    expect(delta.bootstrap).toBe('manual');
    // Only the non-default key inside session_hooks is kept.
    expect(delta.session_hooks).toEqual({ enabled: true });
    // Default-valued subtrees never appear.
    expect(delta).not.toHaveProperty('gc');
    expect(delta).not.toHaveProperty('evaluators');
    expect(delta).not.toHaveProperty('archive');
  });

  it('stamps a fresh document with the version released builds read, not the loaded one', () => {
    const config = getDefaultConfig();
    expect(config.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(buildConfigDelta(config).schema_version).toBe(FRESH_CONFIG_FILE_VERSION);
    expect(FRESH_CONFIG_FILE_VERSION).toBeLessThan(CONFIG_SCHEMA_VERSION);
  });

  it('stamps a fresh document that enables knowledge processing with version 8', () => {
    const config = getDefaultConfig();
    config.knowledge_processing.enabled = true;
    expect(buildConfigDelta(config).schema_version).toBe(8);
  });

  it.each([5, 6, 7])(
    'keeps a preserved file on version %i when no newer key is written',
    (version) => {
      const config = resolveConfig({ schema_version: version, naming: { prefix: 'oo' } });
      const delta = buildConfigDelta(config, version);
      expect(delta.schema_version).toBe(version);
      expect(delta.naming).toEqual({ prefix: 'oo' });
      expect(delta).not.toHaveProperty('knowledge_processing');
    }
  );

  it('drops a default-valued knowledge_processing section without lowering the version', () => {
    const config = resolveConfig({
      schema_version: CONFIG_SCHEMA_VERSION,
      knowledge_processing: { enabled: false },
    });
    const delta = buildConfigDelta(config, CONFIG_SCHEMA_VERSION);
    expect(delta).not.toHaveProperty('knowledge_processing');
    expect(delta.schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('stamps version 8 when the delta carries knowledge processing without tool access', () => {
    const config = getDefaultConfig();
    config.knowledge_processing.enabled = true;
    config.knowledge_processing.max_cost_usd_per_day = 5;
    const delta = buildConfigDelta(config, 6);
    expect(delta.schema_version).toBe(8);
    expect(delta.knowledge_processing).toEqual({ enabled: true, max_cost_usd_per_day: 5 });
  });

  it('stamps version 8 when the delta selects restricted Codex access', () => {
    const config = getDefaultConfig();
    config.knowledge_processing.tool_access = 'codex_restricted';
    const delta = buildConfigDelta(config, 7);
    expect(delta.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(delta.knowledge_processing).toEqual({ tool_access: 'codex_restricted' });
  });

  it('round-trips: resolving the delta reproduces the resolved config', () => {
    const config = getDefaultConfig();
    config.install.scope = 'personal';
    config.install.agents = ['claude-code', 'codex'];
    config.naming.prefix = 'oo';
    const delta = buildConfigDelta(config);
    const resolved = resolveConfig(JSON.parse(JSON.stringify(delta)));
    expect(resolved).toEqual(config);
  });

  it('omits workflow entirely at its defaults, and carries only changed leaves', () => {
    const config = getDefaultConfig();
    expect(buildConfigDelta(config)).not.toHaveProperty('workflow');
    config.workflow.commit_inside_window = false;
    config.workflow.routing.suppress = ['digest'];
    const delta = buildConfigDelta(config);
    expect(delta.workflow).toEqual({
      commit_inside_window: false,
      routing: { suppress: ['digest'] },
    });
    expect(delta.schema_version).toBe(7);
    expect(resolveConfig(delta)).toEqual(config);
  });

  it('keeps workflow settings when knowledge processing raises the version', () => {
    const config = getDefaultConfig();
    config.workflow.commit_inside_window = false;
    config.knowledge_processing.enabled = true;
    const delta = buildConfigDelta(config, 7);
    expect(delta.schema_version).toBe(8);
    expect(resolveConfig(delta)).toEqual(config);
  });
});
