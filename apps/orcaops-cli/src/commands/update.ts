import path from 'node:path';

import { configLocationForScope, Repo, resolveConfigSource } from '@orcaops/core';
import { resolveConfig } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { displayConfigPath, resolvePersonalConfigForAdoption } from '../lib/config-file.js';
import { buildContext } from '../lib/context.js';
import { ORCAOPS_BASE_GITIGNORE, reconcileGitignore } from '../lib/gitignore.js';
import {
  type GlobalInstallLockScope,
  type GlobalInstallManifest,
  type GlobalInstallResult,
  planGlobalInstall,
  readGlobalManifest,
  releaseGlobalRefs,
  resolveGlobalRoot,
  withGlobalInstallLock,
} from '../lib/global-install.js';
import { derivedIgnoreGlobs } from '../lib/install-agents.js';
import { INSTALL_MANIFEST_REL, readInstallManifest } from '../lib/install-manifest.js';
import {
  assertInvisiblePlan,
  planInstallMutations,
  publishInstallManifestsLast,
} from '../lib/install-plan.js';
import { planOrphanPrune, rmdirEmptyManagedDirs } from '../lib/install-prune.js';
import { getInvocationCwd } from '../lib/invocation-context.js';
import {
  deleteMutation,
  executeMutations,
  type MutationMode,
  planManagedGitHookRefreshMutations,
  type PlannedMutation,
  readRepositoryFileOrNull,
  writeMutation,
} from '../lib/mutations.js';
import { readEffectiveLocalManifest } from '../lib/personal-manifest.js';
import { ensureProjectId, readProjectId } from '../lib/project-identity.js';
import { withRepositoryInstallLock } from '../lib/repository-install-lock.js';
import { resolveOrcaopsRoot } from '../lib/resolve-root.js';
import { SESSION_HOOK_RESTART_NOTICE, sessionHooksRestartRequired } from '../lib/session-hooks.js';
import { enabledSkillTemplates, gateWithheldSkillTemplates } from '../lib/skill-set.js';

export interface UpdateOptions {
  force?: boolean;
  json?: boolean;
  cwd?: string;
  /** Plan and print the changes without writing anything. */
  dryRun?: boolean;
  /**
   * Change the skill/command naming prefix. Persists the new prefix to
   * config.json and drives a manifest-tracked rename: the old `<old>-*` footprint
   * is hash-guard-pruned and everything re-renders + re-installs under `<new>`.
   */
  prefix?: string;
  /**
   * Install scope: `project` (default) or `global`. When given, it is
   * persisted to config.json. Under `global`, skills/commands materialize into the
   * per-user global dirs (ref-counted) instead of the repo; the block stays project.
   */
  scope?: 'project' | 'global' | 'personal';
  /**
   * The scope this repo held BEFORE the caller persisted a new one. Not a CLI
   * flag: `configure` writes config.json and then delegates here, so by the
   * time this runs the config already reports the new scope and the flag
   * comparison can no longer see the transition. Callers that persist first
   * pass the old value so the scope-exit reconcile still fires.
   */
  previousScope?: 'project' | 'global' | 'personal';
  /** Shorthand for scope 'personal'. */
  personal?: boolean;
  /** Global materialization: `copy` (default) or `symlink`. Persisted when given. */
  link?: 'copy' | 'symlink';
  /**
   * Tri-state session-hooks toggle (persisted to
   * `config.session_hooks.enabled`). `orcaops update --no-session-hooks` is
   * the documented disable path; the install planner then reconciles the
   * hook surfaces on this same run.
   */
  sessionHooks?: boolean;
  /**
   * Switch the session-hook payload mode (persisted). The installed settings
   * entries are identical across modes, so this needs no reinstall and no
   * session restart — the hook command reads the mode fresh each session.
   */
  sessionHookPayload?: 'static' | 'state-aware';
  /**
   * Which registration carries the hook here (persisted). `none` strips the
   * repo settings entries on this same run — the machine-level registration
   * (`orcaops session-hooks install`) covers the repo; `enabled` gates
   * emission only.
   */
  sessionHookEntries?: 'project' | 'none';
}

