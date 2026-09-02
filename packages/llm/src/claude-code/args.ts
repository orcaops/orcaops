import { DEFAULT_CAPTURE_EXCLUDE } from '@orcaops/evaluator-protocol';

import type { Effort } from '../types.js';

/**
 * Secret-path denylist applied to a command-filtered evaluator run. These are
 * Claude permission-rule patterns passed via
 * `--settings '{"permissions":{"deny":[...]}}'`; they bind to the built-in
 * `Read` tool and survive even `--dangerously-skip-permissions` (which we drop
 * in command-filtered mode anyway). This is command filtering, not an OS
 * sandbox: allowed commands and user-level Claude hooks retain the invoking
 * user's ambient access. Exported so the external command-filter test uses the
 * same source of truth.
 */
export const ORCAOPS_CLAUDE_TOOL_DENY_RULES: readonly string[] = [
  // Cloud-provider / cluster / signing credential DIRECTORIES (recursive).
  // These are enumerated rather than covered by a single recursive
  // `Read(~/.*/**)` ON PURPOSE: a recursive home-dotfile rule descends into
  // any dotfile-NAMED directory, so a repo living under one (e.g.
  // ~/.worktrees/<repo>) would have its ENTIRE worktree denied
  // (a deny rule overrides the Read allow grant). Narrowing the old
  // `Read(~/.*)` to `Read(~/.[!/]*)` fixed that worktree-denial bug but
  // also dropped the recursive coverage the old rule gave these credential
  // dirs — so we restore it by naming them explicitly (none of these
  // collide with a plausible worktree path the way a blanket `~/.*` does).
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.azure/**)',
  'Read(~/.gcloud/**)',
  'Read(~/.config/**)', // XDG config root: gcloud ADC + many app token stores
  'Read(~/.kube/**)',
  'Read(~/.docker/**)', // registry auth tokens in ~/.docker/config.json
  'Read(~/.oci/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.password-store/**)',
  'Read(~/.gem/**)',
  'Read(~/.bundle/**)',
  'Read(~/.terraform.d/**)',
  // Any-path credential FILES, in-repo or out, derived from the shared
  // capture-exclude set, so `Read` denies the same paths capture refuses to
  // snapshot. Only `Read` — `Grep` and `Glob` are granted bare and
  // `Bash(git show:*)` renders a committed file body, both of which reach past
  // every rule here; see SECURITY.md's statement that orcaops provides no OS
  // sandbox. Maintaining a second list would be worse either way: a separate
  // copy is how `.env.local`, `credentials.json` and key material stayed
  // readable while `.env` alone was denied — one list cannot drift against
  // itself.
  ...DEFAULT_CAPTURE_EXCLUDE.map((glob) => `Read(//${glob})`),
  // Hidden files DIRECTLY in $HOME (e.g. ~/.netrc, ~/.git-credentials,
  // ~/.pgpass, ~/.npmrc, ~/.vault-token). The `[!/]` class is load-bearing:
  // a bare `Read(~/.*)` recurses into any dotfile-NAMED directory (the
  // worktree-denial bug above), whereas `Read(~/.[!/]*)` matches ONLY files
  // sitting directly in $HOME — so top-level credential FILES stay denied
  // while credential DIRS are handled by the explicit recursive rules above.
  // Verified live against claude 2.1.159: `Read(~/.*)` blocked all repo
  // reads, `Read(~/.[!/]*)` blocks only the home dotfiles.
  'Read(~/.[!/]*)',
];

/**
 * Native + Bash tools granted in `command-filtered` mode, EXCLUDING the `Read`
 * grant (which is path-scoped per-run — see `claudeInspectionTools`). Grep/Glob
 * by bare name; git is allowed only via inspection subcommands (the evaluator
 * inspects the worktree diff itself — `git diff base_sha`, untracked files via
 * `git ls-files --others`). NEVER Write/Edit or non-git Bash. Residual: a
 * `git diff --no-index <out-of-repo>` read is not blocked by the Read denies
 * (it's a Bash subprocess). The first-party step-coverage prompt never invokes
 * `--no-index`.
 */
export const ORCAOPS_CLAUDE_INSPECTION_TOOLS_BASE: readonly string[] = [
  'Grep',
  'Glob',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git status:*)',
  'Bash(git ls-files:*)',
];

