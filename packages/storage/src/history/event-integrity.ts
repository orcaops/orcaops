import { createHash } from 'node:crypto';
import { z } from 'zod';

import { integrity } from './persistence-error.js';
import { canonicalJson } from '../events/canonical-json.js';
import { type EventRecord, EventRecordSchema } from '../events/event-log.js';

export const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const CounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const EMPTY_ORDERED_HASH = digest(Buffer.from('orcaops-events-v1\n'));

export function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function recordChecksum(record: Record<string, unknown>): string {
  const { checksum: _checksum, ...content } = record;
  return digest(canonicalJson(content));
}

export function orderedHash(records: readonly unknown[], prior = EMPTY_ORDERED_HASH): string {
  let hash = prior;
  for (const record of records) {
    hash = createHash('sha256')
      .update(Buffer.from(hash, 'hex'))
      .update(Buffer.from([0x0a]))
      .update(canonicalJson(record))
      .digest('hex');
  }
  return hash;
}

export function decodeRecords<T extends { event_id: string; checksum: string }>(
  bytes: Buffer,
  schema: z.ZodType<T>
): T[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0x0a) integrity('Committed log is not newline terminated');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    integrity('Committed log is not valid UTF-8');
  }
  const ids = new Set<string>();
  return text!
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      let record: T;
      try {
        record = schema.parse(JSON.parse(line));
      } catch {
        integrity('Committed log record violates its schema', { line: index + 1 });
      }
      if (recordChecksum(record!) !== record!.checksum) {
        integrity('Committed log record checksum differs', { line: index + 1 });
      }
      if (ids.has(record!.event_id)) integrity('Committed log repeats an event identity');
      ids.add(record!.event_id);
      return record!;
    });
}

export function decodeArtifactRecords(bytes: Buffer): EventRecord[] {
  return decodeRecords(bytes, EventRecordSchema);
}
