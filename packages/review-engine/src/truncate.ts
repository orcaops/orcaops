// Complete-hunk normalization for a TRUNCATED review diff.
//
// `diffSnapshotTrees` enforces the byte cap by SIGTERMing git mid-stream and
// slicing the bytes it got. That slice lands wherever it lands — mid-line,
// mid-hunk, mid-file-header. Those exact bytes are then read by four parsers that
// do not agree about what they mean:
//
//   parseUnifiedDiff (@orcaops/diff-fingerprint)  drops an unterminated final line;
//                                                 drops the trailing hunk if its @@
//                                                 counts went unfilled
//   parseChangedRows (review-core)                tolerant; pushes a hunk at every @@
//   parseDiffLinePositions (review-engine)        tolerant; no validation
//   parsePatchFiles (@pierre/diffs, the TUI)      THROWS 'hunk line count mismatch'
//
// Pierre's throw is the expensive one. It fires inside the per-hunk loop, so it
// aborts the ENTIRE FILE — and the TUI catches it to null and collapses that file's
// whole card to a one-row "diff unavailable" note. Every complete hunk in the file,
// with its slices, comments and findings, disappears from the review while the floor
// still counts them. Sampling truncation offsets across a large real review diff,
// the strict parser threw at ~96% of them. Truncation did not degrade
// the review surface, it deleted files from it.
//
// The fix is to stop shipping bytes that mean different things to different readers.
// Trim the truncated patch back to the longest prefix that is STRUCTURALLY COMPLETE,
// and every parser sees the same hunks by construction.
//
// This runs on the REVIEW path only. Checkpoint-fingerprint truncation semantics and
// durable manifest hashes are untouched — they live in packages/core and must not
// call this.

/** The offset just past the last provably-complete hunk/file boundary. */
const LF = 0x0a;
const PLUS = 0x2b;
const MINUS = 0x2d;
const SPACE = 0x20;
const BACKSLASH = 0x5c;

/** `@@ -oldStart[,oldCount] +newStart[,newCount] @@` — an omitted count means 1. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface NormalizedDiff {
  /** A byte-for-byte PREFIX of the input. Empty, or LF-terminated. */
  bytes: Uint8Array;
  /** How many trailing bytes were dropped to reach a complete boundary. */
  discardedBytes: number;
}

/**
 * Trim a truncated unified diff to the longest byte-prefix ending at a structurally
 * complete hunk/file boundary.
 *
 * Guarantees, all of which the property test pins across every truncation offset of
 * every fixture:
 *   - the result is a byte-for-byte PREFIX of the input (never rewritten, never
 *     re-serialized, never LF-completed);
 *   - it is empty or LF-terminated;
 *   - every retained file and hunk is byte-identical to the input's;
 *   - all four parsers enumerate the SAME hunks from it;
 *   - the fingerprint's hunk set is UNCHANGED versus the raw prefix — normalization
 *     only removes bytes the floor was already ignoring, so it moves no coverage and
 *     stales no narrative.
 *
 * Only call this on a diff that ACTUALLY truncated. A complete `git diff` is already
 * a valid patch; rewriting one would churn diff.patch for every repo and move comment
 * anchors for no reason.
 */
