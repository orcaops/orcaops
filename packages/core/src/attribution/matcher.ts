import type { DiffFingerprintHunk, DiffFingerprintManifest } from '../diff-fingerprint/adapter.js';
import { fingerprintUnifiedDiff } from '../diff-fingerprint/adapter.js';

/**
 * Local attribution matcher.
 *
 * EXACT matching only — a live diff hunk is attributed to a checkpoint
 * iff its `patch_hash` (content-only: no paths, no line numbers in the
 * hash input) equals a manifest hunk's. There is deliberately NO fuzzy
 * or rebase-tracking matching here: that is the cloud matcher's
 * territory. Everything this module cannot attribute
 * exactly is reported as unattributed or ambiguous — never guessed.
 *
 * Known-weak exclusion (mandated by the protocol schema docblock): any
 * hunk with `added_line_count + deleted_line_count === 0` collapses to a
 * per-`change_type` constant `patch_hash` — binary hunks, mode changes,
 * pure renames, pure copies. One pure rename would otherwise "match"
 * every pure rename ever captured, so known-weak hunks are excluded from
 * matching on BOTH sides and counted separately in coverage.
 */

/** One manifest offered to the matcher, with provenance + recency. */
export interface ManifestSource {
  artifact_id: string;
  checkpoint_n: number;
  /** ISO timestamp of the checkpoint (close time) — recency ordering. */
  ts: string;
  manifest: DiffFingerprintManifest;
}

export interface HunkMatch {
  artifact_id: string;
  checkpoint_n: number;
  /**
   * `exact`: patch_hash AND file path equal. `content`: patch_hash equal
   * but the path differs — the same content moved/renamed across files.
   */
  match: 'exact' | 'content';
  /** Manifest-side path, for content-class disclosure. */
  manifest_file: string | null;
}

export interface AttributedHunk {
  /** Live-side hunk metadata (paths/ranges from the live diff — safe to show). */
  hunk_index: number;
  file: string | null;
  change_type: DiffFingerprintHunk['change_type'];
  new_start: number | null;
  new_lines: number | null;
  old_start: number | null;
  old_lines: number | null;
  changed_line_count: number;
  patch_hash: string;
  /** Excluded from matching (zero changed lines — constant patch_hash). */
  known_weak: boolean;
  /** Recency-ordered (`exact` class first, then `content`; newest first). */
  matches: HunkMatch[];
  /**
   * Matches exist but cannot be trusted as attribution: they span more
   * than one artifact, or the hunk is tiny (≤2 changed lines) and only
   * matched cross-file (`content` class) — trivial content like a lone
   * `}` collides across files by construction.
   */
  ambiguous: boolean;
}

export interface AttributionCoverage {
  total_hunks: number;
  /** Unambiguously matched (the only bucket a percentage may count). */
  attributed_hunks: number;
  ambiguous_hunks: number;
  unattributed_hunks: number;
  /** Excluded from matching entirely (and from the pct denominator). */
  known_weak_hunks: number;
  /** attributed / (total − known_weak); null when the denominator is 0. */
  attributed_pct: number | null;
}

export interface MatchDiffResult {
  hunks: AttributedHunk[];
  coverage: AttributionCoverage;
  /**
   * Sources whose manifest has `status: 'truncated'` — a PARTIAL hunk
   * set. Unattributed live hunks near these checkpoints may simply have
   * fallen past the capture-time byte cap; consumers must disclose.
   */
  truncated_manifest_checkpoints: Array<{ artifact_id: string; checkpoint_n: number }>;
}

/** The protocol-mandated known-weak predicate. */
export function isKnownWeakHunk(h: {
  added_line_count: number;
  deleted_line_count: number;
}): boolean {
  return h.added_line_count + h.deleted_line_count === 0;
}

/** Live/manifest path identity: file_after wins; deletions fall back to file_before. */
function hunkPath(h: DiffFingerprintHunk): string | null {
  return h.file_after ?? h.file_before;
}

/**
 * Fingerprint a live diff with the exact capture pipeline, then match
 * every live hunk against the offered manifest set.
 *
 * Throws only what `fingerprintUnifiedDiff` throws (parser failure on
 * unparseable diff bytes) — callers own the fail-open conversion, the
 * same split the vendored package documents.
 */
