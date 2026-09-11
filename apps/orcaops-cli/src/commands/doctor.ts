import { run } from 'effection';
import { access, constants as fsConstants, readdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COMMAND_TEMPLATES,
  getToolAdapter,
  hashOrcaopsSection,
  isVersionAhead,
  opencodeSessionPluginPath,
  ORCAOPS_AGENTS_MD_MARKER_END,
  ORCAOPS_AGENTS_MD_MARKER_START_RE,
  readOrcaopsSectionIdentity,
  readOrcaopsSectionStampVersions,
  renderOpencodeSessionPlugin,
  renderOrcaopsAgentsMdSection,
  resolveHintLines,
  SKILL_TEMPLATES,
  type SkillId,
  skillRef,
} from '@orcaops/adapters';
import {
  commonConfigLocation,
  loadConfig,
  Repo,
  resolveCloudTarget,
  resolveCredentialStore,
  scrubAndBound,
  worktreeState,
} from '@orcaops/core';
import { requireDatabaseExecutionContext } from '@orcaops/core/history/database-retention';
import { runBoundedSubprocess } from '@orcaops/evaluator-protocol/subprocess';
import {
  computeEvaluatorFingerprint,
  discoverEvaluators,
  evaluateConsentGate,
  type EvaluatorDiscoveryError,
  providerSelectionDescription,
  resolvePackSource,
  validatePack,
} from '@orcaops/evaluator-runner';
import {
  LLM_TOOL_PREFERENCE,
  type LlmProvider,
  probeProviderAvailability,
  providerBinPath,
  type ProviderProbeSnapshot,
  selectDefaultProvider,
} from '@orcaops/llm';
import { type CredentialStore, getAuthState } from '@orcaops/sdk';
import {
  checkoutsRoot,
  type Config,
  ConfigValidationError,
  getDefaultConfig,
  listPinsForRepo,
  type Pin,
  resolveShellKey,
} from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import { openProjectDatabase, ProjectDatabaseError } from '@orcaops/storage/history/database';

import { inspectSeedClone, repairSeed } from './seed/index.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { resolveAgentSession } from '../lib/coding-session.js';
import { displayConfigPath, resolvePersonalConfigForAdoption } from '../lib/config-file.js';
import { type DatabaseDoctorResult, inspectDatabaseDoctorHistory } from '../lib/database-doctor.js';
import { discoverEvaluatorsForCli } from '../lib/evaluator-discovery.js';
import { computePackTrustDecisions, type PackTrustDecision } from '../lib/evaluator-grants.js';
import { CLI_ROOT } from '../lib/evaluators-config.js';
import { hooksDirCandidates } from '../lib/git-hooks-dir.js';
import { reconcileInfoExclude } from '../lib/git-info-exclude.js';
import {
  activeEntries,
  readGlobalManifest,
  resolveGlobalSkillsDir,
} from '../lib/global-install.js';
import type { GlobalInstallEntry } from '../lib/global-install.js';
import {
  classifyGeneratedFile,
  detectInstallDrift,
  readGeneratedByStamp,
} from '../lib/install-drift.js';
import { resolveManagedInstructionFiles } from '../lib/install-drift.js';
import { readInstallManifest, toPortableManifestPath } from '../lib/install-manifest.js';
import {
  assertInvisiblePlan,
  planInstallMutations,
  publishInstallManifestsLast,
} from '../lib/install-plan.js';
import {
  getInvocationCloudBaseUrl,
  getInvocationCwd,
  getInvocationEnv,
} from '../lib/invocation-context.js';
import { resolveInvokingAgent } from '../lib/invoking-agent.js';
import {
  executeMutations,
  gitHookBody,
  planManagedGitHookRefreshMutations,
  readContainedRepositoryRegularFileOrNull,
  readRepositoryFileOrNull,
  readRepositoryRegularFileOrNull,
  resolveRepositoryPath,
} from '../lib/mutations.js';
import {
  desiredPersonalExcludeLines,
  readEffectiveLocalManifest,
  readPersonalManifestState,
} from '../lib/personal-manifest.js';
import { resolveRepoKey } from '../lib/repo-key.js';
import { withRepositoryInstallLock } from '../lib/repository-install-lock.js';
import { discoverGitRoot, resolveExplicitOverride } from '../lib/resolve-root.js';
import {
  codexDualRepresentationNote,
  evaluateUserSessionHookSurfaces,
  readUserHooksRecord,
  userSettingsSpec,
} from '../lib/session-hooks-user.js';
import {
  documentHasCustomizedSessionHook,
  planSessionHookSettings,
  type SettingsSpec,
  settingsSpecs,
} from '../lib/session-hooks.js';
import {
  CLOUD_GATED_SKILL_IDS,
  enabledSkillTemplates,
  resolveSkillGates,
  resolveSkillSet,
  type SkillGates,
} from '../lib/skill-set.js';
import {
  companionDoctorSummary,
  findOnPath,
  liveCompanionInputs,
  resolveWatchCompanion,
} from '../lib/watch-companion.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  summary: string;
  details?: string[];
}

export interface DoctorReport {
  overall: DoctorStatus;
  orcaops_version: string;
  repo_root: string;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  json?: boolean;
  cwd?: string;
  /** Show every passing check in human output instead of section summaries. */
  verbose?: boolean;
  /** Repair install surfaces and resume a missing/partial seed. */
  fix?: boolean;
  /** With `fix`, preview the repairs (mutation 'preview') without writing. */
  dryRun?: boolean;
}

/**
 * `orcaops doctor` — diagnose adapter health, env, evaluator validity, registered
 * database history, git repo state, and watchdog signals.
 *
 * Each check returns one of pass/warn/fail. Overall is the worst of any
 * check; exit code is 1 only on `fail` (warn does not block CI). The
 * watchdog roles spec'd as Claude Code Stop/PostToolUse hooks are
 * folded in here as `stale-artifacts` + `unresolved-blocks` checks.
 * (User-config writes are consent-gated: `orcaops session-hooks install`
 * and interactive personal init are the only writers, TTY-only with an
 * explicit path-listing prompt, and no repo verb — including `--fix` here —
 * ever touches a user file. The `session-hooks` check owns both surfaces'
 * health; user-file repair goes through the consent command alone.)
 */
