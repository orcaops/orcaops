import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import {
  authoritativelyUnchanged,
  compareEnvironments,
  environmentManifest,
  nothingAuthoritativeMoved,
} from './support/environment.js';
import { compareManifests, fileManifest, recordManifest } from './support/manifest.js';
import { measure, noteProcess, scenario, useCeiling } from './support/measurement.js';
import { children } from './support/paths.js';
import { type DisposableRoot, disposableRoot } from './support/roots.js';
import { runCli, startCli } from './support/spawn.js';

const execute = promisify(execFile);
const file = 'tests/packaged/initialization.test.ts';
const linkLine = /PACKAGED_GATE_LINK (\{.*\})/;
const publishLine = /PACKAGED_GATE_PUBLISH (\{.*\})/;

const capturePlan = ['capture', 'plan', '--input', '-', '--no-llm', '--invoked-by-agent', 'other'];
const initArgs = ['init', '--yes', '--scope', 'personal', '--no-session-hooks', '--json'];

function planPayload(label: string, idempotencyKey: string) {
  return [
    `idempotency_key: ${idempotencyKey}`,
    'task: |-',
    `  initialize the project store as ${label}`,
    'label: |-',
    `  ${label}`,
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
  ].join('\n');
}

/**
 * A pending state the caller is told to retry. Anything else is a terminal
 * refusal: the race must not leave a participant with no way forward.
 */
const retryablePending = ['ACTIVATION_PENDING'];

const envelopeError = (outcome: { json: unknown }) =>
  (outcome.json as { ok?: boolean; error?: { code?: string } } | null)?.error?.code ?? null;

async function historyContents(root: DisposableRoot) {
  const data = await fileManifest(root.dataDir);
  const databases = Object.keys(data).filter((name) => name.endsWith('.sqlite3'));
  const catalog = Object.keys(data).filter(
    (name) => name.startsWith(path.join('projects', 'catalog')) && name.endsWith('.json')
  );
  const markers = Object.keys(await fileManifest(path.join(root.repo, '.git', 'orcaops'))).filter(
    (name) => name === 'registration.json' || name === 'worktree.json'
  );
  return { databases, catalog, markers };
}

