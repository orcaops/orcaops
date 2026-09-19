import { type ChildProcess, execFile, fork } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

import { CapturePlanInputSchema } from '@orcaops/storage';
import {
  openProjectDatabase,
  planCaptureCommand,
  preparePlanCaptureInput,
  type ProjectDatabase,
  readProjectArtifact,
  readProjectExecution,
  readProjectPlanCapture,
} from '@orcaops/storage/history/database';

import {
  captureDatabasePlan,
  type DatabasePlanCaptureInput,
  type DatabasePlanCaptureResult,
} from './plan.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    })
  );
  handles.splice(0).forEach((handle) => handle.close());
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const result = await execute('git', ['-C', cwd, ...args], {
    env: {
      ...env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
    },
    timeout: 10_000,
  });
  return result.stdout.trim();
}
function input(enabled = false): DatabasePlanCaptureInput {
  return {
    authored: CapturePlanInputSchema.parse({
      idempotency_key: 'registered:original-plan',
      task: 'Retain the original registered capture',
      label: 'Registered capture',
      plan_steps: [
        {
          text: 'Preserve original input',
          label: 'Preserve input',
          acceptance_criteria: [{ text: 'The original request bytes survive a retry' }],
        },
      ],
    }),
    sourcePlan: null,
    agent: 'codex',
    snapshot: { enabled, excludePatterns: [] },
    secretAllow: [],
  };
}
async function fixture(borrowed = false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'registered-plan-')));
  roots.push(directory);
  let cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await writeFile(path.join(cwd, 'retained.txt'), 'Committed contents\n');
  await git(cwd, 'add', 'retained.txt');
  await git(cwd, 'commit', '-qm', 'Original fixture');
  if (borrowed) {
    const clone = path.join(directory, 'borrowed');
    await git(directory, 'clone', '-q', '--shared', cwd, clone);
    cwd = clone;
  }
  const root = path.join(directory, 'history');
  const setup = await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: [input().authored],
    secretAllow: [],
  });
  expect(setup.status).toBe('complete');
  const context = await requireDatabaseExecutionContext({ cwd, root });
  const handle = await openProjectDatabase({ authority: context.authority, mode: 'writer' });
  handles.push(handle);
  return { directory, cwd, root, context, handle };
}
function state(handle: ProjectDatabase) {
  return handle.read((view) => ({
    commands: view.all(
      'SELECT idempotency_key, artifact_id, hex(request_bytes) AS request_bytes FROM plan_capture_commands'
    ),
    operations: view.all('SELECT * FROM operations'),
    artifacts: view.all('SELECT * FROM artifacts'),
    publications: view.all('SELECT * FROM git_retention_publications'),
  }));
}
function publication(handle: ProjectDatabase) {
  return handle.read((view) =>
    view.get<{ full_ref: string; object_oid: string; tree_oid: string }>(
      'SELECT full_ref, object_oid, tree_oid FROM git_retention_publications'
    )
  ).value!;
}

