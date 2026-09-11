import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { publishProjectEvidence, readProjectEvidence } from './evidence-files.js';

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
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'retained-evidence-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const project = path.dirname(projectDatabasePath(authority));
  await mkdir(project, { recursive: true });
  const database = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
  });
  handles.push(database);
  return { database, authority, project };
}
function input() {
  return {
    publicationId: uuidv7(),
    members: [{ name: 'floor.json', bytes: Buffer.from('{"schema_version":4}\n') }],
    secretAllow: [] as string[],
  };
}

describe('immutable retained evidence', () => {
  it('retains exact bytes without changing application rows and reads through a readonly connection', async () => {
    const f = await fixture();
    const request = input();
    request.members.push({
      name: 'diff.patch',
      bytes: Buffer.from('diff --git a/a b/a\n+new content\n'),
    });
    const before = f.database.read((view) => view.all('SELECT * FROM operations'));
    const result = await publishProjectEvidence(f.database, request);
    const reader = await openProjectDatabase({ authority: f.authority, mode: 'reader' });
    handles.push(reader);
    for (const [index, descriptor] of result.entries()) {
      expect(descriptor.relativePath).toBe(
        `evidence/${request.publicationId}/${request.members[index]!.name}`
      );
      expect(await readProjectEvidence(reader, descriptor)).toEqual(request.members[index]!.bytes);
    }
    expect(f.database.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
    expect(await readdir(path.join(f.project, 'evidence', request.publicationId))).toEqual([
      'diff.patch',
      'floor.json',
    ]);
  });

  it('copies the entire request before yielding to filesystem operations', async () => {
    const f = await fixture();
    const request = input();
    const expected = Buffer.from(request.members[0]!.bytes);
    const pending = publishProjectEvidence(f.database, request);
    request.members[0]!.bytes.fill(65);
    request.members[0]!.name = '../changed';
    request.publicationId = '../changed';
    request.members.push({ name: 'late.json', bytes: Buffer.from('late') });
    const descriptors = await pending;
    expect(descriptors).toHaveLength(1);
    expect(await readProjectEvidence(f.database, descriptors[0]!)).toEqual(expected);
  });

  it.each([false, true])(
    'refuses the entire batch before any evidence write with escaped secrets %s',
    async (escaped) => {
      const f = await fixture();
      const request = input();
      const secret = 'ghp_' + 'A'.repeat(36);
      const text = escaped
        ? Array.from(secret)
            .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
            .join('')
        : secret;
      request.members.push({
        name: 'story.json',
        bytes: Buffer.from(`{"body":"${text}","body":"safe"}`),
      });
      await expect(publishProjectEvidence(f.database, request)).rejects.toMatchObject({
        code: 'SECRET_IN_PAYLOAD',
      });
      await expect(fs.lstat(path.join(f.project, 'evidence'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(f.database.read(() => null).counters).toEqual({
        writeSequence: 1,
        intentChangeCounter: 0,
      });
    }
  );

  it.each([false, true])(
    'refuses sparse member batches before writes with valid prefix %s',
    async (prefix) => {
      const f = await fixture();
      const request = input();
      const members: typeof request.members = new Array(prefix ? 2 : 1);
      if (prefix) members[0] = request.members[0]!;
      request.members = members;
      await expect(publishProjectEvidence(f.database, request)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(fs.lstat(path.join(f.project, 'evidence'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it('refuses a sparse allowlist before opening evidence files', async () => {
    const f = await fixture();
    const request = input();
    request.secretAllow = new Array(1);
    await expect(publishProjectEvidence(f.database, request)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(fs.lstat(path.join(f.project, 'evidence'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not reapply authoring refusal while reading explicitly allowed historical evidence', async () => {
    const f = await fixture();
    const request = input();
    const knownDead = 'ghp_' + 'A'.repeat(36);
    request.members[0]!.bytes = Buffer.from(JSON.stringify({ body: knownDead }));
    request.secretAllow = [knownDead];
    const result = await publishProjectEvidence(f.database, request);
    expect(await readProjectEvidence(f.database, result[0]!)).toEqual(request.members[0]!.bytes);
  });

  it('rejects unsafe names, duplicate members and invalid UTF-8 before writing', async () => {
    const f = await fixture();
    for (const names of [['../escape'], ['one/file'], ['.hidden'], ['same', 'same']]) {
      const request = input();
      request.members = names.map((name) => ({ name, bytes: Buffer.from('text') }));
      await expect(publishProjectEvidence(f.database, request)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
    const request = input();
    request.members[0]!.bytes = Buffer.from([0xff]);
    await expect(publishProjectEvidence(f.database, request)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(fs.lstat(path.join(f.project, 'evidence'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('makes concurrent equal publications durable and refuses different content without replacement', async () => {
    const f = await fixture();
    const request = input();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => publishProjectEvidence(f.database, request))
    );
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true
    );
    const original = request.members[0]!.bytes;
    request.members[0]!.bytes = Buffer.from('different bytes');
    await expect(publishProjectEvidence(f.database, request)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    expect(await readProjectEvidence(f.database, results[0]![0]!)).toEqual(original);
    expect(await readdir(path.join(f.project, 'evidence', request.publicationId))).toEqual([
      'floor.json',
    ]);
  });

  it('retains a final file after directory fsync failure and settles equal-content retry', async () => {
    const f = await fixture();
    const request = input();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const directory = path.join(f.project, 'evidence', request.publicationId);
    const synced: string[] = [];
    let fail = true;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      const target = String(args[0]);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        synced.push(target);
        if (target === directory && fail) {
          fail = false;
          throw Object.assign(new Error('directory sync unavailable'), { code: 'EIO' });
        }
        await sync();
      });
      return handle;
    });
    await expect(publishProjectEvidence(f.database, request)).rejects.toMatchObject({
      code: 'HISTORY_UNWRITABLE',
    });
    expect(await readFile(path.join(directory, 'floor.json'))).toEqual(request.members[0]!.bytes);
    const leftover = (await readdir(directory)).find((name) => name.endsWith('.tmp'))!;
    expect(leftover).toBeTruthy();
    synced.length = 0;
    const descriptors = await publishProjectEvidence(f.database, request);
    expect(synced).toEqual([
      path.join(directory, 'floor.json'),
      directory,
      path.dirname(directory),
      f.project,
    ]);
    expect(await readProjectEvidence(f.database, descriptors[0]!)).toEqual(
      request.members[0]!.bytes
    );
    expect(await readdir(directory)).toContain(leftover);
  });

  it('honors cancellation after temporary fsync and preserves the unused attempt on retry', async () => {
    const f = await fixture();
    const request = input();
    const controller = new AbortController();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
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
    await expect(
      publishProjectEvidence(f.database, request, { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    const directory = path.join(f.project, 'evidence', request.publicationId);
    const before = await readdir(directory);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatch(/\.tmp$/);
    const result = await publishProjectEvidence(f.database, request);
    expect(await readdir(directory)).toContain(before[0]);
    expect(await readProjectEvidence(f.database, result[0]!)).toEqual(request.members[0]!.bytes);
  });

  it('does not undo a linked publication when cancellation arrives after linking', async () => {
    const f = await fixture();
    const request = input();
    const controller = new AbortController();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.spyOn(fs, 'link').mockImplementation(async (...args: Parameters<typeof fs.link>) => {
      await original.link(...args);
      controller.abort();
    });
    await expect(
      publishProjectEvidence(f.database, request, { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(
      await readFile(path.join(f.project, 'evidence', request.publicationId, 'floor.json'))
    ).toEqual(request.members[0]!.bytes);
    expect(await readdir(path.join(f.project, 'evidence', request.publicationId))).toEqual([
      'floor.json',
    ]);
  });

  it('refuses an already cancelled request before creating any evidence path', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      publishProjectEvidence(f.database, input(), { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(fs.lstat(path.join(f.project, 'evidence'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps a removed database missing when publication is interrupted after preparation', async () => {
    const f = await fixture();
    const request = input();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          await rm(f.database.databasePath);
        });
      }
      return handle;
    });
    await expect(publishProjectEvidence(f.database, request)).rejects.toMatchObject({
      code: 'HISTORY_MISSING',
    });
    await expect(fs.lstat(f.database.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const remaining = await readdir(path.join(f.project, 'evidence', request.publicationId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatch(/\.tmp$/);
  });

  it('preserves unknown occupants and refuses symlinked evidence', async () => {
    const f = await fixture();
    const request = input();
    const outside = path.join(f.authority.resolvedRoot, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(f.project, 'evidence'));
    await expect(publishProjectEvidence(f.database, request)).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('reports missing selected evidence and detects altered bytes without recreating files', async () => {
    const f = await fixture();
    const request = input();
    const [descriptor] = await publishProjectEvidence(f.database, request);
    const target = path.join(f.project, descriptor!.relativePath);
    await writeFile(target, Buffer.alloc(descriptor!.byteLength, 65));
    await expect(readProjectEvidence(f.database, descriptor!)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    await rm(target);
    await expect(readProjectEvidence(f.database, descriptor!)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    expect(await readdir(path.dirname(target))).toEqual([]);
  });

  it('preserves changed-byte integrity failure when the readonly descriptor also fails to close', async () => {
    const f = await fixture();
    const [descriptor] = await publishProjectEvidence(f.database, input());
    const target = path.join(f.project, descriptor!.relativePath);
    await writeFile(target, Buffer.alloc(descriptor!.byteLength, 65));
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const closeFailure = Object.assign(new Error('descriptor close unavailable'), { code: 'EIO' });
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]) === target) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          throw closeFailure;
        });
      }
      return handle;
    });
    const failure = await readProjectEvidence(f.database, descriptor!).catch(
      (cause: unknown) => cause
    );
    expect(failure).toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
      cause: expect.any(AggregateError),
    });
    expect((failure as Error).cause).toMatchObject({
      errors: [expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }), closeFailure],
    });
    expect(await readFile(target)).toEqual(Buffer.alloc(descriptor!.byteLength, 65));
  });

  it('retains preparation and descriptor-close failures together without linking incomplete evidence', async () => {
    const f = await fixture();
    const request = input();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const writeFailure = Object.assign(new Error('storage full'), { code: 'ENOSPC' });
    const closeFailure = Object.assign(new Error('descriptor close unavailable'), { code: 'EIO' });
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        vi.spyOn(handle, 'writeFile').mockRejectedValue(writeFailure);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          throw closeFailure;
        });
      }
      return handle;
    });
    const failure = await publishProjectEvidence(f.database, request).catch(
      (cause: unknown) => cause
    );
    expect(failure).toMatchObject({
      code: 'HISTORY_UNWRITABLE',
      context: { cause: expect.any(AggregateError) },
    });
    expect((failure as { context: { cause: AggregateError } }).context.cause.errors).toEqual([
      writeFailure,
      closeFailure,
    ]);
    const remaining = await readdir(path.join(f.project, 'evidence', request.publicationId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatch(/\.tmp$/);
  });

  it('refuses missing databases and forged handles without creating evidence', async () => {
    const f = await fixture();
    await rm(f.database.databasePath);
    await expect(publishProjectEvidence(f.database, input())).rejects.toMatchObject({
      code: 'HISTORY_MISSING',
    });
    await expect(
      publishProjectEvidence({ ...f.database } as ProjectDatabase, input())
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(fs.lstat(path.join(f.project, 'evidence'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
