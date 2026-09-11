import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  openProjectDatabase,
  ProjectDatabaseError,
  readProjectDisplayName,
  readProjectInitializationCandidate,
} from '@orcaops/storage/history/database';

import { inspectDatabaseSetup } from './inspection.js';
import { setupProjectDatabase } from './setup.js';
import * as filesystem from '../context/filesystem.js';
import * as registrations from '../registration-files.js';

vi.mock('../registration-files.js', async (importOriginal) => {
  const original = await importOriginal<typeof registrations>();
  return {
    ...original,
    publishRepositoryRegistration: vi.fn(original.publishRepositoryRegistration),
    publishProjectCatalogEntry: vi.fn(original.publishProjectCatalogEntry),
    publishWorktreeRegistration: vi.fn(original.publishWorktreeRegistration),
  };
});
vi.mock('../context/filesystem.js', async (importOriginal) => {
  const original = await importOriginal<typeof filesystem>();
  return { ...original, inspectDatabaseFilesystem: vi.fn(original.inspectDatabaseFilesystem) };
});
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const original = await vi.importActual<typeof registrations>('../registration-files.js');
  vi.mocked(registrations.publishRepositoryRegistration)
    .mockReset()
    .mockImplementation(original.publishRepositoryRegistration);
  vi.mocked(registrations.publishProjectCatalogEntry)
    .mockReset()
    .mockImplementation(original.publishProjectCatalogEntry);
  vi.mocked(registrations.publishWorktreeRegistration)
    .mockReset()
    .mockImplementation(original.publishWorktreeRegistration);
  vi.mocked(filesystem.inspectDatabaseFilesystem)
    .mockReset()
    .mockImplementation(
      (await vi.importActual<typeof filesystem>('../context/filesystem.js'))
        .inspectDatabaseFilesystem
    );
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]) {
  return exec('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
}
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-setup-write-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q');
  const root = await normalizeHistoryRoot({ root: path.join(directory, 'history') });
  const input = {
    cwd,
    root: root.resolvedRoot,
    authoredPayloads: ['Set up this disposable project'],
    secretAllow: [] as string[],
  };
  return { directory, cwd, root, input };
}
const refused = `ghp_${'Q'.repeat(36)}`;

