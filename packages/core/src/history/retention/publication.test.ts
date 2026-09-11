import { execFile, spawn } from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { publishDatabaseGitRef, removeDatabaseGitRef } from './publication.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
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
it('creates an immutable ref and acknowledges exact loose and packed retries', async () => {
  const f = await fixture();
  expect(await publishDatabaseGitRef(f.context, f.publication)).toMatchObject({
    publication: 'created',
  });
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
  expect(await publishDatabaseGitRef(f.context, f.publication)).toMatchObject({
    publication: 'existing',
  });
  await git(f.cwd, 'pack-refs', '--all');
  const packed = await readFile(path.join(f.cwd, '.git', 'packed-refs'));
  expect(await publishDatabaseGitRef(f.context, f.publication)).toMatchObject({
    publication: 'existing',
  });
  expect(await readFile(path.join(f.cwd, '.git', 'packed-refs'))).toEqual(packed);
});
it('protects a different existing object without replacing it', async () => {
  const f = await fixture();
  await git(f.cwd, 'commit', '--allow-empty', '-qm', 'Different retained object');
  const other = await git(f.cwd, 'rev-parse', 'HEAD');
  await git(f.cwd, 'update-ref', f.publication.fullRef, other);
  const context = await requireDatabaseExecutionContext(f);
  await expect(publishDatabaseGitRef(context, f.publication)).rejects.toMatchObject({
    code: 'HISTORY_UNEXPECTED_OWNER',
  });
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(other);
});
it.each(['refs/heads/topic', 'refs/heads/absent'])(
  'protects symbolic publication target %s',
  async (target) => {
    const f = await fixture();
    await git(f.cwd, 'symbolic-ref', f.publication.fullRef, target);
    await expect(publishDatabaseGitRef(f.context, f.publication)).rejects.toMatchObject({
      code: 'HISTORY_UNEXPECTED_OWNER',
    });
    expect(await git(f.cwd, 'symbolic-ref', f.publication.fullRef)).toBe(target);
  }
);
it('rejects a mismatched tree and pre-cancellation before publishing a ref', async () => {
  const f = await fixture();
  await expect(
    publishDatabaseGitRef(f.context, { ...f.publication, treeOid: f.publication.objectOid })
  ).rejects.toMatchObject({ code: 'HISTORY_UNEXPECTED_OWNER' });
  await expect(
    publishDatabaseGitRef(f.context, f.publication, { signal: AbortSignal.abort() })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops/snap/')).toBe('');
});
it('rejects a symlinked publication ancestor without writing its target', async () => {
  const f = await fixture();
  const outside = path.join(f.directory, 'outside');
  await mkdir(outside);
  await mkdir(path.join(f.cwd, '.git', 'refs', 'orcaops'), { recursive: true });
  await symlink(outside, path.join(f.cwd, '.git', 'refs', 'orcaops', 'snap'));
  await expect(publishDatabaseGitRef(f.context, f.publication)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  await expect(
    readFile(path.join(outside, f.publication.fullRef.split('/').slice(3).join('/')))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('allows concurrent creators of the same immutable publication to converge', async () => {
  const f = await fixture();
  const results = await Promise.all([
    publishDatabaseGitRef(f.context, f.publication),
    publishDatabaseGitRef(f.context, f.publication),
  ]);
  expect(results.map((r) => r.publication).sort()).toEqual(['created', 'existing']);
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
});

it('waits for a prepared creator and acknowledges its exact publication', async () => {
  const f = await fixture();
  const creator = spawn('git', ['-C', f.cwd, 'update-ref', '--stdin']);
  let output = '';
  let stderr = '';
  const closed = new Promise<number | null>((resolve) => creator.once('close', resolve));
  creator.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const prepared = new Promise<void>((resolve, reject) => {
    creator.once('error', reject);
    creator.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('prepare: ok\n')) resolve();
    });
    void closed.then((code) => reject(new Error(`Creator exited ${code}: ${stderr}`)));
  });
  creator.stdin.on('error', () => {});
  creator.stdin.write(
    `start\nupdate ${f.publication.fullRef} ${f.publication.objectOid} ${'0'.repeat(40)}\nprepare\n`
  );
  const watchdog = setTimeout(() => creator.kill('SIGKILL'), 4000);
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    await prepared;
    const result = publishDatabaseGitRef(f.context, f.publication).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    release = setTimeout(() => creator.stdin.end('commit\n'), 1000);
    const [outcome, code] = await Promise.all([result, closed]);
    expect(code, stderr).toBe(0);
    expect(outcome).toMatchObject({ value: { publication: 'existing' } });
    expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
  } finally {
    clearTimeout(release);
    clearTimeout(watchdog);
    creator.kill('SIGKILL');
    await closed;
  }
});

it('preserves a created ref after writeout failure and permits its exact retry', async () => {
  const f = await fixture();
  const original = filesystem.open;
  let failed = false;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    if (args[0] === path.join(f.cwd, '.git', f.publication.fullRef) && !failed) {
      failed = true;
      throw Object.assign(new Error('Disposable writeout failure'), { code: 'EIO' });
    }
    return original(...args);
  });
  await expect(publishDatabaseGitRef(f.context, f.publication)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  expect(failed).toBe(true);
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
  vi.restoreAllMocks();
  expect(await publishDatabaseGitRef(f.context, f.publication)).toMatchObject({
    publication: 'existing',
  });
});
it('cancels a suspended owned Git transaction and retries after explicit Git-lock repair', async () => {
  const f = await fixture();
  const pidFile = path.join(f.directory, 'hook-pid');
  const hook = path.join(f.cwd, '.git', 'hooks', 'reference-transaction');
  await writeFile(
    hook,
    `#!/bin/sh
if [ "$1" = prepared ]; then
  echo $$ > '${pidFile}'
  kill -STOP $$
fi
`,
    { mode: 0o755 }
  );
  const controller = new AbortController();
  const pending = publishDatabaseGitRef(f.context, f.publication, { signal: controller.signal });
  const outcome = pending.then(
    () => null,
    (error: unknown) => error
  );
  let observed = false;
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        await readFile(pidFile);
        observed = true;
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    controller.abort();
  }
  expect(await outcome).toMatchObject({ code: 'CANCELLED' });
  expect(observed).toBe(true);
  await rm(hook);
  const lock = path.join(f.cwd, '.git', `${f.publication.fullRef}.lock`);
  // Git can leave its own interrupted lock; this fixture explicitly repairs it before retry.
  await rm(lock, { force: true });
  expect(await publishDatabaseGitRef(f.context, f.publication)).toMatchObject({
    publication: 'created',
  });
});

