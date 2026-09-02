import { describe, expect, it } from 'vitest';

import { runSubprocess } from './subprocess.js';

const NODE = process.execPath;

function run(script: string, maxOutputBytes: number) {
  return runSubprocess({
    argv: [NODE, '-e', script],
    cwd: process.cwd(),
    env: {},
    stdin: '',
    timeoutMs: 10_000,
    maxOutputBytes,
    attachContextFile: false,
  });
}

describe('runSubprocess output caps', () => {
  it('counts bytes, not UTF-16 code units', async () => {
    // 'é' is 1 code unit but 2 UTF-8 bytes: 600 chars = 1200 bytes. A
    // code-unit counter would admit all 600 under a 1000-byte cap.
    const result = await run(`process.stdout.write('\\u00e9'.repeat(600));`, 1_000);
    expect(result.killed_reason).toBe('output-too-large');
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1_000);
  });

  it('never splits a multibyte sequence at the cap', async () => {
    // 998 ASCII bytes then a 4-byte emoji: the cap cuts 2 bytes into the
    // emoji; the retained output must drop it rather than decode garbage.
    const result = await run(
      `process.stdout.write(Buffer.concat([Buffer.alloc(998, 0x61), Buffer.from('\\u{1F600}')]));`,
      1_000
    );
    expect(result.killed_reason).toBe('output-too-large');
    expect(result.stdout).toBe('a'.repeat(998));
    expect(result.stdout.includes('�')).toBe(false);
  });

  it('bounds stdout and stderr independently', async () => {
    const result = await run(
      `process.stderr.write('err-intact'); process.stdout.write('x'.repeat(5000));`,
      1_000
    );
    expect(result.killed_reason).toBe('output-too-large');
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1_000);
    expect(result.stderr).toBe('err-intact');
  });

  it('keeps complete multibyte output intact under the cap', async () => {
    const result = await run(`process.stdout.write('héllo \\u{1F600}');`, 1_000);
    expect(result.killed_reason).toBeNull();
    expect(result.stdout).toBe('héllo \u{1F600}');
    expect(result.exit_code).toBe(0);
  });
});
