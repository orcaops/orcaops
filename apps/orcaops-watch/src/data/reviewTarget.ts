// Resolve the on-disk worktree a cockpit row's review should run against, so
// `v` can launch the review for ANY project/branch the dashboard shows — not
// only the branch checked out in the worktree watch was launched from.
//
// The dashboard aggregates threads across every archived project, but the review
// engine needs a real repo (git diff/blame + the artifact hot store). We locate
// the owning project's repo via the archive registry's `last_seen_paths` hint
// (a zoxide-style, verified-on-access hint — never a key), then find the worktree
// that has the branch checked out. Requiring a live checkout keeps the engine on
// its on-branch (non-degraded) path, with artifacts and git objects both local.
//
// Renderer-free (the src/data rule): no OpenTUI/React imports.

import { access } from 'node:fs/promises';
import path from 'node:path';

import { Repo } from '@orcaops/core';
import {
  discoverGitRoot,
  ProjectIdentityError,
  readProjectId,
  resolveExplicitOverride,
} from '@orcaops/project-scope';
import { archiveRoot, loadRegistry, registryPath } from '@orcaops/storage';

export type ReviewTargetResolution = { ok: true; root: string } | { ok: false; reason: string };

export interface ResolveReviewTargetOptions {
  /**
   * The row's project id, or null for the current checkout when it has no
   * minted id (archive disabled). A null id is only ever the hot project, so it
   * skips the registry and resolves against the hot-repo candidates alone
   * (`launchRoot`/`ORCAOPS_ROOT`, then the cwd git root).
   */
  projectId: string | null;
  /** The row's branch — the branch whose live worktree we look for. */
  branch: string;
  /**
   * The `--root` the watch app was started with (the hot project), if any.
   * Usually undefined: the `orcaops watch` stub forwards `--root` via
   * `ORCAOPS_ROOT`, not argv — so the hot repo is normally found via that env
   * var or the cwd git root below, not this param.
   */
  launchRoot?: string;
  /** Human-readable project name for the not-locatable message. */
  projectLabel?: string;
  /** Env to resolve the archive data root + ORCAOPS_ROOT against (tests pass a hermetic env). */
  env?: NodeJS.ProcessEnv;
  /** Directory to resolve the hot-project git root from. Defaults to process.cwd(). */
  cwd?: string;
}

/** The resolver signature, so the mounted App can take an injected one. */
export type ResolveReviewTarget = (
  opts: ResolveReviewTargetOptions
) => Promise<ReviewTargetResolution>;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the worktree that has `branch` checked out for the row's project, so the
 * review runs against it. Candidate repo entry points are the hot repo (the
 * `--root`/`ORCAOPS_ROOT` override, then the cwd git root) followed by the
 * project's registry `last_seen_paths`. A candidate is accepted only when it is
 * a git repo with `.orcaops` whose
 * minted project id matches the row — stale or foreign paths are rejected rather
 * than yielding a wrong-repo review. From an accepted candidate every worktree
 * of the repo is enumerable (the common dir is shared), so we return the one on
 * `branch`. Two distinct refusals: the repo was found but no live worktree has
 * the branch, versus the repo could not be located on disk at all.
 */
export async function resolveReviewTarget(
  opts: ResolveReviewTargetOptions
): Promise<ReviewTargetResolution> {
  const { projectId, branch } = opts;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  // Hot-project candidates: the explicit override (`--root`/launchRoot, else
  // `ORCAOPS_ROOT`) and the cwd's git worktree — the same signals the cockpit
  // resolves the hot repo from, and the ones that keep an archive-disabled repo
  // (null projectId, no registry entry) reviewable when launchRoot is undefined.
  // Cross-project candidates come from the archive registry's last-seen paths.
  // A foreign candidate is rejected by the projectId check below, so gathering
  // all three sources is safe.
  const candidates: string[] = [];
  const override = await resolveExplicitOverride(cwd, env, opts.launchRoot);
  if (override !== null) candidates.push(override);
  const gitRoot = await discoverGitRoot(cwd);
  if (gitRoot !== null) candidates.push(gitRoot);
  if (projectId !== null) {
    const registry = await loadRegistry(registryPath(archiveRoot(env)));
    candidates.push(...(registry.projects[projectId]?.last_seen_paths ?? []));
  }

  const seen = new Set<string>();
  let locatedRepo = false;
  let identityProblem = false;
  for (const candidate of candidates) {
    const key = path.resolve(candidate);
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      if (!(await pathExists(candidate))) continue;
      if (!(await pathExists(path.join(candidate, '.orcaops')))) continue;
      const repo = new Repo(candidate);
      // Identity lives in git's common dir (shared across worktrees) — a match
      // proves this candidate belongs to the row's project. A mismatch is a
      // stale/moved or foreign path; skip it silently.
      if ((await readProjectId(repo)) !== projectId) continue;
      locatedRepo = true;
      for (const worktree of await repo.listWorktrees()) {
        if (worktree.branch !== branch) continue;
        // The review runs (and writes floor/refs/comments) in this worktree, so
        // it must carry its own hot store; an uninitialized checkout is not a
        // usable target.
        if (!(await pathExists(path.join(worktree.path, '.orcaops')))) continue;
        return { ok: true, root: worktree.path };
      }
    } catch (error) {
      if (error instanceof ProjectIdentityError) identityProblem = true;
      // A candidate that can't be opened as a repo is just not a match.
      continue;
    }
  }

  const identitySuffix = identityProblem
    ? '; additionally, a candidate repository has an unreadable or invalid stored project identity — run `orcaops doctor` there'
    : '';
  if (locatedRepo) {
    return {
      ok: false,
      reason:
        `cannot review ${branch} — no live worktree has it checked out; check it out first, ` +
        `or open its worktree${identitySuffix}`,
    };
  }
  const label =
    opts.projectLabel !== undefined && opts.projectLabel.length > 0
      ? opts.projectLabel
      : (projectId ?? 'this project');
  return {
    ok: false,
    reason:
      `cannot review ${branch} — could not locate ${label} on disk; open it once from that ` +
      `repo so orcaops records its path${identitySuffix}`,
  };
}
