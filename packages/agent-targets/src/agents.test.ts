import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  detectInstalledAgents,
  firstConfiguredDir,
  getAgentConfig,
  isUniversalAgent,
  UNIVERSAL_SKILLS_DIR,
} from './index.js';

describe('@orcaops/agent-targets vendored registry', () => {
  it('exposes the skill placement orcaops installs against', () => {
    expect(getAgentConfig('claude-code').skillsDir).toBe('.claude/skills');
    expect(getAgentConfig('codex').skillsDir).toBe('.agents/skills');
    expect(getAgentConfig('aider-desk').skillsDir).toBe('.aider-desk/skills');
    expect(getAgentConfig('claude-code').displayName).toBe('Claude Code');
  });

  it('classifies universal vs agent-specific skill dirs', () => {
    expect(UNIVERSAL_SKILLS_DIR).toBe('.agents/skills');
    // Codex, cursor, opencode, and github-copilot share the universal dir;
    // claude-code and aider-desk have their own.
    expect(isUniversalAgent('codex')).toBe(true);
    expect(isUniversalAgent('cursor')).toBe(true);
    expect(isUniversalAgent('opencode')).toBe(true);
    expect(isUniversalAgent('github-copilot')).toBe(true);
    expect(isUniversalAgent('claude-code')).toBe(false);
    expect(isUniversalAgent('aider-desk')).toBe(false);
  });

  it('exposes detection as an async function', async () => {
    expect(typeof detectInstalledAgents).toBe('function');
    const installed = await detectInstalledAgents();
    expect(Array.isArray(installed)).toBe(true);
  });

  describe('config-dir resolution', () => {
    // CLAUDE_CONFIG_DIR is a comma-separated LIST and may carry an unexpanded
    // `~`. Read raw, it yields `/a,/b/skills` or a CWD-relative path, and
    // global-install then reads every recorded entry as another environment's.
    it('takes the first entry of a comma-separated list', () => {
      expect(firstConfiguredDir('/a,/b', '/fallback')).toBe('/a');
      expect(firstConfiguredDir(' /a , /b ', '/fallback')).toBe('/a');
    });

    it('falls back when the value is absent, empty, or separators only', () => {
      expect(firstConfiguredDir(undefined, '/fallback')).toBe('/fallback');
      expect(firstConfiguredDir('', '/fallback')).toBe('/fallback');
      expect(firstConfiguredDir('   ', '/fallback')).toBe('/fallback');
      expect(firstConfiguredDir(',,', '/fallback')).toBe('/fallback');
    });

    it('expands a leading tilde rather than leaving a CWD-relative path', () => {
      expect(firstConfiguredDir('~', '/fallback')).toBe(homedir());
      expect(firstConfiguredDir('~/.claude', '/fallback')).toBe(path.join(homedir(), '.claude'));
      // Only a LEADING `~/` is a home reference.
      expect(firstConfiguredDir('/opt/~weird', '/fallback')).toBe('/opt/~weird');
    });

    it('passes an ordinary absolute path through unchanged', () => {
      expect(firstConfiguredDir('/opt/claude', '/fallback')).toBe('/opt/claude');
    });

    it('agrees with the transcript locator on the same inputs', () => {
      // Both consumers must select the same root; see claudeProjectBases in
      // @orcaops/agent-activity.
      for (const raw of ['/a,/b', '~/.claude', '', '   ', ',,']) {
        const mine = firstConfiguredDir(raw, path.join(homedir(), '.claude'));
        const theirs = (raw ?? '')
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean)
          .map((e) =>
            e === '~' ? homedir() : e.startsWith('~/') ? path.join(homedir(), e.slice(2)) : e
          )[0];
        expect(mine).toBe(theirs ?? path.join(homedir(), '.claude'));
      }
    });
  });
});
