const TAB = 0x09;
const LF = 0x0a;
const C0_END = 0x1f;
const DEL = 0x7f;
const C1_END = 0x9f;
const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
const BEL = 0x07;
const C1_DCS = 0x90;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_SOS = 0x98;
const C1_PM = 0x9e;
const C1_APC = 0x9f;
// Flatten periodically so dense hostile input cannot retain millions of slices.
const SEGMENTS_PER_BLOCK = 1024;

function isTerminalControl(code: number): boolean {
  if (code === TAB || code === LF) return false;
  return (
    code <= C0_END ||
    (code >= DEL && code <= C1_END) ||
    code === 0x061c ||
    (code >= 0x200e && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Neutralize terminal commands in untrusted text while preserving visible
 * bytes. This is intentionally stricter than persisted prose: CR is removed
 * because a terminal interprets it as cursor movement.
 *
 * This does not remove the printable body of a terminal sequence. Do not use
 * it at an output boundary; use {@link stripTerminalFormatting} there.
 */
export function stripTerminalControls(text: string): string {
  let cursor = 0;
  while (cursor < text.length && !isTerminalControl(text.charCodeAt(cursor))) cursor += 1;
  if (cursor === text.length) return text;

  const blocks: string[] = [];
  const segments: string[] = [];
  let visibleStart = 0;
  for (; cursor < text.length; cursor += 1) {
    if (!isTerminalControl(text.charCodeAt(cursor))) continue;
    if (visibleStart < cursor) segments.push(text.slice(visibleStart, cursor));
    visibleStart = cursor + 1;
    if (segments.length === SEGMENTS_PER_BLOCK) {
      blocks.push(segments.join(''));
      segments.length = 0;
    }
  }
  if (visibleStart < text.length) segments.push(text.slice(visibleStart));
  if (segments.length > 0) blocks.push(segments.join(''));
  return blocks.join('');
}

/**
 * Remove complete ANSI control sequences as well as their introducers.
 * Printable parameters such as `[31m` must disappear with the ESC byte so
 * they cannot split a secret into a pattern the redactor no longer recognizes.
 */
export function stripTerminalFormatting(text: string): string {
  let cursor = 0;
  while (cursor < text.length && terminalFormattingSpanEnd(text, cursor) === cursor) cursor += 1;
  if (cursor === text.length) return text;

  const blocks: string[] = [];
  const segments: string[] = [];
  let visibleStart = 0;
  while (cursor < text.length) {
    const spanEnd = terminalFormattingSpanEnd(text, cursor);
    if (spanEnd === cursor) {
      cursor += 1;
      continue;
    }
    if (visibleStart < cursor) segments.push(text.slice(visibleStart, cursor));
    visibleStart = spanEnd;
    cursor = spanEnd;
    if (segments.length === SEGMENTS_PER_BLOCK) {
      blocks.push(segments.join(''));
      segments.length = 0;
    }
  }
  if (visibleStart < text.length) segments.push(text.slice(visibleStart));
  if (segments.length > 0) blocks.push(segments.join(''));
  return blocks.join('');
}

/**
 * Return the exclusive end of terminal formatting that begins at `index`, or
 * `index` when the current code unit is visible. Exported for the redactor's
 * normalized-to-original range mapping; callers should normally use a strip
 * helper instead.
 */
export function terminalFormattingSpanEnd(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === ESC) {
    const next = text.charCodeAt(index + 1);
    if (next === 0x5b) return csiSpanEnd(text, index, index + 2);
    if (next === 0x5d) return stringSequenceSpanEnd(text, index, index + 2, true);
    if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
      return stringSequenceSpanEnd(text, index, index + 2, false);
    }
  }
  if (code === C1_CSI) return csiSpanEnd(text, index, index + 1);
  if (code === C1_OSC) return stringSequenceSpanEnd(text, index, index + 1, true);
  if (code === C1_DCS || code === C1_SOS || code === C1_PM || code === C1_APC) {
    return stringSequenceSpanEnd(text, index, index + 1, false);
  }
  return isTerminalControl(code) ? index + 1 : index;
}

function csiSpanEnd(text: string, introducer: number, bodyStart: number): number {
  let cursor = bodyStart;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code === CAN || code === SUB) return cursor + 1;
    if (code === ESC || (code >= 0x80 && code <= C1_END)) return cursor;
    // ECMA-48 permits C0 controls inside a CSI sequence: terminals execute
    // them immediately and continue parsing the sequence. DEL is ignored.
    if (code <= C0_END || code === DEL) {
      cursor += 1;
      continue;
    }
    if (code >= 0x40 && code <= 0x7e) return cursor + 1;
    if (code > 0x3f) return introducer + 1;
    cursor += 1;
  }
  return introducer + 1;
}

function stringSequenceSpanEnd(
  text: string,
  introducer: number,
  bodyStart: number,
  bellTerminates: boolean
): number {
  for (let cursor = bodyStart; cursor < text.length; cursor += 1) {
    const code = text.charCodeAt(cursor);
    if (bellTerminates && code === BEL) return cursor + 1;
    if (code === C1_ST) return cursor + 1;
    if (code === ESC && text.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
    // A new introducer makes the current sequence malformed. Stop here so
    // repeated unterminated sequences cannot rescan the entire remaining text.
    if (
      code === ESC ||
      code === C1_CSI ||
      code === C1_OSC ||
      code === C1_DCS ||
      code === C1_SOS ||
      code === C1_PM ||
      code === C1_APC
    ) {
      return introducer + 1;
    }
  }
  return introducer + 1;
}

/**
 * Serialize JSON without placing raw terminal controls on the wire.
 *
 * JSON.stringify already escapes C0 controls. DEL and C1 controls are valid
 * JSON string bytes, so escape those explicitly while preserving their
 * decoded values for machine consumers.
 */
export function stringifyTerminalSafeJson(value: object, space?: string | number): string {
  return JSON.stringify(value, null, space).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => {
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  );
}
