import { describe, expect, it } from 'vitest';

import {
  buildDiffFingerprintManifest,
  computeDiffFingerprintManifestHash,
  summarizeManifest,
} from '@orcaops/diff-fingerprint';

import { validateCheckpointFingerprintManifest } from './diff-fingerprint.js';

async function fixture() {
  const artifactId = '019dd0f3-a2ca-7e65-8ef4-28e6ab262c5e';
  const openTreeSha = 'a'.repeat(40);
  const closeTreeSha = 'b'.repeat(40);
  const built = await buildDiffFingerprintManifest({
    artifactId,
    checkpointN: 1,
    openTreeSha,
    closeTreeSha,
    diffBytes: Buffer.from(
      'diff --git a/value.ts b/value.ts\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-old\n+new\n'
    ),
    truncated: false,
    maxDiffBytes: 100_000,
  });
  if (built.manifest === null) throw new Error('Expected a manifest fixture');
  return {
    artifactId,
    openTreeSha,
    closeTreeSha,
    manifest: built.manifest,
    summary: built.summary,
  };
}

describe('checkpoint fingerprint manifest validation', () => {
  it('accepts a manifest consistent with its retained checkpoint', async () => {
    const f = await fixture();
    await expect(
      validateCheckpointFingerprintManifest({
        artifactId: f.artifactId,
        checkpointN: 1,
        openTreeSha: f.openTreeSha,
        closeTreeSha: f.closeTreeSha,
        summary: f.summary,
        manifest: f.manifest,
      })
    ).resolves.toEqual({ available: true, manifest: f.manifest });
  });

  it.each(['artifact', 'checkpoint', 'tree', 'hash'] as const)(
    'rejects a structurally valid manifest with mismatched %s identity',
    async (mismatch) => {
      const f = await fixture();
      const manifest = structuredClone(f.manifest);
      let summary = structuredClone(f.summary);
      if (mismatch === 'artifact') manifest.artifact_id = '019dd0f3-a2ca-7e65-8ef4-28e6ab262c5f';
      if (mismatch === 'checkpoint') manifest.checkpoint_n = 2;
      if (mismatch === 'tree') manifest.open_tree_sha = 'c'.repeat(40);
      if (mismatch !== 'hash')
        summary = summarizeManifest(manifest, await computeDiffFingerprintManifestHash(manifest));
      else summary.manifest_hash = 'forged';
      const original = structuredClone(manifest);

      await expect(
        validateCheckpointFingerprintManifest({
          artifactId: f.artifactId,
          checkpointN: 1,
          openTreeSha: f.openTreeSha,
          closeTreeSha: f.closeTreeSha,
          summary,
          manifest,
        })
      ).resolves.toEqual({ available: false, reason: 'mismatched' });
      expect(manifest).toEqual(original);
    }
  );

  it('accepts a recovered manifest only for an empty physical fence', async () => {
    const f = await fixture();
    for (const [openTreeSha, closeTreeSha] of [
      ['f'.repeat(40), f.closeTreeSha],
      ['f'.repeat(40), 'f'.repeat(40)],
    ]) {
      await expect(
        validateCheckpointFingerprintManifest({
          artifactId: f.artifactId,
          checkpointN: 1,
          openTreeSha,
          closeTreeSha,
          summary: f.summary,
          manifest: f.manifest,
          recoveredOpenTreeSha: f.openTreeSha,
        })
      ).resolves.toEqual({ available: false, reason: 'mismatched' });
    }

    await expect(
      validateCheckpointFingerprintManifest({
        artifactId: f.artifactId,
        checkpointN: 1,
        openTreeSha: f.closeTreeSha,
        closeTreeSha: f.closeTreeSha,
        summary: f.summary,
        manifest: f.manifest,
        recoveredOpenTreeSha: f.openTreeSha,
      })
    ).resolves.toEqual({ available: true, manifest: f.manifest });
    await expect(
      validateCheckpointFingerprintManifest({
        artifactId: f.artifactId,
        checkpointN: 1,
        openTreeSha: f.closeTreeSha,
        closeTreeSha: f.closeTreeSha,
        summary: f.summary,
        manifest: f.manifest,
        recoveredOpenTreeSha: 'c'.repeat(40),
      })
    ).resolves.toEqual({ available: false, reason: 'mismatched' });
  });
});
