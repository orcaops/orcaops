import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ErrorCodes } from './errors.js';
import { readPayloadInput } from './input.js';

const payloadDir = mkdtempSync(path.join(tmpdir(), 'orcaops-input-unit-'));
let payloadN = 0;
/** Write a raw payload to a temp file — exercises the parser through the
 *  canonical `--input <path>` source without needing piped stdin. */
const payloadFile = (raw: string): string => {
  const p = path.join(payloadDir, `p${payloadN++}`);
  writeFileSync(p, raw, 'utf8');
  return p;
};

describe('readPayloadInput — YAML/JSON payload parsing', () => {
  it('parses a JSON document through the YAML 1.2 input path', async () => {
    const json = JSON.stringify({
      task: 'thing',
      label: 'thing',
      plan_steps: [{ text: 's1', label: 's1' }],
    });
    await expect(readPayloadInput({ inputPath: payloadFile(json) })).resolves.toEqual({
      task: 'thing',
      label: 'thing',
      plan_steps: [{ text: 's1', label: 's1' }],
    });
  });

  it('parses YAML with a strip-chomp block scalar, newlines literal', async () => {
    const yaml = ['summary: |-', '  line one', '  line two', 'files_changed: [src/a.ts]'].join(
      '\n'
    );
    const out = (await readPayloadInput({ inputPath: payloadFile(yaml) })) as {
      summary: string;
      files_changed: string[];
    };
    expect(out.summary).toBe('line one\nline two');
    expect(out.files_changed).toEqual(['src/a.ts']);
  });

  it('treats a comment-only document as NO_INPUT (not a re-wrapped parse error)', async () => {
    await expect(
      readPayloadInput({ inputPath: payloadFile('# just a comment') })
    ).rejects.toMatchObject({
      code: ErrorCodes.NO_INPUT,
    });
  });

  it('rejects malformed YAML as INVALID_INPUT', async () => {
    // Unclosed flow sequence — a genuine parse error.
    await expect(readPayloadInput({ inputPath: payloadFile('key: [1, 2') })).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
    });
  });

  it('a colon-space in an unquoted scalar fails INVALID_INPUT with a quoting hint', async () => {
    // YAML reads `implement: the thing` (value with a colon-space) as a nested
    // mapping → hard parse error; the hint nudges toward quoting / a block scalar.
    await expect(
      readPayloadInput({ inputPath: payloadFile('text: implement: the thing') })
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
      message: expect.stringContaining("quote any value containing ': '"),
    });
  });

  describe('allowEmpty (bare pre-pr-check)', () => {
    it('bare invocation (no source, TTY) resolves to {} when allowEmpty', async () => {
      await expect(readPayloadInput({ isTTY: true, allowEmpty: true })).resolves.toEqual({});
    });

    it('bare invocation (no source, TTY) still throws NO_INPUT without allowEmpty', async () => {
      await expect(readPayloadInput({ isTTY: true })).rejects.toMatchObject({
        code: ErrorCodes.NO_INPUT,
      });
    });

    it('an explicit but missing --input still throws NO_INPUT even with allowEmpty', async () => {
      await expect(
        readPayloadInput({ inputPath: '/nonexistent/orcaops-f2-xyz.yaml', allowEmpty: true })
      ).rejects.toMatchObject({ code: ErrorCodes.NO_INPUT });
    });
  });
});
