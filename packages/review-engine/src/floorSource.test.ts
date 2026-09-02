import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';

import { FLOOR_PRODUCER_VERSION } from './floor.js';
import { inspectFloorBundle, loadHealthyFloorSource } from './floorSource.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('healthy floor source', () => {
  it('requires the committed floor-cache health marker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-floor-source-'));
    roots.push(root);
    const floor = buildReviewFloorFixture('clean').floor;
    const dir = path.join(root, '.orcaops', 'reviews', 'demo');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'floor.json'), JSON.stringify(floor));
    await writeFile(path.join(dir, 'diff.patch'), 'retained diff');

    await expect(loadHealthyFloorSource(root, 'demo')).rejects.toThrow('no healthy floor');
    await writeFile(
      path.join(dir, 'floor-cache.json'),
      JSON.stringify({ producerVersion: 'stale-producer', floorFingerprint: 'fp' })
    );
    await expect(loadHealthyFloorSource(root, 'demo')).rejects.toThrow('health gate failed');
    await writeFile(
      path.join(dir, 'floor-cache.json'),
      JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: 'fp' })
    );
    await expect(loadHealthyFloorSource(root, 'demo')).resolves.toMatchObject({
      diffText: 'retained diff',
      floorFingerprint: 'fp',
      floor: { input_hash: floor.input_hash },
    });
  });

  it('inspection reports HEALTHY exactly when the loader accepts the directory', async () => {
    const floor = buildReviewFloorFixture('clean').floor;
    const marker = JSON.stringify({
      producerVersion: FLOOR_PRODUCER_VERSION,
      floorFingerprint: 'fp',
    });
    const bundles: Record<string, Record<string, string>> = {
      healthy: {
        'floor.json': JSON.stringify(floor),
        'diff.patch': 'retained diff',
        'floor-cache.json': marker,
      },
      markerless: { 'floor.json': JSON.stringify(floor), 'diff.patch': 'retained diff' },
      incompatibleMarker: {
        'floor.json': JSON.stringify(floor),
        'diff.patch': 'retained diff',
        'floor-cache.json': JSON.stringify({ producerVersion: 'stale', floorFingerprint: 'fp' }),
      },
      missingDiff: { 'floor.json': JSON.stringify(floor), 'floor-cache.json': marker },
      empty: {},
    };

    for (const [name, files] of Object.entries(bundles)) {
      const root = await mkdtemp(path.join(tmpdir(), 'orcaops-floor-parity-'));
      roots.push(root);
      const dir = path.join(root, '.orcaops', 'reviews', 'demo');
      await mkdir(dir, { recursive: true });
      for (const [file, content] of Object.entries(files)) {
        await writeFile(path.join(dir, file), content);
      }
      const inspected = await inspectFloorBundle(root, 'demo');
      const loaderAccepted = await loadHealthyFloorSource(root, 'demo').then(
        () => true,
        () => false
      );
      expect(inspected.status === 'HEALTHY', `${name}: inspector vs loader`).toBe(loaderAccepted);
      expect(inspected.status, name).toBe(
        name === 'healthy' ? 'HEALTHY' : name === 'empty' ? 'ABSENT' : 'INVALID'
      );
    }
  });
});
