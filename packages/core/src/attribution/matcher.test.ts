import { describe, expect, it } from 'vitest';

import { lineContentMatch } from './line-match.js';
import { isKnownWeakHunk, type ManifestSource, matchDiffAgainstManifests } from './matcher.js';
import type { DiffFingerprintManifest } from '../diff-fingerprint/adapter.js';
import { buildDiffFingerprintManifest } from '../diff-fingerprint/adapter.js';

/**
 * Matcher core.
 *
 * Manifests are built with the REAL pipeline (`buildDiffFingerprintManifest`)
 * from hand-written unified diffs, so patch/line hashes are the genuine
 * capture-time values — equality in these tests proves recipe identity,
 * not fixture wiring.
 */

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

function diffAddingLines(file: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 0000001..0000002 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,1 +1,${1 + lines.length} @@`,
    ' context line',
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

const PURE_RENAME_DIFF = [
  'diff --git a/old-name.ts b/new-name.ts',
  'similarity index 100%',
  'rename from old-name.ts',
  'rename to new-name.ts',
  '',
].join('\n');

const MODE_CHANGE_DIFF = [
  'diff --git a/script.sh b/script.sh',
  'old mode 100644',
  'new mode 100755',
  '',
].join('\n');

const BINARY_DIFF = [
  'diff --git a/img.bin b/img.bin',
  'index 0000001..0000002 100644',
  'Binary files a/img.bin and b/img.bin differ',
  '',
].join('\n');

async function manifestFor(diffText: string, checkpointN = 1): Promise<DiffFingerprintManifest> {
  const built = await buildDiffFingerprintManifest({
    artifactId: 'art-fixture',
    checkpointN,
    openTreeSha: TREE_A,
    closeTreeSha: TREE_B,
    diffBytes: new TextEncoder().encode(diffText),
    truncated: false,
    maxDiffBytes: 2_000_000,
  });
  if (built.manifest === null) throw new Error(`fixture manifest failed: ${built.status}`);
  return built.manifest;
}

function source(
  manifest: DiffFingerprintManifest,
  overrides: Partial<Omit<ManifestSource, 'manifest'>> = {}
): ManifestSource {
  return {
    artifact_id: overrides.artifact_id ?? 'art-1',
    checkpoint_n: overrides.checkpoint_n ?? 1,
    ts: overrides.ts ?? '2026-07-02T10:00:00.000Z',
    manifest,
  };
}

async function match(diffText: string, sources: ManifestSource[]) {
  return matchDiffAgainstManifests({
    diffBytes: new TextEncoder().encode(diffText),
    truncated: false,
    maxDiffBytes: 2_000_000,
    sources,
  });
}

describe('matchDiffAgainstManifests', () => {
  it('attributes an identical hunk as an exact match', async () => {
    const diff = diffAddingLines('src/a.ts', ['const meaningfulWork = computeThing(42);']);
    const m = await manifestFor(diff);
    const result = await match(diff, [source(m)]);

    expect(result.coverage).toMatchObject({
      total_hunks: 1,
      attributed_hunks: 1,
      ambiguous_hunks: 0,
      unattributed_hunks: 0,
      known_weak_hunks: 0,
      attributed_pct: 100,
    });
    expect(result.hunks[0].matches).toEqual([
      { artifact_id: 'art-1', checkpoint_n: 1, match: 'exact', manifest_file: 'src/a.ts' },
    ]);
  });

  it('classifies same content under a different path as a content match (non-ambiguous when big enough)', async () => {
    const lines = [
      'const one = buildFirstThing();',
      'const two = buildSecondThing();',
      'const three = buildThirdThing();',
    ];
    const m = await manifestFor(diffAddingLines('src/original.ts', lines));
    const result = await match(diffAddingLines('src/moved.ts', lines), [source(m)]);

    expect(result.hunks[0].matches[0]).toMatchObject({
      match: 'content',
      manifest_file: 'src/original.ts',
    });
    expect(result.hunks[0].ambiguous).toBe(false);
    expect(result.coverage.attributed_hunks).toBe(1);
  });

  it('marks tiny cross-file content matches ambiguous (they collide by construction)', async () => {
    const m = await manifestFor(diffAddingLines('src/a.ts', ['return null;']));
    const result = await match(diffAddingLines('src/b.ts', ['return null;']), [source(m)]);

    expect(result.hunks[0].matches).toHaveLength(1);
    expect(result.hunks[0].ambiguous).toBe(true);
    expect(result.coverage).toMatchObject({
      attributed_hunks: 0,
      ambiguous_hunks: 1,
      attributed_pct: 0,
    });
  });

  it('marks multi-artifact matches ambiguous and orders matches by recency', async () => {
    const diff = diffAddingLines('src/a.ts', ['const sharedAcrossArtifacts = true;']);
    const m1 = await manifestFor(diff);
    const m2 = await manifestFor(diff, 2);
    const result = await match(diff, [
      source(m1, { artifact_id: 'art-old', ts: '2026-07-01T00:00:00.000Z' }),
      source(m2, { artifact_id: 'art-new', checkpoint_n: 2, ts: '2026-07-02T00:00:00.000Z' }),
    ]);

    expect(result.hunks[0].ambiguous).toBe(true);
    expect(result.hunks[0].matches.map((x) => x.artifact_id)).toEqual(['art-new', 'art-old']);
    expect(result.coverage.ambiguous_hunks).toBe(1);
  });

  it('excludes known-weak hunks on BOTH sides (rename, mode change, binary)', async () => {
    // Manifest contains a pure rename; live diff contains a DIFFERENT
    // pure rename plus a mode change and a binary hunk — all share
    // per-change_type constant patch_hashes, none may match.
    const renameManifest = await manifestFor(PURE_RENAME_DIFF);
    const liveRename = [
      'diff --git a/completely-unrelated.ts b/somewhere-else.ts',
      'similarity index 100%',
      'rename from completely-unrelated.ts',
      'rename to somewhere-else.ts',
      '',
    ].join('\n');
    const liveDiff = liveRename + MODE_CHANGE_DIFF + BINARY_DIFF;
    const result = await match(liveDiff, [source(renameManifest)]);

    expect(result.coverage.total_hunks).toBe(3);
    expect(result.coverage.known_weak_hunks).toBe(3);
    expect(result.coverage.attributed_hunks).toBe(0);
    expect(result.coverage.attributed_pct).toBeNull();
    for (const hunk of result.hunks) {
      expect(hunk.known_weak).toBe(true);
      expect(hunk.matches).toEqual([]);
    }
  });

  it('reports truncated-manifest sources for disclosure', async () => {
    const m = await manifestFor(diffAddingLines('src/a.ts', ['const x = partialCapture();']));
    const truncated = { ...m, status: 'truncated' as const, truncated: true };
    const result = await match(diffAddingLines('src/other.ts', ['const y = neverCaptured();']), [
      source(truncated, { artifact_id: 'art-t', checkpoint_n: 3 }),
    ]);

    expect(result.truncated_manifest_checkpoints).toEqual([
      { artifact_id: 'art-t', checkpoint_n: 3 },
    ]);
    expect(result.coverage.unattributed_hunks).toBe(1);
  });

  it('isKnownWeakHunk is exactly the zero-changed-lines predicate', () => {
    expect(isKnownWeakHunk({ added_line_count: 0, deleted_line_count: 0 })).toBe(true);
    expect(isKnownWeakHunk({ added_line_count: 1, deleted_line_count: 0 })).toBe(false);
    expect(isKnownWeakHunk({ added_line_count: 0, deleted_line_count: 2 })).toBe(false);
  });
});

describe('lineContentMatch', () => {
  it('finds the checkpoint that added an exact line, with the carrying manifest file', async () => {
    const line = 'const meaningfulWork = computeThing(42);';
    const m = await manifestFor(diffAddingLines('src/a.ts', [line]));
    const result = await lineContentMatch([source(m)], line);

    expect(result.trivial).toBe(false);
    expect(result.matches).toEqual([
      { artifact_id: 'art-1', checkpoint_n: 1, manifest_files: ['src/a.ts'] },
    ]);
  });

  it('discloses a DIFFERENT manifest file when the same content lives elsewhere', async () => {
    const line = 'const sharedHelper = buildSharedHelper(7);';
    const m = await manifestFor(diffAddingLines('src/original.ts', [line]));
    const result = await lineContentMatch([source(m)], line);
    // The caller asked about SOME file; the evidence names where the
    // content actually was — cross-file classification happens upstream.
    expect(result.matches[0].manifest_files).toEqual(['src/original.ts']);
  });

  it('does not match a line the checkpoint never added', async () => {
    const m = await manifestFor(diffAddingLines('src/a.ts', ['const original = 1;']));
    const result = await lineContentMatch([source(m)], 'const somethingElse = 2;');
    expect(result.matches).toEqual([]);
  });

  it('guards trivial lines instead of matching them', async () => {
    const m = await manifestFor(diffAddingLines('src/a.ts', ['}']));
    const result = await lineContentMatch([source(m)], '}');
    expect(result.trivial).toBe(true);
    expect(result.matches).toEqual([]);
  });
});
