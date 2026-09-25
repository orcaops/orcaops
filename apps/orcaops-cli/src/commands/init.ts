import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { type ToolId } from '@orcaops/adapters';
import { configLocationForScope, loadConfig, Repo, resolveConfigSource } from '@orcaops/core';
import {
  type DatabaseSetupWait,
  inspectDatabaseSetup,
  setupProjectDatabase,
} from '@orcaops/core/history/database-setup';
import {
  assertConfigVersionCurrent,
  type Config,
  CONFIG_SCHEMA_VERSION,
  ConfigValidationError,
  getDefaultConfig,
  resolveConfig,
  type SupportedAgentId,
} from '@orcaops/storage';
import { HistoryError, normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

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
import { repositoryHasCapturedHistory } from '../lib/captured-history-presence.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { buildConfigDelta } from '../lib/config-delta.js';
import {
  displayConfigPath,
  refuseTrackedPersonalTransition,
  resolvePersonalConfigForAdoption,
  trackedProjectInstallPaths,
} from '../lib/config-file.js';
import { registerMissingDatabaseWorktree } from '../lib/database-worktree-registration.js';
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
import { readInstructionBlock } from '../lib/instruction-block.js';
import type { InstructionFileAction } from '../lib/instruction-placement.js';
import {
  getInvocationCwd,
  getInvocationEnv,
  getInvocationRootOverride,
} from '../lib/invocation-context.js';
import { knownInstructionFiles } from '../lib/managed-instruction-files.js';
import {
  deleteMutation,
  executeMutations,
  type GitHookAction,
  type MutationMode,
  planGitHookMutation,
  type PlannedMutation,
  readRepositoryFileForOwnership,
  readRepositoryFileOrNull,
  repositoryEntryExists,
  writeMutation,
} from '../lib/mutations.js';
import { readEffectiveLocalManifest } from '../lib/personal-manifest.js';
import { adoptProjectId, readProjectId } from '../lib/project-identity.js';
import { withRepositoryInstallLock } from '../lib/repository-install-lock.js';
import { bestEffortRealpath, discoverGitRoot } from '../lib/resolve-root.js';
import { assessMachineSessionHookCoverage } from '../lib/session-hooks-coverage.js';
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
  inspectUserSessionHooks,
  readUserHooksRecord,
  userHookCapableAgents,
} from '../lib/session-hooks-user.js';
import {
  configSelectsProjectHook,
  SESSION_HOOK_RESTART_NOTICE,
  sessionHookCapableAgents,
  type SessionHookFilePlan,
  sessionHooksRestartRequired,
} from '../lib/session-hooks.js';
import {
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
   * block; false opts out. Undefined lets interactive init recommend the block,
   * and leaves an unattended fresh init to the coverage rule: managed under
   * project or global scope unless enabled session hooks already cover every
   * selected agent or the repository has an instruction file of its own, and
   * always manual under personal scope. Existing config is preserved.
   */
  agentsMd?: boolean;
  /**
   * Tri-state session-hooks choice — the top rung of the bootstrap ladder
   * (session hooks > instruction block > manual). True enables (persisted to
   * `config.session_hooks.enabled`); false disables; undefined lets a fresh
   * interactive init recommend them when any selected agent is hook-capable,
   * while unattended fresh init stays disabled. Existing config is preserved.
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
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  let waiting = false;
  try {
    const raw = await runInit(opts, {
      signal: controller.signal,
      onWait: (wait) => {
        if (waiting) return;
        waiting = true;
        writeTerminalSafeStderr(`Waiting to ${wait.operation}; Ctrl-C cancels the wait.\n`);
      },
    });
    // Warnings interpolate raw fs/parse error text from machine-hook applies,
    // so scrub once here, ahead of both exits.
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
    if (
      renderedError instanceof OrcaopsError ||
      renderedError instanceof ProjectDatabaseError ||
      renderedError instanceof HistoryError
    ) {
      writeErrorLine(renderedError);
      throw new CliExit(1);
    }
    throw err;
  } finally {
    process.off('SIGINT', interrupt);
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

interface WorktreeInitResult {
  registration_only: true;
  repo_root: string;
  project_id: string;
  project_id_minted: false;
  dry_run: boolean;
  warnings: string[];
}

interface InitResult {
  repo_root: string;
  created: string[];
  config_path: string;
  gitignore_added: string[];
  llm_tool: 'auto' | 'claude' | 'codex' | 'none';
  detected_llm_tool: 'claude' | 'codex' | null;
  prefix: string;
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

async function runInit(
  opts: InitOptions,
  operation: { signal: AbortSignal; onWait: (wait: DatabaseSetupWait) => void }
): Promise<InitResult | WorktreeInitResult> {
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
      '`--reset-config` requires `--force`; canonical history is preserved.'
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
  const registrationOnly = Object.entries(opts).every(
    ([key, value]) =>
      value === undefined ||
      (key === 'installAgent' && Array.isArray(value) && value.length === 0) ||
      (value === false &&
        ['force', 'resetConfig', 'noLlm', 'personal', 'withHooks'].includes(key)) ||
      ['cwd', 'root', 'here', 'yes', 'json', 'dryRun'].includes(key)
  );
  if (registrationOnly) {
    const historyRoot = await normalizeHistoryRoot({ env: getInvocationEnv(), cwd: repoRoot });
    const registrationConfig = await loadConfig(repoRoot, { allowMissing: true });
    const repair = await registerMissingDatabaseWorktree(
      {
        cwd: repoRoot,
        root: historyRoot.resolvedRoot,
        secretAllow: registrationConfig.redact.allow,
      },
      { dryRun: opts.dryRun, signal: operation.signal }
    );
    if (repair)
      return {
        registration_only: true,
        repo_root: repoRoot,
        project_id: repair.projectId,
        project_id_minted: false,
        dry_run: !!opts.dryRun,
        warnings: [],
      };
  }
  if (alreadyInitialized && !opts.force) {
    let registrationAdvice = '';
    if (!registrationOnly) {
      try {
        const root = await normalizeHistoryRoot({ env: getInvocationEnv(), cwd: repoRoot });
        const missing = await registerMissingDatabaseWorktree(
          { cwd: repoRoot, root: root.resolvedRoot, secretAllow: [] },
          { dryRun: true, signal: operation.signal }
        );
        if (missing)
          registrationAdvice =
            ' This worktree has no execution registration. Run `orcaops init` without installation flags to register it, or run `orcaops doctor --fix`.';
      } catch {
        // Optional registration advice must not replace the existing init refusal.
      }
    }
    throw new OrcaopsError(
      ErrorCodes.ALREADY_INITIALIZED,
      `${displayConfigPath(existingSource, repoRoot)} already exists. Run ` +
        '`orcaops configure` to change settings, or pass --force to re-initialize.' +
        registrationAdvice
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
    // `bootstrap` is decided further down, once the install set and the hook
    // registrations that could cover it are known.
    //
    // Fresh init owns the INVISIBLE default: personal scope — skills in
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
  // An explicit flag always wins over the coverage rule below.
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
  if (!preservingConfig) {
    // Coverage counts registrations that ALREADY exist on this machine, not
    // only what this run stages. Codex has no project hook surface and an
    // unattended run stages nothing, so without this a codex-bearing install
    // set could never read as covered however it is registered.
    const { surfaces, codexGate } = await inspectUserSessionHooks(await readUserHooksRecord());
    for (const result of assessMachineSessionHookCoverage({ config, surfaces, codexGate })) {
      if (result.state === 'covered') expectedMachineAgents.add(result.agent);
    }
  }
  const blockInitialChoice = (): 'managed' | 'manual' => {
    if (preservingConfig) return config.bootstrap;
    const hooksCoverInstallSet =
      config.session_hooks.enabled &&
      config.install.agents.every(
        (agent) => configSelectsProjectHook(config, agent) || expectedMachineAgents.has(agent)
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
  const gates = resolveSkillGates(getInvocationEnv());
  if (!preservingConfig && opts.agentsMd === undefined && !blockQuestionAsked) {
    // Nobody is here to approve an append, so a repository whose instruction
    // file is someone else's keeps it: editing a file the user wrote,
    // unprompted, is a worse failure than leaving this repository without a
    // routing surface — which doctor then names, with the recovery steps for
    // this scope.
    const foreign = await unmanagedInstructionFile(repoRoot);
    config.bootstrap = foreign === null ? blockInitialChoice() : 'manual';
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
        const picked = requireInitAnswer(
          await editHints(config.workflow.hints.keys, {
            enabledSkills: enabledSkillTemplates(config, gates),
            commitInsideWindow: config.workflow.commit_inside_window,
          })
        );
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
    if (tracked.length > 0) {
      throw refuseTrackedPersonalTransition(tracked, {
        fromResetDefault:
          opts.resetConfig === true && opts.scope === undefined && opts.personal !== true,
      });
    }
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
  const preservedVersion = preservingConfig
    ? (rawCurrent as Record<string, unknown>).schema_version
    : undefined;
  const desiredConfig = JSON.stringify(buildConfigDelta(config, preservedVersion), null, 2) + '\n';
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
  // --force marks identical bytes as changed; only a content change counts as created.
  if (
    configMut.changed &&
    configMut.desiredContent !== configMut.currentContent &&
    !created.includes(configRel)
  ) {
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
  const identicalRewrites = new Set(
    plan.mutations
      .filter((m) => m.desiredContent !== null && m.desiredContent === m.currentContent)
      .map((m) => m.path)
  );
  const agentsMdResults: AgentsMdResult[] = plan.agentsMd.map((m) => ({
    path: m.path,
    action: m.action === 'replaced' && identicalRewrites.has(m.path) ? 'unchanged' : m.action,
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

  const historyRoot = await normalizeHistoryRoot({ env: getInvocationEnv(), cwd: repoRoot });
  const configuredProjectId = await readProjectId(repo);
  const databaseSetup =
    mode === 'preview'
      ? await inspectDatabaseSetup(
          {
            cwd: repoRoot,
            root: historyRoot.resolvedRoot,
            ...(configuredProjectId === null ? {} : { projectId: configuredProjectId }),
          },
          { signal: operation.signal }
        )
      : null;

  let identity = {
    projectId: configuredProjectId ?? databaseSetup?.initialization?.authority.projectId ?? null,
    minted: false,
  };
  if (mode === 'apply') {
    const setup = await setupProjectDatabase(
      {
        cwd: repoRoot,
        root: historyRoot.resolvedRoot,
        ...(configuredProjectId === null ? {} : { projectId: configuredProjectId }),
        authoredPayloads: [],
        secretAllow: [...config.redact.allow],
      },
      { signal: operation.signal, onWait: operation.onWait }
    );
    try {
      if (operation.signal.aborted) {
        throw new ProjectDatabaseError(
          'CANCELLED',
          'Initialization cancelled after project history setup; retry to reuse the retained registration'
        );
      }
      identity = await adoptProjectId(repo, setup.initialization.authority.projectId);
      if (operation.signal.aborted) {
        throw new ProjectDatabaseError(
          'CANCELLED',
          'Initialization cancelled after project history registration; retry to reuse it'
        );
      }
    } catch (cause) {
      reportRetainedDatabaseSetup(setup.initialization.authority.projectId);
      throw cause;
    }
    for (const pending of setup.pending)
      warnings.push(
        `Project history ${pending.resource} publication is pending (${pending.code}): ${pending.message}`
      );
  }

  // Under global scope, materialize skills/commands into the per-user global
  // dirs (ref-counted, per-user-current, copy-default/guarded-symlink) — separate from
  // the project block/manifest above (which stay project-scoped). Mirrors `update`.
  const repoId = identity.projectId;
  const planGlobalPhase = (
    globalMode: MutationMode,
    globalManifest: GlobalInstallManifest | null,
    lockScope?: GlobalInstallLockScope
  ): Promise<GlobalInstallResult | null> => {
    // A fresh dry-run has no identity yet, so global planning is skipped rather
    // than previewed against a key that does not exist. Registered history can
    // supply the retained identity without a write.
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
  try {
    if (mode === 'preview') {
      const globalManifest = await readGlobalManifest();
      global = await planGlobalPhase('preview', globalManifest);
      await executeMutations(publishInstallManifestsLast(mutations), mode);
    } else {
      const commonDir = await repo.getCommonDirAbsolute();
      global = await withRepositoryInstallLock(commonDir, async (installLease) => {
        const globalManifest = await readGlobalManifest();
        // repoId is never null here: apply mode adopted it above.
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
  } catch (cause) {
    if (mode === 'apply') reportRetainedDatabaseSetup(identity.projectId!);
    throw cause;
  }
  if (global) warnings.push(...global.warnings);

  let machineHooks: AppliedUserSessionHookInstall | null = null;
  let machineHookGuidance: string | null = null;
  if (mode === 'apply' && stagedMachineHooks !== null && config.session_hooks.enabled) {
    try {
      machineHooks = await applyUserSessionHookInstall(stagedMachineHooks, CLI_VERSION);
      machineHookGuidance = await codexSessionHookGuidance(machineHooks.codexOutcome);
      warnings.push(...machineHooks.warnings);
    } catch (cause) {
      reportRetainedDatabaseSetup(identity.projectId!);
      throw cause;
    }
  }
  const machineHooksDeferred =
    config.session_hooks.enabled &&
    machineHookAgents.some(
      (agent) =>
        !configSelectsProjectHook(config, agent) && !machineHooks?.liveAgents.includes(agent)
    );

  // The seed offer asks the project database whether anything has been captured,
  // not whether a legacy artifact directory exists — on a migrated project that
  // directory is gone and the legacy probe offered to seed a repository that
  // already had its whole history.
  const seedSuggested =
    (await countHistoryCommits(repoRoot)) >= 20 && !(await repositoryHasCapturedHistory(repoRoot));

  return {
    repo_root: repoRoot,
    created,
    config_path: configRel,
    gitignore_added: gitignoreAdded,
    llm_tool: config.llm.tool,
    detected_llm_tool: null,
    prefix: config.naming.prefix,
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

/**
 * Every name the registry knows, not just the ones this install manages, and
 * presence separate from ownership so a dangling link counts as someone else's.
 */
async function unmanagedInstructionFile(repoRoot: string): Promise<string | null> {
  for (const rel of knownInstructionFiles()) {
    const abs = path.join(repoRoot, rel);
    if (!(await repositoryEntryExists(abs, repoRoot, 'instruction file'))) continue;
    if ((await readInstructionBlock(repoRoot, rel)) !== null) continue;
    return rel;
  }
  return null;
}

function reportRetainedDatabaseSetup(projectId: string): void {
  writeTerminalSafeStderr(
    `Project history ${projectId} remains registered, but installation did not complete. ` +
      'Retry `orcaops init`; it will reuse the retained registration.\n'
  );
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

function formatHumanInitResult(r: InitResult | WorktreeInitResult): string {
  if ('registration_only' in r) {
    return `${r.dry_run ? 'Would register' : 'Registered'} this worktree with existing project ${r.project_id}.\n`;
  }
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
      lines.push(`  ${count} skill(s) at ${root}/${r.prefix}-*/SKILL.md`);
    }
    for (const [root, count] of countByRoot(r.agent_commands_installed, 1)) {
      lines.push(`  ${count} slash command(s) at ${root}/*.md`);
    }
    lines.push('');
  }
  if (r.global?.skipped_version_mismatch) {
    lines.push(
      `Global install: SKIPPED filesystem changes (CLI v${CLI_VERSION} vs ` +
        `manifest v${r.global.materialized_by}); references unchanged.`,
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
    lines.push('LLM tool: none (llm.tool is "none"). Evaluators run in deterministic-only mode.');
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
