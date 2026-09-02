import { terminalFormattingSpanEnd } from './terminal.js';

/**
 * Text normalization for the DETECTOR ONLY.
 *
 * A secret check has to see what a reader sees. A zero-width character costs a
 * credential nothing on screen and splits it into fragments no pattern matches,
 * so one U+200B inside `aws_secret_access_key` hides a live key from the
 * redactor and the write gate while a human reading the same bytes sees the key
 * whole.
 *
 * Two rules, both anchored on rendering rather than on a character list: what
 * renders as NOTHING is removed, and what renders as a SPACE becomes one.
 * Nothing here rewrites persisted text — {@link stripTerminalFormatting} owns
 * that boundary and must keep the no-break space an author typed. Findings are
 * mapped back to the original coordinates, so redaction still replaces the
 * bytes as given.
 */

// Flatten periodically so dense hostile input cannot retain millions of slices.
const SEGMENTS_PER_BLOCK = 1024;

/**
 * Renders as nothing. The bidi marks are here as well as in the terminal
 * control set: the terminal walk runs first and consumes them, and a security
 * predicate that is complete on its own is worth the overlap.
 *
 * Combining marks are the one entry that is not strictly invisible — they
 * decorate the character before them. No credential format admits one, and a
 * base64 run wearing an acute accent still reads as that run.
 */
function isInvisible(code: number): boolean {
  return (
    code === 0x00ad || // SOFT HYPHEN
    code === 0x061c || // ARABIC LETTER MARK
    code === 0x180e || // MONGOLIAN VOWEL SEPARATOR
    code === 0xfeff || // ZERO WIDTH NO-BREAK SPACE / BOM
    (code >= 0x0300 && code <= 0x036f) || // combining diacritical marks
    (code >= 0x200b && code <= 0x200f) || // ZWSP, ZWNJ, ZWJ, LRM, RLM
    (code >= 0x202a && code <= 0x202e) || // bidi embedding and override
    (code >= 0x2060 && code <= 0x2064) || // word joiner, invisible operators
    (code >= 0x2066 && code <= 0x2069) || // bidi isolates
    (code >= 0xfe00 && code <= 0xfe0f) // variation selectors
  );
}

/** Renders as a space. Folded rather than removed, so no token is joined. */
function isSpaceLike(code: number): boolean {
  return code === 0x00a0 || code === 0x2007 || code === 0x202f;
}

/**
 * Normalized text plus, per code unit, the source range it came from. Ranges
 * found in {@link text} map back through {@link start} and {@link end}, which
 * is why a match is reported and redacted over the bytes as given.
 */
export interface NormalizedText {
  readonly text: string;
  /** Source offset of each code unit of {@link text}. */
  readonly start: Int32Array;
  /** Exclusive source end of each code unit of {@link text}. */
  readonly end: Int32Array;
}

/** Normalize `text` for detection, or `null` when it needs no normalization. */
export function normalizeForDetection(text: string): NormalizedText | null {
  let probe = 0;
  while (probe < text.length) {
    const code = text.charCodeAt(probe);
    if (terminalFormattingSpanEnd(text, probe) !== probe) break;
    if (isInvisible(code) || isSpaceLike(code)) break;
    probe += 1;
  }
  if (probe === text.length) return null;

  const blocks: string[] = [];
  const segments: string[] = [];
  const start = new Int32Array(text.length);
  const end = new Int32Array(text.length);
  let kept = 0;
  let runStart = 0;

  const push = (segment: string): void => {
    segments.push(segment);
    if (segments.length === SEGMENTS_PER_BLOCK) {
      blocks.push(segments.join(''));
      segments.length = 0;
    }
  };
  const flush = (upTo: number): void => {
    if (upTo <= runStart) return;
    push(text.slice(runStart, upTo));
    for (let at = runStart; at < upTo; at += 1) {
      start[kept] = at;
      end[kept] = at + 1;
      kept += 1;
    }
  };

  for (let cursor = 0; cursor < text.length; ) {
    const spanEnd = terminalFormattingSpanEnd(text, cursor);
    const code = text.charCodeAt(cursor);
    const folded = spanEnd === cursor && isSpaceLike(code);
    if (spanEnd === cursor && !folded && !isInvisible(code)) {
      cursor += 1;
      continue;
    }
    flush(cursor);
    if (folded) {
      push(' ');
      start[kept] = cursor;
      end[kept] = cursor + 1;
      kept += 1;
    }
    cursor = spanEnd > cursor ? spanEnd : cursor + 1;
    runStart = cursor;
  }
  flush(text.length);
  if (segments.length > 0) blocks.push(segments.join(''));

  return {
    text: blocks.join(''),
    start: start.subarray(0, kept),
    end: end.subarray(0, kept),
  };
}
