import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { compareManifests, fileManifest } from './support/manifest.js';
import { measure, noteProcess, scenario, useCeiling } from './support/measurement.js';
import { children, compiled } from './support/paths.js';
import { disposableRoot } from './support/roots.js';
import { runCli, startCli, startNode } from './support/spawn.js';

const file = 'tests/packaged/coordinator-slots.test.ts';
const execute = promisify(execFile);
const registrationLine = /PACKAGED_GATE_REGISTRATION empty-created/;
const setupWait = /Waiting to initialize project history; Ctrl-C cancels the wait\./;

/**
 * Tripwires for packaged scenarios that have no trigger at this base. Each asserts
 * the CURRENT boundary, so it fails when the boundary moves rather than going
 * quietly out of date.
 *
 * The capture-family tripwire that lived here has been retired: the capture port
 * landed, the tripwire fired as designed, and the scenario it was holding a slot
 * for is now tests/packaged/capture.test.ts.
 */

it('initializes one store on init and reuses it on the first capture', async () => {
  const record = scenario('init creates one store; the first capture reuses it', file);
  const root = await disposableRoot('slot-init');

  const beforeInit = await fileManifest(root.dataDir);
  const initialized = await measure(record, 'orcaops init on an empty history root', () =>
    runCli(root, ['init', '--yes', '--scope', 'personal', '--no-session-hooks', '--json'])
  );
  noteProcess(record, 'orcaops init', initialized.pid!, {
    code: initialized.code,
    signal: initialized.signal,
  });
  expect(initialized.code, initialized.stderr).toBe(0);

  const afterInit = compareManifests(beforeInit, await fileManifest(root.dataDir));
  expect(afterInit.database.created).toHaveLength(1);
  expect(afterInit.database.removed).toEqual([]);
  expect(afterInit.database.changed).toEqual([]);
  const created = afterInit.database.created[0]!;
  expect(afterInit.wal).toEqual({
    created: [`${created}-wal`],
    removed: [],
    changed: [],
  });
  const projectId = path.basename(path.dirname(created));
  expect(created).toBe(path.join('projects', projectId, 'history.sqlite3'));
  expect(afterInit.other.created).toContain(path.join('projects', 'catalog', `${projectId}.json`));
  expect(Object.keys(await fileManifest(path.join(root.repo, '.git', 'orcaops'))).sort()).toEqual(
    ['config.json', 'locks', 'personal-manifest.json', 'registration.json', 'worktree.json'].sort()
  );
  record.notes.push(`init created: ${created} and its catalog entry`);

  const captured = await measure(record, 'first orcaops capture plan', () =>
    runCli(root, ['capture', 'plan', '--input', '-', '--no-llm', '--invoked-by-agent', 'other'], {
      stdin: [
        'task: |-',
        '  reuse the initialized project store through the first capture',
        'label: |-',
        '  First capture reuses history',
        'plan_steps:',
        '  - text: |-',
        '      write the first plan',
        '    label: |-',
        '      Write the first plan',
        '    acceptance_criteria:',
        '      - text: |-',
        '          the step is delivered',
        'touched_scope: []',
        'non_goals: []',
        '',
      ].join('\n'),
    })
  );
  noteProcess(record, 'orcaops capture plan', captured.pid!, {
    code: captured.code,
    signal: captured.signal,
  });
  expect(captured.code, captured.stderr).toBe(0);

  const afterCapture = compareManifests(beforeInit, await fileManifest(root.dataDir));
  expect(afterCapture.database.created).toHaveLength(1);
  expect(afterCapture.database.created[0]).toBe(created);
  expect(afterCapture.other.created).toContain(
    path.join('projects', 'catalog', `${projectId}.json`)
  );
  expect(Object.keys(await fileManifest(path.join(root.repo, '.git', 'orcaops'))).sort()).toEqual(
    ['config.json', 'locks', 'personal-manifest.json', 'registration.json', 'worktree.json'].sort()
  );
  record.notes.push(`first capture reused ${created}`);
});

it('names a contended setup wait and cancels before installer publication', async () => {
  const record = scenario('contended init cancelled before registration', file);
  const root = await disposableRoot('slot-init-cancel');
  const projectId = '01a07000-0000-7000-8000-000000000009';
  await execute('git', ['-C', root.repo, 'config', '--local', 'orcaops.projectid', projectId], {
    env: root.env,
  });
  const holder = startNode(root, children.registrationBoundary, [
    JSON.stringify({
      cwd: root.repo,
      root: root.dataDir,
      projectId,
      boundary: 'empty-created',
      modules: compiled,
    }),
  ]);
  noteProcess(record, 'initializer holding an uncommitted database', holder.pid);
  await holder.waitFor('stderr', registrationLine, useCeiling(record, 'streamPatternMs'));

  const contender = startCli(root, [
    'init',
    '--yes',
    '--scope',
    'project',
    '--no-session-hooks',
    '--json',
  ]);
  noteProcess(record, 'contended init', contender.pid);
  const wait = await contender.waitFor('stderr', setupWait, useCeiling(record, 'streamPatternMs'));
  record.notes.push(`observed wait: ${wait}`);
  contender.send('SIGINT');
  const cancelled = await contender.exited;
  expect(cancelled.json).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  await expect(access(path.join(root.repo, '.orcaops'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    access(path.join(root.repo, '.git', 'orcaops', 'registration.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });

  holder.send('SIGKILL');
  const killed = await holder.exited;
  expect(killed.signal).toBe('SIGKILL');
  expect(
    await access(path.join(root.dataDir, 'projects', projectId, 'history.sqlite3')).then(
      () => true,
      () => false
    )
  ).toBe(true);
});
