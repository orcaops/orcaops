import Database from 'better-sqlite3';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

import { holdRefTransaction, holdWriteLock } from './support/holders.js';
import {
  compareManifests,
  fileManifest,
  onlyRuntimeCoordination,
  recordManifest,
  rowCounts,
} from './support/manifest.js';
import { measure, noteProcess, scenario, useCeiling } from './support/measurement.js';
import { disposableRoot } from './support/roots.js';
import { seedProject } from './support/seed.js';
import { runCli, runSidecar } from './support/spawn.js';

const file = 'tests/packaged/foundation.test.ts';
const exists = (target: string) =>
  access(target).then(
    () => true,
    () => false
  );

it('separates an authoritative packaged write from SQLite runtime coordination', async () => {
  const record = scenario('manifest oracle self-check', file);
  const root = await disposableRoot('foundation');
  const project = await seedProject(root, { artifacts: 1 });
  const artifactId = project.artifactIds[0]!;

  const beforeFiles = await fileManifest(root.dataDir);
  const beforeRecords = recordManifest(project.databasePath);
  expect(beforeRecords.integrityCheck).toBe('ok');
  expect(beforeRecords.foreignKeyCheck).toEqual([]);

  // Positive control: a packaged public writer must move authoritative rows.
  useCeiling(record, 'cliRunMs');
  const written = await measure(record, 'orcaops checkout (packaged writer)', () =>
    runCli(root, ['checkout', artifactId, '--json'])
  );
  noteProcess(record, 'packaged checkout writer', written.pid!, {
    code: written.code,
    signal: written.signal,
  });
  expect(written.code, written.stderr).toBe(0);
  expect(written.json).toMatchObject({ ok: true, artifact_id: artifactId, action: 'focused' });

  const afterWriteFiles = await fileManifest(root.dataDir);
  const afterWriteRecords = recordManifest(project.databasePath);
  const writeDifference = compareManifests(beforeFiles, afterWriteFiles);
  expect(onlyRuntimeCoordination(writeDifference)).toBe(false);
  expect(afterWriteRecords.tables).not.toEqual(beforeRecords.tables);
  expect(rowCounts(afterWriteRecords).operations).toBeGreaterThan(
    rowCounts(beforeRecords).operations ?? 0
  );

  // Negative control: a passive packaged read must move nothing authoritative.
  // The record manifest is deliberately taken AFTER the second file manifest so
  // the oracle's own readonly open is never mistaken for the scenario's effect.
  const beforeReadFiles = await fileManifest(root.dataDir);
  const read = await measure(record, 'orcaops list (packaged reader)', () =>
    runCli(root, ['list', '--json'])
  );
  noteProcess(record, 'packaged list reader', read.pid!, { code: read.code, signal: read.signal });
  expect(read.code, read.stderr).toBe(0);
  const afterReadFiles = await fileManifest(root.dataDir);
  const readDifference = compareManifests(beforeReadFiles, afterReadFiles);
  expect(onlyRuntimeCoordination(readDifference)).toBe(true);
  expect(recordManifest(project.databasePath).tables).toEqual(afterWriteRecords.tables);

  record.notes.push(
    `passive read moved: ${JSON.stringify({ wal: readDifference.wal, shm: readDifference.shm })}`
  );
}, 60_000);

it('suspends and resumes a real write-lock holder and a real git ref transaction', async () => {
  const record = scenario('holder processes', file);
  const root = await disposableRoot('holders');
  const project = await seedProject(root, { artifacts: 1 });

  const holder = await holdWriteLock(root, project.databasePath);
  noteProcess(record, 'raw BEGIN IMMEDIATE holder', holder.pid);
  expect(holder.pid).toBeGreaterThan(0);
  holder.suspend();
  // A suspended holder still owns the lock: an independent raw writer must be
  // refused rather than take it over.
  const contender = new Database(project.databasePath, { timeout: 0 });
  try {
    expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(
      expect.objectContaining({ code: 'SQLITE_BUSY' })
    );
  } finally {
    contender.close();
  }
  holder.resume();
  expect(await holder.release()).toEqual([0, null]);

  const refHolder = await holdRefTransaction(root, root.repo, 'refs/orcaops/packaged-gate/held');
  noteProcess(record, 'git update-ref --stdin holder', refHolder.pid);
  expect(refHolder.pid).toBeGreaterThan(0);
  const [refCode, refSignal] = await refHolder.commit();
  expect([refCode, refSignal]).toEqual([0, null]);

  await measure(record, 'holder teardown', async () => {
    await root.remove();
  });
  expect(await exists(root.base)).toBe(false);
}, 60_000);

it('runs the compiled sidecar and the packaged CLI against the same disposable roots', async () => {
  const record = scenario('sidecar and cli parity', file);
  const root = await disposableRoot('sidecar');
  await seedProject(root, { artifacts: 1 });

  useCeiling(record, 'cliRunMs');
  const [cli, sidecar] = await measure(record, 'cli and sidecar one-shot', () =>
    Promise.all([
      runCli(root, ['stats', '--json']),
      runSidecar(root, ['--once'], { env: { ORCAOPS_ROOT: root.repo } }),
    ])
  );
  noteProcess(record, 'packaged stats reader', cli.pid!, { code: cli.code, signal: cli.signal });
  noteProcess(record, 'compiled sidecar one-shot', sidecar.pid!, {
    code: sidecar.code,
    signal: sidecar.signal,
  });
  expect(cli.code, cli.stderr).toBe(0);
  expect(cli.json).toMatchObject({ ok: true });
  expect(sidecar.code, sidecar.stderr).toBe(0);
  expect(sidecar.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(sidecar.stdout)).toEqual(expect.objectContaining({}));

  // The pinned environment must not resolve anything under the developer's home.
  for (const value of [root.dataDir, root.configHome, root.globalRoot, root.stateHome])
    expect(path.relative(root.base, value).startsWith('..')).toBe(false);
}, 60_000);
