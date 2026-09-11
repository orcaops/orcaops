import { HistoryConversionError } from './errors.js';

export const LEGACY_PROFILE_ID = 'orcaops-0.2.0-rc.2';
export const LEGACY_PRODUCER_VERSION = '0.2.0-rc.2';
export const LEGACY_SOURCE_REVISION = '9cb6e606cebed31a3e22bb928119c04cb041bfc3';
export const CONVERTER_INTRODUCED_VERSION = '0.3.0';
export const CONVERTER_REMOVAL_VERSION = '0.4.0';

const schemaVersions = {
  artifact_record: [1],
  plan: [4],
  checkpoint: [4],
  summary: [1],
  evaluator_record: [1],
  artifact_projection: [1],
  usage_record: [1],
  sqlite_baseline: [20, 22, 23, 24, 25],
  config: [4, 5, 6],
  source_plan_pull: [1],
  source_plan_review_pull: [1],
  seed_journal: [1, 2],
  seed_coverage: [1],
  seed_state: [1],
  seed_enrichment: [2],
  seed_bundle: [2],
} as const;

export type LegacyVersionedResource = keyof typeof schemaVersions;
export interface LegacyProducer {
  readonly version: typeof LEGACY_PRODUCER_VERSION | null;
  readonly sourceRevision: typeof LEGACY_SOURCE_REVISION | null;
  readonly evidence: 'recorded' | 'unknown';
}

export function validateLegacyProducer(input?: {
  version?: unknown;
  sourceRevision?: unknown;
}): LegacyProducer {
  const version = input?.version;
  const revision = input?.sourceRevision;
  if (
    (version !== undefined && version !== LEGACY_PRODUCER_VERSION) ||
    (revision !== undefined && revision !== LEGACY_SOURCE_REVISION)
  )
    throw new HistoryConversionError(
      'UNSUPPORTED_SOURCE_PROFILE',
      'The recorded producer differs from the supported local source profile'
    );
  return Object.freeze({
    version: version === undefined ? null : LEGACY_PRODUCER_VERSION,
    sourceRevision: revision === undefined ? null : LEGACY_SOURCE_REVISION,
    evidence: version === undefined && revision === undefined ? 'unknown' : 'recorded',
  });
}

// Version agreement is only a precondition; each resource still needs its frozen structural decoder.
export function assertLegacySchemaVersion(resource: string, version: unknown): void {
  const allowed = Object.hasOwn(schemaVersions, resource)
    ? (schemaVersions[resource as LegacyVersionedResource] as readonly number[])
    : undefined;
  if (typeof version !== 'number' || !allowed?.includes(version))
    throw new HistoryConversionError(
      'UNSUPPORTED_RESOURCE_SCHEMA',
      'The retained resource does not use a supported source schema',
      resource
    );
}
