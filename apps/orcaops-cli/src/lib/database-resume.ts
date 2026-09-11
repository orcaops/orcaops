import { isDeepStrictEqual } from 'node:util';

import { buildResumeFromSnapshot } from '@orcaops/core';
import { HistoryScopeError, validateHistorySelector } from '@orcaops/project-scope/history';
import { resolveDatabaseHistoryOverview } from '@orcaops/project-scope/history/database';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';
import {
  assessExecutionEligibility,
  resolveShellKey,
  selectExecutionArtifact,
} from '@orcaops/storage/history/execution-focus';
import { historyMetadataDetails } from '@orcaops/storage/history/metadata-row';

import type { resolveDatabaseHistoryCommandContext } from './database-history-context.js';
import { readDatabaseShowTarget } from './database-show.js';
import { databaseTaskActions, inspectDatabaseTasks } from './database-task-context.js';

export interface DatabaseResumeOptions {
  artifact?: string;
  project?: string;
  branch?: string;
  copy?: boolean;
  format?: 'md' | 'json';
  json?: boolean;
}
export function validateDatabaseResume(raw: DatabaseResumeOptions = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide resume options as an object');
  let options: DatabaseResumeOptions;
  try {
    options = structuredClone(raw);
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide copyable passive resume selectors', {
      cause,
    });
  }
  if (
    Object.getPrototypeOf(options) !== Object.prototype &&
    Object.getPrototypeOf(options) !== null
  )
    throw new HistoryScopeError('INVALID_INPUT', 'Provide plain passive resume selectors');
  for (const [key, value] of Object.entries(options)) {
    if (
      !['artifact', 'project', 'branch', 'copy', 'format', 'json'].includes(key) ||
      (value !== undefined &&
        typeof value !== (key === 'copy' || key === 'json' ? 'boolean' : 'string'))
    )
      throw new HistoryScopeError(
        'INVALID_INPUT',
        'Provide passive resume selectors; automatic pinning and restoration are retired'
      );
  }
  if (options.format !== undefined && !['md', 'json'].includes(options.format))
    throw new HistoryScopeError('INVALID_INPUT', 'Resume format must be md or json');
  if (options.artifact !== undefined && !/^[0-9a-f-]{1,36}$/i.test(options.artifact))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide an artifact UUID or hexadecimal prefix');
  const selector = { projectId: options.project, branch: options.branch };
  validateHistorySelector({ profile: 'resume', selector });
  return { options, selector };
}

