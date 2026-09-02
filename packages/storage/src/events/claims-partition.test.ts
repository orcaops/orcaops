import { describe, expect, it } from 'vitest';

import {
  applyClaimsPartition,
  applyUnmergedExclusion,
  type PartitionSegment,
  type PartitionSibling,
  replayAttributionDegradedRemovals,
  replayWindowOverlapRemovals,
} from './claims-partition.js';
import { DiffFingerprintManifestSchema } from '../schema/diff-fingerprint.js';
import type {
  DiffFingerprintManifest,
  DiffFingerprintSummary,
} from '../schema/diff-fingerprint.js';

// ── Fixture builders ─────────────────────────────────────────────────

let hunkIdx = 0;
function hunk(fileBefore: string | null, fileAfter: string | null) {
  hunkIdx += 1;
  return {
    hunk_index: hunkIdx,
    file_before: fileBefore,
    file_after: fileAfter,
    change_type: (fileBefore === null ? 'add' : fileAfter === null ? 'delete' : 'modify') as
      | 'add'
      | 'delete'
      | 'modify',
    old_start: 1,
    old_lines: 1,
    new_start: 1,
    new_lines: 1,
    binary: false,
    patch_hash: `ph-${hunkIdx}`,
    added_line_hashes: ['lh-a'],
    deleted_line_hashes: [],
    hunk_header_hash: null,
    added_line_count: 1,
    deleted_line_count: 0,
  };
}

function manifestWith(
  hunks: ReturnType<typeof hunk>[],
  overrides: Partial<DiffFingerprintManifest> = {}
): DiffFingerprintManifest {
  return DiffFingerprintManifestSchema.parse({
    schema_version: 1,
    artifact_id: 'art-1',
    checkpoint_n: 1,
    open_tree_sha: 'a'.repeat(40),
    close_tree_sha: 'b'.repeat(40),
    status: 'captured',
    hunk_count: hunks.length,
    captured_hunk_count: hunks.length,
    truncated: false,
    error_reason: null,
    normalization_version: 'orcaops-line-normalization-v1',
    diff_algorithm: 'git-diff-unified-v1',
    diff_options: { unified: 3, find_renames: true, no_ext_diff: true },
    limits: { max_diff_bytes: 1048576 },
    hash_encoding: 'base64url-nopad',
    line_hash_algorithm: 'blake3-xof-96-base64url-nopad-v2',
    patch_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
    hunk_header_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
    manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
    hunks,
    ...overrides,
  });
}

function summaryFor(manifest: DiffFingerprintManifest): DiffFingerprintSummary {
  return {
    status: manifest.status,
    hunk_count: manifest.hunk_count,
    captured_hunk_count: manifest.captured_hunk_count,
    truncated: manifest.truncated,
    fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2',
    manifest_hash: 'pre-partition-hash',
    manifest_hash_algorithm: manifest.manifest_hash_algorithm,
    error_reason: null,
  };
}

const seg = (
  activeNs: number[],
  changedFiles: string[] | null,
  idx: [number, number],
  degradedReason: string | null = changedFiles === null ? 'missing_boundary_tree' : null
): PartitionSegment => ({
  fromEventIdx: idx[0],
  toEventIdx: idx[1],
  activeNs,
  kind: activeNs.length === 1 ? 'exclusive' : 'concurrent',
  changedFiles,
  degradedReason,
});

const sib = (
  n: number,
  status: PartitionSibling['status'],
  filesChanged: string[] = []
): PartitionSibling => ({ n, status, filesChanged });

// Closing cp is n=1 throughout. Timeline for most tests:
//   1.open(e0) → 2.open(e1) → [2.close(e2)] → 1.close(e3, appended)
// Segment [e0,e1] is exclusive-1; [e1,e2] / [e1,e3] concurrent.