export async function doctorAction(opts: DoctorOptions = {}): Promise<void> {
  try {
    const report = await runDoctor(opts);
    if (opts.json) {
      emitOk(report);
    } else {
      writeTerminalSafeStdout(formatHumanReport(report, opts.verbose ?? false));
    }
    if (report.overall === 'fail') {
      throw new CliExit(1);
    }
  } catch (err) {
    if (err instanceof CliExit) throw err;
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  // doctor must NOT throw on a non-git / uninitialized repo — it reports
  // those as checks. Resolve with the non-throwing primitives and fall
  // back to cwd, so checkGitRepo / checkInit report the failure instead of
  // an envelope. Running from a subdir resolves to the git worktree top.
  const cwd = path.resolve(opts.cwd ?? getInvocationCwd());
  const repoRoot = (await resolveExplicitOverride(cwd)) ?? (await discoverGitRoot(cwd)) ?? cwd;
  const checks: DoctorCheck[] = [];

  checks.push(await checkGitRepo(repoRoot));
  checks.push(await checkIndexConflicts(repoRoot));
  checks.push(await checkInit(repoRoot));
  checks.push(await guardRepositoryCheck('personal-scope', () => checkPersonalScope(repoRoot)));

  // Resolved here because doctor must still run in a repo too broken for buildContext.
  const gates = resolveSkillGates(getInvocationEnv());

  let config: Config | null = null;
  let defaultLlmProvider: LlmProvider | null = null;
  try {
    config = await loadConfig(repoRoot, { allowMissing: false });
    checks.push({
      name: 'config',
      status: 'pass',
      summary: `install=[${config.install.agents.join('+') || 'none'}], llm.tool=${config.llm.tool}`,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      checks.push({
        name: 'config',
        status: 'fail',
        summary: '.orcaops/config.json missing — run `orcaops init`',
      });
    } else {
      checks.push({
        name: 'config',
        status: 'fail',
        summary: `cannot load .orcaops/config.json: ${(err as Error).message}`,
      });
    }
  }

  let databaseHistory: DatabaseDoctorResult | null = null;
  const appendDatabaseHistory = async (dispositionTtlDays: number) => {
    try {
      databaseHistory = await readCanonicalDoctorHistory(repoRoot, dispositionTtlDays);
      checks.push(...databaseHistory.checks);
    } catch (error) {
      checks.push(databaseHistoryFailure(error));
    }
  };
  if (config) {
    const providerSnapshot =
      config.llm.tool === 'none'
        ? ({ claude: 'absent', codex: 'absent' } satisfies ProviderProbeSnapshot)
        : await run(() =>
            probeProviderAvailability({
              env: getInvocationEnv(),
              cwd: getInvocationCwd(),
            })
          );
    defaultLlmProvider = selectDefaultProvider(config.llm.tool, providerSnapshot);
    checks.push(await guardRepositoryCheck('evaluators', () => checkEvaluators(repoRoot, config)));
    checks.push(checkLlmTool(config, providerSnapshot));
    checks.push(await guardRepositoryCheck('watch-companion', () => checkWatchCompanion()));
    const resolvedDiscovery = discoverEvaluatorsForCli(repoRoot);
    checks.push(
      await guardRepositoryCheck('evaluator-provider-availability', async () => {
        const discovery = await resolvedDiscovery;
        return checkEvaluatorProviderAvailability(
          discovery.evaluators,
          config,
          providerSnapshot,
          defaultLlmProvider,
          discovery.errors
        );
      })
    );
    checks.push(
      await guardRepositoryCheck('command-evaluator-trust', async () =>
        checkCommandEvaluatorTrust(repoRoot, await resolvedDiscovery, defaultLlmProvider)
      )
    );
    checks.push(
      await guardRepositoryCheck('fingerprint-zero-match', () =>
        checkFingerprintZeroMatch(repoRoot)
      )
    );
    checks.push(
      await guardRepositoryCheck('agent-skills', () => checkAgentSkills(repoRoot, config, gates))
    );
    checks.push(
      await guardRepositoryCheck('skill-drift', () => checkSkillDrift(repoRoot, config, gates))
    );
    checks.push(
      await guardRepositoryCheck('agents-md', () => checkAgentsMd(repoRoot, config, gates))
    );
    checks.push(
      await guardRepositoryCheck('block-skill-refs', () =>
        checkBlockSkillRefs(repoRoot, config, gates)
      )
    );
    // Guarded like every other repository check: a corrupt or policy-violating
    // global manifest must degrade to a failing check (doctor is the surface
    // users reach for exactly when state is broken), never crash the command.
    checks.push(
      await guardRepositoryCheck('global-install', () => checkGlobalInstall(repoRoot, config))
    );
    checks.push(
      await guardRepositoryCheck('generated-files', () =>
        checkGeneratedFiles(repoRoot, config, gates)
      )
    );
    checks.push(await checkGitHooks(repoRoot));
    checks.push(await checkSessionHooks(repoRoot, config));
    checks.push(await checkInfoExclude(repoRoot, config));
    await appendDatabaseHistory(config.evaluators.disposition_ttl_days);
    checks.push(await guardRepositoryCheck('usage-source', () => checkUsageSourceHealth()));
    checks.push(await checkScratchCheckouts(repoRoot));
    checks.push(checkShellKey());
    if (gates.cloud) checks.push(await checkCloudAuth());
  } else {
    await appendDatabaseHistory(getDefaultConfig().evaluators.disposition_ttl_days);
  }

  // `--fix`: repair missing/stale skills, commands, and (unless bootstrap=manual)
  // the instruction block by routing through the SAME shared mutation path as
  // init/update — never raw force:true writers — so the repair inherits preview,
  // manifest recording, prefix, and hints. `force:false` preserves current-stamp
  // user edits (they stay `action:'unchanged'`). Under bootstrap=manual the shared
  // planner takes the removal branch, so skills/commands are repaired but the block
  // is never re-added. Re-run the install checks afterward so the report reflects
  // the post-fix state and `overall` recomputes below.
  if (opts.fix && config) {
    const applyFix = async (installLease: { verify(): Promise<void> }): Promise<DoctorCheck> =>
      guardRepositoryCheck('fix', async () => {
        const currentConfig = await loadConfig(repoRoot, { allowMissing: false });
        const prevInstall = await readInstallManifest(repoRoot);
        const prevLocal = await readEffectiveLocalManifest(repoRoot, currentConfig.install.scope);
        const gitignoreLines = (prevInstall?.entries ?? [])
          .filter((e) => e.kind === 'gitignore-entry')
          .map((e) => e.path);
        // Planned unconditionally, as `update` does: an empty agent set is a
        // graceful no-op for the per-agent generation, but the planner also
        // owns the agent-INDEPENDENT repairs — the info/exclude section, the
        // session-hook sweep across every known settings path, and the
        // manifest refresh. Skipping it left `--fix` unable to repair the very
        // warnings doctor had just told the user to run it for.
        const plan = await planInstallMutations({
          repoRoot,
          agents: currentConfig.install.agents,
          // Honor the configured scope (mirrors `update`): under `global` the planner
          // skips project skill/command generation, so `--fix` never writes a
          // project tree into a global-scoped repo. Without it the planner would
          // default to project generation (`input.scope !== 'global'`), polluting
          // the worktree.
          scope: currentConfig.install.scope,
          config: currentConfig,
          gates,
          generatedBy: CLI_VERSION,
          force: false,
          gitignoreLines,
          prevInstall,
          prevLocal,
        });
        const mutations = [...plan.mutations];
        const hooksDir = await new Repo(repoRoot).getHooksDir();
        if (hooksDir.source !== 'core.hooksPath') {
          mutations.push(
            ...(await planManagedGitHookRefreshMutations(repoRoot, hooksDir.dir, CLI_VERSION))
          );
        }
        if (currentConfig.install.scope === 'personal' && prevInstall === null) {
          await assertInvisiblePlan(repoRoot, mutations, plan.sessionHooks);
        }
        const mode = opts.dryRun ? 'preview' : 'apply';
        await installLease.verify();
        const exec = await executeMutations(publishInstallManifestsLast(mutations), mode);
        const repaired = exec.changed.map((m) => m.path);
        if (!opts.dryRun) {
          // Repairs landed → re-run the install checks so the report reflects the
          // post-fix state and `overall` recomputes (green) below.
          replaceCheck(
            checks,
            await guardRepositoryCheck('agent-skills', () =>
              checkAgentSkills(repoRoot, currentConfig, gates)
            )
          );
          replaceCheck(
            checks,
            await guardRepositoryCheck('skill-drift', () =>
              checkSkillDrift(repoRoot, currentConfig, gates)
            )
          );
          replaceCheck(
            checks,
            await guardRepositoryCheck('agents-md', () =>
              checkAgentsMd(repoRoot, currentConfig, gates)
            )
          );
          replaceCheck(
            checks,
            await guardRepositoryCheck('block-skill-refs', () =>
              checkBlockSkillRefs(repoRoot, currentConfig, gates)
            )
          );
          replaceCheck(checks, await checkSessionHooks(repoRoot, currentConfig));
          replaceCheck(checks, await checkInfoExclude(repoRoot, currentConfig));
          replaceCheck(checks, await checkGitHooks(repoRoot));
        }
        const seedNeedsRepair = databaseHistory?.seedNeedsRepair === true;
        let seedRepair: string | null = null;
        if (seedNeedsRepair) {
          if (opts.dryRun) {
            seedRepair = 'would run `orcaops seed --yes`';
          } else {
            await repairSeed(repoRoot);
            seedRepair = 'resumed `orcaops seed --yes`';
            try {
              databaseHistory = await readCanonicalDoctorHistory(
                repoRoot,
                currentConfig.evaluators.disposition_ttl_days
              );
              for (const check of databaseHistory.checks) replaceCheck(checks, check);
            } catch (error) {
              replaceCheck(checks, databaseHistoryFailure(error));
            }
          }
        }
        // Under --dry-run nothing was written, so the install checks stay at their
        // pre-fix state — `overall` never claims green from a dry run.
        const warnings = plan.warnings;
        const details = [
          ...repaired.map((p) => `  ~ ${p}`),
          ...(seedRepair ? [`  ~ ${seedRepair}`] : []),
          ...warnings.map((warning) => `  ! ${warning}`),
        ];
        return {
          name: 'fix',
          status: warnings.length > 0 ? 'warn' : 'pass',
          summary:
            repaired.length || seedRepair
              ? [
                  repaired.length
                    ? `${opts.dryRun ? 'would repair' : 'repaired'} ${repaired.length} file(s)`
                    : null,
                  seedRepair,
                ]
                  .filter((part): part is string => part !== null)
                  .join('; ')
              : warnings.length > 0
                ? `preserved ${warnings.length} conflict(s)`
                : 'nothing to repair',
          details: details.length > 0 ? details : undefined,
        };
      });
    if (opts.dryRun) {
      checks.push(await applyFix({ verify: async () => {} }));
    } else {
      const commonDir = await new Repo(repoRoot).getCommonDirAbsolute();
      checks.push(
        await withRepositoryInstallLock(commonDir, async (installLease) => {
          return applyFix(installLease);
        })
      );
    }
  }

  const overall: DoctorStatus = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'pass';

  return {
    overall,
    orcaops_version: CLI_VERSION,
    repo_root: repoRoot,
    checks: sanitizeDoctorChecks(checks),
  };
}

async function readCanonicalDoctorHistory(
  repoRoot: string,
  dispositionTtlDays: number
): Promise<DatabaseDoctorResult> {
  const env = getInvocationEnv();
  const root = await normalizeHistoryRoot({ env, cwd: repoRoot });
  const context = await requireDatabaseExecutionContext({
    cwd: repoRoot,
    root: root.resolvedRoot,
  });
  const database = await openProjectDatabase({ authority: context.authority, mode: 'reader' });
  try {
    const pinContext = await loadPinContext(repoRoot);
    const history = await inspectSeedClone(new Repo(repoRoot));
    return await inspectDatabaseDoctorHistory({
      database,
      context,
      pins: pinContext?.pins ?? [],
      shellKey: resolveShellKey({ env }),
      historyCommitCount: history.historyCommitCount,
      dispositionTtlDays,
    });
  } finally {
    database.close();
  }
}

function findProjectDatabaseError(error: unknown): ProjectDatabaseError | null {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ProjectDatabaseError) return current;
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return null;
}

export function databaseHistoryFailure(error: unknown): DoctorCheck {
  const failure = findProjectDatabaseError(error);
  const code = failure?.code ?? 'HISTORY_INACCESSIBLE';
  const message =
    failure?.message ??
    (error instanceof Error ? error.message : 'Registered project history is unavailable');
  const guidance =
    code === 'HISTORY_MISSING'
      ? 'Preserve the registration, SQLite companion files and retained evidence. Restore the original registered database from a verified backup if available; otherwise report this Doctor output for investigation. Setup cannot replace missing history.'
      : code === 'HISTORY_INTEGRITY_REQUIRED'
        ? 'Preserve the database, SQLite companion files, registration and retained evidence. Restore a verified backup if available; otherwise report this Doctor output for investigation. Doctor cannot reconstruct authoritative history.'
        : code === 'STALE_CONTEXT'
          ? 'History advanced during diagnosis; rerun doctor against the current registered state.'
          : ['AUTHORITY_MISMATCH', 'HISTORY_UNEXPECTED_OWNER'].includes(code)
            ? 'Use the exact registered project database and original repository authority.'
            : 'Preserve the database and registration, correct the reported boundary, then run doctor again.';
  return {
    name: 'history-database',
    status: 'fail',
    summary: `${code}: ${message}`,
    details: [guidance],
  };
}

export function sanitizeDoctorChecks(checks: readonly DoctorCheck[]): DoctorCheck[] {
  return checks.map((check) => ({
    ...check,
    summary: scrubAndBound(check.summary, 8192),
    ...(check.details === undefined
      ? {}
      : {
          details: check.details.map((detail) => scrubAndBound(detail, 8192)),
        }),
  }));
}

/** Replace a check in-place by name (after `--fix` re-runs it), else append. */
function replaceCheck(checks: DoctorCheck[], updated: DoctorCheck): void {
  const i = checks.findIndex((c) => c.name === updated.name);
  if (i >= 0) checks[i] = updated;
  else checks.push(updated);
}

async function guardRepositoryCheck(
  name: string,
  check: () => Promise<DoctorCheck>
): Promise<DoctorCheck> {
  try {
    return await check();
  } catch (err) {
    return {
      name,
      status: 'fail',
      summary: 'could not safely inspect repository-managed paths',
      details: [(err as Error).message],
    };
  }
}

/**
 * Cloud auth health. The blind spot this closes: `getAuthState` is a pure
 * local clock check, and auto-push preflights skip on an expired access token
 * — so an expired-but-renewable session silently stalls sync while nothing
 * surfaces it. Doctor distinguishes "expired but auto-recoverable (refresh
 * token present)" from "needs re-login", so the user knows `orcaops resync`
 * will self-heal rather than reaching for `orcaops login`.
 *
 * Read-only + offline (no network, no refresh): doctor reports state, it
 * doesn't mutate the session. `store` is injectable for tests.
 */
export async function checkCloudAuth(
  store: CredentialStore = resolveCredentialStore()
): Promise<DoctorCheck> {
  const name = 'cloud-auth';
  const baseUrl = resolveCloudTarget(getInvocationCloudBaseUrl());

  const state = await getAuthState(store, baseUrl);
  if (state.kind === 'connected') {
    return { name, status: 'pass', summary: `connected to ${baseUrl}` };
  }
  if (state.kind === 'not_connected') {
    return { name, status: 'pass', summary: `not logged in to ${baseUrl} (cloud sync inactive)` };
  }

  // expired — recoverable iff a refresh token is on hand and the store can
  // refresh (env tokens are cloud-managed, no refresh token to spend).
  const creds = await Promise.resolve(store.read(baseUrl));
  const recoverable = store.kind !== 'env' && !!creds?.refreshToken;
  return recoverable
    ? {
        name,
        status: 'warn',
        summary: `access token for ${baseUrl} expired but auto-recoverable`,
        details: [
          'A valid refresh token is present — no re-login needed.',
          'Run `orcaops resync` to renew now and drain pending pushes; eager sync also self-heals on the next cloud call.',
        ],
      }
    : {
        name,
        status: 'warn',
        summary: `session for ${baseUrl} expired — re-login required`,
        details: ['No refresh token available to renew automatically; run `orcaops login`.'],
      };
}

async function checkGitRepo(repoRoot: string): Promise<DoctorCheck> {
  try {
    const repo = new Repo(repoRoot);
    const branch = await repo.getCurrentBranch();
    const sha = await repo.getHeadSha();
    return {
      name: 'git-repo',
      status: 'pass',
      summary: `branch ${branch} @ ${sha.slice(0, 8)}`,
    };
  } catch (err) {
    return {
      name: 'git-repo',
      status: 'fail',
      summary: `${repoRoot} is not a git repository (or has no commits).`,
      details: [(err as Error).message],
    };
  }
}

/**
 * Initialized means governed by a config — this worktree's own, or the
 * shared personal one in the git common dir — never that `.orcaops/` exists:
 * a personal sibling has no local directory until it captures, and a stray
 * data directory without a config is residue, not an install.
 */
async function checkInit(repoRoot: string): Promise<DoctorCheck> {
  const state = await worktreeState(repoRoot);
  if (state.kind === 'enabled') {
    return {
      name: 'init',
      status: 'pass',
      summary: `governed by ${displayConfigPath(state.source, repoRoot)} (${state.source.origin} config)`,
    };
  }
  if (state.kind === 'broken') {
    const residue =
      state.error instanceof ConfigValidationError && state.error.path === 'install.scope';
    return {
      name: 'init',
      status: 'fail',
      summary: residue
        ? `unsupported residue: ${state.error.message}`
        : `configuration cannot be used: ${state.error.message}`,
    };
  }
  return {
    name: 'init',
    status: 'fail',
    summary: 'no orcaops configuration governs this worktree — run `orcaops init`',
  };
}

/**
 * `personal-scope`: the shared files a personal install depends on, reported
 * apart from database history and the machine hooks. Names the effective source, verifies the
 * common config and ownership manifest are safely contained regular files,
 * and recognises the two residue shapes: an emptied manifest left by
 * uninstall, and a stale one a fresh init would replace.
 */
async function checkPersonalScope(repoRoot: string): Promise<DoctorCheck> {
  const name = 'personal-scope';
  const state = await worktreeState(repoRoot);
  if (state.kind !== 'enabled') {
    return { name, status: 'pass', summary: 'not applicable — no governing configuration' };
  }
  const details: string[] = [`  - effective config: ${displayConfigPath(state.source, repoRoot)}`];
  let manifest: Awaited<ReturnType<typeof readPersonalManifestState>>;
  try {
    manifest = await readPersonalManifestState(repoRoot);
  } catch (err) {
    return {
      name,
      status: 'fail',
      summary: 'the common personal manifest is unsafe',
      details: [...details, `  - ${(err as Error).message}`],
    };
  }
  if (state.source.origin !== 'common') {
    const residue: string[] = [];
    if (manifest.kind === 'valid' && manifest.manifest.entries.length === 0) {
      const shared = await commonConfigLocation(repoRoot);
      const sharedContent = await readRepositoryFileOrNull(
        shared.configPath,
        shared.containmentRoot,
        'shared personal configuration'
      );
      let livePersonalConfig = false;
      if (sharedContent !== null) {
        try {
          resolvePersonalConfigForAdoption(sharedContent, shared.configPath);
          livePersonalConfig = true;
        } catch {
          livePersonalConfig = false;
        }
      }
      residue.push(
        livePersonalConfig
          ? `  - live shared personal config remains at ${shared.configPath}; this worktree uses its project override`
          : `  - ${manifest.location.manifestPath} is uninstalled personal residue; it keeps the ` +
              '`.orcaops/` exclusion so retained data in any linked worktree stays hidden'
      );
    }
    return {
      name,
      status: 'pass',
      summary: `${state.source.origin} config governs this worktree`,
      ...(residue.length > 0 ? { details: residue } : {}),
    };
  }
  details.push(`  - shared config: ${state.source.configPath} (git common dir)`);
  if (manifest.kind === 'absent') {
    return {
      name,
      status: 'warn',
      summary: 'shared personal config without its ownership manifest',
      details: [...details, '  - run `orcaops update` to rewrite personal-manifest.json'],
    };
  }
  if (manifest.kind === 'stale') {
    return {
      name,
      status: 'warn',
      summary: 'the common personal manifest is stale',
      details: [
        ...details,
        `  - ${manifest.location.manifestPath}: ${manifest.reason}; rerun \`orcaops init --personal --force\` to rewrite it`,
      ],
    };
  }
  const claims = (manifest.manifest.info_exclude ?? []).includes('.orcaops/');
  details.push(
    `  - ownership manifest: ${manifest.location.manifestPath} (${manifest.manifest.entries.length} entries, ` +
      `${claims ? 'owns' : 'does not own'} the \`.orcaops/\` exclusion)`
  );
  return {
    name,
    status: claims ? 'pass' : 'warn',
    summary: claims
      ? 'shared personal config and manifest are healthy'
      : 'the personal manifest no longer claims the `.orcaops/` exclusion',
    details,
  };
}

async function checkUsageSourceHealth(): Promise<DoctorCheck> {
  const invokedAgent = resolveInvokingAgent().agent;
  const resolved = await resolveAgentSession({
    env: getInvocationEnv(),
    cwd: getInvocationCwd(),
    invokingAgent: invokedAgent,
  });
  if (!resolved) {
    return {
      name: 'usage-source',
      status: 'pass',
      summary:
        invokedAgent === 'github-copilot'
          ? 'no active agent session; Copilot requires COPILOT_AGENT_SESSION_ID (CLI ≥ 1.0.29)'
          : 'no active agent session resolved from environment or local discovery',
    };
  }
  const snapshot = await resolved.source.readUsage(resolved.sessionId, {
    cwd: getInvocationCwd(),
  });
  if (snapshot) {
    return {
      name: 'usage-source',
      status: 'pass',
      summary: `${resolved.agent} usage found for session ${resolved.sessionId.slice(0, 8)}… (${snapshot.recordCount} record(s), via ${resolved.via})`,
    };
  }
  return {
    name: 'usage-source',
    status: 'warn',
    summary:
      `no usage data found for active ${resolved.agent} session ${resolved.sessionId.slice(0, 8)}…` +
      (resolved.agent === 'github-copilot'
        ? ' — enable Copilot OTel file export before the session starts'
        : ''),
  };
}

async function checkEvaluators(repoRoot: string, _config: Config): Promise<DoctorCheck> {
  const { evaluators, config, errors: discoveryErrors } = await discoverEvaluatorsForCli(repoRoot);

  // Run validatePack against every configured pack to surface
  // install drift (missing executables, missing prompt files,
  // params_schema mismatches) that discovery alone doesn't catch.
  const validationDetails: string[] = [];
  if (config !== null) {
    for (const pkg of config.packages) {
      try {
        const resolved = resolvePackSource(pkg.source, { repoRoot, cliRoot: CLI_ROOT });
        const validation = await validatePack(resolved);
        for (const err of validation.errors) {
          validationDetails.push(
            `  - [${pkg.id}] [${err.code}] ${err.message}` +
              (err.evaluator_id ? ` (${err.evaluator_id})` : '')
          );
        }
      } catch (err) {
        validationDetails.push(
          `  - [${pkg.id}] [resolution] ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  if (evaluators.length === 0 && discoveryErrors.length === 0 && validationDetails.length === 0) {
    return {
      name: 'evaluators',
      status: 'pass',
      summary: 'no evaluator packs installed (run `orcaops eval add-pack <source>` to install one)',
    };
  }

  if (discoveryErrors.length === 0 && validationDetails.length === 0) {
    return {
      name: 'evaluators',
      status: 'pass',
      summary: `${evaluators.length} evaluator(s) discovered and validated cleanly`,
    };
  }

  const allDetails = [...discoveryErrors.map((e) => `  - ${e.message}`), ...validationDetails];
  const issueCount = discoveryErrors.length + validationDetails.length;
  return {
    name: 'evaluators',
    status: 'warn',
    summary: `${issueCount} evaluator install/discovery issue(s); ${evaluators.length} evaluator(s) parsed cleanly`,
    details: allDetails,
  };
}

const UNVERIFIED_TOOL_DETAIL =
  'Probe did not complete, so this is not evidence the tool is missing; re-run doctor if evaluators misbehave.';

function checkLlmTool(config: Config, snapshot: ProviderProbeSnapshot): DoctorCheck {
  if (config.llm.tool === 'none') {
    return {
      name: 'llm-tool',
      status: 'pass',
      summary: 'LLM disabled (config.llm.tool=none); LLM evaluators are skipped',
    };
  }
  if (config.llm.tool === 'auto') {
    const selected = selectDefaultProvider('auto', snapshot);
    if (selected !== null && snapshot[selected] === 'present') {
      return {
        name: 'llm-tool',
        status: 'pass',
        summary: `auto-detected ${providerFoundDescription(selected)}`,
      };
    }
    const unverified = LLM_TOOL_PREFERENCE.filter(
      (provider) => snapshot[provider] === 'unverified'
    );
    if (unverified.length > 0) {
      return {
        name: 'llm-tool',
        status: 'pass',
        summary: `config.llm.tool=auto; could not verify ${unverified.map(providerProbeDescription).join(' or ')}`,
        details: [UNVERIFIED_TOOL_DETAIL],
      };
    }
    return {
      name: 'llm-tool',
      status: 'warn',
      summary: 'config.llm.tool=auto but neither configured provider CLI is available',
      details: ['LLM evaluators will be skipped until a provider is installed.'],
    };
  }
  const tool = config.llm.tool;
  const state = snapshot[tool];
  if (state === 'unverified') {
    return {
      name: 'llm-tool',
      status: 'pass',
      summary: `config.llm.tool=${tool}; could not verify ${providerProbeDescription(tool)}`,
      details: [UNVERIFIED_TOOL_DETAIL],
    };
  }
  if (state === 'absent') {
    return {
      name: 'llm-tool',
      status: 'warn',
      summary:
        providerBinPath(tool, getInvocationEnv()) === tool
          ? `config.llm.tool=${tool} but \`${tool}\` is not on PATH`
          : `config.llm.tool=${tool} but configured \`${tool}\` CLI is unavailable`,
      details: ['LLM evaluators will be skipped until the CLI is installed.'],
    };
  }
  return {
    name: 'llm-tool',
    status: 'pass',
    summary: providerFoundDescription(tool),
  };
}

function providerProbeDescription(provider: LlmProvider): string {
  return providerBinPath(provider, getInvocationEnv()) === provider
    ? `\`${provider}\` on PATH`
    : `configured \`${provider}\` CLI`;
}

function providerFoundDescription(provider: LlmProvider): string {
  return providerBinPath(provider, getInvocationEnv()) === provider
    ? `${provider} found on PATH`
    : `${provider} found via configured binary override`;
}

function checkEvaluatorProviderAvailability(
  evaluators: Awaited<ReturnType<typeof discoverEvaluators>>['evaluators'],
  config: Config,
  snapshot: ProviderProbeSnapshot,
  defaultLlmProvider: LlmProvider | null,
  discoveryErrors: readonly EvaluatorDiscoveryError[] = []
): DoctorCheck {
  // A pack that failed to load is absent from `evaluators`, so its LLM
  // evaluators cannot be probed and a clean result would read as "every
  // provider is installed" over a world missing the very ones at risk.
  if (discoveryErrors.length > 0) {
    return {
      name: 'evaluator-provider-availability',
      status: 'warn',
      summary:
        `${discoveryErrors.length} evaluator discovery problem(s); provider availability ` +
        `was checked over ${evaluators.length} evaluator(s) only`,
      details: discoveryErrors.map((err) => `${err.source_path}: ${err.message}`),
    };
  }
  if (config.llm.tool === 'none') {
    return {
      name: 'evaluator-provider-availability',
      status: 'pass',
      summary: 'LLM disabled; evaluator provider availability was not probed',
    };
  }
  const unavailable = evaluators.flatMap((evaluator) => {
    if (!evaluator.enabled || evaluator.engine.kind !== 'llm') return [];
    const provider = evaluator.engine.provider ?? defaultLlmProvider;
    if (provider === null || snapshot[provider] !== 'absent') return [];
    return [
      `  - ${evaluator.ref}: resolved provider ${provider} is not installed ` +
        `(${providerSelectionDescription(evaluator)})`,
    ];
  });
  if (unavailable.length === 0) {
    return {
      name: 'evaluator-provider-availability',
      status: 'pass',
      summary: 'no enabled LLM evaluator resolves to a confirmed-missing provider',
    };
  }
  return {
    name: 'evaluator-provider-availability',
    status: 'warn',
    summary: `${unavailable.length} enabled LLM evaluator(s) resolve to an unavailable provider`,
    details: unavailable,
  };
}

/**
 * Report on the per-user GLOBAL install for THIS repo.
 *  - scope=global but nothing materialized for this repo → WARN (a broken install: the
 *    committed block references skills that don't resolve on this machine).
 *  - this repo HAS global materialization but a DIFFERENT CLI version owns the bytes →
 *    WARN (two binaries can fight over the shared bytes).
 * The version-mismatch warn is gated on THIS repo actually holding global refs, so a
 * project-scoped repo with no global footprint never false-warns about another repo's
 * global state. `warn` never flips the exit code (only `fail` does), so these
 * surface without gating CI.
 */
async function checkGlobalInstall(repoRoot: string, config: Config): Promise<DoctorCheck> {
  const name = 'global-install';
  // Personal materializes globally too — same parity check applies.
  const isGlobal = config.install.scope === 'global' || config.install.scope === 'personal';
  const manifest = await readGlobalManifest();

  // Global state is per-user-current, ref-counted by repo id. Does the manifest
  // reference THIS repo? (Same id derivation as the pin context: projectid
  let hasThisRepo = false;
  // Entries under another agent root are not materialized here, so they must
  // not read as "installed".
  let inertForThisRepo: GlobalInstallEntry[] = [];
  if (manifest) {
    try {
      const repoId = await resolveRepoKey(new Repo(repoRoot));
      hasThisRepo = repoId !== null && activeEntries(manifest).some((e) => e.refs.includes(repoId));
      inertForThisRepo =
        repoId === null
          ? []
          : (manifest.inert_entries ?? []).filter((e) => e.refs.includes(repoId));
    } catch {
      // can't resolve the repo id → treat as not-materialized-here (conservative)
    }
  }

  // Keyed on the files STILL BEING THERE, not on whether this environment has
  // its own install: gating on the latter silences the warning the moment the
  // user follows its own advice and runs `orcaops update`, which is exactly
  // when the old root becomes permanently stranded.
  const stranded: GlobalInstallEntry[] = [];
  for (const entry of inertForThisRepo) {
    try {
      await access(entry.path);
      stranded.push(entry);
    } catch {
      // already gone
    }
  }
  if (stranded.length > 0) {
    // Skills sit at `<root>/<dir>/SKILL.md`, a flat command at `<root>/<file>.md`.
    // Nested command roots are indistinguishable here and unreachable today.
    const roots = [
      ...new Set(
        stranded.map((e) =>
          e.surface === 'skill' ? path.dirname(path.dirname(e.path)) : path.dirname(e.path)
        )
      ),
    ];
    return {
      name,
      status: 'warn',
      summary: `${stranded.length} global orcaops file(s) for this repo are recorded under a different agent root`,
      details: [
        `Recorded under: ${roots.join(', ')}.`,
        hasThisRepo
          ? 'This environment has its own materialization, so orcaops works here — but those files are still referenced by this repo and no command here can update or remove them.'
          : 'Those files are intact and still referenced, but they are not managed in this environment and no command here will update or remove them.',
        'Set the agent config dir they were installed under (CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME) back to that root and re-run `orcaops uninstall` there to release them.',
      ],
    };
  }

  // scope=global declared but nothing materialized for this repo → the committed
  // instruction block points the agent at skills that don't resolve. A health signal.
  if (isGlobal && !hasThisRepo) {
    return {
      name,
      status: 'warn',
      summary:
        'scope=global but no skills are materialized for this repo — run `orcaops update --scope global`',
      details: [
        'The committed instruction block references orcaops skills, but none are installed in your global dirs on this machine.',
      ],
    };
  }

  // Project-scoped (or no global footprint here) → nothing global to check.
  if (!hasThisRepo) {
    return {
      name,
      status: 'pass',
      summary: manifest ? 'no global install for this repo' : 'no global install',
    };
  }

  // This repo HAS global materialization → per-user-current version parity matters.
  // Gate this on hasThisRepo so a project repo never warns about another repo's bytes.
  if (manifest && manifest.materialized_by !== CLI_VERSION) {
    return {
      name,
      status: 'warn',
      summary: `global orcaops materialized by CLI v${manifest.materialized_by}; you are on v${CLI_VERSION}`,
      details: [
        'Two repos on different orcaops binaries can fight over the shared global bytes.',
        'Use that CLI for global ops, `--scope project` here, or `orcaops update --scope global --force` to take ownership.',
      ],
    };
  }
  return {
    name,
    status: 'pass',
    summary: `global install current (CLI v${CLI_VERSION}; ${activeEntries(manifest).length} materialized key(s))`,
  };
}

/**
 * Under `generated_files:"commit"`, recommend switching to `"ignore"` when
 * the committed generated trees are stale across CLI versions, which churns the
 * committed projection. Stays `status:"pass"` (it's an advisory, not a problem — the
 * staleness itself is already surfaced by `agent-skills`; this never flips `overall`).
 */
async function checkGeneratedFiles(
  repoRoot: string,
  config: Config,
  gates: SkillGates
): Promise<DoctorCheck> {
  const name = 'generated-files';
  if (config.generated_files === 'ignore') {
    return {
      name,
      status: 'pass',
      summary: 'generated_files=ignore (generated trees gitignored; materialized locally)',
    };
  }
  // commit mode. Global/personal scope has no project trees; an empty install set has nothing to churn.
  if (
    config.install.scope === 'global' ||
    config.install.scope === 'personal' ||
    config.install.agents.length === 0
  ) {
    return { name, status: 'pass', summary: 'generated_files=commit' };
  }
  const drift = await detectInstallDrift(repoRoot, config, CLI_VERSION, gates);
  // Ahead files are not churn this CLI can fix; checkAgentSkills reports them.
  const staleCount = drift ? drift.staleSkills.length + drift.staleCommands.length : 0;
  if (staleCount === 0) {
    return {
      name,
      status: 'pass',
      summary: 'generated_files=commit (no committed-projection churn)',
    };
  }
  return {
    name,
    status: 'pass',
    summary: `generated_files=commit with ${staleCount} stale committed file(s) — consider switching to "ignore"`,
    details: [
      'Committed generated trees drift across CLI versions (the projection churn the DevEx plan flags).',
      'Set config.generated_files to "ignore" so each dev materializes locally (gitignored), then `orcaops update`.',
    ],
  };
}

async function checkAgentSkills(
  repoRoot: string,
  config: Config,
  gates: SkillGates
): Promise<DoctorCheck> {
  const agents = config.install.agents;
  if (agents.length === 0) {
    return {
      name: 'agent-skills',
      status: 'pass',
      summary: 'no install agents (capture commands invoked manually)',
    };
  }
  // Under global scope the skill files live in the per-user global dirs,
  // NOT the repo — so the project-path checks below would false-report "missing".
  // Global CLI-version parity is the separate `global-install-version` check.
  if (config.install.scope === 'global' || config.install.scope === 'personal') {
    return {
      name: 'agent-skills',
      status: 'pass',
      summary: `install scope=${config.install.scope} (${agents.join(' + ')}); skills materialize in per-user global dirs`,
    };
  }

  // Aggregate across the install set; detail lines carry an [agent] tag so a stale
  // skill is attributable. The single-agent pass summary is byte-identical to before.
  const missing: string[] = [];
  const stale: string[] = [];
  const ahead: string[] = [];
  const unverifiable: string[] = [];
  let skillCount = 0;
  let cmdCount = 0;
  const labels: string[] = [];
  for (const id of agents) {
    const adapter = getToolAdapter(id);
    if (!adapter) {
      missing.push(`[${id}] (no adapter registered)`);
      continue;
    }
    labels.push(`${adapter.id} (${adapter.status})`);
    if (adapter.skills) {
      // Expected set = the ENABLED skills: a disabled skill's absence
      // is correct; its lingering presence is the skill-drift check's job.
      for (const skill of enabledSkillTemplates(config, gates)) {
        const rel = adapter.skills.filePath(skill.id, config.naming.prefix);
        const desired = adapter.skills.format(skill, {
          generatedBy: CLI_VERSION,
          prefix: config.naming.prefix,
        });
        const cls = await classifyGeneratedFile(
          path.join(repoRoot, rel),
          desired,
          CLI_VERSION,
          repoRoot
        );
        if (cls.status === 'missing') missing.push(`[${id}] ${rel}`);
        else if (cls.status === 'ahead-version')
          ahead.push(`[${id}] ${rel} (stamped @${cls.stampedVersion} — newer than this CLI)`);
        else if (cls.status === 'stale-version')
          stale.push(`[${id}] ${rel} (stamped @${cls.stampedVersion})`);
        else if (cls.status === 'stale-body')
          stale.push(`[${id}] ${rel} (body drift at v${cls.stampedVersion})`);
        else if (cls.status === 'unverifiable')
          unverifiable.push(`[${id}] ${rel} (no content fingerprint at v${cls.stampedVersion})`);
        skillCount++;
      }
    }
    if (adapter.commands) {
      for (const cmd of COMMAND_TEMPLATES) {
        const rel = adapter.commands.filePath(cmd.id, config.naming.prefix);
        const desired = adapter.commands.format(cmd, {
          generatedBy: CLI_VERSION,
          prefix: config.naming.prefix,
        });
        const cls = await classifyGeneratedFile(
          path.join(repoRoot, rel),
          desired,
          CLI_VERSION,
          repoRoot
        );
        if (cls.status === 'missing') missing.push(`[${id}] ${rel}`);
        else if (cls.status === 'ahead-version')
          ahead.push(`[${id}] ${rel} (stamped @${cls.stampedVersion} — newer than this CLI)`);
        else if (cls.status === 'stale-version')
          stale.push(`[${id}] ${rel} (stamped @${cls.stampedVersion})`);
        else if (cls.status === 'stale-body')
          stale.push(`[${id}] ${rel} (body drift at v${cls.stampedVersion})`);
        else if (cls.status === 'unverifiable')
          unverifiable.push(`[${id}] ${rel} (no content fingerprint at v${cls.stampedVersion})`);
        cmdCount++;
      }
    }
  }

  if (
    missing.length === 0 &&
    stale.length === 0 &&
    ahead.length === 0 &&
    unverifiable.length === 0
  ) {
    const parts: string[] = [];
    if (skillCount > 0) parts.push(`${skillCount} skill(s)`);
    if (cmdCount > 0) parts.push(`${cmdCount} command(s)`);
    return {
      name: 'agent-skills',
      status: 'pass',
      summary: `${labels.join(' + ')}: ${parts.join(' + ')} at v${CLI_VERSION}`,
    };
  }
  const details: string[] = [];
  if (missing.length > 0) {
    details.push(`Missing (${missing.length}):`);
    for (const m of missing) details.push(`  - ${m}`);
  }
  if (stale.length > 0) {
    details.push(`Stale (${stale.length}):`);
    for (const s of stale) details.push(`  - ${s}`);
  }
  if (ahead.length > 0) {
    details.push(`Ahead (${ahead.length}):`);
    for (const a of ahead) details.push(`  - ${a}`);
  }
  if (unverifiable.length > 0) {
    details.push(`Unverifiable (${unverifiable.length}):`);
    for (const u of unverifiable) details.push(`  - ${u}`);
  }
  if (missing.length > 0 || stale.length > 0) details.push('Run `orcaops update` to refresh.');
  if (ahead.length > 0) {
    details.push(
      "This CLI is older than this repo's generated files — upgrade orcaops " +
        '(`orcaops update` will not downgrade them; `doctor --fix` will not touch them).'
    );
  }
  if (unverifiable.length > 0) {
    details.push(
      'Unverifiable files carry this CLI version but no content fingerprint — plain ' +
        '`orcaops update` preserves them; inspect them or run `orcaops update --force` to regenerate.'
    );
  }
  // Keep the pre-ahead summary byte-identical when no ahead files exist.
  const summaryParts = [`${missing.length} missing`, `${stale.length} stale`];
  if (ahead.length > 0) summaryParts.push(`${ahead.length} newer-than-CLI`);
  if (unverifiable.length > 0) summaryParts.push(`${unverifiable.length} unverifiable`);
  return {
    name: 'agent-skills',
    status: 'warn',
    summary: `${labels.join(' + ') || 'install'}: ${summaryParts.join(', ')}`,
    details,
  };
}

async function checkAgentsMd(
  repoRoot: string,
  config: Config,
  gates: SkillGates
): Promise<DoctorCheck> {
  if (config.install.agents.length === 0) {
    return {
      name: 'agents-md',
      status: 'pass',
      summary: 'no install agents (no bootstrap section managed)',
    };
  }
  // Under bootstrap=manual the user owns the instruction block; orcaops
  // does not manage it, so the missing/stale staleness warning is suppressed
  // (surfaced once at init). Skills/commands stay managed (checkAgentSkills).
  if (config.bootstrap === 'manual') {
    return {
      name: 'agents-md',
      status: 'pass',
      summary: 'bootstrap=manual (instruction block not managed by orcaops)',
    };
  }
  // Union the instruction files across the install set — every agent targets
  // AGENTS.md, so check the deduped union once (no double-count). Personal
  // scope reads CLAUDE.local.md instead.
  const instructionFiles = resolveManagedInstructionFiles(config);
  if (instructionFiles.length === 0) {
    return {
      name: 'agents-md',
      status: 'pass',
      summary: 'adapter does not manage AGENTS.md / CLAUDE.md',
    };
  }
  const missing: string[] = [];
  const stale: string[] = [];
  const ahead: string[] = [];
  const desiredHash = hashOrcaopsSection(
    renderOrcaopsAgentsMdSection({
      generatedBy: CLI_VERSION,
      prefix: config.naming.prefix,
      hints: resolveHintLines(config.workflow.hints),
      enabledSkills: enabledSkillTemplates(config, gates),
    })
  );
  for (const rel of instructionFiles) {
    const abs = path.join(repoRoot, rel);
    const identity = await readOrcaopsSectionIdentity(abs, repoRoot);
    // Ahead resolves before the missing/stale/content checks: an ahead
    // block's remedy is upgrading orcaops, and the write paths preserve it —
    // including a MALFORMED ahead block, whose identity is null but whose
    // stamps are still readable.
    const aheadStamp =
      identity !== null
        ? isVersionAhead(identity.version, CLI_VERSION)
          ? identity.version
          : undefined
        : (await readOrcaopsSectionStampVersions(abs, repoRoot)).find((v) =>
            isVersionAhead(v, CLI_VERSION)
          );
    if (aheadStamp !== undefined) {
      ahead.push(`${rel} (stamped @${aheadStamp} — newer than this CLI)`);
    } else if (identity === null) missing.push(rel);
    else if (identity.version !== CLI_VERSION) {
      stale.push(`${rel} (stamped @${identity.version})`);
    } else if (identity.contentHash !== desiredHash) {
      stale.push(`${rel} (content differs at @${identity.version})`);
    }
  }
  if (missing.length === 0 && stale.length === 0 && ahead.length === 0) {
    return {
      name: 'agents-md',
      status: 'pass',
      summary: `${instructionFiles.join(' + ')} bootstrap section present at v${CLI_VERSION}`,
    };
  }
  const details: string[] = [];
  if (missing.length > 0) {
    details.push(`Missing (${missing.length}) — agent will not know to invoke skills:`);
    for (const m of missing) details.push(`  - ${m}`);
  }
  if (stale.length > 0) {
    details.push(`Stale (${stale.length}):`);
    for (const s of stale) details.push(`  - ${s}`);
  }
  if (ahead.length > 0) {
    details.push(`Ahead (${ahead.length}):`);
    for (const a of ahead) details.push(`  - ${a}`);
  }
  if (missing.length > 0 || stale.length > 0)
    details.push('Run `orcaops update` to refresh (or pass --no-agents-md to opt out).');
  if (ahead.length > 0) {
    details.push(
      'This CLI is older than the managed block — upgrade orcaops (`orcaops update` will not downgrade it).'
    );
  }
  const summaryParts = [`${missing.length} missing`, `${stale.length} stale`];
  if (ahead.length > 0) summaryParts.push(`${ahead.length} newer-than-CLI`);
  return {
    name: 'agents-md',
    status: 'warn',
    summary: summaryParts.join(', '),
    details,
  };
}

/** Read just the managed marker region (markers included), or null if absent. */
async function readManagedBlock(absPath: string, repoRoot: string): Promise<string | null> {
  const content = await readContainedRepositoryRegularFileOrNull(
    absPath,
    repoRoot,
    'managed instruction block'
  );
  if (content === null) return null;
  const start = content.match(ORCAOPS_AGENTS_MD_MARKER_START_RE);
  if (!start || start.index === undefined) return null;
  const endIdx = content.indexOf(ORCAOPS_AGENTS_MD_MARKER_END, start.index);
  if (endIdx === -1) return null;
  return content.slice(start.index, endIdx + ORCAOPS_AGENTS_MD_MARKER_END.length);
}

/**
 * Verify the managed block references the SAME skill names that the
 * configured naming prefix installs. Catches a prefix drift — `config.naming.prefix`
 * changed but `orcaops update` wasn't re-run, so the block still names the old
 * prefix's skills (which the agent can no longer resolve).
 */
async function checkBlockSkillRefs(
  repoRoot: string,
  config: Config,
  gates: SkillGates
): Promise<DoctorCheck> {
  const name = 'block-skill-refs';
  if (config.install.agents.length === 0 || config.bootstrap === 'manual') {
    return { name, status: 'pass', summary: 'no orcaops-managed instruction block' };
  }
  const instructionFiles = resolveManagedInstructionFiles(config);
  if (instructionFiles.length === 0) {
    return { name, status: 'pass', summary: 'adapter does not manage AGENTS.md / CLAUDE.md' };
  }
  let block: string | null = null;
  for (const rel of instructionFiles) {
    block = await readManagedBlock(path.join(repoRoot, rel), repoRoot);
    if (block !== null) break;
  }
  if (block === null) {
    // Absence is the agents-md check's job; nothing to verify here.
    return { name, status: 'pass', summary: 'no managed block present' };
  }
  const prefix = config.naming.prefix;
  // Block-worthy skills: the block references a skill iff it is ENABLED
  // — lifecycle steps, read-intent entries, the plan-approval section, and any
  // skill shipping a blockTriggerLine. Validate BOTH ways: every enabled
  // block-worthy skill must be referenced (stale block after enabling), and
  // no DISABLED one may linger (dead ref after disabling).
  const BLOCK_REF_IDS = new Set<SkillId>([
    'capture',
    'checkpoint',
    'pre-pr',
    'summary',
    'digest',
    'resume',
    'why',
    'search',
    'doctor',
  ]);
  const enabledIds = new Set(enabledSkillTemplates(config, gates).map((s) => s.id));
  const blockWorthy = (id: SkillId, hasTriggerLine: boolean): boolean =>
    BLOCK_REF_IDS.has(id) || hasTriggerLine;
  const refInBlock = (id: SkillId): boolean =>
    // Word-boundary match (not substring) so a short/generic prefix can't
    // false-match a ref embedded in a longer token (the prefix-change case).
    new RegExp(`\\b${skillRef(id, prefix)}\\b`).test(block);

  const missingRefs: string[] = [];
  const lingeringRefs: string[] = [];
  for (const t of SKILL_TEMPLATES) {
    if (!blockWorthy(t.id, t.blockTriggerLine !== undefined)) continue;
    const enabled = enabledIds.has(t.id);
    const referenced = refInBlock(t.id);
    if (enabled && !referenced) missingRefs.push(skillRef(t.id, prefix));
    if (!enabled && referenced) lingeringRefs.push(skillRef(t.id, prefix));
  }
  if (missingRefs.length === 0 && lingeringRefs.length === 0) {
    return { name, status: 'pass', summary: `managed block references the ${prefix}-* skills` };
  }
  const details: string[] = [];
  if (missingRefs.length > 0) {
    details.push(`Enabled skill(s) missing from the block: ${missingRefs.join(', ')}.`);
  }
  if (lingeringRefs.length > 0) {
    details.push(`Disabled skill(s) still referenced by the block: ${lingeringRefs.join(', ')}.`);
  }
  details.push(
    'The naming prefix or enabled skill set changed but the block was not re-rendered. ' +
      'Run `orcaops update`.'
  );
  return {
    name,
    status: 'warn',
    summary:
      missingRefs.length > 0
        ? `managed block is stale for the enabled skill set (prefix "${prefix}")`
        : `managed block references disabled skill(s)`,
    details,
  };
}

/**
 * `git-hooks`: an installed orcaops hook whose body is not what this CLI
 * writes.
 *
 * The hook body ends in `|| true` so that a failing hook can never break a
 * git operation. The cost of that safety is total silence when the hook
 * invokes a command this version no longer has: merges and rebases keep
 * working, lineage just quietly stops being maintained, and nothing surfaces
 * it.
 *
 * Hooks live in `.git/hooks`, are never committed, and are NOT
 * manifest-tracked, so the install-manifest and generated-file checks cannot
 * see them. Update and doctor --fix scan the active hooks directory and route
 * stamp-owned refreshes through the same planner used by init.
 *
 * Ownership is the `# orcaops-hook v=` stamp, matching planGitHookMutation and
 * planRemoveGitHooks: an unstamped hook belongs to the user and is never
 * reported.
 */
/**
 * `info-exclude`: the invisible footprint's hiding mechanism vs the shared
 * reconciler. Personal scope with a pending ADD means the footprint is
 * visible in `git status`; any other scope with a pending STRIP means a
 * stale section survived a scope switch. Routed through the same
 * reconcileInfoExclude the install planner uses, so doctor and the writers
 * cannot disagree; `--fix` repairs via the shared planner automatically.
 */
async function checkInfoExclude(repoRoot: string, config: Config): Promise<DoctorCheck> {
  const name = 'info-exclude';
  const personal = config.install.scope === 'personal';
  try {
    const plan = await reconcileInfoExclude(
      repoRoot,
      await desiredPersonalExcludeLines(repoRoot, config.install.scope)
    );
    if (plan.desiredContent === null) {
      return {
        name,
        status: 'pass',
        summary: personal
          ? 'personal footprint hidden via info/exclude'
          : 'no orcaops info/exclude section',
      };
    }
    return {
      name,
      status: 'warn',
      summary: personal
        ? 'personal footprint NOT hidden — info/exclude section missing or stale'
        : 'stale orcaops info/exclude section after a scope switch',
      details: [
        `  - ${plan.excludePath}`,
        'Run `orcaops update` or `orcaops doctor --fix` to reconcile.',
      ],
    };
  } catch {
    // rev-parse failure — the git-repo check owns that finding.
    return { name, status: 'pass', summary: 'info/exclude not resolvable (degraded repo)' };
  }
}

async function checkGitHooks(repoRoot: string): Promise<DoctorCheck> {
  const name = 'git-hooks';
  const stale: string[] = [];
  const stranded: string[] = [];
  let installed = 0;

  // Plumbing-resolved candidate union: the dir git actually runs hooks from
  // plus the default common-dir hooks/ (linked-worktree correct). A stamped
  // hook found OUTSIDE the active dir will never run — typically a hook
  // installed before the repo adopted core.hooksPath (husky/lefthook).
  let activeDir: string;
  let candidates: string[];
  try {
    const repo = new Repo(repoRoot);
    activeDir = (await repo.getHooksDir()).dir;
    candidates = await hooksDirCandidates(repo);
  } catch {
    activeDir = path.join(repoRoot, '.git', 'hooks');
    candidates = [activeDir];
  }

  for (const dir of candidates) {
    for (const hook of ['post-merge', 'post-rewrite'] as const) {
      const rel = path.relative(repoRoot, path.join(dir, hook));
      let body: string;
      try {
        const read = await readRepositoryFileOrNull(path.join(dir, hook), dir, `Git hook ${hook}`);
        if (read === null) continue; // absent — hooks are opt-in via `--with-hooks`
        body = read;
      } catch {
        continue; // redirected or refused path — ownership is unknowable here
      }
      if (!body.includes('# orcaops-hook v=')) continue; // the user's own hook
      installed++;
      if (dir !== activeDir) stranded.push(rel);
      // Exact-body compare — the same test planGitHookMutation uses to choose
      // between 'unchanged' and 'refreshed', so doctor and the refresh path
      // cannot disagree about which hooks are stale.
      if (body !== gitHookBody(CLI_VERSION)) stale.push(rel);
    }
  }

  if (installed === 0) {
    return { name, status: 'pass', summary: 'no orcaops git hooks installed' };
  }
  if (stranded.length > 0) {
    return {
      name,
      status: 'warn',
      summary: `${stranded.length} orcaops git hook(s) will never run (core.hooksPath points elsewhere)`,
      details: [
        ...stranded.map((rel) => `  - ${rel}`),
        'core.hooksPath directs git to a different hooks dir, so these stamped hooks are ' +
          'dead. Remove them via `orcaops uninstall` or `orcaops configure`, and wire ' +
          '`orcaops lineage` into your hook manager instead.',
      ],
    };
  }
  if (stale.length === 0) {
    return { name, status: 'pass', summary: `${installed} orcaops git hook(s) current` };
  }
  return {
    name,
    status: 'warn',
    summary: `${stale.length} orcaops git hook(s) out of date`,
    details: [
      ...stale.map((rel) => `  - ${rel}`),
      'A stale hook can invoke a command this version no longer has, and the trailing ' +
        '`|| true` hides it — lineage silently stops being maintained. Run ' +
        '`orcaops update` or `orcaops doctor --fix` to refresh it.',
    ],
  };
}

/**
 * `session-hooks`: the settings-file hook entries + the generated OpenCode
 * plugin vs the running CLI. Routes through the SAME planner init/update use
 * (`planSessionHookSettings`) so doctor and the writers can never disagree on
 * what needs reconciling — the shared-planner principle checkAgentsMd and the
 * drift nudge follow; the planner is scope-aware (install project-only, strip
 * everywhere), so no compensation here. Enabled: a missing/out-of-date entry,
 * an unparseable settings file, or a non-current plugin warns. Disabled or
 * inactive-by-scope: only LINGERING orcaops entries warn (a user's broken
 * settings file with nothing of ours in it is not our finding).
 */
async function checkSessionHooks(repoRoot: string, config: Config): Promise<DoctorCheck> {
  const name = 'session-hooks';
  const active = config.session_hooks.enabled && config.install.scope === 'project';
  const findings: string[] = [];
  const info: string[] = [];
  let projectAttention = false;
  let machineAttention = false;
  const addProjectFinding = (finding: string): void => {
    projectAttention = true;
    findings.push(finding);
  };
  const addMachineFinding = (finding: string): void => {
    machineAttention = true;
    findings.push(finding);
  };
  let current = 0;
  let intentionallySkipped = 0;
  let installedEntry = false;
  try {
    const plan = await planSessionHookSettings({
      repoRoot,
      agents: config.install.agents,
      enabled: config.session_hooks.enabled,
      scope: config.install.scope,
      entries: config.session_hooks.entries,
    });
    for (const p of plan.plans) {
      if (p.action === 'unchanged') {
        current++;
        installedEntry = true;
      } else if (p.action === 'created') {
        addProjectFinding(`  - ${p.path}: orcaops entry missing`);
      } else if (p.action === 'updated') {
        addProjectFinding(`  - ${p.path}: orcaops entry out of date`);
      } else if (p.action === 'removed') {
        addProjectFinding(`  - ${p.path}: lingering orcaops entry (update will strip it)`);
      } else if (p.action === 'preserved-invalid-json') {
        addProjectFinding(`  - ${p.path}: unreadable (invalid JSON) — reconcile manually`);
      } else if (p.action === 'skipped-entries') {
        intentionallySkipped++;
      }
      // 'skipped-scope' is not a finding: install-blocked-by-scope with
      // nothing on disk is healthy, and the summary below names the state.
    }

    const inspectCustomized = (
      spec: SettingsSpec,
      settingsPath: string,
      raw: string | null
    ): void => {
      if (raw === null) return;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          documentHasCustomizedSessionHook(parsed as Record<string, unknown>, spec)
        ) {
          info.push(
            `  - ${settingsPath}: customized session-hook command is user-owned; left untouched`
          );
        }
      } catch {
        // Invalid files are reported by the shared planners when relevant.
      }
    };
    for (const spec of settingsSpecs()) {
      const settingsPath = path.join(repoRoot, spec.path);
      inspectCustomized(
        spec,
        settingsPath,
        await readRepositoryRegularFileOrNull(settingsPath, repoRoot, 'session-hook settings')
      );
    }
    if (active && config.install.agents.includes('opencode')) {
      const rel = opencodeSessionPluginPath(config.naming.prefix);
      const cls = await classifyGeneratedFile(
        path.join(repoRoot, rel),
        renderOpencodeSessionPlugin({ generatedBy: CLI_VERSION }),
        CLI_VERSION,
        repoRoot
      );
      if (cls.status === 'current') current++;
      else if (cls.status === 'missing') addProjectFinding(`  - ${rel}: plugin missing`);
      else addProjectFinding(`  - ${rel}: plugin ${cls.status}`);
    }

    // MACHINE-level surfaces (reported from repo context; machine-global
    // state). Never repaired by --fix — user files are written only by the
    // consent command. `preview` never writes.
    const record = await readUserHooksRecord();
    const machineSurfaces = await evaluateUserSessionHookSurfaces(record);
    for (const surface of machineSurfaces) {
      if (surface.state === 'installed') {
        if (!surface.recorded && surface.agent !== 'codex') {
          addMachineFinding(
            `  - ${surface.path}: orcaops entry in a user config with NO registration record — ` +
              'remove with `orcaops session-hooks uninstall` (or re-register)'
          );
        } else {
          current++;
          installedEntry = true;
        }
      } else if (surface.state === 'registered-but-broken') {
        if (surface.recorded || surface.owned) {
          addMachineFinding(
            `  - ${surface.path}: registered user-level entry is broken — ${surface.remedy}`
          );
        }
      } else if (surface.state === 'registered-but-missing') {
        addMachineFinding(
          `  - ${surface.path}: registered user-level entry is missing — ${surface.remedy}`
        );
      } else if (surface.state === 'registered-unverified') {
        if (surface.recorded) {
          addMachineFinding(
            `  - ${surface.path}: registered user-level entry could not be verified — ${surface.remedy}`
          );
        }
      } else if (surface.state === 'superseded') {
        // The hook IS registered and running — from the file the resolved
        // representation moved it to. What is left here is a duplicate
        // registration to clean up, so this warns rather than reads as broken.
        addMachineFinding(
          `  - ${surface.path}: leftover duplicate registration — ${surface.remedy}`
        );
      } else if (surface.state === 'registered-unsupported') {
        addMachineFinding(`  - ${surface.path}: ${surface.remedy}`);
      }
      // `invalid-json` is another tool's unparseable file (an unparseable one
      // of OURS reads as registered-but-broken above) — not doctor's to report.
    }
    const dualRepresentation = await codexDualRepresentationNote();
    if (dualRepresentation !== null) info.push(`  - ${dualRepresentation}`);
    for (const entry of record?.entries ?? []) {
      const userSpec = userSettingsSpec(entry.agent, entry.path);
      if (!userSpec) continue;
      // User-scope path: resolve-and-follow; unreadable stays silent (the
      // machine-scope surface checks above already report those states).
      const raw = await readFile(entry.path, 'utf8').catch(() => null);
      inspectCustomized(userSpec, entry.path, raw);
    }

    if (installedEntry) {
      // One probe answers both questions — is `orcaops` reachable, and does it
      // support the subcommand the installed entries invoke — because only the
      // bounded helper reports WHY it stopped. Every kill reason is claimed
      // before the exit code is read: a killed process reports exit_code null,
      // which would otherwise read as "the binary answered no". A probe that
      // merely ran out of time is an absence of evidence, so it stays out of
      // `findings` — telling a busy machine to upgrade its CLI is a wrong
      // remedy on the one command users run when things already look broken.
      const probe = await runBoundedSubprocess({
        argv: ['orcaops', 'hook', 'session-start', '--help'],
        cwd: getInvocationCwd(),
        env: Object.fromEntries(
          Object.entries(getInvocationEnv()).filter(([, value]) => value !== undefined)
        ) as Record<string, string>,
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      });
      if (probe.spawn_error?.code === 'ENOENT') {
        findings.push(
          '  - installed session-hook entries cannot resolve `orcaops` on PATH — ' +
            'install the CLI and expose its bin directory to agent-launched shells'
        );
      } else if (probe.killed_reason !== null) {
        info.push(
          '  - could not verify the `orcaops` on PATH supports `hook session-start` ' +
            `(probe ${probe.killed_reason}); re-run doctor if session hooks misbehave`
        );
      } else if (probe.exit_code !== 0) {
        findings.push(
          '  - the `orcaops` on PATH does not support `hook session-start` — ' +
            'upgrade the CLI before relying on installed session hooks'
        );
      }
    }
  } catch (err) {
    return {
      name,
      status: 'warn',
      summary: `session-hook check failed: ${(err as Error).message}`,
    };
  }
  if (findings.length === 0) {
    return {
      name,
      status: 'pass',
      summary: active
        ? intentionallySkipped > 0
          ? `project session-hook entries intentionally disabled for ${intentionallySkipped} agent(s); machine registration expected`
          : `${current} session-hook surface(s) current`
        : config.session_hooks.enabled
          ? `session hooks enabled but inactive under scope "${config.install.scope}" ` +
            '(project-scope only in v1); no lingering entries'
          : 'session hooks disabled; no lingering entries',
      ...(info.length > 0 ? { details: info } : {}),
    };
  }
  return {
    name,
    status: 'warn',
    summary: `${findings.length} session-hook surface(s) need attention`,
    details: [
      ...findings,
      ...info,
      ...(projectAttention
        ? [
            'Project entries: run `orcaops update` to reconcile ' +
              '(or `orcaops update --no-session-hooks` to strip).',
          ]
        : []),
      ...(machineAttention ? ['Machine registration: run `orcaops session-hooks install`.'] : []),
    ],
  };
}

/**
 * `skill-drift`: the enabled skill set vs what is actually installed.
 *
 *   - warn: a stamped `${prefix}-<id>` skill dir exists for a skill that is
 *     NOT in the enabled set — `orcaops update` will prune it (hash-guarded).
 *   - info (pass + details): enabled-but-capability-unsatisfied skills.
 */
async function checkSkillDrift(
  repoRoot: string,
  config: Config,
  gates: SkillGates
): Promise<DoctorCheck> {
  const name = 'skill-drift';
  if (config.install.agents.length === 0) {
    return { name, status: 'pass', summary: 'no install agents (no skills managed)' };
  }
  const resolved = resolveSkillSet(config, gates);
  const info: string[] = [];
  for (const d of resolved.disabled) {
    if (d.reason === 'capability_unsatisfied') {
      info.push(
        `  - ${d.template.id}: requires ${d.missing_capabilities?.join(', ')} (not satisfied by this config)`
      );
    }
  }
  const installedButDisabled: string[] = [];
  const preservedCloud: string[] = [];
  const aheadDisabled: string[] = [];
  if (config.install.scope !== 'global') {
    const prefix = config.naming.prefix;
    // Installed directory names are untrusted filesystem strings. Keep these
    // membership sets string-typed at this runtime validation boundary.
    const enabledIds = new Set<string>(resolved.enabled.map((s) => s.id));
    const knownIds = new Set<string>(SKILL_TEMPLATES.map((s) => s.id));
    // After a rename, preserved cloud skills live under a PRIOR prefix the
    // scan below cannot name; the committed manifest is the only record that
    // still owns them, so it is what earns them the inert-skill explanation.
    const manifestPaths = gates.cloud
      ? new Set<string>()
      : new Set(
          ((await readInstallManifest(repoRoot))?.entries ?? [])
            .filter((e) => e.kind === 'generated-file')
            .map((e) => toPortableManifestPath(e.path))
        );
    for (const agentId of config.install.agents) {
      const adapter = getToolAdapter(agentId);
      if (!adapter?.skills) continue;
      // `.claude/skills/${prefix}-probe/SKILL.md` → the skills ROOT two up.
      const probeRel = adapter.skills.filePath('probe', prefix);
      const skillsRoot = path.dirname(path.dirname(probeRel));
      let entries: string[] = [];
      try {
        entries = await readdir(
          resolveRepositoryPath(
            path.join(repoRoot, skillsRoot),
            repoRoot,
            `installed skills directory ${skillsRoot}`
          )
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        continue; // no skills dir → nothing installed → no drift
      }
      for (const entry of entries) {
        if (!entry.startsWith(`${prefix}-`)) {
          const rel = toPortableManifestPath(path.join(skillsRoot, entry, 'SKILL.md'));
          const cloudSuffix = [...CLOUD_GATED_SKILL_IDS].some(
            (id) =>
              entry.endsWith(`-${id}`) &&
              ![...knownIds].some(
                (other) => other.length > id.length && entry.endsWith(`-${other}`)
              )
          );
          if (!gates.cloud && cloudSuffix && manifestPaths.has(rel)) {
            preservedCloud.push(`[${agentId}] ${skillsRoot}/${entry}`);
          }
          continue;
        }
        const skillId = entry.slice(prefix.length + 1);
        if (enabledIds.has(skillId) || !knownIds.has(skillId)) continue;
        // Only orcaops-stamped dirs count — a user's own same-prefix dir is
        // not ours to flag (and never ours to prune).
        const stamp = await readGeneratedByStamp(
          path.join(repoRoot, skillsRoot, entry, 'SKILL.md'),
          repoRoot
        );
        if (stamp === null) continue;
        // Not drift: the gate never deletes, so a contributor without
        // credentials legitimately has what teammates committed. Reported
        // rather than skipped, or an inert skill has no explanation.
        if (!gates.cloud && CLOUD_GATED_SKILL_IDS.has(skillId)) {
          preservedCloud.push(`[${agentId}] ${skillsRoot}/${entry}`);
          continue;
        }
        // An AHEAD-stamped leftover cannot be pruned by this CLI (the delete
        // guard preserves it) — plain-update advice would be a no-op loop.
        if (isVersionAhead(stamp, CLI_VERSION)) {
          aheadDisabled.push(`[${agentId}] ${skillsRoot}/${entry} (stamped @${stamp})`);
        } else {
          installedButDisabled.push(`[${agentId}] ${skillsRoot}/${entry}`);
        }
      }
    }
  }

  if (preservedCloud.length > 0) {
    // Committed by teammates, so never advise removing them: that would tell a
    // contributor to fight their own git history.
    info.push(
      ...preservedCloud.map((p) => `  - ${p}`),
      `  ${preservedCloud.length} cloud skill(s) are installed here but inert without`,
      '  credentials. `orcaops login` makes them usable; they are kept, not pruned.'
    );
  }
  info.push(...(await globalCloudResidue(config, gates)));

  if (installedButDisabled.length > 0 || aheadDisabled.length > 0) {
    const details: string[] = [];
    if (installedButDisabled.length > 0) {
      details.push(...installedButDisabled.map((p) => `  - ${p}`));
      details.push('Run `orcaops update` to prune (user-edited files are preserved).');
    }
    if (aheadDisabled.length > 0) {
      details.push(...aheadDisabled.map((p) => `  - ${p}`));
      details.push(
        'These are stamped by a NEWER orcaops — this CLI will not prune them. ' +
          'Upgrade orcaops, or remove them manually after inspection.'
      );
    }
    details.push(...info);
    return {
      name,
      status: 'warn',
      summary: `${installedButDisabled.length + aheadDisabled.length} disabled skill(s) still installed`,
      details,
    };
  }
  return {
    name,
    status: 'pass',
    summary:
      info.length > 0
        ? 'installed skills match the enabled set (notes below)'
        : 'installed skills match the enabled set',
    ...(info.length > 0 ? { details: info } : {}),
  };
}

/**
 * The Task Review companion: what `orcaops watch` would launch, and whether it
 * can. Resolution is shared with the launcher; this adds the probes only a
 * health check should pay for (the executable's own version, its signature
 * on macOS, the temp dir it extracts into).
 */
async function checkWatchCompanion(): Promise<DoctorCheck> {
  const name = 'watch-companion';
  const env = getInvocationEnv();
  const inputs = liveCompanionInputs(env);
  const launch = resolveWatchCompanion(inputs);
  const base = companionDoctorSummary(launch);

  // An override that points at nothing has forfeited every fallback, so it is
  // a fault even on a workspace build. A bare name resolves the way spawn does.
  if (launch.kind === 'launch' && launch.tier === 'override') {
    const present = launch.command.includes(path.sep)
      ? await pathExists(launch.command)
      : findOnPath(launch.command, env) !== null;
    if (!present) {
      return {
        name,
        status: 'warn',
        summary: `ORCAOPS_WATCH_BIN points at ${launch.command}, which does not exist`,
        details: ['  - unset it, or point it at a runnable Task Review build'],
      };
    }
  }

  if (launch.kind !== 'launch' || launch.tier !== 'platform') {
    return {
      name,
      status: base.status,
      summary: base.summary,
      ...(base.details.length > 0 ? { details: base.details } : {}),
    };
  }

  const details = [...base.details];
  let status: DoctorStatus = base.status;
  const childEnv = Object.fromEntries(
    Object.entries(launch.env).filter(([, value]) => value !== undefined)
  ) as Record<string, string>;

  const version = await runBoundedSubprocess({
    argv: [launch.command, '--version'],
    cwd: getInvocationCwd(),
    env: childEnv,
    timeoutMs: 5_000,
    maxOutputBytes: 4 * 1024,
  });
  const reported = version.exit_code === 0 ? version.stdout.trim() : null;
  if (reported === null) {
    status = 'warn';
    details.push(
      `  - exe_version=unknown (${version.spawn_error?.code ?? version.killed_reason ?? `exit ${version.exit_code}`}); the companion may not run here — reinstall the CLI`
    );
  } else if (reported !== launch.companion?.version) {
    status = 'warn';
    details.push(
      `  - exe_version=${reported} does not match the package (${launch.companion?.version ?? '?'}); reinstall the CLI`
    );
  } else {
    details.push(`  - exe_version=${reported}`);
  }

  if (process.platform === 'darwin') {
    const sign = await runBoundedSubprocess({
      argv: ['codesign', '--verify', '--strict', launch.command],
      cwd: getInvocationCwd(),
      env: childEnv,
      timeoutMs: 10_000,
      maxOutputBytes: 4 * 1024,
    });
    if (sign.spawn_error !== null) details.push('  - codesign=n/a (codesign not found)');
    else if (sign.exit_code === 0) details.push('  - codesign=valid');
    else {
      status = 'warn';
      details.push(
        '  - codesign=invalid; macOS may refuse to run the companion — reinstall the CLI'
      );
    }
  } else {
    details.push('  - codesign=n/a');
  }

  // Bun extracts the embedded native library into a temp dir it chooses
  // itself: the launcher's TMPDIR when honoured, otherwise the platform
  // default. Both must be writable for the companion to start.
  const writable = async (dir: string): Promise<boolean> =>
    access(dir, fsConstants.W_OK).then(
      () => true,
      () => false
    );
  const tmp = launch.env.TMPDIR ?? '';
  const tmpWritable = await writable(tmp);
  const systemTmp = process.platform === 'win32' ? tmpdir() : '/tmp';
  const systemTmpWritable = await writable(systemTmp);
  if (!tmpWritable || !systemTmpWritable) status = 'warn';
  details.push(
    `  - tmpdir=${tmp} writable=${tmpWritable ? 'yes' : 'no'} system_tmp=${systemTmp} writable=${systemTmpWritable ? 'yes' : 'no'}`
  );

  // A degraded check must not keep the healthy headline. The details carried the
  // problem while the summary still read "Task Review ready", so a scanning
  // reader saw a warning row that said everything was fine.
  const summary =
    status === base.status
      ? base.summary
      : `Task Review companion needs attention (${base.summary})`;
  return { name, status, summary, details };
}

/** Does a path exist at all? (An absent dir is the common case here.) */
async function pathExists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false
  );
}

