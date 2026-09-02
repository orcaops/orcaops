import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore, getDefaultConfig } from '@orcaops/storage';

import { requireCompleteArtifactStore } from './storePreparation.js';

describe('requireCompleteArtifactStore', () => {
  let root: string;
  let store: ArtifactStore;
  const config = getDefaultConfig();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-store-'));
    await mkdir(path.join(root, '.orcaops', 'artifacts'), { recursive: true });
    store = new ArtifactStore({ repoRoot: root, config });
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('rebuilds a pending projection before authoritative reads', async () => {
    store.store.setProjectionHealth('rebuild_pending');
    const result = await requireCompleteArtifactStore(store, 'review scope');

    expect(result.projectionHealth).toBe('healthy');
    expect(result.rebuild).toMatchObject({ skipped_artifacts: 0 });
  });

  it('refuses a degraded projection with a typed error', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000bd';
    await mkdir(path.join(root, config.artifacts.path, artifactId), { recursive: true });
    store.store.setProjectionHealth('rebuild_pending');

    await expect(requireCompleteArtifactStore(store, 'claim ledger')).rejects.toMatchObject({
      name: 'ReviewProjectionIncompleteError',
      code: 'REVIEW_PROJECTION_INCOMPLETE',
      operation: 'claim ledger',
      preparation: expect.objectContaining({ projectionHealth: 'degraded' }),
    });
  });
});
