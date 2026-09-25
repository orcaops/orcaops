import { isDeepStrictEqual } from 'node:util';

import { Repo } from '@orcaops/core';
import { readDatabaseHistoryContext } from '@orcaops/core/history/database-read';
import { HistoryScopeError } from '@orcaops/project-scope/history';
import { collectDatabaseHistory } from '@orcaops/project-scope/history/database';
import { redactSecretsInObject } from '@orcaops/storage';
import { ProjectDatabaseError, readProjectInitialization } from '@orcaops/storage/history/database';
import { HistoryMetadataDetailsSchema } from '@orcaops/storage/history/metadata-row';

import {
  buildDatabaseListResult,
  type DatabaseListContext,
  type DatabaseListOptions,
  formatDatabaseList,
  validateDatabaseList,
} from './database-list.js';
import { getInvocationEnv } from './invocation-context.js';
import { type BetweenSha, parseBetweenRange } from './list-provenance.js';

const RangeDetailsSchema = HistoryMetadataDetailsSchema.pick({
  anchors: true,
  branchLineage: true,
});
// Only the latest anchor proves all the work landed. Anchors carry no timestamps,
// so latest is the summary, else the highest checkpoint n, else the pre-PR check.
function latestAnchor(anchors: ReadonlyArray<BetweenSha>): BetweenSha | undefined {
  const checkpoints = anchors.filter((anchor) => anchor.source === 'checkpoint');
  return (
    anchors.find((anchor) => anchor.source === 'summary') ??
    checkpoints.reduce<BetweenSha | undefined>(
      (latest, anchor) => (latest && latest.n! >= anchor.n! ? latest : anchor),
      undefined
    ) ??
    anchors.find((anchor) => anchor.source === 'pre_pr')
  );
}
export async function readDatabaseRangeList(
  context: DatabaseListContext,
  input: DatabaseListOptions
) {
  const options = { ...input };
  const prepared = validateDatabaseList(options);
  if (options.between === undefined)
    throw new HistoryScopeError('INVALID_INPUT', 'Provide a Git range');
  const range = parseBetweenRange(options.between);
  const scope = {
    ...context.scope,
    root: { ...context.scope.root },
    branch: { ...context.scope.branch },
    projects: context.scope.projects.map((project) => ({
      ...project,
      authority: project.authority ? { ...project.authority } : null,
      completeness: structuredClone(project.completeness),
    })),
    gitContext: structuredClone(context.scope.gitContext),
    completeness: structuredClone(context.scope.completeness),
  };
  const detached = { scope, config: structuredClone(context.config) };
  const git = scope.gitContext;
  if (!git || scope.kind === 'all-projects' || scope.projects.length !== 1)
    throw new HistoryScopeError(
      'GIT_CONTEXT_UNAVAILABLE',
      'Git range requires one matching repository'
    );
  if (
    (prepared.selector.projectId !== undefined &&
      (scope.projects.length !== 1 ||
        scope.projects[0].projectId !== prepared.selector.projectId)) ||
    (prepared.selector.scope !== undefined && prepared.selector.scope !== scope.kind) ||
    scope.branch.value !== null
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'Git range options differ from the opened project scope'
    );
  const project = scope.projects[0];
  const initialization = project.database ? readProjectInitialization(project.database) : null;
  const authority = initialization?.authority ?? project.authority;
  const expectedRegistrationAuthority = authority && {
    resolved_root: authority.resolvedRoot,
    root_key: authority.rootKey,
    project_id: authority.projectId,
    store_instance_id: authority.storeInstanceId,
  };
  const revalidate = async () => {
    const observed = await readDatabaseHistoryContext({ cwd: git.worktreeRoot });
    if (observed.headIssue) throw observed.headIssue;
    if (
      !isDeepStrictEqual(observed.git, git) ||
      !authority ||
      !isDeepStrictEqual(observed.registration?.authority, expectedRegistrationAuthority) ||
      observed.registration?.repository_instance_id !== authority.repositoryInstanceId ||
      (initialization !== null &&
        observed.registration?.initialization_operation_id !==
          initialization.initializationOperationId)
    )
      throw new ProjectDatabaseError(
        'STALE_CONTEXT',
        'Repository context changed during range inspection; retry the original read'
      );
  };
  await revalidate();
  const env = {
    ...Object.fromEntries(
      Object.entries(getInvocationEnv()).filter(([key]) => !key.startsWith('GIT_'))
    ),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
  };
  const repo = new Repo(git.worktreeRoot, { env });
  const from = await repo.resolveCommit(range.from);
  const to = await repo.resolveCommit(range.to);
  if (!from || !to)
    throw new HistoryScopeError(
      'INVALID_INPUT',
      `Git range endpoint does not resolve to a commit: ${!from ? range.from : range.to}`
    );
  let commits: string[];
  try {
    commits = await repo.listCommitShasBetween(from, to);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Git range cannot be read; restore the selected repository objects and retry',
      { cause }
    );
  }
  const ref2LocalBranch = (await repo.branchExists(range.to)) ? range.to : null;
  await revalidate();
  const collection = collectDatabaseHistory(
    scope,
    { ...prepared.filters, offset: 0, limit: undefined },
    'details'
  );
  const shas = new Set(commits);
  const matches = new Map<string, BetweenSha[]>();
  const unmatched: Array<{
    id: string;
    artifact_id: string;
    project_id: string;
    label: string | null;
    branch: string;
    reason: 'no_head_sha_in_range';
    origin: 'captured' | 'git-import';
  }> = [];
  const lineageCandidates: Array<{
    entry: (typeof collection.entries)[number];
    latestSha: string | undefined;
  }> = [];
  const matching = collection.entries.filter((entry) => {
    try {
      const raw = JSON.parse(entry.row.detailsJson!);
      const details = RangeDetailsSchema.parse({
        anchors: raw.anchors,
        branchLineage: raw.branchLineage,
      });
      const anchors = details.anchors.filter((anchor) => shas.has(anchor.head_sha));
      if (anchors.length) {
        matches.set(entry.row.artifactId, anchors);
        return true;
      }
      if (
        ref2LocalBranch !== null &&
        details.branchLineage.some((line) => line.branch === ref2LocalBranch)
      )
        lineageCandidates.push({ entry, latestSha: latestAnchor(details.anchors)?.head_sha });
    } catch {
      collection.completeness.complete = false;
      collection.completeness.issues.push({
        code: 'HISTORY_INTEGRITY_REQUIRED',
        project_id: entry.projectId,
        artifact_id: entry.row.artifactId,
        message:
          'Recorded Git anchors are unavailable; explicitly rebuild derived metadata from original history',
      });
    }
    return false;
  });
  const reachability = await repo.checkReachabilityFromTips(
    [...new Set(lineageCandidates.flatMap(({ latestSha }) => (latestSha ? [latestSha] : [])))],
    [to]
  );
  for (const { entry, latestSha } of lineageCandidates) {
    if (latestSha !== undefined && reachability.get(latestSha) === 'reachable') continue;
    unmatched.push({
      id: entry.row.artifactId,
      artifact_id: entry.row.artifactId,
      project_id: entry.projectId,
      label: entry.row.label,
      branch: entry.row.branch,
      reason: 'no_head_sha_in_range',
      origin: entry.row.origin,
    });
  }
  collection.entries = matching.slice(
    prepared.filters.offset,
    prepared.filters.limit === undefined
      ? undefined
      : prepared.filters.offset + prepared.filters.limit
  );
  collection.availableCounts = {
    captured: matching.filter((entry) => entry.row.origin === 'captured').length,
    imported: matching.filter((entry) => entry.row.origin === 'git-import').length,
  };
  collection.counts = collection.completeness.complete
    ? { ...collection.availableCounts }
    : { captured: null, imported: null };
  collection.hasMore = collection.completeness.complete
    ? prepared.filters.offset + collection.entries.length < matching.length
    : null;
  const output = buildDatabaseListResult(detached, prepared, collection);
  const result = {
    ...output,
    between: {
      from: range.from,
      to: range.to,
      from_sha: from,
      to_sha: to,
      rev_list_count: commits.length,
      ref2_local_branch: ref2LocalBranch,
    },
    results: output.results.map((row) => ({ ...row, matched_shas: matches.get(row.id)! })),
    unmatched_candidates: unmatched,
  };
  return detached.config.digest.redact_secrets ? redactSecretsInObject(result) : result;
}
export function formatDatabaseRangeList(result: Awaited<ReturnType<typeof readDatabaseRangeList>>) {
  const lines = [
    formatDatabaseList(result).trimEnd(),
    `Range: ${result.between.from}..${result.between.to}`,
  ];
  for (const row of result.results)
    for (const anchor of row.matched_shas)
      lines.push(
        `${row.id.slice(0, 8)} ${anchor.source}${anchor.n === undefined ? '' : ` ${anchor.n}`} ${anchor.head_sha}`
      );
  if (result.unmatched_candidates.length) {
    lines.push('Unmatched branch-lineage candidates (no recorded HEAD in range):');
    for (const row of result.unmatched_candidates)
      lines.push(`${row.id.slice(0, 8)} ${row.branch} ${row.label ?? 'unlabelled'}`);
  }
  return lines.join('\n') + '\n';
}
