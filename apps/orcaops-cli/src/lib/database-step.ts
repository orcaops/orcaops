import {
  HistoryScopeError,
  unavailableProjectError,
  validateHistorySelector,
} from '@orcaops/project-scope/history';
import {
  type DatabaseHistoryScope,
  hydrateDatabaseHistorySelection,
} from '@orcaops/project-scope/history/database';
import { type Config, type Plan, redactSecretsInObject } from '@orcaops/storage';
import {
  type ProjectArtifactQueryRow,
  readProjectStepMembership,
} from '@orcaops/storage/history/database';

import { historyPlanRevisions } from './history-read-model.js';
import { buildStepBrief, renderStepBrief, type StepView } from './history-views.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface DatabaseStepBriefOptions {
  artifact?: string;
  project?: string;
  json?: boolean;
}
export interface DatabaseStepBriefContext {
  scope: DatabaseHistoryScope;
  config: Pick<Config, 'digest'>;
}

export function validateDatabaseStepBrief(stepId: string, input: DatabaseStepBriefOptions = {}) {
  if (typeof stepId !== 'string' || stepId.trim().length === 0 || stepId.includes('\0'))
    throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'step brief requires a <step_id>.', 'step_id');
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide step brief options as an object');
  for (const [key, value] of Object.entries(input)) {
    if (!['artifact', 'project', 'json'].includes(key))
      throw new HistoryScopeError('INVALID_INPUT', 'Unsupported or retired step brief option');
    if (value !== undefined && typeof value !== (key === 'json' ? 'boolean' : 'string'))
      throw new HistoryScopeError(
        'INVALID_INPUT',
        'Step brief selectors must be strings and JSON output boolean'
      );
  }
  if (input.artifact !== undefined && !/^[0-9a-f-]{1,36}$/i.test(input.artifact))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide an artifact UUID or hexadecimal prefix');
  const selector = { projectId: input.project };
  validateHistorySelector({ profile: 'exact', selector });
  return {
    stepId,
    options: { ...input },
    selector,
    profile: 'exact' as const,
    json: input.json === true,
  };
}

function stepViews(plan: Plan): StepView[] {
  return plan.plan_steps.map((step, index) => ({ ...step, idx: index + 1 }));
}

