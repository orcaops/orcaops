import type { SkillId } from '@orcaops/storage';

export { SKILL_IDS, type SkillId } from '@orcaops/storage';

/**
 * The agent tools we ship adapters for — the INSTALL id space, aligned with the
 * vendored registry ids (`aider-desk`, not the capture identity `aider`).
 */
export type ToolId =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'opencode'
  | 'aider-desk'
  | 'github-copilot'
  | 'antigravity-cli';

/**
 * Skill grouping for the enable/disable surface. This is the CANONICAL
 * union — used verbatim by the enabled-set resolver, `orcaops skills list`,
 * the lifecycle-disable warning (which keys on `'lifecycle'`), and the
 * managed AGENTS.md block's section builders.
 */
export type SkillGroup =
  | 'lifecycle'
  | 'read'
  | 'insight'
  | 'review'
  | 'orchestration'
  | 'authoring';

/**
 * Capabilities a skill can require (capability gating). A template whose
 * `requires` is unsatisfied by the current CLI/config does NOT materialize,
 * regardless of enable overrides. The union grows as gated features land —
 * additively, never restructured.
 * `snapshot-checkout` + `matcher` both derive from
 * `diff_fingerprint.enabled` (the snapshot/fingerprint kill-switch); two
 * names are kept for independent future knobs.
 * `cloud` is the only capability keyed on machine state rather than repo
 * config, and the only one whose unsatisfied templates are hidden outright
 * rather than reported as gated.
 */
export type SkillCapability =
  | 'diff-fingerprint'
  | 'archive'
  | 'snapshot-checkout'
  | 'matcher'
  | 'cloud';

export type SubagentOrchestration = 'parallel' | 'none';

export interface SkillBodyOptions {
  subagentOrchestration?: SubagentOrchestration;
}

/**
 * Skill metadata + body. Skills are markdown files the agent loads
 * automatically; the body tells the agent WHEN to fire which CLI command
 * and WHAT JSON shape to pass.
 *
 * The default id space is the shipped registry. Low-level renderers and tests
 * may opt into `SkillTemplate<string>` for third-party/synthetic templates,
 * while shipped templates and cross-skill references stay closed over
 * `SkillId`.
 */
export interface SkillTemplate<Id extends string = SkillId> {
  /**
   * Bare-verb slug (no extension, no prefix), e.g. 'capture'. The installed
   * directory is `${prefix}-${id}` (default prefix `orcaops`), computed at
   * render time by the skill renderer.
   */
  id: Id;
  /** Title shown to the user / agent in skill listings. */
  name: string;
  /** One-line description shown alongside the title. */
  description: string;
  /** Optional tags surfaced by tools that support them. */
  tags?: string[];
  /**
   * The skill body — the actual instructions the agent reads. Either a static
   * string, or a `(prefix) => string` for bodies that cross-reference sibling
   * skills/commands (via `skillRef`/`commandRef`), so those references render
   * under the active naming prefix. `format()` resolves either form.
   */
  body: string | ((prefix: string, options?: SkillBodyOptions) => string);
  /**
   * Skill group. Drives grouping in `orcaops skills list` and the
   * lifecycle-disable warning. The SKILL.md renderer ignores it (zero byte
   * churn in generated files).
   */
  group?: SkillGroup;
  /** Enable default. Absent ⇒ enabled. Renderer-ignored. */
  defaultEnabled?: boolean;
  /** Required skills ignore disable overrides and cannot be disabled. Renderer-ignored. */
  required?: boolean;
  /**
   * Capabilities this skill needs. Unsatisfied ⇒ excluded from the
   * enabled set regardless of overrides. Renderer-ignored.
   */
  requires?: SkillCapability[];
  /**
   * Emit `disable-model-invocation: true` into the rendered frontmatter, so the
   * agent surfaces the skill but never auto-fires it — the human invokes it.
   * Emitted for every adapter; only Claude Code enforces it today, so treat it
   * as a preference and never as a safety boundary. Absent ⇒ the key is omitted
   * entirely, keeping every existing skill byte-identical.
   */
  disableModelInvocation?: boolean;
  /**
   * One-line trigger entry for the managed AGENTS.md/CLAUDE.md block (the
   * auto-trigger bootstrap): a `"Read intents"`-style cue mapping user
   * phrasing to this skill. Consumed by the enabled-set-aware block
   * rendering; absent ⇒ the skill contributes no block trigger line.
   * String or `(prefix) => string`, like `body`. Renderer-ignored for
   * SKILL.md output.
   */
  blockTriggerLine?: string | ((prefix: string) => string);
}

/**
 * Slash command metadata + body. Commands are user-facing convenience
 * triggers like `/orcaops:status`. The body describes what the command
 * does + how the agent should run it.
 */
