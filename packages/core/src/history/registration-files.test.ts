import * as fs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';

import { registrationBytes, sealRegistration } from './registration-files-format.js';
import {
  readProjectCatalogEntry,
  readRepositoryRegistration,
  readWorktreeRegistration,
} from './registration-files.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open), lstat: vi.fn(original.lstat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'registration-files-')));
  roots.push(base);
  const commonDir = path.join(base, 'common');
  const gitDir = path.join(base, 'worktree');
  await mkdir(commonDir);
  await mkdir(gitDir);
  const root = await normalizeHistoryRoot({ root: path.join(base, 'history') });
  const repositoryInstanceId = uuidv7();
  const projectId = uuidv7();
  const operationId = uuidv7();
  const repository = sealRegistration({
    schema_version: 1 as const,
    repository_instance_id: repositoryInstanceId,
    authority: {
      resolved_root: root.resolvedRoot,
      root_key: root.rootKey,
      project_id: projectId,
      store_instance_id: uuidv7(),
    },
    initialization_operation_id: operationId,
  });
  const worktree = sealRegistration({
    schema_version: 1 as const,
    repository_instance_id: repositoryInstanceId,
    worktree_id: uuidv7(),
  });
  const catalog = sealRegistration({
    schema_version: 1 as const,
    project_id: projectId,
    creation: { operation_id: operationId, created_at: '2026-09-06T18:00:00.000Z' },
  });
  return {
    base,
    commonDir,
    gitDir,
    root,
    projectId,
    repositoryInstanceId,
    repository,
    worktree,
    catalog,
  };
}

