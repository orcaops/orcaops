// FOUR-PARSER PARITY over a truncated review diff — the proof behind the normalizer.
//
// The stored `diff.patch` is read by four independent parsers, and before
// normalization they disagreed about what a truncated one meant:
//
//   1. parseUnifiedDiff   (@orcaops/diff-fingerprint) — builds the floor's coverage.
//                          Drops an unterminated final line; drops a trailing hunk
//                          whose @@ counts went unfilled.
//   2. parseChangedRows   (@orcaops/review-core) — the changed-row substrate.
//                          Tolerant. `attribute()` cross-checks it against (1) and
//                          FAILS A HUNK CLOSED to UNREVIEWABLE when they disagree.
//   3. parsePatchFiles    (@pierre/diffs, via diffFileFromPatch) — what the TUI
//                          renders. THROWS on a hunk count mismatch, from inside its
//                          per-hunk loop, which aborts the WHOLE FILE.
//   4. splitPatchByFile   (this app) — the splitter feeding (3).
//
// This test lives here because `apps/orcaops-watch` is the only package that can see
// all of them: it depends on review-engine (the normalizer), review-core (the
// substrate), diff-render (Pierre), and owns the splitter.
//
// The corpus is the vendored fixture set — 16 real git diffs covering renames, CRLF,
// binary, deletions, additions, no-newline-at-EOF, non-BMP paths, a 64KB line — plus
// a mode-only case the corpus lacks. Each is truncated at EVERY byte offset (a real
// cap lands wherever it lands), normalized, and then all four parsers are held to the
// same account.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { fingerprintUnifiedDiff, parseUnifiedDiff } from '@orcaops/diff-fingerprint';
import { fixtureCases } from '@orcaops/diff-fingerprint/fixtures';
import { diffFileFromPatch } from '@orcaops/diff-render';
import { indexParsedHunks, parseChangedRows } from '@orcaops/review-core';
import { normalizeTruncatedReviewDiff } from '@orcaops/review-engine';

import { splitPatchByFile } from './patchSplit.js';

const LF = 0x0a;
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * The fingerprint emits a synthetic zero-line entry for a BINARY file; Pierre emits
 * none. That divergence exists on COMPLETE diffs too and is not truncation's fault —
 * `coverage.ts` already maps exactly these to UNREVIEWABLE and the TUI renders them
 * as a `⊘ binary` note, never as hunks. So parity is asserted over the REVIEWABLE
 * hunks. (Omitting this filter makes the test fail on a correct normalizer — it cost
 * a debugging round to learn, hence the comment.)
 */
interface FpHunk {
  binary: boolean;
  added_line_count: number;
  deleted_line_count: number;
  old_start: number | null;
  new_start: number | null;
  change_type: string;
  patch_hash: string;
  file_before: string | null;
  file_after: string | null;
}
const isReviewable = (h: FpHunk): boolean =>
  !h.binary && h.added_line_count + h.deleted_line_count > 0;

/**
 * Ordered signature, NOT a coordinate set. A set comparison silently tolerates
 * duplicates and count drift; comparing ordered signatures that carry the counts, the
 * change type, and the content hash does not.
 */
const fpSignature = (h: FpHunk): string =>
  `${h.file_after ?? h.file_before}@${h.old_start},${h.new_start}` +
  `+${h.added_line_count}-${h.deleted_line_count}:${h.change_type}:${h.patch_hash}`;

const fingerprintHunks = async (bytes: Uint8Array): Promise<FpHunk[]> =>
  (await fingerprintUnifiedDiff({
    diffBytes: bytes,
    truncated: true,
    maxDiffBytes: 1_000_000_000,
  })) as unknown as FpHunk[];

/**
 * What the TUI would actually render: every file through the splitter, then Pierre.
 *
 * Dedupe on the CHUNK, not the map key. `splitPatchByFile` deliberately keys a rename
 * under BOTH paths (old and new) so a lookup by either resolves, and the app's
 * `buildPatchIndex` reads it by name and caches — it never iterates. Walking the
 * entries here without deduping parses the same rename chunk twice and invents a
 * phantom duplicate hunk. (Found by this test, at 04-rename-with-content-change@159.)
 */
