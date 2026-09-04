import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  COMMAND_TEMPLATES,
  extractStamp,
  getToolAdapter,
  isVersionAhead,
  opencodeSessionPluginPath,
  planInjectOrcaopsSection,
  readOrcaopsSectionStampVersions,
  renderOpencodeSessionPlugin,
  renderOrcaopsAgentsMdSection,
  resolveHintLines,
} from '@orcaops/adapters';
import { assertCanonicalRelativePath, type Config, type SupportedAgentId } from '@orcaops/storage';

import { reconcileInfoExclude } from './git-info-exclude.js';
import { readInstallManifest, toPortableManifestPath } from './install-manifest.js';
import { readRepositoryRegularFileOrNull, repositoryRegularFileExists } from './mutations.js';
import { desiredPersonalExcludeLines } from './personal-manifest.js';
import { planSessionHookSettings } from './session-hooks.js';
import { CLOUD_GATED_SKILL_IDS, enabledSkillTemplates, type SkillGates } from './skill-set.js';

/** Stale-install signal split by surface (drift nudge). */
export interface InstallDrift {
  /** Repo-relative skill files that are missing, version-stale, or body-drifted at the same version. */
  staleSkills: string[];
  /** Repo-relative command files that are missing, version-stale, or body-drifted at the same version. */
  staleCommands: string[];
  /**
   * Repo-relative instruction files whose managed block is missing, or whose
   * body differs from the current render — including at an UNCHANGED CLI
   * version, the same-version refresh gap `classifyGeneratedFile` closes for
   * skills and commands. ALWAYS empty under bootstrap=manual — the user owns
   * the block there.
   */
  staleBlock: string[];
  /**
   * Session-hook surfaces needing reconciliation: settings files whose
   * orcaops entry is missing/out-of-date (or lingering while disabled), plus
   * the OpenCode plugin when not `current`. Routed through the SAME planner
   * `init`/`update` use (planSessionHookSettings), so the nudge and the fix
   * can never disagree. Entries are version-free, so this fires only when
   * the entry SHAPE changes — no per-release nag.
   */
  staleSessionHooks: string[];
  /**
   * The info/exclude path when the managed section needs reconciling —
   * a personal footprint left visible, or a stale section after a scope
   * switch. Same shared-reconciler principle as the surfaces above.
   */
  staleInfoExclude: string[];
  /** Surfaces stamped NEWER than this CLI — the remedy is upgrading orcaops. */
  aheadSkills: string[];
  aheadCommands: string[];
  aheadBlock: string[];
  /**
   * Current-version files with no verifiable content fingerprint. Plain
   * `update` preserves them, so they are never listed as update-fixable —
   * the remedy is manual inspection or `update --force`.
   */
  unverifiableSkills: string[];
  unverifiableCommands: string[];
}

/**
 * Read the orcaops version stamp out of a generated skill/command file, or null
 * if the file is absent. Returns `''` when the file exists but carries no stamp.
 * Shared between doctor's `checkAgentSkills` and the drift nudge so they can never
 * disagree on what "stale" means.
 */
export async function readGeneratedByStamp(
  absPath: string,
  repoRoot: string
): Promise<string | null> {
  const raw = await readRepositoryRegularFileOrNull(absPath, repoRoot, 'generated install file');
  if (raw === null) return null;
  const m = raw.match(/generatedBy:\s*"orcaops@([^"\n]+)"/);
  return m ? m[1] : '';
}

/** How an installed generated file compares to the CLI's pristine render. */
export interface GeneratedFileClass {
  status: 'missing' | 'ahead-version' | 'stale-version' | 'stale-body' | 'unverifiable' | 'current';
  /** Version captured from the installed stamp (`''` when unstamped, null when the file is absent). */
  stampedVersion: string | null;
}

