import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentType } from '@orcaops/agent-targets';

import { detectInstallAgentEvidence, detectInstallAgents } from './detect.js';

const cursorAndCopilot = async (): Promise<AgentType[]> => ['cursor', 'github-copilot'];

/** A fake home whose only entries are what orcaops and Superset themselves write. */
const footprintOnlyHome: Record<string, string[]> = {
  '.cursor': ['hooks.json', 'skills'],
  '.copilot': ['skills'],
};

/** readdir over an in-memory home; unknown directories reject like a missing path. */
function fakeReaddir(home: string, listing: Record<string, string[]>) {
  return async (dir: string): Promise<string[]> => {
    const entries = listing[path.relative(home, dir)];
    if (entries === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return entries;
  };
}

const evidenceHome = {
  home: '/home/evidence',
  readdir: fakeReaddir('/home/evidence', {
    '.cursor': ['hooks.json', 'skills', 'cli-config.json'],
    '.copilot': ['skills', 'config.json'],
  }),
};

describe('detectInstallAgents', () => {
  it('intersects detection with overlay-backed targets, in canonical order', async () => {
    // Detected agents come back in SUPPORTED_AGENT_IDS order regardless of
    // input order; non-overlay ids (gemini-cli) are dropped.
    const result = await detectInstallAgents({
      ...evidenceHome,
      detectInstalledAgents: async () => ['codex', 'cursor', 'gemini-cli', 'claude-code'],
    });
    expect(result).toEqual(['claude-code', 'codex', 'cursor']);
  });

  it('drops detected agents that have no overlay (detectable but not installable)', async () => {
    const result = await detectInstallAgents({
      ...evidenceHome,
      detectInstalledAgents: async () => ['gemini-cli', 'goose', 'windsurf'],
    });
    expect(result).toEqual([]);
  });

  it('detects the opencode / aider-desk / github-copilot overlays', async () => {
    const result = await detectInstallAgents({
      ...evidenceHome,
      detectInstalledAgents: async () => ['github-copilot', 'aider-desk', 'opencode'],
    });
    expect(result).toEqual(['opencode', 'aider-desk', 'github-copilot']);
  });

  it('returns the single detected supported agent', async () => {
    const result = await detectInstallAgents({
      ...evidenceHome,
      detectInstalledAgents: async () => ['codex'],
    });
    expect(result).toEqual(['codex']);
  });

  it('detects the Antigravity CLI registry row', async () => {
    const result = await detectInstallAgents({
      ...evidenceHome,
      detectInstalledAgents: async () => ['antigravity-cli'],
    });
    expect(result).toEqual(['antigravity-cli']);
  });
});

describe('detectInstallAgentEvidence', () => {
  const home = '/home/fake';
  const detectWith = (listing: Record<string, string[]>) =>
    detectInstallAgentEvidence({
      home,
      readdir: fakeReaddir(home, listing),
      detectInstalledAgents: cursorAndCopilot,
    });

  it('does not detect Cursor from a directory holding only hooks.json and orcaops skills', async () => {
    expect(await detectWith(footprintOnlyHome)).toEqual([]);
  });

  it('detects Cursor from its CLI config and names it as evidence', async () => {
    const result = await detectWith({
      ...footprintOnlyHome,
      '.cursor': ['hooks.json', 'skills', 'cli-config.json'],
    });
    expect(result).toEqual([{ id: 'cursor', evidence: '~/.cursor/cli-config.json' }]);
  });

  it('detects Cursor from the cursor-agent install directory', async () => {
    const result = await detectWith({
      ...footprintOnlyHome,
      '.local/share': ['cursor-agent', 'fonts'],
    });
    expect(result).toEqual([{ id: 'cursor', evidence: '~/.local/share/cursor-agent' }]);
  });

  it('does not detect Copilot from a directory holding only orcaops skills', async () => {
    const result = await detectWith({
      '.cursor': ['hooks.json', 'skills', 'cli-config.json'],
      '.copilot': ['skills'],
    });
    expect(result).toEqual([{ id: 'cursor', evidence: '~/.cursor/cli-config.json' }]);
  });

  it('detects Copilot from its CLI config and names it as evidence', async () => {
    const result = await detectWith({
      ...footprintOnlyHome,
      '.copilot': ['skills', 'config.json'],
    });
    expect(result).toEqual([{ id: 'github-copilot', evidence: '~/.copilot/config.json' }]);
  });

  it('ignores dotfiles when looking for evidence', async () => {
    const result = await detectWith({
      '.cursor': ['.DS_Store', 'hooks.json', 'skills'],
      '.copilot': ['.gitkeep', 'skills'],
    });
    expect(result).toEqual([]);
  });

  it('treats a missing config directory as no evidence', async () => {
    expect(await detectWith({})).toEqual([]);
  });

  it('names the first qualifying entry in sorted order', async () => {
    const result = await detectWith({
      '.cursor': ['skills', 'extensions', 'argv.json', 'hooks.json'],
    });
    expect(result).toEqual([{ id: 'cursor', evidence: '~/.cursor/argv.json' }]);
  });

  it('keeps agents without an evidence rule and reports null evidence for them', async () => {
    const result = await detectInstallAgentEvidence({
      home,
      readdir: fakeReaddir(home, footprintOnlyHome),
      detectInstalledAgents: async () => ['claude-code', 'cursor', 'codex'],
    });
    expect(result).toEqual([
      { id: 'claude-code', evidence: null },
      { id: 'codex', evidence: null },
    ]);
  });

  describe('against a real home directory', () => {
    let realHome: string;

    beforeEach(async () => {
      realHome = await mkdtemp(path.join(tmpdir(), 'orcaops-detect-home-'));
    });
    afterEach(async () => {
      await rm(realHome, { recursive: true, force: true });
    });

    const tree = async (dir: string): Promise<string[]> =>
      (await readdir(dir, { recursive: true })).map((p) => p.split(path.sep).join('/')).sort();

    it('never creates directories while probing', async () => {
      await mkdir(path.join(realHome, '.cursor', 'skills', 'orcaops-capture'), {
        recursive: true,
      });
      await writeFile(path.join(realHome, '.cursor', 'hooks.json'), '{}');
      const before = await tree(realHome);

      const result = await detectInstallAgentEvidence({
        home: realHome,
        detectInstalledAgents: cursorAndCopilot,
      });

      expect(result).toEqual([]);
      expect(await tree(realHome)).toEqual(before);
    });

    it('reads evidence from disk with the default readdir', async () => {
      await mkdir(path.join(realHome, '.copilot', 'logs'), { recursive: true });
      await writeFile(path.join(realHome, '.copilot', 'config.json'), '{}');

      const result = await detectInstallAgentEvidence({
        home: realHome,
        detectInstalledAgents: cursorAndCopilot,
      });

      expect(result).toEqual([{ id: 'github-copilot', evidence: '~/.copilot/config.json' }]);
    });
  });
});