export function readDatabaseStepBrief(
  context: DatabaseStepBriefContext,
  stepId: string,
  input: DatabaseStepBriefOptions = {}
) {
  const prepared = validateDatabaseStepBrief(stepId, input);
  const scope = context.scope;
  if (scope.kind === 'all-projects' || scope.projects.length !== 1)
    throw new HistoryScopeError('PROJECT_REQUIRED', 'Step briefs require one selected project');
  const project = scope.projects[0];
  if (
    prepared.selector.projectId !== undefined &&
    prepared.selector.projectId !== project.projectId
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'Step brief options differ from the opened history scope'
    );
  const { database, authority } = project;
  if (!database || !authority) throw unavailableProjectError(project.completeness.issues);
  if (
    database.authority.projectId !== project.projectId ||
    database.authority.storeInstanceId !== authority.storeInstanceId ||
    database.authority.rootKey !== scope.root.rootKey ||
    database.authority.resolvedRoot !== scope.root.resolvedRoot
  )
    throw new HistoryScopeError(
      'AUTHORITY_MISMATCH',
      'Resolve the original project and store before reading this step'
    );
  const projectId = project.projectId;
  const membership = readProjectStepMembership(database, stepId);
  const candidates = membership.artifacts;
  const ids = candidates.map((row) => row.artifactId);
  if (candidates.length === 0)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No plan step with step_id "${stepId}" in any captured artifact of project ${projectId}.`,
      'step_id'
    );
  const ambiguous = (rows: ProjectArtifactQueryRow[]) =>
    new HistoryScopeError(
      'AMBIGUOUS_ARTIFACT',
      `step_id "${stepId}" appears in ${rows.length} artifacts (${rows.map((row) => row.artifactId).join(', ')}). Pass --artifact <id> to disambiguate.`,
      {
        candidates: rows.map((row) => ({
          project_id: projectId,
          artifact_id: row.artifactId,
          command: `orcaops step brief ${stepId} --artifact ${row.artifactId} --project ${projectId}`,
        })),
        truncated: false,
      }
    );
  let selected: ProjectArtifactQueryRow;
  if (prepared.options.artifact !== undefined) {
    const requested = prepared.options.artifact.toLowerCase();
    const exact = candidates.filter((row) => row.artifactId === requested);
    const matches = exact.length
      ? exact
      : candidates.filter((row) => row.artifactId.startsWith(requested));
    if (matches.length === 0)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Artifact "${prepared.options.artifact}" has no plan step "${stepId}" (found in: ${ids.join(', ')}).`,
        'artifact'
      );
    if (matches.length > 1) throw ambiguous(matches);
    selected = matches[0];
  } else {
    if (candidates.length > 1) throw ambiguous(candidates);
    selected = candidates[0];
  }
  // Exactly one thread is decoded: the revision and execution version selected
  // at lookup, so a concurrent publication surfaces as STALE_CONTEXT.
  const [detail] = hydrateDatabaseHistorySelection(scope, [
    { projectId, storeInstanceId: database.authority.storeInstanceId, row: selected },
  ]);
  const thread = detail.artifact!.thread;
  const latest = thread.plan!;
  const revisions = historyPlanRevisions(thread);
  const historical = [...revisions]
    .reverse()
    .find((plan) => plan.plan_steps.some((step) => step.step_id === stepId));
  if (!historical)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `step_id "${stepId}" is indexed for artifact "${selected.artifactId}" but no retained plan revision contains it — explicitly rebuild derived metadata.`,
      'step_id'
    );
  const inLatest = latest.plan_steps.some((step) => step.step_id === stepId);
  const closed = thread.checkpoints.filter((checkpoint) => checkpoint.status === 'closed');
  const open = thread.checkpoints.filter((checkpoint) => checkpoint.status === 'open');
  const brief = buildStepBrief({
    artifactId: selected.artifactId,
    stepId,
    origin: latest.origin?.kind ?? null,
    latest: {
      revision_n: latest.revision_n,
      steps: stepViews(latest),
      non_goals: latest.non_goals,
      touched_scope: latest.touched_scope,
    },
    lastPresent: inLatest
      ? null
      : {
          revision_n: historical.revision_n,
          step: stepViews(historical).find((step) => step.step_id === stepId)!,
        },
    claims: {
      closedClaimed: [
        ...new Set(closed.flatMap((checkpoint) => checkpoint.completed_step_ids)),
      ].sort(),
      openDeclared: open.map((checkpoint) => ({
        n: checkpoint.n,
        declared: [...checkpoint.declared_step_ids],
      })),
    },
    closedCheckpoints: closed.map((checkpoint) => ({
      n: checkpoint.n,
      closed_at: checkpoint.closed_at,
      summary: checkpoint.summary,
      completed_step_ids: checkpoint.completed_step_ids,
      done_criteria: checkpoint.done_criteria,
    })),
  });
  const output = {
    schema_version: 3 as const,
    scope: {
      kind: scope.kind,
      selection: scope.selection,
      root_key: scope.root.rootKey,
      authorities: scope.projects.map((entry) => ({
        project_id: entry.projectId,
        store_instance_id: entry.authority?.storeInstanceId ?? null,
        state: entry.database === null ? 'unavailable' : 'available',
      })),
      worktree_id: scope.gitContext?.worktreeId ?? null,
      branch: { ...scope.branch },
    },
    code_revision: scope.gitContext?.headOid ?? null,
    project_id: projectId,
    ...brief,
    candidates: ids,
    source_version: {
      artifact: detail.artifact!.revision,
      execution: detail.execution?.version ?? null,
    },
    sources: [
      {
        project_id: projectId,
        store_instance_id: database.authority.storeInstanceId,
        lookup_write_sequence: membership.counters.writeSequence,
        counters: { ...detail.counters },
      },
    ],
    completeness: structuredClone(scope.completeness),
    integrity: {
      source_observation: 'read-transaction' as const,
      selection: 'verified-revisions' as const,
    },
  };
  return context.config.digest.redact_secrets ? redactSecretsInObject(output) : output;
}
export type DatabaseStepBriefResult = ReturnType<typeof readDatabaseStepBrief>;

export function formatDatabaseStepBrief(result: DatabaseStepBriefResult): string {
  const lines = [renderStepBrief(result).trimEnd()];
  if (result.candidates.length > 1)
    lines.push(`  candidates:   ${result.candidates.join(', ')} (selected ${result.artifact_id})`);
  for (const issue of result.completeness.issues)
    lines.push(`  ${issue.project_id ?? 'scope'}: ${issue.code}: ${issue.message}`);
  return lines.join('\n') + '\n';
}
