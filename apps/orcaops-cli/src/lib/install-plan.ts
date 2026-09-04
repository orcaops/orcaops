import path from 'node:path';

import {
  type GenerateResult,
  getToolAdapter,
  isVersionAhead,
  opencodeSessionPluginPath,
  planFile,
  planGenerateForTool,
  type PlannedFile,
  renderOpencodeSessionPlugin,
  resolveHintLines,
  type ToolAdapter,
} from '@orcaops/adapters';
import { commonOrcaopsDirFrom, Repo, resolveCommonDir } from '@orcaops/core';
import {
  type Config,
  resolveCanonicalPath,
  SUPPORTED_AGENT_IDS,
  type SupportedAgentId,
} from '@orcaops/storage';

import { planInfoExcludeMutation } from './git-info-exclude.js';
import {
  generatedFileOrder,
  type PreservedGeneratedFile,
  resolveCloudPreservation,
} from './install-cloud-preserve.js';
import {
  buildManifests,
  INSTALL_MANIFEST_REL,
  type InstallManifest,
  LOCAL_MANIFEST_REL,
  type LocalEntry,
  localEntryFromPlannedFile,
  type LocalManifest,
  readLocalManifest,
  toPortableManifestPath,
} from './install-manifest.js';
import { evaluateEntryDeleteGuard } from './install-prune.js';
import {
  type InstructionFileResult,
  type InstructionPlacement,
  planRemoveInstructionBlocks,
  resolveInstructionPlacement,
} from './instruction-placement.js';
import { deleteMutation, fileMutation, type PlannedMutation, writeMutation } from './mutations.js';
import {
  desiredPersonalExcludeLines,
  personalManifestClaimsExclude,
  planPersonalManifestWrite,
  readPersonalManifestState,
} from './personal-manifest.js';
import { planSessionHookSettings, type SessionHookFilePlan } from './session-hooks.js';
import { CLOUD_GATED_SKILL_IDS, enabledSkillTemplates, type SkillGates } from './skill-set.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface PlanInstallMutationsInput {
  repoRoot: string;
  /**
   * The install set. Adapters are resolved INTERNALLY; an id with no
   * adapter is skipped and surfaced in `warnings`. Empty → no skills/commands/block
   * (manual mode). All `SupportedAgentId`s are overlay-backed (parity test), so the
   * skip branch is defensive.
   */
  agents: SupportedAgentId[];
  /**
   * Install scope. `'project'` (default) generates
   * skills/commands into the repo; `'global'` skips that (they materialize
   * globally via planGlobalInstall) but still plans the project block +
   * committed manifest. `'personal'` (the invisible fresh-init default;
   * every overlay-backed agent) also skips project generation, targets the
   * bootstrap block at `CLAUDE.local.md` ONLY (the one Claude-ism —
   * personalScopeWarnings advises when other agents are present), writes NO
   * committed install.json — the manifest lives in the git-excluded
   * install.local.json alone — and reconciles the info/exclude section.
   */
  scope?: 'project' | 'global' | 'personal';
  config: Config;
  /** Machine-state skill gates (`ctx.gates`). Required — see SkillGates. */
  gates: SkillGates;
  /** CLI version stamped into generated files and the managed block. */
  generatedBy: string;
  /** Overwrite stamp-matching files instead of preserving them. */
  force?: boolean;
  /**
   * Allow overwriting files/blocks stamped NEWER than `generatedBy` — a
   * deliberate downgrade. Only `update --force` passes true.
   */
  allowDowngrade?: boolean;
  /** orcaops-managed `.gitignore` lines to carry forward into the manifest. */
  gitignoreLines: string[];
  /** Prior committed manifest — churn-free writeMutation + the orphan-prune diff. */
  prevInstall: InstallManifest | null;
  /** Prior local manifest — churn-free writeMutation. */
  prevLocal: LocalManifest | null;
  /**
   * This worktree is explicitly leaving personal scope. The common manifest
   * releases its claim on the `info/exclude` block and the block is stripped,
   * so the files project scope materializes are not hidden from `git add`.
   * A sibling worktree that is still personal re-adds the block on its next
   * update — drift reports the gap until it does.
   */
  leavingPersonalScope?: boolean;
}