it('replays the original direct receipt before observing a changed registered branch', async () => {
  const f = await fixture();
  const authored = input();
  const first = await captureDatabasePlan(f.handle, f.context, authored);
  expect(first).toMatchObject({ replayed: false, historical: false, warnings: [] });
  expect(readProjectArtifact(f.handle, first.artifactId)?.thread.plan?.task).toBe(
    authored.authored.task
  );
  expect(readProjectExecution(f.handle, first.artifactId)).toBeTruthy();
  const before = state(f.handle);
  await git(f.cwd, 'checkout', '-qb', 'changed');
  const replay = await captureDatabasePlan(f.handle, f.context, input(true));
  expect(replay).toMatchObject({ artifactId: first.artifactId, planEventId: first.planEventId });
  expect(replay.publication).toEqual({ ...first.publication, replayed: true });
  await expect(
    captureDatabasePlan(f.handle, f.context, {
      ...authored,
      authored: { ...authored.authored, task: 'Different authored request' },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(state(f.handle)).toEqual(before);
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops')).toBe('');
}, 20_000);

function contender(repository: { cwd: string; root: string }) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/plan-child.mjs', import.meta.url)),
    [
      JSON.stringify({
        repository,
        input: input(),
        contextModule: new URL('../../../dist/history/context/execution.js', import.meta.url).href,
        captureModule: new URL('../../../dist/history/capture/plan.js', import.meta.url).href,
        storageModule: new URL(
          '../../../../storage/dist/history/database/index.js',
          import.meta.url
        ).href,
      }),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
    }
  );
  children.push(child);
  type Message = {
    type: string;
    result?: DatabasePlanCaptureResult;
    code?: string;
    message?: string;
    wait?: unknown;
  };
  const messages: Message[] = [];
  const listeners = new Set<() => void>();
  let diagnostics = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  child.on('message', (message) => {
    messages.push(message as Message);
    listeners.forEach((listener) => listener());
  });
  child.on('exit', () => listeners.forEach((listener) => listener()));
  const wait = (type: string) =>
    new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(
            new Error(`Timed out waiting for ${type}: ${JSON.stringify(messages)} ${diagnostics}`)
          ),
        10_000
      );
      function finish(error?: Error, result?: Message) {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error);
        else resolve(result!);
      }
      function check() {
        const found = messages.find((message) => message.type === type);
        if (found) finish(undefined, found);
        else if (
          messages.some((message) => message.type === 'error') ||
          child.exitCode !== null ||
          child.signalCode !== null
        )
          finish(
            new Error(`Child ended before ${type}: ${JSON.stringify(messages)} ${diagnostics}`)
          );
      }
      listeners.add(check);
      check();
    });
  return { child, wait };
}

it('settles one original plan when independent writers wait on the same database', async () => {
  const f = await fixture();
  const before = state(f.handle);
  const first = contender(f);
  const second = contender(f);
  await Promise.all([first.wait('ready'), second.wait('ready')]);
  const Database = createRequire(import.meta.resolve('@orcaops/storage'))('better-sqlite3') as new (
    file: string
  ) => { exec(sql: string): void; close(): void };
  const blocker = new Database(f.handle.databasePath);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    first.child.send('start');
    second.child.send('start');
    const waits = await Promise.all([first.wait('wait'), second.wait('wait')]);
    expect(waits.map((message) => message.wait)).toEqual([
      expect.objectContaining({ operation: expect.any(String) }),
      expect.objectContaining({ operation: expect.any(String) }),
    ]);
    blocker.exec('COMMIT');
    const results = (await Promise.all([first.wait('result'), second.wait('result')])).map(
      (message) => message.result!
    );
    expect(new Set(results.map((result) => result.artifactId)).size).toBe(1);
    expect(new Set(results.map((result) => result.planEventId)).size).toBe(1);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    const rows = state(f.handle);
    expect(rows.value.commands).toHaveLength(before.value.commands.length + 1);
    expect(rows.value.artifacts).toHaveLength(before.value.artifacts.length + 1);
    expect(rows.value.operations).toHaveLength(before.value.operations.length + 1);
    expect(rows.value.operations).toEqual(expect.arrayContaining(before.value.operations));
    expect(rows.value.publications).toEqual(before.value.publications);
    expect(rows.counters).toEqual({
      writeSequence: before.counters.writeSequence + 1,
      intentChangeCounter: before.counters.intentChangeCounter + 1,
    });
    expect(f.handle.read((view) => view.all('SELECT event_id FROM artifact_events')).value).toEqual(
      [{ event_id: results[0]!.planEventId }]
    );
    const replay = await captureDatabasePlan(f.handle, f.context, input());
    expect(replay).toMatchObject({ artifactId: results[0]!.artifactId, replayed: true });
    expect(state(f.handle)).toEqual(rows);
  } finally {
    blocker.close();
  }
}, 25_000);

