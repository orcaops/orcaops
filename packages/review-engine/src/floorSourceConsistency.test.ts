import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';

import { FLOOR_PRODUCER_VERSION } from './floor.js';
import { inspectFloorBundle } from './floorSource.js';

const markerFeed = vi.hoisted(() => ({
  bytesForRead: null as ((read: number) => string) | null,
  reads: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (file: unknown, ...rest: unknown[]) => {
    if (markerFeed.bytesForRead !== null && String(file).endsWith('floor-cache.json')) {
      markerFeed.reads += 1;
      return markerFeed.bytesForRead(markerFeed.reads);
    }
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, readFile };
});

const marker = (fingerprint: string): string =>
  JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: fingerprint });

const roots: string[] = [];

async function bundleDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-floor-consistency-'));
  roots.push(root);
  const dir = path.join(root, '.orcaops', 'reviews', 'demo');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'floor.json'),
    JSON.stringify(buildReviewFloorFixture('clean').floor)
  );
  await writeFile(path.join(dir, 'diff.patch'), 'retained diff');
  return root;
}

afterEach(async () => {
  markerFeed.bytesForRead = null;
  markerFeed.reads = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('floor bundle inspection during a concurrent install', () => {
  it('fails closed after the marker changes on both snapshot attempts', async () => {
    const root = await bundleDir();
    markerFeed.bytesForRead = (read) => marker(`fp-${read}`);

    const inspected = await inspectFloorBundle(root, 'demo');

    expect(inspected).toMatchObject({
      status: 'INVALID',
      reason: expect.stringContaining('changed while being inspected'),
      incompatibleMarker: false,
    });
  });

  it('retries a changed marker and accepts the confirmed generation', async () => {
    const root = await bundleDir();
    markerFeed.bytesForRead = (read) => (read === 1 ? marker('fp-old') : marker('fp-new'));

    const inspected = await inspectFloorBundle(root, 'demo');

    expect(inspected).toMatchObject({ status: 'HEALTHY', floorFingerprint: 'fp-new' });
  });
});