/**
 * Cloud skills in the per-user skills dir on a machine with no credentials.
 * Every repo's agent sees that directory, so without this they are invisible.
 * Reported, never pruned.
 *
 * The advice splits on OWNERSHIP, not scope: dirs the global manifest still
 * ref-counts are a healthy install held through a logout, and telling the user
 * to delete them would remove files the next login re-materializes.
 */
async function globalCloudResidue(config: Config, gates: SkillGates): Promise<string[]> {
  if (gates.cloud) return [];
  const manifest = await readGlobalManifest().catch(() => null);
  // The separator guard is on BOTH arms on purpose: entries record the SKILL.md
  // path today, so only the prefix arm fires, but a future directory-level entry
  // would otherwise let `…/orcaops-review-extra` match `…/orcaops-review`.
  const owned = (dir: string): boolean =>
    (manifest?.entries ?? []).some(
      (e) =>
        e.refs.length > 0 &&
        (e.path === dir || e.path.startsWith(`${dir}${path.sep}`) || e.path.startsWith(`${dir}/`))
    );

  const held: string[] = [];
  const orphaned: string[] = [];
  for (const agentId of config.install.agents) {
    const skillsDir = resolveGlobalSkillsDir(agentId);
    if (!skillsDir) continue;
    for (const id of CLOUD_GATED_SKILL_IDS) {
      const dir = path.join(skillsDir, `${config.naming.prefix}-${id}`);
      // readGeneratedByStamp lstats its containment root, so an absent
      // directory — the common case — must not reach it.
      if (!(await pathExists(dir))) continue;
      if (!(await readGeneratedByStamp(path.join(dir, 'SKILL.md'), skillsDir))) continue;
      (owned(dir) ? held : orphaned).push(dir);
    }
  }

  const lines: string[] = [];
  if (held.length > 0) {
    lines.push(
      ...held.map((p) => `  - ${p}`),
      `  ${held.length} cloud skill(s) are part of your global install and inert without`,
      '  credentials. `orcaops login` makes them usable again; they are kept, not pruned.'
    );
  }
  if (orphaned.length > 0) {
    lines.push(
      ...orphaned.map((p) => `  - ${p}`),
      `  ${orphaned.length} cloud skill(s) from an earlier signed-in install remain in the`,
      '  user-level skills dir, where every repo sees them. `orcaops login` makes them',
      '  usable again; otherwise remove the directories above.'
    );
  }
  return lines;
}