/**
 * Classify an installed generated file against the CLI's freshly rendered
 * content. `ahead-version` is a stamp semver-NEWER than the running CLI (this
 * CLI is behind the repo — the fix is upgrading orcaops, and the write paths
 * preserve the file); `stale-version` is the classic older-stamp (or unstamped)
 * case; `stale-body` is a content fingerprint that differs from the current
 * render — a template body change shipped at an UNCHANGED CLI version,
 * invisible to version-only comparison (the same-version refresh gap);
 * `unverifiable` is a current-version stamp with NO content fingerprint —
 * plain `update` preserves such a file, so its remedy is manual inspection or
 * `update --force`, never a bare update nudge. A user-edited file keeps its
 * recorded generation stamp, so it classifies `current` — respected, never
 * nudged. Shared between doctor's `checkAgentSkills` and the drift nudge so
 * they can never disagree on what "stale" means.
 */
export async function classifyGeneratedFile(
  absPath: string,
  desired: string,
  currentVersion: string,
  repoRoot: string
): Promise<GeneratedFileClass> {
  const raw = await readRepositoryRegularFileOrNull(absPath, repoRoot, 'generated install file');
  if (raw === null) return { status: 'missing', stampedVersion: null };
  const got = extractStamp(raw);
  const stampedVersion = got.version ?? '';
  // Unparseable stamps are never ahead, so they fall through to stale-version.
  if (isVersionAhead(got.version, currentVersion)) {
    return { status: 'ahead-version', stampedVersion };
  }
  if (got.version !== currentVersion) return { status: 'stale-version', stampedVersion };
  if (got.fingerprint === null) return { status: 'unverifiable', stampedVersion };
  const want = extractStamp(desired);
  if (got.fingerprint !== want.fingerprint) {
    return { status: 'stale-body', stampedVersion };
  }
  return { status: 'current', stampedVersion };
}

/**
 * Detect whether the installed skills / commands / instruction block are stale vs
 * the running CLI. Callers that treat the nudge as best-effort catch inspection
 * failures at their command boundary. Returns `null` when there is nothing to
 * nudge about — a fresh, current install, `agent="other"`, or no registered adapter.
 *
 * The block surface is skipped entirely under `bootstrap:"manual"` (the user
 * manages it), so only skill/command staleness can fire there — matching the
 * doctor checks, which suppress the agents-md warning under manual but keep
 * checking skills/commands.
 */
/**
 * The instruction files orcaops manages for this install. Personal scope
 * manages none; every other scope unions the install set's adapter agentsFiles.
 */
export function resolveManagedInstructionFiles(config: Config): string[] {
  if (config.install.scope === 'personal') return [];
  return [...new Set(config.install.agents.flatMap((id) => getToolAdapter(id)?.agentsFiles ?? []))];
}

