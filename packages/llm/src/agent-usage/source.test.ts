import { describe, expect, it } from 'vitest';

import { resolveAgentUsageSource } from './source.js';
import { ClaudeCodeUsageSource } from '../claude-code/transcript-parser.js';
import { CodexUsageSource } from '../codex/rollout-parser.js';
import { CopilotUsageSource } from '../github-copilot/otel-parser.js';
import { OpenCodeUsageSource } from '../opencode/db-reader.js';

describe('resolveAgentUsageSource', () => {
  it('resolves the Claude Code usage source', () => {
    const src = resolveAgentUsageSource('claude-code');
    expect(src).toBeInstanceOf(ClaudeCodeUsageSource);
    expect(src!.agent).toBe('claude-code');
  });

  it('resolves the Codex usage source', () => {
    const src = resolveAgentUsageSource('codex');
    expect(src).toBeInstanceOf(CodexUsageSource);
    expect(src!.agent).toBe('codex');
    expect(src!.discoverActiveSessionId).toBeDefined();
    expect(src!.canonicalizeSessionId).toBeDefined();
  });

  it('resolves the OpenCode usage source', () => {
    const src = resolveAgentUsageSource('opencode');
    expect(src).toBeInstanceOf(OpenCodeUsageSource);
    expect(src!.agent).toBe('opencode');
    expect(src!.discoverActiveSessionId).toBeDefined();
  });

  it('resolves the GitHub Copilot usage source (env-only, no discovery)', () => {
    const src = resolveAgentUsageSource('github-copilot');
    expect(src).toBeInstanceOf(CopilotUsageSource);
    expect(src!.agent).toBe('github-copilot');
    expect(src!.discoverActiveSessionId).toBeUndefined();
  });

  it('returns null for an agent with no usage source', () => {
    expect(resolveAgentUsageSource('cursor')).toBeNull();
    expect(resolveAgentUsageSource('aider')).toBeNull();
    expect(resolveAgentUsageSource('other')).toBeNull();
    expect(resolveAgentUsageSource('')).toBeNull();
  });
});