describe('applyClaimsPartition', () => {
  it('keeps a file changed only in an exclusive-me segment even when unreported (segment-attributed)', async () => {
    const m = manifestWith([hunk('forgot.ts', 'forgot.ts'), hunk('claimed.ts', 'claimed.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['claimed.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed', ['other.ts'])],
      segments: [seg([1], ['forgot.ts'], [0, 1]), seg([1, 2], ['claimed.ts', 'other.ts'], [1, 3])],
      crossArtifactSiblings: [],
    });
    // Unreported exclusive file kept, recorded; manifest untouched (no removals).
    expect(out.windowOverlap.segment_attributed).toEqual(['forgot.ts']);
    expect(out.windowOverlap.dropped_files).toEqual([]);
    expect(out.manifest).toBe(m);
    expect(out.summary.manifest_hash).toBe('pre-partition-hash');
  });

  it('rejects an own claim contradicted by segments (changed only while not open)', async () => {
    // n=1 claims before.ts, but it changed only in the sibling-exclusive
    // segment outside n=1's window — and is absent from n=1's fence.
    const m = manifestWith([hunk('mine.ts', 'mine.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['mine.ts', 'before.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed', [])],
      segments: [
        seg([2], ['before.ts'], [0, 1]), // 2-exclusive, before 1 opened
        seg([1, 2], ['mine.ts'], [1, 2]),
      ],
      crossArtifactSiblings: [],
    });
    expect(out.windowOverlap.rejected_claims).toEqual(['before.ts']);
    // mine.ts: concurrent + only my claim + no pending → kept clean.
    expect(out.windowOverlap.dropped_files).toEqual([]);
    expect(out.windowOverlap.own_claim_pending).toEqual([]);
  });

  it('splits pending states by claim: own_claim_pending KEPT, sibling_pending REMOVED', async () => {
    const m = manifestWith([hunk('mine.ts', 'mine.ts'), hunk('theirs.ts', 'theirs.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['mine.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'open')],
      segments: [seg([1, 2], ['mine.ts', 'theirs.ts'], [0, 2])],
      crossArtifactSiblings: [],
    });
    expect(out.windowOverlap.pending).toBe(true);
    expect(out.windowOverlap.own_claim_pending).toEqual([
      { file_before: 'mine.ts', file_after: 'mine.ts' },
    ]);
    expect(out.windowOverlap.dropped_files).toEqual([
      { file_before: 'theirs.ts', file_after: 'theirs.ts', status: 'sibling_pending' },
    ]);
    // Kept: mine.ts only. Summary recomputed to match the filtered manifest.
    expect(out.manifest?.hunks.map((h) => h.file_after)).toEqual(['mine.ts']);
    expect(out.manifest?.hunk_count).toBe(1);
    expect(out.summary.hunk_count).toBe(1);
    expect(out.summary.manifest_hash).not.toBe('pre-partition-hash');
  });

  it('distinguishes sibling-claimed vs unclaimed removals when all siblings closed', async () => {
    const m = manifestWith([
      hunk('mine.ts', 'mine.ts'),
      hunk('theirs.ts', 'theirs.ts'),
      hunk('nobody.ts', 'nobody.ts'),
    ]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['mine.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed', ['theirs.ts'])],
      segments: [seg([1, 2], ['mine.ts', 'theirs.ts', 'nobody.ts'], [0, 2])],
      crossArtifactSiblings: [],
    });
    expect(out.windowOverlap.dropped_files).toEqual([
      { file_before: 'nobody.ts', file_after: 'nobody.ts', status: 'unclaimed' },
      { file_before: 'theirs.ts', file_after: 'theirs.ts', status: 'sibling-claimed' },
    ]);
    // Last close (no pending) → nobody.ts is finalized unattributed.
    expect(out.windowOverlap.unattributed_in_window).toEqual(['nobody.ts']);
    expect(out.windowOverlap.pending).toBe(false);
  });

  it('flags symmetric both-claim ambiguity, kept in the manifest', async () => {
    const m = manifestWith([hunk('shared.ts', 'shared.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['shared.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed', ['shared.ts'])],
      segments: [seg([1, 2], ['shared.ts'], [0, 2])],
      crossArtifactSiblings: [],
    });
    expect(out.windowOverlap.ambiguous_files).toEqual([
      { file_before: 'shared.ts', file_after: 'shared.ts' },
    ]);
    expect(out.manifest).toBe(m); // kept — no removals, byte-identical pass-through
    expect(out.windowOverlap.dropped_files).toEqual([]);
  });

  it('keeps a mixed-segment file on evidence regardless of self-report, flagged', async () => {
    // The under-reported exclusive owner: n=1 changed both.ts in its
    // exclusive segment, forgot to claim it, and it was ALSO touched
    // concurrently — the sibling claims it. Segment proof outranks the
    // sibling's claim: kept in n=1's manifest, flagged mixed_segment,
    // NEVER removed as sibling-claimed.
    const m = manifestWith([hunk('both.ts', 'both.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: [],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed', ['both.ts'])],
      segments: [seg([1], ['both.ts'], [0, 1]), seg([1, 2], ['both.ts'], [1, 3])],
      crossArtifactSiblings: [],
    });
    expect(out.windowOverlap.mixed_segment).toEqual([
      { file_before: 'both.ts', file_after: 'both.ts' },
    ]);
    expect(out.windowOverlap.dropped_files).toEqual([]);
    expect(out.manifest).toBe(m);
  });

  it('degrades to claims-only when segments are missing, disclosed — never silent', async () => {
    const m = manifestWith([hunk('mine.ts', 'mine.ts'), hunk('theirs.ts', 'theirs.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['mine.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed', ['theirs.ts'])],
      segments: [seg([1, 2], null, [0, 2])],
      crossArtifactSiblings: [],
    });
    expect(out.windowOverlap.degradations).toEqual(['missing_boundary_tree:0-2']);
    // Claims still arbitrate: mine kept, theirs dropped as sibling-claimed.
    expect(out.manifest?.hunks.map((h) => h.file_after)).toEqual(['mine.ts']);
    expect(out.windowOverlap.dropped_files).toEqual([
      { file_before: 'theirs.ts', file_after: 'theirs.ts', status: 'sibling-claimed' },
    ]);
  });

  it('cross-artifact overlap voids segments: claims-only, always pending, disclosed', async () => {
    const m = manifestWith([hunk('mine.ts', 'mine.ts'), hunk('theirs.ts', 'theirs.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['mine.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [],
      // Intact segments supplied — but cross-artifact voids them: the
      // foreign agent shares the worktree, so "exclusive" is unprovable.
      segments: [seg([1], ['mine.ts', 'theirs.ts'], [0, 1])],
      crossArtifactSiblings: [{ artifact_id: 'other-art', n: 3 }],
    });
    expect(out.windowOverlap.pending).toBe(true);
    expect(out.windowOverlap.cross_artifact_siblings).toEqual([{ artifact_id: 'other-art', n: 3 }]);
    expect(out.windowOverlap.degradations).toContain('cross_artifact_claims_only');
    expect(out.windowOverlap.own_claim_pending).toEqual([
      { file_before: 'mine.ts', file_after: 'mine.ts' },
    ]);
    expect(out.windowOverlap.dropped_files).toEqual([
      { file_before: 'theirs.ts', file_after: 'theirs.ts', status: 'sibling_pending' },
    ]);
    // Not the last close — never finalize unattributed under pending.
    expect(out.windowOverlap.unattributed_in_window).toEqual([]);
  });

  it('filters a sibling-owned rename under BOTH paths (dual-path disposition)', async () => {
    // Sibling renamed old.ts → new.ts and claims only the NEW path; the
    // rename hunk carries both identities. A single-path record would
    // let it survive under the other name.
    const m = manifestWith([hunk('old.ts', 'new.ts'), hunk('mine.ts', 'mine.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['mine.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed', ['new.ts'])],
      segments: [seg([1, 2], ['old.ts', 'new.ts', 'mine.ts'], [0, 2])],
      crossArtifactSiblings: [],
    });
    expect(out.windowOverlap.dropped_files).toEqual([
      { file_before: 'old.ts', file_after: 'new.ts', status: 'sibling-claimed' },
    ]);
    expect(out.manifest?.hunks.map((h) => h.file_after)).toEqual(['mine.ts']);
  });

  it('filters a sibling-owned deletion (file_after null) via file_before', async () => {
    const m = manifestWith([hunk('gone.ts', null), hunk('mine.ts', 'mine.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['mine.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed', ['gone.ts'])],
      segments: [seg([1, 2], ['gone.ts', 'mine.ts'], [0, 2])],
      crossArtifactSiblings: [],
    });
    expect(out.windowOverlap.dropped_files).toEqual([
      { file_before: 'gone.ts', file_after: null, status: 'sibling-claimed' },
    ]);
  });

  it('keeps a claimed rename whether the claim names the old or the new path', async () => {
    const renameHunk = () => hunk('old-name.ts', 'new-name.ts');
    for (const claimPath of ['old-name.ts', 'new-name.ts']) {
      const m = manifestWith([renameHunk()]);
      const out = await applyClaimsPartition({
        currentN: 1,
        ownClaim: [claimPath],
        manifest: m,
        summary: summaryFor(m),
        siblings: [sib(2, 'closed', [])],
        segments: [seg([1, 2], ['old-name.ts', 'new-name.ts'], [0, 2])],
        crossArtifactSiblings: [],
      });
      expect(out.windowOverlap.dropped_files).toEqual([]);
      expect(out.manifest?.hunks).toHaveLength(1);
    }
  });

  it('passes manifest and summary through untouched when nothing is removed', async () => {
    const m = manifestWith([hunk('a.ts', 'a.ts')]);
    const s = summaryFor(m);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['a.ts'],
      manifest: m,
      summary: s,
      siblings: [sib(2, 'closed', [])],
      segments: [seg([1], ['a.ts'], [0, 1]), seg([1, 2], [], [1, 2])],
      crossArtifactSiblings: [],
    });
    expect(out.manifest).toBe(m);
    expect(out.summary).toBe(s);
  });

  it('handles a null manifest (fingerprinting skipped) while still recording the overlap', async () => {
    const skipped: DiffFingerprintSummary = {
      status: 'skipped',
      hunk_count: 0,
      captured_hunk_count: 0,
      truncated: false,
      fingerprint_algorithm: null,
      manifest_hash: null,
      manifest_hash_algorithm: null,
      error_reason: null,
    };
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['mine.ts'],
      manifest: null,
      summary: skipped,
      siblings: [sib(2, 'open')],
      segments: [],
      crossArtifactSiblings: [],
    });
    expect(out.manifest).toBeNull();
    expect(out.summary).toBe(skipped);
    expect(out.windowOverlap.siblings).toEqual([2]);
    expect(out.windowOverlap.pending).toBe(true);
  });
});

