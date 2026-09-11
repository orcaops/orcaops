import {
  type PreparedExecutionQueryMetadata,
  prepareExecutionQueryMetadata,
  replaceExecutionQueryMetadata,
} from './query-metadata-records.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';
import { digest } from '../event-integrity.js';
import { type ExecutionState, ExecutionStateSchema } from '../execution-schema.js';
import { type ArtifactRevision, copyArtifactRevision } from './artifacts.js';
import type { ProjectCounters, ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import type { ProjectSettlement } from './transactions.js';

export interface ProjectExecutionSnapshot {
  state: ExecutionState;
  version: number;
  counters: ProjectCounters;
}
interface RetainedRow {
  ordinal: number;
  bytes: string;
  hash: string;
  identity: string;
  generation?: number;
  repository?: string;
  position?: number;
  checkpoint?: string;
  takeover?: string;
}
const families = [
  ['execution_transitions', 'operation_id AS identity, generation'],
  [
    'execution_associations',
    'worktree_id AS identity, repository_instance_id AS repository, association_position AS position',
  ],
  [
    'execution_checkpoint_attributions',
    'checkpoint_event_id AS identity, binding_generation AS generation',
  ],
  [
    'execution_checkpoint_recoveries',
    'operation_id AS identity, checkpoint_event_id AS checkpoint, takeover_operation_id AS takeover',
  ],
] as const;

function invalid(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Selected execution records are missing or inconsistent; preserve history for explicit repair',
    { cause }
  );
}

export function readProjectExecution(
  handle: ProjectDatabase,
  artifactId: string
): ProjectExecutionSnapshot | null {
  if (!isUuidV7(artifactId))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select an exact artifact UUID');
  const read = handle.read((view) => selectProjectExecutionRecords(view, artifactId));
  return hydrateProjectExecutionRecords(artifactId, read.value, read.counters);
}

export function hydrateProjectExecutionRecords(
  artifactId: string,
  selected: ReturnType<typeof selectProjectExecutionRecords>,
  counters: ProjectCounters
): ProjectExecutionSnapshot | null {
  if (!selected) return null;
  const { initial, current, rows, checkpointIds } = selected;
  try {
    const decoded = rows.map((records) =>
      records.map((row, index) => {
        const bytes = Buffer.from(row.bytes, 'hex');
        if (row.ordinal !== index + 1 || digest(bytes) !== row.hash) invalid();
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      })
    );
    const transitions = decoded[0] as ExecutionState['binding_history'];
    const latest = transitions.at(-1);
    if (!latest) invalid();
    const outcomes = decoded[3] as ExecutionState['checkpoint_recovery_history'];
    const latestOutcomes = new Map(
      outcomes
        .filter((row) => row.takeover_operation_id === latest.operation_id)
        .map((row) => [row.checkpoint_event_id, row.action])
    );
    const verified = latest.checkpoint_ids.filter(
      (id) => latestOutcomes.get(id) === 'verified_continuation'
    );
    const abandoned = latest.checkpoint_ids.filter(
      (id) => latestOutcomes.get(id) === 'administrative_abandon'
    );
    const pending = latest.checkpoint_ids.length > verified.length + abandoned.length;
    const completed =
      latest.action === 'completed' ||
      (latest.action === 'unbound' && latest.reason === 'completed');
    if (
      rows[1]
        .map((row) => row.position)
        .sort((a, b) => a! - b!)
        .some((position, index) => position !== index + 1)
    )
      invalid();
    const state = ExecutionStateSchema.parse({
      schema_version: 1,
      artifact_id: artifactId,
      origin_kind: initial.origin,
      associations_unknown: initial.unknown === 1,
      lifecycle: completed ? 'completed' : 'active',
      binding_generation: latest.generation,
      current_binding: latest.binding,
      current_worktree_id: latest.binding?.worktree_id ?? null,
      null_reason: latest.binding ? null : completed ? 'completed' : latest.reason,
      associations: [...rows[1]]
        .sort((a, b) => a.position! - b.position!)
        .map((row) => row.identity),
      association_history: decoded[1],
      binding_history: transitions,
      checkpoint_execution: decoded[2],
      checkpoint_recovery_history: outcomes,
      recovery: pending
        ? {
            state: 'required',
            operation_id: latest.operation_id,
            takeover_generation: latest.generation,
            reason: latest.reason ?? 'First binding requires verification of existing checkpoints',
            checkpoint_ids: latest.checkpoint_ids,
            verified_checkpoint_ids: verified,
            abandoned_checkpoint_ids: abandoned,
          }
        : null,
    });
    const retainedCheckpoints = new Set(checkpointIds);
    if (
      [
        ...state.binding_history.flatMap((row) => row.checkpoint_ids),
        ...state.checkpoint_execution.map((row) => row.checkpoint_event_id),
        ...state.checkpoint_recovery_history.map((row) => row.checkpoint_event_id),
      ].some((id) => !retainedCheckpoints.has(id))
    )
      invalid();
    if (
      current.transition !== latest.operation_id ||
      current.generation !== latest.generation ||
      current.worktree !== state.current_worktree_id
    )
      invalid();
    rows.forEach((records, family) =>
      records.forEach((row, index) => {
        const record = decoded[family][index];
        const identity =
          family === 1
            ? record.worktree_id
            : family === 2
              ? record.checkpoint_event_id
              : record.operation_id;
        if (
          row.identity !== identity ||
          (family === 0 && row.generation !== record.generation) ||
          (family === 1 && row.repository !== record.repository_instance_id) ||
          (family === 2 && row.generation !== record.binding_generation) ||
          (family === 3 &&
            (row.checkpoint !== record.checkpoint_event_id ||
              row.takeover !== record.takeover_operation_id))
        )
          invalid();
      })
    );
    return { state, version: current.version, counters };
  } catch (cause) {
    invalid(cause);
  }
}