async function checkIndexConflicts(repoRoot: string): Promise<DoctorCheck> {
  const name = 'index-conflicts';
  try {
    const unmerged = await new Repo(repoRoot).listUnmergedPaths();
    if (unmerged === null) {
      return {
        name,
        status: 'pass',
        summary: 'unmerged-index scan skipped (git probe unavailable)',
      };
    }
    if (unmerged.length === 0) {
      return { name, status: 'pass', summary: 'no unmerged paths in the index' };
    }
    return {
      name,
      status: 'warn',
      summary: `${unmerged.length} unmerged path(s) in the git index`,
      details: [
        ...unmerged.map((p) => `  - ${p}`),
        'Checkpoint capture continues, but these paths are excluded from per-line',
        'attribution until the conflicts are resolved. Resolve (edit, then',
        '`git add <path>`) or abort the merge (`git merge --abort`).',
      ],
    };
  } catch (err) {
    return {
      name,
      status: 'pass',
      summary: `unmerged-index scan skipped (${(err as Error).message})`,
    };
  }
}

async function checkScratchCheckouts(repoRoot: string): Promise<DoctorCheck> {
  const name = 'scratch-checkouts';
  try {
    const root = checkoutsRoot(getInvocationEnv());
    // git reports worktree paths realpath-resolved; the configured root may sit
    // behind a symlink (macOS /var -> /private/var). Match against both forms.
    const rootPrefixes = new Set([root + path.sep]);
    try {
      rootPrefixes.add((await realpath(root)) + path.sep);
    } catch {
      // root absent — raw prefix alone still matches nothing, which is correct.
    }
    const registered = await new Repo(repoRoot).listWorktreePaths();
    const underRoot = registered.filter((p) =>
      [...rootPrefixes].some((prefix) => p.startsWith(prefix))
    );
    const stale: string[] = [];
    let active = 0;
    for (const p of underRoot) {
      try {
        await access(p);
        active++;
      } catch {
        stale.push(p);
      }
    }
    if (stale.length === 0) {
      return {
        name,
        status: 'pass',
        summary:
          active > 0
            ? `${active} live scratch checkout(s) under the checkouts cache`
            : 'no scratch-checkout worktree registrations',
      };
    }
    return {
      name,
      status: 'warn',
      summary: `${stale.length} stale scratch-checkout worktree registration(s)`,
      details: [
        `Registrations whose checkout dir was deleted without \`git worktree remove\` (${stale.length}):`,
        ...stale.map((p) => `  - ${p}`),
        'Run `git worktree prune` to drop them.',
      ],
    };
  } catch (err) {
    return {
      name,
      status: 'pass',
      summary: `scratch-checkout scan skipped (${(err as Error).message})`,
    };
  }
}

