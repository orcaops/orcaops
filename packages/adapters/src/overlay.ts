import type { AgentType } from '@orcaops/agent-targets';

import type { SessionHooksSurface, SubagentOrchestration, ToolId } from './types.js';

/**
 * orcaops install overlay.
 *
 * The vendored `@orcaops/agent-targets` registry supplies skill *placement*
 * (`skillsDir`, `globalSkillsDir`, `detectInstalled`) for ~71 agents, but it has
 * no notion of orcaops's instruction-file injection or slash commands. This
 * overlay adds that orcaops-owned surface, keyed by tool id.
 *
 * It is also the install-target gate: **an agent is an orcaops install target
 * only if it has an overlay entry here.** Registry-only agents are detectable
 * but not installable, so `init`/`update`/`doctor` never hit an undefined
 * instruction/command surface.
 */
export interface AgentOverlay {
  /** Which vendored registry row supplies `skillsDir`/`globalSkillsDir`/detection. */
  registryAgent: AgentType;
  /** Orcaops-owned display name, such as `Codex CLI`. */
  name: string;
  /** Stability marker surfaced by `orcaops doctor` / `orcaops update`. */
  status: 'stable' | 'beta' | 'experimental';
  /**
   * Repo-relative instruction files the bootstrap block is injected into. The
   * managed block is always project-scoped (never global).
   */
  instructionFiles: string[];
  /** Whether this agent supports orcaops slash commands. */
  supportsCommands: boolean;
  /**
   * Per-agent command base, **prefix-free**. The prefix placement is computed
   * at render time from `commandLayout` (`${commandRoot}/${prefix}/` nested or
   * `${commandRoot}/${prefix}-` flat). Required when `supportsCommands` is true.
   */
  commandRoot?: string;
  /**
   * Command file placement (see `CommandRendererOptions.layout`). Required when
   * `supportsCommands` is true. `flat` exists for agents whose command loader
   * skips subdirectories (Cursor CLI).
   */
  commandLayout?: 'nested' | 'flat';
  /**
   * Command frontmatter shape (see `CommandRendererOptions.frontmatter`).
   * Required when `supportsCommands` is true. NOTE for future command
   * templates: bodies must avoid `$ARGUMENTS`-style placeholders until the
   * renderer learns per-agent arg syntax — AiderDesk substitutes only
   * `{{ARGUMENTS}}`/`{{n}}`, and Cursor arg interpolation is unverified.
   */
  commandFrontmatter?: 'full' | 'minimal' | 'none';
  /**
   * Global command base for `--scope global`. Absent → commands are
   * project-only. Global *skills* use the registry `globalSkillsDir`.
   */
  globalCommandRoot?: string;
  /**
   * Whether the skill frontmatter carries a `tags:` line. Claude Code does;
   * Codex omits it. Kept per-agent so generated files are byte-identical.
   */
  skillFrontmatterTags: boolean;
  /** Agent-specific enrichment orchestration rendered into seed skills. */
  subagentOrchestration: SubagentOrchestration;
  /**
   * Session-start hook surface — the top rung of the bootstrap ladder
   * (session hooks > instruction block > manual). Absent → no supported
   * session-hook modality; the init recommendation then falls to the
   * instruction block. Deferred agents:
   * - github-copilot: the Copilot CLI runs sessionStart hooks but IGNORES
   *   their output (no context injection — side effects only); VS Code agent
   *   mode reads Claude-format .claude/settings.json, so it rides
   *   claude-code's entry for free.
   * - aider-desk: automation surface is a JS/TS extension system, not a
   *   declarative hook config.
   * - antigravity-cli: no session-start hook event (nearest is per-turn
   *   PreInvocation, which needs fire-once state keyed on session id).
   */
  sessionHooks?: SessionHooksSurface;
}

/**
 * The overlay-backed install targets, in `SUPPORTED_AGENT_IDS` order (the
 * lockstep is asserted by overlay.test.ts). Status reflects the confidence in
 * the whole installed surface, not an agent's popularity.
 */