describe('replayAttributionDegradedRemovals', () => {
  it('filters a rename hunk when either side is unmerged', () => {
    const m = manifestWith([hunk('old-name.ts', 'new-name.ts'), hunk('other.ts', 'other.ts')]);
    const byBefore = replayAttributionDegradedRemovals(m, ['old-name.ts']);
    expect(byBefore.hunks.map((h) => h.file_after)).toEqual(['other.ts']);
    const byAfter = replayAttributionDegradedRemovals(m, ['new-name.ts']);
    expect(byAfter.hunks.map((h) => h.file_after)).toEqual(['other.ts']);
    expect(byBefore.hunk_count).toBe(1);
    expect(byBefore.captured_hunk_count).toBe(1);
  });

  it('returns the same object reference when nothing matches', () => {
    const m = manifestWith([hunk('a.ts', 'a.ts')]);
    expect(replayAttributionDegradedRemovals(m, [])).toBe(m);
    expect(replayAttributionDegradedRemovals(m, ['unrelated.ts'])).toBe(m);
  });

  it('normalizes a filtered-to-nothing manifest to status empty', () => {
    const m = manifestWith([hunk('conflict.txt', 'conflict.txt')]);
    const out = replayAttributionDegradedRemovals(m, ['conflict.txt']);
    expect(out.status).toBe('empty');
    expect(out.hunks).toEqual([]);
    expect(out.hunk_count).toBe(0);
    expect(out.captured_hunk_count).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.error_reason).toBeNull();
  });

  it('composes with replayWindowOverlapRemovals to the same manifest in either order', () => {
    const m = manifestWith([
      hunk('conflict.txt', 'conflict.txt'),
      hunk('dropped.ts', 'dropped.ts'),
      hunk('kept.ts', 'kept.ts'),
    ]);
    const overlap = {
      dropped_files: [
        { file_before: 'dropped.ts', file_after: 'dropped.ts', status: 'unclaimed' as const },
      ],
      rejected_claims: [],
    };
    const unmerged = ['conflict.txt'];
    const a = replayAttributionDegradedRemovals(replayWindowOverlapRemovals(m, overlap), unmerged);
    const b = replayWindowOverlapRemovals(replayAttributionDegradedRemovals(m, unmerged), overlap);
    expect(a).toEqual(b);
    expect(a.hunks.map((h) => h.file_after)).toEqual(['kept.ts']);
  });
});

