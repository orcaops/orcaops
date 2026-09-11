import { computeUnresolvedBlocks, nextActions, sourcePlanView } from '@orcaops/core';
import {
  HistoryScopeError,
  type HistorySelector,
  validateHistorySelector,
} from '@orcaops/project-scope/history';
import type { DatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { redactSecretsInObject } from '@orcaops/storage';
import {
  ProjectDatabaseError,
  readProjectCloudSyncStatus,
  readProjectTaskContext,
} from '@orcaops/storage/history/database';
import {
  assessExecutionEligibility,
  assessExecutionFocus,
  resolveShellKey,
} from '@orcaops/storage/history/execution-focus';
import { aggregateCanonicalUsage } from '@orcaops/storage/history/usage-accounting';

import type { DatabaseListContext } from './database-list.js';
import { renderNextActions } from './next-actions-render.js';
import { deriveThreadStatus } from './thread-status.js';

export interface DatabaseTaskOptions {
  scope?: HistorySelector['scope'];
  project?: string;
  branch?: string;
  json?: boolean;
}
export function validateDatabaseTaskOptions(raw: DatabaseTaskOptions = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide task context options as an object');
  for (const [key, value] of Object.entries(raw)) {
    if (
      !['scope', 'project', 'branch', 'json'].includes(key) ||
      (value !== undefined && typeof value !== (key === 'json' ? 'boolean' : 'string'))
    )
      throw new HistoryScopeError('INVALID_INPUT', 'Provide fixed task context selectors');
  }
  const options = { ...raw };
  const selector = { scope: options.scope, projectId: options.project, branch: options.branch };
  validateHistorySelector({ profile: 'status', selector });
  return { options, selector };
}

export function inspectDatabaseTasks(scope: DatabaseHistoryScope, env: NodeJS.ProcessEnv) {
  const shellKey = resolveShellKey({ env });
  const git = scope.gitContext;
  const issues = [...scope.completeness.issues];
  if (scope.branch.source === 'unavailable')
    issues.push({
      code: 'CURRENT_BRANCH_UNAVAILABLE',
      project_id: null,
      message:
        'Current branch is unavailable; displayed history does not establish current-branch task selection',
    });
  const projects = scope.projects.map((project) => {
    if (!project.database || !project.authority) {
      if (!issues.some((issue) => issue.project_id === project.projectId))
        issues.push({
          code: 'HISTORY_INACCESSIBLE',
          project_id: project.projectId,
          message: 'Selected project history is unavailable; preserve it for explicit repair',
        });
      return {
        project_id: project.projectId,
        available: false as const,
        snapshot: null,
        focus: null,
        candidates: [],
      };
    }
    const matchingGit =
      git?.repositoryInstanceId === project.authority.repositoryInstanceId ? git : null;
    const focusScope =
      matchingGit?.worktreeId && shellKey.kind !== 'none'
        ? {
            rootKey: project.authority.rootKey,
            projectId: project.projectId,
            storeInstanceId: project.authority.storeInstanceId,
            repositoryInstanceId: project.authority.repositoryInstanceId,
            worktreeId: matchingGit.worktreeId,
            shellKey,
          }
        : undefined;
    let snapshot: ReturnType<typeof readProjectTaskContext>;
    try {
      snapshot = readProjectTaskContext(project.database, {
        branch: scope.branch.value ?? undefined,
        worktreeId: scope.kind === 'worktree' ? (matchingGit?.worktreeId ?? undefined) : undefined,
        focusScope,
      });
    } catch (cause) {
      if (
        !(cause instanceof ProjectDatabaseError) ||
        ![
          'HISTORY_INTEGRITY_REQUIRED',
          'HISTORY_MISSING',
          'HISTORY_INACCESSIBLE',
          'CONVERSION_REQUIRED',
        ].includes(cause.code)
      )
        throw cause;
      issues.push({ code: cause.code, project_id: project.projectId, message: cause.message });
      return {
        project_id: project.projectId,
        available: false as const,
        snapshot: null,
        focus: null,
        candidates: [],
      };
    }
    if (snapshot.unknownAssociations > 0)
      issues.push({
        code: 'UNKNOWN_WORKTREE_ASSOCIATIONS',
        project_id: project.projectId,
        count: snapshot.unknownAssociations,
        message: 'Some retained artifacts have unknown worktree associations',
      });
    const candidates = snapshot.artifacts.map((artifact) => ({
      artifact_id: artifact.row.artifactId,
      label: artifact.row.label ?? artifact.row.task ?? artifact.row.artifactId,
      eligibility: assessExecutionEligibility({
        gitContext: matchingGit,
        candidate: {
          artifactId: artifact.row.artifactId,
          label: artifact.row.label ?? artifact.row.artifactId,
          executionState: artifact.execution,
        },
      }),
      binding: artifact.execution?.current_binding ?? null,
      binding_generation: artifact.execution?.binding_generation ?? null,
      execution_version: artifact.row.executionVersion,
    }));
    const focused = snapshot.focusedArtifact;
    const pin =
      snapshot.focus?.status === 'present'
        ? { status: 'present' as const, pin: snapshot.focus.pin }
        : { status: 'absent' as const };
    const assessment = assessExecutionFocus({
      authority: { ...project.authority, formatVersion: 1 },
      gitContext: matchingGit,
      shellKey,
      pin,
      candidate: focused
        ? {
            artifactId: focused.row.artifactId,
            label: focused.row.label ?? focused.row.artifactId,
            executionState: focused.execution,
          }
        : null,
    });
    const focusedEligibility = focused
      ? assessExecutionEligibility({
          gitContext: matchingGit,
          candidate: {
            artifactId: focused.row.artifactId,
            label: focused.row.label ?? focused.row.artifactId,
            executionState: focused.execution,
          },
        })
      : null;
    return {
      project_id: project.projectId,
      available: true as const,
      snapshot,
      focus: {
        status: snapshot.focus?.status ?? 'unavailable',
        selection: snapshot.focus?.selection ?? null,
        pin: pin.status === 'present' ? pin.pin : null,
        assessment,
        eligibility: focusedEligibility,
      },
      candidates,
    };
  });
  return {
    projects,
    issues,
    complete: scope.completeness.complete && issues.length === 0,
    context: { git, issues: scope.contextIssues, shell_key: shellKey },
  };
}

function cloudStatus(scope: DatabaseHistoryScope, now: number) {
  const unavailable = { state: 'unavailable' as const, pending_count: null, stuck_count: null };
  if (!scope.completeness.complete) return unavailable;
  try {
    const rows = scope.projects.flatMap((project) => {
      if (!project.database)
        throw new ProjectDatabaseError('HISTORY_MISSING', 'Project history is unavailable');
      return readProjectCloudSyncStatus(project.database)
        .rows.filter((row) => row.pending)
        .map((row) => ({ ...row, projectId: project.projectId }));
    });
    const key = (row: (typeof rows)[number]) => `${row.projectId}/${row.artifactId}`;
    const stuck = rows.filter((row) => row.consecutiveFailures > 0);
    const ages = rows.map((row) => Date.parse(row.startedAt)).filter(Number.isFinite);
    const last = [...stuck].sort(
      (a, b) =>
        (b.lastAttemptAt ?? '').localeCompare(a.lastAttemptAt ?? '') || key(a).localeCompare(key(b))
    )[0];
    return {
      state: 'available' as const,
      pending_count: new Set(rows.map(key)).size,
      stuck_count: new Set(stuck.map(key)).size,
      oldest_pending_age_seconds: ages.length
        ? Math.max(
            0,
            Math.round((now - ages.reduce((oldest, age) => Math.min(oldest, age), Infinity)) / 1000)
          )
        : null,
      last_failure: last
        ? {
            artifact_id: last.artifactId,
            project_id: last.projectId,
            target: last.target,
            kind: last.lastError?.kind ?? null,
            consecutive_failures: last.consecutiveFailures,
          }
        : null,
    };
  } catch (cause) {
    return {
      ...unavailable,
      issues: [
        {
          code: cause instanceof ProjectDatabaseError ? cause.code : 'INTERNAL',
          message: 'Cloud upload history could not be read; inspect push-status for details.',
        },
      ],
    };
  }
}

export function readDatabaseStatus(
  context: DatabaseListContext,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
  acknowledgeByRef?: (ref: string) => boolean
) {
  const inspection = inspectDatabaseTasks(context.scope, env);
  const artifacts = inspection.projects.flatMap(
    (project) =>
      project.snapshot?.artifacts.map((artifact) => {
        const { row, details, lifecycles } = artifact;
        const thread = deriveThreadStatus({
          artifact: {
            id: row.artifactId,
            task: details.task,
            branch: row.branch,
            status: row.completedAt !== null ? 'complete' : 'active',
            started_at: row.startedAt,
            completed_at: row.completedAt,
          },
          planStepCount: details.planStepIds.length,
          checkpoints: [
            ...details.closedCheckpoints.map((cp) => ({ ...cp, status: 'closed' })),
            ...details.openCheckpoints,
          ],
          hasSummary: row.completedAt !== null,
          lifecycles: lifecycles.map((entry) => entry.record),
          evaluatorRuns: details.evaluatorRuns,
        });
        const actions = databaseTaskActions(
          row.artifactId,
          row.state,
          row.checkpointCount,
          details,
          context.scope.gitContext?.headOid ?? '',
          acknowledgeByRef
        );
        const { status: _status, ...publicThread } = thread;
        return {
          ...publicThread,
          project_id: project.project_id,
          label: row.label,
          state: row.state,
          origin: row.origin,
          open_checkpoints: details.openCheckpoints.map((cp) => ({
            ...cp,
            idle_for_seconds: Math.max(0, Math.round((now - Date.parse(cp.opened_at)) / 1000)),
          })),
          source_plan: sourcePlanView(details.sourcePlan),
          next_actions: actions,
          digest_cache: { state: 'unavailable' as const },
          execution: project.candidates.find(
            (candidate) => candidate.artifact_id === row.artifactId
          ),
          source_versions: {
            revision: { generation: row.generation, orderedHash: row.orderedHash },
            execution: row.executionVersion,
          },
        };
      }) ?? []
  );
  const eligibilityAvailable =
    inspection.complete &&
    !!context.scope.gitContext?.branch &&
    !!context.scope.gitContext?.repositoryInstanceId &&
    !!context.scope.gitContext?.worktreeId;
  const output = {
    schema_version: 3,
    scope: {
      kind: context.scope.kind,
      selection: context.scope.selection,
      branch: context.scope.branch,
    },
    branch: context.scope.branch.value,
    context: inspection.context,
    history: {
      state: inspection.complete
        ? 'available'
        : inspection.issues.some((issue) => issue.code === 'HISTORY_INTEGRITY_REQUIRED')
          ? 'integrity'
          : 'unavailable',
      complete: inspection.complete,
      issues: inspection.issues,
      projects: inspection.projects.map((project) => ({
        project_id: project.project_id,
        available: project.available,
        counters: project.snapshot?.counters ?? null,
      })),
    },
    focus: inspection.projects.map((project) => ({
      project_id: project.project_id,
      ...project.focus,
    })),
    binding: inspection.projects.flatMap((project) =>
      project.candidates.map((candidate) => ({
        project_id: project.project_id,
        artifact_id: candidate.artifact_id,
        value: candidate.binding,
        generation: candidate.binding_generation,
        execution_version: candidate.execution_version,
        eligibility: {
          state: candidate.eligibility.valid ? 'eligible' : 'ineligible',
          reason: candidate.eligibility.reason,
        },
      }))
    ),
    eligibility: {
      state: eligibilityAvailable ? 'available' : 'unavailable',
      reason: eligibilityAvailable
        ? null
        : (inspection.issues[0]?.code ?? 'GIT_CONTEXT_UNAVAILABLE'),
    },
    eligible_tasks: !eligibilityAvailable
      ? []
      : inspection.projects.flatMap((project) =>
          project.candidates
            .filter((candidate) => candidate.eligibility.valid)
            .map((candidate) => ({ project_id: project.project_id, ...candidate }))
        ),
    artifacts: artifacts.filter((artifact) => artifact.origin === 'captured'),
    imported_artifacts: {
      count: inspection.complete
        ? artifacts.filter((artifact) => artifact.origin === 'git-import').length
        : null,
      known_count: artifacts.filter((artifact) => artifact.origin === 'git-import').length,
      artifacts: artifacts.filter((artifact) => artifact.origin === 'git-import'),
    },
    coding_sessions: inspection.projects.map((project) => ({
      project_id: project.project_id,
      accounting: project.snapshot ? aggregateCanonicalUsage([project.snapshot.usage]) : null,
    })),
    cloud_sync: cloudStatus(context.scope, now),
  };
  return context.config.digest.redact_secrets ? redactSecretsInObject(output) : output;
}

export function databaseTaskActions(
  artifactId: string,
  state: 'planned' | 'active' | 'blocked' | 'summarized',
  checkpointCount: number,
  details: Pick<
    ReturnType<typeof readProjectTaskContext>['artifacts'][number]['details'],
    | 'closedCheckpoints'
    | 'openCheckpoints'
    | 'evaluatorRuns'
    | 'artifactSourceEventId'
    | 'prePrCheckedHeadSha'
    | 'prePrCheckedSourceEventId'
    | 'planStepIds'
  >,
  headSha: string,
  acknowledgeByRef?: (ref: string) => boolean
) {
  const closed = new Set(details.closedCheckpoints.flatMap((cp) => cp.completed_step_ids));
  const claimed = new Set([
    ...closed,
    ...details.openCheckpoints.flatMap((cp) => cp.declared_step_ids),
  ]);
  const blocks = computeUnresolvedBlocks(details.evaluatorRuns, acknowledgeByRef);
  if (state === 'summarized' && !blocks.length) return [];
  // Cache eligibility is unavailable; only task/blocked branches of the pure producer run here.
  return renderNextActions(
    nextActions({
      artifact_id: artifactId,
      state,
      current_head_sha: headSha,
      artifact_source_event_id: details.artifactSourceEventId,
      pre_pr_checked_head_sha: details.prePrCheckedHeadSha,
      pre_pr_checked_source_event_id: details.prePrCheckedSourceEventId,
      digest_present: false,
      digest_source_event_id: null,
      digest_usage_fingerprint: null,
      live_usage_fingerprint: '',
      open_checkpoints: details.openCheckpoints,
      uncovered_step_ids: details.planStepIds.filter((id) => !claimed.has(id)),
      plan_coverage_complete:
        details.planStepIds.length > 0 && details.planStepIds.every((id) => closed.has(id)),
      unresolved_blocks: blocks,
      no_checkpoints_yet: checkpointCount === 0,
    })
  );
}
