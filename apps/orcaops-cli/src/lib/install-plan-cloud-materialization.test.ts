import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { getDefaultConfig, type SupportedAgentId } from '@orcaops/storage';

import { type InstallManifest, MANIFEST_VERSION } from './install-manifest.js';
import { planCloudSkillMaterialization } from './install-plan.js';

async function scratchRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-mat-'));
  await mkdir(path.join(root, '.orcaops'), { recursive: true });
  return root;
}

function configWith(agents: SupportedAgentId[], prefix = 'orcaops') {
  const config = getDefaultConfig();
  config.install.agents = agents;
  config.naming.prefix = prefix;
  return config;
}

function manifest(installAgents: string[], namingPrefix = 'orcaops'): InstallManifest {
  return {
    manifest_version: MANIFEST_VERSION,
    install_agents: installAgents,
    naming_prefix: namingPrefix,
    entries: [],
  };
}

async function plan(over: {
  agents: SupportedAgentId[];
  prevInstall: InstallManifest;
  prefix?: string;
}) {
  return planCloudSkillMaterialization({
    repoRoot: await scratchRepo(),
    agents: over.agents,
    config: configWith(over.agents, over.prefix),
    generatedBy: '9.9.9',
    prevInstall: over.prevInstall,
    prevLocal: null,
  });
}

describe('planCloudSkillMaterialization refusals', () => {
  it('refuses when the recorded prefix disagrees with config', async () => {
    const res = await plan({
      agents: ['claude-code'],
      prevInstall: manifest(['claude-code'], 'oo'),
    });
    expect(res.refusal).toBe('prefix-mismatch');
    expect(res.mutations).toEqual([]);
  });

  it('refuses when the recorded agent set genuinely differs', async () => {
    const res = await plan({
      agents: ['claude-code'],
      prevInstall: manifest(['claude-code', 'cursor']),
    });
    expect(res.refusal).toBe('agent-set-mismatch');
  });

  it('does not refuse over a configured agent that has no adapter', async () => {
    // The manifest records the ADAPTER-BACKED subset, so comparing the raw
    // config set against it mismatched forever on a stale or hand-edited id —
    // a refusal no `orcaops update` could satisfy, on every login.
    const res = await plan({
      agents: ['claude-code', 'gemini-cli' as SupportedAgentId],
      prevInstall: manifest(['claude-code']),
    });
    expect(res.refusal).toBeUndefined();
  });

  it('does not refuse over recorded ordering', async () => {
    const res = await plan({
      agents: ['claude-code', 'cursor'],
      prevInstall: manifest(['cursor', 'claude-code']),
    });
    expect(res.refusal).toBeUndefined();
  });
});
