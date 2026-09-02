// OSC 52 clipboard write + copy-text formatting for the Walk's `y` copy.
//
// Measured against @opentui/core 0.1.89: the renderer exposes copyToClipboardOSC52(text) + isOsc52Supported(); under a
// standard xterm pty the native call returns true and its escape bytes reach
// the terminal. The native path is capability-gated — it returns false (writing
// nothing) when the terminal never acked OSC 52. For those terminals we fall
// back to writing the escape directly; a direct process.stdout
// write does NOT reliably reach the tty while the renderer owns the output
// stream, so the fallback is genuinely best-effort (surfaced as a copied notice,
// not a promise the clipboard changed).
//
// The pure pieces (payload framing + decoration formatting) are unit-tested; the
// thin renderer call is not (it needs a live tty).

/** What copyViaOsc52 managed — drives the user-facing notice. */
export type ClipboardResult = 'native' | 'fallback' | 'none';

/** A copyable changed line — the AnchorPick subset copy formatting needs. */
export interface CopyLine {
  side: 'add' | 'delete';
  line: number;
  /** The line body without the diff sign. */
  body: string;
}

/**
 * The OSC 52 escape that sets the system clipboard to `text`: base64 of the raw
 * UTF-8 bytes, framed by OSC 52 (`ESC ] 52 ; c ; <base64> BEL`). `c` targets the
 * primary system clipboard.
 */
export function osc52Payload(text: string): string {
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${base64}\x07`;
}

/** Copy-decoration options — feature-flagged, default OFF (raw code copied). */
export interface CopyDecorations {
  /** Prefix each line with its (side-appropriate) line number + a separator. */
  lineNumbers?: boolean;
}

/**
 * Render the selected changed lines to clipboard text. Default is the raw code
 * bodies joined by newlines — what pastes cleanly into an editor. With
 * `lineNumbers`, each line is prefixed `<n>│ ` (a decoration for context, off by
 * default so a paste never carries gutter noise).
 */
export function formatSelectionText(
  lines: readonly CopyLine[],
  opts: CopyDecorations = {}
): string {
  if (!opts.lineNumbers) {
    return lines.map((l) => l.body).join('\n');
  }
  const width = lines.reduce((w, l) => Math.max(w, String(l.line).length), 1);
  return lines.map((l) => `${String(l.line).padStart(width)}│ ${l.body}`).join('\n');
}

/** The renderer surface copyViaOsc52 needs — the CliRenderer subset used here. */
export interface Osc52Renderer {
  copyToClipboardOSC52(text: string): boolean;
}

/**
 * Best-effort clipboard write via OSC 52. Prefers the renderer's native path
 * (capability-gated, routed through the tty it owns); falls back to a direct
 * escape write for terminals that honor OSC 52 without acking the capability.
 * Returns which path wrote so the caller can phrase the notice honestly.
 */
export function copyViaOsc52(renderer: Osc52Renderer | null, text: string): ClipboardResult {
  try {
    if (renderer !== null && renderer.copyToClipboardOSC52(text)) return 'native';
  } catch {
    // fall through to the direct write
  }
  try {
    process.stdout.write(osc52Payload(text));
    return 'fallback';
  } catch {
    return 'none';
  }
}