export async function readDatabaseResume(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  raw: DatabaseResumeOptions,
  env: NodeJS.ProcessEnv,
  acknowledgeByRef?: (ref: string) => boolean
) {
  const { options } = validateDatabaseResume(raw);
  const scope = context.scope;
  const shellKey = resolveShellKey({ env });
  let requested = options.artifact;
  let via: 'explicit' | 'pin' | 'unique' = 'explicit';
  let selected: {
    row: NonNullable<
      ReturnType<typeof inspectDatabaseTasks>['projects'][number]['snapshot']
    >['artifacts'][number]['row'];
    writeSequence: number;
  } | null = null;
  if (requested === undefined) {
    if (scope.projects.length !== 1 || !scope.projects[0].authority)
      throw new HistoryScopeError(
        scope.completeness.issues[0]?.code ?? 'PROJECT_REQUIRED',
        'Implicit resume requires one available original project',
        { issues: scope.completeness.issues }
      );
    const taskScope = {
      ...scope,
      branch:
        options.branch !== undefined
          ? scope.branch
          : {
              value: scope.gitContext?.branch ?? null,
              source: scope.gitContext?.branch ? ('current' as const) : ('unavailable' as const),
            },
    };
    const inspection = inspectDatabaseTasks(taskScope, env);
    const project = inspection.projects[0];
    const snapshot = project.snapshot;
    const selection = selectExecutionArtifact({
      authority: { ...scope.projects[0].authority, formatVersion: 1 },
      gitContext: scope.gitContext,
      shellKey,
      candidates:
        snapshot?.artifacts.map((artifact) => ({
          artifactId: artifact.row.artifactId,
          label: artifact.row.label ?? artifact.row.task ?? artifact.row.artifactId,
          executionState: artifact.execution,
        })) ?? [],
      pin:
        snapshot?.focus?.status === 'present'
          ? { status: 'present', pin: snapshot.focus.pin }
          : { status: 'absent' },
      complete: inspection.complete,
    });
    if (!selection.selected)
      return {
        resolved: false as const,
        schema_version: 3 as const,
        reason: selection.error,
        artifact: null,
        candidates: selection.candidates.map((candidate) => ({
          project_id: project.project_id,
          artifact_id: candidate.artifactId,
          label: candidate.label,
          eligibility: candidate.eligibility,
          command: `orcaops resume --artifact ${candidate.artifactId} --project ${project.project_id}`,
        })),
        focus: project.focus,
        history: { complete: inspection.complete, issues: inspection.issues },
        next_actions: [],
      };
    requested = selection.selected.artifactId;
    via = selection.source === 'pin' ? 'pin' : 'unique';
    selected = {
      row: snapshot!.artifacts.find((artifact) => artifact.row.artifactId === requested)!.row,
      writeSequence: snapshot!.counters.writeSequence,
    };
  }
  const target = resolveDatabaseHistoryOverview(scope, requested);
  if (selected) {
    const row = selected.row;
    const revision = {
      generation: row.generation,
      orderedHash: row.orderedHash,
      eventCount: row.eventCount,
      byteLength: row.byteLength,
      tailEventId: row.tailEventId,
    };
    if (
      !isDeepStrictEqual(target.artifact.revision, revision) ||
      (target.execution?.version ?? null) !== row.executionVersion ||
      target.counters.writeSequence !== selected.writeSequence
    )
      throw new ProjectDatabaseError(
        'STALE_CONTEXT',
        'Task selection changed before resume hydration; repeat the original selection'
      );
  }
  const thread = target.artifact.thread;
  const eligibility = assessExecutionEligibility({
    candidate: {
      artifactId: target.artifactId,
      label: thread.plan!.label ?? thread.plan!.task,
      executionState: target.execution?.state ?? null,
    },
    gitContext: scope.gitContext,
  });
  const rendered = buildResumeFromSnapshot({
    artifactId: target.artifactId,
    plan: thread.plan,
    checkpoints: thread.checkpoints,
    summary: thread.summary,
    redactSecrets: context.config.digest.redact_secrets,
  });
  const details = historyMetadataDetails(thread, target.execution?.state ?? null);
  const actions = databaseTaskActions(
    target.artifactId,
    thread.artifactJson!.state,
    thread.checkpoints.length,
    details,
    scope.gitContext?.headOid ?? '',
    acknowledgeByRef
  );
  const shown = await readDatabaseShowTarget(context, target);
  return {
    schema_version: 3 as const,
    resolved: true as const,
    resolution_via: via,
    artifact_id: target.artifactId,
    project_id: target.projectId,
    plan_event_id: rendered.data.plan_event_id,
    eligibility: {
      state: eligibility.valid ? 'eligible' : 'ineligible',
      reason: eligibility.reason,
    },
    source_versions: {
      artifact: target.artifact.revision,
      execution: target.execution?.version ?? null,
    },
    next_actions: actions,
    digest_cache: { state: 'unavailable' as const },
    artifact: {
      ...rendered.data,
      origin: shown.artifact.origin,
      source_plan: shown.artifact.source_plan,
      repo_state: shown.artifact.repo_state,
      git_context: shown.artifact.git_context,
      usage: shown.artifact.usage,
      lineage_sha_drift: shown.artifact.lineage_sha_drift,
      branch_lineage: shown.artifact.branch_lineage,
    },
    markdown: rendered.markdown,
    completeness: shown.completeness,
  };
}
