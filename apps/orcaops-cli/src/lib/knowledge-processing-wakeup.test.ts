import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import { initializeProjectDatabase, projectDatabasePath } from '@orcaops/storage/history/database';

import {
  wakeProcessingWorker,
  wakeProcessingWorkerForQueue,
} from './knowledge-processing-wakeup.js';
import { WORKER_START_SWITCH } from '../knowledge-worker/start.js';

/**
 * What a committed capture, resume, retry or enablement does about the worker.
 * The CLI suite runs in process, so the kill switch its setup sets is in force
 * here too: these prove the seam's answers, not that a worker really started —
 * `tests/smoke/knowledge-worker.test.ts` proves that with a real process.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function target(enabled = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-wakeup-'));
  roots.push(directory);
  const root = await normalizeHistoryRoot({ root: path.join(directory, 'data') });
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-01T00:00:00.000Z',
    authorize() {},
  });
  handle.close();
  return { repoRoot: directory, authority, enabled };
}

describe('the wake-up a committed change reaches', () => {
  it('says nothing was admitted when a capture admitted nothing', async () => {
    expect(wakeProcessingWorker([], await target())).toEqual({
      signalled: false,
      reason: 'nothing_admitted',
    });
  });

  it('starts nothing for a capture made while processing is off here', async () => {
    const woken = wakeProcessingWorker([{ jobId: 'a' }], await target(false));

    expect(woken).toEqual({ signalled: false, reason: 'processing_off' });
  });

  it('declines while the start switch is off, and says which switch', async () => {
    const woken = wakeProcessingWorker([{ jobId: 'a' }, { jobId: 'b' }], await target());

    expect(woken).toMatchObject({ signalled: false, reason: 'not_started', jobs: 2 });
    if (woken.signalled || woken.reason !== 'not_started') throw new Error('it started one');
    expect(woken.detail).toContain(WORKER_START_SWITCH);
  });

  it('declines a queue wake-up the same way, with no job count', async () => {
    const woken = wakeProcessingWorkerForQueue(await target());

    expect(woken).toMatchObject({ signalled: false, reason: 'not_started', jobs: null });
  });

  it('starts nothing and writes no log while the switch is off', async () => {
    const where = await target();

    wakeProcessingWorkerForQueue(where);

    const log = path.join(
      path.dirname(projectDatabasePath(where.authority)),
      'knowledge-worker.log'
    );
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns its failure instead of throwing into the capture that committed', async () => {
    const broken = {
      get length(): number {
        throw new Error('the admitted jobs could not be read');
      },
    } as unknown as { jobId: string }[];

    expect(wakeProcessingWorker(broken, await target())).toEqual({
      signalled: false,
      reason: 'wake_up_failed',
      message: 'the admitted jobs could not be read',
    });
  });
});
