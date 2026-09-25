import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';

import {
  readProcessingLease,
  releaseProcessingLease,
  renewProcessingLease,
  takeProcessingLease,
} from './processing-lease.js';
import { later, NOW, processingFixture } from '../../../tests/processing-fixture.js';

const fixtures: { close(): Promise<void> }[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function project() {
  const fixture = await processingFixture();
  fixtures.push(fixture);
  return fixture;
}
const HOUR = 60 * 60 * 1000;
const TERM = 7 * 24 * HOUR;

it('takes a free lease and refuses a second taker while it is held', async () => {
  const fixture = await project();
  expect(readProcessingLease(fixture.handle)).toBeNull();
  const first = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, HOUR),
  });
  expect(first).toEqual({
    outcome: 'taken',
    lease: {
      ownerGeneration: 1,
      ownerId: 'worker-a',
      acquiredAt: NOW,
      renewedAt: NOW,
      expiresAt: later(NOW, HOUR),
    },
  });
  const second = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 60_000),
    expiresAt: later(NOW, HOUR),
  });
  expect(second).toEqual({ outcome: 'held_by_other', lease: first.lease });
  expect(readProcessingLease(fixture.handle)).toEqual(first.lease);
});

it('takes over an expired lease under a strictly later generation', async () => {
  const fixture = await project();
  await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 1000),
  });
  const taken = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });
  expect(taken).toMatchObject({
    outcome: 'taken',
    lease: { ownerGeneration: 2, ownerId: 'worker-b' },
  });
  const again = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-c',
    now: later(NOW, HOUR),
    expiresAt: later(NOW, 2 * HOUR),
  });
  expect(again).toMatchObject({ outcome: 'taken', lease: { ownerGeneration: 3 } });
});

it('renews only as the current owner under the current generation', async () => {
  const fixture = await project();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, HOUR),
  });
  const renewed = await renewProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    generation: lease.ownerGeneration,
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR + 1000),
  });
  expect(renewed).toEqual({
    ownerGeneration: 1,
    ownerId: 'worker-a',
    acquiredAt: NOW,
    renewedAt: later(NOW, 1000),
    expiresAt: later(NOW, HOUR + 1000),
  });
  await expect(
    renewProcessingLease(fixture.handle, {
      maxTermMs: TERM,
      ownerId: 'worker-b',
      generation: lease.ownerGeneration,
      now: later(NOW, 2000),
      expiresAt: later(NOW, HOUR),
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await expect(
    renewProcessingLease(fixture.handle, {
      maxTermMs: TERM,
      ownerId: 'worker-a',
      generation: 2,
      now: later(NOW, 2000),
      expiresAt: later(NOW, HOUR),
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProcessingLease(fixture.handle)).toEqual(renewed);
});

it('releases the lease and keeps the generation moving forward', async () => {
  const fixture = await project();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, HOUR),
  });
  const released = await releaseProcessingLease(fixture.handle, {
    ownerId: 'worker-a',
    generation: lease.ownerGeneration,
  });
  expect(released).toEqual({
    ownerGeneration: 1,
    ownerId: null,
    acquiredAt: null,
    renewedAt: null,
    expiresAt: null,
  });
  await expect(
    releaseProcessingLease(fixture.handle, { ownerId: 'worker-a', generation: 1 })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  const next = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });
  expect(next).toMatchObject({ outcome: 'taken', lease: { ownerGeneration: 2 } });
});

it('gives the lease to exactly one of two racing connections', async () => {
  const fixture = await project();
  const other = await fixture.open('writer');
  const input = { now: NOW, expiresAt: later(NOW, HOUR) };
  const results = await Promise.all([
    takeProcessingLease(fixture.handle, { maxTermMs: TERM, ...input, ownerId: 'worker-a' }),
    takeProcessingLease(other, { maxTermMs: TERM, ...input, ownerId: 'worker-b' }),
  ]);
  expect(results.filter((result) => result.outcome === 'taken')).toHaveLength(1);
  const winner = results.find((result) => result.outcome === 'taken')!;
  expect(readProcessingLease(fixture.handle)).toEqual(winner.lease);
  expect(readProcessingLease(other)).toEqual(winner.lease);
});