function pierreHunkCoords(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [file, patch] of splitPatchByFile(dec(bytes))) {
    if (seen.has(patch)) continue;
    seen.add(patch);
    const diff = diffFileFromPatch(patch, { sourceId: `parity:${file}` });
    for (const h of diff.metadata.hunks) {
      out.push(`${diff.path}@${h.deletionStart},${h.additionStart}`);
    }
  }
  return out;
}

const fpCoords = (hunks: FpHunk[]): string[] =>
  hunks
    .filter(isReviewable)
    .map((h) => `${h.file_after ?? h.file_before}@${h.old_start},${h.new_start}`);

/** The corpus lacks a mode-only change; author it so the matrix is complete. */
const MODE_ONLY = new TextEncoder().encode(
  'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n' +
    'diff --git a/x.ts b/x.ts\nindex 111..222 100644\n--- a/x.ts\n+++ b/x.ts\n' +
    '@@ -1,2 +1,2 @@\n keep\n-drop\n+add\n'
);

async function corpus(): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const out = await Promise.all(
    fixtureCases.map(async (f) => ({
      name: f.name,
      bytes: new Uint8Array(await readFile(f.inputPath)),
    }))
  );
  return [...out, { name: '17-mode-only', bytes: MODE_ONLY }];
}

/**
 * Every byte offset for a fixture under 8KB; for the larger ones (the 64KB-line case),
 * every line boundary and its immediate neighbours — the offsets where a cap actually
 * has a chance of doing something interesting. Sampling is stated, never silent.
 */
function offsetsFor(bytes: Uint8Array): number[] {
  if (bytes.length <= 8192) return Array.from({ length: bytes.length + 1 }, (_, k) => k);
  const set = new Set<number>([0, bytes.length]);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === LF)
      for (const d of [-1, 0, 1, 2]) {
        const k = i + d;
        if (k >= 0 && k <= bytes.length) set.add(k);
      }
  }
  return [...set].sort((a, b) => a - b);
}

describe('truncation parity — all four parsers agree on the normalized prefix', () => {
  it('holds at every truncation offset of every fixture', async () => {
    const fixtures = await corpus();
    expect(fixtures.length).toBe(17);

    let checked = 0;
    for (const { name, bytes } of fixtures) {
      let prevLen = -1;

      for (const k of offsetsFor(bytes)) {
        const raw = bytes.subarray(0, k);
        const { bytes: norm, discardedBytes } = normalizeTruncatedReviewDiff(raw);
        const where = `${name}@${k}`;
        checked++;

        // ── the output is a byte-for-byte PREFIX, never a rewrite ──────────────
        expect(norm.length, `${where}: longer than its input`).toBeLessThanOrEqual(raw.length);
        expect(discardedBytes, `${where}: discardedBytes`).toBe(raw.length - norm.length);
        for (let i = 0; i < norm.length; i++) {
          if (norm[i] !== raw[i]) throw new Error(`${where}: byte ${i} was rewritten`);
        }

        // ── empty, or LF-terminated. Never a dangling fragment ────────────────
        if (norm.length > 0) {
          expect(norm[norm.length - 1], `${where}: not LF-terminated`).toBe(LF);
        }

        // ── monotonic: a bigger cap never retains LESS ────────────────────────
        expect(norm.length, `${where}: non-monotonic`).toBeGreaterThanOrEqual(prevLen);
        prevLen = norm.length;

        const fp = await fingerprintHunks(norm);

        // ── (3) Pierre must NEVER throw. This is the whole point: one throw and
        //    the TUI drops an ENTIRE FILE, hunks the floor counted included ────
        let pierre: string[];
        try {
          pierre = pierreHunkCoords(norm);
        } catch (e) {
          throw new Error(`${where}: Pierre threw on a NORMALIZED prefix — ${String(e)}`);
        }

        // ── (1) vs (3): the floor and the TUI enumerate the same hunks ────────
        expect([...pierre].sort(), `${where}: fingerprint vs Pierre`).toEqual(
          [...fpCoords(fp)].sort()
        );

        // ── (1) vs (2): the cross-check `attribute()` actually runs. A null from
        //    take() fails that hunk CLOSED to UNREVIEWABLE, so a normalizer that
        //    satisfied Pierre while quietly poisoning attribution would slip through.
        //
        //    Mirror coverage.ts exactly: it short-circuits `binary || added+deleted
        //    === 0` to UNREVIEWABLE BEFORE reaching take(), so zero-line entries (a
        //    mode change, a pure rename) are never cross-checked in production and
        //    must not be here either — parseChangedRows emits nothing for a section
        //    with no `@@`, so asserting on them would fail a test the engine passes.
        const rows = indexParsedHunks(parseChangedRows(norm));
        for (const h of fp.filter(isReviewable)) {
          expect(
            rows.take(h as never),
            `${where}: parseChangedRows cross-check failed closed on ${fpSignature(h)}`
          ).not.toBeNull();
        }

        // ── FLOOR-NEUTRALITY: normalization may only remove bytes the floor was
        //    ALREADY ignoring. Signatures carry patch_hash, so equality here also
        //    proves the retained hunks are byte-identical — hence their hunkKeys are
        //    unchanged, hence normalization moves no coverage and stales no narrative.
        //
        //    Stated over REVIEWABLE hunks, and that scope is load-bearing. The
        //    fingerprint also emits synthetic zero-line entries for metadata-only
        //    sections (a binary file, a pure rename). One of those sitting at the
        //    unproven trailing edge IS dropped, deliberately: at EOF we cannot know
        //    whether git was about to emit content for that rename, and keeping it
        //    would present a rename-with-content as a pure rename. It carries no rows
        //    and is UNREVIEWABLE in coverage either way, so nothing a reviewer can act
        //    on is lost.
        const rawFp = await fingerprintHunks(raw);
        expect(
          fp.filter(isReviewable).map(fpSignature),
          `${where}: normalization CHANGED the floor's reviewable hunks`
        ).toEqual(rawFp.filter(isReviewable).map(fpSignature));

        // …and nothing is ever INVENTED or reordered: what survives is a prefix of
        // what the raw bytes yielded, metadata-only entries included.
        const rawSigs = rawFp.map(fpSignature);
        expect(fp.map(fpSignature), `${where}: hunks invented or reordered`).toEqual(
          rawSigs.slice(0, fp.length)
        );
      }
    }

    // Guard the guard: if the corpus ever stops being exercised, say so loudly rather
    // than passing vacuously.
    expect(checked, 'the corpus stopped being exercised').toBeGreaterThan(2_000);
  }, 240_000);
});