/**
 * Re-render the agent skills + slash commands for the configured agent tool.
 * Files whose generation stamp (`generatedBy` version + `contentHash`
 * fingerprint) matches the current render are left alone (so user edits to the
 * current generation are preserved); files stamped with an older version — or
 * whose fingerprint differs because a template body changed at an UNCHANGED
 * version — get refreshed. Files stamped with a NEWER version are preserved
 * and surfaced via `preserved_ahead` + a warning; `--force` overwrites
 * everything, ahead files included — the one deliberate-downgrade path.
 *
 * Routes every write through the shared mutation/preview layer, so `--dry-run`
 * plans the same work and writes nothing.
 */
export async function updateAction(opts: UpdateOptions = {}): Promise<void> {
  try {
    const runWithLease = async (installLease: { verify(): Promise<void> }): Promise<void> => {
      // Resolve once via buildContext, which anchors to the git worktree root
      // (honoring --root / ORCAOPS_ROOT) and maps NOT_A_REPO / UNINITIALIZED.
      const ctx = await buildContext({ cwd: opts.cwd });
      try {
        const repoRoot = ctx.repoRoot;
        if (opts.personal) opts.scope = 'personal';
        const priorScope = opts.previousScope ?? ctx.config.install.scope;
        const effectiveScope = opts.scope ?? ctx.config.install.scope;
        const source = await resolveConfigSource(repoRoot);
        const destination = await configLocationForScope(repoRoot, effectiveScope);
        const movingSource = destination.configPath !== source.configPath;
        const adoptedPersonalContent =
          movingSource && source.kind === 'worktree' && effectiveScope === 'personal'
            ? await readRepositoryFileOrNull(
                destination.configPath,
                destination.containmentRoot,
                'shared personal configuration'
              )
            : null;
        if (adoptedPersonalContent !== null) {
          ctx.config = resolvePersonalConfigForAdoption(
            adoptedPersonalContent,
            displayConfigPath(destination, repoRoot)
          );
        }
        // The INSTALL set — update refreshes every agent's skills/commands
        // + the union block, not just one. An empty set (manual mode / `other`) is a
        // graceful no-op rather than an error.
        const installAgents = ctx.config.install.agents;

        // Read the prior manifests once: they drive the churn-free manifest writes
        // (inside the shared planner) and the orphan-prune diff. Carry the
        // orcaops-managed .gitignore lines forward; update doesn't
        // manage the gitignore itself.
        const prevInstall = await readInstallManifest(repoRoot);
        // The prior install's record lives under the scope it was MADE under:
        // configure persists the new scope before delegating here, so only
        // `previousScope` still knows where that was.
        const prevLocal = await readEffectiveLocalManifest(repoRoot, priorScope);
        // Preflight the GLOBAL manifest too, before any project mutation lands:
        // the global phase re-reads it under its lock, but by then project
        // writes have executed and a corrupt global file would strand a
        // half-done update.
        await readGlobalManifest();
        const prevInstallContent = await readRepositoryFileOrNull(
          path.join(repoRoot, INSTALL_MANIFEST_REL),
          repoRoot,
          'install manifest'
        );
        const baseGitignore = [...ORCAOPS_BASE_GITIGNORE];

        // The install scope/link — a flag overrides + persists the repo's
        // durable choice; otherwise the config value drives this run.
        const effectiveLink = opts.link ?? ctx.config.install.link;

        const personalWarnings: string[] = [];
        // Personal scope has no repo settings entries and no instruction
        // block; a flag asking for either would persist a dead setting.
        if (effectiveScope === 'personal' && opts.sessionHookEntries === 'project') {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            '--session-hook-entries project is not available under personal scope: personal ' +
              'installs register hooks at the machine level only (`orcaops session-hooks install`).'
          );
        }
        // Leaving project scope edits tracked files (pruned trees, stripped
        // .gitignore, deleted install.json) — legitimate, but committing them
        // de-adopts the repo for the whole team, so say so once.
        if (effectiveScope === 'personal' && priorScope === 'project') {
          personalWarnings.push(
            'scope changed project → personal: committed orcaops files were modified or ' +
              'removed in the worktree — review `git status`; committing those changes ' +
              'de-adopts the repo for everyone sharing it.'
          );
        }

        // Persist a `--prefix` rename and/or `--scope`/`--link` change to RAW
        // config.json in one write (through the mutation layer, so
        // --dry-run stays honest). Mutate the RAW parsed config so a user's minimal
        // config stays minimal.
        let configMutation: PlannedMutation | undefined;
        let configRemoval: PlannedMutation | undefined;
        const prefixChange = opts.prefix !== undefined && opts.prefix !== ctx.config.naming.prefix;
        const scopeChange = opts.scope !== undefined && opts.scope !== ctx.config.install.scope;
        // What the RECONCILE needs: did this repo's scope actually move? For the
        // flag path that is exactly `scopeChange`; for a caller that persisted
        // first, only `previousScope` still knows. Kept separate from
        // `scopeChange`, which additionally gates persisting the flag itself.
        const scopeTransition = effectiveScope !== priorScope;
        const linkChange = opts.link !== undefined && opts.link !== ctx.config.install.link;
        const sessionHooksChange =
          opts.sessionHooks !== undefined && opts.sessionHooks !== ctx.config.session_hooks.enabled;
        const sessionHookPayloadChange =
          opts.sessionHookPayload !== undefined &&
          opts.sessionHookPayload !== ctx.config.session_hooks.payload;
        const sessionHookEntriesChange =
          opts.sessionHookEntries !== undefined &&
          opts.sessionHookEntries !== ctx.config.session_hooks.entries;
        if (
          adoptedPersonalContent !== null ||
          prefixChange ||
          scopeChange ||
          linkChange ||
          sessionHooksChange ||
          sessionHookPayloadChange ||
          sessionHookEntriesChange
        ) {
          if (prefixChange) {
            try {
              resolveConfig({ naming: { prefix: opts.prefix } });
            } catch {
              throw new OrcaopsError(
                ErrorCodes.INVALID_INPUT,
                `--prefix "${opts.prefix}" must be lowercase and hyphen-safe (e.g. "orcaops", "oo", "my-team").`
              );
            }
          }
          // Read the config in effect, but write to the one the DESTINATION
          // scope owns: `--scope personal` publishes to the git-common file
          // while a project config is still the effective source, and the
          // worktree copy is removed below as part of de-adoption.
          const configRel = path.relative(repoRoot, source.configPath);
          const sourceContent = await readRepositoryFileOrNull(
            source.configPath,
            source.containmentRoot,
            'orcaops configuration'
          );
          if (sourceContent === null) {
            throw new OrcaopsError(
              ErrorCodes.UNINITIALIZED,
              `${displayConfigPath(source, repoRoot)} does not exist.`
            );
          }
          const parsed = JSON.parse(adoptedPersonalContent ?? sourceContent) as {
            naming?: Record<string, unknown>;
            install?: Record<string, unknown>;
            session_hooks?: Record<string, unknown>;
          };
          if (prefixChange) {
            parsed.naming = { ...(parsed.naming ?? {}), prefix: opts.prefix };
            ctx.config.naming.prefix = opts.prefix as string;
          }
          if (scopeChange || linkChange) {
            parsed.install = { agents: ctx.config.install.agents, ...(parsed.install ?? {}) };
            if (scopeChange) {
              parsed.install.scope = opts.scope;
              ctx.config.install.scope = opts.scope as 'project' | 'global' | 'personal';
            }
            // Personal scope always stores the only values it supports.
            if (opts.scope === 'personal') {
              (parsed as { bootstrap?: string }).bootstrap = 'manual';
              parsed.session_hooks = { ...(parsed.session_hooks ?? {}), entries: 'none' };
              ctx.config.bootstrap = 'manual';
              ctx.config.session_hooks.entries = 'none';
            }
            if (linkChange) {
              parsed.install.link = opts.link;
              ctx.config.install.link = opts.link as 'copy' | 'symlink';
            }
          }
          if (sessionHooksChange) {
            parsed.session_hooks = {
              ...(parsed.session_hooks ?? {}),
              enabled: opts.sessionHooks,
            };
            ctx.config.session_hooks.enabled = opts.sessionHooks as boolean;
          }
          if (sessionHookPayloadChange) {
            parsed.session_hooks = {
              ...(parsed.session_hooks ?? {}),
              payload: opts.sessionHookPayload,
            };
            ctx.config.session_hooks.payload = opts.sessionHookPayload as 'static' | 'state-aware';
          }
          if (sessionHookEntriesChange) {
            parsed.session_hooks = {
              ...(parsed.session_hooks ?? {}),
              entries: opts.sessionHookEntries,
            };
            ctx.config.session_hooks.entries = opts.sessionHookEntries as 'project' | 'none';
          }
          const desired = `${JSON.stringify(parsed, null, 2)}\n`;
          const priorDestination = movingSource
            ? (adoptedPersonalContent ??
              (await readRepositoryFileOrNull(
                destination.configPath,
                destination.containmentRoot,
                'orcaops configuration'
              )))
            : sourceContent;
          configMutation = writeMutation(
            repoRoot,
            path.relative(repoRoot, destination.configPath),
            desired,
            priorDestination,
            desired !== priorDestination,
            destination.containmentRoot,
            destination.configPath
          );
          // A published personal config must not leave a worktree config
          // behind claiming the same repository: source selection would fail
          // closed on it, bricking every command until the user removed it by
          // hand.
          if (movingSource && source.kind === 'worktree') {
            configRemoval = deleteMutation(
              repoRoot,
              configRel,
              { kind: 'file', content: sourceContent },
              true
            );
          }
        }

        // Plan generation + instruction placement + manifest refresh through the
        // one shared mutation path (also used by init and doctor --fix).
        // Under generated_files:'ignore' (project scope only) gitignore the
        // generated trees with adapter-DERIVED globs (so a prefix/install-set change
        // updates them); 'commit' (default) keeps just the base lines — byte-unchanged.
        const wantIgnore = ctx.config.generated_files === 'ignore' && effectiveScope !== 'global';
        // Personal scope manages NO repo .gitignore lines; its footprint hides
        // via .git/info/exclude (reconciled below).
        const desiredGitignore =
          effectiveScope === 'personal'
            ? []
            : wantIgnore
              ? [
                  ...baseGitignore,
                  ...derivedIgnoreGlobs(
                    installAgents,
                    ctx.config.naming.prefix,
                    ctx.config.session_hooks.enabled
                  ),
                ]
              : baseGitignore;

        const plan = await planInstallMutations({
          repoRoot,
          agents: installAgents,
          scope: effectiveScope,
          config: ctx.config,
          gates: ctx.gates,
          generatedBy: CLI_VERSION,
          force: opts.force,
          // update --force IS the deliberate downgrade: the only caller that
          // may override the ahead guard (init --force must not).
          allowDowngrade: opts.force,
          gitignoreLines: desiredGitignore,
          prevInstall,
          prevLocal,
          leavingPersonalScope:
            scopeTransition && effectiveScope !== 'personal' && priorScope === 'personal',
        });
        const mutations = [...plan.mutations];
        if (configRemoval) mutations.unshift(configRemoval);
        if (configMutation) mutations.unshift(configMutation);

        // Prune orphans — owned files dropped from the plan since the prior
        // install. Hash-guarded by deleteMode (reconstruct-if-absent first); prune
        // carries its OWN result (deleted/preserved) and executes via the same path.
        const prune = await planOrphanPrune({
          repoRoot,
          prefix: ctx.config.naming.prefix,
          prevInstall,
          nextInstall: plan.install,
          prevLocal,
          genFiles: plan.genFiles,
          currentVersion: CLI_VERSION,
        });
        mutations.push(...prune.mutations);

        const hooksDir = await ctx.repo.getHooksDir();
        if (hooksDir.source !== 'core.hooksPath') {
          mutations.push(
            ...(await planManagedGitHookRefreshMutations(repoRoot, hooksDir.dir, CLI_VERSION))
          );
        }

        // Reconcile orcaops's .gitignore lines in one write — add the desired
        // (base + derived globs under ignore mode) and prune stale ones (old-prefix globs,
        // or the derived globs on an ignore->commit switch).
        if (effectiveScope !== 'personal' || scopeTransition) {
          const giPlan = await reconcileGitignore(repoRoot, desiredGitignore);
          if (giPlan.desiredContent !== null) {
            mutations.push(
              writeMutation(
                repoRoot,
                '.gitignore',
                giPlan.desiredContent,
                giPlan.currentContent,
                true
              )
            );
          }
        }
        // info/exclude (personal add + scope-exit strip) rides the shared
        // planner (planInstallMutations) — no separate write path here.

        // Never-touch enforcement for STEADY-STATE personal runs (already
        // invisible: no committed manifest, no scope flag this run). Scope
        // TRANSITIONS legitimately edit tracked files — pruning trees,
        // stripping .gitignore, removing install.json — and git surfaces
        // those to commit, so they are exempt.
        if (effectiveScope === 'personal' && !scopeTransition && prevInstall === null) {
          await assertInvisiblePlan(repoRoot, mutations, plan.sessionHooks);
        }

        const removeInstallManifest = effectiveScope === 'personal' && prevInstall !== null;
        if (removeInstallManifest) {
          if (prevInstallContent === null) {
            throw new Error('install manifest disappeared after planning');
          }
          mutations.push(
            deleteMutation(
              repoRoot,
              INSTALL_MANIFEST_REL,
              { kind: 'file', content: prevInstallContent },
              true
            )
          );
        }

        // Eager identity: update covers repos without a minted id (the
        // projectid is git-local config, so fresh clones and worktrees lack
        // it) — ensure `orcaops.projectid` exists (idempotent, cheap
        // read when already minted; never on dry-run).
        // Eager identity (dry-run reads only); home-dir stores key by it verbatim.
        const repoId = opts.dryRun
          ? await readProjectId(new Repo(repoRoot))
          : (await ensureProjectId(new Repo(repoRoot))).projectId;

        // Under global scope, materialize skills/commands into the per-user
        // global dirs (ref-counted, per-user-current, copy-default/guarded-symlink) —
        // separate from the project block/manifest above (which stay project-scoped).
        const planGlobalPhase = (
          globalMode: MutationMode,
          globalManifest: GlobalInstallManifest | null,
          lockScope?: GlobalInstallLockScope
        ): Promise<GlobalInstallResult | null> => {
          if (repoId === null) {
            // Dry-run of a repo with no minted identity: nothing is recorded
            // under any home-dir key, so there is nothing to plan or release.
            return Promise.resolve(null);
          }
          if (
            (effectiveScope === 'global' || effectiveScope === 'personal') &&
            installAgents.length > 0
          ) {
            return planGlobalInstall(
              {
                repoId,
                agents: installAgents,
                prefix: ctx.config.naming.prefix,
                generatedBy: CLI_VERSION,
                link: effectiveLink,
                cliVersion: CLI_VERSION,
                skills: enabledSkillTemplates(ctx.config, ctx.gates),
                // The gate blocks creation, never deletion — here too. Without
                // this a logout silently strips the cloud skills from the
                // user's global skills dir on the next update, and login does
                // not put them back. heldPrefixes is derived from the prior
                // global manifest — it covers the prefixes this repo actually
                // holds, including under personal scope where there is no
                // committed manifest to read one from.
                heldSkills: gateWithheldSkillTemplates(ctx.config, ctx.gates),
                force: opts.force,
                // update --force IS the deliberate downgrade override; no
                // other caller may pass overrideAhead for a rendering write.
                overrideAhead: opts.force,
              },
              globalMode,
              globalManifest,
              lockScope
            );
          }
          // Left global scope (or empty install set): release this repo's global refs so a
          // prior global materialization is decremented + cleaned rather than leaked.
          return releaseGlobalRefs(
            // update --force is the sole caller allowed to release an AHEAD
            // tree's refs (a last-ref release deletes hash-owned files).
            { repoId, cliVersion: CLI_VERSION, force: opts.force, overrideAhead: opts.force },
            globalMode,
            globalManifest,
            lockScope
          );
        };

        const mode: MutationMode = opts.dryRun ? 'preview' : 'apply';
        let global: GlobalInstallResult | null;
        // Read (and validate) the global manifest BEFORE any project mutation
        // executes: a corrupt global file must fail the run while the worktree
        // is untouched, not strand a half-done update.
        const globalManifest = await readGlobalManifest();
        const needsGlobalWrite =
          ((effectiveScope === 'global' || effectiveScope === 'personal') &&
            installAgents.length > 0) ||
          (repoId !== null &&
            globalManifest?.entries.some((entry) => entry.refs.includes(repoId)) === true);
        if (mode === 'preview') {
          global = await planGlobalPhase('preview', globalManifest);
          await executeMutations(publishInstallManifestsLast(mutations), mode);
        } else if (needsGlobalWrite) {
          global = await withGlobalInstallLock(async (scope) => {
            await planGlobalPhase('preview', scope.manifest);
            await installLease.verify();
            await executeMutations(publishInstallManifestsLast(mutations), mode);
            await installLease.verify();
            return planGlobalPhase('apply', scope.manifest, scope);
          });
        } else {
          await installLease.verify();
          await executeMutations(publishInstallManifestsLast(mutations), mode);
          global = null;
        }

        // A scope switch to personal leaves the previously-committed
        // install.json stale (personal never writes it). Remove it so the
        // fresh-clone incompleteness nudge and manifest reads stop keying
        // off dead project entries; git surfaces the deletion for the user
        // to commit — that IS the switch.
        const removedInstallManifest = removeInstallManifest && mode === 'apply';

        // Detect a prefix change from the prior manifest's recorded
        // naming_prefix (works for `--prefix` AND a hand-edited config.json) and
        // rmdir now-empty dirs for BOTH the old and new prefix so no `<old>-*`
        // dir residue is left (apply mode only).
        const oldPrefix = prevInstall?.naming_prefix ?? null;
        const newPrefix = ctx.config.naming.prefix;
        const renamed = oldPrefix !== null && oldPrefix !== newPrefix;
        const cleanupPrefixes = [
          ...new Set([oldPrefix, newPrefix].filter((x): x is string => !!x)),
        ];
        const removedDirs =
          mode === 'apply'
            ? await rmdirEmptyManagedDirs(repoRoot, cleanupPrefixes, prune.deleted)
            : [];

        const result = plan.generate;
        const agentsMd = plan.agentsMd;
        const warnings = [...personalWarnings, ...plan.warnings, ...(global?.warnings ?? [])];

        if (opts.json) {
          emitOk({
            orcaops_version: CLI_VERSION,
            install_agents: installAgents,
            scope: effectiveScope,
            dry_run: !!opts.dryRun,
            ...result,
            // Project to the frozen {path, action} shape — the planner's
            // divergence metadata is emitted via `preserved_ahead` instead.
            agents_md: agentsMd.map((m) => ({ path: m.path, action: m.action })),
            session_hooks: plan.sessionHooks,
            restart_required: sessionHooksRestartRequired(plan.sessionHooks),
            warnings,
            preserved_ahead: [...plan.preservedAhead, ...prune.preservedAhead].map((p) => ({
              path: p.path,
              stamped_version: p.stampedVersion,
            })),
            pruned: prune.deleted,
            preserved_orphans: prune.preserved,
            removed_install_manifest: removedInstallManifest,
            removed_dirs: removedDirs,
            prefix_changed: renamed ? { from: oldPrefix, to: newPrefix } : null,
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
          });
          return;
        }

        const lines: string[] = [];
        if (opts.dryRun) {
          lines.push('DRY RUN — nothing was written.');
          lines.push('');
        }
        lines.push(
          `orcaops update — agents: ${installAgents.join(', ') || 'none'}, scope: ${effectiveScope}, version: ${CLI_VERSION}`
        );
        lines.push('');
        if (global) {
          if (global.skippedVersionMismatch) {
            lines.push(
              `Global scope: SKIPPED filesystem changes (CLI v${CLI_VERSION} vs ` +
                `manifest v${global.manifest.materialized_by}); refs updated.`
            );
          } else {
            lines.push(
              `Global scope (${resolveGlobalRoot()}): ${global.materialized.length} materialized` +
                (global.removed.length > 0 ? `, ${global.removed.length} removed` : '') +
                (global.copyFallbacks.length > 0
                  ? `, ${global.copyFallbacks.length} copied (foreign dir)`
                  : '')
            );
          }
          lines.push('');
        }
        if (renamed) {
          lines.push(
            `Prefix changed: ${oldPrefix} → ${newPrefix} (old entries pruned, re-rendered).`
          );
          lines.push('');
        }
        if (result.installed.length > 0) {
          lines.push(`Installed (${result.installed.length}):`);
          for (const p of result.installed) lines.push(`  + ${p}`);
          lines.push('');
        }
        if (result.refreshed.length > 0) {
          lines.push(`Refreshed (${result.refreshed.length}):`);
          for (const p of result.refreshed) lines.push(`  ~ ${p}`);
          lines.push('');
        }
        if (result.unchanged.length > 0) {
          lines.push(`Unchanged (${result.unchanged.length})`);
          lines.push('');
        }
        const touchedAgentsMd = agentsMd.filter((m) => m.action !== 'unchanged');
        if (touchedAgentsMd.length > 0) {
          lines.push(`Bootstrap section (${touchedAgentsMd.length}):`);
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
          lines.push('');
        }
        const touchedSessionHooks = plan.sessionHooks.filter(
          (h) => h.action === 'created' || h.action === 'updated' || h.action === 'removed'
        );
        if (touchedSessionHooks.length > 0) {
          lines.push(`Session hooks (${touchedSessionHooks.length}):`);
          for (const h of touchedSessionHooks) {
            const sym = h.action === 'created' ? '+' : h.action === 'removed' ? '-' : '~';
            lines.push(`  ${sym} ${h.path}  (${h.agent})`);
          }
          lines.push(`! ${SESSION_HOOK_RESTART_NOTICE}`);
          lines.push('');
        }
        if (prune.deleted.length > 0) {
          lines.push(`Pruned (${prune.deleted.length}):`);
          for (const p of prune.deleted) lines.push(`  - ${p}`);
          lines.push('');
        }
        if (prune.preserved.length > 0) {
          lines.push(`Preserved orphans (${prune.preserved.length}):`);
          for (const p of prune.preserved) lines.push(`  · ${p.path} (${p.reason})`);
          lines.push('');
        }
        for (const w of warnings) lines.push(`! ${w}`);
        if (warnings.length > 0) lines.push('');
        if (
          result.installed.length === 0 &&
          result.refreshed.length === 0 &&
          touchedAgentsMd.length === 0 &&
          touchedSessionHooks.length === 0 &&
          prune.deleted.length === 0 &&
          prune.preserved.length === 0
        ) {
          const aheadCount = plan.preservedAhead.length + prune.preservedAhead.length;
          if (aheadCount > 0) {
            lines.push(
              `${aheadCount} file(s) preserved — stamped newer than this CLI. Upgrade orcaops.`
            );
          } else if (!global?.skippedVersionMismatch) {
            // A skipped global rewrite is NOT up to date — the SKIPPED line
            // above already named the directional remedy.
            lines.push('Everything is already up to date for this version.');
          }
        }
        writeTerminalSafeStdout(lines.join('\n') + '\n');
      } finally {
        ctx.store.close();
      }
    };
    if (opts.dryRun) {
      await runWithLease({ verify: async () => {} });
    } else {
      const cwd = path.resolve(opts.cwd ?? getInvocationCwd());
      const repoRoot = await resolveOrcaopsRoot({ cwd });
      const commonDir = await new Repo(repoRoot).getCommonDirAbsolute();
      await withRepositoryInstallLock(commonDir, runWithLease);
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
