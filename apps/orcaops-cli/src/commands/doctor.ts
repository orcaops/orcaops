import { run } from 'effection';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
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
  type ArtifactSnapshot,
  collectBaselineRefsForArtifact,
  collectPrunableRefsForArtifact,
  computeArtifactHash,
  computeUnresolvedBlocks,
  listRawBaselineRefNames,
  listRawSnapshotRefNames,
  listSnapshotRefs,
  loadConfig,
  materializeArtifactUsage,
  parseBaselineRefName,
  Repo,
  resolveCloudTarget,
  resolveCredentialStore,
  scrubAndBound,
} from '@orcaops/core';
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
import {
  ensureProjectId,
  ProjectIdentityError,
  projectIdentityRecoveryGuidance,
  readProjectId,
} from '@orcaops/project-scope';
import { type CredentialStore, getAuthState } from '@orcaops/sdk';
import {
  archiveProjectDir,
  archiveRoot,
  artifactPathsFor,
  artifactsRoot,
  ArtifactStore,
  cacheDbPath,
  checkoutsRoot,
  computeMirrorLag,
  type Config,
  type CorruptEntry,
  CURRENT_VERSION,
  DETERMINISTIC_CLOUD_SYNC_KINDS,
  hasArtifactEventLogs,
  hasDurableCacheSources,
  indexRoot,
  inspectArtifactDeletionStaging,
  inspectArtifactSources,
  listPinsForRepo,
  loadRegistry,
  parseCacheSchemaVersion,
  type Pin,
  PLAN_IDEMPOTENCY_PENDING_REMEDY,
  readEventLog,
  RecoveryRefusedError,
  registryPath,
  resolveShellKey,
  scanReviewPullRecordsForIntegrity,
  sha256Hex,
  sourcePlanCacheDir,
  Store,
  usageBlockedMissing,
} from '@orcaops/storage';