export async function detectInstallDrift(
  repoRoot: string,
  config: Config,
  currentVersion: string,
  gates: SkillGates
): Promise<InstallDrift | null> {
  if (config.install.agents.length === 0) return null;
  const prefix = config.naming.prefix;
  // Under global AND personal scope the skills/commands live in the per-user
  // GLOBAL dirs, not the repo (matching install-plan and doctor) —
  // classifying project paths would false-report every enabled skill as
  // missing and nudge an update that writes none of them. Block staleness
  // (below) is the only project-side drift surface for those scopes.
  const projectTrees = config.install.scope === 'project';

  // Aggregate across the install set, deduping by path (every agent shares
  // AGENTS.md, and codex/cursor/opencode share the universal `.agents/skills`
  // dir). A Set keeps each stale surface listed once.
  const staleSkills = new Set<string>();
  const staleCommands = new Set<string>();
  const aheadSkills = new Set<string>();
  const aheadCommands = new Set<string>();
  const unverifiableSkills = new Set<string>();
  const unverifiableCommands = new Set<string>();
  const instructionFiles = new Set<string>();
  // Only ENABLED skills are expected on disk — a disabled skill's
  // absence is correct, not drift (its lingering presence is the doctor's
  // skill-drift concern, not a staleness nudge).
  const expectedSkills = enabledSkillTemplates(config, gates);
  for (const id of config.install.agents) {
    const adapter = getToolAdapter(id);
    if (!adapter) continue;
    if (adapter.skills && projectTrees) {
      for (const skill of expectedSkills) {
        const rel = adapter.skills.filePath(skill.id, prefix);
        const desired = adapter.skills.format(skill, { generatedBy: currentVersion, prefix });
        const cls = await classifyGeneratedFile(
          path.join(repoRoot, rel),
          desired,
          currentVersion,
          repoRoot
        );
        if (cls.status === 'ahead-version') aheadSkills.add(rel);
        else if (cls.status === 'unverifiable') unverifiableSkills.add(rel);
        else if (cls.status !== 'current') staleSkills.add(rel);
      }
    }
    if (adapter.commands && projectTrees) {
      for (const cmd of COMMAND_TEMPLATES) {
        const rel = adapter.commands.filePath(cmd.id, prefix);
        const desired = adapter.commands.format(cmd, { generatedBy: currentVersion, prefix });
        const cls = await classifyGeneratedFile(
          path.join(repoRoot, rel),
          desired,
          currentVersion,
          repoRoot
        );
        if (cls.status === 'ahead-version') aheadCommands.add(rel);
        else if (cls.status === 'unverifiable') unverifiableCommands.add(rel);
        else if (cls.status !== 'current') staleCommands.add(rel);
      }
    }
    if (adapter.agentsFiles) for (const rel of adapter.agentsFiles) instructionFiles.add(rel);
  }
  // Block staleness reads the scope's managed instruction files — none
  // under personal.
  if (config.install.scope === 'personal') {
    instructionFiles.clear();
    for (const rel of resolveManagedInstructionFiles(config)) instructionFiles.add(rel);
  }

  // Block staleness is suppressed under bootstrap=manual; skill/command staleness
  // still nudges (those stay managed regardless). Check the deduped union once.
  //
  // Compared by CONTENT, not by the marker's version stamp. A template body
  // change ships at an unchanged CLI version routinely — the same-version
  // refresh gap `classifyGeneratedFile` exists to close for skills and
  // commands — and a stamp compare is blind to it, so every already-installed
  // block would keep the superseded body with nothing reporting it. Planning
  // the injection is precisely what `update` does to decide whether to
  // rewrite, so routing both through `planInjectOrcaopsSection` makes it
  // impossible for the nudge and the fix to disagree about what stale means.
  const staleBlock: string[] = [];
  const aheadBlock: string[] = [];
  if (config.bootstrap !== 'manual') {
    const desiredBlock = renderOrcaopsAgentsMdSection({
      generatedBy: currentVersion,
      prefix,
      hints: resolveHintLines(config.workflow.hints),
      enabledSkills: expectedSkills,
    });
    for (const rel of instructionFiles) {
      const abs = path.join(repoRoot, rel);
      // The non-canonical instruction file is a symlink twin of the canonical
      // (AGENTS.md ⇄ CLAUDE.md). A resolving twin is healthy — the canonical
      // entry carries the block check — while a DANGLING twin is a missing
      // managed file. Only regular files run the block-content comparison.
      let isLink = false;
      try {
        isLink = (await lstat(abs)).isSymbolicLink();
      } catch {
        // Absent entirely: planInjectOrcaopsSection reports it as 'created'.
      }
      if (isLink) {
        try {
          await stat(abs);
        } catch {
          staleBlock.push(rel);
        }
        continue;
      }
      try {
        // Ahead resolves before stale: an ahead block's remedy is upgrading
        // orcaops, and `update` preserves it — a stale nudge would be a no-op.
        // Stamps are read directly (malformed layouts included), so injection
        // preserves a malformed AHEAD block too.
        const stamps = await readOrcaopsSectionStampVersions(abs, repoRoot);
        if (stamps.some((v) => isVersionAhead(v, currentVersion))) {
          aheadBlock.push(rel);
          continue;
        }
        const plan = await planInjectOrcaopsSection({
          filePath: abs,
          containmentRoot: repoRoot,
          desiredBlock,
        });
        // 'unchanged' is the only non-stale outcome: 'created' means the file
        // is absent, 'inserted' means it carries no managed block yet, and
        // 'replaced' means the block body moved.
        if (plan.action !== 'unchanged') staleBlock.push(rel);
      } catch {
        // Exists but cannot carry a healthy block (a directory, a refused
        // path): stale — repair or the preserve-with-warning path decides.
        staleBlock.push(rel);
      }
    }
  }

  // Session-hook surfaces. Same shared-planner principle as the block: any
  // A preserved invalid-JSON file needs manual repair, not update. Every
  // other actionable plan result is drift because init/update would change it.
  // The scope-aware planner runs under every scope (install project-only,
  // strip everywhere), so a lingering entry after a scope switch nudges here
  // exactly like doctor warns about it. The plugin-file surface (OpenCode,
  // install project-only) classifies like any generated file.
  const staleSessionHooks: string[] = [];
  try {
    const hookPlan = await planSessionHookSettings({
      repoRoot,
      agents: config.install.agents,
      enabled: config.session_hooks.enabled,
      scope: config.install.scope,
      entries: config.session_hooks.entries,
    });
    for (const p of hookPlan.plans) {
      if (
        p.action !== 'unchanged' &&
        p.action !== 'skipped-scope' &&
        p.action !== 'skipped-entries' &&
        p.action !== 'preserved-invalid-json'
      ) {
        staleSessionHooks.push(p.path);
      }
    }
    if (
      config.session_hooks.enabled &&
      config.install.scope === 'project' &&
      config.install.agents.includes('opencode')
    ) {
      const rel = opencodeSessionPluginPath(prefix);
      const cls = await classifyGeneratedFile(
        path.join(repoRoot, rel),
        renderOpencodeSessionPlugin({ generatedBy: currentVersion }),
        currentVersion,
        repoRoot
      );
      // Ahead and unverifiable plugins are preserved by plain `update` (the
      // plugin rides the normal generated-file pipeline), so neither is
      // update-fixable drift; doctor's session-hooks check still reports them.
      if (
        cls.status !== 'current' &&
        cls.status !== 'ahead-version' &&
        cls.status !== 'unverifiable'
      ) {
        staleSessionHooks.push(rel);
      }
    }
  } catch {
    // best-effort by contract
  }

  // info/exclude — the invisible footprint's hiding mechanism. A pending
  // reconcile (personal add or scope-exit strip) is drift like any other
  // surface; same shared reconciler as the writers and doctor.
  const staleInfoExclude: string[] = [];
  try {
    const excludePlan = await reconcileInfoExclude(
      repoRoot,
      await desiredPersonalExcludeLines(repoRoot, config.install.scope)
    );
    if (excludePlan.desiredContent !== null) {
      staleInfoExclude.push(path.relative(repoRoot, excludePlan.excludePath));
    }
  } catch {
    // best-effort by contract
  }

  if (
    staleSkills.size === 0 &&
    staleCommands.size === 0 &&
    staleBlock.length === 0 &&
    staleSessionHooks.length === 0 &&
    staleInfoExclude.length === 0 &&
    aheadSkills.size === 0 &&
    aheadCommands.size === 0 &&
    aheadBlock.length === 0 &&
    unverifiableSkills.size === 0 &&
    unverifiableCommands.size === 0
  ) {
    return null;
  }
  return {
    staleSkills: [...staleSkills],
    staleCommands: [...staleCommands],
    staleBlock,
    staleSessionHooks,
    staleInfoExclude,
    aheadSkills: [...aheadSkills],
    aheadCommands: [...aheadCommands],
    aheadBlock,
    unverifiableSkills: [...unverifiableSkills],
    unverifiableCommands: [...unverifiableCommands],
  };
}

