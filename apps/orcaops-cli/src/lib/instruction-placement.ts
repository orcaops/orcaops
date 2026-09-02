import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import {
  isVersionAhead,
  planInjectOrcaopsSection,
  planRemoveOrcaopsSection,
  readOrcaopsSectionStampVersions,
  renderOrcaopsAgentsMdSection,
  type SkillTemplate,
  type StampDivergence,
} from '@orcaops/adapters';
import { assertCanonicalRelativePath, assertResolvedWithin } from '@orcaops/storage';

import {
  deleteMutation,
  injectMutation,
  type PlannedMutation,
  symlinkMutation,
} from './mutations.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * Canonical instruction file + opportunistic symlink.
 *
 * Injecting the SAME managed block into EVERY instruction file an agent
 * declares (claude-code → both `AGENTS.md` AND `CLAUDE.md`) would give two
 * independently-editable sources of truth that drift. Instead, this resolver
 * picks ONE canonical file, symlinks the rest to it when that is provably
 * lossless, and falls back to dual-maintaining the block in each file only
 * when two real files already exist and DIFFER.
 *
 * It is the dedicated orcaops file-link helper — it never calls the vendored
 * `createSymlink` (which `rm`s conflicts). A collapse is a
 * guarded `delete` (only of an absent / already-correct-symlink / byte-identical
 * secondary) followed by a `symlink`, both emitted as `PlannedMutation`s so
 * `--dry-run` previews them and the executor's non-destructive `fs.symlink` seam
 * does the work.
 */

export type InstructionFileAction =
  | 'created'
  | 'inserted'
  | 'replaced'
  | 'unchanged'
  | 'symlinked'
  | 'removed';

export interface InstructionFileResult {
  path: string;
  action: InstructionFileAction;
  /** Stamp-divergence signal copied from the inject plan (ahead guard / forced downgrade). */
  reason?: StampDivergence;
  /** The newer on-disk `v=` stamp that triggered `reason`. */
  stampedVersion?: string;
}

/**
 * One instruction file's ownership + per-machine materialization, fed to the
 * install manifest. The COMMITTED `install.json` records EVERY entry as
 * an injected-block (so it is byte-identical whether this machine symlinked or
 * dual-wrote); `materialization` / `symlinkTarget` live only in the gitignored
 * `install.local.json`.
 */
export interface InstructionPlacement {
  path: string;
  materialization: 'block' | 'symlink';
  /** Expected managed-block hash — set for materialization 'block'. */
  blockHash?: string;
  /** Relative symlink target — set for materialization 'symlink'. */
  symlinkTarget?: string;
  /**
   * Set when the on-disk block diverged from `blockHash` by version skew —
   * manifest construction must not record a preserved-ahead block as
   * CLI-created state.
   */
  reason?: StampDivergence;
}

export interface ResolveInstructionPlacementInput {
  repoRoot: string;
  /** Repo-relative instruction files (deduped union across install agents). */
  instructionFiles: string[];
  /** Version stamped into the managed block. */
  generatedBy: string;
  /** Skill naming prefix threaded into the managed block (default orcaops). */
  prefix?: string;
  /** Resolved workflow-preference lines rendered into the block. */
  hints?: string[];
  /**
   * The enabled skill set — the block body is assembled from it.
   * Omitted ⇒ every shipped template.
   */
  enabledSkills?: ReadonlyArray<SkillTemplate>;
  /** Re-inject even when the stamp matches (e.g. `update --force`). */
  force?: boolean;
  /** Allow replacing a block stamped NEWER than `generatedBy` (`update --force` only). */
  overrideAhead?: boolean;
  /**
   * `'safe'` (init/update) dual-maintains two divergent real files; `'force-collapse'`
   * (`orcaops link --yes`) collapses them onto the canonical, dropping the secondary.
   */
  mode?: 'safe' | 'force-collapse';
  /** Explicit canonical override (`orcaops link --canonical <file>`). */
  canonical?: string;
}

export interface InstructionPlacementResult {
  mutations: PlannedMutation[];
  placements: InstructionPlacement[];
  results: InstructionFileResult[];
  warnings: string[];
  /** The chosen canonical file; `''` when there are no files or none can hold a block. */
  canonical: string;
}

type Snapshot =
  | { rel: string; absPath: string; kind: 'absent' }
  | { rel: string; absPath: string; kind: 'symlink'; target: string }
  | { rel: string; absPath: string; kind: 'non-file' }
  | { rel: string; absPath: string; kind: 'regular'; content: string };

/**
 * Classify an instruction file via `lstat` (NOT `readFile`) so an already-correct
 * symlink is recognized (idempotent re-runs) and only plain files count as "real".
 */
