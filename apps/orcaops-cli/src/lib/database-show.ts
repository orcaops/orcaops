import { buildRepoStateFromSnapshot, Repo, sourcePlanView } from '@orcaops/core';
import { HistoryScopeError, validateHistorySelector } from '@orcaops/project-scope/history';
import { resolveDatabaseHistoryOverview } from '@orcaops/project-scope/history/database';
import { redactSecretsInObject } from '@orcaops/storage';
import {
  aggregateCanonicalUsage,
  estimateArtifactUsage,
} from '@orcaops/storage/history/usage-accounting';

import type { resolveDatabaseHistoryCommandContext } from './database-history-context.js';
import { historyPlanRevisions } from './history-read-model.js';
import { getInvocationEnv } from './invocation-context.js';

export interface DatabaseShowOptions {
  project?: string;
  json?: boolean;
}
export function validateDatabaseShow(artifactId: string, options: DatabaseShowOptions) {
  if (Object.keys(options).some((key) => !['project', 'json'].includes(key)))
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Exact artifact reads accept only project qualification and output format'
    );
  if (typeof artifactId !== 'string' || !/^[0-9a-f-]{1,36}$/i.test(artifactId))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide an artifact UUID or hexadecimal prefix');
  const selector = { projectId: options.project };
  validateHistorySelector({ profile: 'exact', selector });
  return selector;
}
export async function readDatabaseShow(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  requested: string
) {
  const target = resolveDatabaseHistoryOverview(context.scope, requested);
  return readDatabaseShowTarget(context, target);
}
export async function readDatabaseShowTarget(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  original: ReturnType<typeof resolveDatabaseHistoryOverview>
) {
  const target = structuredClone(original);
  const redact = context.config.digest.redact_secrets;
  const scope = {
    ...context.scope,
    root: { ...context.scope.root },
    branch: structuredClone(context.scope.branch),
    projects: context.scope.projects.map((project) => ({
      ...project,
      authority: project.authority === null ? null : { ...project.authority },
    })),
    gitContext:
      context.scope.gitContext === null ? null : structuredClone(context.scope.gitContext),
    completeness: structuredClone(context.scope.completeness),
  };
  const thread = target.artifact.thread;
  const git = scope.gitContext === null ? null : structuredClone(scope.gitContext);
  const gitContext = await (async () => {
    if (!git || git.repositoryInstanceId !== target.authority.repositoryInstanceId)
      return { state: 'unavailable' as const, reason: 'GIT_CONTEXT_UNAVAILABLE', value: null };
    if (target.repoEvidence.state === 'unavailable')
      return {
        state: 'unavailable' as const,
        reason: target.repoEvidence.code,
        message: target.repoEvidence.message,
        value: null,
      };
    const env = {
      ...Object.fromEntries(
        Object.entries(getInvocationEnv()).filter(([key]) => !key.startsWith('GIT_'))
      ),
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1',
    };
    const repo = new Repo(git.worktreeRoot, { env });
    try {
      const anchor =
        thread.summary?.head_sha ?? thread.checkpoints.at(-1)?.head_sha ?? thread.plan!.base_sha;
      if (anchor && (await repo.resolveCommitState(anchor)).status !== 'resolved')
        throw new Error('The recorded artifact commit is unavailable');
      const value = await buildRepoStateFromSnapshot({
        repo,
        artifactId: target.artifactId,
        strictGit: true,
        snapshot: thread,
        laterArtifactEvidence: target.repoEvidence.laterArtifact,
      });
      if (value && value.current_head_sha !== git.headOid)
        return {
          state: 'unavailable' as const,
          reason: 'STALE_CONTEXT',
          message: 'Git changed during this read; repeat the same artifact selection',
          value: null,
        };
      return { state: 'available' as const, value };
    } catch (cause) {
      return {
        state: 'unavailable' as const,
        reason: 'GIT_OBJECTS_UNAVAILABLE',
        message: cause instanceof Error ? cause.message : 'Git evidence is unavailable',
        value: null,
      };
    }
  })();
  const lineage = git?.branch
    ? thread.artifactJson!.branch_lineage.filter((entry) => entry.branch === git.branch).at(-1)
    : undefined;
  const usage = {
    accounting: aggregateCanonicalUsage([target.usage]),
    estimates: [
      {
        project_id: target.projectId,
        artifact_id: target.artifactId,
        estimate: estimateArtifactUsage(target.usage.events, target.artifactId),
      },
    ],
    sources: [{ project_id: target.projectId, counters: target.counters }],
  };
  const artifact = {
    project_id: target.projectId,
    id: target.artifactId,
    branch: thread.plan!.branch,
    label: thread.plan!.label,
    task: thread.plan!.task,
    state: thread.artifactJson!.state,
    started_at: thread.plan!.started_at,
    completed_at: thread.summary?.ts ?? null,
    plan: thread.plan,
    plan_revisions: historyPlanRevisions(thread),
    checkpoints: thread.checkpoints,
    summary: thread.summary,
    evaluator_log: thread.evaluatorLog,
    branch_lineage: thread.artifactJson!.branch_lineage,
    lineage_sha_drift:
      lineage && git?.headOid && lineage.head_sha !== git.headOid
        ? { branch: git.branch!, recorded_sha: lineage.head_sha, current_sha: git.headOid }
        : null,
    repo_state: gitContext.value,
    git_context: gitContext,
    usage,
    source_plan: sourcePlanView(thread.artifactJson!.source_plan ?? null),
    origin: thread.plan!.origin ?? null,
    source_version: target.artifact.revision,
    execution: target.execution?.state ?? null,
    related_evidence: target.repoEvidence,
  };
  const result = {
    schema_version: 3 as const,
    scope: {
      kind: scope.kind,
      selection: scope.selection,
      root_key: scope.root.rootKey,
      authorities: scope.projects.map((project) => ({
        project_id: project.projectId,
        store_instance_id: project.authority?.storeInstanceId ?? null,
        state: project.database === null ? 'unavailable' : 'available',
      })),
      worktree_id: git?.worktreeId ?? null,
      branch: structuredClone(scope.branch),
    },
    code_revision: git?.headOid ?? null,
    artifact,
    results: [artifact],
    sources: [{ project_id: target.projectId, counters: target.counters }],
    completeness: structuredClone(scope.completeness),
    integrity: { source_observation: 'read-transaction' as const },
  };
  return redact ? redactSecretsInObject(result) : result;
}