function removal(publication: Awaited<ReturnType<typeof fixture>>['publication']) {
  return {
    fullRef: publication.fullRef,
    objectOid: publication.objectOid,
    objectFormat: publication.objectFormat,
  };
}
it.each([false, true])(
  'removes only the exact immutable ref and acknowledges absence when packed is %s',
  async (packed) => {
    const f = await fixture();
    await publishDatabaseGitRef(f.context, f.publication);
    if (packed) await git(f.cwd, 'pack-refs', '--all');
    expect(await removeDatabaseGitRef(f.context, removal(f.publication))).toMatchObject({
      outcome: 'removed',
    });
    expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', f.publication.fullRef)).toBe('');
    expect(await git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.publication.objectOid);
    expect(await removeDatabaseGitRef(f.context, removal(f.publication))).toMatchObject({
      outcome: 'absent',
    });
  }
);
it('protects symbolic cleanup targets and refuses a different expected object', async () => {
  const f = await fixture();
  await git(f.cwd, 'symbolic-ref', f.publication.fullRef, 'refs/heads/topic');
  await expect(removeDatabaseGitRef(f.context, removal(f.publication))).rejects.toMatchObject({
    code: 'HISTORY_UNEXPECTED_OWNER',
  });
  expect(await git(f.cwd, 'symbolic-ref', f.publication.fullRef)).toBe('refs/heads/topic');
  await git(f.cwd, 'symbolic-ref', '--delete', f.publication.fullRef);
  await publishDatabaseGitRef(f.context, f.publication);
  await expect(
    removeDatabaseGitRef(f.context, { ...removal(f.publication), objectOid: 'a'.repeat(40) })
  ).rejects.toMatchObject({ code: 'HISTORY_UNEXPECTED_OWNER' });
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
});
it('preserves a publication when cleanup is already cancelled', async () => {
  const f = await fixture();
  await publishDatabaseGitRef(f.context, f.publication);
  await expect(
    removeDatabaseGitRef(f.context, removal(f.publication), { signal: AbortSignal.abort() })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
});
it('reports re-observed absence after interrupted removal writeout without recreating the ref', async () => {
  const f = await fixture();
  await publishDatabaseGitRef(f.context, f.publication);
  const original = filesystem.open;
  let failed = false;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    if (args[0] === path.join(f.cwd, '.git') && !failed) {
      failed = true;
      throw Object.assign(new Error('Disposable removal writeout failure'), { code: 'EIO' });
    }
    return original(...args);
  });
  await expect(removeDatabaseGitRef(f.context, removal(f.publication))).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  expect(failed).toBe(true);
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', f.publication.fullRef)).toBe('');
  vi.restoreAllMocks();
  expect(await removeDatabaseGitRef(f.context, removal(f.publication))).toMatchObject({
    outcome: 'absent',
  });
});
it('preserves an occupied Git lock and reports explicit repair before original retry', async () => {
  // Git deliberately spends two seconds waiting for the occupied lock before the retry.
  const f = await fixture();
  const lock = path.join(f.cwd, '.git', `${f.publication.fullRef}.lock`);
  await mkdir(path.dirname(lock), { recursive: true });
  const marker = 'Original unknown Git lock owner\n';
  await writeFile(lock, marker);
  await expect(publishDatabaseGitRef(f.context, f.publication)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
    message: expect.stringContaining('explicit Git repair'),
  });
  expect(await readFile(lock, 'utf8')).toBe(marker);
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', f.publication.fullRef)).toBe('');
  await rm(lock);
  expect(await publishDatabaseGitRef(f.context, f.publication)).toMatchObject({
    publication: 'created',
  });
}, 15000);

it.each(['original', 'replacement'])(
  'validates the actual retained object despite a %s tree claim',
  async (claim) => {
    const f = await fixture();
    await writeFile(path.join(f.cwd, 'replacement.txt'), 'Different object content\n');
    await git(f.cwd, 'add', 'replacement.txt');
    const replacementTree = await git(f.cwd, 'write-tree');
    const replacement = await git(
      f.cwd,
      'commit-tree',
      replacementTree,
      '-m',
      'Replacement object'
    );
    await git(f.cwd, 'replace', f.publication.objectOid, replacement);
    expect(await git(f.cwd, 'rev-parse', `${f.publication.objectOid}^{tree}`)).toBe(
      replacementTree
    );
    const published = publishDatabaseGitRef(f.context, {
      ...f.publication,
      treeOid: claim === 'original' ? f.publication.treeOid : replacementTree,
    });
    if (claim === 'original')
      expect(await published).toMatchObject({
        publication: 'created',
        objectOid: f.publication.objectOid,
      });
    else {
      await expect(published).rejects.toMatchObject({ code: 'HISTORY_UNEXPECTED_OWNER' });
      expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops/snap/')).toBe(
        ''
      );
    }
  }
);
