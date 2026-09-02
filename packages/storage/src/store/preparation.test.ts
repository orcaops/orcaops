import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareArtifactStoreForRead } from './preparation.js';
import { ArtifactStore } from '../artifacts/store.js';
import { getDefaultConfig } from '../schema/config.js';

describe('prepareArtifactStoreForRead', () => {
  let root: string;
  let store: ArtifactStore;
  const config = getDefaultConfig();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-store-prepare-'));
    await mkdir(path.join(root, '.orcaops', 'artifacts'), { recursive: true });
    store = new ArtifactStore({ repoRoot: root, config });
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('rebuilds a pending projection before returning it as healthy', async () => {
    store.store.setProjectionHealth('rebuild_pending');
    expect(store.store.projectionHealth).toBe('rebuild_pending');

    const result = await prepareArtifactStoreForRead({ store });

    expect(result).toMatchObject({
      projectionHealth: 'healthy',
      issue: null,
      reconciliation: { restored: [], removed: [] },
      rebuild: { skipped_artifacts: 0 },
    });
    expect(store.store.projectionHealth).toBe('healthy');
  });

  it('returns degraded health when durable sources cannot be fully rebuilt', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000bd';
    await mkdir(path.join(root, config.artifacts.path, artifactId), { recursive: true });
    store.store.setProjectionHealth('rebuild_pending');

    const result = await prepareArtifactStoreForRead({ store });

    expect(result).toMatchObject({
      projectionHealth: 'degraded',
      issue: null,
      rebuild: { skipped_artifacts: 1 },
    });
    expect(store.store.projectionSkippedArtifacts).toBe(1);
  });

  it('returns a typed issue when protected deletion staging is ambiguous', async () => {
    const stagingRoot = path.join(root, '.orcaops', 'tmp', 'artifact-deletions');
    await mkdir(stagingRoot, { recursive: true });
    await writeFile(path.join(stagingRoot, 'unexpected-file'), 'bytes', 'utf8');

    const result = await prepareArtifactStoreForRead({ store });

    expect(result.projectionHealth).toBe('degraded');
    expect(result.rebuild).toBeNull();
    expect(result.issue).toMatchObject({
      kind: 'deletion_reconciliation_failed',
      message: expect.stringContaining('ambiguous'),
    });
  });
});
