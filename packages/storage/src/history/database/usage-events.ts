import { canonicalJson } from '../../events/canonical-json.js';
import {
  type AgentUsageSnapshotPayload,
  AgentUsageSnapshotPayloadSchema,
  type SourcePlanLinkPayload,
  SourcePlanLinkPayloadSchema,
  type UsageLedgerRecord,
  UsageLedgerRecordSchema,
} from '../../schema/usage-ledger.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';
import { decodeRecords, digest } from '../event-integrity.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';
import type { ProjectSettlement } from './transactions.js';

export interface UsageSidecarPayload {
  readonly eventId: string;
  readonly bytes: Uint8Array;
}
export interface RetainedUsageEvent {
  record: UsageLedgerRecord;
  payload: unknown;
  completeness: { state: 'complete' | 'incomplete'; reasons: string[] };
}
export interface DecodedUsageEvent {
  event: RetainedUsageEvent;
  bytes: Buffer;
  sidecar: Buffer | null;
}
function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}
export function decodeUsageInput(
  bytes: Uint8Array,
  sidecars: readonly UsageSidecarPayload[],
  secretAllow: readonly string[],
  authored: boolean
): DecodedUsageEvent[] {
  if (!(bytes instanceof Uint8Array) || !Array.isArray(sidecars))
    invalid('Provide exact usage event bytes and an explicit sidecar payload array');
  const copy = Buffer.from(bytes);
  if (authored) refuseJsonBytes(copy, secretAllow);
  const payloads = new Map<string, Buffer>();
  for (const sidecar of sidecars) {
    if (
      !sidecar ||
      typeof sidecar.eventId !== 'string' ||
      !(sidecar.bytes instanceof Uint8Array) ||
      payloads.has(sidecar.eventId)
    )
      invalid('Provide one exact sidecar payload per referring usage event ID');
    const payload = Buffer.from(sidecar.bytes);
    if (authored) refuseJsonBytes(payload, secretAllow);
    payloads.set(sidecar.eventId, payload);
  }
  let records: UsageLedgerRecord[];
  try {
    records = decodeRecords(copy, UsageLedgerRecordSchema);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Usage bytes violate the original envelope schema or checksum; correct the input',
      { cause }
    );
  }
  if (!records.length) invalid('A usage append must contain at least one event');
  let offset = 0;
  const result = records.map((record) => {
    const end = copy.indexOf(0x0a, offset) + 1;
    const recordBytes = copy.subarray(offset, end);
    offset = end;
    const sidecar = payloads.get(record.event_id) ?? null;
    payloads.delete(record.event_id);
    let payload: unknown;
    try {
      if ('sidecar_sha256' in record) {
        if (
          !sidecar ||
          sidecar.length !== record.sidecar_size ||
          digest(sidecar) !== record.sidecar_sha256
        )
          invalid('Usage sidecar must match its exact original size and SHA-256');
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sidecar));
      } else {
        if (sidecar) invalid('An inline usage record cannot also carry a sidecar');
        payload = record.payload;
      }
      if (authored) {
        assertNoSecretsInPayload(record, secretAllow);
        assertNoSecretsInPayload(payload, secretAllow);
        const parsed =
          record.type === 'agent_usage_snapshot_recorded'
            ? AgentUsageSnapshotPayloadSchema.parse(payload)
            : SourcePlanLinkPayloadSchema.parse(payload);
        if (
          record.type === 'agent_usage_snapshot_recorded' &&
          (parsed as AgentUsageSnapshotPayload).idempotency_key !== record.idempotency_key
        )
          invalid('Snapshot and envelope idempotency keys must agree');
      }
    } catch (cause) {
      if (cause instanceof ProjectDatabaseError) throw cause;
      throw new ProjectDatabaseError(
        cause instanceof SecretInPayloadError ? 'SECRET_IN_PAYLOAD' : 'INVALID_INPUT',
        cause instanceof SecretInPayloadError
          ? 'Remove or redescribe refused usage content before a new attempt'
          : 'Provide a valid typed usage payload and matching envelope',
        { cause }
      );
    }
    return {
      event: { record, payload, completeness: { state: 'complete' as const, reasons: [] } },
      bytes: recordBytes,
      sidecar,
    };
  });
  if (payloads.size) invalid('Unreferenced usage sidecars cannot be persisted');
  return result;
}
export type UsageAccountingRow = {
  kind: 'snapshot' | 'link';
  values: Array<string | number | null>;
};
export function prepareUsageAccountingRow(event: RetainedUsageEvent): UsageAccountingRow {
  if (event.record.type === 'agent_usage_snapshot_recorded') {
    const p = AgentUsageSnapshotPayloadSchema.parse(event.payload);
    return {
      kind: 'snapshot',
      values: [
        event.record.event_id,
        p.snapshot_id,
        p.agent,
        p.session_id,
        p.artifact_id,
        p.source_plan_ref_id,
        p.lifecycle_event,
        p.checkpoint_n,
        p.baseline_kind,
        p.record_count,
        p.as_of,
        canonicalJson(p.cumulative_usage),
        canonicalJson(p.delta_usage),
        canonicalJson(p.model_breakdown),
      ],
    };
  }
  const p: SourcePlanLinkPayload = SourcePlanLinkPayloadSchema.parse(event.payload);
  return {
    kind: 'link',
    values: [
      event.record.event_id,
      p.canonical_ref_id,
      p.artifact_id,
      p.linked_at,
      p.pinned_version,
    ],
  };
}
export function insertUsageAccountingRow(
  transaction: ProjectSettlement,
  row: UsageAccountingRow
): void {
  transaction.run(
    row.kind === 'snapshot'
      ? 'INSERT INTO usage_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      : 'INSERT INTO usage_links VALUES (?, ?, ?, ?, ?)',
    ...row.values
  );
}