it('resolves four unstaggered packaged captures and a concurrent init onto one project', async () => {
  const record = scenario('packaged initialization race', file);
  const root = await disposableRoot('packaged-init-race');

  // No init: the repository is entirely fresh, so every participant races to
  // initialize the store through its own capture.
  expect(await historyContents(root)).toEqual({ databases: [], catalog: [], markers: [] });

  const keys = Array.from(
    { length: 4 },
    (_, index) => `01a08000-0000-7000-8000-0000000000${(index + 10).toString().padStart(2, '0')}`
  );
  const racing = keys.map((key, index) =>
    startCli(root, capturePlan, {
      env: { CLAUDE_SESSION_ID: `${root.shellKey}-race-${index}` },
      stdin: planPayload(`racer ${index}`, key),
    })
  );
  for (const handle of racing) noteProcess(record, 'racing packaged capture', handle.pid);

  // A fifth participant runs `init` first, concurrently with the four captures.
  const initializing = startCli(root, initArgs, {
    env: { CLAUDE_SESSION_ID: `${root.shellKey}-init` },
  });
  noteProcess(record, 'concurrent orcaops init', initializing.pid);

  const settled = await measure(record, 'four captures and one init settle', () =>
    Promise.all(racing.map((handle) => handle.exited))
  );
  const initialized = await initializing.exited;
  noteProcess(record, 'concurrent init result', initialized.pid!, {
    code: initialized.code,
    signal: initialized.signal,
  });
  expect(initialized.code, initialized.stderr).toBe(0);

  const afterInitKey = '01a08000-0000-7000-8000-000000000099';
  const afterInit = await measure(record, 'capture after the concurrent init', () =>
    runCli(root, capturePlan, {
      env: { CLAUDE_SESSION_ID: `${root.shellKey}-init` },
      stdin: planPayload('after init', afterInitKey),
    })
  );
  noteProcess(record, 'capture after init', afterInit.pid!, {
    code: afterInit.code,
    signal: afterInit.signal,
  });

  const outcomes = [...settled, afterInit];
  for (const outcome of outcomes)
    noteProcess(record, 'settled participant', outcome.pid!, {
      code: outcome.code,
      signal: outcome.signal,
    });
  record.notes.push(
    `outcomes: ${outcomes
      .map((outcome) => `${outcome.code}:${envelopeError(outcome) ?? 'ok'}`)
      .join(', ')}`
  );

  // No terminal refusal: every participant either completed or was told to retry.
  const completed = new Set<string>();
  const pending: string[] = [];
  outcomes.forEach((outcome, index) => {
    const code = envelopeError(outcome);
    if (outcome.code === 0 && code === null) {
      completed.add((outcome.json as { artifact_id: string }).artifact_id);
      return;
    }
    expect(
      retryablePending,
      `participant ${index} refused terminally with ${String(code)}: ${outcome.stderr.trim() || outcome.stdout.trim()}`
    ).toContain(code);
    pending.push([...keys, afterInitKey][index]!);
  });
  record.retries.pendingParticipants = pending.length;

  // Every pending participant completes on a retry under the same key.
  for (const key of pending) {
    const retried = await measure(record, 'retry a pending participant', () =>
      runCli(root, capturePlan, { stdin: planPayload('retried', key) })
    );
    noteProcess(record, 'retried participant', retried.pid!, {
      code: retried.code,
      signal: retried.signal,
    });
    expect(retried.code, retried.stderr).toBe(0);
    completed.add((retried.json as { artifact_id: string }).artifact_id);
  }

  // Exactly one adopted project: one catalog entry and one marker pair. The
  // observed contents are recorded before the assertions so a failure always
  // leaves the exact paths behind, not just a count.
  const contents = await historyContents(root);
  record.notes.push(`history contents: ${JSON.stringify(contents)}`);
  expect(contents.catalog).toHaveLength(1);
  expect(contents.markers.sort()).toEqual(['registration.json', 'worktree.json']);
  const adopted = path.basename(contents.catalog[0]!, '.json');
  expect(contents.databases).toContain(path.join('projects', adopted, 'history.sqlite3'));

  // Every participant's history is in that one adopted project.
  const manifest = recordManifest(path.join(root.dataDir, 'projects', adopted, 'history.sqlite3'));
  expect(manifest.integrityCheck).toBe('ok');
  expect(manifest.foreignKeyCheck).toEqual([]);
  expect(manifest.tables.artifacts).toHaveLength(completed.size);
  for (const artifactId of completed)
    expect(
      manifest.tables.artifacts!.filter((row) => row.startsWith(`text:'${artifactId}'|`))
    ).toHaveLength(1);

  // Any other project directory is a losing initializer's candidate store. The
  // approved gate wording tolerates an unused loser database; what it must not be
  // is used, so each one must hold no history and own no catalog entry.
  const losers = contents.databases.filter(
    (name) => name !== path.join('projects', adopted, 'history.sqlite3')
  );
  for (const loser of losers) {
    const loserId = path.basename(path.dirname(loser));
    expect(contents.catalog).not.toContain(path.join('projects', 'catalog', `${loserId}.json`));
    expect(recordManifest(path.join(root.dataDir, loser)).tables.artifacts).toEqual([]);
  }
  record.notes.push(
    `adopted ${adopted} with ${completed.size} artifacts; unused loser stores: ${losers.length}`
  );
});

it('never exposes a partial registration marker when a packaged capture is killed before the hard link', async () => {
  const record = scenario('packaged capture killed before the registration hard link', file);
  const root = await disposableRoot('packaged-init-link');
  const key = '01a08000-0000-7000-8000-0000000000aa';

  const doomed = startCli(root, capturePlan, {
    stdin: planPayload('killed before link', key),
    env: { PACKAGED_GATE_LINK_BOUNDARY: '1' },
    nodeArgs: ['--import', children.linkBoundary],
  });
  noteProcess(record, 'capture parked before the hard link', doomed.pid);
  const marker = await doomed.waitFor('stderr', linkLine, useCeiling(record, 'streamPatternMs'));
  const detail = JSON.parse(linkLine.exec(marker)![1]!) as { temporary: string; final: string };
  record.notes.push(`parked before linking ${path.basename(detail.final)}`);

  // The temporary carries complete bytes; the final name does not exist.
  const retained = await readFile(detail.temporary);
  expect(retained.length).toBeGreaterThan(0);
  await expect(stat(detail.final)).rejects.toMatchObject({ code: 'ENOENT' });

  doomed.send('SIGKILL');
  const killed = await measure(record, 'SIGKILL before the hard link', () => doomed.exited);
  noteProcess(record, 'killed capture', killed.pid!, { code: killed.code, signal: killed.signal });
  expect(killed.signal).toBe('SIGKILL');
  await expect(stat(detail.final)).rejects.toMatchObject({ code: 'ENOENT' });

  // An authorized retry publishes the marker and adopts.
  const retried = await measure(record, 'retry after the kill', () =>
    runCli(root, capturePlan, { stdin: planPayload('retried after link kill', key) })
  );
  noteProcess(record, 'retried capture', retried.pid!, {
    code: retried.code,
    signal: retried.signal,
  });
  expect(retried.code, retried.stderr).toBe(0);
  const published = await readFile(detail.final);
  expect(published.equals(retained)).toBe(true);

  // The unknown leftover temporary stays protected rather than being cleaned up.
  const directory = await readdir(path.dirname(detail.final));
  expect(directory).toContain(path.basename(detail.temporary));
  expect(directory).toContain(path.basename(detail.final));
  record.notes.push(`marker directory after the retry: ${directory.sort().join(', ')}`);
});