export const AGENT_OVERLAYS: Partial<Record<ToolId, AgentOverlay>> = {
  'claude-code': {
    registryAgent: 'claude-code',
    name: 'Claude Code',
    status: 'stable',
    // Claude Code auto-loads both CLAUDE.md and AGENTS.md from the repo root.
    instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
    supportsCommands: true,
    commandRoot: '.claude/commands',
    commandLayout: 'nested',
    commandFrontmatter: 'full',
    globalCommandRoot: undefined,
    skillFrontmatterTags: true,
    subagentOrchestration: 'parallel',
    // SessionStart hook stdout is added to the model's context verbatim.
    // Matcher skips `compact` (post-compact summaries retain instructions;
    // revisit if capture guidance drops out after compaction) and `fork`.
    sessionHooks: {
      kind: 'settings-json',
      path: '.claude/settings.json',
      payload: 'text',
      matcher: 'startup|resume|clear',
      // User-settings hooks apply in every project (documented); Claude Code
      // merges user + project settings and runs all matching entries — the
      // hook command's --user arbitration prevents double emission.
      userFile: 'settings.json',
    },
  },
  codex: {
    registryAgent: 'codex',
    name: 'Codex CLI',
    // Stable: AGENTS.md auto-load, `.agents/skills` discovery, and capture
    // attribution (`--invoked-by-agent codex`) are all exercised surfaces.
    status: 'stable',
    // Codex auto-loads AGENTS.md (not CLAUDE.md); custom prompts are deprecated,
    // so it ships skills only.
    instructionFiles: ['AGENTS.md'],
    supportsCommands: false,
    skillFrontmatterTags: false,
    subagentOrchestration: 'none',
    // Codex hooks — live-validated against shipped codex-cli 0.146.0:
    // `.codex/hooks.json` is never read (repo- or user-level), while the
    // config.toml file-form registration works end-to-end (upstream flux
    // openai/codex#17532/#21639). Hooks register via a `hooks` struct in
    // config.toml gated by `[features].hooks`, and plain-text stdout is
    // REJECTED: injection requires the hookSpecificOutput JSON envelope
    // (payload 'codex-json'; the hook command emits it). There is no project
    // settings surface: `machine-config` keeps codex session-hook capable
    // while the settings-file planner skips it — the only registration is
    // the config.toml snippet/managed flow in `orcaops session-hooks
    // install`.
    sessionHooks: {
      kind: 'machine-config',
      path: 'config.toml',
      payload: 'codex-json',
      // NO userFile: machine registration is the bespoke config.toml
      // snippet/managed flow in session-hooks-user.ts, not the
      // settings-json userFile machinery.
    },
  },
  cursor: {
    registryAgent: 'cursor',
    name: 'Cursor',
    status: 'experimental',
    // Cursor reads AGENTS.md natively.
    instructionFiles: ['AGENTS.md'],
    supportsCommands: true,
    commandRoot: '.cursor/commands',
    // FLAT + no frontmatter: the Cursor CLI reads only top-level .md files and
    // parses no command frontmatter (name = filename); the IDE reads the same
    // flat files, so flat keeps one layout working in both.
    commandLayout: 'flat',
    commandFrontmatter: 'none',
    // REQUIRED false: cursor shares the universal `.agents/skills` dir with
    // codex and opencode — the install planner dedupes generated files by path
    // first-wins, so agents sharing a skillsDir must render byte-identical
    // skills (enforced by the shared-dir parity test in overlay.test.ts).
    skillFrontmatterTags: false,
    subagentOrchestration: 'none',
    // Cursor parses sessionStart hook stdout as JSON: `additional_context`
    // (snake_case) injects into the conversation. hooks.json is documented as
    // VCS-checked and auto-reloads on change (no restart needed). No matcher
    // support — the hook fires every session; the payload is short.
    sessionHooks: {
      kind: 'settings-json',
      path: '.cursor/hooks.json',
      payload: 'cursor-json',
      // No userFile: hooks.json is documented as a project (VCS-checked)
      // file, and no ~/.cursor/hooks.json machine-level surface is verified
      // against a live Cursor build. The user planner keys machine-level
      // registration on this row's presence.
    },
  },
  opencode: {
    registryAgent: 'opencode',
    name: 'OpenCode',
    // Beta: shares the whole install surface with codex (AGENTS.md +
    // universal `.agents/skills`, byte-identical renders enforced by the
    // shared-dir parity test), plus a command tree verified against
    // OpenCode's documented nested-command behavior. Held below stable
    // pending broader live validation.
    status: 'beta',
    // OpenCode auto-loads AGENTS.md.
    instructionFiles: ['AGENTS.md'],
    supportsCommands: true,
    // Nested dirs are supported and name commands by path: /orcaops/<verb>.
    commandRoot: '.opencode/commands',
    commandLayout: 'nested',
    // `description` is honored; unknown frontmatter keys are ignored, but
    // minimal keeps us off the undocumented surface.
    commandFrontmatter: 'minimal',
    skillFrontmatterTags: false, // universal `.agents/skills` — see cursor note
    subagentOrchestration: 'none',
    // BETA: OpenCode has no declarative hook config — a generated plugin in
    // `.opencode/plugins/` self-registers by existing and injects via a
    // one-shot `chat.message` handler (in the published plugin types; known
    // TUI display quirk). `experimental.chat.system.transform` was rejected
    // (absent from published types — silently discarded on some versions).
    sessionHooks: {
      kind: 'plugin-file',
      path: '.opencode/plugins',
      payload: 'text',
      // No userFile: a machine-wide auto-loading plugin under
      // ~/.config/opencode/plugin is a weak consent story, and the PROJECT
      // plugin surface is itself beta without live validation.
    },
  },
  'aider-desk': {
    registryAgent: 'aider-desk',
    name: 'AiderDesk',
    status: 'experimental',
    // ASSUMPTION: AiderDesk documents no project instruction file; AGENTS.md is
    // the multi-tool convention and is already the canonical union member, so
    // this adds no extra file when combined with other agents.
    instructionFiles: ['AGENTS.md'],
    supportsCommands: true,
    // Nested dirs are supported and name commands by path: /orcaops/<verb>.
    commandRoot: '.aider-desk/commands',
    commandLayout: 'nested',
    // AiderDesk REQUIRES `description` in command frontmatter; unknown-key
    // tolerance is undocumented, so minimal emits exactly that one key.
    commandFrontmatter: 'minimal',
    skillFrontmatterTags: false, // own dir (.aider-desk/skills); false for consistency
    subagentOrchestration: 'none',
    // No sessionHooks: extension system, not declarative — see the interface doc.
  },
  'github-copilot': {
    registryAgent: 'github-copilot',
    name: 'GitHub Copilot',
    status: 'experimental',
    // Copilot CLI, cloud agent, and VS Code agent mode all auto-load AGENTS.md.
    instructionFiles: ['AGENTS.md'],
    // Skills-only, like codex: the Copilot CLI and VS Code surface installed
    // skills as /skill-name slash commands natively, and the CLI has no
    // prompt-file mechanism (VS Code prompt files are a separate preview
    // surface with a .prompt.md suffix the renderer doesn't emit).
    supportsCommands: false,
    skillFrontmatterTags: false, // universal `.agents/skills` — see cursor note
    subagentOrchestration: 'none',
    // No sessionHooks: Copilot CLI ignores sessionStart output — see the interface doc.
  },
  'antigravity-cli': {
    registryAgent: 'antigravity-cli',
    name: 'Antigravity CLI',
    status: 'beta',
    // Antigravity loads AGENTS.md and uses the universal Agent Skills path.
    // Skills surface as commands natively, so no separate command renderer.
    //
    // KNOWN GAP: the vendored registry also has an `antigravity` row (the IDE,
    // detected via ~/.gemini/antigravity) with no overlay here. An IDE-only
    // user therefore detects as `antigravity`, finds no install target, and
    // silently gets nothing. Deliberate: only the CLI surface is validated in
    // a live session, and guessing the IDE's skill discovery would ship an
    // untestable target.
    instructionFiles: ['AGENTS.md'],
    supportsCommands: false,
    skillFrontmatterTags: false, // universal `.agents/skills` — see cursor note
    subagentOrchestration: 'none',
    // No sessionHooks: no session-start hook event — see the interface doc.
  },
};

export function getAgentOverlay(id: ToolId): AgentOverlay | undefined {
  return AGENT_OVERLAYS[id];
}

/** Tool ids that are overlay-backed install targets, in declaration order. */
export function overlayBackedToolIds(): ToolId[] {
  return Object.keys(AGENT_OVERLAYS) as ToolId[];
}
