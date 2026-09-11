import { z } from 'zod';

import { CounterSchema, DigestSchema } from './event-integrity.js';
import { HistoryMetadataDetailsSchema } from './metadata-details.js';
import { HistoryProvenanceMetadataSchema } from './metadata-provenance.js';
import { UuidV7Schema } from '../ids/uuidv7.js';
import { ArtifactStateSchema } from '../schema/artifact-json.js';

export {
  historyMetadataDetails,
  type HistoryMetadataDetails,
  HistoryMetadataDetailsSchema,
} from './metadata-details.js';

export const HISTORY_METADATA_ROW_VERSION = 5;

export const HistoryMetadataRowSchema = z.strictObject({
  artifactId: UuidV7Schema,
  details: HistoryMetadataDetailsSchema,
  provenance: HistoryProvenanceMetadataSchema,
  versionToken: DigestSchema,
  generation: CounterSchema,
  eventCount: CounterSchema,
  byteLength: CounterSchema,
  orderedHash: DigestSchema,
  label: z.string(),
  agent: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
  state: ArtifactStateSchema,
  origin: z.enum(['captured', 'git-import']),
  branches: z.array(z.string()),
  files: z.array(z.string()),
  checkpointCount: CounterSchema,
  openCheckpointCount: CounterSchema,
  planRevisionCount: CounterSchema,
  associations: z.array(UuidV7Schema),
  associationsUnknown: z.boolean(),
  bindingGeneration: CounterSchema.nullable(),
  currentWorktreeId: UuidV7Schema.nullable(),
  executionIssue: z.string().nullable(),
});
export type HistoryMetadataRow = z.infer<typeof HistoryMetadataRowSchema>;

export {
  historyProvenanceMetadata,
  historyProvenanceMayMatch,
  HistoryProvenanceMetadataSchema,
  HISTORY_PROVENANCE_PATH_LIMIT,
  HISTORY_PROVENANCE_HASH_LIMIT,
} from './metadata-provenance.js';
export type { HistoryProvenanceMetadata } from './metadata-provenance.js';