it('leaves the whole authoritative inventory unchanged across a same-key capture replay', async () => {
  const record = scenario('same-key capture replay is inert', file);
  const root = await disposableRoot('packaged-replay');
  const key = '01a08000-0000-7000-8000-0000000000bb';

  const first = await measure(record, 'first capture under the key', () =>
    runCli(root, capturePlan, { stdin: planPayload('replayed', key) })
  );
  noteProcess(record, 'first capture', first.pid!, { code: first.code, signal: first.signal });
  expect(first.code, first.stderr).toBe(0);
  const artifactId = (first.json as { artifact_id: string }).artifact_id;

  const data = await fileManifest(root.dataDir);
  const databaseFile = path.join(
    root.dataDir,
    Object.keys(data).find((name) => name.endsWith('.sqlite3'))!
  );
  const before = recordManifest(databaseFile);
  const beforeEnvironment = await environmentManifest(root);

  const replayed = await measure(record, 'replay under the same key', () =>
    runCli(root, capturePlan, { stdin: planPayload('replayed', key) })
  );
  noteProcess(record, 'replayed capture', replayed.pid!, {
    code: replayed.code,
    signal: replayed.signal,
  });
  expect(replayed.code, replayed.stderr).toBe(0);
  expect(replayed.json).toMatchObject({ ok: true, artifact_id: artifactId });

  // A replay resolves to the retained result. It must therefore change nothing
  // authoritative: the same payload under the same key is not new history.
  const after = recordManifest(databaseFile);
  const moved = Object.keys(after.tables).filter(
    (name) => JSON.stringify(after.tables[name]) !== JSON.stringify(before.tables[name])
  );
  record.notes.push(`tables that moved across the replay: ${moved.join(', ') || 'none'}`);
  expect(moved).toEqual([]);
  expect(
    authoritativelyUnchanged(
      compareEnvironments(beforeEnvironment, await environmentManifest(root))
    )
  ).toEqual(nothingAuthoritativeMoved);
});

