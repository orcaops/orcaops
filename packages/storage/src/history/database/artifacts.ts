import { isDeepStrictEqual } from 'node:util';

import {
  prepareArtifactQueryMetadata,
  replaceArtifactQueryMetadata,
} from './query-metadata-records.js';
import type { ArtifactThread } from '../../events/artifact-thread.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { digest, EMPTY_ORDERED_HASH, orderedHash } from '../event-integrity.js';
import {
  artifactEventsChangeIntent,
  type ArtifactSidecarPayload,
  decodeArtifactInput,
  reconstructDatabaseArtifact,
  type RetainedArtifactEvent,
} from './artifact-events.js';
import type { ProjectCounters, ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { prepareArtifactSearchRows, replaceArtifactSearchRows } from './search-records.js';
import { assertSourceTimeArtifactMembership } from './source-time-membership.js';
import {
  assertProjectSourceTimeSelection,
  hydrateProjectSourceTime,
  isSourceTimeSnapshotChanged,
  type ProjectSourceTimeMaterialized,
  snapshotProjectSourceTime,
} from './source-time-records.js';
import {
  type ProjectOperationOptions,
  type ProjectOperationResult,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';

export interface ArtifactRevision {
  generation: number;
  orderedHash: string;
  eventCount: number;
  byteLength: number;
  tailEventId: string;
}
export interface ProjectArtifactSnapshot {
  artifactId: string;
  revision: ArtifactRevision;
  eventBytes: Buffer;
  sidecarPayloads: ArtifactSidecarPayload[];
  thread: ArtifactThread;
  counters: ProjectCounters;
}
export interface ProjectArtifactMetadata {
  artifactId: string;
  label: string;
  task: string;
  agent: string;
  branch: string;
  baseSha: string;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  state: string;
  originKind: string;
  checkpointCount: number;
  openCheckpointCount: number;
  planRevisionCount: number;
}
export interface AppendProjectArtifactEvents {
  readonly operationId: string;
  readonly artifactId: string;
  readonly expectedRevision: ArtifactRevision | null;
  readonly eventBytes: Uint8Array;
  readonly sidecarPayloads: readonly ArtifactSidecarPayload[];
  readonly secretAllow: readonly string[];
}
export interface ArtifactAppendResult {
  artifactId: string;
  revision: ArtifactRevision;
  eventIds: string[];
}
const revisionColumns = `generation, ordered_hash AS orderedHash, event_count AS eventCount,
  byte_length AS byteLength, tail_event_id AS tailEventId`;
const metadataColumns = `artifact_id AS artifactId, label, task, agent, branch,
  base_sha AS baseSha, started_at AS startedAt, completed_at AS completedAt,
  updated_at AS updatedAt, state, origin_kind AS originKind,
  checkpoint_count AS checkpointCount, open_checkpoint_count AS openCheckpointCount,
  plan_revision_count AS planRevisionCount`;

function validateId(id: string): void {
  if (!isUuidV7(id))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select an exact artifact UUID');
}
export function copyArtifactRevision(revision: ArtifactRevision): ArtifactRevision {
  if (!revision || typeof revision !== 'object')
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide an exact immutable revision or explicit null for creation'
    );
  const copy = {
    generation: revision.generation,
    orderedHash: revision.orderedHash,
    eventCount: revision.eventCount,
    byteLength: revision.byteLength,
    tailEventId: revision.tailEventId,
  };
  if (
    ![copy.generation, copy.eventCount, copy.byteLength].every(
      (n) => Number.isSafeInteger(n) && n > 0
    ) ||
    !/^[a-f0-9]{64}$/.test(copy.orderedHash) ||
    !isUuidV7(copy.tailEventId)
  ) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact immutable artifact revision identity'
    );
  }
  return copy;
}
function currentRevision(view: ProjectReadView, id: string): ArtifactRevision | null {
  const revision = view.get<ArtifactRevision>(
    `SELECT ${revisionColumns} FROM artifact_revisions
    WHERE artifact_id = ? AND generation = (SELECT current_generation FROM artifacts WHERE artifact_id = ?)`,
    id,
    id
  );
  if (
    !revision &&
    view.get(
      `SELECT artifact_id FROM artifacts WHERE artifact_id = ?
       UNION ALL SELECT artifact_id FROM artifact_revisions WHERE artifact_id = ?
       UNION ALL SELECT artifact_id FROM artifact_events WHERE artifact_id = ? LIMIT 1`,
      id,
      id,
      id
    )
  )
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The selected artifact publication is missing; preserve history for explicit repair'
    );
  return revision;
}

