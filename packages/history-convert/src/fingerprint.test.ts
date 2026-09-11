import { describe, expect, it } from 'vitest';

import { buildDiffFingerprintManifest } from '@orcaops/diff-fingerprint';

import {
  assertDecodedLegacyDerivedFingerprint,
  decodeLegacyDerivedFingerprint,
} from './fingerprint.js';
import {
  computeChecksum,
  type DerivedFingerprintCacheEntry,
} from './legacy-operations/cli/fingerprint-cache.js';

const encode = (value: Omit<DerivedFingerprintCacheEntry, 'checksum'>) =>
  Buffer.from(JSON.stringify({ ...value, checksum: computeChecksum(value) }, null, 2) + '\n');
async function fixture() {
  const source = {
    artifactId: '01999999-9999-7000-8000-000000000001',
    checkpointN: 1,
    openTreeSha: 'a'.repeat(40),
    closeTreeSha: 'b'.repeat(40),
    maxDiffBytes: 1024,
  };
  const built = await buildDiffFingerprintManifest({
    ...source,
    diffBytes: Buffer.from(
      'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
    ),
    truncated: false,
  });
  expect(built.manifest).not.toBeNull();
  const entry: Omit<DerivedFingerprintCacheEntry, 'checksum'> = {
    schema_version: 1,
    artifact_id: source.artifactId,
    checkpoint_n: source.checkpointN,
    source: 'stored_manifest_trees',
    open_tree_sha: source.openTreeSha,
    close_tree_sha: source.closeTreeSha,
    max_diff_bytes: 1024,
    manifest_hash_stored: built.summary.manifest_hash,
    verified: true,
    note: null,
    manifest: built.manifest,
    derived_summary: {
      status: built.summary.status,
      manifest_hash: built.summary.manifest_hash,
      hunk_count: built.summary.hunk_count,
      captured_hunk_count: built.summary.captured_hunk_count,
      truncated: built.summary.truncated,
    },
  };
  return { entry, manifest: built.manifest! };
}
describe('retained derived fingerprint evidence', () => {
  it('checks both source JSON-order checksum and pinned manifest hash while retaining exact original bytes', async () => {
    const { entry } = await fixture();
    const bytes = encode(entry);
    const original = Buffer.from(bytes);
    const pending = decodeLegacyDerivedFingerprint(bytes);
    bytes.fill(0);
    const result = await pending;
    expect(Buffer.from(result.bytesBase64, 'base64')).toEqual(original);
    expect(result.value.verified).toBe(true);
    expect(() => assertDecodedLegacyDerivedFingerprint(result)).not.toThrow();
    expect(() => assertDecodedLegacyDerivedFingerprint({ ...result })).toThrow();
    const parsed = JSON.parse(original.toString());
    await expect(
      decodeLegacyDerivedFingerprint(Buffer.from(JSON.stringify({ ...parsed, note: 'changed' })))
    ).rejects.toMatchObject({ code: 'SOURCE_INTEGRITY' });
  });
  it('refuses coordinated outer-checksum updates that alter references or derived summary', async () => {
    const { entry, manifest } = await fixture();
    for (const change of [
      { max_diff_bytes: 2048 },
      { checkpoint_n: 2 },
      { close_tree_sha: 'c'.repeat(40) },
      { manifest: { ...manifest, hunks: [] } },
      { derived_summary: { ...entry.derived_summary, hunk_count: 2 } },
      { verified: false },
    ])
      await expect(
        decodeLegacyDerivedFingerprint(encode({ ...entry, ...change }))
      ).rejects.toMatchObject({ code: 'SOURCE_INTEGRITY' });
  });
  it('preserves explicitly unverified and unavailable derivations without upgrading their status', async () => {
    const { entry } = await fixture();
    const mismatch = await decodeLegacyDerivedFingerprint(
      encode({
        ...entry,
        manifest_hash_stored: 'different-original-hash',
        verified: false,
        note: 'Retained disagreement',
      })
    );
    expect(mismatch.value).toMatchObject({ verified: false, note: 'Retained disagreement' });
    const skipped = {
      ...entry,
      manifest: null,
      manifest_hash_stored: null,
      verified: null,
      derived_summary: {
        status: 'skipped',
        manifest_hash: null,
        hunk_count: 0,
        captured_hunk_count: 0,
        truncated: false,
      },
    };
    expect((await decodeLegacyDerivedFingerprint(encode(skipped))).value.manifest).toBeNull();
    await expect(
      decodeLegacyDerivedFingerprint(
        encode({
          ...skipped,
          derived_summary: { ...skipped.derived_summary, captured_hunk_count: 1 },
        })
      )
    ).rejects.toMatchObject({ code: 'SOURCE_INTEGRITY' });
  });
});
