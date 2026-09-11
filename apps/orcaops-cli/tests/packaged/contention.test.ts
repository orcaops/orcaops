import { expect, it } from 'vitest';

import { holdWriteLock } from './support/holders.js';
import {
  compareManifests,
  fileManifest,
  operationRows,
  recordManifest,
  rowCounts,
} from './support/manifest.js';
import {
  machineLoad,
  measure,
  noteProcess,
  scenario,
  useCeiling,
  withinCeiling,
} from './support/measurement.js';
import { disposableRoot } from './support/roots.js';
import { seedProject } from './support/seed.js';
import { runCli, startCli, startSidecar } from './support/spawn.js';

const file = 'tests/packaged/contention.test.ts';

/**
 * The wait the packaged checkout writes to its own stderr. It names the operation,
 * the resource it is waiting on and the cancellation lever, which is the property
 * inventory row 1 asks for on the packaged surface.
 */
const namedWait =
  /Waiting for checkout on the selected project database; Ctrl-C cancels the wait\./;

it('names its wait and cancels on a real SIGINT without changing authoritative rows', async () => {
  const record = scenario('suspended holder, packaged contender, real SIGINT', file);
  const root = await disposableRoot('contention-cancel');
  const project = await seedProject(root, { artifacts: 2 });
  const [first, second] = project.artifactIds as [string, string];

  // Positive control comes first: the same command against an uncontended store
  // must commit, so the negative control below is about contention, not about the
  // command being inert.
  const committed = await measure(record, 'uncontended checkout', () =>
    runCli(root, ['checkout', first, '--json'])
  );
  noteProcess(record, 'uncontended checkout', committed.pid!, {
    code: committed.code,
    signal: committed.signal,
  });
  expect(committed.code, committed.stderr).toBe(0);
  const afterCommit = recordManifest(project.databasePath);
  expect(rowCounts(afterCommit).operations).toBeGreaterThan(0);

  const holder = await holdWriteLock(root, project.databasePath);
  noteProcess(record, 'suspended BEGIN IMMEDIATE holder', holder.pid);
  holder.suspend();

  const contender = startCli(root, ['checkout', second, '--json']);
  noteProcess(record, 'blocked packaged contender', contender.pid);
  const wait = await contender.waitFor('stderr', namedWait, useCeiling(record, 'streamPatternMs'));
  record.notes.push(`observed wait: ${wait}`);

  const beforeCancelFiles = await fileManifest(root.dataDir);
  const beforeCancelRecords = recordManifest(project.databasePath);
  expect(beforeCancelRecords.tables).toEqual(afterCommit.tables);

  const cancelledAt = Date.now();
  contender.send('SIGINT');
  const cancelled = await contender.exited;
  const cancellationMs = Date.now() - cancelledAt;
  record.measurements.push({
    label: 'SIGINT to contender exit',
    wallMs: cancellationMs,
    uptime: await machineLoad(),
    at: new Date().toISOString(),
  });
  noteProcess(record, 'cancelled packaged contender', cancelled.pid!, {
    code: cancelled.code,
    signal: cancelled.signal,
  });
  withinCeiling(record, 'cancellationMs', cancellationMs);
  expect(cancelled.json).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });

  // Negative control: cancellation changed no authoritative row, and touched no
  // file outside SQLite's own runtime coordination.
  expect(recordManifest(project.databasePath).tables).toEqual(beforeCancelRecords.tables);
  const difference = compareManifests(beforeCancelFiles, await fileManifest(root.dataDir));
  expect(difference.database).toEqual({ created: [], removed: [], changed: [] });
  expect(difference.other).toEqual({ created: [], removed: [], changed: [] });

  holder.resume();
  expect(await holder.release()).toEqual([0, null]);
  const recovered = await measure(record, 'checkout after holder release', () =>
    runCli(root, ['checkout', second, '--json'])
  );
  noteProcess(record, 'checkout after release', recovered.pid!, {
    code: recovered.code,
    signal: recovered.signal,
  });
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(recovered.json).toMatchObject({ ok: true, artifact_id: second, action: 'focused' });
  expect(rowCounts(recordManifest(project.databasePath)).operations).toBeGreaterThan(
    rowCounts(beforeCancelRecords).operations!
  );
});

