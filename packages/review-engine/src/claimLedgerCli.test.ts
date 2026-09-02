import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';
import { ArtifactLock } from '@orcaops/storage';

import { runClaimLedger } from './claimLedgerCli.js';
import { FLOOR_PRODUCER_VERSION } from './floor.js';
import { REVIEW_STATE_VERSION, reviewStateLockKey } from './reviewState.js';
import type { ReviewArgs } from './run.js';

describe('claim ledger publication', () => {
  it('refuses to publish when the floor changes while waiting for review state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-ledger-lock-'));
    const floor = buildReviewFloorFixture('clean').floor;
    const branch = floor.scope.branch;
    const slug = floor.scope.branch_slug;
    const dir = path.join(root, '.orcaops', 'reviews', slug);
    const lock = new ArtifactLock({
      locksDir: path.join(root, '.orcaops', 'tmp', 'locks'),
      containmentRoot: root,
    });
    let markAcquired!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'review-state.json'),
        `${JSON.stringify({ review_state_version: REVIEW_STATE_VERSION })}\n`
      );
      await writeFile(path.join(dir, 'floor.json'), JSON.stringify(floor));
      await writeFile(path.join(dir, 'diff.patch'), 'retained diff\n');
      await writeFile(
        path.join(dir, 'floor-cache.json'),
        JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: 'original' })
      );

      const held = lock.withLock(reviewStateLockKey(slug), async () => {
        markAcquired();
        await blocked;
      });
      await acquired;
      const pending = runClaimLedger(
        { cmd: 'review', sub: 'ledger', branch, json: true } as ReviewArgs,
        root
      );
      const state = await Promise.race([
        pending.then(() => 'completed' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100)),
      ]);
      expect(state).toBe('waiting');
      await writeFile(
        path.join(dir, 'floor-cache.json'),
        JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: 'changed' })
      );
      release();
      await held;

      expect(await pending).toBe(1);
      expect(existsSync(path.join(dir, 'ledger-v1.json'))).toBe(false);
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
        'review floor changed while the claim ledger was being built'
      );
    } finally {
      release();
      stdout.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
