import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectDurableReviewState } from './durableState.js';
import { ensureReviewStateVersion } from './reviewState.js';

describe('retired review leftovers', () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root !== null) await rm(root, { recursive: true, force: true });
  });

  it('ignores stray composition files during durable-state health checks', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-retired-review-'));
    const reviewDir = path.join(root, '.orcaops', 'reviews', 'demo');
    await ensureReviewStateVersion(reviewDir, root);
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, 'compose-session-v1.json'), '{broken session');
    await writeFile(path.join(reviewDir, 'narrative.json'), '{broken narrative');

    const health = await inspectDurableReviewState(root, 'demo');

    expect(health.status).toBe('HEALTHY');
    expect(health.states.map((state) => state.kind)).toEqual([
      'REVIEW_STATE',
      'FLOOR',
      'STORY',
      'COMMENTS',
      'JOURNAL',
    ]);
  });
});
