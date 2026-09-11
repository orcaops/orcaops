import { createHash } from 'node:crypto';

import { canonicalJson } from '../events/canonical-json.js';
import {
  AgentUsageSnapshotPayloadSchema,
  SourcePlanLinkPayloadSchema,
  type UsageLedgerEventType,
  type UsageLedgerRecord,
} from '../schema/usage-ledger.js';
export interface LoadedUsageEvent {
  event_id: string;
  type: UsageLedgerEventType;
  ts: string;
  idempotency_key: string;
  payload: unknown;
}
export function usageRecordContentIdentity(
  record: Pick<UsageLedgerRecord, 'event_id' | 'type' | 'ts' | 'idempotency_key'>,
  payload: unknown
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        event_id: record.event_id,
        type: record.type,
        ts: record.ts,
        idempotency_key: record.idempotency_key,
        payload,
      }),
      'utf8'
    )
    .digest('hex');
}
export function isValidUsagePayload(
  type: UsageLedgerEventType,
  idempotencyKey: string,
  payload: unknown
): boolean {
  if (type === 'source_plan_linked') return SourcePlanLinkPayloadSchema.safeParse(payload).success;
  const parsed = AgentUsageSnapshotPayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.idempotency_key === idempotencyKey;
}
