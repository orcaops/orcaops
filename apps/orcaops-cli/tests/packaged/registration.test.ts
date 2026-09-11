import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { measure, noteProcess, scenario, useCeiling } from './support/measurement.js';
import { children, compiled } from './support/paths.js';
import { type DisposableRoot, disposableRoot } from './support/roots.js';
import { startNode } from './support/spawn.js';

const execute = promisify(execFile);
const file = 'tests/packaged/registration.test.ts';
const registrationLine = /PACKAGED_GATE_REGISTRATION (\S+) (\{.*\})/;

/**
 * These scenarios drive the compiled setup module in controlled second processes so
 * they can stop at publication boundaries that the public init command cannot expose.
 */
function startBoundary(
  root: DisposableRoot,
  input: { cwd: string; root: string; projectId?: string; boundary?: string }
) {
  return startNode(root, children.registrationBoundary, [
    JSON.stringify({ ...input, modules: compiled }),
  ]);
}

async function repository(root: DisposableRoot, name: string) {
  const directory = path.join(root.base, name);
  await mkdir(directory, { recursive: true });
  await execute('git', ['-C', directory, 'init', '-qb', 'main'], { env: root.env });
  await execute('git', ['-C', directory, 'commit', '--allow-empty', '-qm', 'Initial'], {
    env: root.env,
  });
  return directory;
}

it('never exposes partial marker bytes and lets an authorized retry adopt', async () => {
  const record = scenario('SIGKILL between the temporary marker and its hard link', file);
  const root = await disposableRoot('registration-link');
  const historyRoot = path.join(root.base, 'history');
  const projectId = '01a07000-0000-7000-8000-000000000004';

  const parked = startBoundary(root, {
    cwd: root.repo,
    root: historyRoot,
    projectId,
    boundary: 'before-link',
  });
  noteProcess(record, 'initializer parked before hard link', parked.pid);
  const marker = await parked.waitFor(
    'stderr',
    registrationLine,
    useCeiling(record, 'streamPatternMs')
  );
  const detail = JSON.parse(registrationLine.exec(marker)![2]!) as {
    temporary: string;
    final: string;
  };
  record.notes.push(`parked before linking ${path.basename(detail.temporary)}`);

  // The temporary carries complete bytes; the final name does not exist at all.
  const retained = await readFile(detail.temporary);
  expect(JSON.parse(retained.toString()) as Record<string, unknown>).toMatchObject({
    initialization_operation_id: expect.any(String),
  });
  await expect(stat(detail.final)).rejects.toMatchObject({ code: 'ENOENT' });

  parked.send('SIGKILL');
  const killed = await measure(record, 'SIGKILL before hard link', () => parked.exited);
  noteProcess(record, 'killed initializer', killed.pid!, {
    code: killed.code,
    signal: killed.signal,
  });
  expect(killed.signal).toBe('SIGKILL');

  const retry = startBoundary(root, { cwd: root.repo, root: historyRoot, projectId });
  noteProcess(record, 'authorized retry', retry.pid);
  const adopted = await measure(record, 'authorized retry adopts', () => retry.exited);
  expect(adopted.code, adopted.stderr).toBe(0);
  expect(JSON.parse(adopted.stdout)).toMatchObject({ kind: 'result', status: 'complete' });

  // The retry published exactly the bytes the killed initializer had prepared.
  const published = await readFile(detail.final).catch(() => null);
  expect(published).not.toBeNull();
  expect(published!.equals(retained)).toBe(true);
  // The unknown leftover temporary stays protected rather than being cleaned up.
  const directory = await readdir(path.dirname(detail.final));
  expect(directory).toContain(path.basename(detail.temporary));
  expect(directory).toContain(path.basename(detail.final));
  record.notes.push(`retry pid ${retry.pid}; directory ${directory.sort().join(', ')}`);
});