export interface CommandTemplate {
  /**
   * Bare-verb slug (no extension, no prefix), e.g. 'status'. The user-facing
   * name (`${prefix}:${id}`) and the file path are both derived at render time.
   */
  id: string;
  /** One-line description. */
  description: string;
  /** Optional tags. */
  tags?: string[];
  /**
   * The command body. Either a static string, or a `(prefix) => string` for
   * bodies that cross-reference sibling commands/skills (via
   * `commandRef`/`skillRef`) so they render under the active naming prefix.
   */
  body: string | ((prefix: string) => string);
}

/**
 * Session-start hook surface for one agent — the top rung of the bootstrap
 * ladder (session hooks > instruction block > manual). Declared per agent in
 * the overlay; consumed by the CLI's session-hook planner and the
 * `orcaops hook session-start` output formatter.
 */
export interface SessionHooksSurface {
  /**
   * `settings-json` = an orcaops-managed entry inside the agent's declarative
   * hook-config file (co-owned with the user; identified by the
   * `orcaops hook session-start` command substring, never a stamp).
   * `plugin-file` = a wholly orcaops-owned generated plugin that
   * self-registers by existing (OpenCode).
   * `machine-config` = the agent has session-hook support but NO project
   * file surface at all — registration lives solely in the agent's user
   * config home behind the consent-gated `orcaops session-hooks install`
   * flow (Codex: the config.toml `hooks` struct). The row's existence keeps
   * the agent session-hook CAPABLE (emission gate, init interview) while
   * every settings-file planner skips it.
   */
  kind: 'settings-json' | 'plugin-file' | 'machine-config';
  /**
   * Repo-relative settings file (`settings-json`), plugin directory
   * (`plugin-file`), or the config file name under the agent's user config
   * home (`machine-config` — the home dir itself is CLI-resolved).
   */
  path: string;
  /**
   * stdout shape `orcaops hook session-start` must emit for this agent:
   * `text` = plain text added to context verbatim; `cursor-json` =
   * `{"additional_context": "..."}` (Cursor parses JSON-on-stdout);
   * `codex-json` = the `hookSpecificOutput.additionalContext` envelope
   * (codex-cli 0.146+ rejects plain text — live-validated).
   */
  payload: 'text' | 'cursor-json' | 'codex-json';
  /** Session-start source matcher, for agents whose hook schema supports one. */
  matcher?: string;
  /**
   * The agent's user-level JSON hook file (e.g. `settings.json` under
   * `~/.claude`, `hooks.json` under `~/.codex`) for MACHINE-level
   * registration — the consent-gated `orcaops session-hooks install`
   * surface. Absent → the agent's hook surface is project-only. The home dir
   * itself is resolved by the CLI (env-overridable), never here.
   *
   * On a `machine-config` row only the USER-level planner honours this; the
   * project settings planner still writes nothing for that agent.
   */
  userFile?: string;
}

/**
 * Per-tool adapter. Each tool has its own preferred file paths and
 * frontmatter format; the adapter encapsulates both.
 */
export interface ToolAdapter {
  /** Unique tool id. */
  id: ToolId;
  /** Display name. */
  name: string;
  /** Stability marker shown by `orcaops doctor` and `orcaops update`. */
  status: 'stable' | 'beta' | 'experimental';
  /** Skill rendering. Returns null when the tool doesn't support skills. */
  skills: SkillRenderer | null;
  /** Slash-command rendering. Returns null when the tool doesn't support commands. */
  commands: CommandRenderer | null;
  /**
   * Repo-relative paths the orcaops bootstrap section should be injected
   * into (e.g. ['AGENTS.md', 'CLAUDE.md']). The section is written to
   * each path independently, idempotently, between markers. Skills load
   * but don't auto-trigger reliably; this section is what tells the
   * agent WHEN to invoke them at session start. Null disables.
   */
  agentsFiles: string[] | null;
  /**
   * Session-start hook surface (overlay-declared). Null when the agent has no
   * supported session-hook modality — the bootstrap ladder then falls to the
   * instruction block.
   */
  sessionHooks: SessionHooksSurface | null;
}

export interface SkillRenderer {
  /**
   * Returns a path RELATIVE to repoRoot for the given bare-verb skill id. The
   * installed directory is `${prefix}-${skillId}` (default prefix `orcaops`).
   */
  filePath(skillId: string, prefix?: string): string;
  /** Renders the on-disk content (frontmatter + body). */
  format(skill: SkillTemplate<string>, opts: RenderOptions): string;
}

export interface CommandRenderer {
  /**
   * Returns a repo-relative path for the given bare-verb command id. The
   * namespace dir is `${commandRoot}/${prefix}/` (default prefix `orcaops`).
   */
  filePath(commandId: string, prefix?: string): string;
  format(command: CommandTemplate, opts: RenderOptions): string;
}

export interface RenderOptions {
  /** orcaops package version stamped into generated files for staleness checks. */
  generatedBy: string;
  /** Naming prefix (default `orcaops`); drives derived command names + paths. */
  prefix?: string;
}
