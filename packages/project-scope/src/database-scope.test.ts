import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import {
  publishProjectCatalogEntry,
  publishRepositoryRegistration,
  publishWorktreeRegistration,
} from '@orcaops/core/history/registration';
import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  ProjectDatabaseError,
  projectDatabasePath,
} from '@orcaops/storage/history/database';

import { type DatabaseHistoryScope, resolveDatabaseHistoryScope } from './database-scope.js';

const execute = promisify(execFile);
const roots: string[] = [];
const scopes: DatabaseHistoryScope[] = [];
const writers = new Set<ProjectDatabase>();
afterEach(async () => {
  for (const scope of scopes.splice(0)) scope.close();
  for (const writer of writers) writer.close();
  writers.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'database-scope-')));
  roots.push(base);
  return base;
}
async function git(cwd: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  return execute('git', ['-C', cwd, ...args], { env });
}
async function project(rootPath: string, catalog = true) {
  const root = await normalizeHistoryRoot({ root: rootPath });
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const initializationOperationId = uuidv7();
  const writer = await initializeProjectDatabase({
    authority,
    initializationOperationId,
    initializedAt: '2026-09-06T00:00:00.000Z',
    authorize() {},
  });
  writers.add(writer);
  if (catalog) await publishProjectCatalogEntry({ expected: authority, initializationOperationId });
  return { authority, writer, initializationOperationId };
}
async function read(input: Parameters<typeof resolveDatabaseHistoryScope>[0]) {
  const scope = await resolveDatabaseHistoryScope(input);
  scopes.push(scope);
  return scope;
}
async function repository(withWorktree = false) {
  const base = await directory();
  const cwd = path.join(base, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  const p = await project(path.join(base, 'history'));
  await publishRepositoryRegistration({
    expected: p.authority,
    initializationOperationId: p.initializationOperationId,
    commonDir: path.join(cwd, '.git'),
  });
  const worktree = withWorktree
    ? await publishWorktreeRegistration({
        gitDir: path.join(cwd, '.git'),
        repositoryInstanceId: p.authority.repositoryInstanceId,
        worktreeId: uuidv7(),
        operationId: uuidv7(),
      })
    : null;
  return { ...p, base, cwd, root: p.authority.resolvedRoot, worktree };
}
it('requires explicit scope outside Git and never creates a missing root', async () => {
  const cwd = await directory();
  const root = path.join(cwd, 'missing');
  await expect(resolveDatabaseHistoryScope({ cwd, root })).rejects.toMatchObject({
    code: 'PROJECT_REQUIRED',
  });
  const all = await read({ cwd, root, selector: { scope: 'all-projects' } });
  expect(all.projects).toEqual([]);
  expect(all.completeness).toEqual({ complete: true, issues: [] });
  expect(await readdir(cwd)).toEqual([]);
});
it('distinguishes verified first use from recovery when registration is absent', async () => {
  const base = await directory();
  const cwd = path.join(base, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  const root = path.join(base, 'history');
  const scope = await read({ cwd, root });
  expect(scope.projects).toEqual([]);
  expect(scope.completeness.issues).toContainEqual({
    code: 'PROJECT_IDENTITY_UNAVAILABLE',
    project_id: null,
    message: expect.stringMatching(
      /doctor.*first-use setup only after confirming no prior history/
    ),
  });
  await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reads explicit activated projects without requiring or publishing Git registration', async () => {
  const cwd = await directory();
  const p = await project(path.join(cwd, 'history'), false);
  const before = p.writer.read((v) => v.all('SELECT * FROM operations'));
  const scope = await read({
    cwd,
    root: p.authority.resolvedRoot,
    selector: { projectId: p.authority.projectId },
  });
  expect(scope.gitContext).toBeNull();
  expect(scope.projects).toHaveLength(1);
  expect(scope.projects[0].authority).toEqual(p.authority);
  expect(scope.completeness.complete).toBe(true);
  const database = scope.projects[0].database!;
  expect(() =>
    database.read((v) => v.get("INSERT INTO artifact_branches VALUES ('absent','refused')"))
  ).toThrow();
  expect(database.read((v) => v.all('SELECT * FROM operations'))).toEqual(before);
  expect(await readdir(cwd)).toEqual(['history']);
  expect(await readdir(path.join(p.authority.resolvedRoot, 'projects'))).toEqual([
    p.authority.projectId,
  ]);
});
it('enumerates databases plus expected catalog history and discloses unknown ownership', async () => {
  const cwd = await directory();
  const root = path.join(cwd, 'history');
  const available = await project(root);
  const missing = await project(root);
  missing.writer.close();
  writers.delete(missing.writer);
  await rm(projectDatabasePath(missing.authority));
  await writeFile(path.join(root, 'projects', 'unknown-owner'), 'preserve');
  for (const name of ['artifacts', 'usage'])
    await mkdir(path.join(root, 'projects', missing.authority.projectId, name));
  const finderFiles = [
    path.join(root, 'projects', '.DS_Store'),
    path.join(root, 'projects', 'catalog', '.DS_Store'),
  ];
  for (const file of finderFiles) await writeFile(file, 'Finder metadata');
  const scope = await read({ cwd, root, selector: { scope: 'all-projects' } });
  expect(scope.projects.map((p) => p.projectId).sort()).toEqual(
    [available.authority.projectId, missing.authority.projectId].sort()
  );
  expect(
    scope.projects.find((p) => p.projectId === available.authority.projectId)?.database
  ).not.toBeNull();
  expect(scope.completeness.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ project_id: missing.authority.projectId, code: 'HISTORY_MISSING' }),
      expect.objectContaining({
        project_id: null,
        code: 'IDENTITY_RECOVERY_REQUIRED',
        resource: 'unknown-owner',
      }),
    ])
  );
  await expect(readFile(projectDatabasePath(missing.authority))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(path.join(root, 'projects', 'unknown-owner'), 'utf8')).toBe('preserve');
  expect(scope.completeness.issues).toHaveLength(2);
  for (const file of finderFiles) expect(await readFile(file, 'utf8')).toBe('Finder metadata');
  const later = await project(root);
  const refreshed = await read({ cwd, root, selector: { scope: 'all-projects' } });
  expect(
    refreshed.projects.some((p) => p.projectId === later.authority.projectId && p.database)
  ).toBe(true);
});
it('reports complete history beside a preserved catalog publication temporary', async () => {
  const cwd = await directory();
  const root = path.join(cwd, 'history');
  const healthy = await project(root);
  const catalog = path.join(root, 'projects', 'catalog');
  const leftover = path.join(catalog, `.${uuidv7()}.json.${uuidv7()}.${randomUUID()}.tmp`);
  await writeFile(leftover, 'interrupted publication');
  const foreign = path.join(catalog, 'foreign.json.tmp');
  await writeFile(foreign, 'not ours');
  const scope = await read({ cwd, root, selector: { scope: 'all-projects' } });
  expect(scope.projects.map((p) => p.projectId)).toEqual([healthy.authority.projectId]);
  expect(scope.completeness.issues).toEqual([
    expect.objectContaining({
      code: 'IDENTITY_RECOVERY_REQUIRED',
      resource: `catalog/${path.basename(foreign)}`,
    }),
  ]);
  expect(await readFile(leftover, 'utf8')).toBe('interrupted publication');
  expect((await readdir(catalog)).sort()).toEqual(
    [`${healthy.authority.projectId}.json`, path.basename(leftover), 'foreign.json.tmp'].sort()
  );
});
it('keeps bare status project-scoped when no worktree marker exists', async () => {
  const f = await repository();
  const marker = path.join(f.cwd, '.git', 'orcaops', 'registration.json');
  const before = await readFile(marker);
  const status = await read({ cwd: f.cwd, root: f.root, profile: 'status' });
  expect(status.kind).toBe('project');
  expect(status.branch).toEqual({ value: 'topic', source: 'current' });
  expect(status.gitContext?.worktreeId).toBeNull();
  expect(status.completeness.complete).toBe(true);
  await expect(
    resolveDatabaseHistoryScope({ cwd: f.cwd, root: f.root, selector: { scope: 'worktree' } })
  ).rejects.toMatchObject({ code: 'WORKTREE_SCOPE_UNAVAILABLE' });
  expect(await readFile(marker)).toEqual(before);
  expect(await readdir(path.dirname(marker))).toEqual(['registration.json']);
});
it('validates registration before opening another root and never replaces missing history', async () => {
  const f = await repository();
  const other = path.join(f.base, 'another-root');
  const wrong = await read({ cwd: f.cwd, root: other });
  expect(wrong.completeness.issues).toContainEqual(
    expect.objectContaining({ code: 'AUTHORITY_MISMATCH', project_id: f.authority.projectId })
  );
  await expect(readdir(other)).rejects.toMatchObject({ code: 'ENOENT' });
  f.writer.close();
  writers.delete(f.writer);
  await rm(projectDatabasePath(f.authority));
  await rm(path.join(f.root, 'projects', 'catalog', `${f.authority.projectId}.json`));
  for (const name of ['artifacts', 'usage'])
    await mkdir(path.join(f.root, 'projects', f.authority.projectId, name));
  const missing = await read({ cwd: f.cwd, root: f.root });
  expect(missing.completeness.issues).toContainEqual(
    expect.objectContaining({ code: 'HISTORY_MISSING', project_id: f.authority.projectId })
  );
  await expect(readFile(projectDatabasePath(f.authority))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('detaches another explicit project and preserves registered worktree scope', async () => {
  const f = await repository(true);
  const other = await project(f.root);
  const local = await read({ cwd: f.cwd, root: f.root, selector: { scope: 'worktree' } });
  expect(local.gitContext?.worktreeId).toBe(f.worktree?.registration.worktree_id);
  const selected = await read({
    cwd: f.cwd,
    root: f.root,
    selector: { projectId: other.authority.projectId },
  });
  expect(selected.gitContext).toBeNull();
  expect(selected.projects[0].authority).toEqual(other.authority);
  await expect(
    resolveDatabaseHistoryScope({
      cwd: f.cwd,
      root: f.root,
      selector: { scope: 'worktree', projectId: other.authority.projectId },
    })
  ).rejects.toMatchObject({ code: 'WORKTREE_SCOPE_UNAVAILABLE' });
});
it('cancels before filesystem work and rejects conflicting selectors first', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    resolveDatabaseHistoryScope({
      cwd: '/nonexistent',
      signal: controller.signal,
      selector: { scope: 'all-projects' },
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(
    resolveDatabaseHistoryScope({
      cwd: '/nonexistent',
      selector: { scope: 'all-projects', projectId: uuidv7() },
    })
  ).rejects.toMatchObject({ code: 'SCOPE_CONFLICT' });
});

it('discloses a damaged worktree marker without hiding project history', async () => {
  const f = await repository(true);
  const marker = path.join(f.cwd, '.git', 'orcaops', 'worktree.json');
  await writeFile(marker, '');
  const scope = await read({ cwd: f.cwd, root: f.root, profile: 'status' });
  expect(scope.projects[0].database).not.toBeNull();
  expect(scope.completeness.complete).toBe(true);
  expect(scope.gitContext?.worktreeId).toBeNull();
  expect(scope.contextIssues).toHaveLength(1);
  expect(await readFile(marker, 'utf8')).toBe('');
});
it('keeps all-project reads independent of another registered data root', async () => {
  const f = await repository();
  const other = await project(path.join(f.base, 'other-history'));
  const scope = await read({
    cwd: f.cwd,
    root: other.authority.resolvedRoot,
    selector: { scope: 'all-projects' },
  });
  expect(scope.projects.map((p) => p.projectId)).toEqual([other.authority.projectId]);
  expect(scope.completeness.complete).toBe(true);
  expect(scope.gitContext).toBeNull();
  expect(scope.contextIssues).toContainEqual(
    expect.objectContaining({ code: 'AUTHORITY_MISMATCH' })
  );
});
it('reports unavailable current branch after detaching without changing scope', async () => {
  const f = await repository();
  await git(
    f.cwd,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'Retained fixture'
  );
  await git(f.cwd, 'checkout', '--detach', '-q');
  const scope = await read({ cwd: f.cwd, root: f.root, profile: 'status' });
  expect(scope.kind).toBe('project');
  expect(scope.branch).toEqual({ value: null, source: 'unavailable' });
  expect(scope.gitContext?.headOid).toMatch(/^[a-f0-9]{40}$/);
  expect(scope.projects[0].database).not.toBeNull();
});

it('keeps registered project history available when its Git commit is missing', async () => {
  const f = await repository();
  await writeFile(path.join(f.cwd, '.git', 'refs', 'heads', 'topic'), 'a'.repeat(40) + '\n');
  const scope = await read({ cwd: f.cwd, root: f.root, profile: 'status' });
  expect(scope.projects[0].authority).toEqual(f.authority);
  expect(scope.projects[0].database).not.toBeNull();
  expect(scope.branch).toEqual({ value: null, source: 'unavailable' });
  expect(scope.contextIssues).toHaveLength(1);
  expect(await readFile(path.join(f.cwd, '.git', 'refs', 'heads', 'topic'), 'utf8')).toBe(
    'a'.repeat(40) + '\n'
  );
});

it('reports typed cleanup failure after closing every reader', async () => {
  const cwd = await directory();
  const root = path.join(cwd, 'history');
  await project(root);
  await project(root);
  const scope = await read({ cwd, root, selector: { scope: 'all-projects' } });
  const original = Database.prototype.close;
  let closed = 0;
  const spy = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
    this: Database.Database
  ) {
    original.call(this);
    if (this.readonly) {
      closed++;
      throw new Error('Cleanup failed');
    }
    return this;
  });
  try {
    expect(() => scope.close()).toThrow(ProjectDatabaseError);
    expect(closed).toBe(2);
    expect(() => scope.close()).not.toThrow();
  } finally {
    spy.mockRestore();
  }
});

it.each(['remove project', 'replace handle'] as const)(
  'keeps private reader ownership when a caller changes the public view: %s',
  async (mutation) => {
    const cwd = await directory();
    const p = await project(path.join(cwd, 'history'));
    const scope = await read({
      cwd,
      root: p.authority.resolvedRoot,
      selector: { projectId: p.authority.projectId },
    });
    const database = scope.projects[0].database!;
    if (mutation === 'remove project') scope.projects.splice(0);
    else scope.projects[0].database = null;
    scope.close();
    expect(() => database.read(() => null)).toThrow();
  }
);

it.each([null, 'history.sqlite3-wal', 'history.sqlite3-shm', 'history-format.json'])(
  'distinguishes legacy-only directories from missing canonical history with marker %s',
  async (marker) => {
    const cwd = await directory();
    const root = path.join(cwd, 'history');
    const projectId = uuidv7();
    const directoryPath = path.join(root, 'projects', projectId);
    await mkdir(path.join(directoryPath, 'artifacts'), { recursive: true });
    await mkdir(path.join(directoryPath, 'usage'));
    const retained = path.join(directoryPath, 'artifacts', 'original.txt');
    await writeFile(retained, 'preserved original history');
    if (marker) await writeFile(path.join(directoryPath, marker), 'canonical evidence');
    const before = await readdir(directoryPath);
    const scope = await read({ cwd, root, selector: { scope: 'all-projects' } });
    expect(scope.projects[0].database).toBeNull();
    expect(scope.completeness.issues).toEqual([
      expect.objectContaining({
        project_id: projectId,
        code: marker ? 'HISTORY_MISSING' : 'LEGACY_HISTORY_PRESENT',
      }),
    ]);
    if (!marker) expect(scope.completeness.issues[0].message).toContain('orcaops history convert');
    expect(await readdir(directoryPath)).toEqual(before);
    expect(await readFile(retained, 'utf8')).toBe('preserved original history');
  }
);
