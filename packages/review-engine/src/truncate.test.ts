// The regression matrix for complete-hunk truncation normalization.
//
// The contract is narrow and absolute: the output is a byte-for-byte PREFIX of the
// input, empty or LF-terminated, ending at a structurally complete boundary. The
// four-parser parity property test (apps/orcaops-watch) proves the parsers agree on
// the result; this file pins the SHAPES — each row of the doc's regression matrix,
// plus the cases that make the algorithm subtle.

import { describe, expect, it } from 'vitest';

import { normalizeTruncatedReviewDiff } from './truncate.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Normalize a patch string and return the retained text. */
function norm(patch: string): string {
  return dec(normalizeTruncatedReviewDiff(enc(patch)).bytes);
}
function discarded(patch: string): number {
  return normalizeTruncatedReviewDiff(enc(patch)).discardedBytes;
}

const HEAD_A = 'diff --git a/a.ts b/a.ts\nindex 111..222 100644\n--- a/a.ts\n+++ b/a.ts\n';
const HUNK_A = '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n';
const HUNK_A2 = '@@ -20,3 +20,3 @@\n twenty\n-twentyone\n+TWENTYONE\n twentytwo\n';
const HEAD_B = 'diff --git a/b.ts b/b.ts\nindex 333..444 100644\n--- a/b.ts\n+++ b/b.ts\n';
const HUNK_B = '@@ -5,3 +5,3 @@\n five\n-six\n+SIX\n seven\n';

describe('normalizeTruncatedReviewDiff — the invariant', () => {
  it('always returns a byte-for-byte PREFIX of its input', () => {
    const patch = HEAD_A + HUNK_A + HEAD_B + '@@ -5,3 +5,3 @@\n five\n-six\n';
    const bytes = enc(patch);
    const out = normalizeTruncatedReviewDiff(bytes).bytes;
    expect(out.length).toBeLessThanOrEqual(bytes.length);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(bytes[i]);
  });

  it('is empty or LF-terminated, never anything else', () => {
    for (const patch of [
      HEAD_A + HUNK_A,
      HEAD_A + '@@ -1,3 +1,3 @@\n one\n-two\n', // partial
      HEAD_A, // metadata only
      '', // nothing
    ]) {
      const out = norm(patch);
      expect(out === '' || out.endsWith('\n')).toBe(true);
    }
  });

  it('discardedBytes is exactly what was dropped', () => {
    const tail = '@@ -20,3 +20,3 @@\n twenty\n-twentyone\n';
    expect(discarded(HEAD_A + HUNK_A + tail)).toBe(enc(tail).length);
    expect(discarded(HEAD_A + HUNK_A)).toBe(0);
  });
});

