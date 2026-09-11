import { expect, it } from 'vitest';

import {
  compareManifests,
  fileManifest,
  operationRows,
  recordManifest,
} from './support/manifest.js';
import { measure, noteProcess, scenario, useCeiling } from './support/measurement.js';
import { children, compiled } from './support/paths.js';
import { disposableRoot } from './support/roots.js';
import { seedProject } from './support/seed.js';
import { runCli, startCli } from './support/spawn.js';

const file = 'tests/packaged/process-death.test.ts';
const boundaryLine = /PACKAGED_GATE_BOUNDARY (\S+) ([0-9a-f-]{36})/;

function boundaryEnv(mode: 'before-commit' | 'after-commit') {
  return {
    env: { PACKAGED_GATE_BOUNDARY: mode, PACKAGED_GATE_DRIVER_ANCHOR: compiled.storageConnection },
    nodeArgs: ['--import', children.commitBoundary],
  };
}

it('leaves no operation when the packaged writer is killed before COMMIT', async () => {
  const record = scenario('SIGKILL before COMMIT', file);
  const root = await disposableRoot('death-before-commit');
  const project = await seedProject(root, { artifacts: 2 });
  const [target, control] = project.artifactIds as [string, string];

  const doomed = startCli(root, ['checkout', target, '--json'], boundaryEnv('before-commit'));
  noteProcess(record, 'writer parked before COMMIT', doomed.pid);
  const marker = await doomed.waitFor(
    'stderr',
    boundaryLine,
    useCeiling(record, 'streamPatternMs')
  );
  const operationId = boundaryLine.exec(marker)![2]!;
  record.notes.push(`parked at ${marker.trim()}`);

  const before = await fileManifest(root.dataDir);
  doomed.send('SIGKILL');
  const killed = await measure(record, 'SIGKILL before COMMIT', () => doomed.exited);
  noteProcess(record, 'killed writer', killed.pid!, { code: killed.code, signal: killed.signal });
  expect(killed.signal).toBe('SIGKILL');

  // The transaction never committed, so the original operation is absent.
  const manifest = recordManifest(project.databasePath);
  expect(operationRows(manifest.tables.operations!, operationId)).toHaveLength(0);
  expect(manifest.integrityCheck).toBe('ok');

  // The original operation lookup says so, and suggests no fresh operation.
  const lookup = await measure(record, 'original operation lookup after death', () =>
    runCli(root, ['checkout', '--operation-id', operationId, '--json'])
  );
  noteProcess(record, 'original operation lookup', lookup.pid!, {
    code: lookup.code,
    signal: lookup.signal,
  });
  expect(lookup.code).toBe(1);
  expect(lookup.json).toMatchObject({ ok: false, error: { code: 'HISTORY_MISSING' } });
  expect(recordManifest(project.databasePath).tables).toEqual(manifest.tables);
  const difference = compareManifests(before, await fileManifest(root.dataDir));
  expect(difference.other).toEqual({ created: [], removed: [], changed: [] });

  // Positive control: the store is still writable by a new operation.
  const recovered = await measure(record, 'fresh checkout after death', () =>
    runCli(root, ['checkout', control, '--json'])
  );
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(recovered.json).toMatchObject({ ok: true, action: 'focused' });
});

it('reports the committed result when the packaged writer is killed after COMMIT', async () => {
  const record = scenario('SIGKILL after COMMIT', file);
  const root = await disposableRoot('death-after-commit');
  const project = await seedProject(root, { artifacts: 1 });
  const target = project.artifactIds[0]!;

  const doomed = startCli(root, ['checkout', target, '--json'], boundaryEnv('after-commit'));
  noteProcess(record, 'writer parked after COMMIT', doomed.pid);
  const marker = await doomed.waitFor(
    'stderr',
    boundaryLine,
    useCeiling(record, 'streamPatternMs')
  );
  const operationId = boundaryLine.exec(marker)![2]!;
  record.notes.push(`parked at ${marker.trim()}`);

  doomed.send('SIGKILL');
  const killed = await measure(record, 'SIGKILL after COMMIT', () => doomed.exited);
  noteProcess(record, 'killed writer', killed.pid!, { code: killed.code, signal: killed.signal });
  expect(killed.signal).toBe('SIGKILL');
  // The process died before it could print anything about what it had done.
  expect(killed.stdout).toBe('');

  const manifest = recordManifest(project.databasePath);
  expect(operationRows(manifest.tables.operations!, operationId)).toHaveLength(1);

  // The original operation lookup finds the committed result rather than
  // suggesting a fresh operation that would duplicate it.
  const lookup = await measure(record, 'original operation lookup after death', () =>
    runCli(root, ['checkout', '--operation-id', operationId, '--json'])
  );
  noteProcess(record, 'original operation lookup', lookup.pid!, {
    code: lookup.code,
    signal: lookup.signal,
  });
  record.notes.push(`lookup envelope: ${lookup.stdout.trim()}`);
  expect(lookup.code, lookup.stderr).toBe(0);
  expect(lookup.json).toMatchObject({
    ok: true,
    action: 'replayed',
    operation_id: operationId,
  });
  expect(
    operationRows(recordManifest(project.databasePath).tables.operations!, operationId)
  ).toHaveLength(1);
});
