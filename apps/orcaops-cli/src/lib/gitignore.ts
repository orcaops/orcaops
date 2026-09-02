import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertResolvedWithin } from '@orcaops/storage';

import { atomicWriteFile } from './atomic-write.js';
import { inspectManagedLineBlock, reconcileManagedLineBlock } from './managed-line-block.js';

/**
 * The orcaops-managed data ignores every install writes — init and update
 * share this list (through planInstallMutations / reconcileGitignore) so the
 * two can never drift. Data paths only; generated-tree globs are derived
 * per-adapter (derivedIgnoreGlobs) under `generated_files: 'ignore'`.
 * `index.sqlite` and `usage/` are ignored too — both are local state
 * (rebuildable cache / usage ledger) that would otherwise land untracked in
 * every repo. `reviews/` is Task Review state — a derived coverage
 * floor plus reviewer-local dispositions and comments — that is regenerable
 * from the capture and never leaves the reviewer's checkout, so it is never
 * committed.
 */
export const ORCAOPS_BASE_GITIGNORE: ReadonlyArray<string> = [
  // A NESTED .orcaops is never legitimate (stores live at the repo root by
  // design — a nested one is wrong-root litter that poisons snapshot diffs at
  // MB scale), so ignore it everywhere…
  '**/.orcaops/',
  // …but re-include the ROOT store dir: committed config (install.json,
  // evaluators.yaml) is user work. Order matters — the negation must follow
  // the broad ignore, and the root-internal data ignores below still apply.
  '!/.orcaops/',
  '.orcaops/artifacts/',
  '.orcaops/cache/',
  '.orcaops/index.sqlite',
  '.orcaops/reviews/',
  '.orcaops/tmp/',
  '.orcaops/usage/',
  '.orcaops/install.local.json',
];

export interface GitignorePlan {
  /** Absolute path to the .gitignore. */
  gitignorePath: string;
  /** Entries that are not already present and would be appended. */
  added: string[];
  /** Current .gitignore content ('' if absent). */
  currentContent: string;
  /** Full next .gitignore content, or null when nothing needs adding. */
  desiredContent: string | null;
}

/**
 * Compute which `.gitignore` entries are missing and the resulting file content,
 * WITHOUT writing. The pure planner half of `ensureGitignoreEntries`.
 */
export async function planGitignoreEntries(
  repoRoot: string,
  entries: string[]
): Promise<GitignorePlan> {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const safeGitignorePath = assertResolvedWithin(gitignorePath, repoRoot, '.gitignore', {
    rejectSymlinks: true,
  });

  let existing = '';
  try {
    existing = await readFile(safeGitignorePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const current = inspectManagedLineBlock(existing).managedLines;
  const desired = [...new Set([...current, ...entries])];
  const plan = reconcileManagedLineBlock(existing, desired);
  return {
    gitignorePath,
    added: plan.added,
    currentContent: existing,
    desiredContent: plan.desiredContent,
  };
}

export interface GitignoreRemovePlan {
  /** Absolute path to the .gitignore. */
  gitignorePath: string;
  /** orcaops entries that were present and will be removed. */
  removed: string[];
  /** Current .gitignore content ('' if absent). */
  currentContent: string;
  /** Full next .gitignore content, or null when nothing needs changing. */
  desiredContent: string | null;
  /** True when the file held ONLY orcaops content → round-trips to absent. */
  deleteFile: boolean;
}

/**
 * The inverse of {@link planGitignoreEntries}: remove selected entries only
 * from Orcaops's bounded block, WITHOUT writing. Used by `orcaops uninstall`.
 * If the file held only Orcaops content it rounds back to absent (`deleteFile`).
 */
export async function planRemoveGitignoreEntries(
  repoRoot: string,
  entries: string[]
): Promise<GitignoreRemovePlan> {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const safeGitignorePath = assertResolvedWithin(gitignorePath, repoRoot, '.gitignore', {
    rejectSymlinks: true,
  });

  let existing: string;
  try {
    existing = await readFile(safeGitignorePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        gitignorePath,
        removed: [],
        currentContent: '',
        desiredContent: null,
        deleteFile: false,
      };
    }
    throw err;
  }

  const state = inspectManagedLineBlock(existing);
  const toRemove = new Set(entries.map((entry) => entry.trim()).filter(Boolean));
  const removed = [...new Set(state.managedLines.filter((line) => toRemove.has(line)))];
  if (removed.length === 0) {
    return {
      gitignorePath,
      removed: [],
      currentContent: existing,
      desiredContent: null,
      deleteFile: false,
    };
  }

  const desired = state.managedLines.filter((line) => !toRemove.has(line));
  const plan = reconcileManagedLineBlock(existing, desired);
  if (plan.desiredContent === '') {
    return {
      gitignorePath,
      removed,
      currentContent: existing,
      desiredContent: null,
      deleteFile: true,
    };
  }
  return {
    gitignorePath,
    removed,
    currentContent: existing,
    desiredContent: plan.desiredContent,
    deleteFile: false,
  };
}

export interface GitignoreReconcilePlan {
  gitignorePath: string;
  added: string[];
  removed: string[];
  currentContent: string;
  /** Full next content, or null when nothing needs changing. */
  desiredContent: string | null;
}

/**
 * Reconcile Orcaops's bounded `.gitignore` block in ONE pass, preserving
 * identical user-authored lines outside it. A single writeMutation source, so
 * a prefix/mode change that adds new globs AND drops stale ones never races two
 * writes on the same file. Stable: when the result equals the current file,
 * `desiredContent` is null (no churn).
 */
export async function reconcileGitignore(
  repoRoot: string,
  desired: string[]
): Promise<GitignoreReconcilePlan> {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const safeGitignorePath = assertResolvedWithin(gitignorePath, repoRoot, '.gitignore', {
    rejectSymlinks: true,
  });
  let existing = '';
  try {
    existing = await readFile(safeGitignorePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const plan = reconcileManagedLineBlock(existing, desired);
  if (plan.desiredContent === null) {
    return {
      gitignorePath,
      added: [],
      removed: [],
      currentContent: existing,
      desiredContent: null,
    };
  }
  return {
    gitignorePath,
    added: plan.added,
    removed: plan.removed,
    currentContent: existing,
    desiredContent: plan.desiredContent,
  };
}

/**
 * Append entries to `.gitignore` if not already present. A thin plan →
 * execute wrapper. Returns the entries that were actually added.
 */
export async function ensureGitignoreEntries(
  repoRoot: string,
  entries: string[]
): Promise<string[]> {
  const plan = await planGitignoreEntries(repoRoot, entries);
  if (plan.desiredContent !== null) {
    await atomicWriteFile(plan.gitignorePath, plan.desiredContent, repoRoot);
  }
  return plan.added;
}