describe('truncation parity — raw prefixes really do break the parser', () => {
  it('RAW truncated prefixes really do make Pierre throw (so the fix is not a no-op)', async () => {
    // A test that cannot fail proves nothing. This one pins the disease: without
    // normalization, arbitrary byte prefixes routinely explode Pierre — and each
    // explosion is a whole file missing from the review.
    const fixtures = await corpus();
    let rawThrows = 0;
    let sampled = 0;

    for (const { bytes } of fixtures) {
      for (const k of offsetsFor(bytes)) {
        sampled++;
        try {
          pierreHunkCoords(bytes.subarray(0, k));
        } catch {
          rawThrows++;
        }
      }
    }
    expect(sampled).toBeGreaterThan(2_000);
    expect(
      rawThrows,
      'raw prefixes never threw — the normalizer would be pointless'
    ).toBeGreaterThan(0);
  }, 240_000);
});

describe('truncation parity — the vendored parser really does drop things', () => {
  it('parseUnifiedDiff keeps an incomplete trailing hunk that fingerprintUnifiedDiff drops', async () => {
    // Documents WHY the normalizer cannot lean on the vendored parser to find the
    // boundary: the tolerant entry point retains the partial hunk, the validating one
    // drops it, and NEITHER exposes byte offsets to slice at. Hence our own scanner.
    const patch = new TextEncoder().encode(
      'diff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n' +
        '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n' +
        '@@ -20,3 +20,3 @@\n twenty\n-twentyone\n'
    );
    const tolerant = (await parseUnifiedDiff(patch)) as unknown as FpHunk[];
    const validating = await fingerprintHunks(patch);
    expect(tolerant.length).toBe(2);
    expect(validating.length).toBe(1);

    // …and the normalizer agrees with the VALIDATING one, byte-exactly.
    const { bytes: norm } = normalizeTruncatedReviewDiff(patch);
    expect((await fingerprintHunks(norm)).length).toBe(1);
    expect(dec(norm).endsWith(' three\n')).toBe(true);
  });
});