it('publishes the exact working tree baseline and settles its plan atomically', async () => {
  const f = await fixture();
  const before = state(f.handle);
  await writeFile(path.join(f.cwd, 'retained.txt'), 'Selected working contents\n');
  const first = await captureDatabasePlan(f.handle, f.context, input(true));
  expect(first.warnings).toEqual([]);
  const ref = publication(f.handle);
  expect(await git(f.cwd, 'rev-parse', ref.full_ref)).toBe(ref.object_oid);
  expect(await git(f.cwd, 'rev-parse', `${ref.object_oid}^{tree}`)).toBe(ref.tree_oid);
  expect(await git(f.cwd, 'show', `${ref.object_oid}:retained.txt`)).toBe(
    'Selected working contents'
  );
  expect(
    readProjectArtifact(f.handle, first.artifactId)?.thread.artifactJson?.baseline_seed_tree_sha
  ).toBe(ref.tree_oid);
  expect(state(f.handle).counters).toEqual({
    writeSequence: before.counters.writeSequence + 2,
    intentChangeCounter: before.counters.intentChangeCounter + 1,
  });
  const captured = state(f.handle);
  await git(f.cwd, 'checkout', '-qb', 'later');
  const replay = await captureDatabasePlan(f.handle, f.context, input(true));
  expect(replay.publication).toEqual({ ...first.publication, replayed: true });
  expect(state(f.handle)).toEqual(captured);
}, 20_000);

it('resumes retained snapshot input after explicit ref-directory permission repair', async () => {
  const f = await fixture();
  const before = state(f.handle);
  const refs = path.join(f.cwd, '.git', 'refs', 'orcaops');
  await mkdir(refs);
  await writeFile(path.join(f.cwd, 'retained.txt'), 'Original pending contents\n');
  await chmod(refs, 0o555);
  try {
    await expect(captureDatabasePlan(f.handle, f.context, input(true))).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
    });
  } finally {
    await chmod(refs, 0o755);
  }
  const originalInput = input();
  const found = readProjectPlanCapture(
    f.handle,
    preparePlanCaptureInput(
      { authored: originalInput.authored, sourcePlan: originalInput.sourcePlan },
      []
    )
  );
  expect(found?.kind).toBe('command');
  if (found?.kind !== 'command') throw new Error('Original command missing');
  const original = planCaptureCommand(found.command);
  expect(readProjectArtifact(f.handle, original.artifactId)).toBeNull();
  const pending = publication(f.handle);
  expect(state(f.handle).counters).toEqual({
    writeSequence: before.counters.writeSequence + 1,
    intentChangeCounter: before.counters.intentChangeCounter,
  });
  await writeFile(path.join(f.cwd, 'retained.txt'), 'Later uncommitted contents\n');
  const recovered = await captureDatabasePlan(f.handle, f.context, input(true));
  expect(recovered.artifactId).toBe(original.artifactId);
  expect(recovered.replayed).toBe(true);
  expect(publication(f.handle)).toEqual(pending);
  expect(await git(f.cwd, 'show', `${pending.full_ref}:retained.txt`)).toBe(
    'Original pending contents'
  );
  expect(state(f.handle).counters).toEqual({
    writeSequence: before.counters.writeSequence + 2,
    intentChangeCounter: before.counters.intentChangeCounter + 1,
  });
}, 25_000);

it('retains a degraded plan without claiming a baseline for a borrowed object store', async () => {
  const f = await fixture(true);
  const before = state(f.handle);
  const result = await captureDatabasePlan(f.handle, f.context, input(true));
  expect(result.warnings).toEqual([
    'Plan baseline snapshot is unavailable; empty-fence seed recovery has no baseline.',
  ]);
  expect(
    readProjectArtifact(f.handle, result.artifactId)?.thread.artifactJson?.baseline_seed_tree_sha
  ).toBeNull();
  expect(state(f.handle).value.publications).toEqual([]);
  expect(state(f.handle).counters).toEqual({
    writeSequence: before.counters.writeSequence + 1,
    intentChangeCounter: before.counters.intentChangeCounter + 1,
  });
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops')).toBe('');
}, 20_000);
