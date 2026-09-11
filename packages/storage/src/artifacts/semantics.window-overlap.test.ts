import { beforeEach, describe, expect, it } from 'vitest';

import { computeDiffFingerprintManifestHash } from '@orcaops/diff-fingerprint';

import type { ArtifactDraftSemantics } from './draft-preparation.js';
import {
  createRetainedArtifactDraft,
  type RetainedArtifactDraft,
} from './retained-draft.test-support.js';
import type { CheckpointCloseCallbacks } from './write-types.js';
import type { PartitionSegment } from '../events/claims-partition.js';
import {
  buildDefaultSkippedSnapshotBoundary,
  type DiffFingerprintManifest,
  type DiffFingerprintSummary,
} from '../schema/diff-fingerprint.js';

const ART = '01999999-9999-7000-8000-00000000012a';
const ART_B = '01999999-9999-7000-8000-00000000012b';
const STEP_1 = '01HX0K8N6ZQF8M5R2V8DZ7T3K1';
const STEP_2 = '01HX0K8N6ZQF8M5R2V8DZ7T3K2';

let hunkSeq = 0;
function fileHunk(fileBefore: string | null, fileAfter: string | null) {
  hunkSeq += 1;
  return {
    hunk_index: hunkSeq,
    file_before: fileBefore,
    file_after: fileAfter,
    change_type: 'modify' as const,
    binary: false,
    old_start: 1,
    old_lines: 1,
    new_start: 1,
    new_lines: 1,
    patch_hash: `ph-${hunkSeq}`,
    added_line_hashes: [`lh-${hunkSeq}`],
    deleted_line_hashes: [],
    hunk_header_hash: null,
    added_line_count: 1,
    deleted_line_count: 0,
  };
}

function manifestOf(artifactId: string, n: number, files: string[]): DiffFingerprintManifest {
  const hunks = files.map((f) => fileHunk(f, f));
  return {
    schema_version: 1,
    artifact_id: artifactId,
    checkpoint_n: n,
    open_tree_sha: 'o'.repeat(40),
    close_tree_sha: 'c'.repeat(40),
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
  };
}

function summaryOf(manifest: DiffFingerprintManifest): DiffFingerprintSummary {
  return {
    status: manifest.status,
    hunk_count: manifest.hunk_count,
    captured_hunk_count: manifest.captured_hunk_count,
    truncated: manifest.truncated,
    fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2',
    manifest_hash: `unfiltered-${manifest.checkpoint_n}`,
    manifest_hash_algorithm: manifest.manifest_hash_algorithm,
    error_reason: null,
  };
}

const seg = (
  activeNs: number[],
  changedFiles: string[] | null,
  idx: [number, number]
): PartitionSegment => ({
  fromEventIdx: idx[0],
  toEventIdx: idx[1],
  activeNs,
  kind: activeNs.length === 1 ? 'exclusive' : 'concurrent',
  changedFiles,
  degradedReason: changedFiles === null ? 'missing_boundary_tree' : null,
});