export async function matchDiffAgainstManifests(opts: {
  diffBytes: Uint8Array;
  /** Whether the live diff was byte-cap truncated (forwarded to the parser). */
  truncated: boolean;
  maxDiffBytes: number;
  sources: ManifestSource[];
}): Promise<MatchDiffResult> {
  const liveHunks = await fingerprintUnifiedDiff({
    diffBytes: opts.diffBytes,
    truncated: opts.truncated,
    maxDiffBytes: opts.maxDiffBytes,
  });

  // Index manifest hunks by patch_hash, excluding known-weak entries.
  const byPatchHash = new Map<
    string,
    Array<{ source: ManifestSource; hunk: DiffFingerprintHunk }>
  >();
  for (const source of opts.sources) {
    for (const hunk of source.manifest.hunks) {
      if (isKnownWeakHunk(hunk)) continue;
      const list = byPatchHash.get(hunk.patch_hash) ?? [];
      list.push({ source, hunk });
      byPatchHash.set(hunk.patch_hash, list);
    }
  }

  const hunks: AttributedHunk[] = [];
  for (const live of liveHunks) {
    const knownWeak = isKnownWeakHunk(live);
    const changedLineCount = live.added_line_count + live.deleted_line_count;
    let matches: HunkMatch[] = [];
    if (!knownWeak) {
      const livePath = hunkPath(live);
      const candidates = byPatchHash.get(live.patch_hash) ?? [];
      matches = candidates
        .map(({ source, hunk }) => ({
          artifact_id: source.artifact_id,
          checkpoint_n: source.checkpoint_n,
          match: (hunkPath(hunk) === livePath ? 'exact' : 'content') as 'exact' | 'content',
          manifest_file: hunkPath(hunk),
          ts: source.ts,
        }))
        .sort((a, b) => {
          if (a.match !== b.match) return a.match === 'exact' ? -1 : 1;
          return b.ts.localeCompare(a.ts);
        })
        .map(({ ts: _ts, ...rest }) => rest);
    }

    const artifactIds = new Set(matches.map((m) => m.artifact_id));
    const contentOnly = matches.length > 0 && matches.every((m) => m.match === 'content');
    const ambiguous =
      matches.length > 0 && (artifactIds.size > 1 || (contentOnly && changedLineCount <= 2));

    hunks.push({
      hunk_index: live.hunk_index,
      file: hunkPath(live),
      change_type: live.change_type,
      new_start: live.new_start,
      new_lines: live.new_lines,
      old_start: live.old_start,
      old_lines: live.old_lines,
      changed_line_count: changedLineCount,
      patch_hash: live.patch_hash,
      known_weak: knownWeak,
      matches,
      ambiguous,
    });
  }

  const knownWeakCount = hunks.filter((h) => h.known_weak).length;
  const attributed = hunks.filter((h) => !h.known_weak && h.matches.length > 0 && !h.ambiguous);
  const ambiguousCount = hunks.filter((h) => h.ambiguous).length;
  const unattributed = hunks.filter((h) => !h.known_weak && h.matches.length === 0);
  const denominator = hunks.length - knownWeakCount;

  const truncatedSet = new Map<string, { artifact_id: string; checkpoint_n: number }>();
  for (const source of opts.sources) {
    if (source.manifest.status === 'truncated') {
      truncatedSet.set(`${source.artifact_id}:${source.checkpoint_n}`, {
        artifact_id: source.artifact_id,
        checkpoint_n: source.checkpoint_n,
      });
    }
  }

  return {
    hunks,
    coverage: {
      total_hunks: hunks.length,
      attributed_hunks: attributed.length,
      ambiguous_hunks: ambiguousCount,
      unattributed_hunks: unattributed.length,
      known_weak_hunks: knownWeakCount,
      attributed_pct:
        denominator === 0 ? null : Math.round((attributed.length / denominator) * 1000) / 10,
    },
    truncated_manifest_checkpoints: [...truncatedSet.values()],
  };
}