export interface PlanInstallMutationsResult {
  /** Generate fileMutations + instruction mutations + the two manifest writeMutations. */
  mutations: PlannedMutation[];
  /** Generated skill/command files — feed the manifest AND the prune's reconstruct fallback. */
  genFiles: PlannedFile[];
  instructionPlacements: InstructionPlacement[];
  /** The freshly-built committed manifest — the orphan prune diffs `prevInstall` against this. */
  install: InstallManifest;
  /**
   * The freshly-built per-machine manifest. Returned alongside `install` because
   * the two must stay in lockstep: an entry recorded as owned in one but missing
   * from the other cannot be verified, and `evaluateEntryDeleteGuard` then
   * preserves it as unverifiable forever.
   */
  local: LocalManifest;
  /** installed/refreshed/unchanged/skipped tallies (NOT delete semantics). */
  generate: GenerateResult;
  agentsMd: InstructionFileResult[];
  /** Per-agent session-hook settings outcomes (empty when the feature is off and clean). */
  sessionHooks: SessionHookFilePlan[];
  warnings: string[];
  /** Files/blocks stamped NEWER than this CLI — preserved, not downgraded. */
  preservedAhead: { path: string; stampedVersion: string }[];
  /** The adapter-backed subset actually generated (echo of `agents`, canonical order). */
  installedAgents: SupportedAgentId[];
}

/**
 * Dedupe + canonical-order an install set (the `SUPPORTED_AGENT_IDS` declaration
 * order) so the committed manifest's `install_agents` is deterministic and churn-free
 * regardless of flag/detection order.
 */
export function canonicalAgents(ids: SupportedAgentId[]): SupportedAgentId[] {
  return [...new Set(ids)].sort(
    (a, b) => SUPPORTED_AGENT_IDS.indexOf(a) - SUPPORTED_AGENT_IDS.indexOf(b)
  );
}

export function publishInstallManifestsLast(
  mutations: ReadonlyArray<PlannedMutation>
): PlannedMutation[] {
  const ordinary: PlannedMutation[] = [];
  const localManifest: PlannedMutation[] = [];
  const installManifest: PlannedMutation[] = [];
  // Independent planning passes (block excise, scope-transition guard, orphan
  // prune) can each legitimately claim the same entry's delete; the executor's
  // disappeared-after-planning guard rightly refuses the second at apply, so
  // exact-duplicate deletes collapse HERE, at the one seam every writer's
  // batch already flows through. Only deletes dedupe — a delete/write pair on
  // one path stays a planner conflict for the executor to refuse.
  const seenDeletes = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.kind === 'delete') {
      // The expectation is part of the key: only EXACT duplicates collapse.
      // Two planners claiming one path with different expectations is a real
      // disagreement, and the executor's apply-time recheck must arbitrate it.
      const expectation = mutation.deleteExpectation;
      const expectationKey =
        expectation === undefined
          ? 'none'
          : expectation.kind === 'file'
            ? `file\u0000${expectation.content}`
            : expectation.kind === 'symlink'
              ? `symlink\u0000${expectation.target}`
              : 'directory';
      const key = `${mutation.containmentRoot}\u0000${mutation.path}\u0000${expectationKey}`;
      if (seenDeletes.has(key)) continue;
      seenDeletes.add(key);
    }
    const relative = path.normalize(mutation.path);
    if (relative === path.normalize(LOCAL_MANIFEST_REL)) {
      localManifest.push(mutation);
    } else if (relative === path.normalize(INSTALL_MANIFEST_REL)) {
      installManifest.push(mutation);
    } else {
      ordinary.push(mutation);
    }
  }
  return [...ordinary, ...localManifest, ...installManifest];
}

/**
 * The shared install-mutation planner — the ONE mutation path `init`, `update`,
 * and `doctor --fix` share. It (1) plans skills + slash commands for
 * EACH agent in the install set, (2) resolves the canonical instruction file +
 * opportunistic symlinks over the DEDUPED UNION of instruction files across the set
 * (or, under `bootstrap:"manual"`, plans the hash-guarded block removal), and (3)
 * rebuilds the churn-free committed manifest + per-machine local manifest.
 *
 * It does NOT execute — the caller owns apply vs preview, so `--dry-run` and the
 * orphan prune compose around it. Routing every writer through this one planner is
 * why `init`/`update`/`doctor --fix` get the multi-agent loop, preview, manifest
 * recording, prefix, and hints for free rather than re-deriving them.
 */