export function selectProjectExecutionRecords(view: ProjectReadView, artifactId: string) {
  if (!isUuidV7(artifactId))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select an exact artifact UUID');
  const initial = view.get<{ origin: string; unknown: number }>(
    'SELECT origin_kind AS origin, associations_unknown AS unknown FROM execution_initializations WHERE artifact_id=?',
    artifactId
  );
  if (!initial) {
    if (
      view.get(
        `SELECT artifact_id FROM execution_current WHERE artifact_id=?
         UNION ALL SELECT artifact_id FROM execution_transitions WHERE artifact_id=?
         UNION ALL SELECT artifact_id FROM execution_associations WHERE artifact_id=?
         UNION ALL SELECT artifact_id FROM execution_checkpoint_attributions WHERE artifact_id=?
         UNION ALL SELECT artifact_id FROM execution_checkpoint_recoveries WHERE artifact_id=? LIMIT 1`,
        artifactId,
        artifactId,
        artifactId,
        artifactId,
        artifactId
      )
    )
      invalid();
    return null;
  }
  const current = view.get<{
    version: number;
    transition: string;
    generation: number;
    worktree: string | null;
  }>(
    'SELECT version, transition_operation_id AS transition, binding_generation AS generation, current_worktree_id AS worktree FROM execution_current WHERE artifact_id=?',
    artifactId
  );
  if (!current) invalid();
  const rows = families.map(([table, identity]) =>
    view.all<RetainedRow>(
      `SELECT ordinal, hex(record_bytes) AS bytes, record_hash AS hash, ${identity} FROM ${table} WHERE artifact_id=? ORDER BY ordinal`,
      artifactId
    )
  );
  const checkpointIds = view
    .all<{
      id: string;
    }>(
      "SELECT event_id AS id FROM artifact_events WHERE artifact_id=? AND event_type='checkpoint_opened'",
      artifactId
    )
    .map((row) => row.id);
  return { initial, current, rows, checkpointIds };
}

export interface PreparedExecutionRecords {
  readonly query: PreparedExecutionQueryMetadata;
  readonly artifactId: string;
  readonly artifactRevision: ArtifactRevision;
  readonly operationId: string;
  readonly checkpointIds: readonly string[];
  readonly expectedVersion: number | null;
  readonly origin: string;
  readonly unknown: boolean;
  readonly transition: string;
  readonly generation: number;
  readonly worktree: string | null;
  readonly records: ReadonlyArray<
    ReadonlyArray<
      Readonly<{
        ordinal: number;
        json: string;
        hash: string;
        identity: string;
        generation: number | null;
        repository: string | null;
        position: number | null;
        checkpoint: string | null;
        takeover: string | null;
      }>
    >
  >;
}

