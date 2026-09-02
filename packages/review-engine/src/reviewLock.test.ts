import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REVIEW_LOCK_HEARTBEAT_MS, reviewLock } from './reviewLock.js';

describe('Review locks', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-lock-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('heartbeats before the stale threshold', () => {
    const lock = reviewLock(root);

    expect(lock.options.heartbeatIntervalMs).toBe(REVIEW_LOCK_HEARTBEAT_MS);
    expect(lock.options.heartbeatIntervalMs).toBeLessThan(lock.options.staleThresholdMs);
  });
});
