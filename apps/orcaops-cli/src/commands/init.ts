import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { getAgentOverlay, type ToolId } from '@orcaops/adapters';
import { configLocationForScope, Repo, resolveConfigSource } from '@orcaops/core';
import {
  assertConfigVersionCurrent,
  type Config,
  CONFIG_SCHEMA_VERSION,
  ConfigValidationError,
  getDefaultConfig,
  hasArtifactEventLogs,
  isAcceptedConfigVersion,
  resolveConfig,
  type SupportedAgentId,
} from '@orcaops/storage';

import { type BackfillArtifactIssue, enableArchiveAndBackfillForInit } from './archive.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  scrubOutboundText,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { buildConfigDelta } from '../lib/config-delta.js';
import {
  displayConfigPath,
  refuseTrackedPersonalTransition,
  resolvePersonalConfigForAdoption,
  trackedProjectInstallPaths,
} from '../lib/config-file.js';
import { ORCAOPS_BASE_GITIGNORE, reconcileGitignore } from '../lib/gitignore.js';
import {
  type GlobalInstallLockScope,
  type GlobalInstallManifest,
  type GlobalInstallResult,
  planGlobalInstall,
  readGlobalManifest,
  releaseGlobalRefs,
  resolveGlobalRoot,
  resolveGlobalSkillsDir,
  withGlobalInstallLock,
} from '../lib/global-install.js';
import {
  derivedIgnoreGlobs,
  isInteractiveInit,
  parseInstallAgentFlags,
  resolveInstallAgents,
} from '../lib/install-agents.js';
import { INSTALL_MANIFEST_REL, readInstallManifest } from '../lib/install-manifest.js';
import {
  assertInvisiblePlan,
  planInstallMutations,
  publishInstallManifestsLast,
} from '../lib/install-plan.js';
import type { InstructionFileAction } from '../lib/instruction-placement.js';
import {
  getInvocationCwd,
  getInvocationEnv,
  getInvocationRootOverride,
} from '../lib/invocation-context.js';
import {
  deleteMutation,
  executeMutations,
  type GitHookAction,
  type MutationMode,
  planGitHookMutation,
  type PlannedMutation,
  readRepositoryFileForOwnership,
  readRepositoryFileOrNull,
  writeMutation,
} from '../lib/mutations.js';
import { readEffectiveLocalManifest } from '../lib/personal-manifest.js';
import { ensureProjectId, readProjectId } from '../lib/project-identity.js';
import { withRepositoryInstallLock } from '../lib/repository-install-lock.js';
import { bestEffortRealpath, discoverGitRoot } from '../lib/resolve-root.js';
import {
  type AppliedUserSessionHookInstall,
  applyUserSessionHookInstall,
  codexSessionHookGuidance,
  promptUserSessionHookInstall,
  stagedUserSessionHookAgents,
  type StagedUserSessionHookInstall,
} from '../lib/session-hooks-install.js';
import {
  codexConfigTomlPath,
  codexHooksJsonPath,
  userHookCapableAgents,
} from '../lib/session-hooks-user.js';
import {
  SESSION_HOOK_RESTART_NOTICE,
  sessionHookCapableAgents,
  type SessionHookFilePlan,
  sessionHooksRestartRequired,
} from '../lib/session-hooks.js';
import {
  editArchiveEnabled,
  editBlockChoice,
  editGeneratedFiles,
  editGitHooksConfirm,
  editHints,
  editHintsCustom,
  editLink,
  editPrefix,
  editScope,
  editSessionHookEntries,
  editSessionHooksChoice,
} from '../lib/settings-edit.js';
import { customizeMorePrompt } from '../lib/settings-prompts.js';
import {
  enabledSkillTemplates,
  gateWithheldSkillTemplates,
  resolveSkillGates,
} from '../lib/skill-set.js';

export interface InitOptions {
  force?: boolean;
  /** With `--force`, replace config with current defaults instead of preserving it. */
  resetConfig?: boolean;
  noLlm?: boolean;
  json?: boolean;
  cwd?: string;
  /** Initialize in `cwd` even if it is not the git worktree root. */
  here?: boolean;
  /** Explicit placement root for `.orcaops` (the `--root` flag). Ignores ORCAOPS_ROOT. */
  root?: string;
  /**
   * Repeatable `--install-agent <id>`: the INSTALL set — which
   * overlay-backed agents to generate skills/commands/blocks for. When omitted,
   * a real interactive TTY presents a checklist (default = detected); a
   * non-interactive context uses the deterministic default seed.
   */
  installAgent?: string[];
  /** Comma-separated install set (alias for repeated `--install-agent`). */
  agents?: string;
  /** `--yes`: non-interactive — skip the agent-selection prompt, use defaults. */
  yes?: boolean;
  /**
   * Generated-files git mode: `commit` (default, generated trees tracked in
   * git) or `ignore` (gitignore the generated trees with adapter-derived globs; each dev
   * materializes locally via the first-run nudge).
   */
  generatedFiles?: 'commit' | 'ignore';
  /**
   * Install scope: `personal` (fresh-init default — invisible: global
   * skills, footprint hidden via info/exclude, zero tracked writes),
   * `project` (committed in-repo trees — the team-adoption mode), or
   * `global`. Persisted to config.json.
   */
  scope?: 'project' | 'global' | 'personal';
  /** Shorthand for scope 'personal' (the invisible default). */
  personal?: boolean;
  /** Global materialization: `copy` (default, safe) or `symlink`. Persisted. */
  link?: 'copy' | 'symlink';
  /**
   * Explicit instruction-file choice. True opts into the managed lifecycle
   * block; false opts out. Undefined lets interactive init recommend the block
   * and defaults unattended fresh init to manual. Existing config is preserved.
   */
  agentsMd?: boolean;
  /**
   * Tri-state session-hooks choice — the top rung of the bootstrap ladder
   * (session hooks > instruction block > manual). True enables (persisted to
   * `config.session_hooks.enabled`); false disables; undefined lets a fresh
   * interactive init recommend them when any selected agent is hook-capable,
   * while unattended fresh init stays disabled (same no-surprise asymmetry as
   * the archive). Existing config is preserved.
   */
  sessionHooks?: boolean;
  /**
   * Session-hook payload mode (persisted to `config.session_hooks.payload`).
   * Orthogonal to `sessionHooks`: sets the mode only, never implicitly
   * enables — the mode takes effect while session hooks are enabled. When
   * given interactively it seeds the select prompt's initial value.
   */
  sessionHookPayload?: 'static' | 'state-aware';
  /**
   * Which registration carries the hook in this repo (persisted to
   * `config.session_hooks.entries`): `project` (default) writes repo
   * settings entries; `none` relies on the machine-level registration
   * (`orcaops session-hooks install`) — `enabled` then gates emission only.
   */
  sessionHookEntries?: 'project' | 'none';
  /**
   * Skill/command naming prefix (default `orcaops`). Lowercase,
   * hyphen-safe — e.g. `oo` installs `oo-capture` skills and a managed block that
   * references them. Set once at init; changing it on an existing repo needs the
   * prune machinery.
   */
  prefix?: string;
  /**
   * Opt-in: install `post-merge` and `post-rewrite` git hooks that
   * re-run `orcaops lineage` so artifact lineage stays current after
   * rebases / merges / amends without manual intervention. Default
   * off (per architecture: some users manage hooks via husky /
   * lefthook and want to wire it themselves).
   */
  withHooks?: boolean;
  /** Plan and print the changes without writing anything. */
  dryRun?: boolean;
}

export async function initAction(opts: InitOptions = {}): Promise<void> {
  try {
    const raw = await runInit(opts);
    // Warnings interpolate raw fs/parse error text (machine-hook applies,
    // archive backfill issues) — scrub once here, ahead of both exits.
    const result = { ...raw, warnings: raw.warnings.map(scrubOutboundText) };
    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(formatHumanInitResult(result));
  } catch (err) {
    // A user cancel is a control-flow exit, not an error to render.
    if (err instanceof InitCancelled) {
      const { cancel } = await import('@clack/prompts');
      cancel('Nothing was written.');
      throw new CliExit(1);
    }
    const renderedError =
      err instanceof ConfigValidationError
        ? new OrcaopsError(ErrorCodes.INVALID_CONFIG, err.message, err.path)
        : err;
    if (opts.json) {
      emitError(renderedError);
    }
    if (renderedError instanceof OrcaopsError) {
      writeErrorLine(renderedError);
      throw new CliExit(1);
    }
    throw err;
  }
}

