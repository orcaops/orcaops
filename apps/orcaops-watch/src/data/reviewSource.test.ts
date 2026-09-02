import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';

import { loadReview, loadReviewProjections } from './reviewSource';
import { ReviewCacheBehindError } from './sidecarError';

const diff = [
  'diff --git a/src/fixture.ts b/src/fixture.ts',
  '--- a/src/fixture.ts',
  '+++ b/src/fixture.ts',
  '@@ -1,0 +1 @@',
  '+stable fixture row',
  '',
].join('\n');

describe('narrative-free deterministic projections', () => {
  it('derives coverage targets directly from floor + diff', async () => {
    const fixture = buildReviewFloorFixture('clean');
    const projections = await loadReviewProjections({
      floor: fixture.floor,
      reviewDiff: diff,
    });

    expect(projections.targetsStatus).toEqual({ ok: true });
    expect(projections.eligibleTargets).toHaveLength(1);
    expect(projections.currentThreads[0]?.rows).toHaveLength(1);
  });

  it('reports an unusable diff instead of presenting unknown rows as healthy', async () => {
    const fixture = buildReviewFloorFixture('clean');
    const projections = await loadReviewProjections({
      floor: fixture.floor,
      reviewDiff: '',
    });

    expect(projections.targetsStatus).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no retained parent hunk in diff.patch'),
    });
    expect(projections.eligibleTargets).toHaveLength(0);
    expect(projections.currentThreads[0]?.rows).toBeNull();
  });
});

describe('active review generation', () => {
  it('returns a typed cache-behind error from the sidecar envelope', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-cache-behind-'));
    const sidecarPath = path.join(root, 'cache-behind-sidecar.mjs');
    await writeFile(
      sidecarPath,
      `
        process.stderr.write(JSON.stringify({
          schema: 'orcaops.watch-sidecar-error/v1',
          code: 'CACHE_BEHIND',
          message: 'cache 23 is behind 24',
          cache_version: 23,
          current_version: 24,
        }) + '\\n');
        process.exitCode = 1;
      `
    );
    try {
      await expect(
        loadReview({ root, branch: 'cold-review', nodeBin: process.execPath, sidecarPath })
      ).rejects.toEqual(
        expect.objectContaining<Partial<ReviewCacheBehindError>>({
          name: 'ReviewCacheBehindError',
          code: 'CACHE_BEHIND',
          cacheVersion: 23,
          currentVersion: 24,
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates the one-shot sidecar process group when its caller aborts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-abort-'));
    const sidecarPath = path.join(root, 'hanging-sidecar.mjs');
    const readyPath = path.join(root, 'descendant-started');
    const survivorPath = path.join(root, 'descendant-survived');
    const descendant = `
      const { writeFileSync } = require('node:fs');
      setTimeout(() => writeFileSync(${JSON.stringify(survivorPath)}, 'alive'), 250);
    `;
    await writeFile(
      sidecarPath,
      `
        import { spawn } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
        writeFileSync(${JSON.stringify(readyPath)}, 'ready');
        setTimeout(() => {}, 60_000);
      `
    );
    const controller = new AbortController();
    try {
      const pending = loadReview({
        root,
        branch: 'cold-review',
        nodeBin: process.execPath,
        sidecarPath,
        signal: controller.signal,
      });
      let descendantStarted = false;
      for (let attempt = 0; attempt < 100 && !descendantStarted; attempt += 1) {
        try {
          await stat(readyPath);
          descendantStarted = true;
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(descendantStarted).toBe(true);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
      if (process.platform !== 'win32') {
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        await expect(stat(survivorPath)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
