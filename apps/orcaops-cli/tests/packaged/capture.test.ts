import { expect, it } from 'vitest';

import {
  authoritativelyUnchanged,
  compareEnvironments,
  environmentManifest,
  nothingAuthoritativeMoved,
} from './support/environment.js';
import { holdWriteLock } from './support/holders.js';
import { operationRows, recordManifest } from './support/manifest.js';
import { measure, noteProcess, scenario, useCeiling } from './support/measurement.js';
import { children, compiled } from './support/paths.js';
import { type DisposableRoot, disposableRoot, projectDatabaseFile } from './support/roots.js';
import { runCli, startCli, startSidecar } from './support/spawn.js';

const file = 'tests/packaged/capture.test.ts';

/**
 * The capture family produces two different named waits, and both name the
 * operation being waited on, which is what inventory rows 1 and 3 require.
 *
 * `capture plan` installs its own wait observer and writes "Waiting for plan
 * capture on the selected project database; Ctrl-C cancels the wait." The
 * checkpoint verbs do not install one for their first blocking operation, so they
 * fall through to the storage-level default in transactions.ts and write
 * "Waiting for capture.retention.begin; Ctrl-C to cancel." The scenario accepts
 * either and records which form each writer produced.
 */
const namedWait =
  /Waiting for (?:(?:plan )?capture on the selected project database; Ctrl-C cancels the wait\.)|(?:Waiting for [a-z][\w.]*; Ctrl-C to cancel\.)/;

const boundaryLine = /PACKAGED_GATE_BOUNDARY (\S+) ([0-9a-f-]{36})/;

function planPayload(label: string, idempotencyKey?: string) {
  return [
    ...(idempotencyKey ? [`idempotency_key: ${idempotencyKey}`] : []),
    'task: |-',
    `  contend on the project database as ${label}`,
    'label: |-',
    `  ${label}`,
    'plan_steps:',
    '  - text: |-',
    '      write through the ported capture',
    '    label: |-',
    '      Write through capture',
    'touched_scope: []',
    'non_goals: []',
    '',
  ].join('\n');
}

const capturePlan = ['capture', 'plan', '--input', '-', '--no-llm', '--invoked-by-agent', 'other'];

async function initialize(root: DisposableRoot) {
  const initialized = await runCli(root, [
    'init',
    '--yes',
    '--scope',
    'personal',
    '--no-session-hooks',
    '--json',
  ]);
  expect(initialized.code, initialized.stderr).toBe(0);
}

/** The first capture populates the initialized store, so it doubles as the fixture. */
async function firstCapture(root: DisposableRoot, label: string) {
  const captured = await runCli(root, capturePlan, { stdin: planPayload(label) });
  expect(captured.code, captured.stderr).toBe(0);
  const envelope = captured.json as { artifact_id: string; plan_steps: { step_id: string }[] };
  return { envelope, projectDatabase: projectDatabaseFile(root, await projectId(root)) };
}

async function projectId(root: DisposableRoot) {
  const listed = await runCli(root, ['list', '--json']);
  expect(listed.code, listed.stderr).toBe(0);
  const scope = (listed.json as { scope: { authorities: { project_id: string }[] } }).scope;
  expect(scope.authorities).toHaveLength(1);
  return scope.authorities[0]!.project_id;
}

const operationId = (outcome: { json: unknown }) =>
  (outcome.json as { operation_id: string }).operation_id;

