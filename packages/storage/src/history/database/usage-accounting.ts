import {
  AgentUsageSnapshotPayloadSchema,
  SourcePlanLinkPayloadSchema,
} from '../../schema/usage-ledger.js';
import {
  aggregateCanonicalUsage,
  estimateArtifactUsage,
  type UsageAccountingEvent,
  type UsageAccountingInput,
  type UsageAccountingResult,
  usageSessionKey,
} from '../usage-accounting.js';
import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { assertUsageAccountingRows } from './usage-selection.js';

export interface UsageSession {
  agent: string;
  sessionId: string;
}
export interface ProjectUsageAccountingInput extends UsageAccountingInput {
  counters: ProjectCounters;
}
export interface UsageAccountingSelection {
  artifactIds?: readonly string[];
  expectedWriteSequence?: number;
}
export interface UsageAccountingReadSelection extends UsageAccountingSelection {
  sessions?: readonly UsageSession[];
}
function artifactSelection(input: UsageAccountingSelection): readonly string[] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide usage accounting selection options');
  const ids = input.artifactIds;
  if (ids === undefined) return undefined;
  if (
    !Array.isArray(ids) ||
    !Array.from(ids).every((id) => typeof id === 'string' && id.length > 0)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select nonempty artifact identifiers for usage accounting'
    );
  return [...new Set(ids)];
}
function selectedSessions(
  view: ProjectReadView,
  ids: readonly string[] | undefined
): UsageSession[] {
  if (ids === undefined)
    return view.all<UsageSession>(
      'SELECT DISTINCT agent, session_id AS sessionId FROM usage_snapshots ORDER BY agent, session_id'
    );
  if (!ids.length) return [];
  const sessions = new Map<string, UsageSession>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const placeholders = batch.map(() => '?').join(',');
    for (const session of view.all<UsageSession>(
      `SELECT agent, session_id AS sessionId FROM usage_snapshots WHERE artifact_id IN (${placeholders})
      UNION SELECT s.agent, s.session_id AS sessionId FROM usage_snapshots s JOIN usage_events e ON e.event_id = s.event_id
        JOIN usage_links l ON l.canonical_ref_id = s.source_plan_ref_id
        WHERE l.artifact_id IN (${placeholders}) AND e.recorded_at <= l.linked_at`,
      ...batch,
      ...batch
    ))
      sessions.set(usageSessionKey(session.agent, session.sessionId), session);
  }
  return [...sessions.values()];
}
interface AccountingRow {
  eventId: string;
  recordedAt: string;
  idempotencyKey: string;
  checksum: string;
  completeness: string;
  eventIdentity: string;
  snapshotIdentity: string;
}
interface SnapshotRow extends AccountingRow {
  snapshotId: string;
  agent: string;
  sessionId: string;
  artifactId: string | null;
  sourcePlanRefId: string | null;
  lifecycleEvent: string;
  checkpointN: number | null;
  baselineKind: string;
  recordCount: number;
  asOf: string;
  cumulative: string;
  delta: string;
  modelBreakdown: string;
}
interface LinkRow extends AccountingRow {
  canonicalRefId: string;
  artifactId: string;
  linkedAt: string;
  pinnedVersion: string | null;
}
const envelopeColumns = `e.event_id AS eventId, e.recorded_at AS recordedAt, e.idempotency_key AS idempotencyKey,
  e.checksum, e.completeness_json AS completeness, e.event_identity AS eventIdentity, e.snapshot_identity AS snapshotIdentity`;
