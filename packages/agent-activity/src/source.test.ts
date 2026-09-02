import { describe, expect, it } from 'vitest';

import { ClaudeCodeActivitySource } from './claude-code.js';
import { CodexActivitySource } from './codex/activity.js';
import { resolveAgentActivitySource } from './source.js';

describe('resolveAgentActivitySource', () => {
  it('resolves the Claude Code reader', () => {
    const source = resolveAgentActivitySource('claude-code', {});

    expect(source).toBeInstanceOf(ClaudeCodeActivitySource);
    expect(source?.agent).toBe('claude-code');
  });

  it('resolves Codex and returns null for an unsupported agent', () => {
    expect(resolveAgentActivitySource('codex', {})).toBeInstanceOf(CodexActivitySource);
    expect(resolveAgentActivitySource('unsupported', {})).toBeNull();
  });
});
