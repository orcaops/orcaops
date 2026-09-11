import { copyFile, rm, stat } from 'node:fs/promises';
import { expect, it } from 'vitest';

import {
  authoritativelyUnchanged,
  compareEnvironments,
  environmentManifest,
  nothingAuthoritativeMoved,
} from './support/environment.js';
import { holdWriteLock } from './support/holders.js';
import { recordManifest } from './support/manifest.js';
import { measure, noteProcess, scenario, useCeiling } from './support/measurement.js';
import { disposableRoot } from './support/roots.js';
import { seedProject } from './support/seed.js';
import { runCli, runSidecar, startSidecar } from './support/spawn.js';

const file = 'tests/packaged/passive.test.ts';

/**
 * Collects every diagnostic code a packaged envelope carries, at any depth. The
 * readers report unavailable history inside a completeness section rather than by
 * exiting non-zero, so "refuses" has to be read off the envelope, not the code.
 */
function diagnostics(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (/^[A-Z][A-Z_]{3,}$/.test(value) || value === 'unavailable') found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) diagnostics(entry, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) diagnostics(entry, found);
  }
  return found;
}

/** Packaged readers already ported to the project database at this base. */
const packagedReaders = [
  ['list', ['list', '--json']],
  ['stats', ['stats', '--json']],
  ['status', ['status', '--json']],
  ['search', ['search', 'packaged', '--json']],
] as const;

