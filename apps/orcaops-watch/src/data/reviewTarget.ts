import { access } from 'node:fs/promises';
import path from 'node:path';

import { readOnlyWorktreeState, Repo } from '@orcaops/core';
import { readRepositoryRegistration } from '@orcaops/core/history/registration';
import { discoverGitRoot, resolveExplicitOverride } from '@orcaops/project-scope';
import { HistoryError, normalizeHistoryRoot } from '@orcaops/storage/history/authority';

export type ReviewTargetResolution = { ok: true; root: string } | { ok: false; reason: string };

export interface ResolveReviewTargetOptions {
  projectId: string | null;
  branch: string;
  launchRoot?: string;
  projectLabel?: string;
  repository?: { commonDirectory: string; instanceId: string };
  storeInstanceId?: string;
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type ResolveReviewTarget = (
  opts: ResolveReviewTargetOptions
) => Promise<ReviewTargetResolution>;

export async function resolveReviewTarget(
  opts: ResolveReviewTargetOptions
): Promise<ReviewTargetResolution> {
  const { projectId, branch } = opts;
  if (projectId === null)
    return {
      ok: false,
      reason: `cannot review ${branch} — no registered project history is selected`,
    };
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const requestedRoot = await normalizeHistoryRoot({ root: opts.dataRoot, env, cwd });
  const candidates: string[] = [];
  const override = await resolveExplicitOverride(cwd, env, opts.launchRoot);
  if (override !== null) candidates.push(override);
  const gitRoot = await discoverGitRoot(cwd);
  if (gitRoot !== null) candidates.push(gitRoot);

  let identityProblem = false;
  async function matchesRegistration(commonDir: string): Promise<boolean> {
    const registration = await readRepositoryRegistration({ commonDir, requestedRoot });
    return (
      registration !== null &&
      registration.authority.project_id === projectId &&
      (opts.storeInstanceId === undefined ||
        registration.authority.store_instance_id === opts.storeInstanceId) &&
      (opts.repository === undefined ||
        registration.repository_instance_id === opts.repository.instanceId)
    );
  }
  if (opts.repository) {
    try {
      // The sidecar supplies a locator, not authority to trust arbitrary repository paths.
      if (await matchesRegistration(opts.repository.commonDirectory))
        candidates.push(
          ...(await new Repo(opts.repository.commonDirectory).listWorktrees()).map(
            (worktree) => worktree.path
          )
        );
    } catch (cause) {
      if (cause instanceof HistoryError) identityProblem = true;
    }
  }

  const seen = new Set<string>();
  let locatedRepo = false;
  let configProblem: string | null = null;
  for (const candidate of candidates) {
    const key = path.resolve(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await access(candidate);
      const candidateState = await readOnlyWorktreeState(candidate);
      if (candidateState.kind === 'broken') {
        configProblem ??= candidateState.error.message;
        continue;
      }
      if (candidateState.kind !== 'enabled') continue;
      const repo = new Repo(candidate);
      if (!(await matchesRegistration(await repo.getCommonDirAbsolute()))) continue;
      locatedRepo = true;
      for (const worktree of await repo.listWorktrees()) {
        if (worktree.branch !== branch) continue;
        const worktreeState = await readOnlyWorktreeState(worktree.path);
        if (worktreeState.kind === 'broken') {
          configProblem ??= worktreeState.error.message;
          continue;
        }
        if (worktreeState.kind !== 'enabled') continue;
        if (!(await matchesRegistration(await new Repo(worktree.path).getCommonDirAbsolute())))
          continue;
        return { ok: true, root: worktree.path };
      }
    } catch (cause) {
      if (cause instanceof HistoryError) identityProblem = true;
    }
  }

  const identitySuffix = identityProblem
    ? '; additionally, a candidate repository has an unreadable or invalid stored project identity — run `orcaops doctor` there'
    : '';
  const configSuffix = configProblem === null ? '' : `; configuration error: ${configProblem}`;
  if (locatedRepo)
    return {
      ok: false,
      reason: `cannot review ${branch} — no live worktree has it checked out; check it out first, or open its worktree${identitySuffix}${configSuffix}`,
    };
  const label = opts.projectLabel || projectId;
  return {
    ok: false,
    reason: `cannot review ${branch} — could not locate ${label} on disk; open its registered repository and run orcaops doctor${identitySuffix}${configSuffix}`,
  };
}
