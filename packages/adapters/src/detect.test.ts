import { describe, expect, it } from 'vitest';

import { detectInstallAgents } from './detect.js';

describe('detectInstallAgents', () => {
  it('intersects detection with overlay-backed targets, in canonical order', async () => {
    // Detected agents come back in SUPPORTED_AGENT_IDS order regardless of
    // input order; non-overlay ids (gemini-cli) are dropped.
    const result = await detectInstallAgents({
      detectInstalledAgents: async () => ['codex', 'cursor', 'gemini-cli', 'claude-code'],
    });
    expect(result).toEqual(['claude-code', 'codex', 'cursor']);
  });

  it('drops detected agents that have no overlay (detectable but not installable)', async () => {
    const result = await detectInstallAgents({
      detectInstalledAgents: async () => ['gemini-cli', 'goose', 'windsurf'],
    });
    expect(result).toEqual([]);
  });

  it('detects the opencode / aider-desk / github-copilot overlays', async () => {
    const result = await detectInstallAgents({
      detectInstalledAgents: async () => ['github-copilot', 'aider-desk', 'opencode'],
    });
    expect(result).toEqual(['opencode', 'aider-desk', 'github-copilot']);
  });

  it('returns the single detected supported agent', async () => {
    const result = await detectInstallAgents({
      detectInstalledAgents: async () => ['codex'],
    });
    expect(result).toEqual(['codex']);
  });

  it('detects the Antigravity CLI registry row', async () => {
    const result = await detectInstallAgents({
      detectInstalledAgents: async () => ['antigravity-cli'],
    });
    expect(result).toEqual(['antigravity-cli']);
  });
});
