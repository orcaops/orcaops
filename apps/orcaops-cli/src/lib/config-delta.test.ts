import { describe, expect, it } from 'vitest';

import { getDefaultConfig, resolveConfig } from '@orcaops/storage';

import { buildConfigDelta } from './config-delta.js';

describe('buildConfigDelta', () => {
  it('an all-default config reduces to the three pinned anchors', () => {
    const delta = buildConfigDelta(getDefaultConfig());
    expect(delta).toEqual({
      schema_version: getDefaultConfig().schema_version,
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

  it('round-trips: resolving the delta reproduces the resolved config', () => {
    const config = getDefaultConfig();
    config.install.scope = 'personal';
    config.install.agents = ['claude-code', 'codex'];
    config.naming.prefix = 'oo';
    config.archive = { ...config.archive, enabled: true };
    const delta = buildConfigDelta(config);
    const resolved = resolveConfig(JSON.parse(JSON.stringify(delta)));
    expect(resolved).toEqual(config);
  });
});
