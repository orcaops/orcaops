import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { openEmptyArtifactStore } from './empty-projection.js';
import { getDefaultConfig } from '../schema/config.js';

describe('openEmptyArtifactStore', () => {
  it('closes its in-memory store exactly once', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-empty-projection-'));
    try {
      const artifacts = openEmptyArtifactStore(root, getDefaultConfig());
      const close = vi.spyOn(artifacts.store, 'close');

      artifacts.close();
      artifacts.close();

      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