export function readProjectArtifact(
  handle: ProjectDatabase,
  artifactId: string,
  selectedRevision?: ArtifactRevision
): ProjectArtifactSnapshot | null {
  validateId(artifactId);
  const expected =
    selectedRevision === undefined ? undefined : copyArtifactRevision(selectedRevision);
  const selected = handle.read((view) => selectProjectArtifactRecords(view, artifactId, expected));
  return hydrateProjectArtifactRecords(artifactId, selected.value, selected.counters);
}

export function selectProjectArtifactRecords(
  view: ProjectReadView,
  artifactId: string,
  selectedRevision?: ArtifactRevision
) {
  validateId(artifactId);
  const expected =
    selectedRevision === undefined ? undefined : copyArtifactRevision(selectedRevision);
  const revision = expected
    ? view.get<ArtifactRevision>(
        `SELECT ${revisionColumns} FROM artifact_revisions WHERE artifact_id = ? AND generation = ?`,
        artifactId,
        expected.generation
      )
    : currentRevision(view, artifactId);
  if (!revision) return null;
  if (expected && !isDeepStrictEqual(revision, expected)) {
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The supplied revision content does not identify this retained publication; select its exact identity'
    );
  }
  const rows = view.all<{
    eventId: string;
    ordinal: number;
    bytes: string;
    sidecar: string | null;
    recordHash: string;
  }>(
    `SELECT event_id AS eventId, ordinal, hex(record_bytes) AS bytes, record_hash AS recordHash,
        CASE WHEN sidecar_payload_bytes IS NULL THEN NULL ELSE hex(sidecar_payload_bytes) END AS sidecar
       FROM artifact_events WHERE artifact_id = ? AND ordinal <= ? ORDER BY ordinal`,
    artifactId,
    revision.eventCount
  );
  return { revision, rows };
}

export function hydrateProjectArtifactRecords(
  artifactId: string,
  selected: ReturnType<typeof selectProjectArtifactRecords>,
  counters: ProjectCounters
): ProjectArtifactSnapshot | null {
  if (!selected) return null;
  const { revision, rows } = selected;
  try {
    const eventBytes = Buffer.concat(rows.map((row) => Buffer.from(row.bytes, 'hex')));
    const sidecarPayloads = rows
      .filter((row) => row.sidecar !== null)
      .map((row) => ({ eventId: row.eventId, bytes: Buffer.from(row.sidecar!, 'hex') }));
    const events = decodeArtifactInput(eventBytes, sidecarPayloads, [], false);
    if (
      events.length !== revision.eventCount ||
      eventBytes.length !== revision.byteLength ||
      orderedHash(events.map((entry) => entry.event.record)) !== revision.orderedHash ||
      events.at(-1)?.event.record.event_id !== revision.tailEventId ||
      rows.some(
        (row, index) =>
          row.ordinal !== index + 1 ||
          row.eventId !== events[index]?.event.record.event_id ||
          row.recordHash !== digest(events[index]!.bytes)
      )
    ) {
      throw new Error('Retained revision differs from its exact event prefix');
    }
    const thread = reconstructDatabaseArtifact(artifactId, events, true);
    return {
      artifactId,
      revision,
      eventBytes,
      sidecarPayloads,
      thread,
      counters,
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'HISTORY_INTEGRITY_REQUIRED')
      throw cause;
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained artifact bytes or publication identity are invalid; preserve history for explicit repair',
      { cause }
    );
  }
}

export function listProjectArtifacts(
  handle: ProjectDatabase,
  input: { branch?: string; limit: number; offset?: number }
): { artifacts: ProjectArtifactMetadata[]; counters: ProjectCounters } {
  const limit = input.limit;
  const offset = input.offset ?? 0;
  const branch = input.branch;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (branch !== undefined && (typeof branch !== 'string' || !branch.length))
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Choose a listing limit from 1 to 1000, a nonnegative offset and an optional nonempty branch'
    );
  const result = handle.read((view) =>
    view.all<ProjectArtifactMetadata>(
      `SELECT ${metadataColumns} FROM artifact_metadata
     ${branch === undefined ? '' : 'WHERE artifact_id IN (SELECT artifact_id FROM artifact_branches WHERE branch = ?)'}
     ORDER BY started_at DESC, artifact_id ASC LIMIT ? OFFSET ?`,
      ...(branch === undefined ? [] : [branch]),
      limit,
      offset
    )
  );
  return { artifacts: result.value, counters: result.counters };
}