it('replays the original operation ID after the holder resumes without duplicating events', async () => {
  const record = scenario('original operation ID retry across a suspension', file);
  const root = await disposableRoot('contention-replay');
  const project = await seedProject(root, { artifacts: 1 });
  const artifactId = project.artifactIds[0]!;

  const committed = await measure(record, 'original checkout', () =>
    runCli(root, ['checkout', artifactId, '--json'])
  );
  expect(committed.code, committed.stderr).toBe(0);
  const originalOperationId = (committed.json as { operation_id: string }).operation_id;
  expect(originalOperationId).toMatch(/^[0-9a-f-]{36}$/);
  noteProcess(record, 'original checkout writer', committed.pid!, {
    code: committed.code,
    signal: committed.signal,
  });

  const settled = recordManifest(project.databasePath);
  const settledFiles = await fileManifest(root.dataDir);

  const holder = await holdWriteLock(root, project.databasePath);
  noteProcess(record, 'suspended BEGIN IMMEDIATE holder', holder.pid);
  holder.suspend();

  const retry = startCli(root, ['checkout', '--operation-id', originalOperationId, '--json']);
  noteProcess(record, 'blocked original-ID retry', retry.pid);
  await retry.waitFor('stderr', namedWait, useCeiling(record, 'streamPatternMs'));

  holder.resume();
  expect(await holder.release()).toEqual([0, null]);
  const replayed = await measure(record, 'original-ID retry after release', () => retry.exited);
  noteProcess(record, 'completed original-ID retry', replayed.pid!, {
    code: replayed.code,
    signal: replayed.signal,
  });
  expect(replayed.code, replayed.stderr).toBe(0);
  expect(replayed.json).toMatchObject({
    ok: true,
    action: 'replayed',
    operation_id: originalOperationId,
    focus: { publication: { replayed: true } },
  });

  // No duplicate events: the retry under the original ID left the authoritative
  // rows byte-identical, and moved nothing but SQLite's runtime coordination.
  expect(recordManifest(project.databasePath).tables).toEqual(settled.tables);
  const difference = compareManifests(settledFiles, await fileManifest(root.dataDir));
  expect(difference.database).toEqual({ created: [], removed: [], changed: [] });
  expect(difference.other).toEqual({ created: [], removed: [], changed: [] });
});

it('queues several packaged writers beside a live sidecar, a suspended writer and a second project', async () => {
  const record = scenario('multi-writer contention with a live sidecar', file);
  const root = await disposableRoot('contention-fleet');
  const independent = await disposableRoot('contention-independent');
  const project = await seedProject(root, { artifacts: 3 });
  const other = await seedProject(independent, { artifacts: 1 });

  const sidecar = startSidecar(root, []);
  noteProcess(record, 'live streaming sidecar', sidecar.pid);
  const firstSnapshot = await measure(record, 'sidecar first snapshot', () =>
    sidecar.waitForLine(() => true, useCeiling(record, 'sidecarFirstSnapshotMs'))
  );
  expect(firstSnapshot).toBeTypeOf('object');

  const holder = await holdWriteLock(root, project.databasePath);
  noteProcess(record, 'suspended BEGIN IMMEDIATE holder', holder.pid);
  holder.suspend();
  // Consume every snapshot published before the lock was held, so the one waited
  // for below was produced while the writers were queued behind it.
  const publishedBeforeSuspension = sidecar.drainLines();

  // Each writer carries its own session identity. Sharing one would make them
  // contend on the same focus selection rather than on the write lock, which is a
  // different property (covered by the stale-precondition scenario below).
  const blocked = project.artifactIds.map((artifactId, index) => {
    const handle = startCli(root, ['checkout', artifactId, '--json'], {
      env: { CLAUDE_SESSION_ID: `${root.shellKey}-writer-${index}` },
    });
    noteProcess(record, `blocked writer for ${artifactId}`, handle.pid);
    return handle;
  });
  await Promise.all(
    blocked.map((handle) =>
      handle.waitFor('stderr', namedWait, useCeiling(record, 'streamPatternMs'))
    )
  );
  record.retries.blockedWriters = blocked.length;

  // A different project's writer is independent of this project's held lock.
  const elsewhere = await measure(record, 'independent project writer', () =>
    runCli(independent, ['checkout', other.artifactIds[0]!, '--json'])
  );
  noteProcess(record, 'independent project writer', elsewhere.pid!, {
    code: elsewhere.code,
    signal: elsewhere.signal,
  });
  expect(elsewhere.code, elsewhere.stderr).toBe(0);
  expect(elsewhere.json).toMatchObject({ ok: true, action: 'focused' });

  // The sidecar stays responsive while the writers are queued: it must PUBLISH a
  // further snapshot rather than block behind the held write lock. Liveness alone
  // would not show that, so the assertion is on a line the cursor had not seen
  // when the holder was suspended.
  const duringContention = await measure(record, 'sidecar snapshot during contention', () =>
    sidecar.waitForLine(() => true, useCeiling(record, 'sidecarFirstSnapshotMs'))
  );
  expect(duringContention).toBeTypeOf('object');
  expect(sidecar.linesSeen()).toBeGreaterThan(publishedBeforeSuspension);
  record.notes.push(
    `snapshots published before the suspension: ${publishedBeforeSuspension}; after: ${sidecar.linesSeen()}`
  );
  expect(sidecar.settled()).toBeUndefined();

  holder.resume();
  expect(await holder.release()).toEqual([0, null]);
  const settled = await measure(record, 'queued writers drain', () =>
    Promise.all(blocked.map((handle) => handle.exited))
  );
  for (const outcome of settled) {
    noteProcess(record, 'drained writer', outcome.pid!, {
      code: outcome.code,
      signal: outcome.signal,
    });
    record.notes.push(`drained writer envelope: ${JSON.stringify(outcome.json)}`);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.json).toMatchObject({ ok: true, action: 'focused' });
  }

  // Each committed operation appears exactly once.
  const operationIds = settled.map(
    (outcome) => (outcome.json as { operation_id: string }).operation_id
  );
  expect(new Set(operationIds).size).toBe(operationIds.length);
  const manifest = recordManifest(project.databasePath);
  for (const operationId of operationIds)
    expect(operationRows(manifest.tables.operations!, operationId)).toHaveLength(1);
  expect(manifest.integrityCheck).toBe('ok');
  expect(manifest.foreignKeyCheck).toEqual([]);

  // The passive sidecar wrote nothing authoritative for the whole run.
  const beforeShutdown = await fileManifest(root.dataDir);
  sidecar.child.stdin!.end();
  const sidecarOutcome = await sidecar.exited;
  noteProcess(record, 'sidecar shutdown', sidecarOutcome.pid!, {
    code: sidecarOutcome.code,
    signal: sidecarOutcome.signal,
  });
  expect(sidecarOutcome.code).toBe(0);
  const shutdownDifference = compareManifests(beforeShutdown, await fileManifest(root.dataDir));
  expect(shutdownDifference.database).toEqual({ created: [], removed: [], changed: [] });
  expect(recordManifest(project.databasePath).tables).toEqual(manifest.tables);
});