export function selectProjectUsageAccounting(
  view: ProjectReadView,
  ids: readonly string[] | undefined,
  sessions?: readonly UsageSession[]
) {
  assertUsageAccountingRows(view);
  const selected = sessions ?? selectedSessions(view, ids);
  const snapshots: SnapshotRow[] = [];
  // Fixed-size batches avoid SQLite parameter limits while retaining tuple identity.
  for (let offset = 0; offset < selected.length; offset += 200) {
    const batch = selected.slice(offset, offset + 200);
    snapshots.push(
      ...view.all<SnapshotRow>(
        `SELECT ${envelopeColumns}, s.snapshot_id AS snapshotId, s.agent, s.session_id AS sessionId,
      s.artifact_id AS artifactId, s.source_plan_ref_id AS sourcePlanRefId, s.lifecycle_event AS lifecycleEvent,
      s.checkpoint_n AS checkpointN, s.baseline_kind AS baselineKind, s.record_count AS recordCount, s.as_of AS asOf,
      s.cumulative_json AS cumulative, s.delta_json AS delta, s.model_breakdown_json AS modelBreakdown
      FROM usage_snapshots s JOIN usage_events e ON e.event_id = s.event_id
      WHERE (s.agent, s.session_id) IN (VALUES ${batch.map(() => '(?, ?)').join(',')}) ORDER BY e.ordinal`,
        ...batch.flatMap((session) => [session.agent, session.sessionId])
      )
    );
  }
  const links: LinkRow[] = [];
  const batches =
    ids === undefined
      ? [undefined]
      : Array.from({ length: Math.ceil(ids.length / 400) }, (_, index) =>
          ids.slice(index * 400, (index + 1) * 400)
        );
  for (const batch of batches)
    links.push(
      ...view.all<LinkRow>(
        `SELECT ${envelopeColumns}, l.canonical_ref_id AS canonicalRefId,
    l.artifact_id AS artifactId, l.linked_at AS linkedAt, l.pinned_version AS pinnedVersion
    FROM usage_links l JOIN usage_events e ON e.event_id = l.event_id
    ${batch === undefined ? '' : `WHERE l.artifact_id IN (${batch.map(() => '?').join(',')})`} ORDER BY e.ordinal`,
        ...(batch ?? [])
      )
    );
  return { snapshots, links };
}
function event(
  row: AccountingRow,
  type: 'agent_usage_snapshot_recorded' | 'source_plan_linked',
  payload: unknown
): UsageAccountingEvent {
  const completeness: unknown = JSON.parse(row.completeness);
  if (
    !/^[a-f0-9]{64}$/.test(row.eventIdentity) ||
    !/^[a-f0-9]{64}$/.test(row.snapshotIdentity) ||
    !completeness ||
    typeof completeness !== 'object' ||
    !('state' in completeness) ||
    !['complete', 'incomplete'].includes(String(completeness.state)) ||
    !('reasons' in completeness) ||
    !Array.isArray(completeness.reasons) ||
    !completeness.reasons.every((reason) => typeof reason === 'string')
  )
    throw new Error('Retained accounting identity or completeness is invalid');
  return {
    record: {
      event_id: row.eventId,
      type,
      ts: row.recordedAt,
      schema_version: 1,
      idempotency_key: row.idempotencyKey,
      checksum: row.checksum,
      payload,
    },
    payload,
    completeness: completeness as UsageAccountingEvent['completeness'],
    eventIdentity: row.eventIdentity,
    snapshotIdentity: row.snapshotIdentity,
  };
}
export function hydrateProjectUsageAccounting(
  projectId: string,
  ids: readonly string[] | undefined,
  materialized: {
    value: ReturnType<typeof selectProjectUsageAccounting>;
    counters: ProjectCounters;
  }
): ProjectUsageAccountingInput {
  try {
    const events = materialized.value.snapshots.map((row) =>
      event(
        row,
        'agent_usage_snapshot_recorded',
        AgentUsageSnapshotPayloadSchema.parse({
          snapshot_id: row.snapshotId,
          idempotency_key: row.idempotencyKey,
          agent: row.agent,
          session_id: row.sessionId,
          artifact_id: row.artifactId,
          source_plan_ref_id: row.sourcePlanRefId,
          lifecycle_event: row.lifecycleEvent,
          checkpoint_n: row.checkpointN,
          cumulative_usage: JSON.parse(row.cumulative),
          delta_usage: JSON.parse(row.delta),
          baseline_kind: row.baselineKind,
          model_breakdown: JSON.parse(row.modelBreakdown),
          record_count: row.recordCount,
          as_of: row.asOf,
        })
      )
    );
    events.push(
      ...materialized.value.links.map((row) =>
        event(
          row,
          'source_plan_linked',
          SourcePlanLinkPayloadSchema.parse({
            canonical_ref_id: row.canonicalRefId,
            artifact_id: row.artifactId,
            linked_at: row.linkedAt,
            pinned_version: row.pinnedVersion,
          })
        )
      )
    );
    return {
      projectId,
      ...(ids === undefined ? {} : { artifactIds: [...ids] }),
      events,
      counters: materialized.counters,
    };
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained usage accounting rows are invalid; preserve history and explicitly rebuild derived accounting from retained events',
      { cause }
    );
  }
}
function expectedSequence(input: UsageAccountingSelection): number | undefined {
  const sequence = input.expectedWriteSequence;
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Expected write sequence must be a nonnegative safe integer'
    );
  return sequence;
}
function assertExpectedSequence(expected: number | undefined, counters: ProjectCounters) {
  if (expected !== undefined && expected !== counters.writeSequence)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Project changed after usage selection; repeat the read for the original scope'
    );
}
export function discoverProjectUsageSessions(
  handle: ProjectDatabase,
  input: UsageAccountingSelection = {}
) {
  const ids = artifactSelection(input);
  const expected = expectedSequence(input);
  assertProjectDatabasePath(handle);
  const selected = handle.read((view) => {
    assertUsageAccountingRows(view);
    return selectedSessions(view, ids);
  });
  assertExpectedSequence(expected, selected.counters);
  return { sessions: selected.value, counters: selected.counters };
}
export function readProjectUsageAccounting(
  handle: ProjectDatabase,
  input: UsageAccountingReadSelection = {}
): ProjectUsageAccountingInput {
  const ids = artifactSelection(input);
  const expected = expectedSequence(input);
  let sessions: UsageSession[] | undefined;
  if (input.sessions !== undefined) {
    if (
      !Array.isArray(input.sessions) ||
      !Array.from(input.sessions).every(
        (session) =>
          session &&
          typeof session.agent === 'string' &&
          session.agent.length > 0 &&
          typeof session.sessionId === 'string' &&
          session.sessionId.length > 0
      )
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Select nonempty agent and session identifier pairs'
      );
    sessions = [
      ...new Map(
        input.sessions.map(({ agent, sessionId }) => [
          usageSessionKey(agent, sessionId),
          { agent, sessionId },
        ])
      ).values(),
    ];
  }
  assertProjectDatabasePath(handle);
  const materialized = handle.read((view) => selectProjectUsageAccounting(view, ids, sessions));
  assertExpectedSequence(expected, materialized.counters);
  return hydrateProjectUsageAccounting(handle.authority.projectId, ids, materialized);
}
export function aggregateProjectUsage(
  handles: readonly ProjectDatabase[],
  input: UsageAccountingSelection = {}
): UsageAccountingResult {
  const ids = artifactSelection(input);
  expectedSequence(input);
  if (!Array.isArray(handles))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the selected project database handles'
    );
  const projects: readonly ProjectDatabase[] = [...handles];
  projects.forEach(assertProjectDatabasePath);
  if (ids === undefined)
    return aggregateCanonicalUsage(
      projects.map((handle) => readProjectUsageAccounting(handle, input))
    );
  const discoveries = projects.map((handle) => discoverProjectUsageSessions(handle, input));
  const sessions = [
    ...new Map(
      discoveries
        .flatMap((discovery) => discovery.sessions)
        .map((session) => [usageSessionKey(session.agent, session.sessionId), session])
    ).values(),
  ];
  const inputs = projects.map((handle, index) =>
    readProjectUsageAccounting(handle, {
      artifactIds: ids,
      sessions,
      expectedWriteSequence: discoveries[index].counters.writeSequence,
    })
  );
  return aggregateCanonicalUsage(inputs);
}
export function estimateProjectArtifactUsage(
  input: ProjectUsageAccountingInput,
  artifactId: string
): ReturnType<typeof estimateArtifactUsage> {
  if (typeof artifactId !== 'string' || !artifactId.length)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select a nonempty artifact identifier for the usage estimate'
    );
  return estimateArtifactUsage(input.events, artifactId);
}