async function snapshotFile(repoRoot: string, rel: string): Promise<Snapshot> {
  assertCanonicalRelativePath(rel, 'instruction file path');
  const absPath = path.join(repoRoot, rel);
  const parent = assertResolvedWithin(
    path.dirname(absPath),
    repoRoot,
    `instruction file ${rel} parent`,
    { allowRoot: true, rejectSymlinks: true }
  );
  const safeEntryPath = path.join(parent, path.basename(absPath));
  let st;
  try {
    st = await lstat(safeEntryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rel, absPath, kind: 'absent' };
    throw err;
  }
  if (st.isSymbolicLink()) {
    return { rel, absPath, kind: 'symlink', target: await readlink(safeEntryPath) };
  }
  if (!st.isFile()) return { rel, absPath, kind: 'non-file' };
  const safeReadPath = assertResolvedWithin(absPath, repoRoot, `instruction file ${rel}`, {
    rejectSymlinks: true,
  });
  return { rel, absPath, kind: 'regular', content: await readFile(safeReadPath, 'utf8') };
}

/** Prefer `AGENTS.md` as canonical (the universal name) when it is a candidate. */
function preferCanonical(candidates: string[]): string {
  return candidates.includes('AGENTS.md') ? 'AGENTS.md' : candidates[0];
}

/**
 * Resolve where the managed block lives across an agent's instruction files,
 * emitting the mutations (inject / guarded-delete / symlink) and the manifest
 * placements. Snapshots ALL files first, then makes one atomic decision — never
 * creates a missing file before evaluating the matrix (which would flip "only
 * CLAUDE.md exists" into "two divergent files").
 */