/**
 * The full Claude tool allowlist for a run whose working directory is `cwd`.
 * The built-in `Read` tool grant is path-scoped to that directory
 * (`Read(<cwd>/**)`), not bare `Read`: verified live against claude 2.1.159, a bare `Read` in
 * `--allowed-tools` grants the tool but no path, so with `--setting-sources
 * user` (which drops the project/local settings that would trust the cwd)
 * every concrete read came back "directory is denied". Scoping the grant to
 * the working directory restores content reads. This scopes only the built-in
 * `Read` command; it does not confine other commands or the process. The secret
 * denies still override this allow (deny wins), so a matching `.env` stays
 * blocked to `Read` — verified live.
 *
 * RESIDUAL, and not small: the deny rules bind `Read` alone. `Grep` and `Glob`
 * are granted by bare name with no path scope, and `Bash(git show:*)` prints
 * any committed blob — so a credential that is tracked, or one whose contents
 * a `Grep` pattern can enumerate, is reachable despite a matching deny. This is
 * command filtering, not confinement; SECURITY.md states the same.
 *
 * `cwd` must be an ABSOLUTE path (the evaluator runner passes
 * `context.repo.root`); a relative path would scope to the wrong place.
 */
export function claudeInspectionTools(cwd: string): string[] {
  // `//<abs>` is the same absolute-path rule shape the deny list uses
  // (`Read(//**/.env)`); claude resolves `Read(//<abs>/**)` against the real
  // filesystem path. A leading `~` is intentionally NOT expanded here.
  const scoped = cwd.startsWith('/') ? `Read(/${cwd}/**)` : `Read(${cwd}/**)`;
  return [scoped, ...ORCAOPS_CLAUDE_INSPECTION_TOOLS_BASE];
}

export interface BuildClaudeArgsParams {
  /** Model id; null/undefined lets the CLI pick its default. */
  model?: string | null;
  /** Effort level for the call (Claude supports low/medium/high/xhigh/max). */
  effort?: Effort;
  /** Full system prompt override (passed to --system-prompt). */
  systemPrompt?: string;
  /** Per-call USD budget cap (only valid with --print). */
  maxBudgetUsd?: number;
  /** Session id for this one-shot invocation (--session-id, must be a UUID). */
  sessionId?: string;
  /** When set, request structured output via --json-schema. */
  outputSchema?: Record<string, unknown> | null;
  /**
   * Absolute working directory the spawned `claude` runs in. In
   * `command-filtered` mode the built-in `Read` command is granted for this
   * directory (`Read(<readGrantRoot>/**)`) so the evaluator can inspect files —
   * a bare `Read` grant is denied under `--setting-sources user`. Defaults to
   * `process.cwd()` when omitted; callers that set `execa`'s `cwd` MUST pass
   * the same value here or the scope won't match the real working dir.
   */
  readGrantRoot?: string;
  /**
   * Tool-access policy. Absent / `none` keeps the deny-all posture
   * (`--disallowed-tools "*"` + `--dangerously-skip-permissions`).
   * `command-filtered` swaps to an `--allowed-tools` allowlist (Read/Grep/Glob
   * plus selected git inspection commands) and drops
   * `--dangerously-skip-permissions` so the
   * `--settings` deny rules are actually enforced (bypass mode would nullify
   * them). This is a command policy, not process or filesystem confinement.
   * Effectively Claude-only; the Codex provider configures its own tools.
   */
  toolPolicy?: { mode: 'none' | 'command-filtered' };
  /**
   * Secret-path deny rules to inject via `--settings` when
   * `toolPolicy.mode === 'command-filtered'`. Defaults to
   * `ORCAOPS_CLAUDE_TOOL_DENY_RULES`.
   * Ignored in `none` mode.
   */
  denyRules?: readonly string[];
}

/**
 * Build CLI arguments for a `claude` invocation tuned for orcaops evaluator
 * runs. Choices that differ from the agent's primary session:
 *
 *   --no-session-persistence   evaluator runs are ephemeral.
 *   --disallowed-tools "*"     deny all tools (evaluators must not read or
 *                              write files, run shell commands, etc.).
 *   --output-format stream-json + --verbose
 *                              line-delimited JSON we can parse for cost,
 *                              tokens, and the `result` event.
 *
 * Project-context isolation (without `--bare`): an evaluator must grade the
 * captured artifact, not inherit the project's own instructions/automation.
 * We isolate it from project context with three auth-safe, cwd-safe levers:
 *
 *   --setting-sources user     load ONLY user settings, dropping project +
 *                              local settings — i.e. project/local hooks. A
 *                              project PreToolUse hook could otherwise block
 *                              the evaluator's reads or inject text that
 *                              corrupts our stream-json parsing.
 *   --strict-mcp-config        use only MCP servers from --mcp-config (we pass
 *                              none), ignoring auto-discovered `.mcp.json` and
 *                              the user/local MCP in ~/.claude.json — dropping
 *                              MCP startup latency + tools the evaluator can't
 *                              use anyway under --disallowed-tools "*".
 *   CLAUDE_CODE_DISABLE_CLAUDE_MDS=1  (set in buildClaudeEnv)
 *                              prevents loading any CLAUDE.md memory (project,
 *                              user, auto), shrinking the prompt-injection
 *                              surface and ~25k tokens of per-run cache priming.
 *
 * Why NOT `--bare` (it would drop all of the above too): `--bare` additionally
 * disables OAuth and keychain reads, forcing ANTHROPIC_API_KEY-only auth and
 * breaking the piggyback model (the user's `claude login` session is
 * unusable). The three levers achieve the same project-context isolation while
 * preserving login auth — auth lives in ~/.claude.json (the OAuth session),
 * which `--setting-sources` does not touch.
 *
 * Deliberately NOT changed: cwd stays the repo root (see the evaluator runner)
 * so a future file-reading evaluator keeps worktree access. Residual: the
 * user's own user-global hooks (~/.claude/settings.json) still fire; they can
 * self-guard via `CLAUDE_CODE_ENTRYPOINT === 'orcaops-evaluator'`.
 */