it('refuses every packaged reader and writer when the registered database is deleted', async () => {
  const record = scenario('deleted registered database', file);
  const root = await disposableRoot('passive-deleted');
  const project = await seedProject(root, { artifacts: 1 });
  const artifactId = project.artifactIds[0]!;

  // Positive control: each reader and the writer work against the healthy store.
  for (const [name, args] of packagedReaders) {
    const healthy = await runCli(root, [...args]);
    expect(healthy.code, `${name}: ${healthy.stderr}`).toBe(0);
  }
  const healthySidecar = await runSidecar(root, ['--once']);
  expect(healthySidecar.code, healthySidecar.stderr).toBe(0);

  for (const suffix of ['', '-wal', '-shm'])
    await rm(`${project.databasePath}${suffix}`, { force: true });
  const before = await environmentManifest(root);

  for (const [name, args] of packagedReaders) {
    const refused = await measure(record, `${name} against a deleted database`, () =>
      runCli(root, [...args])
    );
    noteProcess(record, `${name} refusal`, refused.pid!, {
      code: refused.code,
      signal: refused.signal,
    });
    const reported = diagnostics(refused.json ?? refused.stdout);
    record.notes.push(`${name}: exit ${refused.code}; reported ${[...reported].join(', ')}`);
    expect([...reported], `${name} must report the missing history`).toEqual(
      expect.arrayContaining(['HISTORY_MISSING', 'unavailable'])
    );
  }
  const refusedWrite = await measure(record, 'checkout against a deleted database', () =>
    runCli(root, ['checkout', artifactId, '--json'])
  );
  noteProcess(record, 'checkout refusal', refusedWrite.pid!, {
    code: refusedWrite.code,
    signal: refusedWrite.signal,
  });
  expect(refusedWrite.code).toBe(1);
  expect(refusedWrite.json).toMatchObject({ ok: false });
  const refusedSidecar = await measure(record, 'sidecar against a deleted database', () =>
    runSidecar(root, ['--once'])
  );
  noteProcess(record, 'sidecar refusal', refusedSidecar.pid!, {
    code: refusedSidecar.code,
    signal: refusedSidecar.signal,
  });
  record.notes.push(`sidecar: exit ${refusedSidecar.code} ${refusedSidecar.stderr.slice(0, 200)}`);

  // Nothing was replaced anywhere in the environment: no main database, WAL, SHM,
  // directory, marker, temp file, cache, session state or publication ref.
  const difference = compareEnvironments(before, await environmentManifest(root));
  expect(authoritativelyUnchanged(difference)).toEqual(nothingAuthoritativeMoved);
  expect(difference.data.wal).toEqual({ created: [], removed: [], changed: [] });
  expect(difference.data.shm).toEqual({ created: [], removed: [], changed: [] });
  await expect(stat(project.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a substituted store instance without adopting or replacing it', async () => {
  const record = scenario('substituted store instance', file);
  const root = await disposableRoot('passive-substituted');
  const project = await seedProject(root, { artifacts: 1 });
  const stranger = await disposableRoot('passive-stranger');
  const other = await seedProject(stranger, { artifacts: 1 });

  // Positive control: every reader answers this store while it is the registered
  // instance, so the refusals below are about the substitution and not about the
  // readers being inert in this fixture.
  for (const [name, args] of packagedReaders) {
    const healthy = await runCli(root, [...args]);
    expect(healthy.code, `${name}: ${healthy.stderr}`).toBe(0);
    expect(diagnostics(healthy.json ?? healthy.stdout).has('AUTHORITY_MISMATCH')).toBe(false);
  }

  const original = recordManifest(project.databasePath);
  for (const suffix of ['-wal', '-shm'])
    await rm(`${project.databasePath}${suffix}`, { force: true });
  await copyFile(other.databasePath, project.databasePath);
  const before = await environmentManifest(root);

  for (const [name, args] of packagedReaders) {
    const refused = await measure(record, `${name} against a substituted instance`, () =>
      runCli(root, [...args])
    );
    noteProcess(record, `${name} refusal`, refused.pid!, {
      code: refused.code,
      signal: refused.signal,
    });
    const reported = diagnostics(refused.json ?? refused.stdout);
    record.notes.push(`${name}: exit ${refused.code}; reported ${[...reported].join(', ')}`);
    expect([...reported], `${name} must report the wrong instance`).toEqual(
      expect.arrayContaining(['AUTHORITY_MISMATCH', 'unavailable'])
    );
  }

  // Only SQLite's own runtime coordination moved anywhere in the environment; the
  // substituted main database bytes and the stranger's rows are untouched, and
  // nothing was initialized, cached or published.
  const difference = compareEnvironments(before, await environmentManifest(root));
  expect(authoritativelyUnchanged(difference)).toEqual(nothingAuthoritativeMoved);
  expect(recordManifest(project.databasePath).tables).toEqual(
    recordManifest(other.databasePath).tables
  );
  expect(recordManifest(project.databasePath).tables).not.toEqual(original.tables);
});

it('reads through a readonly WAL open with the runtime companions missing', async () => {
  const record = scenario('missing WAL and SHM companions', file);
  const root = await disposableRoot('passive-companions');
  const project = await seedProject(root, { artifacts: 1 });

  const settled = recordManifest(project.databasePath);
  for (const suffix of ['-wal', '-shm'])
    await rm(`${project.databasePath}${suffix}`, { force: true });
  const before = await environmentManifest(root);
  expect(Object.keys(before.data).some((name) => name.endsWith('-wal'))).toBe(false);

  const read = await measure(record, 'packaged reader with no WAL or SHM', () =>
    runCli(root, ['list', '--json'])
  );
  noteProcess(record, 'packaged reader', read.pid!, { code: read.code, signal: read.signal });
  expect(read.code, read.stderr).toBe(0);
  const sidecar = await measure(record, 'compiled sidecar with no WAL or SHM', () =>
    runSidecar(root, ['--once'])
  );
  noteProcess(record, 'compiled sidecar', sidecar.pid!, {
    code: sidecar.code,
    signal: sidecar.signal,
  });
  expect(sidecar.code, sidecar.stderr).toBe(0);

  // SQLite may recreate its runtime companions; the authoritative main database
  // bytes and rows must not move, and nothing else anywhere may be created.
  const difference = compareEnvironments(before, await environmentManifest(root));
  expect(authoritativelyUnchanged(difference)).toEqual(nothingAuthoritativeMoved);
  expect(recordManifest(project.databasePath).tables).toEqual(settled.tables);
  record.notes.push(
    `runtime coordination: ${JSON.stringify({
      wal: difference.data.wal,
      shm: difference.data.shm,
    })}`
  );
});

it('keeps packaged readers and the streaming sidecar responsive against a suspended writer', async () => {
  const record = scenario('passive reads beside a suspended writer', file);
  const root = await disposableRoot('passive-suspended');
  const project = await seedProject(root, { artifacts: 1 });

  const sidecar = startSidecar(root, []);
  noteProcess(record, 'streaming sidecar', sidecar.pid);
  await sidecar.waitForLine(() => true, useCeiling(record, 'sidecarFirstSnapshotMs'));

  const settled = recordManifest(project.databasePath);
  const holder = await holdWriteLock(root, project.databasePath);
  noteProcess(record, 'suspended BEGIN IMMEDIATE holder', holder.pid);
  holder.suspend();
  // Consume every snapshot the sidecar has already published, so the one waited
  // for below was produced while the write lock was held.
  const publishedBeforeSuspension = sidecar.drainLines();
  const before = await environmentManifest(root);

  for (const [name, args] of packagedReaders) {
    const read = await measure(record, `${name} beside a suspended writer`, () =>
      runCli(root, [...args])
    );
    noteProcess(record, `${name} read`, read.pid!, { code: read.code, signal: read.signal });
    expect(read.code, `${name}: ${read.stderr}`).toBe(0);
  }
  const duringSuspension = await measure(record, 'sidecar snapshot during suspension', () =>
    sidecar.waitForLine(() => true, useCeiling(record, 'sidecarFirstSnapshotMs'))
  );
  expect(duringSuspension).toBeTypeOf('object');
  expect(sidecar.linesSeen()).toBeGreaterThan(publishedBeforeSuspension);
  expect(sidecar.settled()).toBeUndefined();
  record.notes.push(
    `snapshots published before the suspension: ${publishedBeforeSuspension}; after: ${sidecar.linesSeen()}`
  );

  // The readers saw the preceding committed snapshot and changed no history
  // anywhere in the environment.
  expect(recordManifest(project.databasePath).tables).toEqual(settled.tables);
  const difference = compareEnvironments(before, await environmentManifest(root));
  expect(authoritativelyUnchanged(difference)).toEqual(nothingAuthoritativeMoved);

  holder.resume();
  expect(await holder.release()).toEqual([0, null]);
  sidecar.child.stdin!.end();
  const sidecarOutcome = await sidecar.exited;
  noteProcess(record, 'sidecar shutdown', sidecarOutcome.pid!, {
    code: sidecarOutcome.code,
    signal: sidecarOutcome.signal,
  });
  expect(sidecarOutcome.code).toBe(0);
});
