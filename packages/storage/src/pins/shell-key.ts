import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Typed shell-key for the pin model. Resolution picks the
 * highest-precedence kind whose env vars are present and STOPS — there
 * is no fallback chain across kinds. If `kind: 'none'`, no pin is
 * possible from this shell (headless / CI / unsupported terminal).
 */
export const ShellKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude_session'), value: z.string().min(1) }),
  z.object({ kind: z.literal('codex_session'), value: z.string().min(1) }),
  z.object({ kind: z.literal('tmux_pane'), value: z.string().min(1) }),
  z.object({ kind: z.literal('screen_window'), value: z.string().min(1) }),
  z.object({ kind: z.literal('tty_session'), value: z.string().min(1) }),
  z.object({ kind: z.literal('none') }),
]);
export type ShellKey = z.infer<typeof ShellKeySchema>;

export interface ResolveShellKeyOptions {
  /** Defaults to `process.env`; override for tests. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.ppid`; override for tests. */
  ppid?: number;
}

/**
 * Resolve the current shell's key from environment.
 *
 * Precedence (highest first; no fallback across kinds — but BOTH claude
 * variables mint the same `claude_session` kind):
 *   1. `$CLAUDE_SESSION_ID` → claude_session (explicit override)
 *   2. `$CLAUDE_CODE_SESSION_ID` → claude_session (documented by Claude Code)
 *   3. `$CODEX_SESSION_ID` → codex_session
 *   4. `$TMUX_PANE` → tmux_pane
 *   5. `$STY` + `$WINDOW` → screen_window
 *   6. `$TTY` (+ ppid) → tty_session, hashed
 *   7. otherwise → none
 *
 * `tty_session` mixes `parent_shell_pid` so that tmux pane splits or
 * subshells get distinct keys (each forks its own pid) and the key
 * dies with the spawning shell.
 */
export function resolveShellKey(opts: ResolveShellKeyOptions = {}): ShellKey {
  const env = opts.env ?? process.env;
  const ppid = opts.ppid ?? process.ppid;

  const claudeId = env.CLAUDE_SESSION_ID;
  if (claudeId && claudeId.length > 0) {
    return { kind: 'claude_session', value: claudeId };
  }
  // CLAUDE_CODE_SESSION_ID is the fallback for the same claude_session kind.
  // Parent and subagent shells that export one shared id resolve to one pin
  // slot because session-key resolution does not incorporate process identity.
  const claudeCodeId = env.CLAUDE_CODE_SESSION_ID;
  if (claudeCodeId && claudeCodeId.length > 0) {
    return { kind: 'claude_session', value: claudeCodeId };
  }
  const codexId = env.CODEX_SESSION_ID;
  if (codexId && codexId.length > 0) {
    return { kind: 'codex_session', value: codexId };
  }
  const tmuxPane = env.TMUX_PANE;
  if (tmuxPane && tmuxPane.length > 0) {
    return { kind: 'tmux_pane', value: tmuxPane };
  }
  const sty = env.STY;
  const window = env.WINDOW;
  if (sty && sty.length > 0 && window && window.length > 0) {
    return { kind: 'screen_window', value: `${sty}:${window}` };
  }
  const tty = env.TTY;
  if (tty && tty.length > 0) {
    const digest = createHash('sha256').update(`${tty}|${ppid}`).digest('hex').slice(0, 32);
    return { kind: 'tty_session', value: digest };
  }
  return { kind: 'none' };
}

/**
 * Filesystem-safe id derived from a ShellKey. Embedded as the pin file
 * stem (`<shell-key-id>.json`). Hashed because raw values may contain
 * `/`, ` `, `%`, etc. that don't round-trip through filenames cleanly.
 */
export function shellKeyId(key: ShellKey): string {
  if (key.kind === 'none') return 'none';
  const valueHash = createHash('sha256').update(key.value).digest('hex').slice(0, 16);
  return `${key.kind}-${valueHash}`;
}
