import { digest } from './event-integrity.js';
import { HistoryPersistenceError } from './persistence-error.js';
import { canonicalJson } from '../events/canonical-json.js';
import { UuidV7Schema } from '../ids/uuidv7.js';

export function artifactOperationId(
  artifactId: string,
  idempotencyKey: string,
  eventFamily: string
): string {
  UuidV7Schema.parse(artifactId);
  if (!idempotencyKey || !eventFamily)
    throw new HistoryPersistenceError('INVALID_INPUT', 'Idempotency scope and key are required');
  const entropy = Buffer.from(
    digest(canonicalJson([artifactId, idempotencyKey, eventFamily])),
    'hex'
  );
  Buffer.from(artifactId.replaceAll('-', '').slice(0, 12), 'hex').copy(entropy, 0);
  entropy[6] = (entropy[6] & 0x0f) | 0x70;
  entropy[8] = (entropy[8] & 0x3f) | 0x80;
  const hex = entropy.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
