import { createHash } from 'node:crypto';

/**
 * Offsets into a source are UTF-8 byte offsets, not UTF-16 code units, because
 * every other identity in this contract — content hashes, the input byte cap,
 * the provider's own accounting — is counted in bytes. A citation is verified
 * by re-encoding, so a span that lands inside a multi-byte character is a
 * mismatch rather than a silent replacement character.
 */
export interface ByteSpan {
  start: number;
  end: number;
}

export function sourceBytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function spanIsWithin(span: ByteSpan, outer: ByteSpan): boolean {
  return (
    Number.isSafeInteger(span.start) &&
    Number.isSafeInteger(span.end) &&
    span.start >= outer.start &&
    span.end <= outer.end &&
    span.start < span.end
  );
}

export function spansOverlap(left: ByteSpan, right: ByteSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * The text at `span`, or null when the span is out of range or splits a
 * character. Round-tripping the decoded text is the only check that catches a
 * split: `Buffer.toString` substitutes U+FFFD instead of failing.
 */
export function textAt(bytes: Buffer, span: ByteSpan): string | null {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)) return null;
  if (span.start < 0 || span.end > bytes.length || span.start >= span.end) return null;
  const slice = bytes.subarray(span.start, span.end);
  const text = slice.toString('utf8');
  return Buffer.from(text, 'utf8').equals(slice) ? text : null;
}

/** The byte offset of the first byte of each line, in order. */
export function lineStarts(bytes: Buffer): number[] {
  const starts = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a && index + 1 < bytes.length) starts.push(index + 1);
  }
  return starts;
}
