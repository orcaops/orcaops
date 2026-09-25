import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import * as store from '@orcaops/storage/history/database';
import { createTempRepo } from '@orcaops/test-harness';

import { runDatabaseReviewPane } from './pane-command.js';

vi.mock('@orcaops/storage/history/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@orcaops/storage/history/database')>()),
  openProjectDatabase: vi.fn(
    (await importOriginal<typeof import('@orcaops/storage/history/database')>()).openProjectDatabase
  ),
}));

const cleanups: Array<() => Promise<void>> = [];

interface RawDatabase {
  pragma(sql: string): unknown;
  close(): void;
}

function loadStorageSqlite(): new (file: string) => RawDatabase {
  const require = createRequire(import.meta.resolve('@orcaops/storage/history/database'));
  return require('better-sqlite3') as new (file: string) => RawDatabase;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('emits a newer-format canonical database failure without writing history', async () => {
  const repo = await createTempRepo({ initialBranch: 'main' });
  cleanups.push(repo.cleanup);
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-review-pane-'));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const setup = await setupProjectDatabase({
    cwd: repo.path,
    root: dataRoot,
    authoredPayloads: [],
    secretAllow: [],
  });
  const databasePath = store.projectDatabasePath(setup.initialization.authority);
  const Database = loadStorageSqlite();
  const raw = new Database(databasePath);
  raw.pragma('user_version = 200');
  raw.close();

  const beforeBytes = await readFile(databasePath);
  vi.mocked(store.openProjectDatabase).mockClear();
  let stdout = '';
  vi.stubEnv('ORCAOPS_DATA_DIR', dataRoot);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });

  expect(await runDatabaseReviewPane({ branch: 'main' }, repo.path)).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({
    ok: false,
    code: 'HISTORY_FORMAT_NEWER',
    message: expect.stringContaining('written by a newer build'),
  });
  expect((await readFile(databasePath)).equals(beforeBytes)).toBe(true);
  expect(store.openProjectDatabase).toHaveBeenCalled();
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([input]) => input.mode === 'reader')
  ).toBe(true);
});
