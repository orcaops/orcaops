import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import * as closure from './object-closure.js';
import { prepareDatabaseSnapshot, type PrepareDatabaseSnapshot } from './snapshot.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

vi.mock('./object-closure.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./object-closure.js')>()),
}));

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]) {
  const result = await execute('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  return result.stdout.trim();
}
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'retention-publication-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Retained object');
  const root = path.join(directory, 'history');
  await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: ['Create disposable history'],
    secretAllow: [],
  });
  const context = await requireDatabaseExecutionContext({ cwd, root });
  const publication = {
    fullRef:
      'refs/orcaops/snap/01900000-0000-7000-8000-000000000001/1/open-01900000-0000-7000-8000-000000000002',
    objectOid: await git(cwd, 'rev-parse', 'HEAD'),
    treeOid: await git(cwd, 'rev-parse', 'HEAD^{tree}'),
    objectFormat: 'sha1' as const,
  };
  return { directory, cwd, root, context, publication };
}
const input: PrepareDatabaseSnapshot = {
  label: 'Original authored snapshot',
  source: { kind: 'worktree' },
  authoredPayloads: ['Original authored capture'],
  secretAllow: [],
};
it('prepares a durable worktree tree while preserving real index and existing exclusions', async () => {
  const f = await fixture();
  await writeFile(path.join(f.cwd, 'visible.txt'), 'Captured bytes\n');
  await writeFile(path.join(f.cwd, '.env'), 'excluded snapshot fixture\n');
  const index = await readFile(path.join(f.cwd, '.git', 'index'));
  const result = await prepareDatabaseSnapshot(f.context, { ...input, excludePatterns: ['.env'] });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error_message);
  expect(await git(f.cwd, 'show', `${result.commit_sha}:visible.txt`)).toBe('Captured bytes');
  expect(await git(f.cwd, 'ls-tree', '--name-only', result.tree_sha)).not.toContain('.env');
  expect(await git(f.cwd, 'rev-list', '--parents', '-1', result.commit_sha)).toBe(
    result.commit_sha
  );
  expect(await readFile(path.join(f.cwd, '.git', 'index'))).toEqual(index);
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops')).toBe('');
});
it('wraps the exact inherited tree without incorporating later worktree changes', async () => {
  const f = await fixture();
  await writeFile(path.join(f.cwd, 'later.txt'), 'Later worktree bytes\n');
  const result = await prepareDatabaseSnapshot(f.context, {
    ...input,
    source: { kind: 'tree', treeOid: f.publication.treeOid },
  });
  expect(result).toMatchObject({ ok: true, tree_sha: f.publication.treeOid, unmerged_paths: [] });
  if (!result.ok) throw new Error(result.error_message);
  expect(await git(f.cwd, 'rev-list', '--parents', '-1', result.commit_sha)).toBe(
    result.commit_sha
  );
  expect(await git(f.cwd, 'ls-tree', '--name-only', result.tree_sha)).not.toContain('later.txt');
});
it.each(['floor', 'base'] as const)(
  'preserves fixed original review %s wrapper identity and bytes',
  async (role) => {
    const f = await fixture();
    const request: PrepareDatabaseSnapshot = {
      ...input,
      source: {
        kind: 'review-pin',
        role,
        treeOid: f.publication.treeOid,
        reviewId: 'original-review',
        generatedAt: '2026-09-01T00:00:00.000Z',
      },
    };
    const result = await prepareDatabaseSnapshot(f.context, request);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error_message);
    expect(await git(f.cwd, 'cat-file', 'commit', result.commit_sha)).toBe(
      `tree ${f.publication.treeOid}\nauthor orcaops-review <orcaops@local> 946684800 +0000\ncommitter orcaops-review <orcaops@local> 946684800 +0000\n\nreview-pin: original-review${role === 'base' ? '-base' : ''} 2026-09-01T00:00:00.000Z`
    );
    expect(await prepareDatabaseSnapshot(f.context, request)).toMatchObject({
      ok: true,
      commit_sha: result.commit_sha,
    });
  }
);
it('refuses raw escaped duplicate-key secrets before any ownership observation or object writes', async () => {
  const f = await fixture();
  const refused = `ghp_${'Q'.repeat(36)}`;
  const source = JSON.stringify({ value: refused })
    .replace('ghp_', '\\u0067hp_')
    .replace(/}$/, ',"value":"safe"}');
  const observe = vi.spyOn(closure, 'requireOwnedDatabaseGitObjects');
  await expect(
    prepareDatabaseSnapshot(f.context, { ...input, authoredPayloads: [source] })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(observe).not.toHaveBeenCalled();
});
it('reports unavailable snapshot evidence for borrowed storage and failed closure verification', async () => {
  const f = await fixture();
  const file = path.join(f.cwd, '.git', 'objects', 'info', 'alternates');
  await writeFile(file, path.join(f.directory, 'borrowed') + '\n');
  expect(await prepareDatabaseSnapshot(f.context, input)).toMatchObject({
    ok: false,
    error_reason: 'unknown',
    error_message: expect.stringContaining('self-contained'),
  });
  await rm(file);
  vi.spyOn(closure, 'prepareDatabaseGitClosure').mockRejectedValueOnce(
    new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Disposable closure writeout failure')
  );
  expect(await prepareDatabaseSnapshot(f.context, input)).toMatchObject({
    ok: false,
    error_reason: 'unknown',
    error_message: 'Disposable closure writeout failure',
  });
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops')).toBe('');
});
it('detaches authored input across asynchronous preparation and preserves pre-cancellation', async () => {
  const f = await fixture();
  await writeFile(path.join(f.cwd, 'original.txt'), 'Original selected bytes\n');
  const request = structuredClone(input);
  const observe = closure.requireOwnedDatabaseGitObjects;
  vi.spyOn(closure, 'requireOwnedDatabaseGitObjects').mockImplementationOnce(async (...args) => {
    const result = await observe(...args);
    request.label = 'Changed caller label';
    request.source = { kind: 'tree', treeOid: f.publication.treeOid };
    return result;
  });
  const result = await prepareDatabaseSnapshot(f.context, request);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error_message);
  expect(await git(f.cwd, 'show', '-s', '--format=%B', result.commit_sha)).toBe(
    'orcaops snapshot Original authored snapshot'
  );
  expect(await git(f.cwd, 'show', `${result.commit_sha}:original.txt`)).toBe(
    'Original selected bytes'
  );
  await expect(
    prepareDatabaseSnapshot(f.context, input, { signal: AbortSignal.abort() })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
});