describe('authorized database setup', () => {
  it('commits initialization before immutable registration, catalog and first-use markers', async () => {
    const f = await fixture();
    const result = await setupProjectDatabase(f.input);
    expect(result.status).toBe('complete');
    expect(result.pending).toEqual([]);
    expect(result.worktree?.repository_instance_id).toBe(
      result.initialization.authority.repositoryInstanceId
    );
    const inspection = await inspectDatabaseSetup(f.input);
    expect(inspection.state).toBe('registered');
    expect(inspection.initialization?.authority).toEqual(result.initialization.authority);
    const entry = await registrations.readProjectCatalogEntry({
      root: f.root,
      projectId: result.initialization.authority.projectId,
    });
    expect(entry?.creation.operation_id).toBe(result.initialization.initializationOperationId);
    expect(await setupProjectDatabase(f.input)).toEqual(result);
  });
  it('retains the accepted root, project and authored payload after caller mutation', async () => {
    const f = await fixture();
    const projectId = uuidv7();
    const input = { ...f.input, projectId };
    const pending = setupProjectDatabase(input);
    input.root = path.join(f.directory, 'other-history');
    input.projectId = uuidv7();
    input.authoredPayloads[0] = refused;
    const result = await pending;
    expect(result.status).toBe('complete');
    expect(result.initialization.authority).toMatchObject({
      resolvedRoot: f.root.resolvedRoot,
      projectId,
    });
    expect(await readdir(f.directory)).not.toContain('other-history');
    expect(
      (await inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })).initialization
        ?.authority
    ).toEqual(result.initialization.authority);
  });
  it('refuses secret payloads before creating a data root or Git marker', async () => {
    const f = await fixture();
    await expect(
      setupProjectDatabase({ ...f.input, authoredPayloads: [{ text: refused }] })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(await readdir(f.directory)).toEqual(['repository']);
    expect(await readdir(path.join(f.cwd, '.git'))).not.toContain('orcaops');
  });
  it('refuses escaped duplicate-key secrets retained in original JSON source before initialization', async () => {
    const f = await fixture();
    const source = JSON.stringify({ value: refused })
      .replace('ghp_', '\\u0067hp_')
      .replace(/}$/, ',"value":"safe"}');
    await expect(
      setupProjectDatabase({ ...f.input, authoredPayloads: [source] })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(await readdir(f.directory)).toEqual(['repository']);
  });
  it('retains initialization after registration failure and retries original IDs', async () => {
    const f = await fixture();
    vi.mocked(registrations.publishRepositoryRegistration).mockRejectedValueOnce(
      new ProjectDatabaseError('HISTORY_UNWRITABLE', 'Injected publication interruption')
    );
    await expect(setupProjectDatabase(f.input)).rejects.toMatchObject({
      code: 'HISTORY_UNWRITABLE',
    });
    const interrupted = await inspectDatabaseSetup(f.input);
    expect(interrupted.state).toBe('unregistered');
    const retry = await setupProjectDatabase(f.input);
    expect(retry.status).toBe('complete');
    expect(retry.initialization).toEqual({
      authority: interrupted.initialization!.authority,
      initializationOperationId: interrupted.initialization!.initializationOperationId,
      initializedAt: interrupted.initialization!.initializedAt,
      state: 'active',
    });
    expect(
      (await readdir(path.join(f.root.resolvedRoot, 'projects'))).filter(
        (name) => name !== 'catalog'
      )
    ).toEqual([retry.initialization.authority.projectId]);
  });
  it('adopts one valid same-root repository winner and preserves any unused initialization', async () => {
    const f = await fixture();
    const [left, right] = await Promise.all([
      setupProjectDatabase(f.input),
      setupProjectDatabase(f.input),
    ]);
    expect(left.status).toBe('complete');
    expect(right.status).toBe('complete');
    expect(left.registration).toEqual(right.registration);
    expect(left.worktree).toEqual(right.worktree);
    expect(left.initialization.authority).toEqual(right.initialization.authority);
  });
  it('converges concurrent fresh setup with one explicitly selected project', async () => {
    const f = await fixture();
    const input = { ...f.input, projectId: uuidv7() };
    const [left, right] = await Promise.all([
      setupProjectDatabase(input),
      setupProjectDatabase(input),
    ]);
    expect(left.status).toBe('complete');
    expect(right.status).toBe('complete');
    expect(left.registration).toEqual(right.registration);
    expect(left.initialization.authority.projectId).toBe(input.projectId);
  });
  it('refuses a conflicting requested root without replacing the winner', async () => {
    const f = await fixture();
    const winner = await setupProjectDatabase(f.input);
    await expect(
      setupProjectDatabase({ ...f.input, root: path.join(f.directory, 'other history') })
    ).rejects.toMatchObject({ code: 'AUTHORITY_MISMATCH' });
    expect((await setupProjectDatabase(f.input)).registration).toEqual(winner.registration);
    expect(await readdir(f.directory)).not.toContain('other history');
  });
  it('preserves both initializations when concurrent publishers request different roots', async () => {
    const f = await fixture();
    const leftInput = { ...f.input, projectId: uuidv7() };
    const rightInput = {
      ...f.input,
      root: path.join(f.directory, 'other-history'),
      projectId: uuidv7(),
    };
    const original = await vi.importActual<typeof registrations>('../registration-files.js');
    let arrived = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(registrations.publishRepositoryRegistration).mockImplementation(async (input) => {
      if (++arrived === 2) release();
      await ready;
      return original.publishRepositoryRegistration(input);
    });
    const results = await Promise.allSettled([
      setupProjectDatabase(leftInput),
      setupProjectDatabase(rightInput),
    ]);
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(arrived).toBe(2);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatchObject({ code: 'AUTHORITY_MISMATCH' });
    const winner = successes[0]!.value;
    expect(winner.status).toBe('complete');
    for (const input of [leftInput, rightInput]) {
      const root = await normalizeHistoryRoot({ root: input.root });
      const candidate = await readProjectInitializationCandidate({
        root: root.resolvedRoot,
        projectId: input.projectId,
      });
      expect(candidate.authority.projectId).toBe(input.projectId);
      if (candidate.authority.resolvedRoot === winner.initialization.authority.resolvedRoot)
        expect(candidate.authority).toEqual(winner.initialization.authority);
      else
        await expect(inspectDatabaseSetup(input)).rejects.toMatchObject({
          code: 'AUTHORITY_MISMATCH',
        });
    }
  });
  it('adopts the concurrent first-use worktree winner', async () => {
    const f = await fixture();
    const main = await setupProjectDatabase(f.input);
    await git(f.cwd, 'commit', '--allow-empty', '-qm', 'Initial fixture');
    const linked = path.join(f.directory, 'linked');
    await git(f.cwd, 'worktree', 'add', '-qb', 'linked', linked);
    const [left, right] = await Promise.all([
      setupProjectDatabase({ ...f.input, cwd: linked }),
      setupProjectDatabase({ ...f.input, cwd: linked }),
    ]);
    expect(left.worktree).toEqual(right.worktree);
    expect(left.worktree?.worktree_id).not.toBe(main.worktree?.worktree_id);
    expect(left.registration).toEqual(main.registration);
  });
  it('returns explicit secondary failure and completes it idempotently on retry', async () => {
    const f = await fixture();
    vi.mocked(registrations.publishProjectCatalogEntry).mockRejectedValueOnce(
      new ProjectDatabaseError('HISTORY_UNWRITABLE', 'Injected catalog failure')
    );
    const result = await setupProjectDatabase(f.input);
    expect(result.status).toBe('partial');
    expect(result.pending).toEqual([
      { resource: 'catalog', code: 'HISTORY_UNWRITABLE', message: 'Injected catalog failure' },
    ]);
    expect(result.worktree).not.toBeNull();
    const retry = await setupProjectDatabase(f.input);
    expect(retry.status).toBe('complete');
    expect(retry.registration).toEqual(result.registration);
  });
  it('stops secondary writes when catalog publication discovers missing expected history', async () => {
    const f = await fixture();
    const original = await vi.importActual<typeof registrations>('../registration-files.js');
    let databaseFile = '';
    const retained = path.join(f.directory, 'retained.sqlite3');
    vi.mocked(registrations.publishProjectCatalogEntry).mockImplementationOnce(async (input) => {
      databaseFile = path.join(
        input.expected.resolvedRoot,
        'projects',
        input.expected.projectId,
        'history.sqlite3'
      );
      await rename(databaseFile, retained);
      return original.publishProjectCatalogEntry(input);
    });
    const result = await setupProjectDatabase(f.input);
    expect(result.status).toBe('partial');
    expect(result.pending).toEqual([
      expect.objectContaining({ resource: 'catalog', code: 'HISTORY_MISSING' }),
      expect.objectContaining({ resource: 'worktree', code: 'HISTORY_MISSING' }),
    ]);
    expect(result.worktree).toBeNull();
    expect(await readdir(path.join(f.cwd, '.git', 'orcaops'))).toEqual(['registration.json']);
    await rename(retained, databaseFile);
    const retry = await setupProjectDatabase(f.input);
    expect(retry.status).toBe('complete');
    expect(retry.initialization).toEqual(result.initialization);
    expect(retry.registration).toEqual(result.registration);
  });
  it('preserves known registration when cancellation arrives after its publication', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const original = await vi.importActual<typeof registrations>('../registration-files.js');
    vi.mocked(registrations.publishRepositoryRegistration).mockImplementationOnce(async (input) => {
      const result = await original.publishRepositoryRegistration(input);
      controller.abort();
      return result;
    });
    const result = await setupProjectDatabase(f.input, { signal: controller.signal });
    expect(result.status).toBe('partial');
    expect(result.pending.map((item) => item.code)).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await inspectDatabaseSetup(f.input)).registration).toEqual(result.registration);
    expect((await setupProjectDatabase(f.input)).status).toBe('complete');
  });
  it('rechecks supported storage before a retry can publish missing markers', async () => {
    const f = await fixture();
    vi.mocked(registrations.publishRepositoryRegistration).mockRejectedValueOnce(
      new ProjectDatabaseError('HISTORY_UNWRITABLE', 'Stop before registration')
    );
    await expect(setupProjectDatabase(f.input)).rejects.toMatchObject({
      code: 'HISTORY_UNWRITABLE',
    });
    const original = await inspectDatabaseSetup(f.input);
    vi.mocked(filesystem.inspectDatabaseFilesystem).mockRejectedValueOnce(
      new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Unsupported local filesystem')
    );
    await expect(setupProjectDatabase(f.input)).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
    });
    expect((await inspectDatabaseSetup(f.input)).initialization).toEqual(original.initialization);
  });
  it('preserves unknown temporary publications and rejects accessors in authored input', async () => {
    const f = await fixture();
    const first = await setupProjectDatabase(f.input);
    const orphan = path.join(f.cwd, '.git', 'orcaops', '.registration.json.unknown.tmp');
    await writeFile(orphan, 'unknown ownership');
    expect((await setupProjectDatabase(f.input)).registration).toEqual(first.registration);
    expect(await readFile(orphan, 'utf8')).toBe('unknown ownership');
    const other = await fixture();
    let called = false;
    const value = {
      get secret() {
        called = true;
        return refused;
      },
    };
    await expect(
      setupProjectDatabase({ ...other.input, authoredPayloads: [value] })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(called).toBe(false);
    expect(await readdir(other.directory)).toEqual(['repository']);
  });
});

it.each([
  'git@example.test:team/orcaops.git',
  'https://reader:password@example.test/team/orcaops.git?access=private',
])(
  'saves the repository name from %s and preserves it after the remote changes',
  async (remote) => {
    const f = await fixture();
    await git(f.cwd, 'remote', 'add', 'origin', remote);
    const first = await setupProjectDatabase(f.input);
    await git(f.cwd, 'remote', 'set-url', 'origin', 'https://example.test/team/renamed.git');
    await setupProjectDatabase(f.input);
    const reader = await openProjectDatabase({
      authority: first.initialization.authority,
      mode: 'reader',
    });
    try {
      expect(readProjectDisplayName(reader)).toBe('orcaops');
    } finally {
      reader.close();
    }
  }
);