export function buildClaudeArgs(params: BuildClaudeArgsParams): string[] {
  const toolPolicyMode = params.toolPolicy?.mode as unknown;
  if (
    params.toolPolicy !== undefined &&
    toolPolicyMode !== 'none' &&
    toolPolicyMode !== 'command-filtered'
  ) {
    throw new TypeError(
      `Unsupported Claude tool policy mode ${JSON.stringify(toolPolicyMode)}; ` +
        `expected "none" or "command-filtered".`
    );
  }
  const commandFiltered = toolPolicyMode === 'command-filtered';
  const args: string[] = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--no-session-persistence',
  ];

  if (commandFiltered) {
    // Claude command filter. The flags work together (verified live against
    // claude 2.1.159):
    //   --permission-mode acceptEdits  auto-accepts the allow-listed tools in
    //       headless mode (it cannot prompt) WHILE still honoring deny rules.
    //       This is the load-bearing choice: plain `default` mode can't grant
    //       a tool non-interactively (every read comes back "no permission"),
    //       and `bypassPermissions` (== --dangerously-skip-permissions) grants
    //       everything but IGNORES deny rules — nullifying the denylist.
    //       acceptEdits is the only mode that both enables reads and enforces
    //       the denylist.
    //   --allowed-tools …             readers + git inspection commands.
    //       the Read grant is PATH-SCOPED to the worktree (`Read(<cwd>/**)`),
    //       not bare `Read`. A bare grant + `--setting-sources user` denies
    //       every concrete read ("directory is denied") — a bare grant gives
    //       the tool but no path, and `--setting-sources user` drops the
    //       project/local settings that would otherwise trust the cwd.
    //   --settings {permissions.deny} the secret-path denylist; a deny
    //       overrides the path-scoped allow, so an in-repo `.env` stays
    //       blocked (verified live).
    // So we DROP --dangerously-skip-permissions here (present only in the
    // deny-all branch, where it's safe because nothing is allowed at all).
    const denyRules = params.denyRules ?? ORCAOPS_CLAUDE_TOOL_DENY_RULES;
    const readGrantRoot = params.readGrantRoot ?? process.cwd();
    args.push('--permission-mode', 'acceptEdits');
    args.push('--allowed-tools', ...claudeInspectionTools(readGrantRoot));
    args.push('--settings', JSON.stringify({ permissions: { deny: [...denyRules] } }));
  } else {
    // Default deny-all posture. skip-permissions is safe here because no
    // tool is allowed at all.
    args.push('--dangerously-skip-permissions', '--disallowed-tools', '*');
  }

  // Project-context isolation without --bare (see the doc-comment above).
  args.push('--setting-sources', 'user', '--strict-mcp-config');

  if (params.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', params.maxBudgetUsd.toFixed(4));
  }

  if (params.model) {
    args.push('--model', params.model);
  }

  if (params.effort) {
    args.push('--effort', params.effort);
  }

  if (params.systemPrompt !== undefined) {
    args.push('--system-prompt', params.systemPrompt);
  }

  if (params.outputSchema) {
    args.push('--json-schema', JSON.stringify(params.outputSchema));
  }

  if (params.sessionId !== undefined) {
    args.push('--session-id', params.sessionId);
  }

  args.push('-p', '-');

  return args;
}

/**
 * Environment variables we set for every spawned `claude` process.
 * - CI=true and TERM=dumb keep the CLI in non-interactive output mode.
 * - CLAUDE_CODE_ENTRYPOINT lets users grep their process list and tell
 *   evaluator runs apart from their primary agent session.
 * - CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 prevents loading any CLAUDE.md memory
 *   (project, user, auto) into the evaluator's context. It is memory-only —
 *   it does not affect auth or cwd — and is the CLAUDE.md half of the
 *   project-context isolation documented on buildClaudeArgs.
 */
export function buildClaudeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: 'orcaops-evaluator',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CI: 'true',
    TERM: 'dumb',
    // Same rationale as CLAUDE_MDS above, for the session-hook surface: an
    // installed orcaops SessionStart hook must not inject capture guidance
    // into evaluator runs (the hook honors this suppress var).
    ORCAOPS_HOOK_SUPPRESS: '1',
  };
}
