import Database from 'better-sqlite3';
import { rm } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';

import { projectDatabasePath } from '@orcaops/storage/history/database';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
function agent(f: Fixture) {
  return makeAgent({ cwd: f.main, env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' } });
}

it('restores damaged query and search rows without changing retained facts or counters', async () => {
  const f = await fixture();
  const id = await f.capture();
  const before = await inventory(f.temporary);
  const db = new Database(projectDatabasePath(f.authority));
  try {
    db.exec(
      'DELETE FROM artifact_metadata; DELETE FROM artifact_query_metadata; DELETE FROM artifact_search_sources; DELETE FROM artifact_search_state;'
    );
  } finally {
    db.close();
  }
  const damaged = await inventory(f.temporary);
  await agent(f).runRaw(['list', '--json']);
  expect(await inventory(f.temporary)).toEqual(damaged);
  const rebuilt = await agent(f).runRaw(['rebuild', '--json']);
  expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
  expect(JSON.parse(rebuilt.stdout)).toMatchObject({
    artifacts: 1,
    executions: 1,
    skipped_artifacts: 0,
  });
  expect(await inventory(f.temporary)).toEqual(before);
  const shown = await agent(f).runRaw(['show', id, '--json']);
  expect(shown.exitCode, shown.stdout + shown.stderr).toBe(0);
  const replay = await agent(f).runRaw(['rebuild']);
  expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
  expect(replay.stdout).toContain('Rebuilt project query and search indexes');
  expect(await inventory(f.temporary)).toEqual(before);
});

it('does not recreate missing expected history', async () => {
  const f = await fixture();
  f.writer.close();
  await rm(projectDatabasePath(f.authority));
  const before = await inventory(f.temporary);
  const result = await agent(f).runRaw(['rebuild', '--json']);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe('HISTORY_MISSING');
  expect(await inventory(f.temporary)).toEqual(before);
});

it('cancels a named writer wait without publishing indexes', async () => {
  const f = await fixture();
  await f.capture();
  const before = await inventory(f.temporary);
  const db = new Database(projectDatabasePath(f.authority));
  db.exec('BEGIN IMMEDIATE');
  const original = process.stderr.write.bind(process.stderr);
  let observed = false;
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((...args) => {
    if (String(args[0]).includes('Waiting to rebuild project indexes')) {
      observed = true;
      process.emit('SIGINT');
    }
    return original(...args);
  });
  try {
    const result = await agent(f).runRaw(['rebuild', '--json']);
    expect(observed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('CANCELLED');
  } finally {
    spy.mockRestore();
    db.exec('ROLLBACK');
    db.close();
  }
  expect(await inventory(f.temporary)).toEqual(before);
});