export async function planInstallMutations(
  input: PlanInstallMutationsInput
): Promise<PlanInstallMutationsResult> {
  const { repoRoot, config, generatedBy } = input;
  const agents = canonicalAgents(input.agents);
  // The enabled skill set: generation, the managed block, and the
  // manifest all derive from it, so a disable flows to every surface at once
  // — and `update`'s existing orphan-prune deletes the newly-absent dirs.
  const enabledSkills = enabledSkillTemplates(config, input.gates);
  const mutations: PlannedMutation[] = [];
  const generate: GenerateResult = { installed: [], refreshed: [], unchanged: [], skipped: [] };
  const warnings: string[] = [];
  const preservedAhead: { path: string; stampedVersion: string }[] = [];
  const forcedDowngrades: { path: string; stampedVersion: string }[] = [];

  // Resolve adapters. A SupportedAgentId always has an overlay (parity test), so the
  // skip branch is defensive against a stale / hand-edited id.
  const adapters: ToolAdapter[] = [];
  const installedAgents: SupportedAgentId[] = [];
  for (const id of agents) {
    const adapter = getToolAdapter(id);
    if (!adapter) {
      warnings.push(`no adapter registered for install agent "${id}" — skipped`);
      continue;
    }
    adapters.push(adapter);
    installedAgents.push(id);
  }

  // Per-agent generate loop. Command dirs are disjoint across agents, but
  // codex/cursor/opencode SHARE the universal `.agents/skills` dir — the
  // `seenPaths` dedupe is first-wins with no conflict detection, so agents
  // sharing a skillsDir must render byte-identical skills (enforced by the
  // shared-dir parity test in @orcaops/adapters overlay.test.ts).
  const genFiles: PlannedFile[] = [];
  const seenPaths = new Set<string>();
  // Under global AND personal scope the skills/commands materialize into the
  // user's global dirs (planGlobalInstall), NOT the repo — so skip project
  // generation here.
  if (input.scope !== 'global' && input.scope !== 'personal') {
    for (const adapter of adapters) {
      const genPlan = await planGenerateForTool({
        repoRoot,
        adapter,
        generatedBy,
        prefix: config.naming.prefix,
        force: input.force,
        overrideAhead: input.allowDowngrade,
        skills: enabledSkills,
      });
      generate.skipped.push(...genPlan.skipped);
      for (const pf of genPlan.files) {
        if (seenPaths.has(pf.path)) continue;
        seenPaths.add(pf.path);
        genFiles.push(pf);
        mutations.push(fileMutation(repoRoot, pf));
        if (pf.reason === 'preserved-ahead') {
          preservedAhead.push({ path: pf.path, stampedVersion: pf.onDiskVersion ?? '' });
        } else if (pf.reason === 'forced-downgrade') {
          forcedDowngrades.push({ path: pf.path, stampedVersion: pf.onDiskVersion ?? '' });
        }
        if (pf.action === 'create') generate.installed.push(pf.path);
        else if (pf.action === 'replace') generate.refreshed.push(pf.path);
        else generate.unchanged.push(pf.path);
      }
    }

    // The OpenCode session plugin — the one `plugin-file` session-hook
    // surface: a wholly orcaops-owned generated file that self-registers by
    // existing in `.opencode/plugins/`, so it rides the normal generated-file
    // pipeline (stamp, manifest, hash-guarded orphan-prune, uninstall, drift)
    // with zero new machinery — unlike the co-owned settings files planned
    // below. Disabling session hooks (or dropping opencode from the set)
    // simply omits it from this plan; `update`'s planOrphanPrune then deletes
    // it hash-guarded.
    if (config.session_hooks.enabled && installedAgents.includes('opencode')) {
      const rel = opencodeSessionPluginPath(config.naming.prefix);
      if (!seenPaths.has(rel)) {
        seenPaths.add(rel);
        const pf = await planFile(
          { repoRoot, generatedBy, force: input.force },
          rel,
          renderOpencodeSessionPlugin({ generatedBy })
        );
        genFiles.push(pf);
        mutations.push(fileMutation(repoRoot, pf));
        if (pf.action === 'create') generate.installed.push(pf.path);
        else if (pf.action === 'replace') generate.refreshed.push(pf.path);
        else generate.unchanged.push(pf.path);
      }
    }
  }

  // Plan the AGENTS.md / CLAUDE.md bootstrap section over the DEDUPED UNION of
  // instruction files across the install set — every agent targets AGENTS.md,
  // so a per-agent loop would inject the managed block into it repeatedly.
  // The instruction-placement resolver picks one canonical file +
  // opportunistic symlinks; under bootstrap=manual the block is pruned
  // (hash-guarded) instead.
  const agentsMd: InstructionFileResult[] = [];
  let instructionPlacements: InstructionPlacement[] = [];
  // Personal scope owns NO instruction file: guidance reaches the agent
  // through machine session hooks or global skills, and the repository stays
  // untouched. Project/global inject into the union of adapter files.
  const instructionFiles =
    input.scope === 'personal' ? [] : [...new Set(adapters.flatMap((a) => a.agentsFiles ?? []))];

  const priorInstructionEntries = (
    input.prevInstall?.entries ??
    input.prevLocal?.entries ??
    []
  ).filter((entry) => entry.kind === 'injected-block');
  const leavingProjectScope = input.scope === 'personal' && input.prevInstall !== null;
  const outgoingInstructionFiles = leavingProjectScope
    ? priorInstructionEntries.map((entry) => entry.path)
    : [];

  if (outgoingInstructionFiles.length > 0) {
    const priorLocalEntries = new Map(
      (input.prevLocal?.entries ?? [])
        .filter((entry) => entry.kind === 'injected-block')
        .map((entry) => [entry.path, entry])
    );
    // Paths the symlink guard already deletes are settled: the block-removal
    // pass below reads THROUGH the twin symlink and would plan a second delete
    // of the same entry, which the executor's disappeared-after-planning guard
    // rightly refuses at apply.
    const removedBySymlinkGuard = new Set<string>();
    for (const instructionFile of outgoingInstructionFiles) {
      const prior = priorLocalEntries.get(instructionFile);
      if (prior?.materialization !== 'symlink') continue;
      const guard = await evaluateEntryDeleteGuard(
        repoRoot,
        { kind: 'injected-block', path: instructionFile },
        prior,
        generatedBy
      );
      if (guard.kind === 'delete') {
        mutations.push(guard.mutation);
        agentsMd.push({ path: instructionFile, action: 'removed' });
        removedBySymlinkGuard.add(instructionFile);
      } else if (guard.kind === 'preserve' || guard.kind === 'confirm') {
        warnings.push(
          `scope changed but the modified instruction symlink at ${instructionFile} remains; remove it by hand.`
        );
      }
    }

    const removal = await planRemoveInstructionBlocks({
      repoRoot,
      instructionFiles: outgoingInstructionFiles.filter((f) => !removedBySymlinkGuard.has(f)),
      generatedBy,
      prefix: config.naming.prefix,
      hints: resolveHintLines(config.workflow.hints),
      enabledSkills,
      reason: 'scope-transition',
    });
    for (const mutation of removal.mutations) {
      const prior = priorLocalEntries.get(mutation.path);
      if (
        (mutation.desiredContent ?? '').trim() === '' &&
        prior?.provenance === 'created' &&
        mutation.currentContent !== null
      ) {
        mutations.push(
          deleteMutation(
            repoRoot,
            mutation.path,
            { kind: 'file', content: mutation.currentContent },
            true
          )
        );
      } else {
        mutations.push(mutation);
      }
    }
    agentsMd.push(...removal.results);
    warnings.push(...removal.warnings);
  }

  if (instructionFiles.length > 0 && config.bootstrap !== 'manual') {
    const placement = await resolveInstructionPlacement({
      repoRoot,
      instructionFiles,
      generatedBy,
      prefix: config.naming.prefix,
      hints: resolveHintLines(config.workflow.hints),
      enabledSkills,
      force: input.force,
      overrideAhead: input.allowDowngrade,
    });
    mutations.push(...placement.mutations);
    instructionPlacements = placement.placements;
    agentsMd.push(...placement.results);
    warnings.push(...placement.warnings);
    for (const r of placement.results) {
      if (r.reason === 'preserved-ahead') {
        preservedAhead.push({ path: r.path, stampedVersion: r.stampedVersion ?? '' });
      } else if (r.reason === 'forced-downgrade') {
        forcedDowngrades.push({ path: r.path, stampedVersion: r.stampedVersion ?? '' });
      }
    }
  } else if (instructionFiles.length > 0 && config.bootstrap === 'manual') {
    const removal = await planRemoveInstructionBlocks({
      repoRoot,
      instructionFiles,
      generatedBy,
      prefix: config.naming.prefix,
      hints: resolveHintLines(config.workflow.hints),
      enabledSkills,
    });
    mutations.push(...removal.mutations);
    agentsMd.push(...removal.results);
    warnings.push(...removal.warnings);
  }

  const maxStamp = (entries: { stampedVersion: string }[]): string =>
    entries.reduce(
      (max, e) => (isVersionAhead(e.stampedVersion, max) ? e.stampedVersion : max),
      '0.0.0'
    );
  if (preservedAhead.length > 0) {
    warnings.push(
      `${preservedAhead.length} orcaops-managed file(s) are stamped by a NEWER orcaops ` +
        `(up to v${maxStamp(preservedAhead)}) than this CLI (v${generatedBy}) — preserved, not ` +
        `downgraded. Upgrade orcaops to manage them, or run \`orcaops update --force\` to ` +
        `deliberately downgrade.`
    );
  }
  if (forcedDowngrades.length > 0) {
    warnings.push(
      `--force overwrote ${forcedDowngrades.length} file(s) stamped by a newer orcaops ` +
        `(up to v${maxStamp(forcedDowngrades)} → v${generatedBy}).`
    );
  }

  // Session-start hook entries (the bootstrap ladder's top rung) ride this
  // same shared planner so init, `update`, and `doctor --fix` all reconcile
  // them and `--dry-run` previews them — the deliberate improvement over git
  // hooks, which only `init --with-hooks` touches. Manifest-less by design:
  // the entries are self-identifying (SESSION_HOOK_COMMAND substring) inside
  // co-owned settings files — see session-hooks.ts for the ownership model.
  const sessionHookPlan = await planSessionHookSettings({
    repoRoot,
    agents: installedAgents,
    enabled: config.session_hooks.enabled,
    scope: input.scope ?? 'project',
    entries: config.session_hooks.entries,
  });
  mutations.push(...sessionHookPlan.mutations);
  warnings.push(...sessionHookPlan.warnings);

  // info/exclude rides the shared planner too: personal scope hides its
  // untracked footprint via the COMMON dir's exclude file. The desired set
  // comes from the one helper every reconciler shares, so a worktree leaving
  // personal scope strips the section only when no sibling still relies on
  // it. Degraded repos (rev-parse failure) get a warning, not a planner crash
  // — there is no git status to keep clean there anyway.
  let desiredExcludeLines: string[] = [];
  try {
    desiredExcludeLines = input.leavingPersonalScope
      ? []
      : await desiredPersonalExcludeLines(repoRoot, input.scope ?? 'project');
    if (input.leavingPersonalScope) {
      await personalManifestClaimsExclude(repoRoot);
      const state = await readPersonalManifestState(repoRoot);
      if (state.kind === 'valid' && (state.manifest.info_exclude ?? []).length > 0) {
        const { info_exclude: _released, ...released } = state.manifest;
        mutations.push(
          planPersonalManifestWrite(repoRoot, state.location, released, state.content)
        );
      }
    }
    const excludePlan = await planInfoExcludeMutation({
      repoRoot,
      desired: desiredExcludeLines,
    });
    if (excludePlan) mutations.push(excludePlan.mutation);
  } catch (err) {
    warnings.push(`info/exclude not reconciled: ${err instanceof Error ? err.message : err}`);
  }

  // Refresh the two-layer install manifest from this plan, carrying the prior
  // gitignore lines forward (this planner doesn't manage `.gitignore` itself).
  const { install, local } = await planInstallManifests({
    repoRoot,
    adapters,
    installAgents: installedAgents,
    config,
    gates: input.gates,
    scope: input.scope ?? 'project',
    currentVersion: generatedBy,
    genFiles,
    instructionPlacements,
    gitignoreLines: input.gitignoreLines,
    infoExcludeLines: desiredExcludeLines,
    prevInstall: input.prevInstall,
    prevLocal: input.prevLocal,
  });
  const installJson = `${JSON.stringify(install, null, 2)}\n`;
  const localJson = `${JSON.stringify(local, null, 2)}\n`;
  const prevInstallJson = input.prevInstall
    ? `${JSON.stringify(input.prevInstall, null, 2)}\n`
    : null;
  // The churn-free compare must read the file AT THE DESTINATION: on a
  // personal→project switch `input.prevLocal` is the common manifest while
  // the worktree manifest does not exist yet, and a "replace" planned against
  // absent bytes is refused at apply.
  const currentWorktreeLocal = await readLocalManifest(repoRoot);
  const prevLocalJson = currentWorktreeLocal
    ? `${JSON.stringify(currentWorktreeLocal, null, 2)}\n`
    : null;
  // Personal scope writes NO committed install.json and NO worktree
  // manifest — a shared enterprise repo must see zero tracked-file changes,
  // and the ownership record belongs to the repository, not one checkout. It
  // goes to the common personal manifest, which also owns the exclusion.
  if (input.scope === 'personal') {
    // A residual manifest from an earlier install is reconciled when valid
    // and replaced when stale; an unsafe one throws the manual recovery.
    const state = await readPersonalManifestState(repoRoot);
    mutations.push(
      planPersonalManifestWrite(
        repoRoot,
        state.location,
        local,
        state.kind === 'absent' ? null : state.content
      )
    );
  } else {
    mutations.push(
      writeMutation(
        repoRoot,
        INSTALL_MANIFEST_REL,
        installJson,
        prevInstallJson,
        installJson !== prevInstallJson
      )
    );
    mutations.push(
      writeMutation(
        repoRoot,
        LOCAL_MANIFEST_REL,
        localJson,
        prevLocalJson,
        localJson !== prevLocalJson
      )
    );
  }

  return {
    mutations,
    genFiles,
    instructionPlacements,
    install,
    local,
    generate,
    agentsMd,
    sessionHooks: sessionHookPlan.plans,
    warnings,
    preservedAhead,
    installedAgents,
  };
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Where a personal-scope mutation is allowed to land, as ABSOLUTE roots:
 * the git common dir's `orcaops/` directory, the exact common `info/exclude`
 * file, and this worktree's excluded `.orcaops/` store. A relative-path
 * shape (`../…`, `.git/…`) is not a boundary — every target is resolved and
 * checked against the root it was planned under.
 */
export interface InvisibleTargets {
  commonOrcaopsDir: string;
  commonInfoExclude: string;
  /**
   * Git's own hooks dir — git-dir state shared by every worktree, never a
   * tracked file. Null under `core.hooksPath`: a hook-manager-owned dir is
   * refused as before.
   */
  gitHooksDir: string | null;
  worktreeStore: string;
  /** Every OTHER worktree of the repository — never a valid target. */
  siblingWorktrees: string[];
}

export async function resolveInvisibleTargets(repoRoot: string): Promise<InvisibleTargets> {
  const repo = new Repo(repoRoot);
  const commonDir = await resolveCommonDir(repoRoot);
  const here = canonical(repoRoot);
  const siblings: string[] = [];
  for (const worktree of await repo.listWorktrees()) {
    const resolved = canonical(worktree.path);
    if (resolved !== here) siblings.push(resolved);
  }
  const hooks = await repo.getHooksDir();
  return {
    commonOrcaopsDir: commonOrcaopsDirFrom(commonDir),
    commonInfoExclude: await repo.getGitPathAbsolute(path.join('info', 'exclude')),
    gitHooksDir: hooks.source === 'git' ? canonical(hooks.dir) : null,
    worktreeStore: path.join(here, '.orcaops'),
    siblingWorktrees: siblings,
  };
}

/**
 * Canonical form of a path that may not exist yet: the deepest existing
 * ancestor is realpath-resolved and the rest re-appended. A plain realpath
 * fails on a planned CREATE and would leave the raw path (`/var/…`) to be
 * compared against canonical roots (`/private/var/…`).
 */
function canonical(target: string): string {
  return resolveCanonicalPath(path.resolve(target), 'personal mutation target');
}

/**
 * Runtime enforcement of the never-touch list: called by init/update/doctor
 * before executing a personal-scope plan. Each changed mutation must resolve
 * under one of the allowed roots, never inside a sibling worktree, and — for
 * a target in this worktree — never onto a tracked file (the git index is an
 * extra guard here, not protection for sibling paths, which are rejected
 * outright). The ONE sanctioned exception is a session-hook STRIP of a
 * lingering orcaops entry (`action:'removed'` — the deliberate scope-agnostic
 * self-clean; see session-hooks.ts). A violation is a planner BUG — throw
 * loudly instead of dirtying a shared repo.
 */
export async function assertInvisiblePlan(
  repoRoot: string,
  mutations: PlannedMutation[],
  sessionHooks: SessionHookFilePlan[]
): Promise<void> {
  const stripPaths = new Set(sessionHooks.filter((p) => p.action === 'removed').map((p) => p.path));
  const targets = await resolveInvisibleTargets(repoRoot);
  const offending: PlannedMutation[] = [];
  const inWorktreeStore: PlannedMutation[] = [];
  for (const m of mutations) {
    if (!m.changed || stripPaths.has(m.path)) continue;
    const abs = canonical(m.absPath);
    // Git-dir targets first: from a linked worktree the common dir sits INSIDE
    // the main checkout, which is itself a sibling here, so the sibling test
    // below would refuse the very files personal scope exists to write.
    if (
      abs === targets.commonInfoExclude ||
      isWithin(abs, targets.commonOrcaopsDir) ||
      (targets.gitHooksDir !== null && isWithin(abs, targets.gitHooksDir))
    ) {
      continue;
    } else if (isWithin(abs, targets.worktreeStore)) {
      inWorktreeStore.push(m);
    } else if (targets.siblingWorktrees.some((sibling) => isWithin(abs, sibling))) {
      offending.push(m);
    } else {
      offending.push(m);
    }
  }
  if (inWorktreeStore.length > 0) {
    let tracked = new Set<string>();
    try {
      tracked = await new Repo(repoRoot).listTrackedPaths(inWorktreeStore.map((m) => m.path));
    } catch {
      // A repo that cannot answer ls-files cannot prove a path untracked either.
      offending.push(...inWorktreeStore);
    }
    offending.push(...inWorktreeStore.filter((m) => tracked.has(m.path)));
  }
  if (offending.length > 0) {
    // Still the invariant — the OrcaopsError shape only makes the refusal
    // render as a clean CLI error instead of a raw stack trace.
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'invisible-install invariant violated: personal scope is unavailable here because ' +
        `applying it would modify tracked path(s): ${offending.map((m) => m.path).join(', ')}. ` +
        'This checkout carries a committed orcaops install; keep it with ' +
        '`orcaops init --scope project`, or remove the committed orcaops files first.'
    );
  }
}