export function prepareArtifactListingMetadata(thread: ArtifactThread): ProjectArtifactMetadata {
  const plan = thread.plan!;
  const artifact = thread.artifactJson!;
  return {
    artifactId: thread.artifactId,
    label: plan.label,
    task: plan.task,
    agent: plan.agent,
    branch: plan.branch,
    baseSha: plan.base_sha,
    startedAt: plan.started_at,
    completedAt: thread.summary?.ts ?? null,
    updatedAt: artifact.updated_at,
    state: artifact.state,
    originKind: plan.origin?.kind ?? 'captured',
    checkpointCount: artifact.checkpoint_count,
    openCheckpointCount: thread.checkpoints.filter((checkpoint) => checkpoint.status === 'open')
      .length,
    planRevisionCount: artifact.plan_revision_count,
  };
}

export function replaceArtifactListingMetadata(
  transaction: Pick<ProjectSettlement, 'run'>,
  row: ProjectArtifactMetadata,
  branches: readonly string[]
): void {
  transaction.run('DELETE FROM artifact_metadata WHERE artifact_id = ?', row.artifactId);
  transaction.run(
    'INSERT INTO artifact_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.artifactId,
    row.label,
    row.task,
    row.agent,
    row.branch,
    row.baseSha,
    row.startedAt,
    row.completedAt,
    row.updatedAt,
    row.state,
    row.originKind,
    row.checkpointCount,
    row.openCheckpointCount,
    row.planRevisionCount
  );
  transaction.run('DELETE FROM artifact_branches WHERE artifact_id = ?', row.artifactId);
  for (const branch of new Set(branches))
    transaction.run('INSERT INTO artifact_branches VALUES (?, ?)', row.artifactId, branch);
}

function artifactAppendRequest(input: AppendProjectArtifactEvents, authored: boolean) {
  const artifactId = input.artifactId;
  const operationId = input.operationId;
  validateId(artifactId);
  const expected =
    input.expectedRevision === null ? null : copyArtifactRevision(input.expectedRevision);
  if (
    !Array.isArray(input.secretAllow) ||
    !input.secretAllow.every((value) => typeof value === 'string')
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Supply the approved secret refusal allowlist explicitly'
    );
  const incoming = decodeArtifactInput(
    input.eventBytes,
    input.sidecarPayloads,
    [...input.secretAllow],
    authored
  );
  const manifest = incoming.map(({ event, bytes, sidecar }) => ({
    eventId: event.record.event_id,
    recordHash: digest(bytes),
    sidecarHash: sidecar === null ? null : digest(sidecar),
  }));
  const operation = {
    operationId,
    kind: 'artifact.append',
    target: { artifactId },
    payload: manifest,
    expectedState: expected === null ? null : { ...expected },
    intentChange: artifactEventsChangeIntent(incoming.map(({ event }) => event)),
  };
  return { artifactId, operationId, expected, incoming, operation };
}

export function prepareArtifactAppendRequest(input: AppendProjectArtifactEvents) {
  return artifactAppendRequest(input, true);
}

export function restoreArtifactAppendRequest(input: AppendProjectArtifactEvents) {
  return artifactAppendRequest(input, false);
}

export async function prepareArtifactAppend(
  handle: ProjectDatabase,
  request: ReturnType<typeof prepareArtifactAppendRequest>
) {
  const prior =
    request.expected === null
      ? null
      : readProjectArtifact(handle, request.artifactId, request.expected);
  if (request.expected && !prior)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The declared prior publication is not retained here; select the correct artifact and prepare a new operation'
    );
  return composeArtifactAppend({
    projectId: handle.authority.projectId,
    request,
    prior,
    sourceSnapshot: handle.read((view) => snapshotProjectSourceTime(view, request.artifactId))
      .value,
  });
}

