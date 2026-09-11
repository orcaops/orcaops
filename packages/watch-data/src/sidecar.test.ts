import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import type { WatchSnapshot } from './types.js';
import {
  type HistoryDatabaseFixture,
  historyDatabaseFixture,
} from '../tests/support/history-database-fixture.js';

const exec = promisify(execFile);
const sidecar = fileURLToPath(new URL('../dist/sidecar.js', import.meta.url));
const stopOnSnapshot = fileURLToPath(
  new URL('../tests/support/stop-on-snapshot.mjs', import.meta.url)
);
const fixtures: HistoryDatabaseFixture[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
function env(f: HistoryDatabaseFixture): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith('ORCAOPS_')) scrubbed[key] = value;
  return { ...scrubbed, ORCAOPS_ROOT: f.cwd, ORCAOPS_DATA_DIR: f.root };
}

/** Resolves each NDJSON line as one parsed snapshot, in arrival order. */
function lines(child: ChildProcess): () => Promise<WatchSnapshot> {
  const queue: WatchSnapshot[] = [];
  const waiting: Array<(snapshot: WatchSnapshot) => void> = [];
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        const snapshot = JSON.parse(line) as WatchSnapshot;
        const next = waiting.shift();
        if (next) next(snapshot);
        else queue.push(snapshot);
      }
      index = buffer.indexOf('\n');
    }
  });
  return () =>
    new Promise<WatchSnapshot>((resolve, reject) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(() => reject(new Error('No snapshot arrived')), 20_000);
      waiting.push((snapshot) => {
        clearTimeout(timer);
        resolve(snapshot);
      });
    });
}

