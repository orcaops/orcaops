import { describe, expect, it } from 'vitest';

import { DEFAULT_CAPTURE_EXCLUDE } from '@orcaops/evaluator-protocol';

import {
  buildClaudeArgs,
  buildClaudeEnv,
  claudeInspectionTools,
  ORCAOPS_CLAUDE_INSPECTION_TOOLS_BASE,
  ORCAOPS_CLAUDE_TOOL_DENY_RULES,
} from './args.js';

describe('buildClaudeArgs', () => {
  it('emits the orcaops baseline flags', () => {
    const args = buildClaudeArgs({});
    expect(args).toContain('--print');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--dangerously-skip-permissions');
    // We deliberately do NOT pass --bare (it disables OAuth/keychain auth
    // and breaks the piggyback model).
    expect(args.includes('--bare')).toBe(false);
    const dt = args.indexOf('--disallowed-tools');
    expect(dt).toBeGreaterThan(-1);
    expect(args[dt + 1]).toBe('*');
    const of = args.indexOf('--output-format');
    expect(of).toBeGreaterThan(-1);
    expect(args[of + 1]).toBe('stream-json');
  });

  it('isolates evaluator runs from project context without --bare', () => {
    const args = buildClaudeArgs({});
    // These flags are the narrower, auth-safe replacement for what --bare
    // would have done: drop project/local hooks (--setting-sources user) and
    // auto-discovered MCP (--strict-mcp-config). We must NOT use --bare itself
    // (it disables OAuth/keychain auth and breaks the claude login piggyback).
    expect(args.includes('--bare')).toBe(false);
    const ss = args.indexOf('--setting-sources');
    expect(ss).toBeGreaterThan(-1);
    expect(args[ss + 1]).toBe('user');
    expect(args).toContain('--strict-mcp-config');
  });

  it('reads prompt from stdin in one-shot mode', () => {
    const args = buildClaudeArgs({});
    expect(args.slice(-2)).toEqual(['-p', '-']);
  });

  it('passes optional knobs through', () => {
    const args = buildClaudeArgs({
      model: 'claude-sonnet-4-6',
      effort: 'high',
      systemPrompt: 'you are a tester',
      maxBudgetUsd: 0.05,
      sessionId: '00000000-0000-0000-0000-000000000000',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args).toContain('--system-prompt');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('you are a tester');
    expect(args).toContain('--max-budget-usd');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.0500');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('00000000-0000-0000-0000-000000000000');
    expect(args).toContain('--json-schema');
  });

  it('omits optional flags when not set', () => {
    const args = buildClaudeArgs({});
    expect(args.includes('--model')).toBe(false);
    expect(args.includes('--effort')).toBe(false);
    expect(args.includes('--system-prompt')).toBe(false);
    expect(args.includes('--max-budget-usd')).toBe(false);
    expect(args.includes('--session-id')).toBe(false);
    expect(args.includes('--resume')).toBe(false);
    expect(args.includes('--json-schema')).toBe(false);
  });

  it('keeps deny-all posture when toolPolicy mode is none (explicit)', () => {
    const args = buildClaudeArgs({ sessionId: 'x', toolPolicy: { mode: 'none' } });
    const idx = args.indexOf('--disallowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('*');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allowed-tools');
  });

  it('rejects every unsupported tool policy mode instead of silently denying all tools', () => {
    for (const mode of ['read-only', 'read-write', '', null, undefined, 1]) {
      expect(() => buildClaudeArgs({ toolPolicy: { mode } as never })).toThrowError(
        /expected "none" or "command-filtered"/
      );
    }
    expect(() => buildClaudeArgs({ toolPolicy: null as never })).toThrowError(
      /expected "none" or "command-filtered"/
    );
  });

  describe('command-filtered tool policy', () => {
    const SCOPE_DIR = '/home/dev/repo';
    const args = buildClaudeArgs({
      sessionId: 'x',
      toolPolicy: { mode: 'command-filtered' },
      readGrantRoot: SCOPE_DIR,
    });

    it('scopes the Read command and grants selected git inspection commands', () => {
      expect(args).toContain('--allowed-tools');
      const aIdx = args.indexOf('--allowed-tools');
      const expected = claudeInspectionTools(SCOPE_DIR);
      const tail = args.slice(aIdx + 1, aIdx + 1 + expected.length);
      expect(tail).toEqual(expected);
      // The Read grant carries the worktree path — bare `Read` would be denied
      // under --setting-sources user (the bug this regression guards).
      expect(tail[0]).toBe(`Read(/${SCOPE_DIR}/**)`);
      expect(tail).not.toContain('Read');
      expect(tail).toContain('Bash(git diff:*)');
      // The base list (everything except the path-scoped Read) is unchanged.
      expect(tail.slice(1)).toEqual([...ORCAOPS_CLAUDE_INSPECTION_TOOLS_BASE]);
    });

    it('narrows the home-dotfile deny so a repo under a dot-dir is not swallowed', () => {
      // `Read(~/.*)` (the old rule) recursed into any dotfile-NAMED directory,
      // so a repo checked out under one (e.g. `~/.worktrees/<repo>`) had its
      // whole worktree denied; `Read(~/.[!/]*)` blocks only direct home
      // dotfiles.
      expect(ORCAOPS_CLAUDE_TOOL_DENY_RULES).toContain('Read(~/.[!/]*)');
      expect(ORCAOPS_CLAUDE_TOOL_DENY_RULES).not.toContain('Read(~/.*)');
    });

    it('DROPS --disallowed-tools "*" AND --dangerously-skip-permissions (so deny rules bind)', () => {
      expect(args).not.toContain('--disallowed-tools');
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('uses --permission-mode acceptEdits (grants the allow-list non-interactively, honors denies)', () => {
      const idx = args.indexOf('--permission-mode');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe('acceptEdits');
    });

    it('injects the secret-path deny rules via --settings inline JSON', () => {
      const settingsIdx = args.indexOf('--settings');
      expect(settingsIdx).toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(args[settingsIdx + 1]) as { permissions: { deny: string[] } };
      expect(parsed.permissions.deny).toEqual([...ORCAOPS_CLAUDE_TOOL_DENY_RULES]);
      expect(parsed.permissions.deny).toContain('Read(~/.ssh/**)');
    });

    it('recursively denies the credential-bearing home dot-DIRECTORIES', () => {
      // The `Read(~/.*)` -> `Read(~/.[!/]*)` narrowing fixed the worktree-denial
      // bug but dropped recursive coverage of credential dot-dirs the old rule
      // had. These explicit recursive denies restore it; dropping any one is a
      // security regression, so each is pinned individually.
      const settingsIdx = args.indexOf('--settings');
      const parsed = JSON.parse(args[settingsIdx + 1]) as { permissions: { deny: string[] } };
      for (const rule of [
        'Read(~/.azure/**)',
        'Read(~/.gcloud/**)',
        'Read(~/.config/**)',
        'Read(~/.kube/**)',
        'Read(~/.docker/**)',
        'Read(~/.oci/**)',
        'Read(~/.gnupg/**)',
        'Read(~/.password-store/**)',
        'Read(~/.gem/**)',
        'Read(~/.bundle/**)',
        'Read(~/.terraform.d/**)',
      ]) {
        expect(parsed.permissions.deny).toContain(rule);
      }
    });

    it('still includes the project-context isolation levers', () => {
      expect(args).toContain('--setting-sources');
      expect(args).toContain('--strict-mcp-config');
    });

    it('honors a custom denyRules override', () => {
      const custom = buildClaudeArgs({
        sessionId: 'x',
        toolPolicy: { mode: 'command-filtered' },
        denyRules: ['Read(//secret/**)'],
      });
      const settingsIdx = custom.indexOf('--settings');
      const parsed = JSON.parse(custom[settingsIdx + 1]) as { permissions: { deny: string[] } };
      expect(parsed.permissions.deny).toEqual(['Read(//secret/**)']);
    });
  });
});

describe('buildClaudeEnv', () => {
  it('includes orcaops marker and CI hygiene', () => {
    const env = buildClaudeEnv();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('orcaops-evaluator');
    expect(env.CI).toBe('true');
    expect(env.TERM).toBe('dumb');
  });

  it('disables CLAUDE.md memory loading for evaluator runs', () => {
    // The CLAUDE.md half of project-context isolation; memory-only, so it
    // does not affect auth or cwd (the file-reading evaluator keeps both).
    expect(buildClaudeEnv().CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
  });
});

describe('unknown executed model', () => {
  it('does not fabricate a provider name as a model id', async () => {
    const { run } = await import('effection');
    const { evaluateOneShot } = await import('./one-shot.js');
    const result = await run(() =>
      evaluateOneShot(
        { binPath: '/usr/bin/true' },
        { prompt: 'prompt', model: '', timeoutMs: 5_000 }
      )
    );
    expect(result.model).toBeNull();
    expect(result.error?.code).toBe('TOOL_ERROR');
  });
});

describe('deny rules cover the shared capture-exclude set', () => {
  it('denies every credential path capture refuses to snapshot', () => {
    // One list, two projections; a second copy here would drift against it.
    for (const glob of DEFAULT_CAPTURE_EXCLUDE) {
      expect(ORCAOPS_CLAUDE_TOOL_DENY_RULES).toContain(`Read(//${glob})`);
    }
  });

  it('still denies the $HOME credential dirs and top-level dotfiles', () => {
    // A different axis from the repo-path rules, and the `[!/]` narrowing is
    // load-bearing — a bare `Read(~/.*)` denies an entire worktree living
    // under a dotfile-named directory.
    expect(ORCAOPS_CLAUDE_TOOL_DENY_RULES).toContain('Read(~/.ssh/**)');
    expect(ORCAOPS_CLAUDE_TOOL_DENY_RULES).toContain('Read(~/.[!/]*)');
  });

  it('denies no ordinary repository source path', () => {
    for (const rule of ORCAOPS_CLAUDE_TOOL_DENY_RULES) {
      expect(rule).not.toBe('Read(//**)');
      expect(rule).not.toBe('Read(~/.*)');
    }
  });
});
