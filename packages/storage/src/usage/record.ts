import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../events/canonical-json.js';
import { INLINE_PAYLOAD_BUDGET_BYTES } from '../events/event-log.js';
import { isUuidV7, uuidv7 } from '../ids/uuidv7.js';
import { assertResolvedWithin } from '../paths/containment.js';
import {
  MAX_USAGE_SIDECAR_BYTES,
  type UsageLedgerEventType,
  type UsageLedgerRecord,
} from '../schema/usage-ledger.js';

export interface AppendUsageRecordInput {
  type: UsageLedgerEventType;
  /** ISO timestamp; caller controls it (lets tests pin exact values). */
  ts: string;
  idempotency_key: string;
  payload: unknown;
  /** Optional event_id override for deterministic fixtures. */
  event_id?: string;
}

/**
 * Derive the exact inline/sidecar envelope without writing it. Archive
 * redaction and lag comparison share this with append so spill thresholds,
 * sidecar hashes, and record checksums cannot drift.
 */
export function deriveUsageLedgerRecord(input: AppendUsageRecordInput): {
  record: UsageLedgerRecord;
  sidecarJson: string | null;
} {
  if (typeof input.idempotency_key !== 'string' || input.idempotency_key.length === 0) {
    throw new Error(`Usage ledger record "${input.type}" requires a non-empty idempotency_key.`);
  }
  if (input.event_id !== undefined && !isUuidV7(input.event_id)) {
    throw new Error(`Usage ledger record event_id "${input.event_id}" is not a canonical UUIDv7.`);
  }
  const eventId = input.event_id ?? uuidv7();
  const payloadJson = canonicalJson(input.payload);
  const payloadBuffer = Buffer.from(payloadJson, 'utf8');
  if (payloadBuffer.byteLength > MAX_USAGE_SIDECAR_BYTES) {
    throw new RangeError(
      `Usage ledger payload exceeds ${MAX_USAGE_SIDECAR_BYTES} bytes (${payloadBuffer.byteLength}).`
    );
  }

  if (payloadBuffer.byteLength > INLINE_PAYLOAD_BUDGET_BYTES) {
    const base = {
      event_id: eventId,
      type: input.type,
      ts: input.ts,
      schema_version: 1 as const,
      idempotency_key: input.idempotency_key,
      sidecar_sha256: createHash('sha256').update(payloadBuffer).digest('hex'),
      sidecar_size: payloadBuffer.byteLength,
    };
    return {
      record: { ...base, checksum: computeUsageRecordChecksum(base) },
      sidecarJson: payloadJson,
    };
  }
  const base = {
    event_id: eventId,
    type: input.type,
    ts: input.ts,
    schema_version: 1 as const,
    idempotency_key: input.idempotency_key,
    payload: input.payload,
  };
  return {
    record: { ...base, checksum: computeUsageRecordChecksum(base) },
    sidecarJson: null,
  };
}

export function computeUsageRecordChecksum(recordWithoutChecksum: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(recordWithoutChecksum), 'utf8').digest('hex');
}

export async function loadUsageRecordPayload(
  record: UsageLedgerRecord,
  sidecarsDir: string,
  containmentRoot?: string
): Promise<{ ok: true; payload: unknown } | { ok: false }> {
  if ('payload' in record) return { ok: true, payload: record.payload };
  const declaredPath = path.join(sidecarsDir, `${record.event_id}.json`);
  const sidecarPath =
    containmentRoot === undefined
      ? declaredPath
      : assertResolvedWithin(declaredPath, containmentRoot, 'usage sidecar read', {
          rejectSymlinks: true,
        });
  let handle: FileHandle;
  try {
    handle = await open(sidecarPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    return { ok: false };
  }
  let bytes: Buffer | null;
  try {
    bytes = await readExactBytes(handle, record.sidecar_size);
  } catch {
    bytes = null;
  }
  await handle.close().catch(() => {});
  if (bytes === null) return { ok: false };
  if (createHash('sha256').update(bytes).digest('hex') !== record.sidecar_sha256) {
    return { ok: false };
  }
  try {
    return { ok: true, payload: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export async function readExactBytes(
  handle: FileHandle,
  expectedSize: number
): Promise<Buffer | null> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > MAX_USAGE_SIDECAR_BYTES
  ) {
    return null;
  }
  const stats = await handle.stat();
  if (!stats.isFile() || stats.size !== expectedSize) return null;
  const bytes = Buffer.allocUnsafe(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(bytes, offset, expectedSize - offset, null);
    if (bytesRead === 0) return null;
    offset += bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  if ((await handle.read(overflow, 0, 1, null)).bytesRead !== 0) return null;
  return bytes;
}
