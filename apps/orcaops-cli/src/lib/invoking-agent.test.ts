import { describe, expect, it } from 'vitest';

import { ORCAOPS_INVOKED_BY_AGENT_ENV, resolveInvokingAgent } from './invoking-agent.js';
import { OrcaopsError } from '../io/errors.js';

/**
 * Pure resolver tests — env is always injected explicitly so nothing
 * here depends on the developer's shell (the vitest setup scrubs the
 * ambient markers from `process.env` anyway, belt-and-braces).
 */
describe('resolveInvokingAgent', () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;

  it('falls back to other with source=fallback on a bare environment', () => {
    expect(resolveInvokingAgent({ env: emptyEnv })).toEqual({
      agent: 'other',
      source: 'fallback',
    });
  });

  // ── tier 1: flag ──────────────────────────────────────────────────

  it('flag wins over env var and ambient markers (nested-agent case)', () => {
    const env = {
      [ORCAOPS_INVOKED_BY_AGENT_ENV]: 'cursor',
      CLAUDECODE: '1',
    } as NodeJS.ProcessEnv;
    // A codex child launched from a Claude Code shell inherits
    // CLAUDECODE=1; its skill-driven flag names the actual invoker.
    expect(resolveInvokingAgent({ flag: 'codex', env })).toEqual({
      agent: 'codex',
      source: 'flag',
    });
  });

  it('accepts every capture enum member as a flag value', () => {
    for (const id of [
      'claude-code',
      'cursor',
      'codex',
      'opencode',
      'aider',
      'github-copilot',
      'antigravity-cli',
      'other',
    ]) {
      expect(resolveInvokingAgent({ flag: id, env: emptyEnv }).agent).toBe(id);
    }
  });

  it('throws INVALID_INPUT on an unknown flag value (loud, never demoted)', () => {
    let thrown: unknown;
    try {
      resolveInvokingAgent({ flag: 'gpt-shell', env: emptyEnv });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OrcaopsError);
    expect((thrown as OrcaopsError).code).toBe('INVALID_INPUT');
    expect((thrown as OrcaopsError).inputPath).toBe('invoked_by_agent');
  });

  // ── tier 2: env var ───────────────────────────────────────────────

  it('resolves from ORCAOPS_INVOKED_BY_AGENT when no flag is given', () => {
    const env = { [ORCAOPS_INVOKED_BY_AGENT_ENV]: 'opencode' } as NodeJS.ProcessEnv;
    expect(resolveInvokingAgent({ env })).toEqual({ agent: 'opencode', source: 'env' });
  });

  it('env var beats an ambient marker', () => {
    const env = {
      [ORCAOPS_INVOKED_BY_AGENT_ENV]: 'aider',
      CLAUDECODE: '1',
    } as NodeJS.ProcessEnv;
    expect(resolveInvokingAgent({ env })).toEqual({ agent: 'aider', source: 'env' });
  });

  it('an invalid env value falls through silently (best-effort tier)', () => {
    const env = {
      [ORCAOPS_INVOKED_BY_AGENT_ENV]: 'not-an-agent',
      CLAUDECODE: '1',
    } as NodeJS.ProcessEnv;
    expect(resolveInvokingAgent({ env })).toEqual({ agent: 'claude-code', source: 'ambient' });
  });

  it('a blank env value is unset', () => {
    const env = { [ORCAOPS_INVOKED_BY_AGENT_ENV]: '  ' } as NodeJS.ProcessEnv;
    expect(resolveInvokingAgent({ env })).toEqual({ agent: 'other', source: 'fallback' });
  });

  // ── tier 3: ambient markers ───────────────────────────────────────

  it.each([
    ['CLAUDECODE', '1', 'claude-code'],
    ['CLAUDE_CODE_SESSION_ID', 'sess-123', 'claude-code'],
    ['CURSOR_AGENT', '1', 'cursor'],
    ['CURSOR_TRACE_ID', 'trace-1', 'cursor'],
    ['CODEX_SESSION_ID', 'root-1', 'codex'],
    ['CODEX_THREAD_ID', 'thread-1', 'codex'],
    ['CODEX_SANDBOX', 'seatbelt', 'codex'],
    ['CODEX_SANDBOX_NETWORK_DISABLED', '1', 'codex'],
  ])('detects %s=%s as %s', (key, value, agent) => {
    const env = { [key]: value } as NodeJS.ProcessEnv;
    expect(resolveInvokingAgent({ env })).toEqual({ agent, source: 'ambient' });
  });

  it('two markers of the SAME agent stay decisive', () => {
    const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-1' } as NodeJS.ProcessEnv;
    expect(resolveInvokingAgent({ env })).toEqual({ agent: 'claude-code', source: 'ambient' });
  });

  it('markers of DISTINCT agents skip the ambient tier and record the conflict', () => {
    const env = { CLAUDECODE: '1', CODEX_THREAD_ID: 'thread-1' } as NodeJS.ProcessEnv;
    expect(resolveInvokingAgent({ env })).toEqual({
      agent: 'other',
      source: 'fallback',
      ambient_conflict: ['claude-code', 'codex'],
    });
  });

  it('blank-valued markers are unset', () => {
    const env = { CLAUDECODE: '', CURSOR_AGENT: '  ' } as NodeJS.ProcessEnv;
    expect(resolveInvokingAgent({ env })).toEqual({ agent: 'other', source: 'fallback' });
  });
});
