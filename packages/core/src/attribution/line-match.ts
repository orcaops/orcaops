import type { ManifestSource } from './matcher.js';
import { lineHash, normalizeLineBody } from '../diff-fingerprint/adapter.js';

/**
 * Line-membership check: is this exact source line's content among a
 * checkpoint manifest's `added_line_hashes`? Powers the `resolveWhy`
 * line-hash confidence tier and the agent-trace exporter's per-line
 * ranges.
 *
 * Uses the capture-time recipe verbatim — `normalizeLineBody` + the v2
 * content-only `lineHash` (the `kind` argument is ignored by v2; the
 * add/delete split is carried by array membership, so membership in
 * `added_line_hashes` IS the "this checkpoint added this content"
 * signal.
 *
 * Trivial-line guard: a normalized body shorter than
 * `TRIVIAL_LINE_MIN_BYTES` (`}`, `});`, blank) collides across the
 * entire codebase by construction, so membership means nothing.
 * Guarded lines return `trivial: true` with no matches — consumers must
 * not fall back to treating that as "unattributed".
 */

export const TRIVIAL_LINE_MIN_BYTES = 4;

export interface LineMatchResult {
  /** Line content too short for membership to be meaningful. */
  trivial: boolean;
  /**
   * Sources whose manifest added this exact line content, newest first.
   * `manifest_files` carries WHICH files' hunks contained the hash —
   * the hunk-level matcher already discloses
   * `manifest_file`; this threads the same to line granularity so
   * consumers can distinguish same-file authorship from identical
   * content added under a different path.
   */
  matches: Array<{ artifact_id: string; checkpoint_n: number; manifest_files: string[] }>;
}

export async function lineContentMatch(
  sources: ManifestSource[],
  lineText: string
): Promise<LineMatchResult> {
  const normalized = normalizeLineBody(new TextEncoder().encode(lineText));
  if (normalized.length < TRIVIAL_LINE_MIN_BYTES) {
    return { trivial: true, matches: [] };
  }
  // v2 lineHash ignores `kind`; pass the raw line bytes — the recipe
  // normalizes internally via the same helper, so hand it the ORIGINAL
  // bytes, not the pre-normalized ones.
  const hash = await lineHash('add', new TextEncoder().encode(lineText));

  const matches = sources
    .map((s) => {
      const files = new Set<string>();
      for (const h of s.manifest.hunks) {
        if (!h.added_line_hashes.includes(hash)) continue;
        const file = h.file_after ?? h.file_before;
        if (file !== null) files.add(file);
      }
      return { source: s, files };
    })
    .filter((m) => m.files.size > 0)
    .sort((a, b) => b.source.ts.localeCompare(a.source.ts))
    .map((m) => ({
      artifact_id: m.source.artifact_id,
      checkpoint_n: m.source.checkpoint_n,
      manifest_files: [...m.files].sort(),
    }));

  return { trivial: false, matches };
}