describe('artifact semantics window-overlap close path', () => {
  let draft: RetainedArtifactDraft;
  let semantics: ArtifactDraftSemantics;

  beforeEach(() => {
    draft = createRetainedArtifactDraft(ART);
    semantics = draft.semantics;
  });

  async function writePlan(
    artifactId = ART,
    key = `plan-${artifactId}`,
    imported = false
  ): Promise<void> {
    await semantics.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'feat/x',
        base_sha: 'abc123',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'overlap fixture',
        label: `overlap-${artifactId.slice(-2)}`,
        plan_steps: [
          { step_id: STEP_1, text: 'step 1', label: 's1', acceptance_criteria: [] },
          { step_id: STEP_2, text: 'step 2', label: 's2', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-04-26T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
        ...(imported
          ? {
              origin: {
                kind: 'git-import' as const,
                imported_at: '2026-04-26T13:00:00.000Z',
                tool_version: '0.0.5',
                source_range: 'main~1..main',
                authors: ['dev@example.com'],
                enriched_at: null,
              },
            }
          : {}),
      },
      { idempotencyKey: key }
    );
  }

  async function openCp(
    artifactId: string,
    stepId: string,
    key: string,
    openedAt?: string
  ): Promise<void> {
    await semantics.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [stepId] },
      { idempotencyKey: key, headSha: 'cafef00d', ...(openedAt ? { openedAt } : {}) }
    );
  }

  interface CloseSpec {
    n: number;
    filesChanged: string[];
    manifest: DiffFingerprintManifest | null;
    segments?: PartitionSegment[];
    key: string;
    closedAt?: string;
    skipWallClockOverlapScan?: boolean;
    crossArtifactSiblings?: Array<{ artifact_id: string; n: number }>;
  }

  async function closeCp(spec: CloseSpec) {
    let receivedOverlap: unknown;
    const callbacks: CheckpointCloseCallbacks = {
      captureCloseFingerprint: async (ctx) => {
        receivedOverlap = ctx.overlap;
        return {
          boundary: {
            ...buildDefaultSkippedSnapshotBoundary(),
            snapshot_ref: `refs/orcaops/snap/x/${spec.n}/close`,
            tree_sha: 'c'.repeat(40),
            snapshot_commit_sha: 'd'.repeat(40),
          },
          summary: spec.manifest
            ? summaryOf(spec.manifest)
            : summaryOf(manifestOf(ART, spec.n, [])),
          manifest: spec.manifest,
          ...(spec.segments !== undefined ? { segment_evidence: spec.segments } : {}),
        };
      },
    };
    const result = await semantics.writeCheckpointClosed(
      {
        artifact_id: ART,
        n: spec.n,
        summary: `cp${spec.n}`,
        files_changed: spec.filesChanged,
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [spec.n === 1 ? STEP_1 : STEP_2],
        head_sha: 'cafef00d',
      },
      {
        idempotencyKey: spec.key,
        snapshotCallbacks: callbacks,
        ...(spec.closedAt ? { closedAt: spec.closedAt } : {}),
        ...(spec.skipWallClockOverlapScan ? { skipWallClockOverlapScan: true } : {}),
        ...(spec.crossArtifactSiblings
          ? { crossArtifactSiblings: spec.crossArtifactSiblings }
          : {}),
      }
    );
    if (result.outcome !== 'created') throw new Error(`close outcome: ${result.outcome}`);
    return { checkpoint: result.checkpoint, receivedOverlap };
  }

  it('omits window_overlap from a serial close event and retained checkpoint', async () => {
    await writePlan();
    await openCp(ART, STEP_1, 'o1');
    const m = manifestOf(ART, 1, ['a.ts']);
    const { checkpoint, receivedOverlap } = await closeCp({
      n: 1,
      filesChanged: ['a.ts'],
      manifest: m,
      key: 'c1',
    });

    expect(receivedOverlap).toBeUndefined();
    expect('window_overlap' in checkpoint).toBe(false);
    expect(checkpoint.diff_fingerprint_summary.manifest_hash).toBe('unfiltered-1');
    const closeLine = draft.events.find((event) => event.record.type === 'checkpoint_closed');
    expect(closeLine).toBeDefined();
    expect(Object.keys((closeLine!.payload as Record<string, unknown>) ?? {})).not.toContain(
      'window_overlap'
    );
  });

  it('disjoint parallel work → clean manifests without reliance on self-report (close order 1→2)', async () => {
    await writePlan();
    await openCp(ART, STEP_1, 'o1');
    await openCp(ART, STEP_2, 'o2');

    // cp1 fence: a.ts (exclusive-1) + b.ts (concurrent, agent2's work).
    const { checkpoint: cp1, receivedOverlap } = await closeCp({
      n: 1,
      filesChanged: ['a.ts'],
      manifest: manifestOf(ART, 1, ['a.ts', 'b.ts']),
      segments: [seg([1], ['a.ts'], [1, 2]), seg([1, 2], ['b.ts'], [2, 3])],
      key: 'c1',
    });
    expect(receivedOverlap).toMatchObject({ currentCloseIdx: 3 });
    expect(cp1.window_overlap).toBeDefined();
    expect(cp1.window_overlap?.pending).toBe(true); // sibling 2 still open
    // b.ts removed — not mine, potential owner still open.
    expect(cp1.window_overlap?.dropped_files).toEqual([
      { file_before: 'b.ts', file_after: 'b.ts', status: 'sibling_pending' },
    ]);
    expect(cp1.diff_fingerprint_summary.hunk_count).toBe(1);

    // cp2 fence: b.ts (concurrent) + c.ts (exclusive-2, UNREPORTED).
    const { checkpoint: cp2 } = await closeCp({
      n: 2,
      filesChanged: ['b.ts'],
      manifest: manifestOf(ART, 2, ['b.ts', 'c.ts']),
      segments: [seg([1, 2], ['b.ts'], [2, 3]), seg([2], ['c.ts'], [3, 4])],
      key: 'c2',
    });
    expect(cp2.window_overlap?.pending).toBe(false);
    // b.ts: mine-claimed, sibling closed without claiming it → clean keep.
    // c.ts: exclusive-segment evidence despite missing self-report → kept.
    expect(cp2.window_overlap?.dropped_files).toEqual([]);
    expect(cp2.window_overlap?.segment_attributed).toEqual(['c.ts']);
    expect(cp2.window_overlap?.ambiguous_files).toEqual([]);
    expect(cp2.diff_fingerprint_summary.hunk_count).toBe(2);
    expect(cp2.window_overlap?.unattributed_in_window).toEqual([]);
  });

  it('disjoint parallel work stays clean in the REVERSE close order (2→1)', async () => {
    await writePlan();
    await openCp(ART, STEP_1, 'o1');
    await openCp(ART, STEP_2, 'o2');

    // cp2 closes FIRST: b.ts concurrent + own-claimed, sibling 1 open.
    const { checkpoint: cp2 } = await closeCp({
      n: 2,
      filesChanged: ['b.ts'],
      manifest: manifestOf(ART, 2, ['b.ts']),
      segments: [seg([1, 2], ['b.ts'], [2, 3])],
      key: 'c2',
    });
    expect(cp2.window_overlap?.own_claim_pending).toEqual([
      { file_before: 'b.ts', file_after: 'b.ts' },
    ]);
    expect(cp2.window_overlap?.dropped_files).toEqual([]);

    // cp1 closes LAST: a.ts exclusive-1; b.ts concurrent, sibling-claimed.
    const { checkpoint: cp1 } = await closeCp({
      n: 1,
      filesChanged: ['a.ts'],
      manifest: manifestOf(ART, 1, ['a.ts', 'b.ts']),
      segments: [seg([1], ['a.ts'], [1, 2]), seg([1, 2], ['b.ts'], [2, 3])],
      key: 'c1',
    });
    expect(cp1.window_overlap?.dropped_files).toEqual([
      { file_before: 'b.ts', file_after: 'b.ts', status: 'sibling-claimed' },
    ]);
    expect(cp1.window_overlap?.pending).toBe(false);
    expect(cp1.diff_fingerprint_summary.hunk_count).toBe(1);
    expect(cp1.window_overlap?.unattributed_in_window).toEqual([]);
  });

  it('overlapping same-file edits in a concurrent segment → ambiguity flagged, kept in both', async () => {
    await writePlan();
    await openCp(ART, STEP_1, 'o1');
    await openCp(ART, STEP_2, 'o2');

    const { checkpoint: cp1 } = await closeCp({
      n: 1,
      filesChanged: ['shared.ts'],
      manifest: manifestOf(ART, 1, ['shared.ts']),
      segments: [seg([1, 2], ['shared.ts'], [1, 3])],
      key: 'c1',
    });
    // First closer cannot see the sibling's claim yet — own claim pending.
    expect(cp1.window_overlap?.own_claim_pending).toEqual([
      { file_before: 'shared.ts', file_after: 'shared.ts' },
    ]);

    const { checkpoint: cp2 } = await closeCp({
      n: 2,
      filesChanged: ['shared.ts'],
      manifest: manifestOf(ART, 2, ['shared.ts']),
      segments: [seg([1, 2], ['shared.ts'], [1, 3])],
      key: 'c2',
    });
    // Later closer sees both claims: ambiguity recorded on THIS close,
    // kept in both manifests (cp1's event is append-only, untouched).
    expect(cp2.window_overlap?.ambiguous_files).toEqual([
      { file_before: 'shared.ts', file_after: 'shared.ts' },
    ]);
    expect(cp2.diff_fingerprint_summary.hunk_count).toBe(1);
    expect(cp1.diff_fingerprint_summary.hunk_count).toBe(1);
  });

  it('unclaimed in-window file → dropped and finalized unattributed at the LAST close', async () => {
    await writePlan();
    await openCp(ART, STEP_1, 'o1');
    await openCp(ART, STEP_2, 'o2');

    const { checkpoint: cp1 } = await closeCp({
      n: 1,
      filesChanged: ['a.ts'],
      manifest: manifestOf(ART, 1, ['a.ts', 'drive-by.ts']),
      segments: [seg([1], ['a.ts'], [1, 2]), seg([1, 2], ['drive-by.ts'], [2, 3])],
      key: 'c1',
    });
    // Sibling still open — could still claim it.
    expect(cp1.window_overlap?.dropped_files).toEqual([
      { file_before: 'drive-by.ts', file_after: 'drive-by.ts', status: 'sibling_pending' },
    ]);
    expect(cp1.window_overlap?.unattributed_in_window).toEqual([]);

    const { checkpoint: cp2 } = await closeCp({
      n: 2,
      filesChanged: ['b.ts'],
      manifest: manifestOf(ART, 2, ['b.ts', 'drive-by.ts']),
      segments: [seg([1, 2], ['drive-by.ts', 'b.ts'], [2, 3])],
      key: 'c2',
    });
    // Last close: nobody claimed drive-by.ts, it changed concurrently —
    // dropped as unclaimed AND finalized in the loud warning set.
    expect(cp2.window_overlap?.dropped_files).toEqual([
      { file_before: 'drive-by.ts', file_after: 'drive-by.ts', status: 'unclaimed' },
    ]);
    expect(cp2.window_overlap?.unattributed_in_window).toEqual(['drive-by.ts']);
  });

  it('retains a summary recomputed from the filtered manifest', async () => {
    await writePlan();
    await openCp(ART, STEP_1, 'o1');
    await openCp(ART, STEP_2, 'o2');

    const { checkpoint: cp1 } = await closeCp({
      n: 1,
      filesChanged: ['a.ts'],
      manifest: manifestOf(ART, 1, ['a.ts', 'b.ts']),
      segments: [seg([1, 2], ['a.ts', 'b.ts'], [1, 3])],
      key: 'c1',
    });

    // b.ts dropped (sibling_pending) → persisted manifest has 1 hunk and
    // the summary hash matches a recompute over the persisted manifest.
    const persisted = await semantics.readCheckpointDiffFingerprint(ART, 1);
    expect(persisted?.hunks.map((h) => h.file_after)).toEqual(['a.ts']);
    expect(persisted?.hunk_count).toBe(1);
    expect(cp1.diff_fingerprint_summary.hunk_count).toBe(1);
    expect(cp1.diff_fingerprint_summary.manifest_hash).toBe(
      await computeDiffFingerprintManifestHash(persisted!)
    );
  });

  it('records supplied cross-artifact overlap as pending claims-only evidence', async () => {
    await writePlan();
    await openCp(ART, STEP_1, 'oa1');

    const { checkpoint } = await closeCp({
      n: 1,
      filesChanged: ['mine.ts'],
      manifest: manifestOf(ART, 1, ['mine.ts', 'foreign.ts']),
      segments: [seg([1], ['mine.ts', 'foreign.ts'], [1, 2])],
      key: 'ca1',
      crossArtifactSiblings: [{ artifact_id: ART_B, n: 1 }],
    });
    expect(checkpoint.window_overlap).toBeDefined();
    expect(checkpoint.window_overlap?.cross_artifact_siblings).toEqual([
      { artifact_id: ART_B, n: 1 },
    ]);
    expect(checkpoint.window_overlap?.pending).toBe(true);
    expect(checkpoint.window_overlap?.degradations).toContain('cross_artifact_claims_only');
    expect(checkpoint.window_overlap?.own_claim_pending).toEqual([
      { file_before: 'mine.ts', file_after: 'mine.ts' },
    ]);
    expect(checkpoint.window_overlap?.dropped_files).toEqual([
      { file_before: 'foreign.ts', file_after: 'foreign.ts', status: 'sibling_pending' },
    ]);
  });

  it('skips cross-artifact overlap scanning for imported checkpoints', async () => {
    const ts = '2020-01-02T03:04:05.000Z';
    await writePlan(ART, 'plan-imported', true);
    await openCp(ART, STEP_1, 'open-imported', ts);

    const { checkpoint: imported } = await closeCp({
      n: 1,
      filesChanged: ['historic.ts'],
      manifest: manifestOf(ART, 1, ['historic.ts']),
      key: 'close-imported',
      closedAt: ts,
      skipWallClockOverlapScan: true,
    });
    expect('window_overlap' in imported).toBe(false);
  });

  it('records claims-only degradation when the callback returns no segment evidence', async () => {
    await writePlan();
    await openCp(ART, STEP_1, 'o1');
    await openCp(ART, STEP_2, 'o2');

    const { checkpoint: cp1 } = await closeCp({
      n: 1,
      filesChanged: ['a.ts'],
      manifest: manifestOf(ART, 1, ['a.ts']),
      // No segments supplied at all.
      key: 'c1',
    });
    expect(cp1.window_overlap?.degradations).toContain('segment_evidence_unavailable');
    // Claims still arbitrate: own claim + open sibling → kept pending.
    expect(cp1.window_overlap?.own_claim_pending).toEqual([
      { file_before: 'a.ts', file_after: 'a.ts' },
    ]);
  });
});