class InitCancelled extends Error {}

function requireInitAnswer<T>(value: T | null): T {
  if (value === null) throw new InitCancelled();
  return value;
}

/**
 * The frozen public agents_md entry shape. Divergence detail (ahead stamps,
 * forced downgrades) is emitted only via `preserved_ahead` and warnings.
 */
interface AgentsMdResult {
  path: string;
  action: InstructionFileAction;
}

interface GitHookResult {
  /** Path relative to repoRoot, e.g. ".git/hooks/post-merge". */
  path: string;
  action: GitHookAction;
}

interface InitResult {
  repo_root: string;
  created: string[];
  config_path: string;
  gitignore_added: string[];
  llm_tool: 'auto' | 'claude' | 'codex' | 'none';
  detected_llm_tool: 'claude' | 'codex' | null;
  /** Primary install agent (first of `install_agents`); null when none. */
  agent_tool: ToolId | null;
  /** The full install set. */
  install_agents: SupportedAgentId[];
  /** Install scope: project (default) or global. */
  scope: 'project' | 'global' | 'personal';
  /** Global materialization result when scope=global; null otherwise. */
  global: {
    materialized: string[];
    removed: string[];
    copy_fallbacks: string[];
    skipped_version_mismatch: boolean;
    materialized_by: string;
    root: string;
  } | null;
  agent_skills_installed: string[];
  agent_commands_installed: string[];
  agents_md: AgentsMdResult[];
  /** Files/blocks stamped NEWER than this CLI — preserved even under --force. */
  preserved_ahead: { path: string; stamped_version: string }[];
  /** Non-fatal advisories (e.g. divergent instruction files being dual-maintained). */
  warnings: string[];
  /** Present only when this applied init transitioned archive false → true. */
  archive_backfill: {
    project_id: string;
    missing_before: number;
    replayed_events: number;
    remaining_missing: number;
    blocked_missing: number;
    usage_blocked_missing: number;
    blocked_artifacts: number;
    complete: boolean;
    artifact_issues: BackfillArtifactIssue[];
    rebuilt_artifacts: Array<{ artifact_id: string; backup_path: string }>;
    remaining_rebuilds: number;
  } | null;
  /** True when an existing config was explicitly replaced with current defaults. */
  config_reset: boolean;
  /** Empty unless --with-hooks was passed. */
  git_hooks: GitHookResult[];
  /** Per-agent session-hook settings outcomes (empty when off and clean). */
  session_hooks: SessionHookFilePlan[];
  /** Consent-gated machine registration attempted inline by interactive personal init. */
  machine_session_hooks: {
    plans: AppliedUserSessionHookInstall['plans'];
    codex_outcome: AppliedUserSessionHookInstall['codexOutcome'];
    codex_migration: AppliedUserSessionHookInstall['codexMigration'];
    live_agents: SupportedAgentId[];
    record: string | null;
    partial_failure: boolean;
    guidance: string | null;
  } | null;
  /** True when enabled personal hooks still need the standalone consent command. */
  machine_session_hooks_deferred: boolean;
  /** True when the interactive consent prompt was shown and answered no. */
  machine_session_hooks_declined: boolean;
  /**
   * True when a session-hook entry was created/updated/removed — the running
   * agent session will not see the change until restarted.
   */
  restart_required: boolean;
  /** The repo's `orcaops.projectid` (null only on a dry-run of an unminted repo). */
  project_id: string | null;
  /** True when THIS init minted the id (vs finding an existing one). */
  project_id_minted: boolean;
  already_initialized: boolean;
  /** True when --dry-run was passed: the result is the PLAN; nothing was written. */
  dry_run: boolean;
  /** Existing history can provide immediate value through a one-time seed. */
  seed_suggested: boolean;
}

