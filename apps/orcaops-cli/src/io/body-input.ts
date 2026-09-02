import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ErrorCodes, OrcaopsError } from './errors.js';
import { readAllStdin } from './stdin.js';
import { getInvocationCwd } from '../lib/invocation-context.js';

export interface ReadBodyInputOptions {
  /**
   * `--input <path>` reads that file; `--input -` (or omitted, with piped
   * stdin) reads stdin to EOF. This is the RAW plan-body reader for the review
   * mutations — NOT the YAML/JSON capture-payload parser (`io/input.ts`): the
   * body is hashed verbatim (`content_hash = sha256(body)`) and the cloud
   * recomputes + 422s on any normalization, so it must never be
   * parsed/reserialized.
   */
  input?: string;
  /** Whether stdin is a TTY (test override). */
  isTTY?: boolean;
}

/**
 * Resolve a raw plan/comment body from `--input <file>` or stdin, mirroring
 * `plan upload`'s file read (resolve against the invocation cwd, read utf8,
 * reject a blank body) but adding the `--input -` / piped-stdin source the
 * review skills use. Returns the body VERBATIM (untrimmed) — only the emptiness
 * check trims; the bytes returned (and later hashed) are exactly what was read.
 */
export async function readBodyInput(opts: ReadBodyInputOptions = {}): Promise<string> {
  const stdinFromDash = opts.input === '-';
  const inputPath = stdinFromDash ? undefined : opts.input;
  const isTTY = opts.isTTY ?? process.stdin.isTTY ?? false;

  let raw: string;
  if (inputPath !== undefined) {
    const abs = path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(getInvocationCwd(), inputPath);
    try {
      raw = await readFile(abs, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new OrcaopsError(
        ErrorCodes.NO_INPUT,
        code === 'ENOENT'
          ? `--input file not found: "${inputPath}".`
          : `could not read --input file "${inputPath}": ${(err as Error).message}`,
        'input'
      );
    }
  } else if (stdinFromDash || !isTTY) {
    raw = await readAllStdin();
  } else {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      "No body provided. Pass --input <file>, --input - <<'EOF'...EOF (stdin), or pipe the body on stdin."
    );
  }

  if (raw.trim().length === 0) {
    throw new OrcaopsError(ErrorCodes.NO_INPUT, 'The plan body was empty.');
  }
  return raw;
}