export async function resolveInstructionPlacement(
  input: ResolveInstructionPlacementInput
): Promise<InstructionPlacementResult> {
  const { repoRoot, force, generatedBy } = input;
  const mode = input.mode ?? 'safe';
  const files = [...new Set(input.instructionFiles)];

  const empty: InstructionPlacementResult = {
    mutations: [],
    placements: [],
    results: [],
    warnings: [],
    canonical: '',
  };
  if (files.length === 0) return empty;

  const snaps = await Promise.all(files.map((rel) => snapshotFile(repoRoot, rel)));
  const byRel = new Map(snaps.map((s) => [s.rel, s]));
  const regulars = snaps.filter(
    (s): s is Extract<Snapshot, { kind: 'regular' }> => s.kind === 'regular'
  );
  const canonicalCandidates = snaps.filter(
    (s): s is Extract<Snapshot, { kind: 'regular' | 'absent' }> =>
      s.kind === 'regular' || s.kind === 'absent'
  );
  const realCount = regulars.length;
  const allIdentical = realCount >= 2 && regulars.every((r) => r.content === regulars[0].content);
  // Two real files that DIFFER are dual-maintained in 'safe' mode (never collapsed
  // — that would drop the secondary's unique content); 'force-collapse' overrides.
  const dualMaintain = realCount >= 2 && !allIdentical && mode === 'safe';

  const mutations: PlannedMutation[] = [];
  const placements: InstructionPlacement[] = [];
  const results: InstructionFileResult[] = [];
  const warnings = snaps
    .filter((snap) => snap.kind === 'non-file')
    .map((snap) => `${snap.rel} is not a regular file; preserving it unchanged.`);

  if (canonicalCandidates.length === 0) {
    results.push(...snaps.map((snap) => ({ path: snap.rel, action: 'unchanged' as const })));
    if (snaps.some((snap) => snap.kind === 'symlink')) {
      warnings.push(
        'No regular or missing instruction file is available; preserving existing links unchanged.'
      );
    }
    return { mutations, placements, results, warnings, canonical: '' };
  }

  let canonical: string;
  if (input.canonical && canonicalCandidates.some((snap) => snap.rel === input.canonical)) {
    canonical = input.canonical;
  } else if (realCount === 0) {
    canonical = preferCanonical(canonicalCandidates.map((snap) => snap.rel));
  } else if (realCount === 1) {
    canonical = regulars[0].rel;
  } else {
    canonical = preferCanonical(regulars.map((r) => r.rel));
  }
  if (input.canonical && files.includes(input.canonical) && input.canonical !== canonical) {
    warnings.push(
      `${input.canonical} cannot hold a managed instruction block; using ${canonical} instead.`
    );
  }
  const canonAbs = path.join(repoRoot, canonical);

  if (mode === 'safe') {
    const foreignLinks = snaps.filter(
      (snap): snap is Extract<Snapshot, { kind: 'symlink' }> =>
        snap.kind === 'symlink' &&
        snap.target !== path.relative(path.dirname(snap.absPath), canonAbs)
    );
    if (foreignLinks.length > 0) {
      const details = foreignLinks.map((snap) => `${snap.rel} -> "${snap.target}"`).join(', ');
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Refusing to replace foreign instruction symlink(s): ${details}. ` +
          `Run \`orcaops link --yes\` to explicitly collapse instruction files onto ${canonical}.`,
        foreignLinks[0].rel
      );
    }
  }

  // Render the managed block ONCE (the caller holds config — prefix/hints) and pass
  // it to each planner; the planner stitches the given block rather than re-render.
  const desiredBlock = renderOrcaopsAgentsMdSection({
    generatedBy,
    prefix: input.prefix,
    hints: input.hints,
    enabledSkills: input.enabledSkills,
  });

  const repairMalformed = mode === 'force-collapse' || force === true;
  const regularPlans = new Map<string, Awaited<ReturnType<typeof planInjectOrcaopsSection>>>();
  for (const snap of regulars) {
    const plan = await planInjectOrcaopsSection({
      filePath: snap.absPath,
      containmentRoot: repoRoot,
      desiredBlock,
      force,
      repairMalformed,
      overrideAhead: input.overrideAhead,
    });
    regularPlans.set(snap.rel, plan);
    // A malformed block stamped NEWER than this CLI is preserved and reported
    // ahead instead of refused: advising a destructive repair would target
    // state a newer orcaops wrote. The upgrade advice supersedes the repair.
    if (plan.malformed && plan.reason !== 'preserved-ahead' && !repairMalformed) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Refusing to rewrite ${snap.rel}: its orcaops managed-block markers are malformed or ` +
          `ambiguous. Repair the file manually or rerun with an explicit destructive option.`,
        snap.rel
      );
    }
  }

  // The canonical always carries the managed block.
  const canonPlan =
    regularPlans.get(canonical) ??
    (await planInjectOrcaopsSection({
      filePath: canonAbs,
      containmentRoot: repoRoot,
      desiredBlock,
      force,
      repairMalformed,
      overrideAhead: input.overrideAhead,
    }));
  mutations.push(injectMutation(repoRoot, canonPlan));
  placements.push({
    path: canonical,
    materialization: 'block',
    blockHash: canonPlan.blockHash,
    reason: canonPlan.reason,
  });
  results.push({
    path: canonical,
    action: canonPlan.action,
    reason: canonPlan.reason,
    stampedVersion: canonPlan.onDiskVersion,
  });

  for (const rel of files) {
    if (rel === canonical) continue;
    const snap = byRel.get(rel)!;

    if (snap.kind === 'non-file') {
      results.push({ path: rel, action: 'unchanged' });
      continue;
    }

    if (dualMaintain && snap.kind === 'regular') {
      // Divergent real secondary → keep its own managed block; never delete/symlink.
      const plan = regularPlans.get(rel)!;
      mutations.push(injectMutation(repoRoot, plan));
      placements.push({
        path: rel,
        materialization: 'block',
        blockHash: plan.blockHash,
        reason: plan.reason,
      });
      results.push({
        path: rel,
        action: plan.action,
        reason: plan.reason,
        stampedVersion: plan.onDiskVersion,
      });
      continue;
    }

    if (snap.kind === 'regular') {
      // An ahead-stamped secondary is never deleted into a symlink without the
      // downgrade override — collapse (identical-content or `link --yes`)
      // would destroy state a newer orcaops wrote. Keep its own block.
      const plan = regularPlans.get(rel)!;
      if (plan.reason === 'preserved-ahead') {
        mutations.push(injectMutation(repoRoot, plan));
        placements.push({
          path: rel,
          materialization: 'block',
          blockHash: plan.blockHash,
          reason: plan.reason,
        });
        results.push({
          path: rel,
          action: plan.action,
          reason: plan.reason,
          stampedVersion: plan.onDiskVersion,
        });
        warnings.push(
          `${rel} holds an orcaops block stamped @${plan.onDiskVersion ?? 'unknown'} — newer than ` +
            `this CLI; preserving the file instead of collapsing it (upgrade orcaops, or ` +
            '`orcaops update --force` to deliberately downgrade).'
        );
        continue;
      }
    }

    // Collapse: symlink rel → canonical.
    const symlinkTarget = path.relative(path.dirname(snap.absPath), canonAbs);
    let changed = true;
    if (snap.kind === 'symlink' && snap.target === symlinkTarget) {
      changed = false; // already the correct symlink → idempotent no-op
    } else if (snap.kind === 'regular' || snap.kind === 'symlink') {
      // A real file (byte-identical / link --yes) or an explicitly-collapsed
      // wrong-target symlink must be removed before fs.symlink, which refuses EEXIST.
      mutations.push(
        deleteMutation(
          repoRoot,
          rel,
          snap.kind === 'regular'
            ? { kind: 'file', content: snap.content }
            : { kind: 'symlink', target: snap.target },
          true
        )
      );
    }
    mutations.push(symlinkMutation(repoRoot, rel, symlinkTarget, changed));
    placements.push({ path: rel, materialization: 'symlink', symlinkTarget });
    results.push({ path: rel, action: changed ? 'symlinked' : 'unchanged' });
  }

  if (dualMaintain) {
    warnings.push(
      `${regulars.map((r) => r.rel).join(' and ')} both contain divergent content; orcaops is ` +
        `dual-maintaining the managed block in each. Run \`orcaops link\` to consolidate ` +
        `(drops the secondary's unique content).`
    );
  }

  return { mutations, placements, results, warnings, canonical };
}

