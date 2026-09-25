import { type ChildProcess, execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  initializeRepositoryDatabase,
  projectDatabasePath,
} from '@orcaops/storage/history/database';

import { inspectDatabaseSetup } from './inspection.js';
import type { DatabaseSetupResult } from './setup.js';
import { setupProjectDatabase } from './setup.js';
import { resolveDatabaseGitContext } from '../context/git-context.js';
import {
  publishProjectCatalogEntry,
  publishRepositoryRegistration,
} from '../registration-files.js';

interface Observation {
  at: number;
  call: string;
  path: string;
  outcome: string;
}
interface Outcome {
  type: 'ready' | 'wait' | 'result' | 'error';
  started: number;
  settled: number;
  result?: DatabaseSetupResult;
  code?: string;
  message?: string;
  chain?: Array<{ name: string; code: string | null; reason: string | null; message: string }>;
  observationCount: number;
  observations: Observation[];
}
interface Initializer {
  ready: Promise<void>;
  parked: Promise<void>;
  progressed: Promise<void>;
  outcome: Promise<Outcome>;
  child: ChildProcess;
}

const exec = promisify(execFile);
interface FixtureConnection {
  exec(sql: string): void;
  close(): void;
  pragma(value: string): unknown;
  prepare(sql: string): { get(...values: unknown[]): unknown };
}
const Database = createRequire(import.meta.resolve('@orcaops/storage'))('better-sqlite3') as {
  new (file: string): FixtureConnection;
};
const roots: string[] = [];
const children: ChildProcess[] = [];

async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  const cause = await run.then(
    () => null,
    (value: unknown) => value
  );
  expect(cause).toBeInstanceOf(Error);
  return cause as { code: string; message: string };
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGCONT');
      child.kill('SIGKILL');
      await exited;
    })
  );
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repository() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'setup-adoption-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await exec('git', ['-C', cwd, 'init', '-q']);
  const root = path.join(directory, 'history');
  const input = {
    cwd,
    root,
    projectId: uuidv7(),
    authoredPayloads: [] as string[],
    secretAllow: [] as string[],
  };
  return { directory, cwd, root, input, watch: [root, path.join(cwd, '.git')] };
}

