import { terminalFormattingSpanEnd } from './terminal.js';
const SEGMENTS_PER_BLOCK = 1024;
function isInvisible(code: number): boolean {
  return (
    code === 0x00ad ||
    code === 0x061c ||
    code === 0x180e ||
    code === 0xfeff ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  );
}
function isSpaceLike(code: number): boolean {
  return code === 0x00a0 || code === 0x2007 || code === 0x202f;
}
export interface NormalizedText {
  readonly text: string;
  readonly start: Int32Array;
  readonly end: Int32Array;
}
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
