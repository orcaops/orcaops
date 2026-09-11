import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  projectDatabasePath,
} from '@orcaops/storage/history/database';

import {
  publishProjectCatalogEntry,
  publishRepositoryRegistration,
  publishWorktreeRegistration,
  readProjectCatalogEntry,
  readRepositoryRegistration,
} from './registration-files.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: vi.fn(original.open),
    link: vi.fn(original.link),
    unlink: vi.fn(original.unlink),
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'registration-publication-')));
  roots.push(base);
  const root = await normalizeHistoryRoot({ root: path.join(base, 'history') });
  const commonDir = path.join(base, 'common');
  const gitDir = path.join(base, 'worktree');
  await mkdir(commonDir);
  await mkdir(gitDir);
  const expected = {
    ...root,
    projectId: uuidv7(),
    repositoryInstanceId: uuidv7(),
    storeInstanceId: uuidv7(),
  };
  const initializationOperationId = uuidv7();
  const initializedAt = '2026-09-06T18:00:00.000Z';
  const initialize = async () => {
    await mkdir(path.dirname(projectDatabasePath(expected)), { recursive: true });
    const database = await initializeProjectDatabase({
      authority: expected,
      initializationOperationId,
      initializedAt,
      authorize() {},
    });
    database.close();
  };
  return {
    base,
    root,
    commonDir,
    gitDir,
    expected,
    initializationOperationId,
    initializedAt,
    initialize,
  };
}