export interface RemoveInstructionBlocksInput {
  repoRoot: string;
  instructionFiles: string[];
  generatedBy: string;
  prefix?: string;
  hints?: string[];
  /** The enabled skill set — must match what rendered the on-disk block. */
  enabledSkills?: ReadonlyArray<SkillTemplate>;
  reason?: 'bootstrap-manual' | 'scope-transition';
}

export interface RemoveInstructionBlocksResult {
  mutations: PlannedMutation[];
  results: InstructionFileResult[];
  warnings: string[];
}

/**
 * Plan removal of the managed block from each REAL instruction file (a
 * `managed → manual` bootstrap flip). Symlinks are skipped — they resolve to a real
 * file that is processed directly. Each file is hash-guarded by
 * `planRemoveOrcaopsSection`: a clean current block is stripped; a modified/stale
 * block is preserved and reported.
 */
export async function planRemoveInstructionBlocks(
  input: RemoveInstructionBlocksInput
): Promise<RemoveInstructionBlocksResult> {
  const expectedBlock = renderOrcaopsAgentsMdSection({
    generatedBy: input.generatedBy,
    prefix: input.prefix,
    hints: input.hints,
    enabledSkills: input.enabledSkills,
  });
  const files = [...new Set(input.instructionFiles)];
  const mutations: PlannedMutation[] = [];
  const results: InstructionFileResult[] = [];
  const warnings: string[] = [];

  for (const rel of files) {
    assertCanonicalRelativePath(rel, 'instruction file path');
    const absPath = path.join(input.repoRoot, rel);
    const parent = assertResolvedWithin(
      path.dirname(absPath),
      input.repoRoot,
      `instruction file ${rel} parent`,
      { allowRoot: true, rejectSymlinks: true }
    );
    const safeEntryPath = path.join(parent, path.basename(absPath));
    let st;
    try {
      st = await lstat(safeEntryPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (!st.isFile()) {
      if (!st.isSymbolicLink()) {
        results.push({ path: rel, action: 'unchanged' });
        warnings.push(`${rel} is not a regular file; preserving it unchanged.`);
      }
      continue;
    }

    const plan = await planRemoveOrcaopsSection({
      filePath: absPath,
      expectedBlock,
      containmentRoot: input.repoRoot,
    });
    if (plan.action === 'removed') {
      mutations.push({
        kind: 'inject-replace',
        path: rel,
        absPath,
        containmentRoot: input.repoRoot,
        desiredContent: plan.desiredContent,
        currentContent: plan.currentContent,
        changed: true,
        note: 'remove-block',
      });
      results.push({ path: rel, action: 'removed' });
    } else if (plan.action === 'preserved-modified') {
      // An ahead stamp resolves before the "modified" advice: the block is
      // newer state, and hand-removal advice would target what a newer
      // orcaops wrote. Every start stamp is read — malformed layouts too —
      // so a truncated or duplicated newer block still gets upgrade advice.
      const stamps = await readOrcaopsSectionStampVersions(absPath, input.repoRoot);
      const aheadStamp = stamps.find((v) => isVersionAhead(v, input.generatedBy));
      const context =
        input.reason === 'scope-transition' ? 'scope changed and' : 'bootstrap=manual and';
      if (aheadStamp !== undefined) {
        warnings.push(
          `${context} the orcaops block in ${rel} is stamped @${aheadStamp} — ` +
            `newer than this CLI; leaving it in place (upgrade orcaops to manage it).`
        );
      } else {
        warnings.push(
          input.reason === 'scope-transition'
            ? `scope changed but a modified orcaops block remains in ${rel}; remove it by hand.`
            : `bootstrap=manual but a modified orcaops block remains in ${rel}; remove it by hand.`
        );
      }
    }
  }

  return { mutations, results, warnings };
}
