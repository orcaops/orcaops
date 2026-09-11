import { afterEach, expect, it, vi } from 'vitest';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { createDatabaseResumeAction } from '../../src/commands/resume.js';
import { resolveDatabaseHistoryCommandContext } from '../../src/lib/database-history-context.js';
import { fixture, inventory } from '../helpers/database-history.js';

afterEach(() => vi.restoreAllMocks());
async function context(f: Awaited<ReturnType<typeof fixture>>) {
  return resolveDatabaseHistoryCommandContext({
    profile: 'resume',
    cwd: f.main,
    checkoutRoot: f.main,
    dataRoot: f.root,
    env: {},
  });
}

it('retains the original artifact and output choices across asynchronous context resolution', async () => {
  const f = await fixture();
  const original = await f.capture();
  const later = await f.capture();
  const c = await context(f);
  const before = await inventory(f.temporary);
  const copy = vi.fn(async () => true);
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const options = { artifact: original, json: true, copy: false };
  const action = createDatabaseResumeAction({
    openContext: async () => {
      await Promise.resolve();
      return c;
    },
    copy,
  });
  try {
    const pending = action(options);
    options.artifact = later;
    options.json = false;
    options.copy = true;
    await pending;
    const result = JSON.parse(String(stdout.mock.calls[0][0]));
    expect(result.artifact_id).toBe(original);
    expect(result.artifact.copied).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledOnce();
    expect(await inventory(f.temporary)).toEqual(before);
  } finally {
    c.scope.close();
  }
}, 30_000);

it('does not copy or publish successful output after reader cleanup fails', async () => {
  const f = await fixture();
  const id = await f.capture();
  const c = await context(f);
  const before = await inventory(f.temporary);
  const copy = vi.fn(async () => true);
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const action = createDatabaseResumeAction({
    openContext: async () => ({
      ...c,
      scope: {
        ...c.scope,
        close() {
          c.scope.close();
          throw new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Original reader cleanup failure');
        },
      },
    }),
    copy,
  });
  try {
    await expect(action({ artifact: id, json: true, copy: true })).rejects.toMatchObject({
      code: 1,
    });
    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0][0])).error.code).toBe('HISTORY_INACCESSIBLE');
    expect(copy).not.toHaveBeenCalled();
    expect(await inventory(f.temporary)).toEqual(before);
  } finally {
    c.scope.close();
  }
}, 30_000);

it('copies the explicit original prompt only after the selected reader closes', async () => {
  const f = await fixture();
  const id = await f.capture(undefined, { task: 'Retain original copied prompt' });
  const c = await context(f);
  const before = await inventory(f.temporary);
  let closed = false;
  const copy = vi.fn(async (text: string) => {
    expect(closed).toBe(true);
    expect(text).toContain('Retain original copied prompt');
    return true;
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const action = createDatabaseResumeAction({
    openContext: async () => ({
      ...c,
      scope: {
        ...c.scope,
        close() {
          c.scope.close();
          closed = true;
        },
      },
    }),
    copy,
  });
  try {
    await action({ artifact: id, json: true, copy: true });
    expect(copy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0][0])).artifact.copied).toBe(true);
    expect(await inventory(f.temporary)).toEqual(before);
  } finally {
    c.scope.close();
  }
}, 30_000);