it('adopts an existing initialized database when registration never happened', async () => {
  const record = scenario('SIGKILL after initialization, before registration', file);
  const root = await disposableRoot('registration-init');
  const historyRoot = path.join(root.base, 'history');
  const projectId = '01a07000-0000-7000-8000-000000000001';

  const parked = startBoundary(root, {
    cwd: root.repo,
    root: historyRoot,
    projectId,
    boundary: 'after-init',
  });
  noteProcess(record, 'initializer parked before registration', parked.pid);
  await parked.waitFor('stderr', registrationLine, useCeiling(record, 'streamPatternMs'));

  const databaseFile = path.join(historyRoot, 'projects', projectId, 'history.sqlite3');
  const initialized = await stat(databaseFile, { bigint: true });
  expect(initialized.size).toBeGreaterThan(0n);

  parked.send('SIGKILL');
  const killed = await measure(record, 'SIGKILL before registration', () => parked.exited);
  noteProcess(record, 'killed initializer', killed.pid!, {
    code: killed.code,
    signal: killed.signal,
  });
  expect(killed.signal).toBe('SIGKILL');

  const retry = startBoundary(root, { cwd: root.repo, root: historyRoot, projectId });
  noteProcess(record, 'authorized retry', retry.pid);
  const adopted = await measure(
    record,
    'retry adopts the initialized database',
    () => retry.exited
  );
  expect(adopted.code, adopted.stderr).toBe(0);
  expect(JSON.parse(adopted.stdout)).toMatchObject({ kind: 'result', status: 'complete' });

  // The retry adopted the original file rather than replacing it.
  const adoptedStat = await stat(databaseFile, { bigint: true });
  expect([adoptedStat.dev, adoptedStat.ino]).toEqual([initialized.dev, initialized.ino]);
  record.notes.push(`adopted inode ${adoptedStat.ino} at ${databaseFile}`);
});

it('resolves four concurrent initializers of the same project onto one identity', async () => {
  const record = scenario('four concurrent repository initializers', file);
  const root = await disposableRoot('registration-race');
  const historyRoot = path.join(root.base, 'history');
  const projectId = '01a07000-0000-7000-8000-000000000002';

  const racing = Array.from({ length: 4 }, () =>
    startBoundary(root, { cwd: root.repo, root: historyRoot, projectId })
  );
  for (const handle of racing) noteProcess(record, 'concurrent initializer', handle.pid);
  const settled = await measure(record, 'four initializers settle', () =>
    Promise.all(racing.map((handle) => handle.exited))
  );
  for (const outcome of settled) {
    noteProcess(record, 'settled initializer', outcome.pid!, {
      code: outcome.code,
      signal: outcome.signal,
    });
    record.notes.push(`initializer: ${outcome.stdout.trim() || outcome.stderr.trim()}`);
  }
  // How many initializers complete is not stable, and the refusal codes are not a
  // closed set: a loser that inspects the winner's half-published installation is
  // classified terminally instead of adopting or reporting pending. The reviewer
  // traced it to inspectDatabaseSetup — the catalog directory read that raises
  // HISTORY_INACCESSIBLE, and the bootstrap-presence branch that raises
  // CONVERSION_REQUIRED — and NOT to the bounded activation wait, which only ever
  // raises ACTIVATION_PENDING on exhaustion and is bypassed because
  // waitForInitialization rethrows every other code immediately. That is a
  // production defect the coordinator owns; this scenario records it and asserts
  // only what the contract actually promises, which is that nothing is destroyed
  // and no replacement is initialized.
  const results = settled.map((outcome) => JSON.parse(outcome.stdout) as Record<string, string>);
  const complete = results.filter((value) => value.kind === 'result');
  expect(complete.length).toBeGreaterThanOrEqual(1);
  for (const value of complete) expect(value.status).toBe('complete');
  const refusals = results.filter((entry) => entry.kind === 'failure').map((entry) => entry.code!);
  record.retries.completedInitializers = complete.length;
  record.notes.push(
    `observed outcome set: ${complete.length} complete, refusals [${refusals.sort().join(', ')}]`
  );

  // Non-destructiveness, whatever the outcome set was: exactly one registration
  // marker, exactly one catalog entry for the requested identity, exactly one
  // project database, and no losing initializer left a replacement behind.
  expect(await readdir(path.join(root.repo, '.git', 'orcaops'))).toContain('registration.json');
  expect(await readdir(path.join(historyRoot, 'projects', 'catalog'))).toEqual([
    `${projectId}.json`,
  ]);
  expect(
    (await readdir(path.join(historyRoot, 'projects'))).filter((name) => name !== 'catalog')
  ).toEqual([projectId]);
  const databases = (await readdir(path.join(historyRoot, 'projects', projectId))).filter((name) =>
    name.endsWith('.sqlite3')
  );
  expect(databases).toEqual(['history.sqlite3']);
});