async function place(file: string, bytes: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

function changedMarker(value: object, changes: object) {
  const body: Record<string, unknown> = { ...value, ...changes };
  delete body.hash;
  return sealRegistration(body);
}

describe('immutable registration candidates', () => {
  it('returns absent without making data or administrative marker directories', async () => {
    const f = await fixture();
    expect(await readRepositoryRegistration({ commonDir: f.commonDir })).toBeNull();
    expect(await readWorktreeRegistration(f)).toBeNull();
    expect(await readProjectCatalogEntry(f)).toBeNull();
    expect(await readdir(f.base)).toEqual(['common', 'worktree']);
    expect(await readdir(f.commonDir)).toEqual([]);
  });

  it('retains exact identities and creation facts without certifying database authority', async () => {
    const f = await fixture();
    await place(
      path.join(f.commonDir, 'orcaops', 'registration.json'),
      registrationBytes(f.repository)
    );
    await place(path.join(f.gitDir, 'orcaops', 'worktree.json'), registrationBytes(f.worktree));
    await place(
      path.join(f.root.resolvedRoot, 'projects', 'catalog', `${f.projectId}.json`),
      registrationBytes(f.catalog)
    );
    expect(
      await readRepositoryRegistration({ commonDir: f.commonDir, requestedRoot: f.root })
    ).toEqual(f.repository);
    expect(await readWorktreeRegistration(f)).toEqual(f.worktree);
    expect(await readProjectCatalogEntry(f)).toEqual(f.catalog);
    expect(await readdir(path.join(f.root.resolvedRoot, 'projects'))).toEqual(['catalog']);
  });

  it.each([
    'empty',
    'malformed',
    'hash',
    'unknown',
    'identity',
    'root',
    'encoding',
    'noncanonical',
  ])('preserves an occupied %s repository marker as pending', async (damage) => {
    const f = await fixture();
    const file = path.join(f.commonDir, 'orcaops', 'registration.json');
    let bytes = registrationBytes(f.repository);
    if (damage === 'empty') bytes = Buffer.alloc(0);
    if (damage === 'malformed') bytes = Buffer.from('{');
    if (damage === 'hash') bytes = registrationBytes({ ...f.repository, hash: '0'.repeat(64) });
    if (damage === 'unknown')
      bytes = registrationBytes(changedMarker(f.repository, { label: 'mutable fact' }));
    if (damage === 'identity')
      bytes = registrationBytes(
        changedMarker(f.repository, { repository_instance_id: '../other' })
      );
    if (damage === 'root')
      bytes = registrationBytes(
        changedMarker(f.repository, {
          authority: { ...f.repository.authority, root_key: '0'.repeat(64) },
        })
      );
    if (damage === 'encoding') bytes = Buffer.from([0xff, 0xfe]);
    if (damage === 'noncanonical') bytes = Buffer.from(JSON.stringify(f.repository, null, 2));
    await place(file, bytes);
    await expect(readRepositoryRegistration({ commonDir: f.commonDir })).rejects.toMatchObject({
      code: 'ACTIVATION_PENDING',
    });
    expect(await readFile(file)).toEqual(bytes);
    expect(await readdir(path.dirname(file))).toEqual(['registration.json']);
  });

  it('refuses unsupported versions separately from invalid markers', async () => {
    const f = await fixture();
    await place(
      path.join(f.commonDir, 'orcaops', 'registration.json'),
      registrationBytes(changedMarker(f.repository, { schema_version: 2 }))
    );
    await expect(readRepositoryRegistration({ commonDir: f.commonDir })).rejects.toMatchObject({
      code: 'HISTORY_FORMAT_UNSUPPORTED',
    });
  });

  it('refuses an unexpected requested root without adopting the marker', async () => {
    const f = await fixture();
    await place(
      path.join(f.commonDir, 'orcaops', 'registration.json'),
      registrationBytes(f.repository)
    );
    const requestedRoot = await normalizeHistoryRoot({ root: path.join(f.base, 'different') });
    await expect(
      readRepositoryRegistration({ commonDir: f.commonDir, requestedRoot })
    ).rejects.toMatchObject({ code: 'AUTHORITY_MISMATCH' });
  });

  it('protects a symlink instead of following or replacing it', async () => {
    const f = await fixture();
    const outside = path.join(f.base, 'outside');
    await place(outside, registrationBytes(f.repository));
    await mkdir(path.join(f.commonDir, 'orcaops'));
    await symlink(outside, path.join(f.commonDir, 'orcaops', 'registration.json'));
    await expect(readRepositoryRegistration({ commonDir: f.commonDir })).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
    });
    expect(await readFile(outside)).toEqual(registrationBytes(f.repository));
  });

  it('protects metadata with unknown ownership', async () => {
    const f = await fixture();
    const owner = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
    await expect(readRepositoryRegistration({ commonDir: f.commonDir })).rejects.toMatchObject({
      code: 'HISTORY_UNEXPECTED_OWNER',
    });
    expect(await readdir(f.commonDir)).toEqual([]);
  });

  it('rechecks the owner of the exact file selected after path inspection', async () => {
    const f = await fixture();
    const file = path.join(f.commonDir, 'orcaops', 'registration.json');
    const bytes = registrationBytes(f.repository);
    await place(file, bytes);
    const actual = await fs.lstat(file, { bigint: true });
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
      .lstat;
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === file && args[1] && 'bigint' in args[1] && args[1].bigint) {
        return Object.assign(actual, { uid: actual.uid + 1n });
      }
      return original(...args);
    });
    const opening = vi.spyOn(fs, 'open');
    await expect(readRepositoryRegistration({ commonDir: f.commonDir })).rejects.toMatchObject({
      code: 'HISTORY_UNEXPECTED_OWNER',
    });
    expect(opening).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(bytes);
  });

  it('reports unreadable occupied metadata without reclassifying it as absence', async () => {
    const f = await fixture();
    const file = path.join(f.commonDir, 'orcaops', 'registration.json');
    const bytes = registrationBytes(f.repository);
    await place(file, bytes);
    const opening = vi
      .spyOn(fs, 'open')
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(readRepositoryRegistration({ commonDir: f.commonDir })).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
    });
    opening.mockRestore();
    expect(await readFile(file)).toEqual(bytes);
    expect(await readdir(path.dirname(file))).toEqual(['registration.json']);
  });

  it('rejects worktree repository mismatch and catalog filename mismatch', async () => {
    const f = await fixture();
    await place(path.join(f.gitDir, 'orcaops', 'worktree.json'), registrationBytes(f.worktree));
    await expect(
      readWorktreeRegistration({ gitDir: f.gitDir, repositoryInstanceId: uuidv7() })
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
    await place(
      path.join(f.root.resolvedRoot, 'projects', 'catalog', `${f.projectId}.json`),
      registrationBytes(changedMarker(f.catalog, { project_id: uuidv7() }))
    );
    await expect(readProjectCatalogEntry(f)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
  });
});
