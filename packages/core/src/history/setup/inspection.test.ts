import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isUuidV7, uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import * as database from '@orcaops/storage/history/database';

import { inspectDatabaseSetup } from './inspection.js';
import {
  enumerateDatabaseGitContexts,
  resolveDatabaseGitContext,
  revalidateDatabaseGitContext,
} from '../context/git-context.js';
import { publishRepositoryRegistration } from '../registration-files.js';

vi.mock('@orcaops/storage/history/database', async (importOriginal) => {
  const original = await importOriginal<typeof database>();
  return {
    ...original,
    readProjectInitializationCandidate: vi.fn(original.readProjectInitializationCandidate),
  };
});
const exec = promisify(execFile);
interface FixtureConnection {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): { get(...values: unknown[]): unknown };
}
const Database = createRequire(import.meta.resolve('@orcaops/storage'))('better-sqlite3') as {
  new (file: string): FixtureConnection;
  prototype: FixtureConnection;
  SqliteError: new (message: string, code: string) => Error;
};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(database.readProjectInitializationCandidate)
    .mockReset()
    .mockImplementation(
      (await vi.importActual<typeof database>('@orcaops/storage/history/database'))
        .readProjectInitializationCandidate
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
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-setup-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q');
  const root = await normalizeHistoryRoot({ root: path.join(directory, 'history') });
  return { directory, cwd, root };
}
async function candidate(f: Awaited<ReturnType<typeof fixture>>) {
  const context = await resolveDatabaseGitContext({ cwd: f.cwd });
  const authority = {
    ...f.root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const initializationOperationId = uuidv7();
  const initializedAt = new Date().toISOString();
  await mkdir(path.dirname(database.projectDatabasePath(authority)), { recursive: true });
  (
    await database.initializeRepositoryDatabase({
      authority,
      initializationOperationId,
      initializedAt,
      repositoryCreation: context.repositoryCreation,
      authorize() {},
    })
  ).close();
  return { authority, initializationOperationId, initializedAt, context };
}
async function register(
  f: Awaited<ReturnType<typeof fixture>>,
  c: Awaited<ReturnType<typeof candidate>>
) {
  return publishRepositoryRegistration({
    commonDir: c.context.commonDir,
    expected: c.authority,
    initializationOperationId: c.initializationOperationId,
  });
}

describe('actual Git administration for database setup', () => {
  it('inspects main and linked administration without initializing application files', async () => {
    const f = await fixture();
    await git(f.cwd, 'commit', '--allow-empty', '-qm', 'Initial fixture');
    const linked = path.join(f.directory, 'linked checkout');
    await git(f.cwd, 'worktree', 'add', '-qb', 'linked', linked);
    const context = await resolveDatabaseGitContext({ cwd: linked });
    expect(context.gitDir).not.toBe(context.commonDir);
    const inventory = await enumerateDatabaseGitContexts(context);
    expect(inventory.unresolved).toEqual([]);
    expect(inventory.contexts).toHaveLength(2);
    expect((await inspectDatabaseSetup({ cwd: linked, root: f.root.resolvedRoot })).state).toBe(
      'fresh'
    );
    expect(await readdir(f.directory)).not.toContain('history');
    expect(await readdir(context.commonDir)).not.toContain('orcaops');
  });
  it('accepts a real separate Git directory and refuses a broken linked backlink', async () => {
    const f = await fixture();
    const separate = path.join(f.directory, 'separate git');
    await git(f.cwd, 'init', '--separate-git-dir', separate, '-q');
    const context = await resolveDatabaseGitContext({ cwd: f.cwd });
    expect(context.commonDir).toBe(separate);
    await git(f.cwd, 'commit', '--allow-empty', '-qm', 'Initial fixture');
    const linked = path.join(f.directory, 'linked');
    await git(f.cwd, 'worktree', 'add', '-qb', 'linked', linked);
    const current = await resolveDatabaseGitContext({ cwd: linked });
    await writeFile(path.join(current.gitDir, 'gitdir'), path.join(f.cwd, '.git'));
    await expect(resolveDatabaseGitContext({ cwd: linked })).rejects.toMatchObject({
      code: 'IDENTITY_RECOVERY_REQUIRED',
    });
  });
  it('detects actual same-path Git replacement while preserving unchanged-directory retry', async () => {
    const f = await fixture();
    const c = await candidate(f);
    const original = await inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot });
    expect(original.state).toBe('unregistered');
    expect(original.initialization?.authority).toEqual(c.authority);
    await revalidateDatabaseGitContext(c.context);
    await rename(c.context.commonDir, path.join(f.directory, 'retained original git'));
    await git(f.cwd, 'init', '-q');
    await expect(revalidateDatabaseGitContext(c.context)).rejects.toMatchObject({
      code: 'IDENTITY_RECOVERY_REQUIRED',
    });
    await expect(
      inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })
    ).rejects.toMatchObject({ code: 'IDENTITY_RECOVERY_REQUIRED' });
    expect(
      (
        await database.readProjectInitializationCandidate({
          root: f.root.resolvedRoot,
          projectId: c.authority.projectId,
        })
      ).authority
    ).toEqual(c.authority);
  });
  it('uses valid registration after relocation without rewriting creation facts', async () => {
    const f = await fixture();
    const c = await candidate(f);
    await register(f, c);
    const moved = path.join(f.directory, 'relocated');
    await rename(f.cwd, moved);
    const inspection = await inspectDatabaseSetup({ cwd: moved, root: f.root.resolvedRoot });
    expect(inspection.state).toBe('registered');
    expect(inspection.initialization?.authority).toEqual(c.authority);
    expect(
      (
        await database.readProjectInitializationCandidate({
          root: f.root.resolvedRoot,
          projectId: c.authority.projectId,
        })
      ).repositoryCreation
    ).toEqual(c.context.repositoryCreation);
  });
});