it('queues several packaged capture writers beside a live sidecar, a suspended writer and a second project', async () => {
  const record = scenario('capture-family writer contention with a live sidecar', file);
  const root = await disposableRoot('capture-fleet');
  const independent = await disposableRoot('capture-independent');
  await Promise.all([initialize(root), initialize(independent)]);
  const fixture = await measure(record, 'first capture populates the store', () =>
    firstCapture(root, 'fixture')
  );
  await firstCapture(independent, 'independent fixture');
  const settledBefore = recordManifest(fixture.projectDatabase);

  const sidecar = startSidecar(root, []);
  noteProcess(record, 'live streaming sidecar', sidecar.pid);
  await measure(record, 'sidecar first snapshot', () =>
    sidecar.waitForLine(() => true, useCeiling(record, 'sidecarFirstSnapshotMs'))
  );

  const holder = await holdWriteLock(root, fixture.projectDatabase);
  noteProcess(record, 'suspended BEGIN IMMEDIATE holder', holder.pid);
  holder.suspend();
  const publishedBeforeSuspension = sidecar.drainLines();
  const before = await environmentManifest(root);

  // Distinct session identities: writers sharing one contend on the focus
  // selection rather than on the write lock, which the same-session scenario in
  // contention.test.ts already covers.
  const session = (name: string) => ({ env: { CLAUDE_SESSION_ID: `${root.shellKey}-${name}` } });
  const blocked = [
    startCli(root, capturePlan, { ...session('plan-a'), stdin: planPayload('queued plan a') }),
    startCli(root, capturePlan, { ...session('plan-b'), stdin: planPayload('queued plan b') }),
    startCli(
      root,
      ['capture', 'checkpoint', 'open', '--input', '-', '--invoked-by-agent', 'other'],
      {
        ...session('checkpoint'),
        stdin: [
          `artifact_id: ${fixture.envelope.artifact_id}`,
          `declared_step_ids: [${fixture.envelope.plan_steps[0]!.step_id}]`,
          '',
        ].join('\n'),
      }
    ),
  ];
  for (const handle of blocked) noteProcess(record, 'blocked capture writer', handle.pid);
  const waits = await Promise.all(
    blocked.map((handle) =>
      handle.waitFor('stderr', namedWait, useCeiling(record, 'streamPatternMs'))
    )
  );
  record.retries.blockedCaptureWriters = blocked.length;
  record.notes.push(`observed named waits: ${waits.map((text) => text.trim()).join(' | ')}`);

  // The second project is independent of this project's held lock.
  const elsewhere = await measure(record, 'independent project capture writer', () =>
    runCli(independent, capturePlan, { stdin: planPayload('independent writer') })
  );
  noteProcess(record, 'independent project writer', elsewhere.pid!, {
    code: elsewhere.code,
    signal: elsewhere.signal,
  });
  expect(elsewhere.code, elsewhere.stderr).toBe(0);
  expect(elsewhere.json).toMatchObject({ ok: true });

  // Watch stays short and passive: a snapshot published while the lock is held.
  const duringContention = await measure(record, 'sidecar snapshot during contention', () =>
    sidecar.waitForLine(() => true, useCeiling(record, 'sidecarFirstSnapshotMs'))
  );
  expect(duringContention).toBeTypeOf('object');
  expect(sidecar.linesSeen()).toBeGreaterThan(publishedBeforeSuspension);
  expect(sidecar.settled()).toBeUndefined();
  expect(recordManifest(fixture.projectDatabase).tables).toEqual(settledBefore.tables);
  expect(
    authoritativelyUnchanged(compareEnvironments(before, await environmentManifest(root)))
  ).toEqual(nothingAuthoritativeMoved);

  holder.resume();
  expect(await holder.release()).toEqual([0, null]);
  const settled = await measure(record, 'queued capture writers drain', () =>
    Promise.all(blocked.map((handle) => handle.exited))
  );
  for (const outcome of settled) {
    noteProcess(record, 'drained capture writer', outcome.pid!, {
      code: outcome.code,
      signal: outcome.signal,
    });
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.json).toMatchObject({ ok: true });
  }

  // The close verb, once its open has committed.
  const closed = await measure(record, 'capture checkpoint close', () =>
    runCli(
      root,
      ['capture', 'checkpoint', 'close', '--input', '-', '--invoked-by-agent', 'other'],
      {
        ...session('checkpoint'),
        stdin: [
          `artifact_id: ${fixture.envelope.artifact_id}`,
          'n: 1',
          'summary: |-',
          '  closed after the queued writers drained',
          'completed_step_ids: []',
          '',
        ].join('\n'),
      }
    )
  );
  noteProcess(record, 'capture checkpoint close', closed.pid!, {
    code: closed.code,
    signal: closed.signal,
  });
  expect(closed.code, closed.stderr).toBe(0);

  // Each committed operation appears exactly once. One capture command commits
  // several operations rows, so the envelope's operation_id is what is counted.
  const manifest = recordManifest(fixture.projectDatabase);
  const committed = [...settled, closed].map(operationId);
  expect(new Set(committed).size).toBe(committed.length);
  for (const id of committed)
    expect(operationRows(manifest.tables.operations!, id)).toHaveLength(1);
  expect(manifest.integrityCheck).toBe('ok');
  expect(manifest.foreignKeyCheck).toEqual([]);
  record.notes.push(`committed capture operations: ${committed.join(', ')}`);

  // The passive sidecar wrote nothing authoritative for the whole run.
  const beforeShutdown = await environmentManifest(root);
  sidecar.child.stdin!.end();
  const sidecarOutcome = await sidecar.exited;
  noteProcess(record, 'sidecar shutdown', sidecarOutcome.pid!, {
    code: sidecarOutcome.code,
    signal: sidecarOutcome.signal,
  });
  expect(sidecarOutcome.code).toBe(0);
  expect(
    authoritativelyUnchanged(compareEnvironments(beforeShutdown, await environmentManifest(root)))
  ).toEqual(nothingAuthoritativeMoved);
  expect(recordManifest(fixture.projectDatabase).tables).toEqual(manifest.tables);
});