export interface CloudSkillMaterializationPlan {
  /** ONLY the cloud skill files + the two manifest writes. */
  mutations: PlannedMutation[];
  installed: string[];
  refreshed: string[];
  unchanged: string[];
  warnings: string[];
  /** Set when the committed manifest disagrees with config; nothing is planned. */
  refusal?: 'prefix-mismatch' | 'agent-set-mismatch';
}

/**
 * Render only the cloud-gated skills and MERGE their entries into the existing
 * manifests — the narrow plan `login` needs.
 *
 * Merging, not rebuilding: a filtered full plan would leave
 * `install.local.json` describing bytes this run never wrote, breaking the
 * delete guard for every file it skipped. Touches no managed block, slash
 * command, `.gitignore`, prune or global install — a login must not become an
 * update.
 */
export async function planCloudSkillMaterialization(input: {
  repoRoot: string;
  agents: SupportedAgentId[];
  config: Config;
  generatedBy: string;
  prevInstall: InstallManifest;
  prevLocal: LocalManifest | null;
}): Promise<CloudSkillMaterializationPlan> {
  const { repoRoot, config, generatedBy, prevInstall, prevLocal } = input;
  const empty = { mutations: [], installed: [], refreshed: [], unchanged: [], warnings: [] };
  // The adapter-backed subset, which is what the manifest records: comparing
  // the raw config set against it mismatches forever on a stale or hand-edited
  // id — a refusal no `orcaops update` could satisfy.
  const agents = canonicalAgents(input.agents).filter((id) => getToolAdapter(id) !== undefined);

  // Reconciling a repo already out of step with its config is `update`'s job;
  // doing it here would silently rename or re-scope from an auth command.
  if (prevInstall.naming_prefix !== config.naming.prefix) {
    return { ...empty, refusal: 'prefix-mismatch' };
  }
  const recorded = new Set(prevInstall.install_agents);
  const sameAgentSet = recorded.size === agents.length && agents.every((id) => recorded.has(id));
  if (!sameAgentSet) {
    return { ...empty, refusal: 'agent-set-mismatch' };
  }

  const cloudSkills = enabledSkillTemplates(config, { cloud: true }).filter((t) =>
    CLOUD_GATED_SKILL_IDS.has(t.id)
  );
  if (cloudSkills.length === 0) return empty;

  const mutations: PlannedMutation[] = [];
  const planned: PlannedFile[] = [];
  const seen = new Set<string>();
  const installed: string[] = [];
  const refreshed: string[] = [];
  const unchanged: string[] = [];
  for (const id of agents) {
    const adapter = getToolAdapter(id);
    if (!adapter) continue;
    const genPlan = await planGenerateForTool({
      repoRoot,
      adapter,
      generatedBy,
      prefix: config.naming.prefix,
      skills: cloudSkills,
      // Explicit: the generator defaults to the full command registry, and a
      // login has no business rewriting slash commands.
      commands: [],
    });
    for (const pf of genPlan.files) {
      if (seen.has(pf.path)) continue;
      seen.add(pf.path);
      planned.push(pf);
      mutations.push(fileMutation(repoRoot, pf));
      if (pf.action === 'create') installed.push(pf.path);
      else if (pf.action === 'replace') refreshed.push(pf.path);
      else unchanged.push(pf.path);
    }
  }

  // Merge at the planner's own ordering, so the result is byte-identical to
  // what a credentialed `update` would have written.
  const adapters = agents.map(getToolAdapter).filter((a): a is ToolAdapter => Boolean(a));
  const order = generatedFileOrder(adapters, config, config.naming.prefix);
  const rank = (p: string): number => order.get(p) ?? Number.MAX_SAFE_INTEGER;
  const havePaths = new Set(prevInstall.entries.map((e) => e.path));

  const install: InstallManifest = { ...prevInstall, entries: [...prevInstall.entries] };
  const generatedCount = install.entries.filter((e) => e.kind === 'generated-file').length;
  const added = planned
    .map((pf) => toPortableManifestPath(pf.path))
    .filter((p) => !havePaths.has(p))
    .map((path) => ({ kind: 'generated-file' as const, path }));
  const generated = [...install.entries.slice(0, generatedCount), ...added].sort(
    (a, b) => rank(a.path) - rank(b.path)
  );
  install.entries = [...generated, ...install.entries.slice(generatedCount)];

  const warnings: string[] = [];
  let local: LocalManifest | null = null;
  if (prevLocal) {
    const byPath = new Map(planned.map((pf) => [toPortableManifestPath(pf.path), pf]));
    const kept = prevLocal.entries.filter(
      (e) => !(e.kind === 'generated-file' && byPath.has(e.path))
    );
    const localGenerated = install.entries
      .filter((e) => e.kind === 'generated-file')
      .map((e) => {
        const pf = byPath.get(e.path);
        // Untouched entries keep their prior hash, which still describes disk.
        return pf
          ? localEntryFromPlannedFile(pf)
          : kept.find((k) => k.kind === 'generated-file' && k.path === e.path);
      })
      .filter((e): e is LocalEntry => Boolean(e));
    local = {
      ...prevLocal,
      entries: [...localGenerated, ...kept.filter((e) => e.kind !== 'generated-file')],
    };
  } else {
    // Reconstructing needs the full planned file set, which is the plan this
    // function exists to avoid; the prune's fallback already covers ownership.
    warnings.push('install.local.json is absent — skipped its update');
  }

  const prevInstallJson = `${JSON.stringify(prevInstall, null, 2)}\n`;
  const installJson = `${JSON.stringify(install, null, 2)}\n`;
  mutations.push(
    writeMutation(
      repoRoot,
      INSTALL_MANIFEST_REL,
      installJson,
      prevInstallJson,
      installJson !== prevInstallJson
    )
  );
  if (local && prevLocal) {
    const prevLocalJson = `${JSON.stringify(prevLocal, null, 2)}\n`;
    const localJson = `${JSON.stringify(local, null, 2)}\n`;
    mutations.push(
      writeMutation(
        repoRoot,
        LOCAL_MANIFEST_REL,
        localJson,
        prevLocalJson,
        localJson !== prevLocalJson
      )
    );
  }
  return { mutations, installed, refreshed, unchanged, warnings };
}