function checkShellKey(): DoctorCheck {
  const key = resolveShellKey({ env: getInvocationEnv() });
  if (key.kind === 'none') {
    return {
      name: 'shell-key',
      status: 'warn',
      summary:
        'no shell-key resolvable — auto-pin will silently no-op from this shell ' +
        '(headless / no session or terminal identity exposed)',
      details: [
        'Precedence: $CLAUDE_SESSION_ID → $CLAUDE_CODE_SESSION_ID → ' +
          '$CODEX_SESSION_ID → $TMUX_PANE → $STY+$WINDOW → $TTY+ppid. ' +
          'None are set in this shell.',
        'Claude Code sessions export CLAUDE_CODE_SESSION_ID, which auto-pin ' +
          'now consumes. Nuance: implicit --continue/--resume may expose the ' +
          'startup session id, while explicit --resume <id> receives the ' +
          'resumed id — a resumed conversation can occupy a different pin ' +
          'slot than the original session.',
        'For multi-session workflows, use `orcaops checkout <id>` to manually ' +
          'pin from this shell, or run orcaops from a tmux pane / set ' +
          'CLAUDE_SESSION_ID yourself to pin an explicit identity.',
      ],
    };
  }
  return {
    name: 'shell-key',
    status: 'pass',
    summary: `${key.kind} resolvable from env — auto-pin will fire on capture plan`,
  };
}