describe('applyUnmergedExclusion', () => {
  it('passes manifest and summary through by reference when nothing matches', async () => {
    const m = manifestWith([hunk('a.ts', 'a.ts')]);
    const s = summaryFor(m);
    const out = await applyUnmergedExclusion(m, s, ['unrelated.ts']);
    expect(out.manifest).toBe(m);
    expect(out.summary).toBe(s);
  });

  it('recomputes a consistent {manifest, summary} pair when hunks are removed', async () => {
    const m = manifestWith([hunk('conflict.txt', 'conflict.txt'), hunk('kept.ts', 'kept.ts')]);
    const out = await applyUnmergedExclusion(m, summaryFor(m), ['conflict.txt']);
    expect(out.manifest.hunks.map((h) => h.file_after)).toEqual(['kept.ts']);
    expect(out.summary.hunk_count).toBe(1);
    expect(out.summary.captured_hunk_count).toBe(1);
    expect(out.summary.status).toBe('captured');
    expect(out.summary.manifest_hash).not.toBe('pre-partition-hash');
    expect(out.summary.manifest_hash).not.toBeNull();
  });
});

describe('applyClaimsPartition — unmergedPaths interaction', () => {
  it('discloses the exclusion and keeps unmerged paths out of segment_attributed', async () => {
    // conflict.txt changed in an exclusive-1 segment with NO claim — without
    // the exception it would be conclusively segment-attributed.
    const m = manifestWith([
      hunk('conflict.txt', 'conflict.txt'),
      hunk('claimed.ts', 'claimed.ts'),
    ]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['claimed.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed')],
      segments: [seg([1], ['conflict.txt', 'claimed.ts'], [0, 1]), seg([1, 2], [], [1, 2])],
      crossArtifactSiblings: [],
      unmergedPaths: ['conflict.txt'],
    });
    expect(out.windowOverlap.degradations).toContain('unmerged_paths_excluded');
    expect(out.windowOverlap.segment_attributed).toEqual([]);
  });

  it('does not report an unmerged path as unattributed_in_window at last close', async () => {
    // conflict.txt changed in a concurrent segment, claimed by no one —
    // without the exception the last close would flag it unattributed.
    const m = manifestWith([hunk('mine.ts', 'mine.ts')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['mine.ts'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed')],
      segments: [seg([1, 2], ['conflict.txt', 'mine.ts'], [0, 1])],
      crossArtifactSiblings: [],
      unmergedPaths: ['conflict.txt'],
    });
    expect(out.windowOverlap.unattributed_in_window).toEqual([]);
    expect(out.windowOverlap.degradations).toContain('unmerged_paths_excluded');
  });

  it('never misreads an honestly-claimed conflicted path as a rejected claim', async () => {
    // The union filter runs AFTER the partition, so the claimed conflicted
    // path's hunks are still in the manifest here — inManifest holds.
    const m = manifestWith([hunk('conflict.txt', 'conflict.txt')]);
    const out = await applyClaimsPartition({
      currentN: 1,
      ownClaim: ['conflict.txt'],
      manifest: m,
      summary: summaryFor(m),
      siblings: [sib(2, 'closed')],
      segments: [seg([2], ['conflict.txt'], [0, 1]), seg([1, 2], ['conflict.txt'], [1, 2])],
      crossArtifactSiblings: [],
      unmergedPaths: ['conflict.txt'],
    });
    expect(out.windowOverlap.rejected_claims).toEqual([]);
  });
});