describe('normalizeTruncatedReviewDiff — the doc regression matrix', () => {
  it('complete hunk WITH a final LF: unchanged', () => {
    const patch = HEAD_A + HUNK_A;
    expect(norm(patch)).toBe(patch);
    expect(discarded(patch)).toBe(0);
  });

  it('complete hunk WITHOUT a final LF: the hunk is DROPPED, not LF-completed', () => {
    // A deliberate divergence from the source doc, which asked to "retain the complete
    // hunk and normalize termination". We refuse to.
    //
    // The LF is not the only byte that may have been cut. ' three' could be the
    // fragment of ' threefold' — the prefix cannot tell us. The fingerprint hashes
    // line BODIES, so appending an LF and calling it whole would mint a patch_hash,
    // and therefore a hunkKey, for a hunk that does not exist in the complete diff.
    // Comment anchors bound to that key would orphan the moment the cap is raised.
    // Losing one hunk is cheap. Fabricating durable identity is not.
    //
    // With an earlier COMPLETE hunk present, you can see the boundary roll back onto
    // it rather than emitting a 2-of-3-row hunk that every parser would choke on.
    const patch = (HEAD_A + HUNK_A + HUNK_A2).slice(0, -1);
    expect(norm(patch)).toBe(HEAD_A + HUNK_A);
    expect(norm(patch)).not.toContain('twentytwo');

    // And with no earlier hunk to fall back to, nothing survives — the honest answer.
    expect(norm((HEAD_A + HUNK_A).slice(0, -1))).toBe('');
  });

  it('partial FIRST hunk: emits no malformed hunk at all', () => {
    // Nothing survives — and that is the honest answer. The disclosure still fires;
    // the alternative is a hunk whose @@ promises rows that are not there, which is
    // exactly what makes the TUI's parser throw away the whole file.
    expect(norm(HEAD_A + '@@ -1,3 +1,3 @@\n one\n-two\n')).toBe('');
  });

  it('complete FIRST hunk + partial SECOND: the first is retained', () => {
    const patch = HEAD_A + HUNK_A + '@@ -20,3 +20,3 @@\n twenty\n-twentyone\n';
    expect(norm(patch)).toBe(HEAD_A + HUNK_A);
  });

  it('complete earlier FILE + partial hunk in a later file: the earlier file survives', () => {
    // The failure this normalization exists to prevent. Pierre aborts the entire file
    // on a count mismatch, so before normalization file a.ts rendered fine but file
    // b.ts vanished — including complete hunks the floor still counted.
    const patch = HEAD_A + HUNK_A + HUNK_A2 + HEAD_B + '@@ -5,3 +5,3 @@\n five\n-six\n';
    expect(norm(patch)).toBe(HEAD_A + HUNK_A + HUNK_A2);
  });

  it('truncation inside a later file HEADER: that file section is dropped whole', () => {
    const patch = HEAD_A + HUNK_A + 'diff --git a/b.ts b/b.ts\nindex 333..444 100644\n--- a/b.ts\n';
    expect(norm(patch)).toBe(HEAD_A + HUNK_A);
  });

  it('rename-with-content: the hunk boundary still governs', () => {
    const patch =
      'diff --git a/old.ts b/new.ts\nsimilarity index 88%\nrename from old.ts\nrename to new.ts\nindex 111..222 100644\n--- a/old.ts\n+++ b/new.ts\n' +
      '@@ -1,2 +1,2 @@\n keep\n-drop\n+add\n';
    expect(norm(patch)).toBe(patch);
  });

  it('a PURE rename (no hunks) is complete only once the next file proves it ended', () => {
    const pureRename =
      'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';
    // Alone at EOF we cannot prove git was finished with it — more metadata, or a
    // hunk, might have been coming. Conservative: drop it.
    expect(norm(pureRename)).toBe('');
    // Followed by another file, its completeness is proven and it is retained.
    expect(norm(pureRename + HEAD_B + HUNK_B)).toBe(pureRename + HEAD_B + HUNK_B);
  });

  it('mode-only change: same rule — proven complete by the next file section', () => {
    const modeOnly = 'diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n';
    expect(norm(modeOnly)).toBe('');
    expect(norm(modeOnly + HEAD_B + HUNK_B)).toBe(modeOnly + HEAD_B + HUNK_B);
  });

  it('deletion and addition hunks', () => {
    const del =
      'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 111..000\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n';
    expect(norm(del)).toBe(del);
    const add =
      'diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 000..111\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n';
    expect(norm(add)).toBe(add);
  });

  it('binary: "Binary files ... differ" is a complete one-line section', () => {
    const bin =
      'diff --git a/i.png b/i.png\nindex 111..222 100644\nBinary files a/i.png and b/i.png differ\n';
    expect(norm(bin)).toBe(bin);
    expect(norm(bin + HEAD_B + HUNK_B)).toBe(bin + HEAD_B + HUNK_B);
  });

  it('a GIT binary patch payload cut mid-base85 drops the whole file section', () => {
    // We cannot validate base85 mid-stream, so the payload is only ever proven
    // complete by the next `diff --git`. Cut inside it, and the section goes.
    const payload =
      'diff --git a/i.png b/i.png\nindex 111..222 100644\nGIT binary patch\nliteral 240\nzcmeAS@N?(olHy`uVBq!ia0vp^\n';
    expect(norm(HEAD_A + HUNK_A + payload)).toBe(HEAD_A + HUNK_A);
  });

  it('CRLF content: the \\r is body bytes, not a boundary', () => {
    const patch = HEAD_A + '@@ -1,3 +1,3 @@\n one\r\n-two\r\n+TWO\r\n three\r\n';
    expect(norm(patch)).toBe(patch);
  });

  it('"\\ No newline at end of file" consumes neither side, and can appear twice', () => {
    // Once after the last '-' and once after the last '+'. Both must extend the
    // boundary rather than being mistaken for body lines.
    const patch =
      HEAD_A +
      '@@ -1,2 +1,2 @@\n keep\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
    expect(norm(patch)).toBe(patch);
  });

  it('a hunk header with OMITTED counts means 1', () => {
    const patch = HEAD_A + '@@ -1 +1 @@\n-a\n+b\n';
    expect(norm(patch)).toBe(patch);
  });

  it('an EMPTY line inside a hunk counts as context on BOTH sides', () => {
    // The vendored fingerprint parser does this; we must match it exactly or the two
    // disagree about where the hunk ends — which is the whole class of bug here.
    const patch = HEAD_A + '@@ -1,3 +1,3 @@\n one\n\n+added\n';
    // 3 old rows promised: ' one', '' (empty=context), and… only 2 present, so the
    // hunk never completes and nothing is retained.
    expect(norm(patch)).toBe('');
    // With the third old row present, it completes.
    const complete = HEAD_A + '@@ -3,3 +3,4 @@\n one\n\n three\n+added\n';
    expect(norm(complete)).toBe(complete);
  });
});

describe('normalizeTruncatedReviewDiff — a diff OF a diff cannot fool it', () => {
  it('body lines that look like headers are consumed by COUNT, never by pattern', () => {
    // A repository can commit `.patch` fixtures, so a review diff can contain diff text.
    // Body lines carry a +/-/space prefix, so a nested 'diff --git' or '@@' is never
    // a bare header — but only because we consume exactly the promised counts and
    // never scan for the next marker.
    // 3 old rows (context, deletion, context) and 3 new (context, addition, context).
    const patch =
      'diff --git a/f.patch b/f.patch\nindex 111..222 100644\n--- a/f.patch\n+++ b/f.patch\n' +
      '@@ -1,3 +1,3 @@\n diff --git a/x b/x\n-@@ -1,1 +1,1 @@\n+@@ -2,2 +2,2 @@\n --- a/x\n';
    expect(norm(patch)).toBe(patch);
  });
});