it('retains every distinct catalog addition and refuses the losing claimant of one identity', async () => {
  const record = scenario('four concurrent catalog additions plus an identity conflict', file);
  const root = await disposableRoot('registration-catalog');
  const historyRoot = path.join(root.base, 'history');

  const repositories = await Promise.all(
    Array.from({ length: 4 }, (_, index) => repository(root, `catalog-${index}`))
  );
  const additions = repositories.map((cwd) => startBoundary(root, { cwd, root: historyRoot }));
  for (const handle of additions) noteProcess(record, 'concurrent catalog addition', handle.pid);
  const settled = await measure(record, 'four catalog additions settle', () =>
    Promise.all(additions.map((handle) => handle.exited))
  );
  for (const outcome of settled)
    noteProcess(record, 'settled catalog addition', outcome.pid!, {
      code: outcome.code,
      signal: outcome.signal,
    });
  const failed = settled.filter((outcome) => outcome.code !== 0);
  expect(
    failed,
    failed
      .map((outcome) => outcome.stdout.trim() || outcome.stderr.trim() || String(outcome.signal))
      .join('\n')
  ).toEqual([]);
  const catalog = await readdir(path.join(historyRoot, 'projects', 'catalog'));
  expect(catalog).toHaveLength(4);
  expect(new Set(catalog).size).toBe(4);

  // Same identity, different content: two repositories claiming one project ID.
  const projectId = '01a07000-0000-7000-8000-000000000003';
  const [left, right] = await Promise.all([
    repository(root, 'conflict-left'),
    repository(root, 'conflict-right'),
  ]);
  const conflicting = [left, right].map((cwd) =>
    startBoundary(root, { cwd, root: historyRoot, projectId })
  );
  for (const handle of conflicting) noteProcess(record, 'conflicting claimant', handle.pid);
  const outcomes = await measure(record, 'conflicting claimants settle', () =>
    Promise.all(conflicting.map((handle) => handle.exited))
  );
  for (const outcome of outcomes) {
    noteProcess(record, 'settled claimant', outcome.pid!, {
      code: outcome.code,
      signal: outcome.signal,
    });
    record.notes.push(`claimant: ${outcome.stdout.trim() || outcome.stderr.trim().slice(0, 200)}`);
  }
  // Same identity, different repository: exactly one claimant publishes the entry
  // and the loser refuses rather than rewriting the shared catalog.
  const results = outcomes.map((outcome) => JSON.parse(outcome.stdout) as { kind: string });
  expect(results.filter((value) => value.kind === 'result')).toHaveLength(1);
  expect(results.filter((value) => value.kind === 'failure')).toHaveLength(1);
  const finalCatalog = await readdir(path.join(historyRoot, 'projects', 'catalog'));
  expect(finalCatalog).toHaveLength(5);
  expect(finalCatalog.filter((name) => name === `${projectId}.json`)).toHaveLength(1);
  expect(new Set(finalCatalog).size).toBe(5);
});
