import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';

import {
  loadInstalledReview,
  loadReview,
  loadReviewProjections,
  readReviewGenerations,
  ReviewPaneError,
} from './reviewSource';

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

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sidecarFixture(
  options: { published?: boolean; producerFailure?: string; missingAfterProduction?: boolean } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-sidecar-'));
  roots.push(root);
  const sidecarPath = path.join(root, 'sidecar.mjs');
  const callsPath = path.join(root, 'calls.jsonl');
  const publishedPath = path.join(root, 'published');
  const floor = buildReviewFloorFixture('clean').floor;
  const pane = {
    ok: true,
    reviewId: 'review-1',
    floor,
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
  if (options.published) await writeFile(publishedPath, 'published');
  await writeFile(
    sidecarPath,
    `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, root: process.env.ORCAOPS_ROOT, marker: process.env.REVIEW_TEST_MARKER }) + '\\n');
    if (args[1] === 'data') {
      if (${options.producerFailure !== undefined}) {
        process.stderr.write('review data (operation retained-operation): ${options.producerFailure}: publication refused\\n');
        process.exit(1);
      }
      if (!${options.missingAfterProduction === true}) writeFileSync(${JSON.stringify(publishedPath)}, 'published');
      process.stdout.write('floor: pane-review · 1 artifact(s)\\n');
    } else if (!existsSync(${JSON.stringify(publishedPath)})) {
      process.stdout.write(JSON.stringify({ ok: false, code: 'REVIEW_NOT_FOUND' }) + '\\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(${JSON.stringify(JSON.stringify(pane))} + '\\n');
    }
  `
  );
  return {
    opts: {
      root,
      branch: 'pane-review',
      nodeBin: process.execPath,
      sidecarPath,
      env: { ...process.env, REVIEW_TEST_MARKER: 'forwarded' },
    },
    floor,
    calls: async () =>
      (await readFile(callsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { args: string[]; root: string; marker: string }),
  };
}

describe('active review generation', () => {
  it.each([false, true])(
    'produces before reading with an existing publication: %s',
    async (published) => {
      const f = await sidecarFixture({ published });
      const data = await loadReview(f.opts);
      expect((await f.calls()).map((call) => call.args)).toEqual([
        ['review', 'data', '--branch', 'pane-review'],
        ['review', 'pane', '--branch', 'pane-review', '--json'],
      ]);
      expect(data.floor.input_hash).toBe(f.floor.input_hash);
      expect(data.reviewDiff).toBe(diff);
      expect(data.targetsStatus).toEqual({ ok: true });
      expect(data.eligibleTargets).toHaveLength(1);
      expect(data.currentThreads[0]?.rows).toHaveLength(1);
      expect(data.routineStory.status).toBe('absent');
      expect(data.slug).toBe('pane-review');
    }
  );

  it('forwards the base and environment to production without requesting a JSON floor', async () => {
    const f = await sidecarFixture();
    await loadReview({ ...f.opts, base: 'main' });
    expect(await f.calls()).toEqual([
      {
        args: ['review', 'data', '--branch', 'pane-review', '--base', 'main'],
        root: f.opts.root,
        marker: 'forwarded',
      },
      {
        args: ['review', 'pane', '--branch', 'pane-review', '--json'],
        root: f.opts.root,
        marker: 'forwarded',
      },
    ]);
  });

  it.each(['HISTORY_INACCESSIBLE', 'HISTORY_FORMAT_UNSUPPORTED', 'REVIEW_NOT_FOUND'])(
    'preserves %s production diagnostics without reading',
    async (code) => {
      const f = await sidecarFixture({ producerFailure: code });
      await expect(loadReview(f.opts)).rejects.toMatchObject({
        name: 'ReviewDataError',
        code,
        message: expect.stringContaining(
          `review data (operation retained-operation): ${code}: publication refused`
        ),
      });
      expect((await f.calls()).map((call) => call.args[1])).toEqual(['data']);
    }
  );

  it('preserves a missing floor after production without retrying', async () => {
    const f = await sidecarFixture({ missingAfterProduction: true });
    await expect(loadReview(f.opts)).rejects.toMatchObject({
      name: 'ReviewPaneError',
      code: 'REVIEW_NOT_FOUND',
    });
    expect((await f.calls()).map((call) => call.args[1])).toEqual(['data', 'pane']);
  });

  it('preserves a canonical pane failure code from sidecar stdout', async () => {
    const f = await sidecarFixture();
    await writeFile(
      f.opts.sidecarPath,
      `
      if (process.argv[3] === 'data') process.exit(0);
      process.stdout.write(JSON.stringify({ ok: false, code: 'HISTORY_FORMAT_UNSUPPORTED', message: 'Unsupported history format' }) + '\\n');
      process.exitCode = 1;
    `
    );
    await expect(loadReview(f.opts)).rejects.toEqual(
      expect.objectContaining<Partial<ReviewPaneError>>({
        name: 'ReviewPaneError',
        code: 'HISTORY_FORMAT_UNSUPPORTED',
        message: 'Unsupported history format',
      })
    );
  });

  it('does not start production when already cancelled', async () => {
    const f = await sidecarFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(loadReview({ ...f.opts, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    await expect(f.calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['data', 'pane'])(
    'terminates the %s process group when its caller aborts',
    async (verb) => {
      const f = await sidecarFixture();
      const readyPath = path.join(f.opts.root, 'descendant-started');
      const survivorPath = path.join(f.opts.root, 'descendant-survived');
      const callsPath = path.join(f.opts.root, 'verbs');
      const descendant = `
      const { writeFileSync } = require('node:fs');
      setTimeout(() => writeFileSync(${JSON.stringify(survivorPath)}, 'alive'), 250);
    `;
      await writeFile(
        f.opts.sidecarPath,
        `
      import { spawn } from 'node:child_process';
      import { appendFileSync, writeFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(callsPath)}, process.argv[3] + '\\n');
      if (process.argv[3] !== ${JSON.stringify(verb)}) process.exit(0);
      spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(readyPath)}, 'ready');
      setTimeout(() => {}, 60_000);
    `
      );
      const controller = new AbortController();
      const pending = loadReview({ ...f.opts, signal: controller.signal });
      try {
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
        expect(await readFile(callsPath, 'utf8')).toBe(verb === 'data' ? 'data\n' : 'data\npane\n');
      } finally {
        controller.abort();
        await pending.catch(() => {});
      }
    }
  );
});

describe('passive review reads', () => {
  it.each([false, true])('never produces with an existing publication: %s', async (published) => {
    const f = await sidecarFixture({ published });
    if (published) {
      const data = await loadInstalledReview(f.opts);
      expect(data.floor.input_hash).toBe(f.floor.input_hash);
      expect(data.eligibleTargets).toHaveLength(1);
    } else {
      await expect(loadInstalledReview(f.opts)).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    }
    expect((await f.calls()).map((call) => call.args)).toEqual([
      ['review', 'pane', '--branch', 'pane-review', '--json'],
    ]);
  });

  it('only reads change tokens when probing generations', async () => {
    const f = await sidecarFixture({ published: true });
    expect((await readReviewGenerations(f.opts)).bundle).toBe('floor-pub-1');
    expect((await f.calls()).map((call) => call.args)).toEqual([
      ['review', 'pane', '--branch', 'pane-review', '--json', '--generations-only'],
    ]);
  });
});
