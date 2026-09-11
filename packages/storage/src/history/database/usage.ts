import { isDeepStrictEqual } from 'node:util';

import { isUuidV7 } from '../../ids/uuidv7.js';
import { digest, EMPTY_ORDERED_HASH, orderedHash } from '../event-integrity.js';
import { usageAccountingIdentities } from '../usage-accounting.js';
import type { ProjectCounters, ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type ProjectOperation,
  type ProjectOperationOptions,
  type ProjectOperationResult,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';
import {
  decodeUsageInput,
  insertUsageAccountingRow,
  prepareUsageAccountingRow,
  type RetainedUsageEvent,
  type UsageSidecarPayload,
} from './usage-events.js';
import { assertUsageAccountingRows, assertUsageSelection } from './usage-selection.js';
import type { DatabaseJson } from './values.js';

export interface UsageRevision {
  generation: number;
  orderedHash: string;
  eventCount: number;
  byteLength: number;
  tailEventId: string;
}
export interface ProjectUsageSnapshot {
  projectId: string;
  revision: UsageRevision;
  eventBytes: Buffer;
  sidecarPayloads: UsageSidecarPayload[];
  events: RetainedUsageEvent[];
  counters: ProjectCounters;
}
export interface AppendProjectUsageEvents {
  readonly operationId: string;
  readonly expectedRevision: UsageRevision | null;
  readonly eventBytes: Uint8Array;
  readonly sidecarPayloads: readonly UsageSidecarPayload[];
  readonly secretAllow: readonly string[];
}
export interface UsageAppendResult {
  revision: UsageRevision;
  eventIds: string[];
}
const revisionColumns = `generation, ordered_hash AS orderedHash, event_count AS eventCount,
  byte_length AS byteLength, tail_event_id AS tailEventId`;
function copyRevision(value: UsageRevision): UsageRevision {
  if (!value || typeof value !== 'object')
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide an exact immutable usage revision or explicit null for creation'
    );
  const copy = {
    generation: value.generation,
    orderedHash: value.orderedHash,
    eventCount: value.eventCount,
    byteLength: value.byteLength,
    tailEventId: value.tailEventId,
  };
  if (
    ![copy.generation, copy.eventCount, copy.byteLength].every(
      (n) => Number.isSafeInteger(n) && n > 0
    ) ||
    !/^[a-f0-9]{64}$/.test(copy.orderedHash) ||
    !isUuidV7(copy.tailEventId)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select an exact retained usage publication identity'
    );
  return copy;
}
function currentRevision(view: ProjectReadView): UsageRevision | null {
  assertUsageSelection(view);
  const revision = view.get<UsageRevision>(
    `SELECT ${revisionColumns} FROM usage_revisions WHERE generation = (SELECT current_generation FROM usage_selection WHERE singleton = 1)`
  );
  if (!revision && view.get('SELECT singleton FROM usage_selection'))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Selected usage history is missing; preserve it for explicit repair'
    );
  return revision;
}
export function readProjectUsage(
  handle: ProjectDatabase,
  selectedRevision?: UsageRevision
): ProjectUsageSnapshot | null {
  const expected = selectedRevision === undefined ? undefined : copyRevision(selectedRevision);
  const materialized = handle.read((view) => {
    assertUsageSelection(view);
    const revision = expected
      ? view.get<UsageRevision>(
          `SELECT ${revisionColumns} FROM usage_revisions WHERE generation = ?`,
          expected.generation
        )
      : currentRevision(view);
    if (!revision || (expected && !isDeepStrictEqual(expected, revision))) return null;
    const rows = view.all<{
      eventId: string;
      bytes: string;
      sidecar: string | null;
      ordinal: number;
      hash: string;
      completeness: string;
    }>(
      `SELECT event_id AS eventId, ordinal, hex(record_bytes) AS bytes, CASE WHEN sidecar_payload_bytes IS NULL THEN NULL ELSE hex(sidecar_payload_bytes) END AS sidecar,
       record_hash AS hash, completeness_json AS completeness FROM usage_events WHERE ordinal <= ? ORDER BY ordinal`,
      revision.eventCount
    );
    return { revision, rows };
  });
  if (!materialized.value) return null;
  try {
    const { revision, rows } = materialized.value;
    const eventBytes = Buffer.concat(rows.map((row) => Buffer.from(row.bytes, 'hex')));
    const sidecarPayloads = rows.flatMap((row) =>
      row.sidecar === null ? [] : [{ eventId: row.eventId, bytes: Buffer.from(row.sidecar, 'hex') }]
    );
    const decoded = decodeUsageInput(eventBytes, sidecarPayloads, [], false);
    if (
      rows.length !== revision.eventCount ||
      eventBytes.length !== revision.byteLength ||
      orderedHash(decoded.map(({ event }) => event.record)) !== revision.orderedHash ||
      decoded.at(-1)?.event.record.event_id !== revision.tailEventId ||
      rows.some(
        (row, index) =>
          row.ordinal !== index + 1 ||
          row.hash !== digest(Buffer.from(row.bytes, 'hex')) ||
          row.eventId !== decoded[index]?.event.record.event_id
      )
    )
      throw new Error('Usage prefix identity does not match retained bytes');
    const events = decoded.map(({ event }, index) => {
      const completeness: unknown = JSON.parse(rows[index].completeness);
      if (
        !completeness ||
        typeof completeness !== 'object' ||
        !('state' in completeness) ||
        !['complete', 'incomplete'].includes(String(completeness.state)) ||
        !('reasons' in completeness) ||
        !Array.isArray(completeness.reasons) ||
        !completeness.reasons.every((reason: unknown) => typeof reason === 'string')
      )
        throw new Error('Retained usage completeness is invalid');
      return { ...event, completeness: completeness as RetainedUsageEvent['completeness'] };
    });
    return {
      projectId: handle.authority.projectId,
      revision,
      eventBytes,
      sidecarPayloads,
      events,
      counters: materialized.counters,
    };
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained usage bytes or publication identity are invalid; preserve history for explicit repair',
      { cause }
    );
  }
}
export async function appendProjectUsageEvents(
  handle: ProjectDatabase,
  input: AppendProjectUsageEvents,
  options: ProjectOperationOptions = {}
): Promise<ProjectOperationResult<UsageAppendResult>> {
  const prepared = prepareUsageAppend(handle.authority.projectId, input, true);
  return runProjectOperation<UsageAppendResult & DatabaseJson>(
    handle,
    prepared.operation,
    (transaction) => prepared.settle(transaction) as UsageAppendResult & DatabaseJson,
    options
  );
}

