// Vendored from hunk (https://github.com/modem-dev/hunk) @ 9ef9b2e, source path src/lib/terminalText.ts
// MIT License, Copyright (c) Ben Vinegar. Full text: packages/diff-render/LICENSE.
// Adaptations for @orcaops/diff-render:
//   - bounded resource usage on adversarial input: the control-string regexes'
//     lazy [\s\S]*? spans rescan to end-of-string from every unterminated
//     ESC]/DCS/C1 intro, which is quadratic on inputs like "\x1b]".repeat(n).
//     The spans are bounded to MAX_CONTROL_SEQUENCE_LENGTH and only the first
//     SEQUENCE_SCAN_LIMIT characters get the superlinear OSC/DCS treatment;
//     past that limit the LINEAR passes still run (CSI stripping with style
//     preservation, per-character strip), so no non-preserved control
//     characters survive (preserveNewlines/preserveTabs are respected) and
//     preserveAnsiStyle works across the boundary.

export interface SanitizeTerminalTextOptions {
  /** Preserve line feeds for multiline text fields. Defaults to true. */
  preserveNewlines?: boolean;
  /** Preserve horizontal tabs for text fields that intentionally support them. Defaults to true. */
  preserveTabs?: boolean;
  /** Preserve ANSI SGR style sequences such as Git color output. Defaults to false. */
  preserveAnsiStyle?: boolean;
}

const controlCodeRegex = /[\x00-\x1f\x7f-\x9f]/;
// Longest control-sequence payload the sequence-aware regexes will span. Real
// OSC/DCS payloads (titles, hyperlinks, SGR runs) are far shorter; a longer
// unterminated intro degrades to the per-character strip instead of an
// end-of-string rescan.
const MAX_CONTROL_SEQUENCE_LENGTH = 1024;
// Only this many leading characters get sequence-aware sanitizing; a single
// minified or newline-free diff line can be megabytes, and the bounded spans
// alone still cost O(n * MAX_CONTROL_SEQUENCE_LENGTH) over the whole line.
const SEQUENCE_SCAN_LIMIT = 65_536;
// Keep these global regexes private and use them only with String#replace below.
// Calling test/exec on shared /g regexes would make lastIndex stateful between calls.
const sevenBitControlStrings = new RegExp(
  `\\x1b(?:\\][\\s\\S]{0,${MAX_CONTROL_SEQUENCE_LENGTH}}?(?:\\x07|\\x1b\\\\|\\x9c)|[PX^_][\\s\\S]{0,${MAX_CONTROL_SEQUENCE_LENGTH}}?(?:\\x1b\\\\|\\x9c)|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
// The CSI-only subset of the pattern above. Linear (no lazy span), so it runs
// across the ENTIRE input — the tail past the scan limit keeps whole-sequence
// stripping and style preservation for CSI while only OSC/DCS handling
// degrades to the per-character strip.
const sevenBitCsi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const c1ControlStrings = new RegExp(
  `[\\x90\\x98\\x9d\\x9e\\x9f][\\s\\S]{0,${MAX_CONTROL_SEQUENCE_LENGTH}}?(?:\\x07|\\x1b\\\\|\\x9c)`,
  "g",
);
const c1Csi = /\x9b[0-?]*[ -/]*[@-~]/g;
const preservedStyleTokenDelimiters = /[\u{f0000}\u{f0001}]/gu;
const preservedStyleTokens = /\u{f0000}(\d+)\u{f0001}/gu;

/** Normalize untrusted terminal-bound text before rendering it in Hunk UI surfaces. */
export function sanitizeTerminalText(
  text: string,
  {
    preserveNewlines = true,
    preserveTabs = true,
    preserveAnsiStyle = false,
  }: SanitizeTerminalTextOptions = {},
) {
  if (!controlCodeRegex.test(text)) {
    return text;
  }

  const controlCharacters = preserveNewlines
    ? preserveTabs
      ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
      : /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g
    : preserveTabs
      ? /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g
      : /[\x00-\x1f\x7f-\x9f]/g;
  const preservedStyles: string[] = [];
  const preserveStyle = (sequence: string) => {
    if (!preserveAnsiStyle || !/^\x1b\[[0-9;:]*m$/.test(sequence)) {
      return "";
    }

    const token = `\u{f0000}${preservedStyles.length}\u{f0001}`;
    preservedStyles.push(sequence);
    return token;
  };

  // Strip placeholder delimiters from untrusted input so authored text cannot spoof
  // an internal token that later restores an ANSI sequence at the wrong location.
  const tokenSafeText = preserveAnsiStyle ? text.replace(preservedStyleTokenDelimiters, "") : text;

  // The LINEAR passes (CSI stripping with style preservation) run over the
  // ENTIRE input first, so a CSI sequence can never straddle the scan
  // boundary. Only the superlinear OSC/DCS handling is bounded to the head;
  // the tail falls back to the per-character strip, so no control character
  // survives either way.
  const csiClean = tokenSafeText.replace(sevenBitCsi, preserveStyle).replace(c1Csi, "");
  const head = csiClean.slice(0, SEQUENCE_SCAN_LIMIT);
  const tail = csiClean.slice(SEQUENCE_SCAN_LIMIT);

  let sanitized =
    head
      .replace(sevenBitControlStrings, preserveStyle)
      .replace(c1ControlStrings, "")
      .replace(controlCharacters, "") + tail.replace(controlCharacters, "");

  if (preservedStyles.length > 0) {
    sanitized = sanitized.replace(preservedStyleTokens, (_token, index: string) => {
      return preservedStyles[Number(index)] ?? "";
    });
  }

  return sanitized;
}

/** Sanitize a single terminal row or cell where newlines must never be preserved. */
export function sanitizeTerminalLine(text: string) {
  return sanitizeTerminalText(text, { preserveNewlines: false, preserveTabs: true });
}

/** Sanitize render spans while preserving their non-text styling metadata. */
export function sanitizeTerminalSpans<T extends { text: string }>(spans: readonly T[]): T[] {
  const sanitized: T[] = [];
  for (const span of spans) {
    const text = sanitizeTerminalLine(span.text);
    if (text.length > 0) {
      sanitized.push({ ...span, text } as T);
    }
  }
  return sanitized;
}