export interface PlanInstallManifestsInput {
  repoRoot: string;
  /** The resolved adapters for this run, in the order generation walked them. */
  adapters: ToolAdapter[];
  installAgents: SupportedAgentId[];
  config: Config;
  gates: SkillGates;
  scope: 'project' | 'global' | 'personal';
  /** The running CLI version — the stamp a preserved entry is classified against. */
  currentVersion: string;
  genFiles: PlannedFile[];
  instructionPlacements: InstructionPlacement[];
  gitignoreLines: string[];
  /** Personal-scope info/exclude lines the manifest records (absent otherwise). */
  infoExcludeLines?: string[];
  prevInstall: InstallManifest | null;
  prevLocal: LocalManifest | null;
}

/**
 * The ONE place the two-layer manifest is built. It resolves what the cloud gate
 * is withholding on this machine and hands it to `buildManifests` as a
 * first-class input, so the committed ownership record and the per-machine
 * delete guard are always produced together.
 *
 * Every writer of `install.json` goes through here — `planInstallMutations`
 * (init / update / doctor --fix / post-login) and `link`. Calling
 * `buildManifests` directly is what let `link` silently drop the cloud entries.
 */
export async function planInstallManifests(input: PlanInstallManifestsInput): Promise<{
  install: InstallManifest;
  local: LocalManifest;
  preserved: PreservedGeneratedFile[];
}> {
  const preservation = await resolveCloudPreservation({
    repoRoot: input.repoRoot,
    adapters: input.adapters,
    config: input.config,
    gates: input.gates,
    scope: input.scope,
    currentVersion: input.currentVersion,
    genFiles: input.genFiles,
    prevInstall: input.prevInstall,
    prevLocal: input.prevLocal,
  });
  const { install, local } = buildManifests({
    repoRoot: input.repoRoot,
    installAgents: input.installAgents,
    files: input.genFiles,
    instructionPlacements: input.instructionPlacements,
    gitignoreLines: input.gitignoreLines,
    infoExcludeLines: input.infoExcludeLines,
    namingPrefix: input.config.naming.prefix,
    preserved: preservation ?? undefined,
  });
  return { install, local, preserved: preservation?.files ?? [] };
}
