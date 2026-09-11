import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readReviewGenerations } from './reviewSource';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A stand-in sidecar that answers `review pane --generations-only` with a fixed
 * envelope. The generation tokens are the review's retained selection versions,
 * so the Watch boundary only maps them; the store behaviour that produces them
 * is proven in the engine's captured-review control.
 */
async function fakeSidecar(generations: Record<string, string | null>): Promise<{
  root: string;
  sidecarPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-generations-'));
  roots.push(root);
  const sidecarPath = path.join(root, 'sidecar.mjs');
  await writeFile(
    sidecarPath,
    `process.stdout.write(JSON.stringify({ ok: true, generations: ${JSON.stringify(generations)} }) + '\\n');\n`
  );
  return { root, sidecarPath };
}

describe('review generations — canonical selection tokens', () => {
  it('maps the retained selection versions onto the invalidation tokens', async () => {
    const { root, sidecarPath } = await fakeSidecar({
      floor: 'floor-pub-1',
      story: 'gen-1',
      storyInstallation: 'run-1',
      storyAnchors: 'anchor-1',
      comments: '2:5',
      workflow: '7',
    });
    const generations = await readReviewGenerations({
      root,
      branch: 'probe',
      nodeBin: process.execPath,
      sidecarPath,
    });
    expect(generations).toEqual({
      bundle: 'floor-pub-1',
      story: 'gen-1',
      storyInstallation: 'run-1',
      storyAnchors: 'anchor-1',
      journal: '7',
      comments: '2:5',
    });
  });

  it('separates Story content generation from run installation identity', async () => {
    const sameContentNewRun = await fakeSidecar({
      floor: 'floor-pub-1',
      story: 'gen-1',
      storyInstallation: 'run-2',
      storyAnchors: null,
      comments: '0:0',
      workflow: '3',
    });
    const generations = await readReviewGenerations({
      root: sameContentNewRun.root,
      branch: 'probe',
      nodeBin: process.execPath,
      sidecarPath: sameContentNewRun.sidecarPath,
    });
    // Same Story content, different run: the content token holds while the
    // installation token moves, so anchors refresh without re-reading the Story.
    expect(generations.story).toBe('gen-1');
    expect(generations.storyInstallation).toBe('run-2');
    expect(generations.storyAnchors).toBeNull();
  });

  it('carries null tokens for a review with no floor, comments or workflow yet', async () => {
    const { root, sidecarPath } = await fakeSidecar({
      floor: 'floor-pub-1',
      story: null,
      storyInstallation: null,
      storyAnchors: null,
      comments: '0:0',
      workflow: '0',
    });
    const generations = await readReviewGenerations({
      root,
      branch: 'probe',
      nodeBin: process.execPath,
      sidecarPath,
    });
    expect(generations.story).toBeNull();
    expect(generations.storyInstallation).toBeNull();
    expect(generations.journal).toBe('0');
  });
});