describe('bounded setup discovery', () => {
  it('retains original IDs for one valid candidate and protects ambiguous candidates', async () => {
    const f = await fixture();
    const c = await candidate(f);
    const first = await inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot });
    expect(first.initialization?.initializationOperationId).toBe(c.initializationOperationId);
    const second = await candidate(f);
    await expect(
      inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })
    ).rejects.toMatchObject({ code: 'IDENTITY_RECOVERY_REQUIRED' });
    expect(
      (await readdir(path.join(f.root.resolvedRoot, 'projects'))).filter(isUuidV7).sort()
    ).toEqual([c.authority.projectId, second.authority.projectId].sort());
  });
  it('rechecks and validates a winner after discovery reports ambiguity', async () => {
    const f = await fixture();
    const c = await candidate(f);
    await candidate(f);
    const actual = (await vi.importActual<typeof database>('@orcaops/storage/history/database'))
      .readProjectInitializationCandidate;
    let count = 0;
    vi.mocked(database.readProjectInitializationCandidate).mockImplementation(async (input) => {
      const value = await actual(input);
      if (++count === 2) await register(f, c);
      return value;
    });
    const inspection = await inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot });
    expect(inspection.state).toBe('registered');
    expect(inspection.initialization?.authority).toEqual(c.authority);
  });
  it('rechecks a winner after unavailable discovery and refuses a winner for another requested root', async () => {
    const f = await fixture();
    const c = await candidate(f);
    vi.mocked(database.readProjectInitializationCandidate).mockImplementationOnce(async () => {
      await register(f, c);
      throw new database.ProjectDatabaseError(
        'HISTORY_INACCESSIBLE',
        'Injected unavailable discovery'
      );
    });
    expect((await inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })).state).toBe(
      'registered'
    );
    const wrong = path.join(f.directory, 'other root');
    await expect(inspectDatabaseSetup({ cwd: f.cwd, root: wrong })).rejects.toMatchObject({
      code: 'AUTHORITY_MISMATCH',
    });
    expect(await readdir(f.directory)).not.toContain('other root');
  });
  it('never replaces registered missing history or occupied unknown candidates', async () => {
    const f = await fixture();
    const c = await candidate(f);
    await register(f, c);
    await rm(database.projectDatabasePath(c.authority));
    const before = await readdir(path.dirname(database.projectDatabasePath(c.authority)));
    await expect(
      inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
    expect(await readdir(path.dirname(database.projectDatabasePath(c.authority)))).toEqual(before);
    const unknown = await fixture();
    await mkdir(path.join(unknown.root.resolvedRoot, 'projects', uuidv7()), { recursive: true });
    await expect(
      inspectDatabaseSetup({ cwd: unknown.cwd, root: unknown.root.resolvedRoot })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  });
  it('protects absent creation evidence and invalid occupied registration without initializing', async () => {
    const f = await fixture();
    const authority = {
      ...f.root,
      projectId: uuidv7(),
      storeInstanceId: uuidv7(),
      repositoryInstanceId: uuidv7(),
    };
    await mkdir(path.dirname(database.projectDatabasePath(authority)), { recursive: true });
    (
      await database.initializeProjectDatabase({
        authority,
        initializationOperationId: uuidv7(),
        initializedAt: new Date().toISOString(),
        authorize() {},
      })
    ).close();
    await expect(
      inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })
    ).rejects.toMatchObject({ code: 'IDENTITY_RECOVERY_REQUIRED' });
    const context = await resolveDatabaseGitContext({ cwd: f.cwd });
    const marker = path.join(context.commonDir, 'orcaops', 'registration.json');
    await mkdir(path.dirname(marker));
    await writeFile(marker, '{}');
    await expect(
      inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })
    ).rejects.toMatchObject({ code: 'ACTIVATION_PENDING' });
    expect(await readFile(marker, 'utf8')).toBe('{}');
    expect(await readdir(path.join(f.root.resolvedRoot, 'projects'))).toEqual([
      authority.projectId,
    ]);
  });
  it('refuses registered activation whose declared canonical schema is incomplete', async () => {
    const f = await fixture();
    const c = await candidate(f);
    await register(f, c);
    const raw = new Database(database.projectDatabasePath(c.authority));
    raw.exec('DROP TABLE artifact_metadata');
    raw.close();
    await expect(
      inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(await readdir(path.join(f.root.resolvedRoot, 'projects'))).toEqual([
      c.authority.projectId,
    ]);
  });
  it.each(['missing', 'io', 'close-only'] as const)(
    'preserves registered initialization failure when close also fails: %s',
    async (kind) => {
      const f = await fixture();
      const c = await candidate(f);
      await register(f, c);
      expect((await inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })).state).toBe(
        'registered'
      );
      const originalPrepare = Database.prototype.prepare;
      const originalClose = Database.prototype.close;
      const closeFailure = new Error('Injected registered reader close failure');
      const ioFailure = new Database.SqliteError('Injected read I/O failure', 'SQLITE_IOERR');
      let armed = false;
      const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
        this: FixtureConnection,
        sql: string
      ) {
        const statement = originalPrepare.call(this, sql);
        if (sql.startsWith('SELECT i.initialization_operation_id')) {
          const originalGet = statement.get;
          vi.spyOn(statement, 'get').mockImplementationOnce(function (
            this: unknown,
            ...args: unknown[]
          ) {
            armed = true;
            if (kind === 'missing') return undefined;
            if (kind === 'io')
              throw new database.ProjectDatabaseError(
                'HISTORY_INACCESSIBLE',
                'Original read I/O failure',
                { cause: ioFailure }
              );
            return originalGet.apply(this, args);
          });
        }
        return statement;
      });
      const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
        this: FixtureConnection
      ) {
        originalClose.call(this);
        if (armed) {
          armed = false;
          throw closeFailure;
        }
      });
      let failure: unknown;
      try {
        failure = await inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot }).catch(
          (error) => error
        );
      } finally {
        prepare.mockRestore();
        close.mockRestore();
      }
      expect(failure).toMatchObject({
        code: kind === 'missing' ? 'HISTORY_INTEGRITY_REQUIRED' : 'HISTORY_INACCESSIBLE',
        reason: kind === 'io' ? 'io' : undefined,
      });
      if (kind === 'close-only') expect((failure as Error).cause).toBe(closeFailure);
      else {
        const aggregate = (failure as Error).cause as AggregateError;
        expect(aggregate).toBeInstanceOf(AggregateError);
        expect(aggregate.errors[1]).toBe(closeFailure);
        expect((failure as Error).message).toBe((aggregate.errors[0] as Error).message);
      }
      expect(
        (await inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })).initialization
          ?.authority
      ).toEqual(c.authority);
    }
  );
  it('freezes selectors before asynchronous Git discovery', async () => {
    const f = await fixture();
    const c = await candidate(f);
    const input = { cwd: f.cwd, root: f.root.resolvedRoot, projectId: c.authority.projectId };
    const pending = inspectDatabaseSetup(input);
    input.root = path.join(f.directory, 'wrong');
    input.projectId = uuidv7();
    expect((await pending).initialization?.authority).toEqual(c.authority);
  });
  it('uses frozen installer presence and protects symlinked administration', async () => {
    const f = await fixture();
    await mkdir(path.join(f.cwd, '.orcaops'));
    await expect(
      inspectDatabaseSetup({ cwd: f.cwd, root: f.root.resolvedRoot })
    ).rejects.toMatchObject({ code: 'CONVERSION_REQUIRED' });
    await rename(path.join(f.cwd, '.git'), path.join(f.directory, 'actualgit'));
    await symlink(path.join(f.directory, 'actualgit'), path.join(f.cwd, '.git'));
    await expect(resolveDatabaseGitContext({ cwd: f.cwd })).rejects.toMatchObject({
      code: 'IDENTITY_RECOVERY_REQUIRED',
    });
  });
});