describe('built Watch sidecar', { timeout: 60_000 }, () => {
  it('prints repository names when launched outside a checkout', async () => {
    const f = await historyDatabaseFixture({ repositoryName: 'demo-repository' });
    fixtures.push(f);
    const id = await f.add();
    const { stdout, stderr } = await exec(process.execPath, [sidecar, '--once'], {
      cwd: f.temporary,
      env: { ...env(f), ORCAOPS_ROOT: f.temporary },
    });
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      projects: [
        {
          projectId: f.authority.projectId,
          displayName: 'demo-repository',
          repository: { instanceId: f.authority.repositoryInstanceId },
          threads: [{ artifactId: id }],
        },
      ],
    });
  });

  it.each(['SIGINT', 'SIGTERM', 'stdin'])(
    'exits cleanly on %s at the first snapshot',
    async (event) => {
      const f = await historyDatabaseFixture();
      fixtures.push(f);
      const id = await f.add();
      const { stdout, stderr } = await exec(
        process.execPath,
        ['--import', stopOnSnapshot, sidecar],
        {
          env: { ...env(f), WATCH_TEST_STOP: event },
          timeout: 15_000,
          killSignal: 'SIGKILL',
        }
      );
      expect(stderr).toBe('');
      const snapshots = stdout.trim().split('\n');
      expect(snapshots).toHaveLength(1);
      expect(JSON.parse(snapshots[0]!)).toMatchObject({
        state: 'current',
        projects: [{ threads: [{ artifactId: id }] }],
      });
    }
  );

  it('exits cleanly when the parent closes stdin before the first snapshot', async () => {
    const f = await historyDatabaseFixture();
    fixtures.push(f);
    await f.add();
    const running = exec(process.execPath, [sidecar], {
      env: env(f),
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    running.child.stdin!.end();
    const { stderr } = await running;
    expect(stderr).toBe('');
  });

  it('prints one snapshot from the project database in --once mode', async () => {
    const f = await historyDatabaseFixture();
    fixtures.push(f);
    const id = await f.add();
    const { stdout, stderr } = await exec(process.execPath, [sidecar, '--once'], {
      env: env(f),
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(stderr).toBe('');
    const snapshots = stdout.trim().split('\n');
    expect(snapshots).toHaveLength(1);
    const snapshot = JSON.parse(snapshots[0]!) as WatchSnapshot;
    expect(snapshot).toMatchObject({
      state: 'current',
      completeness: { complete: true },
      dataRoot: f.root,
      projects: [{ projectId: f.authority.projectId, threads: [{ artifactId: id }] }],
    });
  });

  it('streams a fresh snapshot after a capture lands and exits cleanly on SIGTERM', async () => {
    const f = await historyDatabaseFixture();
    fixtures.push(f);
    const first = await f.add();
    const child = spawn(process.execPath, [sidecar], {
      env: env(f),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const next = lines(child);
    const initial = await next();
    expect(initial.projects[0]!.threads.map((thread) => thread.artifactId)).toEqual([first]);
    const added = await f.add({ branch: 'topic' });
    let latest = initial;
    while (!latest.projects[0]!.threads.some((thread) => thread.artifactId === added))
      latest = await next();
    expect(latest.projects[0]!.threads.map((thread) => thread.artifactId).sort()).toEqual(
      [first, added].sort()
    );
    expect(latest.projects[0]!.writeSequence).toBeGreaterThan(initial.projects[0]!.writeSequence!);
    const exit = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(stderr).toBe('');
  });
});

/**
 * Displace the project inventory with a plain file: the resolver refuses a
 * non-directory inventory and preserves it, so this is the shape of history
 * that is present but unusable — never a fresh install to initialize.
 */
async function displaceInventory(f: HistoryDatabaseFixture): Promise<void> {
  const projects = path.join(f.root, 'projects');
  await rename(projects, path.join(f.root, 'projects-retained'));
  await writeFile(projects, 'displaced\n');
}

describe('built Watch sidecar refusals', { timeout: 60_000 }, () => {
  it('exits with the refusal on stderr when the history root cannot be opened', async () => {
    const f = await historyDatabaseFixture();
    fixtures.push(f);
    await f.add();
    const unusableRoot = path.join(f.temporary, 'root-file');
    await writeFile(unusableRoot, 'not a history root\n');
    const child = spawn(process.execPath, [sidecar], {
      env: { ...env(f), ORCAOPS_DATA_DIR: unusableRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exit = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(exit).toBe(1);
    expect(stderr).toContain('History root ancestor is not a directory');
    expect(stdout).toBe('');
  });

  it('discloses a displaced inventory as unavailable history and leaves it untouched', async () => {
    const f = await historyDatabaseFixture();
    fixtures.push(f);
    await f.add();
    await displaceInventory(f);
    const child = spawn(process.execPath, [sidecar], {
      env: env(f),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    const snapshot = await lines(child)();
    expect(snapshot).toMatchObject({
      state: 'deferred',
      completeness: { complete: false },
      projects: [{ state: 'unavailable', writeSequence: null, threads: [] }],
    });
    expect(snapshot.completeness.issues.map((issue) => issue.message)).toContain(
      'Project inventory is not a directory; preserve it for explicit repair'
    );
    expect((await stat(path.join(f.root, 'projects'))).isFile()).toBe(true);
    expect((await stat(path.join(f.root, 'projects-retained'))).isDirectory()).toBe(true);
    const exit = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
  });

  it('keeps streaming the last display as deferred when the inventory is displaced after it', async () => {
    const f = await historyDatabaseFixture();
    fixtures.push(f);
    const first = await f.add();
    const child = spawn(process.execPath, [sidecar], {
      env: env(f),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    const next = lines(child);
    const initial = await next();
    expect(initial.state).toBe('current');
    expect(initial.projects[0]!.threads.map((thread) => thread.artifactId)).toEqual([first]);
    await displaceInventory(f);
    let latest = initial;
    while (latest.state !== 'deferred') latest = await next();
    expect(latest.projects[0]).toMatchObject({
      state: 'deferred',
      threads: [{ artifactId: first }],
    });
    expect(latest.completeness.issues.map((issue) => issue.message)).toContain(
      'Project inventory is not a directory; preserve it for explicit repair'
    );
    expect(child.exitCode).toBeNull();
    const exit = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
  });
});

describe('built Watch sidecar freshness', { timeout: 60_000 }, () => {
  // The sidecar's slow heartbeat is 10 s. A capture that only becomes visible
  // on that heartbeat is the regression this bound exists to catch: on macOS a
  // commit writes the -wal file and raises no directory notification, so this
  // test fails outright if the engine's database and log files stop being
  // watched directly.
  it('shows a capture into an existing database well inside the heartbeat', async () => {
    const f = await historyDatabaseFixture();
    fixtures.push(f);
    const first = await f.add();
    const child = spawn(process.execPath, [sidecar], {
      env: env(f),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    const next = lines(child);
    const initial = await next();
    expect(initial.projects[0]!.threads.map((thread) => thread.artifactId)).toEqual([first]);
    const startedAt = Date.now();
    const added = await f.add({ branch: 'topic' });
    let latest = initial;
    while (!latest.projects[0]!.threads.some((thread) => thread.artifactId === added))
      latest = await next();
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    const exit = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
  });
});
