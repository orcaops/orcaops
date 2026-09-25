import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import { taskUsesRecordAction } from './task-uses.js';
import { CliExit } from '../io/exit.js';

// The account the process runs as is what `processingActor` reads; a machine whose account this
// process cannot describe is the case under test, and no test may depend on the runner's.
vi.mock('../lib/knowledge-processing-actor.js', () => ({
  processingActor: vi.fn(() => ({ changedBy: null, changedByBasis: 'unknown' })),
}));

let stdout: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  stdout = [];
});

async function record(): Promise<{ payload: Record<string, unknown>; failed: boolean }> {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let failed = false;
  try {
    await taskUsesRecordAction({
      artifact: uuidv7(),
      planEvent: uuidv7(),
      identity: `requirement:${uuidv7()}`,
      revision: uuidv7(),
      role: 'preserve',
      discoveredAt: '2026-09-17T10:00:00.000Z',
      discoveredBy: 'the-cto',
      json: true,
    });
  } catch (err) {
    if (!(err instanceof CliExit)) throw err;
    failed = true;
  }
  return { payload: JSON.parse(stdout.join('')) as Record<string, unknown>, failed };
}

describe('orcaops task uses record', () => {
  it('refuses a name it cannot state a basis for, before opening anything for writing', async () => {
    const { payload, failed } = await record();

    expect(failed).toBe(true);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: 'DISCOVERER_NOT_ATTRIBUTABLE' },
    });
    // No project database was resolved, so the refusal cannot have reached a writer: this
    // invocation names a repository that does not exist and still fails on the discoverer.
    expect(String((payload.error as { message: string }).message)).toContain('the-cto');
  });
});