async function unregistered(
  f: Awaited<ReturnType<typeof repository>>,
  projectId = f.input.projectId
) {
  const context = await resolveDatabaseGitContext({ cwd: f.cwd });
  const authority = {
    ...(await normalizeHistoryRoot({ root: f.root })),
    projectId,
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const initializationOperationId = uuidv7();
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  (
    await initializeRepositoryDatabase({
      authority,
      initializationOperationId,
      initializedAt: new Date().toISOString(),
      repositoryCreation: context.repositoryCreation,
      authorize() {},
    })
  ).close();
  await publishProjectCatalogEntry({ expected: authority, initializationOperationId });
  return { authority, initializationOperationId, context };
}

function start(
  input: object,
  watch: string[],
  options: { barrier?: boolean; boundary?: string } = {}
): Initializer {
  const child = fork(
    fileURLToPath(new URL('./fixtures/adoption-child.mjs', import.meta.url)),
    [
      JSON.stringify({
        input,
        watch,
        ...options,
        module: new URL('../../../dist/history/setup/setup.js', import.meta.url).href,
      }),
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  children.push(child);
  let diagnostics = '';
  let announceParked = (): void => {};
  const parked = new Promise<void>((resolve) => {
    announceParked = resolve;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
    if (diagnostics.includes('PARKED ')) announceParked();
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  let announceReady = (): void => {};
  const ready = new Promise<void>((resolve) => {
    announceReady = resolve;
  });
  // Resolves as soon as the initializer has either reached a verdict or begun waiting
  // for another initializer, so a staged release never depends on a sleep.
  let announceProgress = (): void => {};
  const progressed = new Promise<void>((resolve) => {
    announceProgress = resolve;
  });
  const outcome = new Promise<Outcome>((resolve, reject) => {
    let settled: Outcome | undefined;
    child.on('message', (message) => {
      const value = message as Outcome & { type: string };
      if (value.type === 'ready') announceReady();
      else if (value.type === 'wait') announceProgress();
      else {
        settled = value;
        announceProgress();
      }
    });
    child.on('exit', (code, signal) => {
      announceReady();
      announceParked();
      announceProgress();
      if (settled) resolve(settled);
      else
        reject(
          new Error(`Initializer ended without an outcome (${code}/${signal}) ${diagnostics}`)
        );
    });
  });
  return { ready, parked, progressed, outcome, child };
}

describe('concurrent initializer adoption', () => {
  it('waits for a contended database created after setup inspected a fresh destination', async () => {
    const f = await repository();
    const contender = start(f.input, f.watch, { boundary: 'project-directory' });
    await contender.parked;
    const original = await unregistered(f);
    const holder = new Database(projectDatabasePath(original.authority));
    holder.pragma('locking_mode = EXCLUSIVE');
    holder.exec('BEGIN IMMEDIATE');
    try {
      contender.child.kill('SIGCONT');
      await contender.progressed;
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    const outcome = await contender.outcome;
    expect(outcome.type, JSON.stringify(outcome.chain)).toBe('result');
    expect(outcome.result?.initialization.authority).toEqual(original.authority);
    expect(await setupProjectDatabase(f.input)).toEqual(outcome.result);
  }, 30000);

  it('adopts initialization that commits after its project directory becomes visible', async () => {
    const f = await repository();
    await mkdir(path.join(f.root, 'projects', f.input.projectId), { recursive: true });
    const contender = start(f.input, f.watch);
    await contender.progressed;
    const original = await unregistered(f);
    const winner = await setupProjectDatabase(f.input);
    expect(winner.initialization.authority).toEqual(original.authority);
    expect(await contender.outcome).toMatchObject({ type: 'result', result: winner });
  }, 30000);

  it('preserves missing registered history after waiting for initialization', async () => {
    const f = await repository();
    const winner = await setupProjectDatabase(f.input);
    const file = projectDatabasePath(winner.initialization.authority);
    await rm(file);
    const before = await readdir(path.dirname(file));
    await expect(setupProjectDatabase(f.input)).rejects.toMatchObject({
      code: 'HISTORY_MISSING',
    });
    expect(await readdir(path.dirname(file))).toEqual(before);
  }, 30000);

  it('settles four unstaggered initializers onto one identity without a terminal refusal', async () => {
    const f = await repository();
    // Every initializer loads its modules before any of them is released, so the four
    // reach setup together rather than staggered by their own startup cost.
    const initializers = Array.from({ length: 4 }, () =>
      start(f.input, f.watch, { barrier: true })
    );
    await Promise.all(initializers.map((initializer) => initializer.ready));
    for (const initializer of initializers) initializer.child.send('start');
    const outcomes = await Promise.all(initializers.map((initializer) => initializer.outcome));

    const completed = outcomes.filter((outcome) => outcome.type === 'result');
    const refused = outcomes.filter((outcome) => outcome.type === 'error');
    const logs = process.env.SETUP_ADOPTION_LOG_DIR;
    if (logs)
      await appendFile(
        path.join(logs, 'outcomes.ndjson'),
        JSON.stringify({
          projectId: f.input.projectId,
          completed: completed.length,
          codes: refused.map((outcome) => outcome.code),
          outcomes,
        }) + '\n'
      );

    expect(completed.length).toBeGreaterThanOrEqual(1);
    for (const outcome of completed) expect(outcome.result?.status).toBe('complete');
    // A loser adopts the winner, or reports that the winner has not committed yet. Any
    // other refusal is terminal and denies the contract's promised adoption.
    for (const outcome of refused)
      expect(outcome.code, JSON.stringify(outcome.chain)).toBe('ACTIVATION_PENDING');

    const winner = completed[0]!.result!;
    for (const outcome of completed) expect(outcome.result).toEqual(winner);
    // A refused initializer's explicit retry adopts the same original identity.
    if (refused.length) expect(await setupProjectDatabase(f.input)).toEqual(winner);

    expect(await readdir(path.join(f.cwd, '.git', 'orcaops'))).toContain('registration.json');
    expect(await readdir(path.join(f.root, 'projects', 'catalog'))).toEqual([
      `${f.input.projectId}.json`,
    ]);
    expect(
      (await readdir(path.join(f.root, 'projects'))).filter((name) => name !== 'catalog')
    ).toEqual([f.input.projectId]);
  }, 60000);

  it('waits for registration to resolve several unregistered initializations', async () => {
    const f = await repository();
    const selected = await unregistered(f);
    await unregistered(f, uuidv7());
    let publication: ReturnType<typeof publishRepositoryRegistration> | undefined;
    const result = await setupProjectDatabase(
      {
        cwd: f.cwd,
        root: f.root,
        authoredPayloads: [],
        secretAllow: [],
      },
      {
        onWait() {
          publication ??= publishRepositoryRegistration({
            commonDir: selected.context.commonDir,
            expected: selected.authority,
            initializationOperationId: selected.initializationOperationId,
          });
        },
      }
    );
    await publication;
    expect(result.status).toBe('complete');
    expect(result.initialization.authority).toEqual(selected.authority);
  }, 30000);

  it('adopts a winner whose installation became visible after discovery read the data root', async () => {
    const f = await repository();
    await mkdir(f.root);
    const loser = start(f.input, f.watch, { boundary: 'absent-projects' });
    await loser.parked;
    const winner = start(f.input, f.watch, { boundary: 'before-registration' });
    await winner.parked;
    // The winner has committed its initialization and prepared its marker; the loser is
    // about to answer a data root it last saw empty.
    expect(await readdir(path.join(f.root, 'projects'))).toEqual([f.input.projectId]);
    expect(await readdir(path.join(f.cwd, '.git', 'orcaops'))).not.toContain('registration.json');

    loser.child.kill('SIGCONT');
    // The winner stays parked until the loser has answered the half-published
    // installation, so the loser's classification is the one under test.
    await loser.progressed;
    winner.child.kill('SIGCONT');
    const [winnerOutcome, loserOutcome] = await Promise.all([winner.outcome, loser.outcome]);
    const logs = process.env.SETUP_ADOPTION_LOG_DIR;
    if (logs)
      await appendFile(
        path.join(logs, 'staged.ndjson'),
        JSON.stringify({
          staging: 'installation visible after discovery',
          winner: winnerOutcome,
          loser: loserOutcome,
        }) + '\n'
      );
    expect(winnerOutcome.result?.status).toBe('complete');
    expect(loserOutcome.type).toBe('result');
    expect(loserOutcome.result).toEqual(winnerOutcome.result);
  }, 60000);

  it('keeps the conversion path for a checkout store holding legacy history', async () => {
    const f = await repository();
    const occupied = path.join(f.cwd, '.orcaops/artifacts/legacy/events.ndjson');
    await mkdir(path.dirname(occupied), { recursive: true });
    await writeFile(occupied, '{}');
    await writeFile(path.join(f.cwd, '.orcaops/config.json'), '{}');
    await expect(setupProjectDatabase(f.input)).rejects.toMatchObject({
      code: 'CONVERSION_REQUIRED',
    });
    // Refusing before any write-capable step leaves the requested data root uncreated.
    await expect(readdir(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30000);

  it('starts history beside a committed project configuration', async () => {
    const f = await repository();
    await mkdir(path.join(f.cwd, '.orcaops'));
    await writeFile(path.join(f.cwd, '.orcaops/config.json'), '{}');
    await writeFile(path.join(f.cwd, '.orcaops/install.json'), '{}');
    const result = await setupProjectDatabase(f.input);
    expect(result.status).toBe('complete');
    expect(await readdir(f.root)).toContain('projects');
  }, 30000);

  // The conversion gate protects legacy history; a file under .git/orcaops is
  // configuration, so it never forces the conversion path on its own.
  it('starts history beside a retained administrative file', async () => {
    const f = await repository();
    const occupied = path.join(f.cwd, '.git/orcaops/authority.json');
    await mkdir(path.dirname(occupied), { recursive: true });
    await writeFile(occupied, '{}');
    const result = await setupProjectDatabase(f.input);
    expect(result.status).toBe('complete');
    expect(await readdir(f.root)).toContain('projects');
  }, 30000);

  it('proceeds beside a preserved catalog publication temporary and refuses a foreign name', async () => {
    const f = await repository();
    const c = await unregistered(f);
    const catalog = path.join(f.root, 'projects', 'catalog');
    const leftover = path.join(catalog, `.${uuidv7()}.json.${uuidv7()}.${randomUUID()}.tmp`);
    await writeFile(leftover, 'interrupted publication');
    const foreign = path.join(catalog, 'foreign.json.tmp');
    await writeFile(foreign, 'not ours');

    await expect(setupProjectDatabase(f.input)).rejects.toMatchObject({
      code: 'IDENTITY_RECOVERY_REQUIRED',
    });
    await rm(foreign);

    // With only the publisher's own leftover left, discovery adopts the retained
    // initialization and setup completes; the leftover is never read or removed.
    const result = await setupProjectDatabase(f.input);
    expect(result.status).toBe('complete');
    expect(result.initialization.initializationOperationId).toBe(c.initializationOperationId);
    expect(await readFile(leftover, 'utf8')).toBe('interrupted publication');
    expect((await readdir(catalog)).sort()).toEqual(
      [`${f.input.projectId}.json`, path.basename(leftover)].sort()
    );
  }, 30000);

  it('publishes a catalog retry through a new temporary and preserves the earlier leftover', async () => {
    const f = await repository();
    const c = await unregistered(f);
    const catalog = path.join(f.root, 'projects', 'catalog');
    const entry = path.join(catalog, `${f.input.projectId}.json`);
    const published = JSON.parse(await readFile(entry, 'utf8')) as Record<string, unknown>;
    // What an interrupted publication of this very operation leaves behind.
    const leftover = path.join(
      catalog,
      `.${f.input.projectId}.json.${c.initializationOperationId}.${randomUUID()}.tmp`
    );
    await writeFile(leftover, 'interrupted publication');

    const retry = await publishProjectCatalogEntry({
      expected: c.authority,
      initializationOperationId: c.initializationOperationId,
    });
    expect(retry.publication).toBe('existing');
    expect(retry.entry).toEqual(published);
    expect(JSON.parse(await readFile(entry, 'utf8'))).toEqual(published);
    // The retry published through its own temporary; the leftover is neither reused nor removed.
    expect(await readFile(leftover, 'utf8')).toBe('interrupted publication');
    expect((await readdir(catalog)).sort()).toEqual(
      [`${f.input.projectId}.json`, path.basename(leftover)].sort()
    );
  }, 30000);

  it('refuses a foreign project occupying the requested identity without waiting', async () => {
    const first = await repository();
    const owner = await setupProjectDatabase(first.input);
    // A second repository asking for the first repository's project id in the same root.
    const second = await repository();
    const contender = { ...second.input, root: first.root, projectId: first.input.projectId };
    const started = performance.now();
    const failure = await refusal(setupProjectDatabase(contender));
    expect(failure.code).toBe('CONVERSION_REQUIRED');
    // A foreign project is a settled fact, so nothing waits on it and nothing is created.
    expect(performance.now() - started).toBeLessThan(1500);
    expect(await readdir(path.join(first.root, 'projects', 'catalog'))).toEqual([
      `${first.input.projectId}.json`,
    ]);
    expect(
      (await readdir(path.join(first.root, 'projects'))).filter((name) => name !== 'catalog')
    ).toEqual([first.input.projectId]);
    await expect(readdir(path.join(second.cwd, '.git', 'orcaops'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await setupProjectDatabase(first.input)).toEqual(owner);
  }, 30000);

  it('reports what the exhausted wait observed rather than a generic collision', async () => {
    const f = await repository();
    const marker = path.join(f.cwd, '.git', 'orcaops', 'registration.json');
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, '{}');
    const observed = await refusal(
      inspectDatabaseSetup({ cwd: f.cwd, root: f.root, projectId: f.input.projectId })
    );
    expect(observed.code).toBe('ACTIVATION_PENDING');

    const failure = await refusal(setupProjectDatabase(f.input));
    expect(failure.code).toBe('ACTIVATION_PENDING');
    expect(failure.message).toBe(observed.message);
    expect(failure.message).not.toContain('A collided initialization has not committed');
    expect(await readFile(marker, 'utf8')).toBe('{}');
  }, 30000);

  it('refuses a corrupt canonical database without waiting for it or replacing it', async () => {
    const f = await repository();
    const winner = await setupProjectDatabase(f.input);
    const file = projectDatabasePath(winner.initialization.authority);
    await writeFile(file, 'not a database');
    const started = performance.now();
    await expect(setupProjectDatabase(f.input)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    // An unavailable reason that is not contention never enters the bounded wait.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await readFile(file, 'utf8')).toBe('not a database');
  }, 30000);

  it('waits for a contended canonical database instead of refusing the requested setup', async () => {
    const f = await repository();
    const winner = await setupProjectDatabase(f.input);
    const holder = new Database(projectDatabasePath(winner.initialization.authority));
    holder.pragma('locking_mode = EXCLUSIVE');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('SELECT 1').get();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      holder.exec('ROLLBACK');
      holder.close();
    };
    try {
      // Passive inspection reports the contention it actually observed.
      await expect(
        inspectDatabaseSetup({ cwd: f.cwd, root: f.root, projectId: f.input.projectId })
      ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE', reason: 'contention' });
      const timer = setTimeout(release, 400);
      expect(await setupProjectDatabase(f.input)).toEqual(winner);
      clearTimeout(timer);
    } finally {
      release();
    }
  }, 60000);
});
