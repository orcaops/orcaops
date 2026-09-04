import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Repo } from '@orcaops/core';
import { assertResolvedWithin } from '@orcaops/storage';

import { reconcileManagedLineBlock } from './managed-line-block.js';
import { type PlannedMutation, writeMutation } from './mutations.js';

/**
 * `.git/info/exclude` reconciler (personal install scope). Modeled
 * line-for-line on `reconcileGitignore`: replace only the bounded Orcaops
 * block, preserve user lines, and return `desiredContent: null` when unchanged.
 *
 * Why info/exclude: personal scope must keep `git status` CLEAN on a
 * shared enterprise repo without touching any committed file.
 * info/exclude hides UNTRACKED files locally — exactly the personal
 * footprint (`.orcaops/`) — and lives in the git COMMON dir, so one block
 * hides every worktree's store and teammates never see it. This module
 * NEVER touches the repo `.gitignore`.
 */

/**
 * The personal-scope footprint hidden from `git status`. Exactly one line:
 * personal scope owns no instruction file any more, and the ownership
 * manifest sits in the git common dir rather than under `.orcaops/`.
 * Reconciliation drops the lines earlier layouts managed from an existing
 * block; nothing adds them back.
 */
export const PERSONAL_EXCLUDE_LINES = ['.orcaops/'];

export interface InfoExcludeReconcilePlan {
  /** Absolute path of the exclude file (worktree-aware). */
  excludePath: string;
  /** Git metadata root that owns `excludePath`. */
  containmentRoot: string;
  added: string[];
  removed: string[];
  /** Whether the file already carried an orcaops-owned section. */
  claimed: boolean;
  currentContent: string;
  /** Null when the file already matches (no write needed). */
  desiredContent: string | null;
}

/**
 * Resolve the checkout's info/exclude path via `git rev-parse --git-path
 * info/exclude`. Git owns the layout policy: normal clone →
 * `.git/info/exclude`, linked worktree / submodule → the COMMON dir's
 * `info/exclude` behind the `gitdir:` indirection. Plumbing also works when
 * `repoRoot` is a subdirectory root (`init --here`), where a hand-joined
 * `<repoRoot>/.git` does not exist.
 */
async function resolveInfoExcludeLocation(
  repoRoot: string
): Promise<{ excludePath: string; containmentRoot: string }> {
  const repo = new Repo(repoRoot);
  const containmentRoot = await repo.getCommonDirAbsolute();
  const excludePath = await repo.getGitPathAbsolute('info/exclude');
  assertResolvedWithin(excludePath, containmentRoot, 'Git info/exclude', { rejectSymlinks: true });
  return { excludePath, containmentRoot };
}

export async function resolveInfoExcludePath(repoRoot: string): Promise<string> {
  return (await resolveInfoExcludeLocation(repoRoot)).excludePath;
}

export async function reconcileInfoExclude(
  repoRoot: string,
  desired: string[]
): Promise<InfoExcludeReconcilePlan> {
  const { excludePath, containmentRoot } = await resolveInfoExcludeLocation(repoRoot);
  const safeExcludePath = assertResolvedWithin(excludePath, containmentRoot, 'Git info/exclude', {
    rejectSymlinks: true,
  });
  let existing = '';
  try {
    existing = await readFile(safeExcludePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const plan = reconcileManagedLineBlock(existing, desired);
  if (plan.desiredContent === null) {
    return {
      excludePath,
      containmentRoot,
      added: [],
      removed: [],
      claimed: plan.claimed,
      currentContent: existing,
      desiredContent: null,
    };
  }
  return {
    excludePath,
    containmentRoot,
    added: plan.added,
    removed: plan.removed,
    claimed: plan.claimed,
    currentContent: existing,
    desiredContent: plan.desiredContent,
  };
}

export interface PlanInfoExcludeMutationInput {
  repoRoot: string;
  /** Managed lines desired NOW; `[]` strips the whole orcaops section. */
  desired: string[];
}

export interface InfoExcludeMutationPlan {
  mutation: PlannedMutation;
  added: string[];
  removed: string[];
  /** Whether the file already carried an orcaops-owned section. */
  claimed: boolean;
}

/**
 * The ONE info/exclude write path — shared by the install planner (init /
 * update / doctor --fix) and uninstall. Reconciles the managed section and
 * returns a ready mutation plus what moved, or null when the file already
 * matches. Callers that must not CREATE a section (uninstall) read `claimed`
 * to tell a reconcile from a first write. The mutation's display path is
 * repo-relative and may be `../…` from a linked worktree (the exclude lives in
 * the COMMON dir). Parent creation belongs to the mutation executor so
 * planning and preview remain read-only.
 */
export async function planInfoExcludeMutation(
  input: PlanInfoExcludeMutationInput
): Promise<InfoExcludeMutationPlan | null> {
  const plan = await reconcileInfoExclude(input.repoRoot, input.desired);
  if (plan.desiredContent === null) return null;
  return {
    mutation: writeMutation(
      input.repoRoot,
      path.relative(input.repoRoot, plan.excludePath),
      plan.desiredContent,
      plan.currentContent,
      true,
      plan.containmentRoot,
      plan.excludePath
    ),
    added: plan.added,
    removed: plan.removed,
    claimed: plan.claimed,
  };
}
