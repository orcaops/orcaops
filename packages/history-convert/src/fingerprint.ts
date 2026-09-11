import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  computeDiffFingerprintManifestHash,
  DiffFingerprintManifestSchema,
  DiffFingerprintStatusSchema,
  summarizeManifest,
} from '@orcaops/diff-fingerprint';

import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { UuidV7Schema } from './legacy/storage/ids/uuidv7.js';
import {
  computeChecksum,
  type DerivedFingerprintCacheEntry,
} from './legacy-operations/cli/fingerprint-cache.js';

const count = z.number().int().nonnegative();
const tree = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const schema: z.ZodType<DerivedFingerprintCacheEntry> = z.strictObject({
  schema_version: z.literal(1),
  artifact_id: UuidV7Schema,
  checkpoint_n: z.number().int().positive(),
  source: z.enum(['stored_manifest_trees', 'snapshot_boundaries']),
  open_tree_sha: tree,
  close_tree_sha: tree,
  max_diff_bytes: z.number().int().positive(),
  manifest_hash_stored: z.string().min(1).nullable(),
  verified: z.boolean().nullable(),
  note: z.string().nullable(),
  manifest: DiffFingerprintManifestSchema.nullable(),
  derived_summary: z.strictObject({
    status: DiffFingerprintStatusSchema,
    manifest_hash: z.string().min(1).nullable(),
    hunk_count: count,
    captured_hunk_count: count,
    truncated: z.boolean(),
  }),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});
export interface LegacyDerivedFingerprint {
  readonly sha256: string;
  readonly bytesBase64: string;
  readonly value: DerivedFingerprintCacheEntry;
}
const decoded = new WeakSet<LegacyDerivedFingerprint>();
function fail(): never {
  throw new HistoryConversionError(
    'SOURCE_INTEGRITY',
    'Retained derived fingerprint differs from its frozen structure, checksum or references'
  );
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export async function decodeLegacyDerivedFingerprint(
  input: Buffer
): Promise<LegacyDerivedFingerprint> {
  const bytes = Buffer.from(input);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    fail();
  }
  const result = schema.safeParse(raw);
  if (!result.success || canonicalJson(result.data) !== canonicalJson(raw)) fail();
  const value = raw as DerivedFingerprintCacheEntry;
  const { checksum, ...original } = value;
  if (computeChecksum(original) !== checksum) fail();
  const manifest =
    value.manifest === null ? null : DiffFingerprintManifestSchema.parse(value.manifest);
  if (manifest) {
    if (
      manifest.artifact_id !== value.artifact_id ||
      manifest.checkpoint_n !== value.checkpoint_n ||
      manifest.open_tree_sha !== value.open_tree_sha ||
      manifest.close_tree_sha !== value.close_tree_sha ||
      manifest.limits.max_diff_bytes !== value.max_diff_bytes
    )
      fail();
    const digest = await computeDiffFingerprintManifestHash(manifest);
    const summary = summarizeManifest(manifest, digest);
    const expected = {
      status: summary.status,
      manifest_hash: summary.manifest_hash,
      hunk_count: summary.hunk_count,
      captured_hunk_count: summary.captured_hunk_count,
      truncated: summary.truncated,
    };
    if (canonicalJson(value.derived_summary) !== canonicalJson(expected)) fail();
  } else if (
    value.derived_summary.status !== 'skipped' ||
    value.derived_summary.manifest_hash !== null ||
    value.derived_summary.hunk_count !== 0 ||
    value.derived_summary.captured_hunk_count !== 0
  )
    fail();
  const verified =
    value.manifest_hash_stored === null
      ? null
      : value.manifest_hash_stored === value.derived_summary.manifest_hash;
  if (value.verified !== verified) fail();
  const retained = freeze({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytesBase64: bytes.toString('base64'),
    value,
  });
  decoded.add(retained);
  return retained;
}
export function assertDecodedLegacyDerivedFingerprint(value: LegacyDerivedFingerprint): void {
  if (!decoded.has(value)) fail();
}