export function refuseExecutionInput(value: unknown, secretAllow: readonly string[]): void {
  if (!Array.isArray(secretAllow) || secretAllow.some((entry) => typeof entry !== 'string'))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Supply the explicit authored execution secret allowlist'
    );
  const allow = [...secretAllow];
  try {
    assertNoSecretsInPayload(value, allow);
    const scan = (entry: unknown): void => {
      if (typeof entry === 'string') {
        for (const match of entry.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(match[0]);
          } catch {
            continue;
          }
          assertNoSecretsInPayload(decoded, allow);
        }
      } else if (entry && typeof entry === 'object') Object.values(entry).forEach(scan);
    };
    scan(value);
  } catch (cause) {
    if (cause instanceof SecretInPayloadError)
      throw new ProjectDatabaseError(
        'SECRET_IN_PAYLOAD',
        'Remove or redescribe refused execution content before publication',
        { cause }
      );
    throw cause;
  }
}

interface ExecutionRecordsInput {
  state: ExecutionState;
  artifactRevision: ArtifactRevision;
  previous: ProjectExecutionSnapshot | null;
  operationId: string;
  secretAllow: readonly string[];
}

export function prepareExecutionRecords(input: ExecutionRecordsInput): PreparedExecutionRecords {
  return prepareRecords(input, true);
}

export function restoreExecutionRecords(input: ExecutionRecordsInput): PreparedExecutionRecords {
  return prepareRecords(input, false);
}

function prepareRecords(input: ExecutionRecordsInput, authored: boolean): PreparedExecutionRecords {
  const parsed = ExecutionStateSchema.safeParse(input.state);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide a valid complete execution state with original retained identities',
      { cause: parsed.error }
    );
  const state = parsed.data;
  const previous = input.previous;
  if (
    !Array.isArray(input.secretAllow) ||
    input.secretAllow.some((entry) => typeof entry !== 'string')
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Supply the explicit authored execution secret allowlist'
    );
  const allow = [...input.secretAllow];
  const refuse = (value: unknown): void => {
    if (authored) refuseExecutionInput(value, allow);
  };
  if (!isUuidV7(input.operationId))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original execution publication operation UUID'
    );
  if (
    previous &&
    (previous.state.artifact_id !== state.artifact_id ||
      previous.state.origin_kind !== state.origin_kind ||
      previous.state.associations_unknown !== state.associations_unknown)
  ) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Execution initialization facts cannot be replaced'
    );
  }
  if (previous && previous.state.associations.some((id, index) => state.associations[index] !== id))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Retained association ordering cannot be rewritten'
    );
  const values = [
    state.binding_history,
    state.association_history,
    state.checkpoint_execution,
    state.checkpoint_recovery_history,
  ];
  const prior = previous
    ? [
        previous.state.binding_history,
        previous.state.association_history,
        previous.state.checkpoint_execution,
        previous.state.checkpoint_recovery_history,
      ]
    : [[], [], [], []];
  const records = values.map((entries, family) => {
    if (
      prior[family].length > entries.length ||
      prior[family].some((entry, index) => canonicalJson(entry) !== canonicalJson(entries[index]))
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Retained execution history cannot be removed or rewritten'
      );
    return Object.freeze(
      entries.slice(prior[family].length).map((entry, index) => {
        refuse(entry);
        const record = entry as unknown as Record<string, string | number>;
        const json = canonicalJson(entry);
        return Object.freeze({
          ordinal: prior[family].length + index + 1,
          json,
          hash: digest(json),
          identity: String(
            family === 1
              ? record.worktree_id
              : family === 2
                ? record.checkpoint_event_id
                : record.operation_id
          ),
          generation:
            family === 0
              ? Number(record.generation)
              : family === 2
                ? Number(record.binding_generation)
                : null,
          repository: family === 1 ? String(record.repository_instance_id) : null,
          position:
            family === 1 ? state.associations.indexOf(String(record.worktree_id)) + 1 : null,
          checkpoint: family === 3 ? String(record.checkpoint_event_id) : null,
          takeover: family === 3 ? String(record.takeover_operation_id) : null,
        });
      })
    );
  });
  const nextVersion = (previous?.version ?? 0) + 1;
  if (!Number.isSafeInteger(nextVersion))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Execution version is exhausted; preserve history for explicit repair'
    );
  return Object.freeze({
    artifactId: state.artifact_id,
    artifactRevision: Object.freeze(copyArtifactRevision(input.artifactRevision)),
    operationId: input.operationId,
    checkpointIds: Object.freeze([
      ...new Set([
        ...state.binding_history.flatMap((row) => row.checkpoint_ids),
        ...state.checkpoint_execution.map((row) => row.checkpoint_event_id),
        ...state.checkpoint_recovery_history.map((row) => row.checkpoint_event_id),
      ]),
    ]),
    expectedVersion: previous?.version ?? null,
    origin: state.origin_kind,
    unknown: state.associations_unknown,
    transition: state.binding_history.at(-1)!.operation_id,
    generation: state.binding_generation,
    worktree: state.current_worktree_id,
    records: Object.freeze(records),
    query: prepareExecutionQueryMetadata(state, nextVersion),
  });
}

