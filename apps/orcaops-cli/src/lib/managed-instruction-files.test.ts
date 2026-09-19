import { describe, expect, it } from 'vitest';

import { getDefaultConfig } from '@orcaops/storage';

import { resolveManagedInstructionFiles } from './managed-instruction-files.js';

function configFor(agents: string[], scope: 'project' | 'personal' = 'project') {
  const config = getDefaultConfig();
  config.install.agents = agents as typeof config.install.agents;
  config.install.scope = scope;
  return config;
}

describe('resolveManagedInstructionFiles', () => {
  it('unions the install set when no agent is given', () => {
    expect(resolveManagedInstructionFiles(configFor(['claude-code', 'codex']))).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
    ]);
  });

  it('narrows to the files an installed agent loads', () => {
    expect(resolveManagedInstructionFiles(configFor(['claude-code', 'codex']), 'codex')).toEqual([
      'AGENTS.md',
    ]);
  });

  it('narrows to a known agent outside the install set instead of the union', () => {
    expect(resolveManagedInstructionFiles(configFor(['claude-code', 'codex']), 'cursor')).toEqual([
      'AGENTS.md',
    ]);
  });

  it('manages nothing under personal scope, agent or not', () => {
    expect(resolveManagedInstructionFiles(configFor(['claude-code'], 'personal'))).toEqual([]);
    expect(
      resolveManagedInstructionFiles(configFor(['claude-code'], 'personal'), 'cursor')
    ).toEqual([]);
  });
});