async function runInit(opts: InitOptions): Promise<InitResult> {
  const cwd = path.resolve(opts.cwd ?? getInvocationCwd());

  // init is bespoke: it must distinguish "cwd IS the worktree root" from
  // "the root is merely discoverable from a subdir" (which resolveOrcaopsRoot
  // would erase). cwd must be inside a git work tree regardless of flags, and
  // ORCAOPS_ROOT is a *discovery* override for other commands — never an init
  // *placement* directive — so it is deliberately ignored here.
  const gitTop = await discoverGitRoot(cwd);
  if (gitTop === null) {
    throw new OrcaopsError(
      ErrorCodes.NOT_A_REPO,
      `${cwd} is not a git repository (or has no commits yet).`
    );
  }

  // The --root flag arrives via the ALS frame: the preAction hook normalizes it
  // with optsWithGlobals (so it's found regardless of which command level
  // Commander bound the appended / before-subcommand flag to), and opts.root
  // covers direct programmatic callers. It is the FLAG only — never ORCAOPS_ROOT
  // (the hook reads optsWithGlobals().root, not the env) — so init placement
  // stays env-independent.
  const rootFlag = opts.root ?? getInvocationRootOverride();
  let repoRoot: string;
  if (rootFlag !== undefined && rootFlag !== '') {
    repoRoot = await bestEffortRealpath(path.resolve(cwd, rootFlag));
  } else if (opts.here) {
    repoRoot = await bestEffortRealpath(cwd);
  } else {
    const cwdCanon = await bestEffortRealpath(cwd);
    if (cwdCanon === gitTop) {
      repoRoot = gitTop;
    } else {
      throw new OrcaopsError(
        ErrorCodes.INIT_NOT_AT_ROOT,
        `Refusing to initialize .orcaops in a subdirectory.\n` +
          `  cwd:           ${cwdCanon}\n` +
          `  worktree root: ${gitTop}\n` +
          `orcaops anchors .orcaops to the git worktree root. Re-run from there, ` +
          `or pass \`--root ${gitTop}\` to init the root in place, or \`--here\` to ` +
          `init in this subdirectory (discovery will not find a subdir .orcaops ` +
          `without ORCAOPS_ROOT / --root).`
      );
    }
  }

  // Validate the chosen root is a usable git repo: subsumes the original
  // no-commits guard and rejects an explicit --root that is not a repo.
  const repo = new Repo(repoRoot);
  try {
    await repo.getCurrentBranch();
  } catch {
    throw new OrcaopsError(
      ErrorCodes.NOT_A_REPO,
      `${repoRoot} is not a git repository (or has no commits yet).`
    );
  }

  if (opts.resetConfig && !opts.force) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '`--reset-config` requires `--force`; captured artifacts and cache data are preserved.'
    );
  }
  // Re-entry is decided by the config that governs this worktree, never by the
  // presence of `.orcaops/`: under personal scope the config is not in the
  // worktree at all, and a worktree can hold artifacts and a cache from a
  // checkout whose config was never written. A malformed body is tolerated
  // here so the refusal can name the file `--reset-config` would replace; a
  // worktree config CLAIMING personal still throws, because that state has a
  // manual recovery and no migration path.
  const existingSource = await resolveConfigSource(repoRoot, { tolerateUnreadable: true });
  // A shared personal config does not stop THIS worktree from materializing
  // its own project/global config — that file outranks the shared one the
  // moment it exists, which is how a subdir root or a team branch adopts
  // project scope. Only an install landing where one already is re-enters.
  const explicitWorktreeScope = opts.scope === 'project' || opts.scope === 'global';
  const alreadyInitialized =
    existingSource.kind === 'worktree' ||
    (existingSource.kind === 'common' && !explicitWorktreeScope);
  if (alreadyInitialized && !opts.force) {
    throw new OrcaopsError(
      ErrorCodes.ALREADY_INITIALIZED,
      `${displayConfigPath(existingSource, repoRoot)} already exists. Run ` +
        '`orcaops configure` to change settings, or pass --force to re-initialize.'
    );
  }

  // Build the full plan of repo mutations first (pure — reads disk, writes
  // nothing), then apply, or under --dry-run preview. Every write routes through
  // the one executor so --dry-run is guaranteed to touch nothing.
  const mutations: PlannedMutation[] = [];
  const created: string[] = [];

  // No eager `.orcaops/artifacts` or `.orcaops/cache`: the data directories
  // are created by the first write that has something to store, so the
  // initializing worktree follows the same lazy path as every sibling.

  // Init does not probe the environment for an LLM tool — that's doctor's
  // lazy responsibility (checkLlmTool). The config ships with `llm.tool: 'auto'`
  // so the runner resolves the best available tool at first use; --no-llm
  // hard-pins 'none'.
  // --force reconciles the managed install while preserving current config.
  // --reset-config is the explicit factory reset. A newer config is always
  // refused so an older CLI cannot destroy forward-only settings.
  const existingConfigContent =
    existingSource.kind === 'none'
      ? null
      : await readRepositoryFileOrNull(
          existingSource.configPath,
          existingSource.containmentRoot,
          'orcaops configuration'
        );
  let currentConfig = existingConfigContent;
  let preservedConfigPath = displayConfigPath(existingSource, repoRoot);
  if (existingSource.kind === 'worktree' && (opts.personal || opts.scope === 'personal')) {
    const shared = await configLocationForScope(repoRoot, 'personal');
    const sharedContent = await readRepositoryFileOrNull(
      shared.configPath,
      shared.containmentRoot,
      'shared personal configuration'
    );
    if (sharedContent !== null) {
      resolvePersonalConfigForAdoption(sharedContent, displayConfigPath(shared, repoRoot));
      currentConfig = sharedContent;
      preservedConfigPath = displayConfigPath(shared, repoRoot);
    }
  }
  const configExists = currentConfig !== null;
  let archiveEnabledBefore = false;
  let rawCurrent: unknown = null;
  let currentJsonReadable = false;
  if (currentConfig !== null) {
    try {
      rawCurrent = JSON.parse(currentConfig) as unknown;
      currentJsonReadable = true;
      const version =
        rawCurrent && typeof rawCurrent === 'object' && !Array.isArray(rawCurrent)
          ? (rawCurrent as Record<string, unknown>).schema_version
          : undefined;
      if (typeof version === 'number' && version > CONFIG_SCHEMA_VERSION) {
        assertConfigVersionCurrent(rawCurrent);
      }
      // An accepted predecessor still carries archive state. Comparing to the
      // current version alone read it as disabled, so the first `init --force`
      // after a schema bump ran a spurious archive backfill.
      if (isAcceptedConfigVersion(version)) {
        const archive = (rawCurrent as Record<string, unknown>).archive;
        archiveEnabledBefore =
          archive !== null &&
          typeof archive === 'object' &&
          !Array.isArray(archive) &&
          (archive as Record<string, unknown>).enabled === true;
      }
    } catch (err) {
      if (err instanceof ConfigValidationError) throw err;
      if (!opts.resetConfig) {
        throw new ConfigValidationError(
          `${preservedConfigPath} is not valid JSON. Re-run ` +
            '`orcaops init --force --reset-config` to discard it and restore current defaults.',
          'config'
        );
      }
    }
  }
  const preservingConfig = currentConfig !== null && !opts.resetConfig;
  let config: Config;
  if (preservingConfig) {
    if (!currentJsonReadable) {
      throw new ConfigValidationError(
        `${preservedConfigPath} is not readable. Re-run ` +
          '`orcaops init --force --reset-config` to discard it and restore current defaults.',
        'config'
      );
    }
    assertConfigVersionCurrent(rawCurrent);
    try {
      config = resolveConfig(rawCurrent);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        throw new ConfigValidationError(
          `${err.message} Re-run \`orcaops init --force --reset-config\` to discard the ` +
            'invalid configuration and restore current defaults.',
          err.path
        );
      }
      throw err;
    }
  } else {
    config = getDefaultConfig();
    // Fresh init owns the launch-DX default and starts manual. Legacy configs
    // that omit `bootstrap` are protected on the preserving branch above — the
    // schema's zod default (`.default('managed')`, config.ts) fills the field
    // in during resolveConfig, so a config omitting it never silently loses a
    // block it relies on.
    config.bootstrap = 'manual';
    // Fresh init also owns the INVISIBLE default: personal scope — skills in
    // the per-user global dirs, footprint hidden via the common dir's
    // info/exclude, zero tracked-file writes. Team/project mode is the
    // deliberate adoption step (`orcaops update --scope project`, then
    // commit). The zod default stays 'project' so a legacy committed config
    // that OMITS `scope` keeps meaning project on the preserving branch; the
    // explicit --scope / --personal flags below still override.
    config.install.scope = 'personal';
  }
  if (opts.noLlm) {
    config.llm.tool = 'none';
  }
  if (opts.prefix !== undefined) {
    try {
      // Validate against the schema's lowercase / hyphen-safe prefix rule.
      resolveConfig({ naming: { prefix: opts.prefix } });
    } catch {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--prefix "${opts.prefix}" must be lowercase and hyphen-safe (e.g. "orcaops", "oo", "my-team").`
      );
    }
    config.naming.prefix = opts.prefix;
  }
  // An explicit flag always wins. Without one, fresh interactive init offers
  // the proactive lifecycle block as a recommended opt-in; unattended init
  // stays manual and never surprises a repository with top-level files.
  if (opts.agentsMd !== undefined) {
    config.bootstrap = opts.agentsMd ? 'managed' : 'manual';
  }
  if (opts.generatedFiles) {
    config.generated_files = opts.generatedFiles;
  }
  // Persist the install scope/link choice (init serializes the whole config
  // below, so setting these here persists them — no raw-config mutation needed).
  if (opts.scope) {
    config.install.scope = opts.scope;
  }
  if (opts.personal) {
    config.install.scope = 'personal';
  }
  if (opts.link) {
    config.install.link = opts.link;
  }
  // Personal scope owns no instruction file and no repo settings entries: an
  // explicit flag asking for either cannot be honoured, so refuse it rather
  // than persist a setting nothing reads.
  if (config.install.scope === 'personal') {
    if (opts.agentsMd === true) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--agents-md is not available under personal scope: personal installs never edit ' +
          'instruction files. Use `orcaops init --scope project --agents-md` to adopt a managed block.'
      );
    }
    if (opts.sessionHookEntries === 'project') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--session-hook-entries project is not available under personal scope: personal ' +
          'installs register hooks at the machine level only (`orcaops session-hooks install`).'
      );
    }
  }
  // Explicit selection flags always win. A fresh or reset config uses the
  // normal interactive/default selection (a real TTY presents a checklist,
  // default = detected; non-interactive installs the deterministic
  // claude-code default); a forced reconciliation preserves the existing set
  // when no selection flag was supplied, so a multi-agent repo is not
  // silently collapsed to one install target.
  const installAgentFlags = parseInstallAgentFlags(opts);
  if (!preservingConfig || installAgentFlags !== null) {
    config.install.agents = requireInitAnswer(await resolveInstallAgents(opts));
  }

  // Session hooks — the top rungs of the bootstrap ladder (static hook >
  // state-aware hook (experimental) > instruction block > manual). The
  // payload flag persists the mode without ever implicitly enabling; the
  // explicit bool flag skips the prompt and applies even when preserving;
  // unattended init never enables (no settings-file writes from unattended
  // installs). Only a fresh/reset interactive init interviews — a forced
  // reconciliation without --reset-config preserves the existing choice.
  // Cancelling any interview prompt aborts the whole command before the
  // planned mutations execute.
  const hookCapable = sessionHookCapableAgents(config.install.agents);
  let stagedMachineHooks: StagedUserSessionHookInstall | null = null;
  let machineHooksDeclined = false;
  if (opts.sessionHookPayload !== undefined) {
    config.session_hooks = { ...config.session_hooks, payload: opts.sessionHookPayload };
  }
  if (opts.sessionHookEntries !== undefined) {
    config.session_hooks = { ...config.session_hooks, entries: opts.sessionHookEntries };
  }
  if (opts.sessionHooks !== undefined) {
    config.session_hooks = { ...config.session_hooks, enabled: opts.sessionHooks };
  } else if (!preservingConfig && hookCapable.length > 0 && isInteractiveInit(opts)) {
    // Enabling is meaningful under EVERY scope: project writes repo settings
    // entries; personal/global gate emission for the machine-level
    // registration (`orcaops session-hooks install` — tipped in the output).
    const choice = await promptSessionHooksSelect(config.session_hooks.payload, config.bootstrap);
    config.session_hooks = {
      ...config.session_hooks,
      enabled: choice !== 'off',
      // 'off' keeps the prior payload preference so a later re-enable
      // resumes it (same rule as configure).
      ...(choice !== 'off' ? { payload: choice } : {}),
    };
  }

  const userHookAgents = new Set<SupportedAgentId>(userHookCapableAgents());
  const machineHookAgents = hookCapable.filter((agent) => userHookAgents.has(agent));
  if (
    !preservingConfig &&
    config.install.scope === 'personal' &&
    config.session_hooks.enabled &&
    machineHookAgents.length > 0 &&
    isInteractiveInit(opts)
  ) {
    // The raw stream is only for @clack's interactive rendering; prose goes
    // terminal-safe (stderr under --json so stdout stays the machine envelope).
    stagedMachineHooks = await promptUserSessionHookInstall(machineHookAgents, {
      output: opts.json ? process.stderr : process.stdout,
      say: opts.json ? writeTerminalSafeStderr : writeTerminalSafeStdout,
      onCancel: () => {
        throw new InitCancelled();
      },
    });
    machineHooksDeclined = stagedMachineHooks === null;
  }

  const expectedMachineAgents = new Set(
    stagedMachineHooks === null ? [] : stagedUserSessionHookAgents(stagedMachineHooks)
  );
  const projectHookWillBeLive = (agent: SupportedAgentId): boolean => {
    if (config.install.scope !== 'project' || !config.session_hooks.enabled) return false;
    const surface = getAgentOverlay(agent)?.sessionHooks;
    if (surface?.kind === 'plugin-file') return true;
    return surface?.kind === 'settings-json' && config.session_hooks.entries === 'project';
  };
  const blockInitialChoice = (): 'managed' | 'manual' => {
    if (preservingConfig) return config.bootstrap;
    const hooksCoverInstallSet =
      config.session_hooks.enabled &&
      config.install.agents.every(
        (agent) => projectHookWillBeLive(agent) || expectedMachineAgents.has(agent)
      );
    return hooksCoverInstallSet ? 'manual' : 'managed';
  };
  let blockQuestionAsked = false;
  const askBlockQuestion = async (): Promise<void> => {
    config.bootstrap = await promptBlockSelect(blockInitialChoice());
    blockQuestionAsked = true;
  };

  // Ask after agent selection so the configurator flows from "what should be
  // installed?" to the optional always-on behavior. An empty install set has
  // no block surface and therefore no permission question to ask. Same
  // interview rule as session hooks: only fresh/reset init asks.
  if (
    !preservingConfig &&
    opts.agentsMd === undefined &&
    config.install.agents.length > 0 &&
    // Personal scope owns no instruction file, so there is nothing to offer.
    config.install.scope !== 'personal' &&
    isInteractiveInit(opts)
  ) {
    await askBlockQuestion();
  }

  // Only fresh/reset initialization asks configuration questions. A forced
  // reconciliation without --reset-config preserves every existing choice.
  if (!preservingConfig && isInteractiveInit(opts)) {
    config.archive = {
      ...config.archive,
      enabled: await promptArchiveEnable(config.archive.enabled),
    };
  }

  // Customize-more branch — the settings init does not otherwise ask about
  // (prefix, install location, generated files, workflow reminders,
  // session-hook registration, git hooks), behind ONE default-No confirm so
  // the happy path stays short. Fires on fresh/reset interactive init only
  // (a forced reconciliation preserves every choice; `orcaops configure`
  // is the re-edit surface); every sub-prompt runs through the shared
  // settings-edit loop configure uses — seeded with the current value. Flags win: a
  // setting given explicitly on the command line is not re-asked.
  let wantGitHooks = opts.withHooks === true;
  if (!preservingConfig && isInteractiveInit(opts)) {
    const { confirm, isCancel } = await import('@clack/prompts');
    const customize = await confirm({ message: customizeMorePrompt.message, initialValue: false });
    if (isCancel(customize)) throw new InitCancelled();
    if (customize === true) {
      if (opts.prefix === undefined) {
        const value = requireInitAnswer(await editPrefix(config.naming.prefix));
        config.naming = { ...config.naming, prefix: value };
      }
      if (opts.scope === undefined && !opts.personal) {
        const scope = requireInitAnswer(await editScope(config.install.scope));
        config.install = { ...config.install, scope };
        if (
          scope === 'project' &&
          !blockQuestionAsked &&
          opts.agentsMd === undefined &&
          config.install.agents.length > 0
        ) {
          await askBlockQuestion();
        }
      }
      if (opts.link === undefined) {
        const link = requireInitAnswer(await editLink(config.install.link));
        config.install = { ...config.install, link };
      }
      if (opts.generatedFiles === undefined) {
        config.generated_files = requireInitAnswer(
          await editGeneratedFiles(config.generated_files)
        );
      }
      {
        const picked = requireInitAnswer(await editHints(config.workflow.hints.keys));
        const custom = requireInitAnswer(await editHintsCustom(config.workflow.hints.custom));
        config.workflow = {
          ...config.workflow,
          hints: {
            ...config.workflow.hints,
            keys: picked as typeof config.workflow.hints.keys,
            custom,
          },
        };
      }
      // Which registration carries the hook (`session_hooks.entries`) — the
      // knob configure's session-hooks item offers; only meaningful once
      // hooks are enabled (flag or the interview above).
      if (
        opts.sessionHookEntries === undefined &&
        config.session_hooks.enabled &&
        config.install.scope !== 'personal'
      ) {
        const entries = requireInitAnswer(
          await editSessionHookEntries(config.session_hooks.entries)
        );
        config.session_hooks = { ...config.session_hooks, entries };
      }
      if (!wantGitHooks) {
        wantGitHooks = requireInitAnswer(await editGitHooksConfirm(false));
      }
    }
  }

  // Computed AFTER every surface that can set the scope, including the
  // customize branch above: personal scope stores exactly the values it
  // supports, whatever an interview or a preserved config said.
  const personalWarnings: string[] = [];
  if (config.install.scope === 'personal') {
    config.bootstrap = 'manual';
    config.session_hooks = { ...config.session_hooks, entries: 'none' };
  }

  // The write target follows the scope being installed, not where a config
  // happens to sit today: personal publishes to the git common dir so every
  // linked worktree reads it, project/global stay in the worktree.
  const destination = await configLocationForScope(repoRoot, config.install.scope);
  const configRel = displayConfigPath(destination, repoRoot);
  const movingSource = existingSource.configPath !== destination.configPath;
  if (movingSource && config.install.scope === 'personal' && existingSource.kind === 'worktree') {
    // `update --scope personal` is the transition command: it plans the
    // de-adoption removals and leaves their tracked diff to review. Init must
    // not perform that edit as a side effect of --force.
    const tracked = await trackedProjectInstallPaths(repo, [
      path.relative(repoRoot, existingSource.configPath),
      INSTALL_MANIFEST_REL,
    ]);
    if (tracked.length > 0) throw refuseTrackedPersonalTransition(tracked);
  }
  const priorDestination = movingSource
    ? await readRepositoryFileOrNull(
        destination.configPath,
        destination.containmentRoot,
        'orcaops configuration'
      )
    : currentConfig;
  // One shared file governs every linked worktree, so a reset run from any of
  // them is repository-wide. Say so where the user is standing; captured
  // artifacts and cache bytes are per-worktree and untouched either way.
  const sharedConfigReset =
    destination.origin === 'common' && opts.resetConfig === true && priorDestination !== null;
  if (sharedConfigReset) {
    personalWarnings.push(
      '--reset-config replaced the shared personal configuration in the git common ' +
        'directory: the new settings take effect in EVERY linked worktree of this ' +
        'repository, not just this one. Captured artifacts and cache data are per-worktree ' +
        'and were not touched.'
    );
  }

  // Minimal per-key delta, never the full resolved config: a fresh init
  // writes ~10 lines (portable across CLI versions), and a preserving
  // --force re-init re-minimizes — `config` was seeded from the on-disk
  // JSON, so every effective non-default survives the round-trip.
  const desiredConfig = JSON.stringify(buildConfigDelta(config), null, 2) + '\n';
  const configMut = writeMutation(
    repoRoot,
    path.relative(repoRoot, destination.configPath),
    desiredConfig,
    priorDestination,
    opts.force || priorDestination === null,
    destination.containmentRoot,
    destination.configPath
  );
  mutations.push(configMut);
  if (configMut.changed && !created.includes(configRel)) {
    created.push(configRel);
  }
  // An untracked worktree config left behind after publishing the shared one
  // would fail source selection closed on the next command.
  if (movingSource && existingSource.kind === 'worktree' && currentConfig !== null) {
    if (existingConfigContent === null) {
      throw new Error('worktree configuration disappeared while planning personal adoption');
    }
    mutations.push(
      deleteMutation(
        repoRoot,
        path.relative(repoRoot, existingSource.configPath),
        { kind: 'file', content: existingConfigContent },
        true
      )
    );
  }

  // Init does not auto-install evaluator packs. The absence
  // of .orcaops/evaluators.yaml is the explicit "no packs configured"
  // signal — the first `orcaops eval add-pack` creates it.

  // Install agent skills + slash commands + the bootstrap block for the install set
  // through the SAME shared planner update/doctor --fix use — the multi-agent loop +
  // the instruction-file UNION live there (an empty set installs nothing; `other`
  // seeded to `[]` above preserves today's manual mode). The planner also builds +
  // writes the committed install.json + gitignored install.local.json (churn-free
  // vs the prior manifests). Routing init through it keeps the four install surfaces
  // from ever diverging; for a default single-agent repo the output is byte-identical.
  const baseGitignore = [...ORCAOPS_BASE_GITIGNORE];
  // Under generated_files:'ignore', also gitignore the generated trees with
  // adapter-derived globs (project scope only — global has no project trees).
  // Personal manages NO repo .gitignore lines at all — its footprint
  // hides via .git/info/exclude below.
  const orcaopsGitignoreLines =
    config.install.scope === 'personal'
      ? []
      : config.generated_files === 'ignore' && config.install.scope !== 'global'
        ? [
            ...baseGitignore,
            ...derivedIgnoreGlobs(
              config.install.agents,
              config.naming.prefix,
              config.session_hooks.enabled
            ),
          ]
        : baseGitignore;
  // init has no CliContext (it is what creates the install), so it resolves
  // the machine-state gates directly.
  const gates = resolveSkillGates(getInvocationEnv());
  const currentInstall = await readInstallManifest(repoRoot);
  const currentLocal = await readEffectiveLocalManifest(
    repoRoot,
    existingSource.kind === 'common' ? 'personal' : config.install.scope
  );
  const plan = await planInstallMutations({
    repoRoot,
    agents: config.install.agents,
    scope: config.install.scope,
    config,
    gates,
    generatedBy: CLI_VERSION,
    force: opts.force,
    gitignoreLines: orcaopsGitignoreLines,
    prevInstall: currentInstall,
    prevLocal: currentLocal,
    leavingPersonalScope: existingSource.kind === 'common' && config.install.scope !== 'personal',
  });
  mutations.push(...plan.mutations);

  // Derive init's per-surface result tallies from the plan (changed = create|replace).
  const installedChanged = [...plan.generate.installed, ...plan.generate.refreshed];
  const skillsInstalled = installedChanged.filter((p) => p.includes('/skills/'));
  const commandsInstalled = installedChanged.filter((p) => !p.includes('/skills/'));
  const agentsMdResults: AgentsMdResult[] = plan.agentsMd.map((m) => ({
    path: m.path,
    action: m.action,
  }));
  const warnings = [...personalWarnings, ...plan.warnings];

  // .gitignore: init owns the actual file write (the planner only RECORDS the lines in the
  // manifest). RECONCILE in one pass — like `update` — so a re-init that drops the
  // generated-files globs (a config preserved as commit-mode, or a narrowed install set) PRUNES
  // the stale lines instead of leaving the regenerated trees silently git-ignored.
  let gitignoreAdded: string[] = [];
  if (config.install.scope === 'personal') {
    // NEVER touch the repo .gitignore under personal scope. The untracked
    // personal footprint hides via .git/info/exclude instead — planned by
    // the shared installer (planInstallMutations), so init, update, and
    // doctor --fix all reconcile it and record the lines in the local
    // manifest.
  } else {
    const gitignorePlan = await reconcileGitignore(repoRoot, orcaopsGitignoreLines);
    if (gitignorePlan.desiredContent !== null) {
      mutations.push(
        writeMutation(
          repoRoot,
          '.gitignore',
          gitignorePlan.desiredContent,
          gitignorePlan.currentContent,
          true
        )
      );
    }
    gitignoreAdded = gitignorePlan.added;
  }

  // Optional git hooks. Opt-in via --with-hooks because some
  // users manage hooks via husky / lefthook and want to wire it in
  // their own setup. We touch only `post-merge` + `post-rewrite`, and
  // we never overwrite an unstamped pre-existing hook. The hooks dir is
  // resolved via git plumbing (linked-worktree correct); when
  // `core.hooksPath` points at a tool-owned dir we refuse to write into
  // it — installing there would mutate a committed hook manager's tree,
  // and installing into the default dir would plant a hook git never runs.
  const gitHooksResult: GitHookResult[] = [];
  if (wantGitHooks) {
    const hooksDir = await repo.getHooksDir();
    if (hooksDir.source === 'core.hooksPath') {
      warnings.push(
        `core.hooksPath points at ${path.relative(repoRoot, hooksDir.dir) || hooksDir.dir} — ` +
          'orcaops never writes into a hook-manager-owned dir; wire `orcaops lineage` into ' +
          'your post-merge/post-rewrite hooks there instead'
      );
      for (const name of ['post-merge', 'post-rewrite'] as const) {
        gitHooksResult.push({
          path: path.relative(repoRoot, path.join(hooksDir.dir, name)),
          action: 'skipped-external-hooks-path',
        });
      }
    } else {
      for (const name of ['post-merge', 'post-rewrite'] as const) {
        const ghp = await planGitHookMutation(
          repoRoot,
          hooksDir.dir,
          name,
          CLI_VERSION,
          (absPath) => readRepositoryFileForOwnership(absPath, hooksDir.dir, `Git hook ${name}`)
        );
        mutations.push(ghp.mutation);
        gitHooksResult.push({ path: ghp.mutation.path, action: ghp.action });
        if (ghp.aheadStamp !== undefined) {
          warnings.push(aheadHookWarning(ghp.mutation.path, ghp.aheadStamp));
        }
      }
    }
  }

  // Never-touch enforcement: the invisible default must not dirty a shared
  // repo — a personal-scope plan mutating any tracked path is a planner bug,
  // thrown BEFORE any write (the session-hook lingering-entry strip is the
  // one sanctioned exception).
  if (config.install.scope === 'personal') {
    await assertInvisiblePlan(repoRoot, mutations, plan.sessionHooks);
  }

  const mode: MutationMode = opts.dryRun ? 'preview' : 'apply';

  // Eager identity: mint `orcaops.projectid` at init (idempotent — an
  // existing id is kept). Repo-local git config inside the repo the user just
  // asked orcaops to initialize, shared across worktrees, invisible to
  // `git status`. Dry-run reads only (git config sits outside the mutation
  // executor), and the mint precedes the global preview below so the preview
  // keys by the real identity with zero fs writes.
  const identity = opts.dryRun
    ? { projectId: await readProjectId(repo), minted: false }
    : await ensureProjectId(repo);

  // Under global scope, materialize skills/commands into the per-user global
  // dirs (ref-counted, per-user-current, copy-default/guarded-symlink) — separate from
  // the project block/manifest above (which stay project-scoped). Mirrors `update`.
  const repoId = identity.projectId;
  const planGlobalPhase = (
    globalMode: MutationMode,
    globalManifest: GlobalInstallManifest | null,
    lockScope?: GlobalInstallLockScope
  ): Promise<GlobalInstallResult | null> => {
    // Home-dir stores key by the minted identity; a dry-run of a repo with no
    // identity yet has nothing recorded under any key, so global planning is
    // skipped rather than previewed against a key that does not exist.
    if (repoId === null) return Promise.resolve(null);
    if (
      (config.install.scope === 'global' || config.install.scope === 'personal') &&
      config.install.agents.length > 0
    ) {
      return planGlobalInstall(
        {
          repoId,
          agents: config.install.agents,
          prefix: config.naming.prefix,
          generatedBy: CLI_VERSION,
          link: config.install.link,
          cliVersion: CLI_VERSION,
          skills: enabledSkillTemplates(config, gates),
          // A `--force` re-init on a logged-out machine hits the same decrement
          // path as update, so it needs the same hold.
          heldSkills: gateWithheldSkillTemplates(config, gates),
          force: opts.force,
        },
        globalMode,
        globalManifest,
        lockScope
      );
    }
    // A --force re-init that flips global→project (or to an empty install set) releases this
    // repo's prior global refs so they are decremented + cleaned rather than leaked.
    return releaseGlobalRefs(
      { repoId, cliVersion: CLI_VERSION, force: opts.force },
      globalMode,
      globalManifest,
      lockScope
    );
  };

  let global: GlobalInstallResult | null;
  if (mode === 'preview') {
    const globalManifest = await readGlobalManifest();
    global = await planGlobalPhase('preview', globalManifest);
    await executeMutations(publishInstallManifestsLast(mutations), mode);
  } else {
    const commonDir = await repo.getCommonDirAbsolute();
    global = await withRepositoryInstallLock(commonDir, async (installLease) => {
      const globalManifest = await readGlobalManifest();
      // repoId is never null here: apply mode minted it above.
      const needsGlobalWrite =
        ((config.install.scope === 'global' || config.install.scope === 'personal') &&
          config.install.agents.length > 0) ||
        (repoId !== null &&
          globalManifest?.entries.some((entry) => entry.refs.includes(repoId)) === true);
      if (needsGlobalWrite) {
        return withGlobalInstallLock(async (scope) => {
          await planGlobalPhase('preview', scope.manifest);
          await installLease.verify();
          await executeMutations(publishInstallManifestsLast(mutations), mode);
          await installLease.verify();
          return planGlobalPhase('apply', scope.manifest, scope);
        });
      }
      await installLease.verify();
      await executeMutations(publishInstallManifestsLast(mutations), mode);
      return null;
    });
  }
  if (global) warnings.push(...global.warnings);

  let archiveBackfill: InitResult['archive_backfill'] = null;
  if (mode === 'apply' && !archiveEnabledBefore && config.archive.enabled) {
    const activation = await enableArchiveAndBackfillForInit(repoRoot);
    archiveBackfill = {
      project_id: activation.backfill.projectId,
      missing_before: activation.backfill.missingBefore,
      replayed_events: activation.backfill.replayedEvents,
      remaining_missing: activation.backfill.remainingMissing,
      blocked_missing: activation.backfill.blockedMissing,
      usage_blocked_missing: activation.backfill.quarantinedUsageEvents,
      blocked_artifacts: activation.backfill.blockedArtifacts,
      complete: activation.backfill.complete,
      artifact_issues: activation.backfill.artifactIssues,
      rebuilt_artifacts: activation.backfill.rebuiltArtifacts,
      remaining_rebuilds: activation.backfill.remainingRebuilds,
    };
    if (!activation.backfill.complete) {
      warnings.push(
        `Archive backfill is incomplete: ${activation.backfill.remainingMissing} repairable ` +
          `event(s), ${activation.backfill.remainingRebuilds} rebuild(s), and ` +
          `${activation.backfill.blockedArtifacts} blocked artifact(s) remain. ` +
          'Run `orcaops archive status --json` for the exact disposition.'
      );
    }
    if (activation.backfill.quarantinedUsageEvents > 0) {
      warnings.push(
        `Archive backfill quarantined ${activation.backfill.quarantinedUsageEvents} invalid ` +
          'usage event(s) in the hot ledger; they remain without archive-readable content and ' +
          'do not block archive activation.'
      );
    }
    for (const issue of activation.backfill.artifactIssues) {
      warnings.push(archiveActivationWarning(issue));
    }
  }

  let machineHooks: AppliedUserSessionHookInstall | null = null;
  let machineHookGuidance: string | null = null;
  if (mode === 'apply' && stagedMachineHooks !== null && config.session_hooks.enabled) {
    machineHooks = await applyUserSessionHookInstall(stagedMachineHooks, CLI_VERSION);
    machineHookGuidance = await codexSessionHookGuidance(machineHooks.codexOutcome);
    warnings.push(...machineHooks.warnings);
  }
  const machineHooksDeferred =
    config.session_hooks.enabled &&
    machineHookAgents.some(
      (agent) => !projectHookWillBeLive(agent) && !machineHooks?.liveAgents.includes(agent)
    );

  const seedSuggested =
    (await countHistoryCommits(repoRoot)) >= 20 && !hasArtifactEventLogs(repoRoot, config);

  return {
    repo_root: repoRoot,
    created,
    config_path: configRel,
    gitignore_added: gitignoreAdded,
    llm_tool: config.llm.tool,
    detected_llm_tool: null,
    agent_tool: config.install.agents[0] ?? null,
    install_agents: config.install.agents,
    scope: config.install.scope,
    global: global
      ? {
          materialized: global.materialized,
          removed: global.removed,
          copy_fallbacks: global.copyFallbacks,
          skipped_version_mismatch: global.skippedVersionMismatch,
          materialized_by: global.manifest.materialized_by,
          root: resolveGlobalRoot(),
        }
      : null,
    agent_skills_installed: skillsInstalled,
    agent_commands_installed: commandsInstalled,
    agents_md: agentsMdResults,
    preserved_ahead: plan.preservedAhead.map((p) => ({
      path: p.path,
      stamped_version: p.stampedVersion,
    })),
    warnings,
    archive_backfill: archiveBackfill,
    config_reset: configExists && opts.resetConfig === true,
    git_hooks: gitHooksResult,
    session_hooks: plan.sessionHooks,
    machine_session_hooks:
      machineHooks === null
        ? null
        : {
            plans: machineHooks.plans,
            codex_outcome: machineHooks.codexOutcome,
            codex_migration: machineHooks.codexMigration,
            live_agents: machineHooks.liveAgents,
            record: machineHooks.record,
            partial_failure: machineHooks.partialFailure,
            guidance: machineHookGuidance,
          },
    machine_session_hooks_deferred: machineHooksDeferred,
    machine_session_hooks_declined: machineHooksDeclined,
    restart_required:
      sessionHooksRestartRequired(plan.sessionHooks) || (machineHooks?.restartRequired ?? false),
    project_id: identity.projectId,
    project_id_minted: identity.minted,
    already_initialized: alreadyInitialized,
    dry_run: !!opts.dryRun,
    seed_suggested: seedSuggested,
  };
}

async function countHistoryCommits(repoRoot: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-list', '--count', '--all'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => resolve(0));
    child.on('close', (code) => resolve(code === 0 ? Number.parseInt(stdout.trim(), 10) || 0 : 0));
  });
}

/**
 * One authoring point for the ahead-hook warning so the human formatter can
 * recognize which preserved-conflict hooks are AHEAD (the frozen git_hooks
 * entries carry only {path, action}).
 */
function aheadHookWarning(hookRel: string, stamp: string): string {
  return (
    `Git hook ${hookRel} is stamped by a NEWER orcaops (v${stamp}) than this CLI — ` +
    'preserved, not overwritten. Upgrade orcaops to manage it.'
  );
}
const AHEAD_HOOK_WARNING_RE = /^Git hook (\S+) is stamped by a NEWER orcaops /;

function countByRoot(paths: string[], levelsUp: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const p of paths) {
    let root = p;
    for (let i = 0; i < levelsUp; i++) root = path.dirname(root);
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function formatHumanInitResult(r: InitResult): string {
  const lines: string[] = [];
  if (r.dry_run) {
    lines.push('DRY RUN — what `orcaops init` would do; nothing was written.');
    lines.push('');
  }
  lines.push(`Orcaops ${r.dry_run ? 'would initialize' : 'initialized'} at ${r.repo_root}`);
  lines.push('');
  if (r.already_initialized) {
    lines.push(
      r.config_reset
        ? '(re-initialized; --reset-config restored current defaults and reconciled generated files)'
        : '(re-initialized; existing config preserved and generated files reconciled)'
    );
    lines.push('');
  }
  if (r.created.length > 0) {
    lines.push('Created:');
    for (const c of r.created) {
      lines.push(`  ${c}`);
    }
    lines.push('');
  }
  if (
    r.install_agents.length > 0 &&
    r.agent_skills_installed.length + r.agent_commands_installed.length > 0
  ) {
    lines.push(`Installed agent integration for ${r.install_agents.join(', ')}:`);
    // Group installed paths by surface root (.claude/skills, .agents/skills,
    // …) so every agent's tree is named, not just the first agent's.
    for (const [root, count] of countByRoot(r.agent_skills_installed, 2)) {
      lines.push(`  ${count} skill(s) at ${root}/orcaops-*/SKILL.md`);
    }
    for (const [root, count] of countByRoot(r.agent_commands_installed, 1)) {
      lines.push(`  ${count} slash command(s) at ${root}/*.md`);
    }
    lines.push('');
  }
  if (r.global?.skipped_version_mismatch) {
    lines.push(
      `Global install: SKIPPED filesystem changes (CLI v${CLI_VERSION} vs ` +
        `manifest v${r.global.materialized_by}); refs updated.`,
      ''
    );
  } else if (r.global) {
    let reportedGlobalSkills = false;
    for (const agent of r.install_agents) {
      const skillsRoot = resolveGlobalSkillsDir(agent);
      if (skillsRoot === null) continue;
      const count = r.global.materialized.filter((file) => pathIsInside(skillsRoot, file)).length;
      if (count > 0) {
        reportedGlobalSkills = true;
        lines.push(
          `Installed ${count} ${count === 1 ? 'skill' : 'skills'} for ${agent} → ${displayPath(skillsRoot)}`
        );
      }
    }
    if (reportedGlobalSkills) lines.push('');
  }
  const touchedAgentsMd = r.agents_md.filter((m) => m.action !== 'unchanged');
  if (touchedAgentsMd.length > 0) {
    lines.push('Bootstrap section written to:');
    for (const m of touchedAgentsMd) {
      const sym =
        m.action === 'symlinked'
          ? '→'
          : m.action === 'replaced'
            ? '~'
            : m.action === 'removed'
              ? '-'
              : '+';
      const suffix = m.action === 'symlinked' ? ' (symlink)' : '';
      lines.push(`  ${sym} ${m.path}${suffix}`);
    }
    lines.push('  (enables automatic capture on non-trivial tasks;');
    lines.push('   use --no-agents-md to opt out, or edit between the <!-- orcaops:* --> markers)');
    lines.push('');
  }
  if (r.warnings.length > 0) {
    for (const w of r.warnings) lines.push(`! ${w}`);
    lines.push('');
  }
  if (r.archive_backfill !== null) {
    lines.push(
      `Archive backfill: ${r.archive_backfill.replayed_events} event(s) replayed, ` +
        `${r.archive_backfill.remaining_missing} remaining; ` +
        `${r.archive_backfill.rebuilt_artifacts.length} artifact(s) rebuilt, ` +
        `${r.archive_backfill.remaining_rebuilds} rebuild(s) remaining.`
    );
    if (!r.archive_backfill.complete) {
      lines.push(
        `Archive backfill is incomplete: ${r.archive_backfill.blocked_artifacts} ` +
          `artifact(s) blocked, ${r.archive_backfill.blocked_missing} blocked artifact event(s).`
      );
    }
    if (r.archive_backfill.usage_blocked_missing > 0) {
      lines.push(
        `Archive quarantine: ${r.archive_backfill.usage_blocked_missing} invalid usage event(s) ` +
          'remain outside the readable archive.'
      );
    }
    lines.push('');
  }
  if (r.gitignore_added.length > 0) {
    lines.push(`Updated .gitignore: ${r.gitignore_added.join(', ')}`);
    lines.push('');
  }
  if (r.git_hooks.length > 0) {
    const created = r.git_hooks.filter((h) => h.action === 'created');
    const refreshed = r.git_hooks.filter((h) => h.action === 'refreshed');
    const conflicts = r.git_hooks.filter((h) => h.action === 'preserved-conflict');
    if (created.length + refreshed.length > 0) {
      lines.push('Installed git hooks:');
      for (const h of created) lines.push(`  + ${h.path}`);
      for (const h of refreshed) lines.push(`  ~ ${h.path} (refreshed)`);
      lines.push('  (these run `orcaops lineage` after merge / rebase / amend)');
      lines.push('');
    }
    if (conflicts.length > 0) {
      const aheadPaths = new Set(
        r.warnings
          .map((w) => AHEAD_HOOK_WARNING_RE.exec(w)?.[1])
          .filter((p): p is string => p !== undefined)
      );
      const unstamped = conflicts.filter((h) => !aheadPaths.has(h.path));
      const aheadHooks = conflicts.filter((h) => aheadPaths.has(h.path));
      if (unstamped.length > 0) {
        lines.push('Pre-existing git hooks left untouched (no orcaops stamp):');
        for (const h of unstamped) lines.push(`  ! ${h.path}`);
        lines.push(
          '  Add `orcaops lineage >/dev/null 2>&1 || true` manually if you want auto-sync.'
        );
        lines.push('');
      }
      if (aheadHooks.length > 0) {
        lines.push('Git hooks stamped by a NEWER orcaops left untouched:');
        for (const h of aheadHooks) lines.push(`  ! ${h.path}`);
        lines.push('  Upgrade orcaops to manage them.');
        lines.push('');
      }
    }
    const skipped = r.git_hooks.filter((h) => h.action === 'skipped-external-hooks-path');
    if (skipped.length > 0) {
      lines.push('Git hooks not installed (core.hooksPath is hook-manager-owned):');
      for (const h of skipped) lines.push(`  - ${h.path}`);
      lines.push('');
    }
  } else {
    lines.push(
      'Tip: pass `--with-hooks` next time to auto-run `orcaops lineage` after merges/rebases.'
    );
    lines.push('');
  }
  const shInstalled = r.session_hooks.filter(
    (h) => h.action === 'created' || h.action === 'updated'
  );
  const shRemoved = r.session_hooks.filter((h) => h.action === 'removed');
  if (shInstalled.length > 0) {
    lines.push('Session hooks installed:');
    for (const h of shInstalled) {
      lines.push(`  ${h.action === 'created' ? '+' : '~'} ${h.path}  (${h.agent})`);
    }
    lines.push('');
  }
  if (shRemoved.length > 0) {
    lines.push('Session-hook entries removed from:');
    for (const h of shRemoved) lines.push(`  - ${h.path}`);
    lines.push('');
  }
  if (r.machine_session_hooks?.live_agents.length) {
    lines.push('Machine session hooks installed for:');
    for (const agent of r.machine_session_hooks.live_agents) lines.push(`  + ${agent}`);
    lines.push('');
  }
  if (r.machine_session_hooks?.guidance) {
    lines.push(r.machine_session_hooks.guidance.trimEnd(), '');
  }
  lines.push('No evaluator packs installed.');
  lines.push(
    '  Run `orcaops eval add-pack @orcaops/evaluator-pack core` to install the default first-party pack.'
  );
  lines.push('');
  // Fresh installs only — a preserving re-init means the user already
  // answered (declined the prompt or ran --no-session-hooks); re-tipping on
  // every re-init would nag past an explicit decision. (`shSkipped` needs no
  // clause: skipped-scope rows live in r.session_hooks, so length 0 covers it.)
  if (
    !r.already_initialized &&
    r.session_hooks.length === 0 &&
    r.machine_session_hooks === null &&
    !r.machine_session_hooks_deferred &&
    sessionHookCapableAgents(r.install_agents).length > 0
  ) {
    lines.push(
      'Tip: pass `--session-hooks` to inject orcaops capture guidance at every agent session start.'
    );
    lines.push('');
  }
  if (r.llm_tool === 'none') {
    if (r.detected_llm_tool === null) {
      lines.push('LLM tool: none (no `claude` or `codex` found on PATH).');
      lines.push('LLM evaluators will be skipped until a provider CLI is installed.');
    } else {
      lines.push('LLM disabled via --no-llm. Evaluators will run in deterministic-only mode.');
    }
  } else {
    lines.push(`LLM tool: ${r.llm_tool} (piggybacks on your local subscription — no API key).`);
  }
  lines.push('');
  if (r.scope === 'personal' && !r.already_initialized) {
    lines.push('Invisible install: nothing touches git — `git status` stays clean, teammates');
    lines.push('see nothing. To adopt orcaops as a team later: `orcaops update --scope project`,');
    lines.push('then commit the files it materializes.');
    lines.push('');
  }
  // Declining machine hooks is a choice, not a problem to fix: say plainly
  // what the agents have without one, and how to add it later.
  if (r.machine_session_hooks === null && r.machine_session_hooks_declined) {
    const agents = r.install_agents.join(', ') || 'the selected agents';
    const plural = r.install_agents.length !== 1;
    lines.push(
      `Machine session hooks were not installed (prompt declined): ${agents} ` +
        `${plural ? 'keep their' : 'keeps its'} global skills and the orcaops CLI, but ` +
        `${plural ? 'get' : 'gets'} no automatic session reminder. ` +
        'Run `orcaops session-hooks install` when you want one.'
    );
    lines.push('');
  }
  const actions: string[] = [];
  if (r.restart_required) {
    actions.push(SESSION_HOOK_RESTART_NOTICE);
  }
  if (r.machine_session_hooks_deferred || r.machine_session_hooks?.partial_failure) {
    actions.push(...machineSessionHookActions(r));
  }
  if (actions.length > 0) {
    lines.push('Action needed:');
    for (const action of actions) lines.push(`  - ${action}`);
    lines.push('');
  }
  if (r.seed_suggested) {
    lines.push(
      'Tip: this repository already has history. Ask your agent to seed orcaops from git history.'
    );
    lines.push('No agent available? Preview the local fallback with `orcaops seed --dry-run`.');
    lines.push('');
  }
  lines.push('Next: have your agent capture plans + checkpoints via `orcaops capture …`.');
  lines.push('Change settings: `orcaops configure` · Undo: `orcaops uninstall`');
  lines.push('');
  return lines.join('\n');
}

function machineSessionHookActions(r: InitResult): string[] {
  const machine = r.machine_session_hooks;
  if (machine === null) {
    // A declined prompt is reported as information above, never as an action.
    if (r.machine_session_hooks_declined) return [];
    if (r.dry_run) {
      return [
        'Machine session hooks are not written by a dry run. ' +
          'Re-run without `--dry-run`, or run `orcaops session-hooks install`.',
      ];
    }
    if (r.scope !== 'personal') {
      return [
        `Machine session hooks are registered separately from a ${r.scope}-scope init. ` +
          'Run `orcaops session-hooks install` when you want them.',
      ];
    }
    if (r.already_initialized) {
      return [
        'Machine session hooks are not re-offered by a re-init. ' +
          'Run `orcaops session-hooks install` when you want them.',
      ];
    }
    return [
      'Finish machine registration with `orcaops session-hooks install` in an interactive terminal.',
    ];
  }
  const actions: string[] = [];
  const codex = machine.codex_outcome;
  if (codex === 'manual-snippet') {
    actions.push('Paste the Codex snippet above, then run `orcaops session-hooks status`.');
  } else if (
    codex === 'refused-invalid' ||
    codex === 'refused-hooks-shape' ||
    codex === 'refused-fence' ||
    codex === 'refused-markers'
  ) {
    actions.push(
      `Edit ${displayPath(codexConfigTomlPath())} as described above, ` +
        'then re-run `orcaops session-hooks install`.'
    );
  } else if (codex === 'skipped') {
    actions.push(
      'Codex was skipped. Run `orcaops session-hooks install --agents codex` when you want it.'
    );
  } else if (codex === 'refused-unreadable' || codex === 'failed') {
    actions.push(
      `Repair ${displayPath(codexConfigTomlPath())} (see the warning above), ` +
        'then re-run `orcaops session-hooks install --agents codex`.'
    );
  }
  if (machine.codex_migration === 'kept-duplicate') {
    actions.push(
      `Codex is registered in ${displayPath(codexHooksJsonPath())}; delete the leftover ` +
        `orcaops hook in ${displayPath(codexConfigTomlPath())} (see the warning above), ` +
        'or re-run `orcaops session-hooks install` to retry the move.'
    );
  }
  for (const plan of machine.plans) {
    if (
      plan.action === 'preserved-invalid-json' ||
      plan.action === 'preserved-unreadable' ||
      plan.action === 'preserved-unwritable'
    ) {
      actions.push(
        `Repair ${displayPath(plan.path)} (see the warning above), ` +
          'then re-run `orcaops session-hooks install`.'
      );
    }
  }
  if (machine.live_agents.length > 0 && machine.record === null) {
    actions.push(
      'The registration record was not updated (see the warning above); ' +
        're-run `orcaops session-hooks install` once it is repaired.'
    );
  }
  // Exhaustive: an applied install leaves every consented agent either live
  // or on one of the outcomes above (a JSON plan is created/updated/unchanged
  // or preserved-*, a Codex config.toml answer is written/unchanged, the
  // manual snippet, skipped, refused or failed, and a move either lands or
  // leaves the old block behind), and an install without a record is the last
  // clause — so an empty list means nothing is pending.
  return actions;
}

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function displayPath(absolutePath: string): string {
  const home = os.homedir();
  const relative = path.relative(home, absolutePath);
  if (relative === '') return '~';
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return absolutePath;
}

function archiveActivationWarning(issue: BackfillArtifactIssue): string {
  const prefix = `Archive artifact ${issue.artifact_id} is blocked (${issue.kind}): ${issue.message}`;
  if (issue.resolution_commands.length === 0) {
    return (
      `${prefix} Neither source strictly reconstructs, so no automated resolution is safe. ` +
      'Inspect with `orcaops archive status --json`; nothing was mutated.'
    );
  }
  return (
    `${prefix} Inspect with \`orcaops archive status --json\`, then explicitly choose: ` +
    issue.resolution_commands.map((command) => `\`${command}\``).join(' or ') +
    '.'
  );
}

async function promptArchiveEnable(initialValue: boolean): Promise<boolean> {
  return requireInitAnswer(await editArchiveEnabled(initialValue));
}

async function promptBlockSelect(
  initialValue: 'managed' | 'manual'
): Promise<'managed' | 'manual'> {
  return requireInitAnswer(await editBlockChoice(initialValue));
}

async function promptSessionHooksSelect(
  initialValue: 'static' | 'state-aware' | 'off',
  bootstrap: 'managed' | 'manual'
): Promise<'static' | 'state-aware' | 'off'> {
  return requireInitAnswer(await editSessionHooksChoice(initialValue, bootstrap));
}
