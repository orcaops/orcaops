// The stream source keeps child stderr only to format the first 200 characters
// of an exit diagnostic, so retained bytes stay bounded even for a long-lived
// noisy child.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BoundedHeadBuffer, createStreamSource, STDERR_RETAIN_BYTES } from './streamSource';

describe('BoundedHeadBuffer', () => {
  it('retains exactly the cap-length head and stops growing', () => {
    const buffer = new BoundedHeadBuffer(10);
    buffer.append('abcde');
    expect(buffer.head()).toBe('abcde');
    buffer.append('fghijKLMNO');
    expect(buffer.head()).toBe('abcdefghij');
    buffer.append('never-lands');
    expect(buffer.head()).toBe('abcdefghij');
    expect(buffer.head().length).toBe(10);
  });

  it('is a no-op past the cap without re-slicing retained content', () => {
    const buffer = new BoundedHeadBuffer(4);
    buffer.append('wxyz');
    buffer.append('!');
    expect(buffer.head()).toBe('wxyz');
  });
});

describe('createStreamSource exit diagnostics', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-stream-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('preserves the first-200-chars diagnostic from a noisy child under the retention bound', async () => {
    // A stand-in sidecar that spews far more stderr than the retention cap,
    // then exits non-zero. The marker leads, so the expected diagnostic is
    // its first 200 chars regardless of the flood after it.
    const marker = `MARKER-${'d'.repeat(300)}`;
    const sidecar = path.join(tmpRoot, 'noisy.js');
    await writeFile(
      sidecar,
      `
      process.stderr.write(${JSON.stringify(marker)});
      const block = 'y'.repeat(64 * 1024);
      let written = 0;
      const spew = () => {
        for (let i = 0; i < 16; i += 1) { process.stderr.write(block); written += block.length; }
        if (written < ${String(STDERR_RETAIN_BYTES)} * 100) setImmediate(spew);
        else process.exit(7);
      };
      spew();
      `
    );

    const source = createStreamSource({ sidecarPath: sidecar, restartDelayMs: 60_000 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = await new Promise<Error>((resolve) => {
      const stop = source.start({
        onSnapshot: () => undefined,
        onError: (err) => {
          stop();
          resolve(err as Error);
        },
      });
    });

    expect(error.message).toContain('watch sidecar exited (code 7)');
    expect(error.message).toContain(`: ${marker.slice(0, 200)}`);
    expect(vi.getTimerCount()).toBe(0);
  }, 30_000);
});
