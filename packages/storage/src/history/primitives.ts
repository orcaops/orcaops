export {
  CounterSchema,
  DigestSchema,
  EMPTY_ORDERED_HASH,
  decodeRecords,
  digest,
  orderedHash,
  recordChecksum,
} from './event-integrity.js';
export { HistoryPersistenceError } from './persistence-error.js';

export { encodeArtifactEvent } from './event-encoding.js';
export type { EncodedArtifactEvent } from './event-encoding.js';

export function contained(root: string, file: string): string {
  return assertResolvedWithin(file, root, 'canonical history resource', {
    allowRoot: true,
    rejectSymlinks: true,
  });
}
import { assertResolvedWithin } from '../paths/containment.js';