interface PinContext {
  pins: Pin[];
}

/**
 * Resolve the per-repo pin set once for all pin-related checks. Returns
 * null when the git common-dir can't be read (already covered by the
 * git-repo check, so doctor's report stays useful even if pins are
 * unreadable).
 */
async function loadPinContext(repoRoot: string): Promise<PinContext | null> {
  try {
    const repoId = await resolveRepoKey(new Repo(repoRoot));
    if (repoId === null) return null; // no identity → no pin store for this repo
    const pins = await listPinsForRepo({ repoId, env: getInvocationEnv() });
    return { pins };
  } catch {
    return null;
  }
}

const DOCTOR_SECTIONS = [
  {
    name: 'repository',
    checks: new Set([
      'git-repo',
      'index-conflicts',
      'init',
      'personal-scope',
      'config',
      'llm-tool',
      'watch-companion',
    ]),
  },
  {
    name: 'install surfaces',
    checks: new Set([
      'agent-skills',
      'agents-md',
      'block-skill-refs',
      'generated-files',
      'git-hooks',
      'global-install',
      'info-exclude',
      'session-hooks',
      'skill-drift',
    ]),
  },
  {
    name: 'artifact state',
    checks: new Set([
      'artifact-integrity',
      'cloud-auth',
      'cloud-sync-pending',
      'execution-history',
      'focus',
      'git-publications',
      'history-database',
      'lineage-identity',
      'lineage-orphan',
      'open-checkpoint-stale',
      'plan-idempotency',
      'session-history',
      'seed',
      'scratch-checkouts',
      'source-plan-history',
      'source-plan-pin-integrity',
      'stale-artifacts',
      'unresolved-blocks',
      'usage-history',
      'usage-source',
    ]),
  },
  {
    name: 'evaluator health',
    checks: new Set([
      'command-evaluator-trust',
      'evaluator-provider-availability',
      'evaluator-dismiss-rate',
      'evaluators',
      'fingerprint-zero-match',
      'persistent-evaluator-errors',
      'materialized-disposition-consistency',
      'skipped-fingerprint-rate',
      'skipped-run-analytics',
      'stale-dispositions',
    ]),
  },
  {
    name: 'pins and shell',
    checks: new Set([
      'aged-pin',
      'pin-displaced',
      'pin-orphan',
      'same-session-multi-active',
      'shell-key',
      'stale-pin',
    ]),
  },
  { name: 'repairs', checks: new Set(['fix']) },
] as const;

