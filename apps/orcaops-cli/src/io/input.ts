import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { collectControlCharPaths } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from './errors.js';
import { writeTerminalSafeStderr } from './output.js';
import { readAllStdin } from './stdin.js';

export interface ReadPayloadInputOptions {
  /**
   * The `--input <value>` payload source: `'-'` reads stdin; any other value
   * is a file path. Mirrors the convention other CLIs use (kubectl `-f`,
   * jq `-f`, etc.).
   */
  inputPath?: string;
  /** Whether stdin is a TTY (test override). */
  isTTY?: boolean;
  /**
   * When true, a bare invocation with NO payload source — no `--input` and no
   * piped stdin (or empty/whitespace stdin) — resolves to `{}` instead of
   * throwing NO_INPUT. For capture subcommands whose fields are all optional
   * and that autodetect the active artifact (e.g. pre-pr-check). An explicit
   * but missing/unreadable `--input <path>` still errors loudly — that check
   * precedes this one.
   */
  allowEmpty?: boolean;
}

/**
 * Resolve the capture payload (YAML or JSON — the format is auto-detected)
 * for a capture command via canonical `--input`.
 *   1. `--input <path>` → read + parse that file.
 *   2. `--input -` or no flag → read stdin to EOF.
 *   3. stdin is a TTY (no piped input) and no flag → error.
 *
 * The `-` convention is what the agent skills tell agents to use
 * (`orcaops capture plan --input - <<'EOF' ... EOF`); it must work.
 */
export async function readPayloadInput(opts: ReadPayloadInputOptions = {}): Promise<unknown> {
  // `--input -` is the canonical stdin form; fold it into the stdin path so it
  // is never mistaken for a file literally named "-".
  const stdinExplicit = opts.inputPath === '-';
  const inputPath = stdinExplicit ? undefined : opts.inputPath;

  const isTTY = opts.isTTY ?? process.stdin.isTTY ?? false;

  let raw: string;
  if (inputPath !== undefined) {
    try {
      raw = await readFile(inputPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new OrcaopsError(
          ErrorCodes.NO_INPUT,
          `--input file not found: "${inputPath}".`,
          'input'
        );
      }
      throw new OrcaopsError(
        ErrorCodes.NO_INPUT,
        `Could not read --input file "${inputPath}": ${(err as Error).message}`,
        'input'
      );
    }
  } else if (stdinExplicit || !isTTY) {
    raw = await readAllStdin();
  } else if (opts.allowEmpty) {
    // Bare invocation, no payload source: the caller opts into an empty
    // payload (all fields optional + artifact autodetection). Return {} so the
    // schema parse and autodetect run instead of failing NO_INPUT.
    return {};
  } else {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      "No input provided. Pass --input - <<'EOF'...EOF (stdin), --input <path>, or pipe a payload (YAML or JSON) on stdin."
    );
  }

  if (raw.trim().length === 0) {
    // Empty/whitespace stdin (the non-TTY bare path, e.g. a vitest worker) —
    // same opt-in as the interactive bare branch above.
    if (opts.allowEmpty) return {};
    throw new OrcaopsError(ErrorCodes.NO_INPUT, 'Input was empty.');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Could not parse input (expected YAML or JSON): ${(err as Error).message} — ` +
        `quote any value containing ': ' (or use a |- block scalar for prose); ` +
        `an unquoted colon-space is read as a nested mapping.`
    );
  }

  // A comment-only or whitespace-only YAML document parses to null/undefined
  // (unlike JSON.parse, which would have thrown). Guard it OUTSIDE the catch
  // above so it surfaces as NO_INPUT rather than a re-wrapped INVALID_INPUT.
  if (parsed === null || parsed === undefined) {
    throw new OrcaopsError(ErrorCodes.NO_INPUT, 'Input was empty or contained no document.');
  }

  // Best-effort advisory: downstream the capture-input schemas STRIP forbidden
  // control chars from prose fields but REJECT them in identifier fields (ids /
  // refs / keys), so the wording can't promise a clean heal for every field —
  // an identifier hit hard-fails. Surface a one-line note when the raw input
  // carried any, so a systematically-broken source (a bad paste pipeline) is
  // noticed rather than silently healed. Not load-bearing — the schemas + the
  // wire-side assert are the actual guard.
  const dirtyPaths = collectControlCharPaths(parsed);
  if (dirtyPaths.length > 0) {
    const shown = dirtyPaths.slice(0, 5).join(', ');
    const more = dirtyPaths.length > 5 ? ` (+${dirtyPaths.length - 5} more)` : '';
    writeTerminalSafeStderr(
      `⚠ Disallowed control character(s) found in input field(s): ${shown}${more}. ` +
        `They render invisibly (often a stray paste). Prose fields are cleaned ` +
        `automatically; identifier fields (ids/refs/keys) are rejected instead.\n`
    );
  }

  return parsed;
}
