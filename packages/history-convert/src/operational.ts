import { createHash } from 'node:crypto';

import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { UploadsIndexEntrySchema } from './legacy-operations/plan/upload.js';
import {
  PersistedSeedEnrichmentSchema,
  SeedEnrichmentManifestSchema,
  SeedEnrichmentSchema,
} from './legacy-operations/seed/enrichment.js';
import {
  SeedCoverageReportSchema,
  SeedJournalSchema,
  SeedJournalV1Schema,
  SeedPreciousStateSchema,
} from './legacy-operations/seed/journal.js';
import {
  PathPointerSchema,
  PullCacheRecordSchema,
} from './legacy-operations/storage/source-plan/pull-cache.js';
import { ReviewPullRecordSchema } from './legacy-operations/storage/source-plan/review-pull-cache.js';

const schemas = {
  source_plan_pull: PullCacheRecordSchema,
  source_plan_path: PathPointerSchema,
  source_plan_review_pull: ReviewPullRecordSchema,
  source_plan_upload: UploadsIndexEntrySchema,
  seed_journal: SeedJournalSchema.or(SeedJournalV1Schema),
  seed_state: SeedPreciousStateSchema,
  seed_coverage: SeedCoverageReportSchema,
  seed_enrichment: SeedEnrichmentSchema,
  seed_enrichment_retained: PersistedSeedEnrichmentSchema,
  seed_bundle: SeedEnrichmentManifestSchema,
};
export type LegacyOperationalKind = keyof typeof schemas;
export interface LegacyOperationalFile {
  readonly kind: LegacyOperationalKind;
  readonly sha256: string;
  readonly bytesBase64: string;
  readonly value: unknown;
}
const decoded = new WeakSet<LegacyOperationalFile>();
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function invalid(kind: string, message: string): never {
  throw new HistoryConversionError('SOURCE_INTEGRITY', message, kind);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function decodeLegacyOperationalFile(
  kind: LegacyOperationalKind,
  input: Buffer
): LegacyOperationalFile {
  const bytes = Buffer.from(input);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return invalid(kind, 'Retained operational source is not complete UTF-8 JSON');
  }
  const schema = Object.hasOwn(schemas, kind) ? schemas[kind] : null;
  if (!schema) invalid(kind, 'Retained operational source kind is unsupported');
  const parsed = schema.safeParse(raw);
  if (!parsed.success || canonicalJson(raw) !== canonicalJson(parsed.data))
    invalid(kind, 'Retained operational source does not match its complete frozen representation');
  const fields = raw as Record<string, unknown>;
  if (kind === 'source_plan_pull' || kind === 'source_plan_review_pull') {
    const body = fields.body;
    if (typeof body !== 'string' || fields.content_hash !== hash(body))
      invalid(kind, 'Retained operational content differs from its recorded checksum');
  }
  const result = freeze({
    kind,
    sha256: hash(bytes),
    bytesBase64: bytes.toString('base64'),
    value: raw,
  });
  decoded.add(result);
  return result;
}

export function assertDecodedLegacyOperationalFile(value: LegacyOperationalFile): void {
  if (!decoded.has(value))
    invalid(value.kind, 'Operational import requires an independently decoded source');
}