function doctorSection(checkName: string): string {
  return DOCTOR_SECTIONS.find((section) => section.checks.has(checkName))?.name ?? 'other';
}

function pushDoctorCheck(lines: string[], check: DoctorCheck): void {
  const marker = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
  lines.push(`${marker} ${check.name.padEnd(20)} ${check.summary}`);
  for (const detail of check.details ?? []) lines.push(`  ${detail}`);
}

function formatHumanReport(report: DoctorReport, verbose: boolean): string {
  const lines: string[] = [];
  lines.push(`orcaops doctor — v${report.orcaops_version}`);
  lines.push(`  repo: ${report.repo_root}`);
  lines.push('');

  if (verbose) {
    for (const check of report.checks) pushDoctorCheck(lines, check);
  } else {
    const sectionNames = [...DOCTOR_SECTIONS.map((section) => section.name), 'other'];
    for (const sectionName of sectionNames) {
      const checks = report.checks.filter((check) => doctorSection(check.name) === sectionName);
      if (checks.length === 0) continue;
      const passing = checks.filter((check) => check.status === 'pass');
      if (passing.length > 0) {
        const count =
          passing.length === checks.length
            ? `${passing.length} checks passed`
            : `${passing.length}/${checks.length} checks passed`;
        lines.push(`✓ ${sectionName.padEnd(20)} ${count}`);
        for (const check of passing.filter((candidate) => candidate.details?.length)) {
          lines.push(`  ${check.name}: ${check.summary}`);
          for (const detail of check.details ?? []) lines.push(`    ${detail.trimStart()}`);
        }
      }
      for (const check of checks.filter((candidate) => candidate.status !== 'pass')) {
        pushDoctorCheck(lines, check);
      }
    }
  }
  lines.push('');
  const failCount = report.checks.filter((c) => c.status === 'fail').length;
  const warnCount = report.checks.filter((c) => c.status === 'warn').length;
  let tail: string;
  if (report.overall === 'pass') {
    tail = 'all checks passed';
  } else if (report.overall === 'warn') {
    tail = `${warnCount} warning(s)`;
  } else {
    tail = `${failCount} failure(s), ${warnCount} warning(s)`;
  }
  lines.push(`Overall: ${report.overall.toUpperCase()} (${tail})`);
  lines.push('');
  return lines.join('\n');
}