it('retries a capture killed at the COMMIT boundary under its original idempotency key', async () => {
  const record = scenario('capture killed at the COMMIT boundary', file);
  const root = await disposableRoot('capture-death');
  await initialize(root);
  const fixture = await firstCapture(root, 'fixture');
  const settledBefore = recordManifest(fixture.projectDatabase);

  const idempotencyKey = '01a08000-0000-7000-8000-00000000c001';
  const payload = planPayload('killed at commit', idempotencyKey);
  const doomed = startCli(root, capturePlan, {
    stdin: payload,
    env: {
      PACKAGED_GATE_BOUNDARY: 'before-commit',
      PACKAGED_GATE_DRIVER_ANCHOR: compiled.storageConnection,
    },
    nodeArgs: ['--import', children.commitBoundary],
  });
  noteProcess(record, 'capture parked before COMMIT', doomed.pid);
  const marker = await doomed.waitFor(
    'stderr',
    boundaryLine,
    useCeiling(record, 'streamPatternMs')
  );
  record.notes.push(`parked at ${marker.trim()}`);

  doomed.send('SIGKILL');
  const killed = await measure(record, 'SIGKILL before COMMIT', () => doomed.exited);
  noteProcess(record, 'killed capture', killed.pid!, { code: killed.code, signal: killed.signal });
  expect(killed.signal).toBe('SIGKILL');
  expect(killed.stdout).toBe('');

  // Nothing of the killed capture settled.
  const afterDeath = recordManifest(fixture.projectDatabase);
  expect(afterDeath.tables).toEqual(settledBefore.tables);
  expect(afterDeath.integrityCheck).toBe('ok');

  // The retry under the original idempotency key commits the capture once.
  const retried = await measure(record, 'retry under the original idempotency key', () =>
    runCli(root, capturePlan, { stdin: payload })
  );
  noteProcess(record, 'retried capture', retried.pid!, {
    code: retried.code,
    signal: retried.signal,
  });
  expect(retried.code, retried.stderr).toBe(0);
  expect(retried.json).toMatchObject({ ok: true, idempotency_status: 'created' });
  const artifactId = (retried.json as { artifact_id: string }).artifact_id;

  // A second run with the same key resolves to the same artifact rather than
  // capturing a second one. It is NOT a byte-level no-op on this base: it appends
  // a pending capture event and advances the write sequence, which is recorded
  // rather than asserted away.
  const afterRetry = recordManifest(fixture.projectDatabase);
  const replayed = await measure(record, 'replay under the original idempotency key', () =>
    runCli(root, capturePlan, { stdin: payload })
  );
  noteProcess(record, 'replayed capture', replayed.pid!, {
    code: replayed.code,
    signal: replayed.signal,
  });
  expect(replayed.code, replayed.stderr).toBe(0);
  expect(replayed.json).toMatchObject({ ok: true, artifact_id: artifactId });
  const afterReplay = recordManifest(fixture.projectDatabase);
  expect(afterReplay.tables.artifacts).toEqual(afterRetry.tables.artifacts);
  expect(afterReplay.tables.artifacts!.filter((row) => row.includes(artifactId))).toHaveLength(1);
  expect(afterReplay.integrityCheck).toBe('ok');
  const moved = Object.keys(afterReplay.tables).filter(
    (name) => JSON.stringify(afterReplay.tables[name]) !== JSON.stringify(afterRetry.tables[name])
  );
  record.notes.push(
    `replay status ${String((replayed.json as { idempotency_status?: string }).idempotency_status)}; tables that moved: ${moved.join(', ') || 'none'}`
  );
});