it('refuses same-session packaged writers on a stale precondition instead of retargeting', async () => {
  const record = scenario('real contention produces a stale precondition refusal', file);
  const root = await disposableRoot('contention-stale');
  const project = await seedProject(root, { artifacts: 3 });

  const holder = await holdWriteLock(root, project.databasePath);
  noteProcess(record, 'suspended BEGIN IMMEDIATE holder', holder.pid);
  holder.suspend();

  // All three share one session identity, so they prepared against the same focus
  // selection before any of them could commit.
  const racing = project.artifactIds.map((artifactId) => {
    const handle = startCli(root, ['checkout', artifactId, '--json']);
    noteProcess(record, `same-session writer for ${artifactId}`, handle.pid);
    return handle;
  });
  await Promise.all(
    racing.map((handle) =>
      handle.waitFor('stderr', namedWait, useCeiling(record, 'streamPatternMs'))
    )
  );

  holder.resume();
  expect(await holder.release()).toEqual([0, null]);
  const settled = await measure(record, 'same-session writers drain', () =>
    Promise.all(racing.map((handle) => handle.exited))
  );
  for (const outcome of settled)
    noteProcess(record, 'same-session writer result', outcome.pid!, {
      code: outcome.code,
      signal: outcome.signal,
    });

  const envelopes = settled.map((outcome) => outcome.json as Record<string, unknown>);
  const accepted = envelopes.filter((value) => value.ok === true);
  const refused = envelopes.filter((value) => value.ok === false);
  expect(accepted).toHaveLength(1);
  expect(refused).toHaveLength(racing.length - 1);
  for (const value of refused) expect(value).toMatchObject({ error: { code: 'STALE_CONTEXT' } });
  record.notes.push(
    `refused: ${refused.map((value) => JSON.stringify((value as { error: unknown }).error)).join(' ')}`
  );

  // The refusals wrote nothing: no operations row carries a refused operation ID.
  const manifest = recordManifest(project.databasePath);
  for (const value of refused)
    expect(operationRows(manifest.tables.operations!, String(value.operation_id))).toHaveLength(0);
  expect(
    operationRows(manifest.tables.operations!, String(accepted[0]!.operation_id))
  ).toHaveLength(1);
  expect(manifest.integrityCheck).toBe('ok');
});