it('leaves the created store unregistered and untouched when a packaged capture is killed before registration publishes', async () => {
  const record = scenario('packaged capture killed before registration publishes', file);
  const root = await disposableRoot('packaged-init-publish');
  const key = '01a08000-0000-7000-8000-0000000000cc';
  const markerDirectory = path.join(root.repo, '.git', 'orcaops');
  const catalogDirectory = path.join(root.dataDir, 'projects', 'catalog');

  const doomed = startCli(root, capturePlan, {
    stdin: planPayload('killed before registration', key),
    env: { PACKAGED_GATE_PUBLISH_BOUNDARY: '1' },
    nodeArgs: ['--import', children.publishBoundary],
  });
  noteProcess(record, 'capture parked before registration publishes', doomed.pid);
  const marker = await doomed.waitFor('stderr', publishLine, useCeiling(record, 'streamPatternMs'));
  record.notes.push(`parked at ${JSON.parse(publishLine.exec(marker)![1]!).file}`);

  // At the boundary the database exists and nothing has been published.
  const atBoundary = await historyContents(root);
  record.notes.push(`at the boundary: ${JSON.stringify(atBoundary)}`);
  expect(atBoundary.databases).toHaveLength(1);
  expect(atBoundary.catalog).toEqual([]);
  expect(atBoundary.markers).toEqual([]);
  const orphan = path.join(root.dataDir, atBoundary.databases[0]!);
  const beforeKill = await fileManifest(path.dirname(orphan));
  const beforeEnvironment = await environmentManifest(root);

  doomed.send('SIGKILL');
  const killed = await measure(
    record,
    'SIGKILL before registration publishes',
    () => doomed.exited
  );
  noteProcess(record, 'killed capture', killed.pid!, { code: killed.code, signal: killed.signal });
  expect(killed.signal).toBe('SIGKILL');
  expect(killed.stdout).toBe('');

  // No partial registration is visible: no marker, no catalog entry, and no
  // half-written file left under either directory.
  const afterKill = await historyContents(root);
  record.notes.push(`after the kill: ${JSON.stringify(afterKill)}`);
  expect(afterKill.markers).toEqual([]);
  expect(afterKill.catalog).toEqual([]);
  expect(Object.keys(await fileManifest(catalogDirectory))).toEqual([]);
  expect(
    Object.keys(await fileManifest(markerDirectory)).filter((name) =>
      name.includes('registration.json')
    )
  ).toEqual([]);

  // The created-but-unregistered store is left in place and untouched: unknown
  // ownership is protected, never deleted and never silently adopted.
  const afterKillFiles = await fileManifest(path.dirname(orphan));
  const difference = compareManifests(beforeKill, afterKillFiles);
  expect(difference.database).toEqual({ created: [], removed: [], changed: [] });
  expect(difference.other).toEqual({ created: [], removed: [], changed: [] });
  await expect(stat(orphan)).resolves.toBeTruthy();

  // Across the kill itself nothing authoritative moved anywhere, refs included.
  const acrossKill = compareEnvironments(beforeEnvironment, await environmentManifest(root));
  expect(authoritativelyUnchanged(acrossKill)).toEqual(nothingAuthoritativeMoved);
  expect(acrossKill.refsChanged).toBe(false);

  // The retry under the original key completes and registers exactly one project.
  const retried = await measure(record, 'retry after the kill', () =>
    runCli(root, capturePlan, { stdin: planPayload('retried before registration', key) })
  );
  noteProcess(record, 'retried capture', retried.pid!, {
    code: retried.code,
    signal: retried.signal,
  });
  expect(retried.code, retried.stderr).toBe(0);

  const settled = await historyContents(root);
  record.notes.push(`after the retry: ${JSON.stringify(settled)}`);
  expect(settled.catalog).toHaveLength(1);
  expect(settled.markers.sort()).toEqual(['registration.json', 'worktree.json']);
  const adopted = path.basename(settled.catalog[0]!, '.json');
  const adoptedFile = path.join(root.dataDir, 'projects', adopted, 'history.sqlite3');
  const adoptedManifest = recordManifest(adoptedFile);
  expect(adoptedManifest.integrityCheck).toBe('ok');
  expect(adoptedManifest.tables.artifacts).toHaveLength(1);

  // Whether the retry adopted the killed process's store or left it as a loser is
  // recorded, not assumed. A surviving loser must hold no history and own no
  // catalog entry, which is what the approved wording tolerates.
  const adoptedTheOrphan = adoptedFile === orphan;
  record.notes.push(
    adoptedTheOrphan
      ? `the retry adopted the store the killed process created (${adopted})`
      : `the retry created ${adopted}; the killed process's store survives as a loser`
  );
  for (const database of settled.databases) {
    const candidate = path.join(root.dataDir, database);
    if (candidate === adoptedFile) continue;
    const loserId = path.basename(path.dirname(database));
    expect(settled.catalog).not.toContain(path.join('projects', 'catalog', `${loserId}.json`));
    expect(recordManifest(candidate).tables.artifacts).toEqual([]);
  }

  // Nothing else authoritative moved across the whole window: the config and
  // state homes are exactly as they were at the boundary. Publication refs DO
  // change, because the retry is a successful capture and publishes its own
  // retention; that is the registration this scenario asked for, not a stray
  // mutation, so the refs are recorded rather than frozen.
  const acrossWindow = compareEnvironments(beforeEnvironment, await environmentManifest(root));
  const still = { created: [], removed: [], changed: [] };
  for (const area of ['config', 'state'] as const)
    for (const bucket of ['database', 'wal', 'shm', 'other'] as const)
      expect(acrossWindow[area][bucket], `${area}.${bucket}`).toEqual(still);
  const refs = await execute('git', ['-C', root.repo, 'for-each-ref', 'refs/orcaops'], {
    env: root.env,
  });
  record.notes.push(
    `refs after the retry: ${refs.stdout.trim().split('\n').filter(Boolean).length} under refs/orcaops`
  );
});
