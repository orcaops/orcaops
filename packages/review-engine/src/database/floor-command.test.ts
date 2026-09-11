import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import { executeDatabaseReviewData } from './floor-command.js';
import { runReview } from '../run.js';

vi.mock('@orcaops/storage/history/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@orcaops/storage/history/database')>()),
  openProjectDatabase: vi.fn(
    (await importOriginal<typeof import('@orcaops/storage/history/database')>()).openProjectDatabase
  ),
}));

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]) {
  const result = await exec(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', ...args],
    { cwd }
  );
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'review-data-'));
  roots.push(root);
  const gitRoot = path.join(root, 'repo');
  await mkdir(gitRoot);
  await git(gitRoot, ['init', '--quiet', '--initial-branch=main']);
  await writeFile(path.join(gitRoot, 'value.txt'), 'original\n');
  await git(gitRoot, ['add', 'value.txt']);
  await git(gitRoot, ['commit', '--quiet', '-m', 'Original base']);
  const baseOid = await git(gitRoot, ['rev-parse', 'HEAD']);
  const authority = (
    await setupProjectDatabase({
      cwd: gitRoot,
      root: path.join(root, 'history'),
      authoredPayloads: [],
      secretAllow: [],
    })
  ).initialization.authority;
  return { root, gitRoot, authority, baseOid, dataRoot: path.join(root, 'history') };
}

function request(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    branch: 'main',
    root: f.gitRoot,
    dataRoot: f.dataRoot,
    projectId: f.authority.projectId,
    operationId: uuidv7(),
    generatedAt: '2026-06-01T00:00:00.000Z',
    secretAllow: [] as string[],
    ...overrides,
  };
}

async function rows(f: Awaited<ReturnType<typeof fixture>>) {
  const database = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  try {
    return database.read((view) => ({
      reviews: view.all<{ review_id: string }>('SELECT review_id FROM reviews'),
      publications: view.all<{ publication_id: string; kind: string }>(
        'SELECT publication_id, kind FROM review_evidence_publications ORDER BY rowid'
      ),
      selection: view.get<{
        floor_publication_id: string | null;
        floor_version: number;
        base_revision_id: string | null;
        base_version: number;
      }>(
        'SELECT floor_publication_id, floor_version, base_revision_id, base_version FROM review_selections'
      ),
      bases: view.all<{ revision_id: string }>('SELECT revision_id FROM review_base_revisions'),
    })).value;
  } finally {
    database.close();
  }
}

it('mints the review and publishes its floor with the retained selection advanced', async () => {
  const f = await fixture();
  const result = await executeDatabaseReviewData(request(f));
  expect(result).toMatchObject({
    ok: true,
    membership_outcome: 'created',
    floor_outcome: 'published',
  });
  expect(result.floor.scope.branch).toBe('main');
  const after = await rows(f);
  expect(after.reviews).toHaveLength(1);
  expect(after.publications.filter((row) => row.kind === 'floor')).toEqual([
    { publication_id: result.publication_id, kind: 'floor' },
  ]);
  expect(after.selection).toMatchObject({
    floor_publication_id: result.publication_id,
    floor_version: 1,
  });
});

it('retains the selected floor when the inputs are unchanged', async () => {
  const f = await fixture();
  const first = await executeDatabaseReviewData(request(f));
  const before = await rows(f);
  const second = await executeDatabaseReviewData(request(f));
  expect(second).toMatchObject({
    membership_outcome: 'retained',
    floor_outcome: 'retained',
    publication_id: first.publication_id,
  });
  expect(second.floor.input_hash).toBe(first.floor.input_hash);
  expect(await rows(f)).toEqual(before);
}, 60_000);

it('publishes a new floor when the reviewed worktree moves', async () => {
  const f = await fixture();
  const first = await executeDatabaseReviewData(request(f));
  await writeFile(path.join(f.gitRoot, 'value.txt'), 'changed\n');
  await git(f.gitRoot, ['add', 'value.txt']);
  const second = await executeDatabaseReviewData(request(f));
  expect(second.floor_outcome).toBe('published');
  expect(second.publication_id).not.toBe(first.publication_id);
  expect(second.floor.input_hash).not.toBe(first.floor.input_hash);
  expect(second.floor.coverage.summary.unexplained_rows).toBeGreaterThan(
    first.floor.coverage.summary.unexplained_rows
  );
  expect(second.floor.outline.unassigned.gap.files.map((entry) => entry.file)).toContain(
    'value.txt'
  );
  const after = await rows(f);
  expect(after.publications.filter((row) => row.kind === 'floor')).toHaveLength(2);
  expect(after.selection).toMatchObject({
    floor_publication_id: second.publication_id,
    floor_version: 2,
  });
}, 60_000);