it('retains unmerged-path degradation while preparing the current conflict bytes', async () => {
  const f = await fixture();
  await writeFile(path.join(f.cwd, 'shared.txt'), 'original\n');
  await git(f.cwd, 'add', 'shared.txt');
  await git(f.cwd, 'commit', '-qm', 'Original shared content');
  await git(f.cwd, 'checkout', '-qb', 'other');
  await writeFile(path.join(f.cwd, 'shared.txt'), 'other\n');
  await git(f.cwd, 'commit', '-qam', 'Other shared content');
  await git(f.cwd, 'checkout', 'topic');
  await writeFile(path.join(f.cwd, 'shared.txt'), 'current\n');
  await git(f.cwd, 'commit', '-qam', 'Current shared content');
  await expect(git(f.cwd, 'merge', 'other')).rejects.toBeDefined();
  const context = await requireDatabaseExecutionContext(f);
  const bytes = await readFile(path.join(f.cwd, 'shared.txt'), 'utf8');
  const result = await prepareDatabaseSnapshot(context, input);
  expect(result).toMatchObject({ ok: true, unmerged_paths: ['shared.txt'] });
  if (!result.ok) throw new Error(result.error_message);
  expect(await git(f.cwd, 'show', `${result.commit_sha}:shared.txt`)).toBe(bytes.trim());
});

it('reports the operation budget as unavailable evidence while preserving caller cancellation semantics', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.spyOn(closure, 'requireOwnedDatabaseGitObjects').mockImplementationOnce(
    async (_context, options) => {
      await new Promise<void>((_resolve, reject) =>
        options!.signal!.addEventListener(
          'abort',
          () =>
            reject(
              new ProjectDatabaseError(
                'CANCELLED',
                'Owned observation received deadline cancellation'
              )
            ),
          { once: true }
        )
      );
      throw new Error('Unreachable successful ownership observation');
    }
  );
  const pending = prepareDatabaseSnapshot(f.context, input);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await pending).toMatchObject({
    ok: false,
    error_reason: 'unknown',
    error_message: expect.stringContaining('five-minute operation budget'),
  });
});

it('refuses cyclic, sparse and accessor-authored JSON before object observation', async () => {
  const f = await fixture();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let accessed = false;
  const accessor = {
    get value() {
      accessed = true;
      return 'not inspected';
    },
  };
  const hidden = { [Symbol('hidden')]: 'unsupported authored property' };
  const observe = vi.spyOn(closure, 'requireOwnedDatabaseGitObjects');
  for (const value of [cycle, new Array(2), accessor, hidden]) {
    await expect(
      prepareDatabaseSnapshot(f.context, {
        ...input,
        authoredPayloads: [value],
      } as PrepareDatabaseSnapshot)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(accessed).toBe(false);
  expect(observe).not.toHaveBeenCalled();
});
