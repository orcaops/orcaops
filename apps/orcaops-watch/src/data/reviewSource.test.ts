import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';

import { loadReview, loadReviewProjections, ReviewPaneError } from './reviewSource';

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
  it('preserves a canonical pane failure code from sidecar stdout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-format-unsupported-'));
    const sidecarPath = path.join(root, 'format-unsupported-sidecar.mjs');
    await writeFile(
      sidecarPath,
      `
        process.stdout.write(JSON.stringify({
          ok: false,
          code: 'HISTORY_FORMAT_UNSUPPORTED',
          message: 'This database needs an explicitly supported schema upgrade or repair',
        }) + '\\n');
        process.exitCode = 1;
      `
    );
    try {
      await expect(
        loadReview({ root, branch: 'cold-review', nodeBin: process.execPath, sidecarPath })
      ).rejects.toEqual(
        expect.objectContaining<Partial<ReviewPaneError>>({
          name: 'ReviewPaneError',
          code: 'HISTORY_FORMAT_UNSUPPORTED',
          message: 'This database needs an explicitly supported schema upgrade or repair',
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
  it('loads a review from the canonical pane envelope the sidecar emits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-pane-'));
    const fixture = buildReviewFloorFixture('clean');
    const sidecarPath = path.join(root, 'pane-sidecar.mjs');
    const pane = {
      ok: true,
      reviewId: 'review-1',
      floor: fixture.floor,
      diff,
      routineStory: {
        model: null,
        status: 'absent',
        issue: null,
        runId: null,
        generation: null,
        anchors: { model: null, status: 'absent', issue: null, generation: null },
      },
      generations: {
        floor: 'floor-pub-1',
        story: null,
        storyInstallation: null,
        storyAnchors: null,
        comments: '0:0',
        workflow: '0',
      },
    };
    await writeFile(
      sidecarPath,
      `process.stdout.write(${JSON.stringify(JSON.stringify(pane))} + '\\n');\n`
    );
    try {
      const data = await loadReview({
        root,
        branch: 'pane-review',
        nodeBin: process.execPath,
        sidecarPath,
      });
      expect(data.floor.input_hash).toBe(fixture.floor.input_hash);
      expect(data.reviewDiff).toBe(diff);
      expect(data.targetsStatus).toEqual({ ok: true });
      expect(data.eligibleTargets).toHaveLength(1);
      expect(data.currentThreads[0]?.rows).toHaveLength(1);
      expect(data.routineStory.status).toBe('absent');
      expect(data.slug).toBe('pane-review');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces a not-yet-published review as an error rather than a floorless pane', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-absent-'));
    const sidecarPath = path.join(root, 'absent-sidecar.mjs');
    await writeFile(
      sidecarPath,
      `process.stdout.write(JSON.stringify({ ok: false, code: 'REVIEW_NOT_FOUND' }) + '\\n'); process.exitCode = 1;\n`
    );
    try {
      await expect(
        loadReview({ root, branch: 'unpublished', nodeBin: process.execPath, sidecarPath })
      ).rejects.toThrow(/REVIEW_NOT_FOUND|review pane/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