it('records an explicit base as the review base policy', async () => {
  const f = await fixture();
  await executeDatabaseReviewData(request(f));
  const before = await rows(f);
  expect(before.selection!.base_revision_id).toBeNull();
  const pinned = await executeDatabaseReviewData(request(f, { base: f.baseOid }));
  expect(pinned.floor_outcome).toBe('published');
  const after = await rows(f);
  expect(after.bases).toHaveLength(1);
  expect(after.selection).toMatchObject({ base_version: 1 });
  expect(after.selection!.base_revision_id).toBe(after.bases[0]!.revision_id);
}, 60_000);

it('retains a scope-warning disclosure on the floor rather than dropping it', async () => {
  const f = await fixture();
  // A non-ignored untracked file the tracked-only review policy excludes is a
  // scope caveat the floor must surface, not silently drop.
  await writeFile(path.join(f.gitRoot, 'untracked.txt'), 'loose\n');
  const result = await executeDatabaseReviewData(request(f));
  const excluded = result.floor.disclosure.find(
    (entry) => entry.code === 'untracked_evidence_excluded'
  );
  expect(excluded, 'the excluded-untracked scope warning is retained').toBeDefined();
  expect(excluded!.message).toContain('untracked.txt');
}, 60_000);

it('reuses a saved explicit base on a later refresh with no --base and lets a new --base override it', async () => {
  const f = await fixture();
  const commit1 = f.baseOid;
  await writeFile(path.join(f.gitRoot, 'value.txt'), 'second\n');
  await git(f.gitRoot, ['commit', '--quiet', '-am', 'Second']);
  const commit2 = await git(f.gitRoot, ['rev-parse', 'HEAD']);
  await writeFile(path.join(f.gitRoot, 'value.txt'), 'third\n');
  await git(f.gitRoot, ['commit', '--quiet', '-am', 'Third']);

  const pinned = await executeDatabaseReviewData(request(f, { base: commit1 }));
  expect(pinned.floor.scope.base_sha).toBe(commit1);
  expect((await rows(f)).selection).toMatchObject({ base_version: 1 });

  // No --base: the saved explicit base is reused rather than re-resolved to the
  // automatic base (HEAD here), so the refresh is not rejected as stale and
  // re-serves the retained floor.
  const reused = await executeDatabaseReviewData(request(f));
  expect(reused.floor_outcome).toBe('retained');
  expect(reused.floor.scope.base_sha).toBe(commit1);
  expect(reused.publication_id).toBe(pinned.publication_id);
  const afterReuse = await rows(f);
  expect(afterReuse.selection).toMatchObject({ base_version: 1 });
  expect(afterReuse.bases).toHaveLength(1);

  // An explicit new --base overrides the saved base and republishes.
  const overridden = await executeDatabaseReviewData(request(f, { base: commit2 }));
  expect(overridden.floor.scope.base_sha).toBe(commit2);
  expect(overridden.publication_id).not.toBe(pinned.publication_id);
  const afterOverride = await rows(f);
  expect(afterOverride.selection).toMatchObject({ base_version: 2 });
  expect(afterOverride.bases).toHaveLength(2);
}, 60_000);

it('refuses an unresolvable explicit base before opening any write-capable connection', async () => {
  const f = await fixture();
  vi.mocked(store.openProjectDatabase).mockClear();
  await expect(executeDatabaseReviewData(request(f, { base: 'not-a-ref' }))).rejects.toThrow(
    /invalid --base/
  );
  // Receipt-first replay reads the operation receipt before the base is
  // resolved against Git, so the verb opens a READER first by design; the
  // refusal still lands before anything write-capable.
  expect(vi.mocked(store.openProjectDatabase).mock.calls.map(([call]) => call.mode)).not.toContain(
    'writer'
  );
});

it('refuses a blank branch before opening any database connection at all', async () => {
  const f = await fixture();
  vi.mocked(store.openProjectDatabase).mockClear();
  await expect(executeDatabaseReviewData(request(f, { branch: '   ' }))).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
});

it('retains the floor evidence members under their exact names', async () => {
  const f = await fixture();
  const result = await executeDatabaseReviewData(request(f));
  const database = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  try {
    const members = database.read((view) =>
      view.all<{ name: string; kind: string }>(
        'SELECT name, kind FROM review_evidence_members WHERE publication_id = ? ORDER BY name',
        result.publication_id
      )
    ).value;
    expect(members).toEqual([
      { name: 'diff.patch', kind: 'diff' },
      { name: 'floor.json', kind: 'floor' },
    ]);
  } finally {
    database.close();
  }
  await expect(
    readFile(path.join(f.gitRoot, '.orcaops', 'reviews', 'main', 'floor.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reaches the registered root from a stray cwd', async () => {
  const f = await fixture();
  vi.stubEnv('ORCAOPS_DATA_DIR', f.dataRoot);
  const stray = await mkdtemp(path.join(tmpdir(), 'orcaops-stray-verb-'));
  roots.push(stray);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    expect(
      await runReview(
        ['review', 'data', '--branch', 'main', '--root', f.gitRoot, '--json'],
        {},
        stray
      )
    ).toBe(0);
  } finally {
    stdout.mockRestore();
    vi.unstubAllEnvs();
  }
}, 60_000);
