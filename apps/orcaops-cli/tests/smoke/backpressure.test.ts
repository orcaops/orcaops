import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flushWritable } from '../../src/io/exit.js';

/**
 * Structured output must survive `process.exit` under backpressure.
 *
 * This has to be a SPAWN test with a real pipe. The in-process harness
 * replaces `process.stdout.write` with a string accumulator, so its writes
 * always return true and the pipe buffer — the thing under test — never
 * exists. It also has to write MORE than the pipe buffer (~64 KiB): a
 * smaller payload is accepted whole and `process.exit` loses nothing, so a
 * test built on a small envelope passes with or without the fix. (The
 * largest real envelope, `doctor --json`, is about 4 KiB — nowhere near
 * enough, which is why this drives the exit path directly.)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/cli → dist/io/exit.js, the compiled helper the real entry point uses.
const EXIT_MODULE = path.resolve(__dirname, '..', '..', 'dist', 'io', 'exit.js');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'orcaops-backpressure-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Spawn `script`, stall the reader so the pipe fills, then drain it. */
function runWithStalledReader(script: string, stallMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.pause(); // let writes back up into the pipe
    setTimeout(() => {
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stdout.resume();
    }, stallMs);
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
  });
}

function runScript(
  script: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

/** A payload comfortably past any platform's pipe buffer. */
const BIG = 512 * 1024;

describe('flushStdio before process.exit', () => {
  it('fences a pending write that did not arm the drain event', async () => {
    let releasePending: (() => void) | undefined;
    const stream = new Writable({
      highWaterMark: 1024,
      write(_chunk, _encoding, callback) {
        if (releasePending === undefined) {
          releasePending = callback;
          return;
        }
        callback();
      },
    });

    expect(stream.write('pending')).toBe(true);
    expect(stream.writableNeedDrain).toBe(false);
    expect(stream.writableLength).toBeGreaterThan(0);

    let flushed = false;
    const flush = flushWritable(stream).then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);
    expect(stream.listenerCount('error')).toBe(1);

    releasePending?.();
    const completedAfterRelease = await Promise.race([
      flush.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(completedAfterRelease).toBe(true);
    expect(flushed).toBe(true);
    expect(stream.listenerCount('error')).toBe(0);
  });

  it('stops waiting for a write that never completes', async () => {
    let releasePending: (() => void) | undefined;
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        if (releasePending === undefined) {
          releasePending = callback;
          return;
        }
        callback();
      },
    });
    stream.write('pending');

    const startedAt = performance.now();
    await flushWritable(stream);
    const elapsed = performance.now() - startedAt;
    expect(stream.listenerCount('error')).toBe(1);
    releasePending?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(4000);
    expect(stream.listenerCount('error')).toBe(0);
  }, 5000);

  it('absorbs an asynchronous error from the fence write', async () => {
    const script = path.join(dir, 'write-after-end.mjs');
    await writeFile(
      script,
      [
        `import { Writable } from 'node:stream';`,
        `import { flushWritable } from ${JSON.stringify(EXIT_MODULE)};`,
        `const stream = new Writable({ write(_chunk, _encoding, callback) {`,
        `  setTimeout(callback, 20);`,
        `} });`,
        `stream.write('pending');`,
        `stream.end();`,
        `await flushWritable(stream);`,
        `await new Promise((resolve) => setImmediate(resolve));`,
        `process.stdout.write('ok\\n');`,
      ].join('\n')
    );

    const result = await runScript(script);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(result.stderr).toBe('');
  });

  it('delivers a large envelope in full when the reader is slow', async () => {
    const script = path.join(dir, 'with-flush.mjs');
    await writeFile(
      script,
      [
        `import { flushStdio } from ${JSON.stringify(EXIT_MODULE)};`,
        `const payload = JSON.stringify({ ok: true, blob: 'x'.repeat(${BIG}) });`,
        `process.stdout.write(payload + '\\n');`,
        `await flushStdio();`,
        `process.exit(1);`,
      ].join('\n')
    );

    const out = await runWithStalledReader(script, 300);
    const parsed = JSON.parse(out.trim()) as { ok: boolean; blob: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.blob.length).toBe(BIG);
  }, 60_000);

  it('WITHOUT the flush the same payload is truncated — proving the guard is load-bearing', async () => {
    const script = path.join(dir, 'no-flush.mjs');
    await writeFile(
      script,
      [
        `const payload = JSON.stringify({ ok: true, blob: 'x'.repeat(${BIG}) });`,
        `process.stdout.write(payload + '\\n');`,
        `process.exit(1);`,
      ].join('\n')
    );

    const out = await runWithStalledReader(script, 300);
    // The negative control. Without it, the test above would pass on any
    // payload small enough to fit the buffer and prove nothing.
    expect(out.length).toBeLessThan(BIG);
    expect(() => JSON.parse(out.trim())).toThrow();
  }, 60_000);
});
