import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { resolveShellKey, shellKeyId } from './shell-key.js';

describe('resolveShellKey', () => {
  it('picks claude_session over every other env var when set', () => {
    const key = resolveShellKey({
      env: {
        CLAUDE_SESSION_ID: 'sess_abc',
        CODEX_SESSION_ID: 'sess_codex',
        TMUX_PANE: '%42',
        STY: '1234.tty',
        WINDOW: '0',
        TTY: '/dev/ttys001',
      },
      ppid: 12345,
    });
    expect(key).toEqual({ kind: 'claude_session', value: 'sess_abc' });
  });

  it('falls to codex_session when claude is absent', () => {
    const key = resolveShellKey({
      env: {
        CODEX_SESSION_ID: 'sess_codex',
        TMUX_PANE: '%42',
      },
      ppid: 12345,
    });
    expect(key).toEqual({ kind: 'codex_session', value: 'sess_codex' });
  });

  it('uses tmux_pane when no agent session is present', () => {
    const key = resolveShellKey({
      env: { TMUX_PANE: '%42' },
      ppid: 12345,
    });
    expect(key).toEqual({ kind: 'tmux_pane', value: '%42' });
  });

  it('requires both STY and WINDOW for screen_window', () => {
    expect(resolveShellKey({ env: { STY: '1234.tty' }, ppid: 1 }).kind).toBe('none');
    expect(resolveShellKey({ env: { WINDOW: '0' }, ppid: 1 }).kind).toBe('none');
    const key = resolveShellKey({ env: { STY: '1234.tty', WINDOW: '0' }, ppid: 1 });
    expect(key).toEqual({ kind: 'screen_window', value: '1234.tty:0' });
  });

  it('hashes $TTY + ppid for tty_session', () => {
    const key = resolveShellKey({ env: { TTY: '/dev/ttys001' }, ppid: 4242 });
    expect(key.kind).toBe('tty_session');
    if (key.kind !== 'tty_session') return;
    const expected = createHash('sha256').update('/dev/ttys001|4242').digest('hex').slice(0, 32);
    expect(key.value).toBe(expected);
  });

  it('different ppids produce different tty_session values (subshells diverge)', () => {
    const a = resolveShellKey({ env: { TTY: '/dev/ttys001' }, ppid: 1 });
    const b = resolveShellKey({ env: { TTY: '/dev/ttys001' }, ppid: 2 });
    expect(a).not.toEqual(b);
  });

  it('returns kind=none when no recognized env vars are set', () => {
    expect(resolveShellKey({ env: {}, ppid: 1 })).toEqual({ kind: 'none' });
  });

  it('treats empty-string env vars as unset', () => {
    expect(
      resolveShellKey({
        env: { CLAUDE_SESSION_ID: '', CODEX_SESSION_ID: '', TMUX_PANE: '' },
        ppid: 1,
      }).kind
    ).toBe('none');
  });
});

describe('shellKeyId', () => {
  it('embeds kind as prefix', () => {
    const id = shellKeyId({ kind: 'claude_session', value: 'sess_abc' });
    expect(id.startsWith('claude_session-')).toBe(true);
  });

  it('different values yield different ids (same kind)', () => {
    expect(shellKeyId({ kind: 'tmux_pane', value: '%1' })).not.toBe(
      shellKeyId({ kind: 'tmux_pane', value: '%2' })
    );
  });

  it('value-hash suffix is 16 hex chars', () => {
    const id = shellKeyId({ kind: 'claude_session', value: 'sess' });
    const hex = id.split('-').pop() ?? '';
    expect(hex).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stable across calls (deterministic)', () => {
    const a = shellKeyId({ kind: 'codex_session', value: 'whatever-value-here' });
    const b = shellKeyId({ kind: 'codex_session', value: 'whatever-value-here' });
    expect(a).toBe(b);
  });

  it('handles raw values that would otherwise be filesystem-unsafe', () => {
    const id = shellKeyId({ kind: 'tmux_pane', value: '/dev/tty pane%1' });
    expect(id).not.toContain('/');
    expect(id).not.toContain(' ');
    expect(id).toMatch(/^tmux_pane-[0-9a-f]{16}$/);
  });

  it('returns "none" for kind=none (no value to hash)', () => {
    expect(shellKeyId({ kind: 'none' })).toBe('none');
  });
});