// Split from the handle-driven path so a conversion can compose the same rows for a target
// database that has no readable connection yet: it is still being created.
export async function composeArtifactAppend(input: {
  projectId: string;
  request: ReturnType<typeof prepareArtifactAppendRequest>;
  prior: ProjectArtifactSnapshot | null;
  sourceSnapshot: ProjectSourceTimeMaterialized;
}) {
  const { request, prior, sourceSnapshot } = input;
  const { artifactId, operationId, expected, incoming } = request;
  const previous: RetainedArtifactEvent[] = prior
    ? decodeArtifactInput(prior.eventBytes, prior.sidecarPayloads, [], false)
    : [];
  const events = [...previous, ...incoming];
  if (new Set(events.map(({ event }) => event.record.event_id)).size !== events.length)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'An artifact append cannot repeat a retained event ID'
    );
  const thread = reconstructDatabaseArtifact(artifactId, events, false);
  const row = prepareArtifactListingMetadata(thread);
  const revision: ArtifactRevision = {
    generation: (expected?.generation ?? 0) + 1,
    eventCount: events.length,
    byteLength:
      (expected?.byteLength ?? 0) + incoming.reduce((sum, event) => sum + event.bytes.length, 0),
    orderedHash: orderedHash(
      incoming.map(({ event }) => event.record),
      expected?.orderedHash ?? EMPTY_ORDERED_HASH
    ),
    tailEventId: incoming.at(-1)!.event.record.event_id,
  };
  copyArtifactRevision(revision);
  const sourceTimeMember = hydrateProjectSourceTime(sourceSnapshot, artifactId);
  assertSourceTimeArtifactMembership(thread, sourceTimeMember);
  const searchRows = prepareArtifactSearchRows(
    input.projectId,
    thread,
    revision.generation,
    sourceTimeMember
  );
  const query = await prepareArtifactQueryMetadata(thread, revision.generation);
  const settle = (transaction: ProjectSettlement): ArtifactAppendResult => {
    if (!isDeepStrictEqual(currentRevision(transaction, artifactId), expected))
      throw new ProjectDatabaseError(
        'STALE_CONTEXT',
        'The artifact advanced after preparation; prepare an explicitly new operation against the intended revision'
      );
    assertProjectSourceTimeSelection(transaction, artifactId, sourceSnapshot.selection);
    for (const { event } of incoming) {
      if (
        transaction.get(
          'SELECT event_id FROM artifact_events WHERE event_id = ?',
          event.record.event_id
        )
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'An event ID already belongs to retained history; preserve its original identity and prepare different authored content under new IDs'
        );
    }
    if (expected === null)
      transaction.run('INSERT INTO artifacts VALUES (?, ?)', artifactId, revision.generation);
    else
      transaction.run(
        'UPDATE artifacts SET current_generation = ? WHERE artifact_id = ?',
        revision.generation,
        artifactId
      );
    incoming.forEach(({ event, bytes, sidecar }, index) => {
      transaction.run(
        'INSERT INTO artifact_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        artifactId,
        event.record.event_id,
        (expected?.eventCount ?? 0) + index + 1,
        bytes,
        sidecar,
        event.record.checksum,
        digest(bytes),
        event.record.type,
        event.record.ts
      );
    });
    transaction.run(
      'INSERT INTO artifact_revisions VALUES (?, ?, ?, ?, ?, ?, ?)',
      artifactId,
      revision.generation,
      operationId,
      revision.orderedHash,
      revision.eventCount,
      revision.byteLength,
      revision.tailEventId
    );
    replaceArtifactSearchRows(transaction, searchRows);
    replaceArtifactListingMetadata(
      transaction,
      row,
      thread.artifactJson!.branch_lineage.map((entry) => entry.branch)
    );
    replaceArtifactQueryMetadata(transaction, query);
    return {
      artifactId,
      revision: { ...revision },
      eventIds: incoming.map(({ event }) => event.record.event_id),
    };
  };
  return { prior, thread, revision, settle };
}

export async function appendProjectArtifactEvents(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents,
  options: ProjectOperationOptions = {}
): Promise<ProjectOperationResult<ArtifactAppendResult>> {
  const runtime = { signal: options.signal, onWait: options.onWait };
  const request = prepareArtifactAppendRequest(input);
  if (
    handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id = ?', request.operationId)
    ).value
  ) {
    return runProjectOperation(
      handle,
      request.operation,
      () => {
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'An immutable original operation disappeared during replay; preserve history for explicit repair'
        );
      },
      runtime
    );
  }
  for (let attempt = 0; ; attempt++) {
    const prepared = await prepareArtifactAppend(handle, request);
    try {
      return await runProjectOperation(
        handle,
        request.operation,
        (transaction) => ({
          ...prepared.settle(transaction),
          revision: { ...prepared.revision },
        }),
        runtime
      );
    } catch (error) {
      if (attempt !== 0 || !isSourceTimeSnapshotChanged(error)) throw error;
    }
  }
}