it('gives the lease to exactly one of two racing processes', async () => {
  const fixture = await project();
  const driver = createRequire(import.meta.url).resolve('better-sqlite3');
  const expiresAt = later(NOW, HOUR);
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], { timeout: 2000 });
    const now = process.argv[3];
    const expires = process.argv[4];
    process.send('ready');
    process.on('message', () => {
      let took = false;
      let generation = null;
      try {
        db.exec('BEGIN IMMEDIATE');
        const row = db.prepare('SELECT owner_generation, owner_id, expires_at FROM processing_lease WHERE singleton=1').get();
        if (!row || row.owner_id === null || row.expires_at <= now) {
          generation = (row ? row.owner_generation : 0) + 1;
          if (row)
            db.prepare('UPDATE processing_lease SET owner_generation=?, owner_id=?, acquired_at=?, renewed_at=?, expires_at=? WHERE singleton=1').run(generation, 'worker-child', now, now, expires);
          else
            db.prepare('INSERT INTO processing_lease VALUES (1,?,?,?,?,?)').run(generation, 'worker-child', now, now, expires);
          took = true;
        }
        db.exec('COMMIT');
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        process.send({ failure: String(error) });
        db.close();
        process.exit(0);
      }
      process.send({ took, generation });
      db.close();
      process.exit(0);
    });
  `,
      driver,
      fixture.databasePath,
      NOW,
      expiresAt,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  children.push(child);
  expect(await once(child, 'message')).toEqual(['ready', undefined]);
  child.send('go');
  const [mine, theirs] = await Promise.all([
    takeProcessingLease(fixture.handle, {
      maxTermMs: TERM,
      ownerId: 'worker-parent',
      now: NOW,
      expiresAt,
    }),
    once(child, 'message') as Promise<[{ took: boolean; generation: number | null }, unknown]>,
  ]);
  expect([mine.outcome === 'taken', theirs[0].took].filter(Boolean)).toHaveLength(1);
  const lease = readProcessingLease(fixture.handle)!;
  expect(lease.ownerGeneration).toBe(1);
  expect(lease.ownerId).toBe(mine.outcome === 'taken' ? 'worker-parent' : 'worker-child');
  expect(mine.lease).toEqual(lease);
});

it('writes no operation receipt and moves neither project counter', async () => {
  const fixture = await project();
  await fixture.capture();
  const before = fixture.snapshot();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, HOUR),
  });
  await renewProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    generation: lease.ownerGeneration,
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });
  await releaseProcessingLease(fixture.handle, { ownerId: 'worker-a', generation: 1 });
  const after = fixture.snapshot();
  expect(after.operations).toEqual(before.operations);
  expect(after.writeSequence).toBe(before.writeSequence);
  expect(after.intentChangeCounter).toBe(before.intentChangeCounter);
  expect(after.jobs).toEqual(before.jobs);
});

it('reads the lease through a read-only connection without writing', async () => {
  const fixture = await project();
  await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, HOUR),
  });
  const reader = await fixture.open('reader');
  const before = fixture.snapshot();
  expect(readProcessingLease(reader)).toMatchObject({ ownerId: 'worker-a', ownerGeneration: 1 });
  await expect(
    takeProcessingLease(reader, {
      maxTermMs: TERM,
      ownerId: 'worker-b',
      now: later(NOW, HOUR),
      expiresAt: later(NOW, 2 * HOUR),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
  expect(fixture.snapshot()).toEqual(before);
});

it('refuses a lease that expires before it is taken', async () => {
  const fixture = await project();
  await expect(
    takeProcessingLease(fixture.handle, {
      maxTermMs: TERM,
      ownerId: 'worker-a',
      now: NOW,
      expiresAt: NOW,
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    takeProcessingLease(fixture.handle, {
      maxTermMs: TERM,
      ownerId: 'worker-a',
      now: NOW,
      expiresAt: '2026-09-01',
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(readProcessingLease(fixture.handle)).toBeNull();
});

it('refuses a lease term longer than the ceiling its caller allows', async () => {
  const fixture = await project();
  const century = later(NOW, 100 * 365 * 24 * HOUR);
  await expect(
    takeProcessingLease(fixture.handle, {
      ownerId: 'runaway',
      now: NOW,
      expiresAt: century,
      maxTermMs: 30_000,
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(readProcessingLease(fixture.handle)).toBeNull();
  const { lease } = await takeProcessingLease(fixture.handle, {
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 30_000),
    maxTermMs: 30_000,
  });
  await expect(
    renewProcessingLease(fixture.handle, {
      ownerId: 'worker-a',
      generation: lease.ownerGeneration,
      now: later(NOW, 1000),
      expiresAt: century,
      maxTermMs: 30_000,
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(readProcessingLease(fixture.handle)).toEqual(lease);
  // A bounded term is what makes expiry the break: the next taker only has to wait it out.
  expect(
    await takeProcessingLease(fixture.handle, {
      ownerId: 'worker-b',
      now: later(NOW, 30_000),
      expiresAt: later(NOW, 60_000),
      maxTermMs: 30_000,
    })
  ).toMatchObject({ outcome: 'taken', lease: { ownerGeneration: 2 } });
});