export function normalizeTruncatedReviewDiff(bytes: Uint8Array): NormalizedDiff {
  const decoder = new TextDecoder('utf-8', { fatal: false });

  let lastSafeEnd = 0;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  // A file section we cannot prove complete (a malformed hunk, or a binary payload we
  // cannot validate). Its bytes must not be blessed as a boundary.
  let unprovable = false;

  let i = 0;
  while (i < bytes.length) {
    let j = i;
    while (j < bytes.length && bytes[j] !== LF) j++;

    // An unterminated final line is ALWAYS discarded, and never completed with an
    // appended LF — even when the hunk's counts already balance. The LF that got cut
    // may not be the only thing that got cut: the line's CONTENT may be a fragment
    // too, and there is no way to tell from the prefix. The fingerprint hashes line
    // bodies, so blessing a fragment as a whole line would mint a patch_hash — hence
    // a hunkKey — for a hunk that does not exist in the complete diff, and comment
    // anchors bound to it would orphan the moment the cap is raised. Dropping a real
    // hunk is cheap; fabricating a fake identity is not.
    if (j >= bytes.length) break;

    const end = j + 1; // just past the LF
    const first = bytes[i];

    if (inHunk) {
      // Inside a hunk body, lines are consumed BY COUNT, never by pattern. This is
      // what makes a diff-of-a-diff safe: a body line carries a +/-/space prefix, so
      // a nested 'diff --git' or '@@' can never be mistaken for a real header.
      if (first === BACKSLASH) {
        // '\ No newline at end of file' — annotates the preceding line, consumes
        // neither side's count. It may legitimately appear twice in one hunk (once
        // after the last '-' line and once after the last '+'), and it may trail a
        // hunk whose counts are already satisfied — in which case it extends the
        // boundary rather than starting anything new.
        if (oldRemaining === 0 && newRemaining === 0) lastSafeEnd = end;
        i = end;
        continue;
      }
      if (first === PLUS) newRemaining--;
      else if (first === MINUS) oldRemaining--;
      else if (first === SPACE || i === j) {
        // A context line, or a zero-length line. The vendored fingerprint parser
        // counts an empty line against BOTH sides; match it exactly, or the two
        // disagree about where the hunk ends.
        oldRemaining--;
        newRemaining--;
      } else {
        // Not a body line, but the counts say the hunk is unfinished. The patch is
        // malformed; stop trusting this file section.
        unprovable = true;
        inHunk = false;
        i = end;
        continue;
      }

      if (oldRemaining < 0 || newRemaining < 0) {
        unprovable = true;
        inHunk = false;
        i = end;
        continue;
      }
      if (oldRemaining === 0 && newRemaining === 0) {
        inHunk = false;
        lastSafeEnd = end; // a COMPLETE hunk — the primary boundary
      }
      i = end;
      continue;
    }

    if (first === BACKSLASH) {
      // A '\ No newline at end of file' trailing a hunk whose counts ALREADY balanced.
      // It annotates the hunk's final line and consumes neither side's count, so the
      // in-hunk branch above never sees it — the hunk closed on the previous line. It
      // is still part of that hunk, and dropping it would silently change what the
      // patch says about the file's last line.
      //
      // Extend the boundary, but only when the marker sits EXACTLY on it. That way it
      // can lengthen a boundary we already proved, and can never bless bytes we did
      // not.
      if (!unprovable && lastSafeEnd === i) lastSafeEnd = end;
      i = end;
      continue;
    }

    const line = decoder.decode(bytes.subarray(i, j));

    if (line.startsWith('diff --git ')) {
      // A new file section starts here, which proves the PREVIOUS one ended cleanly.
      // This is what makes hunk-less sections safe: a mode-only change, a pure rename,
      // or a terminated `GIT binary patch` payload becomes a boundary the moment the
      // next file begins. One that is still open at EOF is simply dropped — we cannot
      // prove git was finished with it.
      if (!unprovable) lastSafeEnd = i;
      unprovable = false;
      i = end;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
      newRemaining = header[4] === undefined ? 1 : Number(header[4]);
      inHunk = true;
      // A degenerate `@@ -0,0 +0,0 @@` promises nothing, so it is already complete.
      if (oldRemaining === 0 && newRemaining === 0) {
        inHunk = false;
        lastSafeEnd = end;
      }
      i = end;
      continue;
    }

    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      // A complete, hunk-less file section in one line.
      lastSafeEnd = end;
      i = end;
      continue;
    }

    if (line === 'GIT binary patch') {
      // A base85 payload we cannot validate mid-stream. Do not advance the boundary;
      // only the next 'diff --git' can prove the payload terminated.
      unprovable = true;
      i = end;
      continue;
    }

    // Any other metadata line ('index', '---', '+++', 'old/new mode', 'similarity
    // index', 'rename from/to', 'copy from/to', 'new/deleted file mode'): part of a
    // file section that is not yet provably finished. Do NOT advance the boundary.
    i = end;
  }

  return {
    bytes: bytes.subarray(0, lastSafeEnd),
    discardedBytes: bytes.length - lastSafeEnd,
  };
}