// Composed apart from the operation runner so a conversion can settle the identical rows for
// a target database whose connection does not exist yet.
export function prepareUsageAppend(
  projectId: string,
  input: AppendProjectUsageEvents,
  authored: boolean
): { operation: ProjectOperation; settle: (transaction: ProjectSettlement) => UsageAppendResult } {
  const operationId = input.operationId;
  const expected = input.expectedRevision === null ? null : copyRevision(input.expectedRevision);
  if (
    !Array.isArray(input.secretAllow) ||
    !input.secretAllow.every((value) => typeof value === 'string')
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Supply the approved secret refusal allowlist explicitly'
    );
  const incoming = decodeUsageInput(
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
  const identities = incoming.map(({ event }) => usageAccountingIdentities(event));
  const accountingRows = incoming.map(({ event }) => prepareUsageAccountingRow(event));
  const revision: UsageRevision = {
    generation: (expected?.generation ?? 0) + 1,
    orderedHash: orderedHash(
      incoming.map(({ event }) => event.record),
      expected?.orderedHash ?? EMPTY_ORDERED_HASH
    ),
    eventCount: (expected?.eventCount ?? 0) + incoming.length,
    byteLength:
      (expected?.byteLength ?? 0) + incoming.reduce((sum, event) => sum + event.bytes.length, 0),
    tailEventId: incoming.at(-1)!.event.record.event_id,
  };
  copyRevision(revision);
  return {
    operation: {
      operationId,
      kind: 'usage.append',
      target: { projectId },
      payload: manifest,
      expectedState: expected === null ? null : { ...expected },
      intentChange: false,
    },
    settle: (transaction: ProjectSettlement) => {
      assertUsageAccountingRows(transaction);
      if (!isDeepStrictEqual(currentRevision(transaction), expected))
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'Usage advanced after preparation; prepare an explicitly new operation against the intended revision'
        );
      for (const { event } of incoming)
        if (
          transaction.get(
            'SELECT event_id FROM usage_events WHERE event_id = ?',
            event.record.event_id
          )
        )
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            'A usage event identity is already retained; preserve its original content and author new records under new IDs'
          );
      incoming.forEach(({ event, bytes, sidecar }, index) => {
        transaction.run(
          'INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          event.record.event_id,
          (expected?.eventCount ?? 0) + index + 1,
          bytes,
          sidecar,
          event.record.checksum,
          manifest[index].recordHash,
          identities[index].eventIdentity,
          identities[index].snapshotIdentity,
          event.record.type,
          event.record.ts,
          event.record.idempotency_key,
          JSON.stringify({
            state: event.completeness.state,
            reasons: event.completeness.reasons,
          })
        );
        insertUsageAccountingRow(transaction, accountingRows[index]);
      });
      transaction.run(
        'INSERT INTO usage_revisions VALUES (?, ?, ?, ?, ?, ?)',
        revision.generation,
        operationId,
        revision.orderedHash,
        revision.eventCount,
        revision.byteLength,
        revision.tailEventId
      );
      if (expected === null)
        transaction.run('INSERT INTO usage_selection VALUES (1, ?)', revision.generation);
      else
        transaction.run(
          'UPDATE usage_selection SET current_generation = ? WHERE singleton = 1',
          revision.generation
        );
      return {
        revision: { ...revision },
        eventIds: incoming.map(({ event }) => event.record.event_id),
      };
    },
  };
}