import { archiveResolutionCommands } from './archive.js';
import { inspectSeedClone, repairSeed } from './seed/index.js';
import { readSeedState } from './seed/journal.js';
import { resolveWatchBin } from './watch.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { resolveAgentSession } from '../lib/coding-session.js';
import { discoverEvaluatorsForCli } from '../lib/evaluator-discovery.js';
import { computePackTrustDecisions, type PackTrustDecision } from '../lib/evaluator-grants.js';
import { CLI_ROOT } from '../lib/evaluators-config.js';
import { readDerivedCache } from '../lib/fingerprint-cache.js';
import { hooksDirCandidates } from '../lib/git-hooks-dir.js';
import { PERSONAL_EXCLUDE_LINES, reconcileInfoExclude } from '../lib/git-info-exclude.js';
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
import {
  readInstallManifest,
  readLocalManifest,
  toPortableManifestPath,
} from '../lib/install-manifest.js';
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
import { resolveRepoKey } from '../lib/repo-key.js';
import { withRepositoryInstallLock } from '../lib/repository-install-lock.js';
import { discoverGitRoot, resolveExplicitOverride } from '../lib/resolve-root.js';
import {
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
import { STALE_CHECKPOINT_HOURS } from '../lib/session-start-state.js';
import {
  CLOUD_GATED_SKILL_IDS,
  enabledSkillTemplates,
  resolveSkillGates,
  resolveSkillSet,
  type SkillGates,
} from '../lib/skill-set.js';

// Shared with the session-start hook guidance so "stale open checkpoint"
// means the same thing in doctor and in the hook's nudge.
const STALE_HOURS = STALE_CHECKPOINT_HOURS;

/**
 * Days threshold for the `aged-pin` check. Pin >7 days old on an
 * `active` artifact suggests the work has been parked or forgotten.
 */
const PIN_AGE_DAYS_WARN = 7;

/**
 * Per-evaluator dismiss-rate thresholds for the `evaluator-dismiss-rate`
 * check. We only flag evaluators with enough signal to be meaningful
 * (≥ MIN_RUNS) and a dismiss share that's high enough to look
 * systemic rather than incidental (≥ DISMISS_RATE_WARN).
 */
const DISMISS_RATE_MIN_RUNS = 3;
const DISMISS_RATE_WARN = 0.5;

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
 * `orcaops doctor` — diagnose adapter health, env, evaluator validity, cache
 * integrity, git repo state, and watchdog signals (stale active artifacts,
 * unresolved block-severity violations).
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

  let store: Store | null = null;
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
    try {
      store = new Store(cacheDbPath(repoRoot, config), {
        containmentRoot: repoRoot,
        rebuildFreshProjection: hasDurableCacheSources(repoRoot, config),
      });
      checks.push(checkCacheSchema(store, hasArtifactEventLogs(repoRoot, config)));
      const deletionRecovery = await checkArtifactDeletionRecovery(repoRoot, store);
      if (deletionRecovery) checks.push(deletionRecovery);
    } catch (err) {
      store?.close();
      store = null;
      checks.push({
        name: 'cache',
        status: 'fail',
        summary: `cannot open SQLite cache: ${(err as Error).message}`,
        details: ['Try `orcaops rebuild` to drop and re-populate from JSON.'],
      });
    }
    checks.push(await guardRepositoryCheck('evaluators', () => checkEvaluators(repoRoot, config)));
    checks.push(checkLlmTool(config, providerSnapshot));
    checks.push(await guardRepositoryCheck('watch-runtime', () => checkWatchRuntime()));
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
  }

  if (store) {
    try {
      checks.push(checkStaleArtifacts(store));
      if (config) {
        checks.push(await guardRepositoryCheck('seed', () => checkSeed(repoRoot, config, store)));
      }
      checks.push(checkPlanIdempotency(store));
      checks.push(checkOpenCheckpointStale(store));
      checks.push(checkUnresolvedBlocks(store));
      // A local fault with a local remedy, so it runs on every machine — and it
      // owns `content-invalid` now that `cloud-sync-pending` is gated.
      const integrity = checkArtifactContentIntegrity(store);
      if (integrity) checks.push(integrity);
      checks.push(await checkUsageSourceHealth(store, config));
      // Omitted, not passed: the check NAMES are themselves a trace, and every
      // remediation they print names a command the gate hides.
      if (gates.cloud) {
        checks.push(checkCloudSyncPending(store));
        checks.push(await checkCloudAuth());
      }
      checks.push(await checkLineageOrphans(repoRoot, store));
      // Snapshot/fingerprint health. Both need `config` (for
      // ArtifactStore + projection paths); config is non-null whenever
      // store exists, but TS doesn't narrow across the `if (store)`
      // boundary — mirror the `if (config)` guard at checkStaleDispositions.
      if (config) {
        checks.push(
          await guardRepositoryCheck('stale-snapshot-refs', () =>
            checkStaleSnapshotRefs(repoRoot, config, store)
          )
        );
        checks.push(
          await guardRepositoryCheck('stale-baseline-refs', () =>
            checkStaleBaselineRefs(repoRoot, config, store)
          )
        );
        checks.push(await checkScratchCheckouts(repoRoot));
        checks.push(await checkSourcePlanPinIntegrity(repoRoot, config, store));
        checks.push(await checkSkippedFingerprintRate(repoRoot, config, store));
        checks.push(
          await guardRepositoryCheck('stale-projection', () =>
            checkStaleProjection(repoRoot, config, store)
          )
        );
        checks.push(
          await guardRepositoryCheck('event-log-corruption', () =>
            checkEventLogCorruption(repoRoot, config, store)
          )
        );
        // Archive health — mirror lag, identity drift, perms,
        // index classification, and manifest derivability.
        checks.push(...(await archiveChecks(repoRoot, config, store)));
      }
      // Local-only (needs just repoRoot): re-hash the review-pull cache.
      checks.push(await checkReviewCacheIntegrity(repoRoot));
      checks.push(checkEvaluatorDismissRates(store));
      // Evaluator-health checks. Each is a
      // bounded SQL query (no full-scan); see individual docblocks.
      checks.push(await checkFingerprintZeroMatch(repoRoot));
      checks.push(checkPersistentEvaluatorErrors(store));
      if (config) checks.push(checkStaleDispositions(store, config));
      checks.push(checkSkippedRunAnalytics(store));
      checks.push(checkMaterializedDispositionConsistency(store));
      // Pin-related doctor checks. All bounded by the
      // per-repo pin set + per-artifact event log; OSS scale.
      checks.push(checkShellKey());
      const pinCtx = await loadPinContext(repoRoot, config);
      if (pinCtx && config) {
        checks.push(checkStalePins(pinCtx, store));
        checks.push(checkAgedPins(pinCtx, store));
        checks.push(checkPinOrphans(pinCtx, store));
        checks.push(await checkSameSessionMultiActive(repoRoot, config, store));
        checks.push(await checkPinDisplaced(repoRoot, config, store));
      }
    } finally {
      store.close();
    }
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
        const prevLocal = await readLocalManifest(repoRoot);
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
          assertInvisiblePlan(mutations, plan.sessionHooks);
        }
        const mode = opts.dryRun ? 'preview' : 'apply';
        await installLease.verify();
        const exec = await executeMutations(publishInstallManifestsLast(mutations), mode);
        const repaired = exec.changed.map((m) => m.path);
        if (!opts.dryRun) {
          // Eager identity for repos without a minted id (fresh clones and
          // worktrees lack the git-local config): --fix is
          // a repair verb, so ensure `orcaops.projectid` here too (idempotent;
          // plain doctor stays read-only). Best-effort — a failure never sinks
          // the fix, and an INVALID stored id is refused by ensureProjectId
          // (never replaced) so the archive-identity check keeps reporting it.
          try {
            const identity = await ensureProjectId(new Repo(repoRoot));
            if (identity.minted) repaired.push('git config orcaops.projectid');
          } catch {
            // degraded or refused repo — the archive/identity checks already report it
          }
        }
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
        const seedNeedsRepair = checks.find((check) => check.name === 'seed')?.status === 'warn';
        let seedRepair: string | null = null;
        if (seedNeedsRepair) {
          if (opts.dryRun) {
            seedRepair = 'would run `orcaops seed --yes`';
          } else {
            await repairSeed(repoRoot);
            seedRepair = 'resumed `orcaops seed --yes`';
            const refreshedStore = new Store(cacheDbPath(repoRoot, currentConfig), {
              containmentRoot: repoRoot,
              rebuildFreshProjection: hasDurableCacheSources(repoRoot, currentConfig),
            });
            try {
              replaceCheck(
                checks,
                await guardRepositoryCheck('seed', () =>
                  checkSeed(repoRoot, currentConfig, refreshedStore)
                )
              );
            } finally {
              refreshedStore.close();
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

export async function checkSeed(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck> {
  const name = 'seed';
  const { precious, journal } = await readSeedState(
    new Repo(repoRoot),
    getInvocationEnv(),
    repoRoot,
    config
  );
  const artifacts = store.listArtifacts();
  const imported = artifacts.filter((artifact) => artifact.origin_kind === 'git-import').length;
  const live = artifacts.length - imported;
  const partial =
    precious?.pending_importance === true ||
    (journal !== null &&
      Object.values(journal.clusters).some((cluster) =>
        ['pending', 'writing', 'failed'].includes(cluster.status)
      ));

  if (partial) {
    return {
      name,
      status: 'warn',
      summary: `git-history import is partial (${imported} imported artifact(s))`,
      details: ['Resume with `orcaops seed --yes` or run `orcaops doctor --fix`.'],
    };
  }
  if (artifacts.length > 0) {
    return {
      name,
      status: 'pass',
      summary: `${live} live and ${imported} imported artifact(s) available`,
    };
  }
  const history = await inspectSeedClone(new Repo(repoRoot));
  if (journal === null && history.historyCommitCount > 0) {
    return {
      name,
      status: 'warn',
      summary: 'git history exists but Orcaops has never been seeded',
      details: [
        'Preview with `orcaops seed --dry-run`; apply with `orcaops seed --yes` or `orcaops doctor --fix`.',
      ],
    };
  }
  return {
    name,
    status: 'pass',
    summary: journal === null ? 'no git history to seed' : 'seed completed with no imports',
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
 * Settle the per-artifact reads for a ref scan. Promise.all's
 * first-rejection race could let a recovery refusal mask a co-occurring
 * containment or programming failure on the same artifact — so every read
 * settles, any non-refusal rejection rethrows (surfacing as the call-site
 * guard's failing check), and the artifact is skipped (disclosed, refs
 * kept) only when every rejection is a recovery refusal.
 */
async function settleRefScanReads<T extends readonly unknown[]>(
  artifactId: string,
  skipped: Array<{ id: string; reason: string }>,
  reads: { [K in keyof T]: Promise<T[K]> }
): Promise<T | null> {
  const settled = await Promise.allSettled(reads);
  const rejected = settled.filter(
    (entry): entry is PromiseRejectedResult => entry.status === 'rejected'
  );
  for (const entry of rejected) {
    if (!(entry.reason instanceof RecoveryRefusedError)) throw entry.reason;
  }
  if (rejected.length > 0) {
    skipped.push({
      id: artifactId,
      reason: (rejected[0].reason as RecoveryRefusedError).message,
    });
    return null;
  }
  return settled.map((entry) => (entry as PromiseFulfilledResult<unknown>).value) as unknown as T;
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

async function checkInit(repoRoot: string): Promise<DoctorCheck> {
  const orcaopsDir = path.join(repoRoot, '.orcaops');
  try {
    await access(orcaopsDir);
    return {
      name: 'init',
      status: 'pass',
      summary: '.orcaops/ exists',
    };
  } catch {
    return {
      name: 'init',
      status: 'fail',
      summary: '.orcaops/ missing — run `orcaops init`',
    };
  }
}

function checkCacheSchema(store: Store, artifactEventLogsExist: boolean): DoctorCheck {
  const versionRow = store.db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined;
  const rawVersion = versionRow?.value ?? null;
  const version = parseCacheSchemaVersion(rawVersion);
  if (version !== CURRENT_VERSION) {
    const renderedVersion =
      version !== null
        ? `v${version}`
        : rawVersion === null
          ? 'missing'
          : JSON.stringify(rawVersion);
    return {
      name: 'cache',
      status: 'fail',
      summary: `cache schema ${renderedVersion} != CURRENT_VERSION (v${CURRENT_VERSION})`,
      details: [
        'Migrations should auto-apply on Store open; this state suggests a bug.',
        'Try `orcaops rebuild` to drop and re-populate.',
      ],
    };
  }
  const counts = store.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM artifacts) AS artifacts,
         (SELECT COUNT(*) FROM checkpoints) AS checkpoints,
         (SELECT COUNT(*) FROM evaluator_runs) AS evaluator_runs`
    )
    .get() as { artifacts: number; checkpoints: number; evaluator_runs: number };
  if (store.projectionHealth === 'rebuild_pending') {
    // Durable-source replay has not completed, so the counts above never
    // describe a healthy projection.
    return {
      name: 'cache',
      status: 'warn',
      summary: `schema v${version} • projection rebuild pending`,
      details: [
        'The SQLite projection was recreated or wiped but durable-source replay has ' +
          'not completed. Any orcaops command other than doctor (or ' +
          '`orcaops rebuild`) will replay it; cache-dependent checks below ' +
          'describe the unhealed projection.',
      ],
    };
  }
  if (store.projectionHealth === 'degraded') {
    const skipped = store.projectionSkippedArtifacts;
    return {
      name: 'cache',
      status: 'warn',
      summary:
        `schema v${version} • projection degraded` +
        (skipped === null ? '' : ` • ${skipped} skipped artifact(s)`),
      details: [
        'A rebuild could not derive every artifact from its durable sources. ' +
          '`orcaops gc --apply` is disabled until the projection is healthy.',
        'Restore missing or malformed event data from an archive or backup, or move the ' +
          'affected artifact directory out of `.orcaops/artifacts/` to explicitly accept its loss.',
        'Then run `orcaops rebuild` followed by `orcaops doctor`.',
      ],
    };
  }
  if (counts.artifacts === 0 && artifactEventLogsExist) {
    return {
      name: 'cache',
      status: 'warn',
      summary: `schema v${version} • empty projection despite durable replay sources`,
      details: [
        'The cache contains no artifacts while durable event or usage logs remain. ' +
          'Run `orcaops rebuild`, then `orcaops doctor`, and inspect any skipped artifacts.',
      ],
    };
  }
  return {
    name: 'cache',
    status: 'pass',
    summary: `schema v${version} • ${counts.artifacts} artifact(s), ${counts.checkpoints} checkpoint(s), ${counts.evaluator_runs} evaluator run(s)`,
  };
}

async function checkArtifactDeletionRecovery(
  repoRoot: string,
  store: Store
): Promise<DoctorCheck | null> {
  const inspection = await inspectArtifactDeletionStaging(repoRoot);
  if (inspection.entries.length === 0 && inspection.problems.length === 0) return null;
  if (inspection.problems.length > 0) {
    return {
      name: 'artifact-deletion-recovery',
      status: 'fail',
      summary: 'protected artifact deletion staging is ambiguous',
      details: [
        ...inspection.problems,
        'Do not delete staged bytes. Correct path ownership or layout, then run `orcaops doctor` again.',
      ],
    };
  }
  return {
    name: 'artifact-deletion-recovery',
    status: 'warn',
    summary: `${inspection.entries.length} protected artifact deletion(s) require reconciliation`,
    details: [
      `projection health is ${store.projectionHealth}`,
      ...inspection.entries.map(
        (entry) => `${entry.artifact_id}: ${entry.phase} at ${entry.staging_path}`
      ),
      inspection.entries.every((entry) => entry.phase === 'committed')
        ? 'The deletion committed; correct filesystem access and rerun any orcaops command to finish cleanup and rebuild.'
        : 'Run `orcaops rebuild`; prepared staged bytes will be restored before durable replay.',
    ],
  };
}

/**
 * Coding-agent usage health: the ledger is readable and, when an agent
 * session resolves (env evidence or invoking-agent discovery), its usage data
 * is locatable. `warn` (never `fail`) when an active session has no usage
 * data — usage tracking is best-effort and must not present as a broken
 * install. Copilot gets a targeted hint: its OTel file export is off by
 * default, so "no data" usually means the export env vars are missing.
 */
async function checkUsageSourceHealth(store: Store, _config: Config | null): Promise<DoctorCheck> {
  const sessions = store.listCodingSessions();
  const totalRecords = sessions.reduce((sum, s) => sum + s.record_count, 0);
  // Config v3 removed static config.agent; the discovery-fallback hint now
  // comes from the runtime-resolved invoking agent (no-flag form — a health
  // check must never throw on a bad --invoked-by-agent value).
  const invokedAgent = resolveInvokingAgent().agent;
  const resolved = await resolveAgentSession({
    env: getInvocationEnv(),
    cwd: getInvocationCwd(),
    invokingAgent: invokedAgent,
  });
  let status: DoctorStatus = 'pass';
  let transcriptNote: string;
  if (!resolved) {
    transcriptNote =
      'no active agent session (headless run, or no session env var / discovery match)';
    if (invokedAgent === 'github-copilot') {
      transcriptNote +=
        '; Copilot sessions surface only via COPILOT_AGENT_SESSION_ID (CLI ≥ 1.0.29)';
    }
  } else {
    const snap = await resolved.source.readUsage(resolved.sessionId, { cwd: getInvocationCwd() });
    if (snap) {
      transcriptNote = `${resolved.agent} usage found for session ${resolved.sessionId.slice(0, 8)}… (${snap.recordCount} record(s), via ${resolved.via})`;
    } else {
      transcriptNote = `no usage data found for active ${resolved.agent} session ${resolved.sessionId.slice(0, 8)}…`;
      if (resolved.agent === 'github-copilot') {
        transcriptNote +=
          ' — enable Copilot OTel file export (COPILOT_OTEL_ENABLED=true, COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH) before the session starts';
      }
      status = 'warn';
    }
  }
  return {
    name: 'usage-source',
    status,
    summary: `${sessions.length} coding session(s), ${totalRecords} usage record(s) in the ledger; ${transcriptNote}`,
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
    const plan = await reconcileInfoExclude(repoRoot, personal ? PERSONAL_EXCLUDE_LINES : []);
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
      } else if (surface.state === 'invalid-json') {
        if (surface.recorded) {
          addMachineFinding(`  - ${surface.path}: user config unreadable (invalid JSON)`);
        }
      } else if (surface.state === 'registered-unsupported') {
        addMachineFinding(`  - ${surface.path}: ${surface.remedy}`);
      }
    }
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
 * A missing Bun is NOT a fault — `orcaops watch` is the only command that needs
 * it, and warning on every run would teach people to skim past doctor. Only a
 * resolvable watch binary with no Bun to run it warns.
 */
async function checkWatchRuntime(): Promise<DoctorCheck> {
  const name = 'watch-runtime';
  const env = getInvocationEnv();

  const probe = await runBoundedSubprocess({
    argv: ['bun', '--version'],
    cwd: getInvocationCwd(),
    env: Object.fromEntries(
      Object.entries(env).filter(([, value]) => value !== undefined)
    ) as Record<string, string>,
    timeoutMs: 5_000,
    maxOutputBytes: 4 * 1024,
  });
  // Kill reasons must be claimed before the exit code: a killed process reports
  // exit_code null, which would otherwise read as "bun said no".
  const bun: 'present' | 'absent' | 'unverified' =
    probe.spawn_error?.code === 'ENOENT'
      ? 'absent'
      : probe.killed_reason !== null
        ? 'unverified'
        : probe.exit_code === 0
          ? 'present'
          : 'absent';

  const resolved = resolveWatchBin(env);
  const explicitOverride = (env.ORCAOPS_WATCH_BIN ?? '') !== '';
  const watchPath = resolved.includes(path.sep)
    ? (await pathExists(resolved))
      ? resolved
      : null
    : await findOnPath(resolved, env);

  const details: string[] = [];
  if (bun === 'unverified') {
    details.push(
      `  - could not verify bun (probe ${probe.killed_reason}); re-run doctor if \`orcaops watch\` misbehaves`
    );
  }

  // An override that points at nothing has forfeited the PATH fallback, so
  // unlike a plain absence it is always a fault.
  if (explicitOverride && watchPath === null) {
    return {
      name,
      status: 'warn',
      summary: `ORCAOPS_WATCH_BIN points at ${resolved}, which does not exist`,
      details: [
        '  - unset it to fall back to PATH resolution, or point it at the installed binary',
        ...details,
      ],
    };
  }

  if (watchPath !== null && bun === 'absent') {
    return {
      name,
      status: 'warn',
      summary: `orcaops-watch found at ${watchPath} but bun is not on PATH`,
      details: [
        '  - Task Review runs under Bun; `orcaops watch` will fail to start until it is installed (https://bun.sh)',
        ...details,
      ],
    };
  }

  if (watchPath !== null) {
    return {
      name,
      status: 'pass',
      summary: `Task Review ready (bun ${bun}, orcaops-watch at ${watchPath})`,
      ...(details.length > 0 ? { details } : {}),
    };
  }

  return {
    name,
    status: 'pass',
    summary:
      bun === 'present'
        ? 'bun present; orcaops-watch not installed (optional — only `orcaops watch` needs it)'
        : `Task Review not installed (bun ${bun}, no orcaops-watch) — optional; every other command is Node-only`,
    ...(details.length > 0 ? { details } : {}),
  };
}

async function findOnPath(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, bin);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
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

function checkStaleArtifacts(store: Store): DoctorCheck {
  const now = Date.now();
  const cutoffMs = now - STALE_HOURS * 60 * 60 * 1000;
  const rows = store.db
    .prepare(
      `SELECT a.id, a.branch, a.task, a.started_at,
              COALESCE(
                (SELECT MAX(closed_at) FROM checkpoints WHERE artifact_id = a.id),
                a.started_at
              ) AS last_activity
       FROM artifacts a
       WHERE a.status = 'active'`
    )
    .all() as Array<{
    id: string;
    branch: string;
    task: string;
    started_at: string;
    last_activity: string;
  }>;
  const stale = rows.filter((r) => Date.parse(r.last_activity) < cutoffMs);
  if (stale.length === 0) {
    return {
      name: 'stale-artifacts',
      status: 'pass',
      summary: `${rows.length} active artifact(s); none idle >${STALE_HOURS}h`,
    };
  }
  const details = stale.map((r) => {
    const ageH = Math.round((now - Date.parse(r.last_activity)) / (3600 * 1000));
    return `  - ${r.id} (${r.branch}): ${ageH}h since last activity — "${truncate(r.task, 60)}"`;
  });
  details.push(
    'Resolve by capturing a summary (`orcaops capture summary --input -`) or amending the artifact.'
  );
  return {
    name: 'stale-artifacts',
    status: 'warn',
    summary: `${stale.length} active artifact(s) idle >${STALE_HOURS}h`,
    details,
  };
}

/**
 * `plan-idempotency` — reservations whose artifact never published a
 * plan: capture is refused (IDEMPOTENCY_PENDING) until the projection
 * is rebuilt or the operator confirms that no event was published.
 * Same `latestPlanRevisionN < 0` predicate as the capture-plan refusal,
 * so doctor cannot drift from it. Bounded by the reservation table.
 * pass/warn only.
 */
function checkPlanIdempotency(store: Store): DoctorCheck {
  const rows = store.db
    .prepare(
      `SELECT idempotency_key, artifact_id, created_at FROM plan_idempotency ORDER BY created_at`
    )
    .all() as Array<{ idempotency_key: string; artifact_id: string; created_at: string }>;
  const planless = rows.filter((r) => store.latestPlanRevisionN(r.artifact_id) < 0);
  if (planless.length === 0) {
    return {
      name: 'plan-idempotency',
      status: 'pass',
      summary: `${rows.length} plan reservation(s); all published`,
    };
  }
  return {
    name: 'plan-idempotency',
    status: 'warn',
    summary:
      `${planless.length} planless plan-idempotency reservation(s) — ` +
      `capture with these keys refuses (IDEMPOTENCY_PENDING)`,
    details: [
      ...planless
        .slice(0, 5)
        .map(
          (r) =>
            `  - key "${r.idempotency_key}" → artifact ${r.artifact_id} (reserved ${r.created_at})`
        ),
      ...(planless.length > 5 ? [`  …and ${planless.length - 5} more`] : []),
      'A reservation with no cached plan means the winning capture is still in flight, died ' +
        'before publishing, or published an event whose projections need recovery.',
      PLAN_IDEMPOTENCY_PENDING_REMEDY,
    ],
  };
}

/**
 * `open-checkpoint-stale`: warn when an open checkpoint hasn't
 * progressed past its open-time threshold. The same `STALE_HOURS`
 * cap as stale-artifacts so a single env knob governs both.
 *
 * Defense-in-depth for the resume / status surfaces — pure-cache
 * doctor signal that surfaces "subagent X hung mid-flight" or
 * "open cp from yesterday's session was never closed".
 */
function checkOpenCheckpointStale(store: Store): DoctorCheck {
  const now = Date.now();
  const cutoffMs = now - STALE_HOURS * 60 * 60 * 1000;
  const rows = store.db
    .prepare(
      `SELECT artifact_id, n, agent_session_id, declared_step_ids, opened_at
       FROM checkpoints
       WHERE status = 'open'`
    )
    .all() as Array<{
    artifact_id: string;
    n: number;
    agent_session_id: string | null;
    declared_step_ids: string;
    opened_at: string;
  }>;
  const stale = rows.filter((r) => Date.parse(r.opened_at) < cutoffMs);
  if (rows.length === 0) {
    return {
      name: 'open-checkpoint-stale',
      status: 'pass',
      summary: 'no open checkpoints',
    };
  }
  if (stale.length === 0) {
    return {
      name: 'open-checkpoint-stale',
      status: 'pass',
      summary: `${rows.length} open checkpoint(s); none idle >${STALE_HOURS}h`,
    };
  }
  const details = stale.map((r) => {
    const ageH = Math.round((now - Date.parse(r.opened_at)) / (3600 * 1000));
    const declared = JSON.parse(r.declared_step_ids) as string[];
    const who = r.agent_session_id ? ` (${r.agent_session_id})` : '';
    return `  - ${r.artifact_id} cp #${r.n}${who}: declared [${declared.join(', ')}], idle ${ageH}h`;
  });
  details.push(
    'Resolve by closing the cp (`orcaops capture checkpoint close`) or abandoning it (`orcaops capture checkpoint abandon`).'
  );
  return {
    name: 'open-checkpoint-stale',
    status: 'warn',
    summary: `${stale.length} open checkpoint(s) idle >${STALE_HOURS}h`,
    details,
  };
}

/**
 * `cloud-sync-pending`: warn when the activity-window scan turns up
 * artifacts whose last eager push hasn't reached cloud, with extra
 * detail when one or more is stuck (consecutive_failures > 0). Bounded
 * by the same per-branch / windowed scan the drain helper uses, so it
 * never reads more than `limit` rows.
 *
 * Surface choice: doctor only flags `warn` when there are stuck
 * artifacts (real recorded failures). A backlog of "never synced yet"
 * is normal during an offline session and would be noise here.
 */
function checkCloudSyncPending(store: Store): DoctorCheck {
  const pending = store.getCloudSyncPendingArtifacts();
  if (pending.length === 0) {
    return {
      name: 'cloud-sync-pending',
      status: 'pass',
      summary: 'no artifacts pending cloud sync',
    };
  }
  const stuck = pending.filter((p) => p.cloud_consecutive_failures > 0);
  if (stuck.length === 0) {
    return {
      name: 'cloud-sync-pending',
      status: 'pass',
      summary: `${pending.length} artifact(s) pending sync; none with recorded failures`,
    };
  }
  const now = Date.now();
  const oldestStuckMs = Math.min(
    ...stuck
      .map((p) => (p.cloud_last_push_attempt_at ? Date.parse(p.cloud_last_push_attempt_at) : NaN))
      .filter((v) => !Number.isNaN(v))
  );
  const oldestAgeMin = Number.isFinite(oldestStuckMs)
    ? Math.round((now - oldestStuckMs) / 60_000)
    : null;
  const details = stuck.slice(0, 5).map((p) => {
    const failures = p.cloud_consecutive_failures;
    const kind = p.cloud_last_push_error_kind ?? 'unknown';
    // A `content-invalid` fault is deterministic (a disallowed control byte the
    // wire assert caught), NOT transient — show the field path + the
    // scrub+rebuild remediation so it isn't mistaken for something
    // `resync --force` would clear.
    // `upgrade-required` is equally deterministic for this binary: the cloud
    // rejected its version/schema, so the generic resync-retry footer below
    // would send the user in a circle.
    if (kind === 'upgrade-required') {
      return `  - ${p.id} (${p.branch}): upgrade-required (the cloud requires a newer CLI; upgrade your orcaops install, then \`orcaops resync\`)`;
    }
    return `  - ${p.id} (${p.branch}): ${failures}× ${kind}`;
  });
  if (stuck.length > 5) details.push(`  …and ${stuck.length - 5} more`);
  // Suppress the force-retry suggestion when nothing stuck can clear with a
  // bare retry — the per-entry lines above carry the real remediation.
  const deterministic = new Set<string>(DETERMINISTIC_CLOUD_SYNC_KINDS);
  const anyRetryable = stuck.some(
    (p) => p.cloud_last_push_error_kind === null || !deterministic.has(p.cloud_last_push_error_kind)
  );
  details.push(
    anyRetryable
      ? 'Run `orcaops push-status` for the full list, or `orcaops resync --force` to retry ignoring backoff.'
      : 'Run `orcaops push-status` for the full list. A bare retry will not clear these — apply the remediation above first, then `orcaops resync`.'
  );
  return {
    name: 'cloud-sync-pending',
    status: 'warn',
    summary:
      `${stuck.length} artifact(s) stuck on cloud sync` +
      (oldestAgeMin === null ? '' : ` (oldest ${oldestAgeMin}m since last attempt)`),
    details,
  };
}

/**
 * `artifact-integrity` — artifacts carrying a disallowed control byte. A local
 * fault with a local remediation, so it runs regardless of the gate: the
 * credential-less machine is the one that can still fix it. Null when clean.
 */
function checkArtifactContentIntegrity(store: Store): DoctorCheck | null {
  const invalid = store
    .getCloudSyncPendingArtifacts()
    .filter((p) => p.cloud_last_push_error_kind === 'content-invalid');
  if (invalid.length === 0) return null;
  return {
    name: 'artifact-integrity',
    status: 'warn',
    summary: `${invalid.length} artifact(s) contain a disallowed control byte`,
    details: [
      ...invalid.slice(0, 5).map((p) => {
        const where = p.cloud_last_push_error_message
          ? ` — ${p.cloud_last_push_error_message}`
          : '';
        return `  - ${p.id} (${p.branch})${where}`;
      }),
      ...(invalid.length > 5 ? [`  …and ${invalid.length - 5} more`] : []),
      '  Scrub the disallowed byte from the event log + plan.json (recompute its',
      '  checksum), then run `orcaops rebuild`. This is not transient and will not',
      '  clear on its own.',
    ],
  };
}

/**
 * `stale-snapshot-refs` — local `refs/orcaops/snap/*` refs that should
 * no longer exist.
 *
 * Three flag classes, encoded to be *definitionally identical* to what
 * auto-prune removes (no drift):
 *
 *   - **orphan / malformed**: a raw namespace ref whose `artifact_id`
 *     is absent from the cache, OR a malformed-but-valid-git ref (no
 *     owning artifact by definition). Both are `prune --orphans`
 *     candidates.
 *   - **should-have-been-pruned**: the artifact has a summary AND its
 *     recorded `cloud_sync_state.hash` equals the hash of the SAME
 *     four projections sync feeds `computeArtifactHash` (the current
 *     fingerprint-bearing state actually synced) AND a surviving ref
 *     is in `collectPrunableRefsForArtifact`. Intentionally-kept refs
 *     (skipped close / abandon / in-flight open) and refs whose state
 *     has not yet synced (hash mismatch) are NEVER flagged.
 *   - An artifact in the strict-sync missing-manifest state (a closed
 *     cp declares a manifest_hash but its manifest is unloadable) has
 *     its refs KEPT — they are the only re-derivation material; that
 *     is `cloud-sync-pending`'s concern, surfaced here for `resync`.
 *
 * Parity is the typed `ArtifactSnapshot` contract — no reach into
 * `cloud/sync.ts`'s private `readSnapshot`, no new public surface. The
 * `ArtifactStore` reuses the doctor's shared cache `store` (the
 * `checkSameSessionMultiActive` precedent), so there is no extra
 * SQLite handle to close. `pass`/`warn` only — a ref leak is
 * recoverable, never `fail`.
 */
async function checkStaleSnapshotRefs(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck> {
  const repo = new Repo(repoRoot);
  let rawRefs: string[];
  let parsed: Awaited<ReturnType<typeof listSnapshotRefs>>;
  try {
    rawRefs = await listRawSnapshotRefNames(repo);
    parsed = await listSnapshotRefs(repo);
  } catch (err) {
    return {
      name: 'stale-snapshot-refs',
      status: 'warn',
      summary: `could not enumerate snapshot refs: ${(err as Error).message}`,
    };
  }
  if (rawRefs.length === 0) {
    return { name: 'stale-snapshot-refs', status: 'pass', summary: 'no snapshot refs' };
  }

  const parsedRefSet = new Set(parsed.map((e) => e.ref));
  // Malformed-but-valid-git refs: in the raw set but not parseable →
  // no owning artifact → orphan candidates (`prune --orphans` acts on
  // these).
  const orphanRefs: string[] = rawRefs.filter((r) => !parsedRefSet.has(r));

  const byArtifact = new Map<string, typeof parsed>();
  for (const e of parsed) {
    const list = byArtifact.get(e.artifact_id) ?? [];
    list.push(e);
    byArtifact.set(e.artifact_id, list);
  }

  const artifactStore = new ArtifactStore({ repoRoot, config, store });
  const shouldHaveBeenPruned: Array<{ id: string; count: number }> = [];
  const missingManifest: string[] = [];
  // Parseable refs whose checkpoint `n` is absent from the artifact's
  // recovered checkpoints — a pin-before-append crash orphan (the ref
  // was pinned but the checkpoint event never committed). The selector
  // (`collectPrunableRefsForArtifact`) keeps these on purpose so the
  // sync-layer auto-prune stays conservative; surfacing + cleaning them
  // is doctor's + `snapshots prune --orphans`'s job. Without this, such a
  // ref is invisible to every flag class above and the recommended prune
  // is a dead end.
  const unmodeledRefs: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const [artifactId, entries] of byArtifact) {
    const row = store.db.prepare(`SELECT status FROM artifacts WHERE id = ?`).get(artifactId) as
      | { status: string }
      | undefined;
    if (!row) {
      for (const e of entries) orphanRefs.push(e.ref);
      continue;
    }
    // A rot-refused artifact can't be analyzed for stale refs — skip it as a
    // DISCLOSED row (refs kept) rather than abort the whole doctor run.
    // Defensive by design: every artifact is read here, not just those
    // carrying snapshot refs. Only a RecoveryRefusedError degrades —
    // containment/symlink violations and programming errors propagate to
    // the call-site guard and surface as this check FAILING, never a
    // silent skip and never a dead report.
    const reads = await settleRefScanReads(artifactId, skipped, [
      artifactStore.readPlan(artifactId),
      artifactStore.readCheckpointsRecovered(artifactId),
      artifactStore.readSummary(artifactId),
      artifactStore.readEvaluatorLog(artifactId),
      artifactStore.readArtifact(artifactId),
    ] as const);
    if (reads === null) continue;
    const [plan, checkpoints, summary, evaluators, artifact] = reads;
    if (summary === null) continue; // in-flight — never auto-pruned, not stale
    // Unmodeled (pin-before-append) refs: flagged BEFORE the
    // missing-manifest / sync gates (which `continue`) because such a
    // ref is stale regardless of fingerprint/sync state — its
    // checkpoint `n` never committed. An in-flight OPEN cp has its `n`
    // present in recovered checkpoints (status 'open') so it is NOT
    // flagged here — only an `n` entirely absent from the recovered
    // set is unmodeled.
    const modeledN = new Set(checkpoints.map((c) => c.n));
    for (const e of entries) {
      if (!modeledN.has(e.n)) unmodeledRefs.push(e.ref);
    }
    // Missing-manifest guard: refs are recovery material; never flag.
    let inMissingManifest = false;
    for (const cp of checkpoints) {
      if (cp.status !== 'closed') continue;
      if (cp.diff_fingerprint_summary.manifest_hash === null) continue;
      if ((await artifactStore.readCheckpointDiffFingerprint(artifactId, cp.n)) === null) {
        inMissingManifest = true;
        break;
      }
    }
    if (inMissingManifest) {
      missingManifest.push(artifactId);
      continue;
    }
    // A pin whose content no longer hashes to its recorded hash is a drifted
    // anchor — the push would fail integrity (cloud/sync.ts readSnapshot), so
    // this artifact's current state cannot have synced and its prune-eligibility
    // hash is untrustworthy. Skip its ref analysis SILENTLY; the dedicated
    // `source-plan-pin-integrity` check owns surfacing the drift.
    const sourcePlan = artifact?.source_plan ?? null;
    if (sourcePlan && sha256Hex(sourcePlan.content) !== sourcePlan.hash) {
      continue;
    }
    // Skip never-synced artifacts BEFORE building the snapshot — their current
    // state cannot have synced, so materializing usage (a per-session window CTE)
    // for them would be pure waste.
    const syncState = store.getCloudSyncState(artifactId);
    if (syncState === null) continue;
    const snapshot: ArtifactSnapshot = {
      plan,
      checkpoints,
      summary,
      evaluators,
      // Materialized so the prune-eligibility hash matches the push's stored
      // hash for pinned artifacts (computeArtifactHash folds in {source_ref,
      // hash}); null here would mis-flag every pinned artifact as unsynced.
      source_plan: sourcePlan,
      // Same parity reason for the usage anchor: the push folds it in,
      // so doctor must materialize it identically or every usage-bearing artifact
      // mis-flags as unsynced.
      usage: materializeArtifactUsage(artifactStore, artifactId),
      // Required by ArtifactSnapshot but ignored by computeArtifactHash —
      // empty map keeps parity cast-free.
      fingerprintByN: new Map(),
    };
    if (syncState.hash !== computeArtifactHash(snapshot)) {
      continue; // current fingerprint-bearing state has not synced
    }
    const prunable = new Set(await collectPrunableRefsForArtifact(repo, artifactId, snapshot));
    const survivors = entries.filter((e) => prunable.has(e.ref));
    if (survivors.length > 0) {
      shouldHaveBeenPruned.push({ id: artifactId, count: survivors.length });
    }
  }

  const flagged =
    orphanRefs.length +
    unmodeledRefs.length +
    shouldHaveBeenPruned.reduce((a, g) => a + g.count, 0);
  if (flagged === 0) {
    return {
      name: 'stale-snapshot-refs',
      status: 'pass',
      summary:
        `${rawRefs.length} snapshot ref(s); none stale` +
        (missingManifest.length > 0
          ? ` (${missingManifest.length} artifact(s) pending resync — refs intentionally kept)`
          : '') +
        (skipped.length > 0 ? ` (${skipped.length} artifact(s) unreadable — refs kept)` : ''),
    };
  }
  const details: string[] = [];
  if (orphanRefs.length > 0) {
    details.push(`  orphan/malformed (no owning artifact): ${orphanRefs.length}`);
    for (const r of orphanRefs.slice(0, 5)) details.push(`    - ${r}`);
    if (orphanRefs.length > 5) details.push(`    …and ${orphanRefs.length - 5} more`);
  }
  if (unmodeledRefs.length > 0) {
    details.push(
      `  unmodeled (no checkpoint for that n — pin-before-append orphan): ${unmodeledRefs.length}`
    );
    for (const r of unmodeledRefs.slice(0, 5)) details.push(`    - ${r}`);
    if (unmodeledRefs.length > 5) details.push(`    …and ${unmodeledRefs.length - 5} more`);
  }
  for (const g of shouldHaveBeenPruned) {
    details.push(`  - ${g.id}: ${g.count} ref(s) synced but not auto-pruned`);
  }
  if (missingManifest.length > 0) {
    details.push(
      `  ${missingManifest.length} artifact(s) have an unloadable manifest — refs KEPT; ` +
        'run `orcaops resync --force` after fixing the disk/permissions issue.'
    );
  }
  if (skipped.length > 0) {
    details.push(`  ${skipped.length} artifact(s) unreadable — refs KEPT:`);
    for (const s of skipped.slice(0, 5)) details.push(`    - ${s.id}: ${s.reason}`);
    if (skipped.length > 5) details.push(`    …and ${skipped.length - 5} more`);
  }
  details.push(
    'Remediation: `orcaops snapshots prune --orphans --apply` (orphan/malformed/unmodeled); ' +
      '`orcaops resync --force` then re-run doctor for synced-but-not-pruned.'
  );
  return {
    name: 'stale-snapshot-refs',
    status: 'warn',
    summary: `${flagged} stale snapshot ref(s)`,
    details,
  };
}

/**
 * `stale-baseline-refs` — local `refs/orcaops/baseline/*` refs (the
 * plan-time baseline seed) that should no longer exist. The baseline
 * sibling of `stale-snapshot-refs`,
 * encoded to mirror what auto-prune removes (no drift):
 *
 *   - **orphan / malformed**: a raw baseline ref that does not
 *     `parseBaselineRefName` (a `…/<id>/garbage` malformed entry), OR whose
 *     parsed `artifact_id` is absent from the cache. Both are
 *     orphan/`prune`-candidate refs with no owning artifact.
 *   - **should-have-been-pruned**: the artifact has a summary AND its recorded
 *     `cloud_sync_state.hash` equals the hash of the SAME projections sync
 *     feeds `computeArtifactHash` (so its state actually synced) AND
 *     `collectBaselineRefsForArtifact` returns the surviving baseline ref (the
 *     artifact is finalized-and-accounted, so empty-fence recovery no longer
 *     needs the seed). In-flight / unsynced / kept-baseline artifacts are
 *     NEVER flagged — same gating as `stale-snapshot-refs`.
 *   - Missing-manifest / drifted-pin artifacts have their baseline ref KEPT
 *     and SILENTLY skipped, exactly as the snapshot check does.
 *
 * Per-artifact analysis is bounded by the (at most one-per-artifact) baseline
 * refs, themselves bounded by the repo artifact set. `pass`/`warn` only — a
 * ref leak is recoverable, never `fail`.
 */
async function checkStaleBaselineRefs(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck> {
  const repo = new Repo(repoRoot);
  let rawRefs: string[];
  try {
    rawRefs = await listRawBaselineRefNames(repo);
  } catch (err) {
    return {
      name: 'stale-baseline-refs',
      status: 'warn',
      summary: `could not enumerate baseline refs: ${(err as Error).message}`,
    };
  }
  if (rawRefs.length === 0) {
    return { name: 'stale-baseline-refs', status: 'pass', summary: 'no baseline refs' };
  }

  const artifactStore = new ArtifactStore({ repoRoot, config, store });
  // Orphan/malformed: unparseable refs, plus parseable refs whose artifact has
  // no cache row. Group the parseable ones by artifact_id for per-artifact
  // analysis (a baseline namespace has at most one ref per artifact, but the
  // unfiltered list can carry a malformed `…/<id>/garbage` sibling too).
  const orphanRefs: string[] = [];
  const byArtifact = new Map<string, string>();
  for (const ref of rawRefs) {
    const parsed = parseBaselineRefName(ref);
    if (parsed === null) {
      orphanRefs.push(ref); // malformed-but-valid-git — no owning artifact
      continue;
    }
    byArtifact.set(parsed.artifact_id, ref);
  }

  const shouldHaveBeenPruned: string[] = [];
  const missingManifest: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const [artifactId, ref] of byArtifact) {
    const row = store.db.prepare(`SELECT status FROM artifacts WHERE id = ?`).get(artifactId) as
      | { status: string }
      | undefined;
    if (!row) {
      orphanRefs.push(ref); // parsed id has no owning artifact → orphan
      continue;
    }
    // Rot-refused artifact: disclosed skip, refs kept (mirror
    // checkStaleSnapshotRefs). Only a RecoveryRefusedError degrades —
    // anything else propagates to the call-site guard and surfaces as
    // this check FAILING.
    const reads = await settleRefScanReads(artifactId, skipped, [
      artifactStore.readPlan(artifactId),
      artifactStore.readCheckpointsRecovered(artifactId),
      artifactStore.readSummary(artifactId),
      artifactStore.readEvaluatorLog(artifactId),
      artifactStore.readArtifact(artifactId),
    ] as const);
    if (reads === null) continue;
    const [plan, checkpoints, summary, evaluators, artifact] = reads;
    if (summary === null) continue; // in-flight — baseline never auto-pruned, not stale
    // Missing-manifest guard: refs are recovery material; never flag (parity
    // with the snapshot check).
    let inMissingManifest = false;
    for (const cp of checkpoints) {
      if (cp.status !== 'closed') continue;
      if (cp.diff_fingerprint_summary.manifest_hash === null) continue;
      if ((await artifactStore.readCheckpointDiffFingerprint(artifactId, cp.n)) === null) {
        inMissingManifest = true;
        break;
      }
    }
    if (inMissingManifest) {
      missingManifest.push(artifactId);
      continue;
    }
    // Drifted-pin: its hash is untrustworthy, the push could not have synced —
    // skip SILENTLY (source-plan-pin-integrity owns the surfacing).
    const sourcePlan = artifact?.source_plan ?? null;
    if (sourcePlan && sha256Hex(sourcePlan.content) !== sourcePlan.hash) {
      continue;
    }
    // Skip never-synced artifacts before materializing usage (parity with the
    // snapshot-staleness check above).
    const syncState = store.getCloudSyncState(artifactId);
    if (syncState === null) continue;
    const snapshot: ArtifactSnapshot = {
      plan,
      checkpoints,
      summary,
      evaluators,
      source_plan: sourcePlan,
      // Usage materialized for hash parity with the push (see the
      // snapshot-staleness check above).
      usage: materializeArtifactUsage(artifactStore, artifactId),
      fingerprintByN: new Map(),
    };
    if (syncState.hash !== computeArtifactHash(snapshot)) {
      continue; // current fingerprint-bearing state has not synced
    }
    const prunable = await collectBaselineRefsForArtifact(repo, artifactId, snapshot);
    if (prunable.includes(ref)) {
      shouldHaveBeenPruned.push(artifactId);
    }
  }

  const flagged = orphanRefs.length + shouldHaveBeenPruned.length;
  if (flagged === 0) {
    return {
      name: 'stale-baseline-refs',
      status: 'pass',
      summary:
        `${rawRefs.length} baseline ref(s); none stale` +
        (missingManifest.length > 0
          ? ` (${missingManifest.length} artifact(s) pending resync — refs intentionally kept)`
          : '') +
        (skipped.length > 0 ? ` (${skipped.length} artifact(s) unreadable — refs kept)` : ''),
    };
  }
  const details: string[] = [];
  if (orphanRefs.length > 0) {
    details.push(`  orphan/malformed (no owning artifact): ${orphanRefs.length}`);
    for (const r of orphanRefs.slice(0, 5)) details.push(`    - ${r}`);
    if (orphanRefs.length > 5) details.push(`    …and ${orphanRefs.length - 5} more`);
  }
  for (const id of shouldHaveBeenPruned) {
    details.push(`  - ${id}: baseline ref synced + accounted but not auto-pruned`);
  }
  if (missingManifest.length > 0) {
    details.push(
      `  ${missingManifest.length} artifact(s) have an unloadable manifest — refs KEPT; ` +
        'run `orcaops resync --force` after fixing the disk/permissions issue.'
    );
  }
  if (skipped.length > 0) {
    details.push(`  ${skipped.length} artifact(s) unreadable — refs KEPT:`);
    for (const s of skipped.slice(0, 5)) details.push(`    - ${s.id}: ${s.reason}`);
    if (skipped.length > 5) details.push(`    …and ${skipped.length - 5} more`);
  }
  details.push(
    'Remediation: `orcaops gc --apply` total-wipes a deleted artifact’s baseline ref; ' +
      '`orcaops resync --force` then re-run doctor for synced-but-not-pruned.'
  );
  return {
    name: 'stale-baseline-refs',
    status: 'warn',
    summary: `${flagged} stale baseline ref(s)`,
    details,
  };
}

/**
 * `scratch-checkouts` — scratch checkouts from `snapshots checkout` are
 * detached worktrees under the disposable checkouts cache root, and users
 * are told `rm -rf` is
 * fine — which leaves a stale worktree REGISTRATION in the repo's common dir
 * until `git worktree prune` runs. Heavy timetravel use accumulates them.
 * Reports registrations pointing under checkoutsRoot whose directory is gone.
 * Scoped strictly to THIS repo's registrations under the checkouts root: a
 * user's own worktrees (however broken) are never flagged, and dirs other
 * projects parked under the shared cache root are never counted or offered
 * for deletion. Fail-open like every doctor check.
 */
/**
 * Live unmerged-index probe. While conflicts are unresolved, checkpoint
 * snapshots still capture but the conflicted paths are excluded from
 * per-line attribution — a warn keeps that visible on every doctor run
 * until the index is clean (non-pass checks always print, even without
 * --verbose). A null probe (git unavailable) passes with a skip summary:
 * unknown must never masquerade as clean OR as a conflict.
 */
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

/**
 * `source-plan-pin-integrity` — a pinned source plan whose stored content no
 * longer hashes to its recorded hash. A drifted anchor: the push throws
 * `SourcePlanIntegrityError` (cloud/sync.ts readSnapshot) and the conformance
 * grade would be meaningless, so it must be re-pulled / re-pinned. This is a
 * distinct integrity failure from stale snapshot refs, so it stands as its own
 * check — `checkStaleSnapshotRefs` therefore SILENTLY skips a drifted-pin
 * artifact's prune analysis (its hash is untrustworthy) and leaves the surfacing
 * here. Reads `source_plan` off each artifact projection; bounded by the
 * per-repo artifact set (doctor is a cold path, and several checks already
 * iterate artifacts independently). `pass`/`warn` only — a drifted pin is
 * recoverable, never `fail`.
 */
async function checkSourcePlanPinIntegrity(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck> {
  const name = 'source-plan-pin-integrity';
  const artifactStore = new ArtifactStore({ repoRoot, config, store });
  const rows = store.db.prepare(`SELECT id FROM artifacts`).all() as Array<{ id: string }>;
  let pinned = 0;
  let unreadable = 0;
  const drifted: string[] = [];
  for (const { id } of rows) {
    // readArtifact parse-throws on a corrupt/partial projection (and the rebuild
    // path throws the "no plan_captured" invariant). This check reads EVERY
    // artifact, so one bad projection would otherwise propagate out of runDoctor's
    // catch-less if(store) block and replace the entire report with an error
    // envelope — the worst case for the tool you run to FIND a broken artifact.
    // Skip + count instead (surface the count; never swallow silently — corruption
    // is otherwise invisible here, as checkCacheSchema inspects only the SQLite cache).
    let artifact: Awaited<ReturnType<typeof artifactStore.readArtifact>>;
    try {
      artifact = await artifactStore.readArtifact(id);
    } catch {
      unreadable++;
      continue;
    }
    const pin = artifact?.source_plan ?? null;
    if (!pin) continue;
    pinned++;
    if (sha256Hex(pin.content) !== pin.hash) drifted.push(id);
  }
  const unreadableNote = unreadable > 0 ? ` (${unreadable} artifact(s) unreadable, skipped)` : '';
  if (drifted.length === 0) {
    return {
      name,
      status: 'pass',
      summary:
        (pinned === 0
          ? 'no pinned source plans'
          : `${pinned} pinned source plan(s); all content hashes match`) + unreadableNote,
    };
  }
  const details = drifted.slice(0, 5).map((id) => `  - ${id}`);
  if (drifted.length > 5) details.push(`  …and ${drifted.length - 5} more`);
  details.push(
    'A push would fail integrity for these. Re-pull the approved version ' +
      '(`orcaops plan pull`) and re-pin via `capture plan --source-plan`, or re-capture the artifact.'
  );
  return {
    name,
    status: 'warn',
    summary:
      `${drifted.length} of ${pinned} pinned source plan(s) drifted from their content hash` +
      unreadableNote,
    details,
  };
}

/**
 * `review-cache-integrity` — re-hash `sha256(body) === content_hash` over every
 * review-pull cache record (`plan review pull`'s candidates + proposals).
 * Sibling to `source-plan-pin-integrity` but over the OTHER cache: a drifted
 * review body means a `push --input` off that record could publish a body the
 * user never reviewed. LOCAL ONLY — no cloud reach, needs just repoRoot.
 * Readable cache content is `pass`/`warn` only because drift is recoverable by
 * re-pulling. An uninspectable or uncontained cache is `fail`; corrupt
 * (unparseable) files are surfaced in the summary rather than thrown.
 */
async function checkReviewCacheIntegrity(repoRoot: string): Promise<DoctorCheck> {
  const name = 'review-cache-integrity';
  let scan: Awaited<ReturnType<typeof scanReviewPullRecordsForIntegrity>>;
  try {
    scan = await scanReviewPullRecordsForIntegrity(sourcePlanCacheDir(repoRoot), repoRoot);
  } catch (err) {
    return {
      name,
      status: 'fail',
      summary: `cannot inspect review-pull cache: ${(err as Error).message}`,
      details: [
        'Restore `.orcaops/cache/source-plan` as an inspectable directory inside the repository, ' +
          'then re-run `orcaops plan review pull`.',
      ],
    };
  }
  const { records, corrupt } = scan;
  const corruptNote = corrupt > 0 ? ` (${corrupt} unparseable record(s), skipped)` : '';
  const drifted = records.filter(({ record }) => sha256Hex(record.body) !== record.content_hash);
  if (drifted.length === 0) {
    return {
      name,
      status: corrupt > 0 ? 'warn' : 'pass',
      summary:
        (records.length === 0
          ? 'no review-pull records'
          : `${records.length} review-pull record(s); all content hashes match`) + corruptNote,
    };
  }
  const label = ({ record }: (typeof drifted)[number]): string =>
    record.target === 'proposal'
      ? `  - proposal ${record.proposal_id} on ${record.external_id}`
      : `  - candidate of ${record.external_id} (v${record.version_number})`;
  const details = drifted.slice(0, 5).map(label);
  if (drifted.length > 5) details.push(`  …and ${drifted.length - 5} more`);
  details.push(
    'A push/propose off these records could publish a body you never reviewed. ' +
      'Re-run `orcaops plan review pull <ref>` to refresh them.'
  );
  return {
    name,
    status: 'warn',
    summary:
      `${drifted.length} of ${records.length} review-pull record(s) drifted from their content hash` +
      corruptNote,
    details,
  };
}

/**
 * `skipped-fingerprint-rate` — fraction of recent closed checkpoints
 * whose diff-fingerprint capture was skipped. A high rate points at a
 * systemic problem (disk space, permissions, frequent unborn-repo,
 * parser failures) rather than incidental skips.
 *
 * The `checkpoints` cache table has no `diff_fingerprint_summary`
 * column, so this reads the
 * projection JSON. Bounded to the last 20 closed cps by `closed_at`
 * (the same bounded-scan shape as `checkPinDisplaced`). `warn` when
 * skipped exceeds 20%.
 */
async function checkSkippedFingerprintRate(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck> {
  const rows = store.db
    .prepare(
      `SELECT artifact_id, n FROM checkpoints
       WHERE status = 'closed' AND closed_at IS NOT NULL
       ORDER BY closed_at DESC LIMIT 20`
    )
    .all() as Array<{ artifact_id: string; n: number }>;
  if (rows.length === 0) {
    return {
      name: 'skipped-fingerprint-rate',
      status: 'pass',
      summary: 'no closed checkpoints to sample',
    };
  }
  let total = 0;
  let skipped = 0;
  const reasons = new Map<string, number>();
  for (const r of rows) {
    const projPath = artifactPathsFor(repoRoot, config, r.artifact_id).checkpointJson(r.n);
    let proj: {
      diff_fingerprint_summary?: { status?: string; error_reason?: string | null };
    };
    try {
      proj = JSON.parse(await readFile(projPath, 'utf8')) as typeof proj;
    } catch {
      continue; // projection missing/unreadable — not counted
    }
    const fp = proj.diff_fingerprint_summary;
    if (!fp || typeof fp.status !== 'string') continue;
    total++;
    if (fp.status === 'skipped') {
      skipped++;
      const reason = fp.error_reason ?? 'null (deliberate skip / disabled)';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  if (total === 0) {
    return {
      name: 'skipped-fingerprint-rate',
      status: 'pass',
      summary: 'no closed checkpoints carry a fingerprint summary',
    };
  }
  const rate = skipped / total;
  const pct = Math.round(rate * 100);
  if (rate <= 0.2) {
    return {
      name: 'skipped-fingerprint-rate',
      status: 'pass',
      summary: `${skipped}/${total} recent closed cps skipped fingerprint (${pct}%)`,
    };
  }
  const details = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `  - ${n}× ${reason}`);
  details.push(
    'Investigate error_reason patterns (disk space, permissions, frequent unborn-repo). ' +
      'Use `orcaops fingerprint show --artifact <id> --checkpoint <n>` to inspect one.'
  );
  return {
    name: 'skipped-fingerprint-rate',
    status: 'warn',
    summary: `${skipped}/${total} recent closed cps skipped fingerprint (${pct}% > 20%)`,
    details,
  };
}

function checkUnresolvedBlocks(store: Store): DoctorCheck {
  const blockers = store.listArtifacts({}).flatMap((artifact) =>
    computeUnresolvedBlocks(store.listEvaluatorRuns(artifact.id)).map((block) => ({
      artifact_id: artifact.id,
      ...block,
    }))
  );
  if (blockers.length === 0) {
    return {
      name: 'unresolved-blocks',
      status: 'pass',
      summary: 'no unresolved block-severity evaluator failures',
    };
  }
  const details = blockers.map(
    (block) =>
      `  - ${block.artifact_id} blocked by ${block.evaluator_ref} ` +
      `(${block.kind}, run ${block.run_id})`
  );
  details.push(
    'Policy violations can be acknowledged or dismissed. Evaluator errors must be rerun successfully.'
  );
  return {
    name: 'unresolved-blocks',
    status: 'warn',
    summary: `${blockers.length} unresolved block-severity evaluator failure(s)`,
    details,
  };
}

/**
 * `lineage-orphan` — flag artifacts whose latest lineage SHA isn't
 * reachable from any local branch tip. The remediation is `orcaops
 * sync` from the branch where the artifact's work currently lives,
 * which appends a fresh lineage entry pointing at a reachable SHA.
 *
 * O(N artifacts × M branch tips) `git merge-base --is-ancestor`
 * invocations with short-circuit on the first reaching tip. Doctor
 * is not on the hot path, so this is fine for OSS-grade repo
 * sizes.
 */
async function checkLineageOrphans(repoRoot: string, store: Store): Promise<DoctorCheck> {
  const repo = new Repo(repoRoot);
  let tips: string[];
  try {
    tips = await repo.listLocalBranchTips();
  } catch (err) {
    return {
      name: 'lineage-orphan',
      status: 'warn',
      summary: `could not enumerate branch tips: ${(err as Error).message}`,
    };
  }
  if (tips.length === 0) {
    return {
      name: 'lineage-orphan',
      status: 'pass',
      summary: 'no local branches — nothing to check',
    };
  }
  const rows = store.db
    .prepare(
      `SELECT lbls.artifact_id, lbls.latest_lineage_sha, lbls.branch_name, a.task
       FROM lineage_by_latest_sha lbls
       LEFT JOIN artifacts a ON a.id = lbls.artifact_id`
    )
    .all() as Array<{
    artifact_id: string;
    latest_lineage_sha: string;
    branch_name: string;
    task: string | null;
  }>;
  if (rows.length === 0) {
    return {
      name: 'lineage-orphan',
      status: 'pass',
      summary: 'no captured artifacts to check',
    };
  }

  const orphans: Array<{ id: string; branch_name: string; sha: string; task: string | null }> = [];
  for (const row of rows) {
    let reachable = false;
    for (const tip of tips) {
      if (await repo.isAncestor(row.latest_lineage_sha, tip)) {
        reachable = true;
        break;
      }
    }
    if (!reachable) {
      orphans.push({
        id: row.artifact_id,
        branch_name: row.branch_name,
        sha: row.latest_lineage_sha,
        task: row.task,
      });
    }
  }

  if (orphans.length === 0) {
    return {
      name: 'lineage-orphan',
      status: 'pass',
      summary: `${rows.length} artifact(s); all latest lineage SHAs reachable from a local branch`,
    };
  }
  const details = orphans.map(
    (o) =>
      `  - ${o.id} (last on ${o.branch_name} @ ${o.sha.slice(0, 8)}): ` +
      `"${truncate(o.task ?? '<unknown>', 60)}"`
  );
  details.push(
    'Run `orcaops lineage` on the branch where this work lives to append a reachable lineage entry.'
  );
  return {
    name: 'lineage-orphan',
    status: 'warn',
    summary: `${orphans.length} of ${rows.length} artifact(s) have unreachable latest lineage SHAs`,
    details,
  };
}

/**
 * `evaluator-dismiss-rate` — surface evaluators that get
 * persistently dismissed. Per the architecture's evaluator-revision
 * feedback loop ("persistently-dismissed evaluators get flagged for
 * revision rather than silently ignored"), an evaluator the agent
 * keeps overriding is signalling that the evaluator itself needs
 * work — either the prompt, the threshold, or removal.
 *
 * The denominator is *resolutions* (pass / dismissed /
 * acknowledged), not total runs — a violation is a transient input
 * state, not a resolution outcome. The rate "dismissed / resolved"
 * answers: of the times the evaluator's verdict was actually
 * resolved, what fraction was the agent rejecting it entirely?
 * Acks (formal breaking-change accepts via `on_block` opt-in) are
 * signal-not-noise and stay outside the dismissed numerator.
 *
 * Warns on any evaluator with ≥ MIN_RUNS resolutions AND ≥ WARN
 * dismiss share. The MIN_RUNS gate keeps "dismissed once out of
 * one run" from triggering immediately.
 */
function checkEvaluatorDismissRates(store: Store): DoctorCheck {
  // Two sources of "agent rejected an evaluator's verdict":
  //   1. evaluator_runs with status='dismissed' (post-hoc dismiss
  //      via `block dismiss`).
  //   2. policy_exceptions[] applied at checkpoint-open time
  //      (compile-time bypass via `policy_exceptions` payload).
  //
  // Both reflect the same signal: the evaluator's verdict was
  // overridden. A single denominator unioning both sources keeps the
  // dismiss-rate metric honest — without it, an evaluator that's
  // routinely bypassed via policy_exceptions[] would never show up
  // even if its block rate is uniformly overridden.
  //
  // SQLite's `json_each` parses the JSON array column inline.
  //
  // Outer aliases distinct from inner subquery columns (`total_resolved`
  // / `total_dismissed`) — SQLite's UNION ALL alias-resolution rules
  // bind `HAVING resolved` to the inner column, not the outer
  // `SUM(resolved) AS resolved`, which silently drops aggregated rows
  // whose inner per-source resolved happens to be < threshold.
  const rawRows = store.db
    .prepare(
      // A resolution is anything that clears blocking: a pass run,
      // OR a disposition event (acknowledged / dismissed /
      // policy-excepted). The dismiss rate is dismissed / resolved
      // by evaluator_ref.
      `SELECT evaluator_ref AS evaluator,
              SUM(resolved) AS total_resolved,
              SUM(dismissed) AS total_dismissed
       FROM (
         SELECT evaluator_ref,
                SUM(CASE WHEN run_status = 'completed' AND verdict = 'pass' THEN 1 ELSE 0 END)
                  AS resolved,
                0 AS dismissed
         FROM evaluator_runs
         GROUP BY evaluator_ref
         UNION ALL
         SELECT evaluator_ref,
                COUNT(*) AS resolved,
                SUM(CASE WHEN disposition IN ('dismissed', 'policy-excepted') THEN 1 ELSE 0 END) AS dismissed
         FROM evaluator_dispositions
         GROUP BY evaluator_ref
       )
       GROUP BY evaluator_ref
       HAVING total_resolved >= ?
       ORDER BY (CAST(total_dismissed AS REAL) / total_resolved) DESC, evaluator_ref ASC`
    )
    .all(DISMISS_RATE_MIN_RUNS) as Array<{
    evaluator: string;
    total_resolved: number;
    total_dismissed: number;
  }>;
  const rows = rawRows.map((r) => ({
    evaluator: r.evaluator,
    resolved: r.total_resolved,
    dismissed: r.total_dismissed,
  }));

  const flagged = rows.filter((r) => r.dismissed / r.resolved >= DISMISS_RATE_WARN);

  if (rows.length === 0) {
    return {
      name: 'evaluator-dismiss-rate',
      status: 'pass',
      summary: `no evaluators with ≥ ${DISMISS_RATE_MIN_RUNS} resolutions yet — not enough signal`,
    };
  }
  if (flagged.length === 0) {
    return {
      name: 'evaluator-dismiss-rate',
      status: 'pass',
      summary:
        `${rows.length} evaluator(s) tracked; none above ` +
        `${Math.round(DISMISS_RATE_WARN * 100)}% dismiss rate`,
    };
  }
  const details = flagged.map((r) => {
    const pct = Math.round((r.dismissed / r.resolved) * 100);
    return `  - ${r.evaluator}: ${r.dismissed}/${r.resolved} resolutions dismissed (${pct}%)`;
  });
  details.push(
    'Persistent dismissal usually means the evaluator needs revision (prompt, ' +
      'threshold, watch_paths) — not silent compliance. Edit the spec inside its ' +
      'pack (`<pack-root>/evaluators/<id>.eval.yaml`) or remove it from ' +
      '`.orcaops/evaluators.yaml` via `orcaops eval disable`.'
  );
  return {
    name: 'evaluator-dismiss-rate',
    status: 'warn',
    summary:
      `${flagged.length} of ${rows.length} evaluator(s) above ${Math.round(
        DISMISS_RATE_WARN * 100
      )}% dismiss rate ` + `(min ${DISMISS_RATE_MIN_RUNS} resolutions)`,
    details,
  };
}

// ─── Pin-related checks ───────────────────────────────────────────────

/**
 * `shell-key` — surface whether the current shell can mint a pin at all.
 *
 * `resolveShellKey()` walks the precedence chain (CLAUDE_SESSION_ID →
 * CLAUDE_CODE_SESSION_ID → CODEX_SESSION_ID → TMUX_PANE → STY+WINDOW →
 * TTY+ppid). When NONE of those env vars are present the shell silently
 * can't auto-pin, and `orcaops capture plan` no-ops the pin step without
 * surfacing why.
 *
 * Claude Code documents CLAUDE_CODE_SESSION_ID, which the chain now
 * consumes for the claude_session kind. Nuance worth keeping in mind:
 * implicit `--continue`/`--resume` may expose the STARTUP session id while
 * an explicit `--resume <id>` receives the resumed id — so a resumed
 * conversation's pin slot can differ from the original session's.
 */
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
  repoId: string;
  pins: Pin[];
}

/**
 * Resolve the per-repo pin set once for all pin-related checks. Returns
 * null when the git common-dir can't be read (already covered by the
 * git-repo check, so doctor's report stays useful even if pins are
 * unreadable).
 */
async function loadPinContext(
  repoRoot: string,
  _config: Config | null
): Promise<PinContext | null> {
  try {
    const repoId = await resolveRepoKey(new Repo(repoRoot));
    if (repoId === null) return null; // no identity → no pin store for this repo
    const pins = await listPinsForRepo({ repoId, env: getInvocationEnv() });
    return { repoId, pins };
  } catch {
    return null;
  }
}

/**
 * `stale-pin` — pin pointing at a summarized, deleted, or missing
 * artifact. The picker treats these as stale and falls through to
 * branch-active resolution; doctor surfaces them so the user can
 * `orcaops checkout --clear` (in the offending shell).
 */
function checkStalePins(ctx: PinContext, store: Store): DoctorCheck {
  if (ctx.pins.length === 0) {
    return { name: 'stale-pin', status: 'pass', summary: 'no pins to check' };
  }
  const stale: Array<{ pin: Pin; reason: string }> = [];
  for (const pin of ctx.pins) {
    const row = store.getArtifact(pin.artifact_id);
    if (!row) {
      stale.push({ pin, reason: 'artifact missing from index' });
      continue;
    }
    if (row.status === 'complete') {
      stale.push({ pin, reason: 'artifact summarized (work shipped)' });
    }
  }
  if (stale.length === 0) {
    return {
      name: 'stale-pin',
      status: 'pass',
      summary: `${ctx.pins.length} pin(s); all targets are still in-flight`,
    };
  }
  const details = stale.map(
    (s) => `  - ${s.pin.artifact_id} (${s.pin.shell_key.kind}, branch=${s.pin.branch}): ${s.reason}`
  );
  details.push('Run `orcaops checkout --clear` from the affected shell to remove the stale pin.');
  return {
    name: 'stale-pin',
    status: 'warn',
    summary: `${stale.length} of ${ctx.pins.length} pin(s) point at non-in-flight artifacts`,
    details,
  };
}

/**
 * `aged-pin` — pin >7 days old whose target is still active. Suggests
 * the work has been parked or forgotten; user should confirm or
 * summarize.
 */
function checkAgedPins(ctx: PinContext, store: Store): DoctorCheck {
  if (ctx.pins.length === 0) {
    return { name: 'aged-pin', status: 'pass', summary: 'no pins to check' };
  }
  const cutoffMs = Date.now() - PIN_AGE_DAYS_WARN * 24 * 60 * 60 * 1000;
  const aged: Pin[] = [];
  for (const pin of ctx.pins) {
    const row = store.getArtifact(pin.artifact_id);
    if (!row || row.status !== 'active') continue;
    const pinnedMs = Date.parse(pin.pinned_at);
    if (Number.isNaN(pinnedMs)) continue;
    if (pinnedMs < cutoffMs) aged.push(pin);
  }
  if (aged.length === 0) {
    return {
      name: 'aged-pin',
      status: 'pass',
      summary: `no pins older than ${PIN_AGE_DAYS_WARN}d on active artifacts`,
    };
  }
  const details = aged.map((pin) => {
    const ageDays = Math.floor((Date.now() - Date.parse(pin.pinned_at)) / 86_400_000);
    return `  - ${pin.artifact_id} (${pin.shell_key.kind}): pinned ${ageDays}d ago`;
  });
  details.push(
    'Forgotten work? Either `orcaops capture summary` to ship, or ' +
      '`orcaops checkout --clear` to release the pin.'
  );
  return {
    name: 'aged-pin',
    status: 'warn',
    summary: `${aged.length} pin(s) older than ${PIN_AGE_DAYS_WARN}d on active artifact(s)`,
    details,
  };
}

/**
 * `pin-orphan` — active artifacts with no pin from any shell.
 * Informational only ("orphan; expected if you cleaned up shells"
 * per spec). Helps surface "I forgot which shell I was working in"
 * scenarios without flagging them as warnings.
 */
function checkPinOrphans(ctx: PinContext, store: Store): DoctorCheck {
  const pinnedIds = new Set(ctx.pins.map((p) => p.artifact_id));
  const activeRows = store.db
    .prepare(`SELECT id, branch, task FROM artifacts WHERE status = 'active'`)
    .all() as Array<{ id: string; branch: string; task: string }>;
  const orphans = activeRows.filter((r) => !pinnedIds.has(r.id));
  if (orphans.length === 0) {
    return {
      name: 'pin-orphan',
      status: 'pass',
      summary: `${activeRows.length} active artifact(s); all pinned by some shell`,
    };
  }
  const details = orphans.map((r) => `  - ${r.id} (${r.branch}): "${truncate(r.task, 60)}"`);
  details.push(
    'Active without a pin is fine if you cleaned up the shell. Run ' +
      '`orcaops checkout <id>` from the shell that owns the work.'
  );
  return {
    name: 'pin-orphan',
    // Informational per spec: never warn/fail on orphan-pin alone.
    status: 'pass',
    summary: `${orphans.length} of ${activeRows.length} active artifact(s) have no pin`,
    details,
  };
}

/**
 * `same-session-multi-active` — multiple in-flight artifacts on the
 * same branch from the same `created_by_session_id`. Informational
 * only. Helps surface the "I forgot I was already working on this"
 * pattern without forcing action.
 *
 * `created_by_session_id` lives in artifact.json (not SQLite), so
 * each active artifact gets one filesystem read. Bounded by the
 * active-set size; OSS scale.
 */
async function checkSameSessionMultiActive(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck> {
  const activeRows = store.db
    .prepare(`SELECT id, branch, task FROM artifacts WHERE status = 'active'`)
    .all() as Array<{ id: string; branch: string; task: string }>;
  if (activeRows.length === 0) {
    return {
      name: 'same-session-multi-active',
      status: 'pass',
      summary: 'no active artifacts to check',
    };
  }
  // Read session_id from each artifact's artifact.json. Reusing
  // ArtifactStore here is the safe path — recovery-on-read handles
  // any transient inconsistency.
  const artifactStore = new ArtifactStore({ repoRoot, config, store });
  type Row = { id: string; branch: string; task: string; session_id: string };
  const enriched: Row[] = [];
  for (const r of activeRows) {
    // Guard the per-artifact read: a corrupt/partial projection must not abort
    // the whole doctor run (source-plan-pin-integrity reads + counts every
    // artifact, so the unreadable total is surfaced there).
    let json: Awaited<ReturnType<typeof artifactStore.readArtifact>>;
    try {
      json = await artifactStore.readArtifact(r.id);
    } catch {
      continue;
    }
    if (!json?.created_by_session_id) continue;
    enriched.push({ ...r, session_id: json.created_by_session_id });
  }
  if (enriched.length === 0) {
    return {
      name: 'same-session-multi-active',
      status: 'pass',
      summary: 'no active artifacts have session_id metadata',
    };
  }
  // Group by (branch, session_id).
  const groups = new Map<string, Row[]>();
  for (const r of enriched) {
    const key = `${r.branch}::${r.session_id}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const flagged = [...groups.values()].filter((g) => g.length > 1);
  if (flagged.length === 0) {
    return {
      name: 'same-session-multi-active',
      status: 'pass',
      summary: `${enriched.length} active artifact(s); each unique (branch, session_id)`,
    };
  }
  const details: string[] = [];
  for (const g of flagged) {
    const session = g[0].session_id;
    const branch = g[0].branch;
    details.push(`  - branch=${branch} session=${session.slice(0, 12)}…: ${g.length} active`);
    for (const r of g) details.push(`      ${r.id}: "${truncate(r.task, 50)}"`);
  }
  return {
    name: 'same-session-multi-active',
    // Informational per spec: parallel feature work in the same shell
    // is plausible (worktrees, etc.); doctor reports without warning.
    status: 'pass',
    summary: `${flagged.length} (branch, session) group(s) have >1 active artifact`,
    details,
  };
}

/**
 * `event-log-corruption` — artifacts whose `events.ndjson` carries
 * acknowledged-then-lost lines. This is the operator surface behind
 * recovery's fail-closed refusals: a read over a rotted log throws and
 * points here, and this check names the artifact, the line, and the
 * failure kind. Deliberately NOT gated on `archive.enabled` — hot-log
 * rot must surface in the default configuration. `fail` because a lost
 * line is data loss until the user restores the log or accepts it.
 * Truncated tails (crash mid-write, never acknowledged) are excluded
 * from the loss count but reported as `fail` details, since they block
 * captures until the partial line is removed.
 */
async function checkEventLogCorruption(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck> {
  // Union SQLite rows with on-disk artifact directories: rebuild skips an
  // artifact whose plan.json is missing or malformed, leaving it row-less —
  // exactly the artifact most likely to be corrupt, and this check is its
  // only surface.
  const ids = new Set<string>(store.listArtifacts({}).map((row) => row.id));
  try {
    for (const entry of await readdir(artifactsRoot(repoRoot, config), { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (ids.size === 0) {
    return { name: 'event-log-corruption', status: 'pass', summary: 'no artifacts to check' };
  }
  const flagged: Array<{ id: string; entries: CorruptEntry[] }> = [];
  const tails: string[] = [];
  const uninspectable: string[] = [];
  for (const id of [...ids].sort()) {
    // Per-artifact containment: one symlinked or unreadable log must not
    // abort the scan and mask every other artifact's findings.
    let result;
    try {
      const paths = artifactPathsFor(repoRoot, config, id);
      result = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
        containmentRoot: repoRoot,
      });
    } catch (err) {
      uninspectable.push(
        `  - ${id}: could not inspect events.ndjson — ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const lost = result.corrupt.filter((c) => c.kind !== 'truncated_tail');
    if (lost.length > 0) flagged.push({ id, entries: lost });
    for (const t of result.corrupt.filter((c) => c.kind === 'truncated_tail')) {
      tails.push(
        `  - ${id}: line ${t.line} is an unterminated partial write (crash residue, never acknowledged) — benign to read, but captures refuse until it is removed`
      );
    }
  }
  if (flagged.length === 0 && uninspectable.length === 0) {
    return {
      name: 'event-log-corruption',
      // Crash tails BLOCK captures (appendAndMirror refuses), so a green
      // doctor followed by a hard-failing capture would be a lie: fail.
      status: tails.length > 0 ? 'fail' : 'pass',
      summary:
        tails.length > 0
          ? `${ids.size} artifact(s); no lost lines, but ${tails.length} crash-truncated tail(s) block captures`
          : `${ids.size} artifact(s); every event log verifies clean`,
      ...(tails.length > 0 ? { details: tails } : {}),
    };
  }
  const details = flagged.flatMap((f) =>
    f.entries.map((e) => `  - ${f.id}: line ${e.line} (${e.kind}) — ${e.reason}`)
  );
  // Crash tails and uninspectable artifacts stay visible even when other
  // artifacts have lost lines — each blocks or hides work regardless.
  details.push(...tails);
  details.push(...uninspectable);
  if (flagged.length > 0) {
    details.push(
      'Reads that depend on the lost lines fail closed. Restore events.ndjson from a ' +
        'backup or the archive mirror, or delete the artifact to accept the loss.'
    );
  }
  // An uninspectable-only result is NOT "0 corrupt lines" — no loss was
  // established either way; say what actually happened.
  const summary =
    flagged.length > 0
      ? `${flagged.length} artifact(s) have corrupt event-log lines — dependent reads fail closed`
      : `${uninspectable.length} artifact(s) could not be inspected — resolve access/containment and re-run` +
        (tails.length > 0 ? `; ${tails.length} crash-truncated tail(s) block captures` : '');
  return {
    name: 'event-log-corruption',
    status: 'fail',
    summary,
    details,
  };
}

/**
 * `pin-displaced` — pin_displaced events on still-active or blocked
 * artifacts. The pin moved away from these artifacts while they were
 * still in flight; the user may have abandoned them. Surface so they
 * can run `capture summary` or `block dismiss`.
 */
async function checkPinDisplaced(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck> {
  const inFlight = store.db
    .prepare(`SELECT id, branch, task FROM artifacts WHERE status IN ('active')`)
    .all() as Array<{ id: string; branch: string; task: string }>;
  if (inFlight.length === 0) {
    return {
      name: 'pin-displaced',
      status: 'pass',
      summary: 'no active artifacts to check',
    };
  }
  const flagged: Array<{ id: string; task: string; count: number; lastDisplacedAt: string }> = [];
  for (const row of inFlight) {
    const paths = artifactPathsFor(repoRoot, config, row.id);
    const result = await readEventLog({
      eventLogPath: paths.eventsNdjson,
      sidecarsDir: paths.sidecarsDir,
      containmentRoot: repoRoot,
    });
    const displaced = result.events.filter((e) => e.type === 'pin_displaced');
    if (displaced.length === 0) continue;
    const last = displaced[displaced.length - 1];
    flagged.push({ id: row.id, task: row.task, count: displaced.length, lastDisplacedAt: last.ts });
  }
  if (flagged.length === 0) {
    return {
      name: 'pin-displaced',
      status: 'pass',
      summary: `${inFlight.length} active artifact(s); none have pin_displaced events`,
    };
  }
  const details = flagged.map(
    (f) =>
      `  - ${f.id}: ${f.count} pin_displaced event(s); last at ${f.lastDisplacedAt}; ` +
      `task="${truncate(f.task, 40)}"`
  );
  details.push(
    'A still-active artifact whose pin moved away is often abandoned work. ' +
      'Run `orcaops capture summary` to ship it, or ' +
      '`orcaops block dismiss` if it was a false alarm.'
  );
  return {
    name: 'pin-displaced',
    status: 'warn',
    summary: `${flagged.length} active artifact(s) had their pin displaced — work parked?`,
    details,
  };
}

/**
 * `stale-projection` — the SQLite `plan_steps` projection is empty for an
 * artifact whose event log DOES contain a `plan_captured` event. That is the
 * signature of a schema migration that DROP+recreated `plan_steps` (e.g.
 * migration 015/016) without a following `orcaops rebuild`:
 * `getLatestPlanRevision` then returns zero steps, so `orcaops status` renders
 * the artifact plan-less even though the event log (source of truth) is intact.
 * `warn` — the data is recoverable via `orcaops rebuild`; this is refresh
 * hygiene, not corruption. (Bounded scan: one cheap plan-row read per artifact,
 * event-log read only for the already-empty ones — same shape as
 * `checkPinDisplaced`.)
 */
async function checkStaleProjection(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck> {
  const artifacts = store.listArtifacts({});
  if (artifacts.length === 0) {
    return { name: 'stale-projection', status: 'pass', summary: 'no artifacts to check' };
  }
  const flagged: Array<{ id: string; task: string; lag: string }> = [];
  for (const row of artifacts) {
    // "Empty" = no plan row OR a plan row with zero steps. A captured plan
    // always has >=1 step, so zero means the projection was dropped by a
    // migration and not yet rebuilt.
    const latest = store.getLatestPlanRevision(row.id);
    const planProjectionEmpty = latest === null || latest.steps.length === 0;
    // A summary row missing while the log carries summary_captured is a crash
    // between the durable append and the cache write. It strands one artifact
    // rather than the whole projection, so it gets its own reason string.
    const summaryProjectionMissing = store.getSummary(row.id) === null;
    if (!planProjectionEmpty && !summaryProjectionMissing) continue;
    // Confirm the events actually exist in the log — otherwise the artifact is
    // legitimately plan-less or unsummarized, not stale.
    const paths = artifactPathsFor(repoRoot, config, row.id);
    const result = await readEventLog({
      eventLogPath: paths.eventsNdjson,
      sidecarsDir: paths.sidecarsDir,
      containmentRoot: repoRoot,
    });
    const reasons: string[] = [];
    if (planProjectionEmpty && result.events.some((e) => e.type === 'plan_captured')) {
      reasons.push('plan_steps projection empty but the event log has a plan_captured event');
    }
    if (summaryProjectionMissing && result.events.some((e) => e.type === 'summary_captured')) {
      reasons.push('no summaries row but the event log has a summary_captured event');
    }
    if (reasons.length > 0) {
      flagged.push({ id: row.id, task: row.task, lag: reasons.join('; ') });
    }
  }
  if (flagged.length === 0) {
    return {
      name: 'stale-projection',
      status: 'pass',
      summary: `${artifacts.length} artifact(s); projections in sync with the event log`,
    };
  }
  const details = flagged.map((f) => `  - ${f.id}: ${f.lag}; task="${truncate(f.task, 40)}"`);
  details.push(
    'A schema migration that DROP+recreates a projection, or a crash between a ' +
      'durable event append and the cache write, leaves the projection behind the ' +
      'log until rebuilt. Run `orcaops rebuild` to re-project from the event log. ' +
      'Do not delete the artifact directory or the project archive — the cache ' +
      'outlives both, and removing them makes the disagreement worse.'
  );
  return {
    name: 'stale-projection',
    status: 'warn',
    summary: `${flagged.length} artifact(s) have a projection behind the event log — run \`orcaops rebuild\``,
    details,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const DOCTOR_SECTIONS = [
  {
    name: 'repository',
    checks: new Set([
      'git-repo',
      'index-conflicts',
      'init',
      'config',
      'cache',
      'llm-tool',
      'watch-runtime',
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
      'archive',
      'cloud-auth',
      'event-log-corruption',
      'plan-idempotency',
      'cloud-sync-pending',
      'lineage-orphan',
      'open-checkpoint-stale',
      'review-cache-integrity',
      'seed',
      'scratch-checkouts',
      'skipped-fingerprint-rate',
      'source-plan-pin-integrity',
      'stale-artifacts',
      'stale-baseline-refs',
      'stale-projection',
      'stale-snapshot-refs',
      'unresolved-blocks',
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
      'materialized-disposition-consistency',
      'persistent-evaluator-errors',
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
  if (checkName.startsWith('archive-')) return 'artifact state';
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

/**
 * `fingerprint-zero-match` — flag evaluators whose `fingerprint.include`
 * patterns expand to zero files in the current repo. Such evaluators
 * are running blind: their soft-block replay key has no inputs, so
 * the runner cannot tell when the bytes-they-care-about have changed.
 * Usually means the pattern is stale or the user moved the watched
 * directory.
 *
 * Live re-compute via `computeEvaluatorFingerprint` for each configured
 * evaluator — no storage path, the data is not persisted.
 */
async function checkFingerprintZeroMatch(repoRoot: string): Promise<DoctorCheck> {
  try {
    const { evaluators, errors } = await discoverEvaluatorsForCli(repoRoot);
    // A failed pack load shrinks the set this check reasons over, so a clean
    // result would otherwise read as "all fingerprints fine" over a
    // truncated world.
    if (errors.length > 0) {
      return {
        name: 'fingerprint-zero-match',
        status: 'warn',
        summary:
          `${errors.length} evaluator discovery problem(s); fingerprint coverage was checked over ` +
          `${evaluators.length} evaluator(s) only`,
        details: errors.map((err) => `${err.source_path}: ${err.message}`),
      };
    }
    const offenders: Array<{ ref: string; empty: string[] }> = [];
    for (const ev of evaluators) {
      try {
        const fp = await computeEvaluatorFingerprint(ev);
        if (fp.empty_patterns.length > 0) {
          offenders.push({ ref: ev.ref, empty: fp.empty_patterns });
        }
      } catch {
        // Individual fingerprint failures don't block the check; the
        // evaluator's own discovery already surfaced any structural
        // issues.
      }
    }
    if (offenders.length === 0) {
      return {
        name: 'fingerprint-zero-match',
        status: 'pass',
        summary: `${evaluators.length} evaluator(s) checked; all fingerprint.include patterns matched at least one file`,
      };
    }
    return {
      name: 'fingerprint-zero-match',
      status: 'warn',
      summary: `${offenders.length} evaluator(s) have fingerprint.include patterns that match no files`,
      details: offenders.flatMap((o) => [`  - ${o.ref}:`, ...o.empty.map((p) => `      - ${p}`)]),
    };
  } catch (err) {
    return {
      name: 'fingerprint-zero-match',
      status: 'warn',
      summary: `discovery failed: ${(err as Error).message}`,
    };
  }
}

/**
 * `command-evaluator-trust` — flag packs whose capability-requiring
 * evaluators dispatch would refuse. The detail text is the shared
 * decision/gate reason, not a parallel offender taxonomy.
 */
/**
 * Report per-pack consent status by running the SAME gate dispatch
 * enforces — the shared trust decisions AND the per-evaluator capability
 * coverage check, under the provider the config resolves for evaluators
 * that declare none. Anything less disagrees with enforcement: a
 * verdict-only read passes a capability-short grant dispatch refuses,
 * and classifying without the effective provider skips an ungranted
 * implicit-codex pack as "not gated".
 */
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

/**
 * `persistent-evaluator-errors` — flag evaluator_refs whose last N
 * runs were all `run_status='error'`. Persistent errors mean the
 * evaluator can't even produce a verdict — needs investigation
 * (broken runtime, missing env, params drift).
 */
function checkPersistentEvaluatorErrors(store: Store): DoctorCheck {
  const MIN_CONSECUTIVE = 3;
  // Per-ref: count of consecutive error rows in trailing window,
  // bounded by total runs to avoid degenerate "1 error of 1 run"
  // false positives.
  const rows = store.db
    .prepare(
      `WITH ranked AS (
         SELECT
           evaluator_ref,
           run_status,
           ROW_NUMBER() OVER (PARTITION BY evaluator_ref ORDER BY ts DESC) AS rn
         FROM evaluator_runs
       )
       SELECT evaluator_ref,
              SUM(CASE WHEN rn <= ? AND run_status = 'error' THEN 1 ELSE 0 END) AS trailing_errors,
              COUNT(*) AS total_runs
       FROM ranked
       GROUP BY evaluator_ref
       HAVING trailing_errors >= ? AND total_runs >= ?`
    )
    .all(MIN_CONSECUTIVE, MIN_CONSECUTIVE, MIN_CONSECUTIVE) as Array<{
    evaluator_ref: string;
    trailing_errors: number;
    total_runs: number;
  }>;
  if (rows.length === 0) {
    return {
      name: 'persistent-evaluator-errors',
      status: 'pass',
      summary: `no evaluator has ≥${MIN_CONSECUTIVE} consecutive errors in its trailing runs`,
    };
  }
  return {
    name: 'persistent-evaluator-errors',
    status: 'warn',
    summary: `${rows.length} evaluator(s) with persistent errors (≥${MIN_CONSECUTIVE} consecutive in trailing runs)`,
    details: rows.map(
      (r) => `  - ${r.evaluator_ref}: ${r.trailing_errors}/${r.total_runs} trailing runs errored`
    ),
  };
}

/**
 * `stale-dispositions` — flag dispositions older than
 * `evaluators.disposition_ttl_days`. Old dispositions accumulate as
 * the underlying issue evolves; reviewers should revisit them
 * periodically rather than treating an ack from 6 months ago as
 * still-applicable.
 */
function checkStaleDispositions(store: Store, config: Config): DoctorCheck {
  const ttlDays = config.evaluators.disposition_ttl_days;
  const cutoff = `-${ttlDays} days`;
  const rows = store.db
    .prepare(
      `SELECT evaluator_ref, disposition, ts
       FROM evaluator_dispositions
       WHERE ts < datetime('now', ?)
       ORDER BY ts ASC`
    )
    .all(cutoff) as Array<{
    evaluator_ref: string;
    disposition: string;
    ts: string;
  }>;
  if (rows.length === 0) {
    return {
      name: 'stale-dispositions',
      status: 'pass',
      summary: `no disposition older than ${ttlDays} days`,
    };
  }
  return {
    name: 'stale-dispositions',
    status: 'warn',
    summary: `${rows.length} disposition(s) older than ${ttlDays} days`,
    details: rows.slice(0, 10).map((r) => `  - ${r.evaluator_ref} [${r.disposition}] from ${r.ts}`),
  };
}

/**
 * `skipped-run-analytics` — flag evaluators with unusually high skip
 * rates. A high skip rate often means the runner's filter is too
 * eager (paths/scopes mismatch), causing the evaluator to never fire
 * when it should.
 */
function checkSkippedRunAnalytics(store: Store): DoctorCheck {
  const SKIP_RATE_WARN = 0.7;
  const MIN_RUNS = 5;
  const rows = store.db
    .prepare(
      `SELECT evaluator_ref,
              SUM(CASE WHEN run_status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
              COUNT(*) AS total
       FROM evaluator_runs
       GROUP BY evaluator_ref
       HAVING total >= ? AND (CAST(skipped AS REAL) / total) >= ?`
    )
    .all(MIN_RUNS, SKIP_RATE_WARN) as Array<{
    evaluator_ref: string;
    skipped: number;
    total: number;
  }>;
  if (rows.length === 0) {
    return {
      name: 'skipped-run-analytics',
      status: 'pass',
      summary: `no evaluator has a skip rate ≥${Math.round(SKIP_RATE_WARN * 100)}% with ≥${MIN_RUNS} runs`,
    };
  }
  return {
    name: 'skipped-run-analytics',
    status: 'warn',
    summary: `${rows.length} evaluator(s) with high skip rates`,
    details: rows.map(
      (r) =>
        `  - ${r.evaluator_ref}: ${r.skipped}/${r.total} skipped (${Math.round(
          (r.skipped / r.total) * 100
        )}%)`
    ),
  };
}

/**
 * `materialized-disposition-consistency` — verify the
 * `evaluator_runs.disposition` materialized column matches the latest
 * disposition event in `evaluator_dispositions` for each run_id.
 * Catches projection drift bugs that would let the runner think
 * a violation was unresolved when an ack/dismiss/policy-except is on
 * file (or vice versa).
 */
function checkMaterializedDispositionConsistency(store: Store): DoctorCheck {
  const rows = store.db
    .prepare(
      `WITH latest AS (
         SELECT run_id, disposition,
                ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY ts DESC) AS rn
         FROM evaluator_dispositions
       )
       SELECT r.evaluator_ref, r.run_id, r.disposition AS materialized, l.disposition AS latest_event
       FROM evaluator_runs r
       JOIN latest l ON l.run_id = r.run_id AND l.rn = 1
       WHERE r.disposition IS NOT NULL
         AND r.disposition != 'unresolved'
         AND r.disposition != l.disposition`
    )
    .all() as Array<{
    evaluator_ref: string;
    run_id: string;
    materialized: string;
    latest_event: string;
  }>;
  if (rows.length === 0) {
    return {
      name: 'materialized-disposition-consistency',
      status: 'pass',
      summary: 'all materialized dispositions match the latest disposition events',
    };
  }
  return {
    name: 'materialized-disposition-consistency',
    status: 'fail',
    summary: `${rows.length} run(s) have materialized disposition drift`,
    details: rows
      .slice(0, 10)
      .map(
        (r) =>
          `  - ${r.evaluator_ref} run=${r.run_id.slice(0, 8)}: materialized=${r.materialized}, latest_event=${r.latest_event}`
      ),
  };
}

// ── archive health checks ───────────────────────────────────────────

/**
 * Archive health. Disabled repos get one pass check, including the retained
 * history location when one exists (identity alone is not drift, since init
 * mints it eagerly);
 * enabled repos get mirror-lag / identity / perms / index / manifest-
 * derivation checks. Everything here is bounded by the hot store size
 * and never throws — doctor reports, it does not break.
 */
async function archiveChecks(
  repoRoot: string,
  config: Config,
  store: Store
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const env = getInvocationEnv();
  const dataRoot = archiveRoot(env);
  const idxRoot = indexRoot(env);
  let projectId: string | null = null;
  try {
    projectId = await readProjectId(new Repo(repoRoot));
  } catch (error) {
    const summary =
      error instanceof ProjectIdentityError
        ? error.message
        : 'could not read git config orcaops.projectid';
    checks.push({
      name: 'archive-identity',
      status: 'fail',
      summary,
    });
    return checks;
  }

  if (!config.archive.enabled) {
    // Init mints identity eagerly; only a project directory proves there is
    // archived history to tell the user about while mirroring is disabled.
    let retainedPath: string | null = null;
    if (projectId !== null) {
      const projectDir = archiveProjectDir(dataRoot, projectId);
      try {
        await access(projectDir);
        retainedPath = projectDir;
      } catch {
        retainedPath = null;
      }
    }
    if (retainedPath !== null) {
      checks.push({
        name: 'archive',
        status: 'pass',
        summary: `archive disabled; archived data retained at ${retainedPath}`,
        details: [
          'Re-enable with `orcaops archive enable`, or delete that directory to reclaim space.',
        ],
      });
    } else {
      checks.push({
        name: 'archive',
        status: 'pass',
        summary:
          'archive disabled for this worktree; set archive.enabled: true to mirror captured history',
      });
    }
    return checks;
  }

  if (projectId === null) {
    const recovery = await projectIdentityRecoveryGuidance(
      new Repo(repoRoot),
      await loadRegistry(registryPath(dataRoot))
    );
    checks.push({
      name: 'archive-identity',
      status: 'warn',
      summary: 'archive.enabled is true but no project identity is minted yet',
      details: [recovery],
    });
    return checks;
  }
  checks.push({
    name: 'archive-identity',
    status: 'pass',
    summary: `project ${projectId} (git config orcaops.projectid, shared across worktrees)`,
  });

  // The mirror lives outside the repository, outside .gitignore, and survives
  // deleting the worktree. Verbatim is the DEFAULT and stays the default —
  // resume restores captured work from this copy in a fresh checkout, and a
  // redacted mirror is a lossy restore. What was missing is anyone saying so.
  checks.push(
    config.archive.redact_secrets
      ? {
          name: 'archive-redaction',
          status: 'pass',
          summary: 'archive mirror is redacted at write (archive.redact_secrets: true)',
          details: [
            'A cold-start `orcaops resume` restores the redacted text; the in-repo event ' +
              'log still holds what was captured.',
          ],
        }
      : {
          // `pass`, not `warn`: this is the default and a deliberate one, and a
          // row that is yellow on every healthy install teaches people to skip
          // the report. The gap this closes is that nothing said it at all.
          name: 'archive-redaction',
          status: 'pass',
          summary: 'archive mirror stores event text verbatim (archive.redact_secrets: false)',
          details: [
            'The mirror is outside the repository and outside .gitignore, and survives ' +
              'deleting the worktree. Set archive.redact_secrets: true to redact the copy — ' +
              'a cold-start `orcaops resume` then restores the redacted text.',
          ],
        }
  );

  const projectDir = archiveProjectDir(dataRoot, projectId);
  try {
    const lag = await computeMirrorLag({ repoRoot, config, projectDir });
    const corrupt = lag.artifacts.reduce((n, a) => n + a.archive_corrupt_lines, 0);
    const quarantinedUsageEvents = usageBlockedMissing(lag);
    if (
      lag.total_missing === 0 &&
      lag.artifacts_requiring_rebuild === 0 &&
      lag.blocked_artifacts === 0 &&
      corrupt === 0
    ) {
      checks.push({
        name: 'archive-mirror-lag',
        status: 'pass',
        summary: `${lag.artifacts.length} artifact(s) fully mirrored; usage ledger in sync`,
      });
    } else {
      const details: string[] = [];
      for (const a of lag.artifacts) {
        if (a.missing_event_ids.length > 0) {
          details.push(`  - ${a.artifact_id}: ${a.missing_event_ids.length} event(s) missing`);
        }
        if (a.repair_mode === 'canonical_rebuild') {
          details.push(`  - ${a.artifact_id}: non-tail gap requires canonical rebuild`);
        }
        if (a.repair_mode === 'blocked') {
          details.push(
            `  - ${a.artifact_id}: ${a.block_reason ?? 'blocked'} — ` +
              `${a.block_message ?? 'automatic repair is unavailable'}`
          );
          const sources = await inspectArtifactSources({
            repoRoot,
            config,
            projectDir,
            artifactId: a.artifact_id,
          });
          const commands = archiveResolutionCommands(a.artifact_id, sources);
          if (commands.length === 0) {
            details.push('    no automated resolution: neither source strictly reconstructs');
          } else {
            details.push(...commands.map((command) => `    resolve: ${command}`));
          }
        }
        if (a.archive_corrupt_lines > 0) {
          details.push(
            `  - ${a.artifact_id}: ${a.archive_corrupt_lines} corrupt archive line(s) ` +
              '(surfaced; prior copy retained if a canonical rebuild is required)'
          );
        }
      }
      if (lag.usage.missing_event_ids.length > 0) {
        details.push(
          `  - usage ledger: ${lag.usage.missing_event_ids.length} event(s) missing` +
            (quarantinedUsageEvents > 0
              ? `; ${quarantinedUsageEvents} invalid event(s) are quarantined in the hot ` +
                'ledger without archive-readable content and do not block archive activation'
              : '')
        );
      }
      if (lag.repairable_missing > 0 || lag.artifacts_requiring_rebuild > 0) {
        details.push('Run `orcaops archive repair` to backfill repairable missing events.');
      }
      checks.push({
        name: 'archive-mirror-lag',
        status: 'warn',
        summary:
          `${lag.total_missing} event(s) not yet mirrored, ` +
          `${lag.artifacts_requiring_rebuild} artifact(s) require rebuild, ` +
          `${lag.blocked_artifacts} artifact(s) blocked` +
          `${corrupt > 0 ? `, ${corrupt} corrupt archive line(s)` : ''}`,
        details,
      });
    }
  } catch (err) {
    checks.push({
      name: 'archive-mirror-lag',
      status: 'warn',
      summary: `could not compute mirror lag: ${(err as Error).message}`,
    });
  }

  if (process.platform !== 'win32') {
    const loose: string[] = [];
    for (const dir of [dataRoot, projectDir]) {
      try {
        const mode = (await stat(dir)).mode;
        if ((mode & 0o077) !== 0) loose.push(dir);
      } catch {
        // not created yet — nothing to grade
      }
    }
    checks.push(
      loose.length === 0
        ? { name: 'archive-perms', status: 'pass', summary: 'archive dirs are 0700' }
        : {
            name: 'archive-perms',
            status: 'warn',
            summary: `${loose.length} archive dir(s) group/other-accessible`,
            details: loose.map((d) => `  - chmod 700 ${d}`),
          }
    );
  }

  // Index classification: CACHEDIR.TAG must exist at the DISPOSABLE index
  // root (backup tools skip it) and must NEVER appear in the precious
  // archive tree (backup tools would skip user data).
  const tagAtIndex = await fileExists(path.join(idxRoot, 'CACHEDIR.TAG'));
  const tagAtData = await fileExists(path.join(dataRoot, 'CACHEDIR.TAG'));
  const idxRootExists = await fileExists(idxRoot);
  if (tagAtData) {
    checks.push({
      name: 'archive-index',
      status: 'warn',
      summary: `CACHEDIR.TAG found in the PRECIOUS archive root (${dataRoot}) — backup tools will skip your captured history`,
      details: [`Delete ${path.join(dataRoot, 'CACHEDIR.TAG')}; only the index root may carry it.`],
    });
  } else if (idxRootExists && !tagAtIndex) {
    checks.push({
      name: 'archive-index',
      status: 'warn',
      summary: 'index root exists but is missing its CACHEDIR.TAG',
      details: [
        'Any `--all-projects` query rewrites it; or delete the index dir (fully disposable).',
      ],
    });
  } else {
    checks.push({
      name: 'archive-index',
      status: 'pass',
      summary: idxRootExists
        ? 'index root is cache-classified (CACHEDIR.TAG present)'
        : 'no index built yet (created on first --all-projects query)',
    });
  }

  // Manifest derivability: closed checkpoints whose snapshot trees are
  // pinned but which have neither a stored manifest nor a cached derived
  // one — snapshot-ref pruning would strand them (the prune gate is the
  // enforcement; this is the early warning).
  try {
    const artifactStore = new ArtifactStore({ repoRoot, config, store });
    const offenders: string[] = [];
    for (const row of store.listArtifacts()) {
      for (const cp of await artifactStore.readCheckpointsRecovered(row.id)) {
        if (cp.status !== 'closed') continue;
        if (cp.diff_fingerprint_summary.manifest_hash !== null) continue;
        if (cp.open_snapshot.tree_sha === null || cp.close_snapshot.tree_sha === null) continue;
        const cached = await readDerivedCache(projectDir, row.id, cp.n);
        if (cached === null) offenders.push(`  - ${row.id} checkpoint #${cp.n}`);
      }
    }
    checks.push(
      offenders.length === 0
        ? {
            name: 'archive-manifest-derivation',
            status: 'pass',
            summary:
              'every closed checkpoint has a stored or cached (or underivable-by-design) manifest',
          }
        : {
            name: 'archive-manifest-derivation',
            status: 'warn',
            summary: `${offenders.length} checkpoint(s) derivable only while their snapshot refs live`,
            details: [
              ...offenders,
              'Run `orcaops fingerprint derive --artifact <id> --checkpoint <n>` to cache each before pruning refs.',
            ],
          }
    );
  } catch (err) {
    checks.push({
      name: 'archive-manifest-derivation',
      status: 'warn',
      summary: `could not scan manifests: ${(err as Error).message}`,
    });
  }

  return checks;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