describe('claude_session variable precedence', () => {
  // CLAUDE_CODE_SESSION_ID is the fallback for the same claude_session kind;
  // an explicit CLAUDE_SESSION_ID retains precedence. Both variables therefore
  // produce the same shell-key schema variant.
  it('resolves claude_session from CLAUDE_SESSION_ID alone', () => {
    // Standalone isolation case: the long-standing chain test supplies every
    // lower-precedence variable at once, which proves precedence but not that
    // this variable suffices by itself.
    expect(resolveShellKey({ env: { CLAUDE_SESSION_ID: 'explicit-1' }, ppid: 1 })).toEqual({
      kind: 'claude_session',
      value: 'explicit-1',
    });
  });

  it('resolves claude_session from CLAUDE_CODE_SESSION_ID alone', () => {
    expect(resolveShellKey({ env: { CLAUDE_CODE_SESSION_ID: 'cc-1' }, ppid: 1 })).toEqual({
      kind: 'claude_session',
      value: 'cc-1',
    });
  });

  // Pin the explicit identifier's precedence over the fallback so future
  // changes cannot accidentally reorder them.
  it('explicit CLAUDE_SESSION_ID wins over CLAUDE_CODE_SESSION_ID', () => {
    expect(
      resolveShellKey({
        env: { CLAUDE_SESSION_ID: 'explicit-1', CLAUDE_CODE_SESSION_ID: 'cc-1' },
        ppid: 1,
      })
    ).toEqual({ kind: 'claude_session', value: 'explicit-1' });
  });

  it('either claude variable beats CODEX_SESSION_ID', () => {
    expect(
      resolveShellKey({
        env: { CLAUDE_CODE_SESSION_ID: 'cc-1', CODEX_SESSION_ID: 'cx-1' },
        ppid: 1,
      })
    ).toEqual({ kind: 'claude_session', value: 'cc-1' });
    expect(
      resolveShellKey({
        env: { CLAUDE_SESSION_ID: 'explicit-1', CODEX_SESSION_ID: 'cx-1' },
        ppid: 1,
      })
    ).toEqual({ kind: 'claude_session', value: 'explicit-1' });
  });

  it('blank claude variables fall through the whole chain stage by stage', () => {
    expect(
      resolveShellKey({
        env: { CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: 'cc-1' },
        ppid: 1,
      })
    ).toEqual({ kind: 'claude_session', value: 'cc-1' });
    expect(
      resolveShellKey({
        env: { CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: 'cx-1' },
        ppid: 1,
      })
    ).toEqual({ kind: 'codex_session', value: 'cx-1' });
    expect(
      resolveShellKey({
        env: {
          CLAUDE_SESSION_ID: '',
          CLAUDE_CODE_SESSION_ID: '',
          CODEX_SESSION_ID: '',
          TMUX_PANE: '%7',
        },
        ppid: 1,
      })
    ).toEqual({ kind: 'tmux_pane', value: '%7' });
  });

  it('identical exported ids resolve parent and subagent shells to one shared key', () => {
    // Resolution depends on the exported id, not ppid. If parent and subagent
    // shells receive the same value, both therefore share one pin slot. This
    // specifies Orcaops behavior without making assumptions about which ids
    // the host exports.
    const parent = resolveShellKey({ env: { CLAUDE_CODE_SESSION_ID: 'shared-id' }, ppid: 100 });
    const child = resolveShellKey({ env: { CLAUDE_CODE_SESSION_ID: 'shared-id' }, ppid: 200 });
    // Both inputs must resolve so equality cannot pass on two absent keys.
    expect(parent).toEqual({ kind: 'claude_session', value: 'shared-id' });
    expect(parent).toEqual(child);
    expect(shellKeyId(parent)).toBe(shellKeyId(child));
  });
});
