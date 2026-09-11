import { digest, recordChecksum } from './event-integrity.js';
import { canonicalJson } from '../events/canonical-json.js';
import {
  type AppendEventInput,
  type EventRecord,
  EventRecordSchema,
  INLINE_PAYLOAD_BUDGET_BYTES,
} from '../events/event-log.js';
import { uuidv7 } from '../ids/uuidv7.js';

export interface EncodedArtifactEvent {
  record: EventRecord;
  eventBytes: Buffer;
  payloadBytes: Buffer;
  sidecar: { relativePath: string; bytes: Buffer } | null;
}

export function encodeArtifactEvent(input: AppendEventInput): EncodedArtifactEvent {
  const eventId = input.event_id ?? uuidv7();
  const payloadBytes = Buffer.from(canonicalJson(input.payload));
  const sidecar =
    payloadBytes.length > INLINE_PAYLOAD_BUDGET_BYTES
      ? { relativePath: `sidecars/${eventId}.json`, bytes: payloadBytes }
      : null;
  const base = {
    event_id: eventId,
    type: input.type,
    ts: input.ts,
    schema_version: 1 as const,
    idempotency_key: input.idempotency_key,
    ...(sidecar
      ? { sidecar_sha256: digest(payloadBytes), sidecar_size: payloadBytes.length }
      : { payload: input.payload }),
  };
  const record = EventRecordSchema.parse({ ...base, checksum: recordChecksum(base) });
  return { record, eventBytes: Buffer.from(canonicalJson(record) + '\n'), payloadBytes, sidecar };
}