export function settleExecutionRecords(
  transaction: ProjectSettlement,
  prepared: PreparedExecutionRecords
): number {
  const artifact = transaction.get<ArtifactRevision>(
    `SELECT r.generation, r.ordered_hash AS orderedHash, r.event_count AS eventCount, r.byte_length AS byteLength, r.tail_event_id AS tailEventId FROM artifacts a JOIN artifact_revisions r ON r.artifact_id=a.artifact_id AND r.generation=a.current_generation WHERE a.artifact_id=?`,
    prepared.artifactId
  );
  if (canonicalJson(artifact) !== canonicalJson(prepared.artifactRevision))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Artifact history changed after execution preparation; prepare a new operation against the intended revision'
    );
  for (const checkpointId of prepared.checkpointIds) {
    if (
      !transaction.get(
        "SELECT event_id FROM artifact_events WHERE artifact_id=? AND event_id=? AND event_type='checkpoint_opened'",
        prepared.artifactId,
        checkpointId
      )
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Execution attribution and recovery must reference an original checkpoint-open event of this artifact'
      );
  }
  const current = transaction.get<{ version: number }>(
    'SELECT version FROM execution_current WHERE artifact_id=?',
    prepared.artifactId
  );
  if ((current?.version ?? null) !== prepared.expectedVersion)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Execution changed after preparation; prepare a new operation against the intended owner'
    );
  const version = (prepared.expectedVersion ?? 0) + 1;
  if (!Number.isSafeInteger(version))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Execution version is exhausted; preserve history for explicit repair'
    );
  if (prepared.expectedVersion === null)
    transaction.run(
      'INSERT INTO execution_initializations VALUES (?, ?, ?, ?)',
      prepared.artifactId,
      prepared.origin,
      Number(prepared.unknown),
      prepared.operationId
    );
  prepared.records.forEach((records, family) =>
    records.forEach((row) => {
      const bytes = Buffer.from(row.json);
      const tail = [prepared.operationId, bytes, row.hash];
      if (family === 0)
        transaction.run(
          'INSERT INTO execution_transitions VALUES (?, ?, ?, ?, ?, ?, ?)',
          prepared.artifactId,
          row.identity,
          row.ordinal,
          row.generation,
          ...tail
        );
      if (family === 1)
        transaction.run(
          'INSERT INTO execution_associations VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          prepared.artifactId,
          row.identity,
          row.repository,
          row.ordinal,
          row.position,
          ...tail
        );
      if (family === 2)
        transaction.run(
          'INSERT INTO execution_checkpoint_attributions VALUES (?, ?, ?, ?, ?, ?, ?)',
          prepared.artifactId,
          row.identity,
          row.generation,
          row.ordinal,
          ...tail
        );
      if (family === 3)
        transaction.run(
          'INSERT INTO execution_checkpoint_recoveries VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          prepared.artifactId,
          row.identity,
          row.checkpoint,
          row.takeover,
          row.ordinal,
          ...tail
        );
    })
  );
  transaction.run(
    `INSERT INTO execution_current VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_id) DO UPDATE SET version=excluded.version, publication_operation_id=excluded.publication_operation_id,
      transition_operation_id=excluded.transition_operation_id, binding_generation=excluded.binding_generation, current_worktree_id=excluded.current_worktree_id`,
    prepared.artifactId,
    version,
    prepared.operationId,
    prepared.transition,
    prepared.generation,
    prepared.worktree
  );
  replaceExecutionQueryMetadata(transaction, prepared.query);
  return version;
}