// =====================================================================
// Evaluator-health doctor checks.
// =====================================================================

async function checkFingerprintZeroMatch(repoRoot: string): Promise<DoctorCheck> {
  try {
    const { evaluators, errors } = await discoverEvaluatorsForCli(repoRoot);
    if (errors.length > 0) {
      return {
        name: 'fingerprint-zero-match',
        status: 'warn',
        summary: `${errors.length} evaluator discovery problem(s); checked ${evaluators.length} available evaluator(s)`,
        details: errors.map((error) => `${error.source_path}: ${error.message}`),
      };
    }
    const offenders: Array<{ ref: string; empty: string[] }> = [];
    for (const evaluator of evaluators) {
      try {
        const fingerprint = await computeEvaluatorFingerprint(evaluator);
        if (fingerprint.empty_patterns.length)
          offenders.push({ ref: evaluator.ref, empty: fingerprint.empty_patterns });
      } catch {
        continue;
      }
    }
    return offenders.length
      ? {
          name: 'fingerprint-zero-match',
          status: 'warn',
          summary: `${offenders.length} evaluator(s) have fingerprint patterns that match no files`,
          details: offenders.flatMap(({ ref, empty }) => [
            `  - ${ref}:`,
            ...empty.map((pattern) => `      - ${pattern}`),
          ]),
        }
      : {
          name: 'fingerprint-zero-match',
          status: 'pass',
          summary: `${evaluators.length} evaluator(s) checked; all fingerprint patterns matched files`,
        };
  } catch (error) {
    return {
      name: 'fingerprint-zero-match',
      status: 'warn',
      summary: `discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkCommandEvaluatorTrust(
  repoRoot: string,
  discovery: Awaited<ReturnType<typeof discoverEvaluators>>,
  defaultLlmProvider: LlmProvider | null
): Promise<DoctorCheck> {
  const { evaluators, config: evalConfig } = discovery;
  if (evalConfig === null) {
    return {
      name: 'command-evaluator-trust',
      status: 'pass',
      summary: 'no evaluators.yaml configured',
    };
  }
  const offenders: Array<{ pack_id: string; detail?: string }> = [];
  let decisions: Map<string, PackTrustDecision>;
  try {
    decisions = await computePackTrustDecisions({
      packs: evalConfig.packages.map((entry) => ({
        packageId: entry.id,
        source: entry.source,
      })),
      repoRoot,
      cliRoot: CLI_ROOT,
      warn: () => {},
    });
  } catch (err) {
    return {
      name: 'command-evaluator-trust',
      status: 'warn',
      summary: 'could not evaluate pack trust',
      details: [`  - ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const reported = new Set<string>();
  for (const evaluator of evaluators) {
    // Disabled evaluators never dispatch, so their capabilities need no
    // grant — reporting them would warn about a refusal that cannot occur.
    if (!evaluator.enabled || reported.has(evaluator.package_id)) continue;
    const gate = evaluateConsentGate(
      evaluator.engine,
      evaluator.package_id,
      decisions.get(evaluator.package_id),
      defaultLlmProvider
    );
    if (!gate.allowed) {
      reported.add(evaluator.package_id);
      offenders.push({ pack_id: evaluator.package_id, detail: gate.reason });
    }
  }
  // A pack whose source or specs fail discovery yields no evaluators for
  // the gate loop to classify; its refused decision still names why trust
  // cannot be established (the spec-load errors themselves are the
  // `evaluators` check's domain).
  const discoveredPacks = new Set(evaluators.map((e) => e.package_id));
  for (const [packId, decision] of decisions) {
    if (decision.verdict !== 'refused' || discoveredPacks.has(packId) || reported.has(packId)) {
      continue;
    }
    offenders.push({ pack_id: packId, detail: decision.reason });
  }
  if (offenders.length === 0) {
    return {
      name: 'command-evaluator-trust',
      status: 'pass',
      summary:
        evalConfig.packages.length === 0
          ? 'no evaluator packs configured'
          : `${evalConfig.packages.length} pack(s) configured; all enabled capability-requiring evaluators have valid user-local or built-in trust`,
    };
  }
  const details = offenders.map(
    ({ pack_id, detail }) =>
      `  - ${pack_id} [no_trust] — ${detail ?? 'no valid grant'} ` +
      `(\`orcaops eval trust ${pack_id}\`)`
  );
  return {
    name: 'command-evaluator-trust',
    status: 'warn',
    summary: `${offenders.length} pack(s) need trust attention`,
    details,
  };
}