describe('durable create-once registration', () => {
  it('preserves missing-history precedence when temporary cleanup also fails', async () => {
    const f = await fixture();
    await f.initialize();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          await rm(projectDatabasePath(f.expected));
        });
      }
      return handle;
    });
    const cleanupCause = Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(cleanupCause);
    const failure = await publishRepositoryRegistration(f).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'HISTORY_MISSING', cause: expect.any(AggregateError) });
    expect((failure as Error).cause).toMatchObject({ errors: [cleanupCause] });
    const names = await readdir(path.join(f.commonDir, 'orcaops'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.tmp$/);
    await expect(fs.lstat(projectDatabasePath(f.expected))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('returns an actionable cleanup failure while preserving a known final marker', async () => {
    const f = await fixture();
    await f.initialize();
    const cleanupCause = Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'unlink').mockRejectedValue(cleanupCause);
    await expect(publishRepositoryRegistration(f)).rejects.toMatchObject({
      code: 'HISTORY_UNWRITABLE',
      context: { linked: true, cause: cleanupCause, cleanupCause },
    });
    const directory = path.join(f.commonDir, 'orcaops');
    const names = await readdir(directory);
    expect(names).toContain('registration.json');
    expect(names.filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
    expect(
      (await readRepositoryRegistration({ commonDir: f.commonDir }))?.initialization_operation_id
    ).toBe(f.initializationOperationId);
  });

  it('certifies the exact committed initialization and retains only immutable catalog facts', async () => {
    const f = await fixture();
    await f.initialize();
    const db = await openProjectDatabase({ authority: f.expected, mode: 'reader' });
    const before = db.read((view) => view.all('SELECT * FROM operations'));
    db.close();
    const result = await publishRepositoryRegistration(f);
    const catalog = await publishProjectCatalogEntry(f);
    expect(result.publication).toBe('created');
    expect(result.registration.initialization_operation_id).toBe(f.initializationOperationId);
    expect(catalog.entry).toMatchObject({
      project_id: f.expected.projectId,
      creation: { operation_id: f.initializationOperationId, created_at: f.initializedAt },
    });
    expect(Object.keys(catalog.entry).sort()).toEqual([
      'creation',
      'hash',
      'project_id',
      'schema_version',
    ]);
    expect(
      await readRepositoryRegistration({ commonDir: f.commonDir, requestedRoot: f.root })
    ).toEqual(result.registration);
    expect(
      await readProjectCatalogEntry({ root: f.root, projectId: f.expected.projectId })
    ).toEqual(catalog.entry);
    expect(await readdir(path.join(f.commonDir, 'orcaops'))).toEqual(['registration.json']);
    const after = await openProjectDatabase({ authority: f.expected, mode: 'reader' });
    expect(after.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
    after.close();
  });

  it.each(['missing', 'wrong-store', 'wrong-operation'])(
    'refuses %s initialization before creating marker or catalog directories',
    async (damage) => {
      const f = await fixture();
      if (damage !== 'missing') await f.initialize();
      const expected = {
        ...f.expected,
        ...(damage === 'wrong-store' ? { storeInstanceId: uuidv7() } : {}),
      };
      const input = {
        ...f,
        expected,
        initializationOperationId:
          damage === 'wrong-operation' ? uuidv7() : f.initializationOperationId,
      };
      const expectedCode =
        damage === 'missing'
          ? 'HISTORY_MISSING'
          : damage === 'wrong-store'
            ? 'HISTORY_MISSING'
            : 'IDENTITY_CONFLICT';
      await expect(publishRepositoryRegistration(input)).rejects.toMatchObject({
        code: expectedCode,
      });
      await expect(publishProjectCatalogEntry(input)).rejects.toMatchObject({ code: expectedCode });
      expect(await readdir(f.commonDir)).toEqual([]);
      await expect(
        fs.lstat(path.join(f.root.resolvedRoot, 'projects', 'catalog'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('preserves invalid occupied bytes and conflicting immutable worktree identities', async () => {
    const f = await fixture();
    await f.initialize();
    await mkdir(path.join(f.commonDir, 'orcaops'));
    const file = path.join(f.commonDir, 'orcaops', 'registration.json');
    await writeFile(file, '');
    await expect(publishRepositoryRegistration(f)).rejects.toMatchObject({
      code: 'ACTIVATION_PENDING',
    });
    expect(await readFile(file, 'utf8')).toBe('');
    expect(await readdir(path.dirname(file))).toEqual(['registration.json']);
    const input = {
      gitDir: f.gitDir,
      repositoryInstanceId: f.expected.repositoryInstanceId,
      worktreeId: uuidv7(),
      operationId: uuidv7(),
    };
    const first = await publishWorktreeRegistration(input);
    expect((await publishWorktreeRegistration(input)).publication).toBe('existing');
    await expect(
      publishWorktreeRegistration({ ...input, worktreeId: uuidv7() })
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
    expect(
      JSON.parse(await readFile(path.join(f.gitDir, 'orcaops', 'worktree.json'), 'utf8'))
    ).toEqual(first.registration);
  });

  it('removes only its own prepared file when interrupted before linking and succeeds on original retry', async () => {
    const f = await fixture();
    await f.initialize();
    const directory = path.join(f.commonDir, 'orcaops');
    await mkdir(directory);
    await writeFile(path.join(directory, '.unknown.tmp'), 'protected');
    vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('interrupted'), { code: 'EIO' })
    );
    await expect(publishRepositoryRegistration(f)).rejects.toMatchObject({
      code: 'HISTORY_UNWRITABLE',
    });
    expect(await readdir(directory)).toEqual(['.unknown.tmp']);
    expect((await publishRepositoryRegistration(f)).publication).toBe('created');
    expect(await readFile(path.join(directory, '.unknown.tmp'), 'utf8')).toBe('protected');
  });

  it('fsyncs complete bytes and every metadata ancestor and retries equal linked markers after a failed directory sync', async () => {
    const f = await fixture();
    await f.initialize();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const directory = path.join(f.commonDir, 'orcaops');
    const file = path.join(directory, 'registration.json');
    const actions: string[] = [];
    let fail = true;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      const location = String(args[0]);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        actions.push(`sync:${location}`);
        if (location.endsWith('.tmp'))
          expect(JSON.parse(await readFile(location, 'utf8')).initialization_operation_id).toBe(
            f.initializationOperationId
          );
        if (location === directory && fail) {
          fail = false;
          throw Object.assign(new Error('sync interrupted'), { code: 'EIO' });
        }
        await sync();
      });
      return handle;
    });
    vi.spyOn(fs, 'link').mockImplementation(async (...args: Parameters<typeof fs.link>) => {
      actions.push('link');
      await original.link(...args);
    });
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
      actions.push('unlink');
      await original.unlink(...args);
    });
    await expect(publishRepositoryRegistration(f)).rejects.toMatchObject({
      code: 'HISTORY_UNWRITABLE',
      context: { linked: true },
    });
    const retained = await readFile(file);
    expect(actions[0]).toMatch(/^sync:.*\.tmp$/);
    expect(actions[1]).toBe('link');
    actions.length = 0;
    expect((await publishRepositoryRegistration(f)).publication).toBe('existing');
    expect(await readFile(file)).toEqual(retained);
    expect(actions).toContain(`sync:${file}`);
    expect(actions).toContain(`sync:${directory}`);
    expect(actions).toContain(`sync:${f.commonDir}`);
    expect(actions.at(-2)).toBe('unlink');
    expect(actions.at(-1)).toBe(`sync:${directory}`);
    expect(await readdir(directory)).toEqual(['registration.json']);
  });

  it('cancels after preparing bytes without linking a final marker', async () => {
    const f = await fixture();
    await f.initialize();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const controller = new AbortController();
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          controller.abort();
        });
      }
      return handle;
    });
    const linking = vi.spyOn(fs, 'link');
    await expect(
      publishRepositoryRegistration({ ...f, signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(linking).not.toHaveBeenCalled();
    expect(await readdir(path.join(f.commonDir, 'orcaops'))).toEqual([]);
  });

  it('revalidates a deleted expected database before linking without recreating it', async () => {
    const f = await fixture();
    await f.initialize();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          await rm(projectDatabasePath(f.expected));
        });
      }
      return handle;
    });
    await expect(publishRepositoryRegistration(f)).rejects.toMatchObject({
      code: 'HISTORY_MISSING',
    });
    expect(await readdir(path.join(f.commonDir, 'orcaops'))).toEqual([]);
    await expect(fs.lstat(projectDatabasePath(f.expected))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('honors cancellation before writing and retains a known publication after cancellation', async () => {
    const f = await fixture();
    await f.initialize();
    const controller = new AbortController();
    controller.abort();
    await expect(
      publishRepositoryRegistration({ ...f, signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await readdir(f.commonDir)).toEqual([]);
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const linked = new AbortController();
    vi.spyOn(fs, 'link').mockImplementation(async (...args: Parameters<typeof fs.link>) => {
      await original.link(...args);
      linked.abort();
    });
    expect((await publishRepositoryRegistration({ ...f, signal: linked.signal })).publication).toBe(
      'created'
    );
    expect(await readdir(path.join(f.commonDir, 'orcaops'))).toEqual(['registration.json']);
  });
});
