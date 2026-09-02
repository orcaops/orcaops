import { type Repo } from '@orcaops/core';
import {
  type AllProjectsScope,
  type CurrentProjectArchive,
  openAllProjects as openAllProjectsWith,
  openCurrentProjectArchive as openCurrentProjectArchiveWith,
  type ProjectHandle,
  type ProjectScopeIssue,
  type UnidentifiedProjectHandle,
} from '@orcaops/project-scope';

import {
  getInvocationCwd,
  getInvocationEnv,
  getInvocationRootOverride,
} from './invocation-context.js';

// Types re-exported so the CLI's existing importers keep their import path.
export type {
  AllProjectsScope,
  CurrentProjectArchive,
  ProjectHandle,
  ProjectScopeIssue,
  UnidentifiedProjectHandle,
};

/**
 * ALS shim over `@orcaops/project-scope`'s `openAllProjects`. Reads the
 * per-invocation cwd / env / `--root` from the invocation context so the CLI's
 * ~6 `openAllProjects()` call sites keep calling it with no arguments. The
 * current project's archive index is attached to its hot handle for readers
 * to merge; only minted projects are fanned out.
 */
export function openAllProjects(): Promise<AllProjectsScope> {
  return openAllProjectsWith({
    cwd: getInvocationCwd(),
    env: getInvocationEnv(),
    rootOverride: getInvocationRootOverride(),
    includeArchiveForHot: true,
    throwOnHotOpenError: true,
  });
}

export function openCurrentProjectArchive(
  repo: Repo,
  repoRoot: string
): Promise<CurrentProjectArchive | null> {
  return openCurrentProjectArchiveWith({
    repo,
    repoRoot,
    env: getInvocationEnv(),
  });
}

/** Human warning appended to every partial `--all-projects` response. */
export function formatProjectScopeWarnings(issues: ProjectScopeIssue[]): string {
  if (issues.length === 0) return '';
  const identityIssues = issues.filter((issue) => issue.kind === 'project_identity_unavailable');
  const artifactIssues = issues.filter((issue) => issue.kind === 'artifact_unavailable');
  const indexIssues = issues.filter((issue) => issue.kind === 'project_index_degraded');
  const projectionIssues = issues.filter((issue) => issue.kind === 'hot_projection_incomplete');
  if (identityIssues.length > 0 || indexIssues.length > 0 || projectionIssues.length > 0) {
    return [
      '',
      `Warning: Partial project data — ${issues.length} issue(s) require attention.`,
      ...issues.map((issue) =>
        issue.kind === 'artifact_unavailable'
          ? `  [${issue.project}] ${issue.artifact_id}: ${issue.message}`
          : `  [${issue.project}] ${issue.message}`
      ),
      ...(artifactIssues.length > 0
        ? [
            '  Run `orcaops archive repair` from the worktree that owns the artifact; ' +
              'where none still does, `orcaops archive prune --artifact <id>` is the only exit.',
          ]
        : []),
      ...(indexIssues.length > 0
        ? ['  The archive index is disposable; retry the command or run `orcaops doctor`.']
        : []),
      ...(projectionIssues.length > 0
        ? ['  Repair the durable sources, then run `orcaops rebuild`.']
        : []),
      '',
    ].join('\n');
  }
  const projects = [...new Set(artifactIssues.map((issue) => issue.project))].join(', ');
  const noun = artifactIssues.length === 1 ? 'artifact' : 'artifacts';
  const lines = [
    '',
    `Warning: Partial archive data — ${artifactIssues.length} ${noun} unavailable in ${projects}.`,
    ...artifactIssues.map((issue) => `  [${issue.project}] ${issue.artifact_id}: ${issue.message}`),
    '  Run `orcaops archive repair` from the worktree that owns the artifact; ' +
      'where none still does, `orcaops archive prune --artifact <id>` is the only exit.',
    '',
  ];
  return lines.join('\n');
}