export interface InstallIncompleteness {
  reason: 'fresh-clone-uncommitted-trees';
  /** Repo-relative committed generated files that are absent on disk. */
  missing: string[];
}

/**
 * First-run signal: a committed `install.json` declares generated files
 * (project skills/commands) that are ABSENT on disk — the fresh-clone case under
 * `generated_files:"ignore"` (the trees are gitignored, so a teammate's checkout
 * lacks them). Returns null when there's nothing to materialize (no committed
 * manifest, no generated-file entries, or all present — e.g. commit mode or global
 * scope). The bare-command caller keeps this advisory best-effort.
 *
 * Gate-aware: the preservation keeps cloud entries in the committed manifest on
 * a machine that cannot generate them, so counting them makes the nudge
 * permanent and its remedy unable to clear it — and in CI, a full update on
 * every bare invocation.
 *
 * Paths come from the MANIFEST alone, never `Config`: loading config here would
 * run its migration writeback on a path that fires on every bare command.
 */
export async function detectInstallIncompleteness(
  repoRoot: string,
  gates: SkillGates
): Promise<InstallIncompleteness | null> {
  const install = await readInstallManifest(repoRoot);
  if (!install) return null;
  let gen = install.entries.filter((e) => e.kind === 'generated-file');
  if (!gates.cloud) {
    const withheld = new Set<string>();
    for (const agentId of install.install_agents) {
      const adapter = getToolAdapter(agentId as SupportedAgentId);
      if (!adapter?.skills) continue;
      for (const id of CLOUD_GATED_SKILL_IDS) {
        withheld.add(toPortableManifestPath(adapter.skills.filePath(id, install.naming_prefix)));
      }
    }
    gen = gen.filter((e) => !withheld.has(e.path));
  }
  if (gen.length === 0) return null;
  const missing: string[] = [];
  for (const e of gen) {
    assertCanonicalRelativePath(e.path, 'generated install entry path');
    if (
      !(await repositoryRegularFileExists(
        path.join(repoRoot, e.path),
        repoRoot,
        `generated install entry ${e.path}`
      ))
    ) {
      missing.push(e.path);
    }
  }
  return missing.length > 0 ? { reason: 'fresh-clone-uncommitted-trees', missing } : null;
}

