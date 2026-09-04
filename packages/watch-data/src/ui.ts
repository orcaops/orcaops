// The surface the Bun UI bundles. Nothing here imports @orcaops/storage as a
// value: the storage barrel carries better-sqlite3's lazy loader, and the UI
// must never pull that into a Bun bundle (the sidecar exists for that).
export type * from './types.js';
export {
  DEFAULT_THRESHOLDS,
  classifyAgent,
  needsAttention,
  type ClassifyInputs,
  type Thresholds,
} from './liveness.js';
export {
  attentionRows,
  deriveSteps,
  reclassify,
  sortedProjects,
  type FlatRow,
} from './presenters.js';
export { DEFAULT_SPARKLINE, bucketize, type SparklineConfig } from './sparkline.js';
export {
  ReviewCacheBehindError,
  ReviewSidecarSchemaError,
  parseSidecarSchemaError,
  serializeSidecarSchemaError,
} from './sidecarError.js';
