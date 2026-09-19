import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { compareManifests, fileManifest, recordManifest } from './support/manifest.js';
import { measure, noteProcess, scenario } from './support/measurement.js';
import { disposableRoot } from './support/roots.js';
import { seedProject } from './support/seed.js';
import { runCli } from './support/spawn.js';

const execute = promisify(execFile);
const file = 'tests/packaged/refusal.test.ts';

/**
 * A GitHub personal-access-token shape, assembled at runtime so the repository
 * never carries a token-shaped literal for someone else's scanner to find.
 */
const credentialShaped = `${'ghp'}_${'A1b2C3d4E5f6G7h8'.repeat(2)}abcd`;

function planPayload(taskLine: string) {
  return [
    'task: |-',
    `  ${taskLine}`,
    'label: |-',
    '  Packaged refusal probe',
    'plan_steps:',
    '  - text: |-',
    '      observe what the packaged capture persists',
    '    label: |-',
    '      Observe the packaged capture',
    '    acceptance_criteria:',
    '      - text: |-',
    '          the step is delivered',
    'touched_scope: []',
    'non_goals: []',
    '',
  ].join('\n');
}

it('persists nothing when an authored capture payload is refused', async () => {
  const record = scenario('secret refusal before capture', file);
  const root = await disposableRoot('refusal-secret');

  const initialized = await runCli(root, [
    'init',
    '--yes',
    '--scope',
    'personal',
    '--no-session-hooks',
    '--json',
  ]);
  expect(initialized.code, initialized.stderr).toBe(0);

  const beforeData = await fileManifest(root.dataDir);
  const beforeRepository = await fileManifest(root.repo);

  const refused = await measure(record, 'packaged capture with a credential-shaped payload', () =>
    runCli(root, ['capture', 'plan', '--input', '-', '--no-llm', '--invoked-by-agent', 'other'], {
      stdin: planPayload(`describe the deploy step with token: ${credentialShaped}`),
    })
  );
  noteProcess(record, 'refused capture', refused.pid!, {
    code: refused.code,
    signal: refused.signal,
  });
  expect(refused.json).toMatchObject({
    ok: false,
    error: { code: 'SECRET_IN_PAYLOAD', path: 'task' },
  });
  // The refusal names the pattern and the author's label, never the value.
  expect(refused.stdout).not.toContain(credentialShaped);
  record.notes.push(`refusal exit ${refused.code}; envelope ${refused.stdout.trim()}`);

  // Nothing persisted anywhere: no database, no marker, no cache, no artifact
  // directory, no ref, and the history root is untouched.
  expect(compareManifests(beforeData, await fileManifest(root.dataDir))).toEqual({
    database: { created: [], removed: [], changed: [] },
    wal: { created: [], removed: [], changed: [] },
    shm: { created: [], removed: [], changed: [] },
    other: { created: [], removed: [], changed: [] },
  });
  const repositoryDifference = compareManifests(beforeRepository, await fileManifest(root.repo));
  expect(repositoryDifference.database).toEqual({ created: [], removed: [], changed: [] });
  expect(repositoryDifference.other.created.filter((name) => name.includes('artifacts'))).toEqual(
    []
  );
  const refs = await execute('git', ['-C', root.repo, 'for-each-ref', 'refs/orcaops'], {
    env: root.env,
  });
  expect(refs.stdout).toBe('');

  // Positive control: the same shape without the credential is accepted.
  const accepted = await measure(record, 'packaged capture without the credential', () =>
    runCli(root, ['capture', 'plan', '--input', '-', '--no-llm', '--invoked-by-agent', 'other'], {
      stdin: planPayload('describe the deploy step using the token from the environment'),
    })
  );
  noteProcess(record, 'accepted capture', accepted.pid!, {
    code: accepted.code,
    signal: accepted.signal,
  });
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(accepted.json).toMatchObject({ ok: true });

  // The accepted capture reuses the initialized project database and its
  // registration markers. Nothing lands under the cache home or projects.json.
  const data = await fileManifest(root.dataDir);
  const databases = Object.keys(data).filter((name) => name.endsWith('.sqlite3'));
  expect(databases).toHaveLength(1);
  const projectId = path.basename(path.dirname(databases[0]!));
  expect(databases[0]).toBe(path.join('projects', projectId, 'history.sqlite3'));
  expect(
    Object.keys(data).filter((name) => name.startsWith(path.join('projects', 'catalog')))
  ).toEqual([
    path.join('projects', 'catalog'),
    path.join('projects', 'catalog', `${projectId}.json`),
  ]);
  expect(Object.keys(data)).not.toContain('projects.json');
  expect(await fileManifest(root.cacheHome)).toEqual({});

  const registration = await fileManifest(path.join(root.repo, '.git', 'orcaops'));
  expect(Object.keys(registration).sort()).toEqual(
    ['config.json', 'locks', 'personal-manifest.json', 'registration.json', 'worktree.json'].sort()
  );

  // The repository working tree is untouched throughout: everything orcaops wrote
  // lives under .git/orcaops and the history root.
  const status = await execute('git', ['-C', root.repo, 'status', '--short'], { env: root.env });
  expect(status.stdout).toBe('');
  const acceptedRefs = await execute('git', ['-C', root.repo, 'for-each-ref', 'refs/orcaops'], {
    env: root.env,
  });
  record.notes.push(
    `created: ${databases[0]}, projects/catalog/${projectId}.json, .git/orcaops/{registration,worktree}.json; refs: ${acceptedRefs.stdout.trim() || 'none'}`
  );
});

it('records that the packaged digest does not publish into the project database', async () => {
  const record = scenario('coordinator slot: derived index publication', file);
  const root = await disposableRoot('refusal-digest');
  const project = await seedProject(root, { artifacts: 1 });

  const initialized = await runCli(root, [
    'init',
    '--yes',
    '--scope',
    'personal',
    '--no-session-hooks',
    '--json',
  ]);
  expect(initialized.code, initialized.stderr).toBe(0);
  const captured = await runCli(
    root,
    ['capture', 'plan', '--input', '-', '--no-llm', '--invoked-by-agent', 'other'],
    { stdin: planPayload('give the digest something to render') }
  );
  expect(captured.code, captured.stderr).toBe(0);

  const before = recordManifest(project.databasePath);
  const beforeFiles = await fileManifest(root.dataDir);
  const digest = await measure(record, 'orcaops digest', () => runCli(root, ['digest', '--json']));
  noteProcess(record, 'packaged digest', digest.pid!, { code: digest.code, signal: digest.signal });
  record.notes.push(`digest exit ${digest.code}; ${digest.stdout.slice(0, 200)}`);
  // A tripwire that never checks the command ran would keep passing if the digest
  // started failing outright.
  expect(digest.code, digest.stderr).toBe(0);
  expect(digest.json).toMatchObject({ ok: true });

  // The slot: the digest's derived index publication is not in the project
  // database at this base, so the write-sequence staleness property has no
  // packaged surface to observe. This fails once the digest is ported.
  expect(recordManifest(project.databasePath).tables).toEqual(before.tables);
  expect(compareManifests(beforeFiles, await fileManifest(root.dataDir)).database).toEqual({
    created: [],
    removed: [],
    changed: [],
  });
  record.notes.push(
    'SLOT: observe that a derived index publication leaves the write sequence unchanged, and that a comment, evaluator, usage or progress change advances it, once the digest publishes through the project database.'
  );
});