/** A one-line advisory for a non-null incompleteness result. */
export function formatIncompletenessNudge(inc: InstallIncompleteness): string {
  return (
    `Tip: orcaops skills aren't materialized in this checkout (${inc.missing.length} missing) — ` +
    'run `orcaops update` to generate them locally.'
  );
}

/** A one-or-two-line advisory for a non-null drift result. */
export function formatDriftNudge(drift: InstallDrift): string {
  const lines: string[] = [];
  const parts: string[] = [];
  if (drift.staleSkills.length > 0) parts.push(`${drift.staleSkills.length} skill(s)`);
  if (drift.staleCommands.length > 0) parts.push(`${drift.staleCommands.length} command(s)`);
  if (drift.staleBlock.length > 0) parts.push(`${drift.staleBlock.length} instruction file(s)`);
  if (drift.staleSessionHooks.length > 0) {
    parts.push(`${drift.staleSessionHooks.length} session-hook surface(s)`);
  }
  if (drift.staleInfoExclude.length > 0) parts.push('the info/exclude section');
  if (parts.length > 0) {
    lines.push(
      `Tip: orcaops install is out of date (${parts.join(', ')}) — ` +
        'run `orcaops update` (or `orcaops doctor --fix`).'
    );
  }
  const ahead = drift.aheadSkills.length + drift.aheadCommands.length + drift.aheadBlock.length;
  if (ahead > 0) {
    lines.push(
      `Tip: ${ahead} orcaops file(s) here were generated by a NEWER orcaops than this CLI — ` +
        'upgrade orcaops; `orcaops update` will not downgrade them.'
    );
  }
  const unverifiable = drift.unverifiableSkills.length + drift.unverifiableCommands.length;
  if (unverifiable > 0) {
    lines.push(
      `Tip: ${unverifiable} orcaops file(s) carry this CLI's version but no content fingerprint — ` +
        '`orcaops update` preserves them; inspect them or run `orcaops update --force` to regenerate.'
    );
  }
  return lines.join('\n');
}
