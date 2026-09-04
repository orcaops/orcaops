import { writeFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { publishInstallManifestsLast } from './install-plan.js';
import {
  deleteMutation,
  dirMutation,
  executeMutations,
  FILE_OWNERSHIP_UNVERIFIED,
  fileMutation,
  formatDryRunPreview,
  injectMutation,
  mutationGlyph,
  planGitHookMutation,
  type PlannedMutation,
  planRemoveGitHooks,
  readContainedRepositoryRegularFileOrNull,
  readRepositoryFileForOwnership,
  readRepositoryRegularFileOrNull,
  symlinkMutation,
  writeMutation,
} from './mutations.js';

describe('mutation executor', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-mut-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fileMut = (rel: string, content: string): PlannedMutation =>
    writeMutation(root, rel, content, null, true);

  const failingFileMut = (rel: string, beforeFailure?: () => void): PlannedMutation => {
    const mutation = fileMut(rel, 'never written');
    Object.defineProperty(mutation, 'desiredContent', {
      get: () => {
        beforeFailure?.();
        throw new Error('simulated staging failure');
      },
    });
    return mutation;
  };

  const mutationResidue = async (targetRoot: string = root): Promise<string[]> =>
    (await readdir(targetRoot, { recursive: true })).filter((entry) =>
      entry.includes('.orcaops-mutation-')
    );

  it('preview mode partitions but writes NOTHING', async () => {
    const muts = [fileMut('a.txt', 'A'), dirMutation(root, 'sub', false)];
    const res = await executeMutations(muts, 'preview');
    expect(res.mode).toBe('preview');
    expect(res.changed).toHaveLength(2);
    await expect(stat(path.join(root, 'a.txt'))).rejects.toThrow();
    await expect(stat(path.join(root, 'sub'))).rejects.toThrow();
  });

  it('apply mode writes the planned files and directories', async () => {
    const res = await executeMutations(
      [fileMut('nested/a.txt', 'A'), dirMutation(root, 'sub', false)],
      'apply'
    );
    expect(res.changed).toHaveLength(2);
    expect(await readFile(path.join(root, 'nested/a.txt'), 'utf8')).toBe('A');
    expect((await stat(path.join(root, 'sub'))).isDirectory()).toBe(true);
  });

  it('preflights every changed target before applying an earlier write', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-mut-preflight-'));
    const sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'outside', 'utf8');
    await symlink(sentinel, path.join(root, 'redirect.txt'));
    try {
      await expect(
        executeMutations(
          [fileMut('earlier.txt', 'must not be written'), fileMut('redirect.txt', 'changed')],
          'apply'
        )
      ).rejects.toThrow(/must not contain symlinks/);
      await expect(lstat(path.join(root, 'earlier.txt'))).rejects.toThrow();
      expect(await readFile(sentinel, 'utf8')).toBe('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rolls back earlier writes when a later staging operation fails', async () => {
    await expect(
      executeMutations([fileMut('first.txt', 'first'), failingFileMut('second.txt')], 'apply')
    ).rejects.toThrow('simulated staging failure');

    await expect(lstat(path.join(root, 'first.txt'))).rejects.toThrow();
    await expect(lstat(path.join(root, 'second.txt'))).rejects.toThrow();
    expect(await mutationResidue()).toEqual([]);
  });

  it('restores replaced file bytes and mode when a later mutation fails', async () => {
    const target = path.join(root, 'managed.sh');
    await writeFile(target, 'old\n', 'utf8');
    await chmod(target, 0o740);
    const replacement = writeMutation(root, 'managed.sh', 'new\n', 'old\n', true);

    await expect(
      executeMutations([replacement, failingFileMut('later.txt')], 'apply')
    ).rejects.toThrow('simulated staging failure');

    expect(await readFile(target, 'utf8')).toBe('old\n');
    expect((await stat(target)).mode & 0o777).toBe(0o740);
    expect(await mutationResidue()).toEqual([]);
  });

  it('preserves a replaced file mode after a successful atomic publication', async () => {
    const target = path.join(root, 'managed.sh');
    await writeFile(target, 'old\n', 'utf8');
    await chmod(target, 0o764);

    await executeMutations([writeMutation(root, 'managed.sh', 'new\n', 'old\n', true)], 'apply');

    expect(await readFile(target, 'utf8')).toBe('new\n');
    expect((await stat(target)).mode & 0o777).toBe(0o764);
  });

  it('applies an explicit replacement mode', async () => {
    const target = path.join(root, 'managed.sh');
    await writeFile(target, 'old\n', 'utf8');
    await chmod(target, 0o644);
    const mutation = writeMutation(root, 'managed.sh', 'new\n', 'old\n', true);
    mutation.mode = 0o755;

    await executeMutations([mutation], 'apply');

    expect(await readFile(target, 'utf8')).toBe('new\n');
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  it('restores deleted files, symlinks, and directories in reverse order', async () => {
    await writeFile(path.join(root, 'file.txt'), 'file bytes', 'utf8');
    await writeFile(path.join(root, 'target.txt'), 'target', 'utf8');
    await symlink('target.txt', path.join(root, 'link.txt'));
    await mkdir(path.join(root, 'directory'));
    await writeFile(path.join(root, 'directory', 'nested.txt'), 'nested', 'utf8');
    const mutations: PlannedMutation[] = [
      deleteMutation(root, 'file.txt', { kind: 'file', content: 'file bytes' }, true),
      deleteMutation(root, 'link.txt', { kind: 'symlink', target: 'target.txt' }, true),
      deleteMutation(root, 'directory', { kind: 'directory' }, true),
      failingFileMut('later.txt'),
    ];

    await expect(executeMutations(mutations, 'apply')).rejects.toThrow('simulated staging failure');

    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('file bytes');
    expect(await readlink(path.join(root, 'link.txt'))).toBe('target.txt');
    expect(await readFile(path.join(root, 'directory', 'nested.txt'), 'utf8')).toBe('nested');
    expect(await mutationResidue()).toEqual([]);
  });

  it('removes created files, symlinks, directories, and parents during rollback', async () => {
    await writeFile(path.join(root, 'target.txt'), 'target', 'utf8');
    const mutations: PlannedMutation[] = [
      fileMut('nested/deep/file.txt', 'created'),
      symlinkMutation(root, 'nested/deep/link.txt', '../../target.txt', true),
      dirMutation(root, 'nested/empty', false),
      failingFileMut('later.txt'),
    ];

    await expect(executeMutations(mutations, 'apply')).rejects.toThrow('simulated staging failure');

    await expect(lstat(path.join(root, 'nested'))).rejects.toThrow();
    expect(await readFile(path.join(root, 'target.txt'), 'utf8')).toBe('target');
    expect(await mutationResidue()).toEqual([]);
  });

  it('does not overwrite an edit made after an earlier mutation', async () => {
    const target = path.join(root, 'first.txt');
    const later = failingFileMut('later.txt', () => writeFileSync(target, 'user edit', 'utf8'));

    await expect(
      executeMutations([fileMut('first.txt', 'installed'), later], 'apply')
    ).rejects.toThrow(/rollback requires inspection/);

    expect(await readFile(target, 'utf8')).toBe('user edit');
  });

  it('retains successful nested parents and removes staging residue', async () => {
    await executeMutations([fileMut('nested/deep/file.txt', 'installed')], 'apply');

    expect(await readFile(path.join(root, 'nested', 'deep', 'file.txt'), 'utf8')).toBe('installed');
    expect((await stat(path.join(root, 'nested', 'deep'))).isDirectory()).toBe(true);
    expect(await mutationResidue()).toEqual([]);
  });

  it('allows contained directory names that begin with two dots', async () => {
    await executeMutations([fileMut('..config/file.txt', 'installed')], 'apply');

    expect(await readFile(path.join(root, '..config', 'file.txt'), 'utf8')).toBe('installed');
  });

  it('commits nested deletions without leaving moved backups', async () => {
    await mkdir(path.join(root, '.orcaops'));
    await writeFile(path.join(root, '.orcaops', 'install.json'), '{}', 'utf8');

    await executeMutations(
      [
        deleteMutation(root, '.orcaops/install.json', { kind: 'file', content: '{}' }, true),
        deleteMutation(root, '.orcaops', { kind: 'directory' }, true),
      ],
      'apply'
    );

    await expect(lstat(path.join(root, '.orcaops'))).rejects.toThrow();
    expect(await mutationResidue()).toEqual([]);
  });

  it('skips no-op mutations (changed=false) and never writes them', async () => {
    const noop = writeMutation(root, 'x.txt', 'X', 'X', false);
    const res = await executeMutations([noop], 'apply');
    expect(res.changed).toEqual([]);
    expect(res.unchanged).toHaveLength(1);
    await expect(stat(path.join(root, 'x.txt'))).rejects.toThrow();
  });

  it('reads regular diagnostic files without following final non-file entries', async () => {
    const regular = path.join(root, 'regular.txt');
    const linked = path.join(root, 'linked.txt');
    const directory = path.join(root, 'directory');
    await writeFile(regular, 'body\n', 'utf8');
    await symlink(regular, linked);
    await mkdir(directory);

    expect(await readRepositoryRegularFileOrNull(regular, root, 'diagnostic')).toBe('body\n');
    expect(await readRepositoryRegularFileOrNull(linked, root, 'diagnostic')).toBeNull();
    expect(await readRepositoryRegularFileOrNull(directory, root, 'diagnostic')).toBeNull();
  });

  it('reports non-regular ownership entries as unverified', async () => {
    const regular = path.join(root, 'regular.txt');
    const linked = path.join(root, 'linked.txt');
    const directory = path.join(root, 'directory');
    await writeFile(regular, 'body\n', 'utf8');
    await symlink(regular, linked);
    await mkdir(directory);

    expect(await readRepositoryFileForOwnership(regular, root, 'owned file')).toBe('body\n');
    expect(await readRepositoryFileForOwnership(linked, root, 'owned file')).toBe(
      FILE_OWNERSHIP_UNVERIFIED
    );
    expect(await readRepositoryFileForOwnership(directory, root, 'owned file')).toBe(
      FILE_OWNERSHIP_UNVERIFIED
    );
    expect(
      await readRepositoryFileForOwnership(path.join(root, 'missing'), root, 'owned file')
    ).toBeNull();
  });

  it('distinguishes redirected diagnostic parents from ownership conflicts', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-mut-redirect-'));
    await writeFile(path.join(outside, 'entry'), 'external\n', 'utf8');
    await symlink(outside, path.join(root, 'redirect'));

    try {
      await expect(
        readRepositoryRegularFileOrNull(path.join(root, 'redirect', 'entry'), root, 'diagnostic')
      ).rejects.toThrow(/must not contain symlinks|resolves outside/);
      expect(
        await readRepositoryFileForOwnership(
          path.join(root, 'redirect', 'entry'),
          root,
          'owned file'
        )
      ).toBe(FILE_OWNERSHIP_UNVERIFIED);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reads contained file links without opening non-regular targets', async () => {
    const regular = path.join(root, 'regular.txt');
    const linked = path.join(root, 'linked.txt');
    const directory = path.join(root, 'directory');
    const linkedDirectory = path.join(root, 'linked-directory');
    await writeFile(regular, 'body\n', 'utf8');
    await mkdir(directory);
    await symlink('regular.txt', linked);
    await symlink('directory', linkedDirectory);

    expect(
      await readContainedRepositoryRegularFileOrNull(linked, root, 'contained diagnostic')
    ).toBe('body\n');
    expect(
      await readContainedRepositoryRegularFileOrNull(directory, root, 'contained diagnostic')
    ).toBeNull();
    expect(
      await readContainedRepositoryRegularFileOrNull(linkedDirectory, root, 'contained diagnostic')
    ).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'does not open contained Unix socket targets',
    async () => {
      const socketPath = path.join(root, 'entry.sock');
      const linkedSocket = path.join(root, 'linked.sock');
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await symlink('entry.sock', linkedSocket);

      try {
        expect(
          await readContainedRepositoryRegularFileOrNull(socketPath, root, 'contained diagnostic')
        ).toBeNull();
        expect(
          await readContainedRepositoryRegularFileOrNull(linkedSocket, root, 'contained diagnostic')
        ).toBeNull();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it('fails closed when an untyped caller omits the mutation root', async () => {
    const mutation = fileMut('x.txt', 'X');
    (mutation as { containmentRoot?: string }).containmentRoot = undefined;

    await expect(executeMutations([mutation], 'apply')).rejects.toThrow(
      /requires a non-empty containment root/
    );
    await expect(stat(path.join(root, 'x.txt'))).rejects.toThrow();
  });

  it('honors the file mode (e.g. 0o755 for a git hook)', async () => {
    const hook: PlannedMutation = {
      kind: 'create',
      path: 'hook',
      absPath: path.join(root, 'hook'),
      containmentRoot: root,
      desiredContent: '#!/bin/sh\n',
      currentContent: null,
      changed: true,
      mode: 0o755,
    };
    await executeMutations([hook], 'apply');
    const st = await stat(path.join(root, 'hook'));
    expect(st.mode & 0o777).toBe(0o755);
  });

  it('writes Git hooks under their external common-directory owner', async () => {
    const commonDir = await mkdtemp(path.join(tmpdir(), 'oo-mut-git-common-'));
    try {
      // git init always creates hooks/; the containment root must exist.
      await mkdir(path.join(commonDir, 'hooks'), { recursive: true });
      const plan = await planGitHookMutation(
        commonDir,
        path.join(commonDir, 'hooks'),
        'post-merge',
        '1.2.3',
        () => Promise.resolve(null)
      );

      expect(plan.mutation.path).toBe(path.join('hooks', 'post-merge'));
      expect(plan.mutation.containmentRoot).toBe(path.join(commonDir, 'hooks'));
      await executeMutations([plan.mutation], 'apply');
      expect(await readFile(path.join(commonDir, 'hooks', 'post-merge'), 'utf8')).toContain(
        '# orcaops-hook v=1.2.3'
      );
    } finally {
      await rm(commonDir, { recursive: true, force: true });
    }
  });

  it('keeps an unverified hook plan as a non-changing replacement', async () => {
    const plan = await planGitHookMutation(
      '/repo',
      path.join('/repo', '.git', 'hooks'),
      'post-merge',
      '1.2.3',
      () => Promise.resolve(FILE_OWNERSHIP_UNVERIFIED)
    );

    expect(plan.action).toBe('preserved-conflict');
    expect(plan.mutation).toMatchObject({
      kind: 'replace',
      currentContent: null,
      changed: false,
    });
    expect(mutationGlyph(plan.mutation)).toBe('~');
  });

  it('renders instruction replacement metadata without current content as a replacement', () => {
    const mutation = injectMutation(root, {
      filePath: path.join(root, 'AGENTS.md'),
      action: 'unchanged',
      desiredContent: '',
      currentContent: null,
      desiredBlock: '',
      blockHash: '',
      malformed: false,
    });

    expect(mutation).toMatchObject({
      kind: 'inject-replace',
      currentContent: null,
      changed: false,
    });
    expect(mutationGlyph(mutation)).toBe('~');
  });

  it('keeps an external mutation target independent from its display path', () => {
    const mutation = writeMutation(
      'C:\\worktree',
      '.git\\info\\exclude',
      'managed\n',
      null,
      true,
      'D:\\repo\\.git',
      'D:\\repo\\.git\\info\\exclude'
    );

    expect(mutation.path).toBe('.git\\info\\exclude');
    expect(mutation.absPath).toBe('D:\\repo\\.git\\info\\exclude');
    expect(mutation.containmentRoot).toBe('D:\\repo\\.git');
  });

  it('creates a real symlink for a symlink mutation with a target', async () => {
    await executeMutations([fileMut('AGENTS.md', 'canonical\n')], 'apply');
    const res = await executeMutations(
      [symlinkMutation(root, 'CLAUDE.md', 'AGENTS.md', true)],
      'apply'
    );
    expect(res.changed).toHaveLength(1);
    expect((await lstat(path.join(root, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
  });

  it('throws on a symlink mutation with a missing target (no silent empty file)', async () => {
    const bad: PlannedMutation = {
      kind: 'symlink',
      path: 'CLAUDE.md',
      absPath: path.join(root, 'CLAUDE.md'),
      containmentRoot: root,
      desiredContent: null,
      currentContent: null,
      changed: true,
      // symlinkTarget intentionally omitted — a planner bug
    };
    await expect(executeMutations([bad], 'apply')).rejects.toThrow(/symlinkTarget/);
    await expect(stat(path.join(root, 'CLAUDE.md'))).rejects.toThrow(); // nothing written
  });

  it('rejects writes through an ancestor symlink without changing the external file', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-mut-outside-'));
    try {
      const sentinel = path.join(outside, 'sentinel.txt');
      await writeFile(sentinel, 'outside', 'utf8');
      await symlink(outside, path.join(root, 'redirect'));

      await expect(
        executeMutations([fileMut('redirect/sentinel.txt', 'changed')], 'apply')
      ).rejects.toThrow(/must not contain symlinks/);
      expect(await readFile(sentinel, 'utf8')).toBe('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects writes to a final symlink without changing the external file', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-mut-outside-'));
    try {
      const sentinel = path.join(outside, 'sentinel.txt');
      await writeFile(sentinel, 'outside', 'utf8');
      await symlink(sentinel, path.join(root, 'redirect.txt'));

      await expect(executeMutations([fileMut('redirect.txt', 'changed')], 'apply')).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readFile(sentinel, 'utf8')).toBe('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects directory and symlink creation through an ancestor symlink', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-mut-outside-'));
    try {
      await symlink(outside, path.join(root, 'redirect'));

      await expect(
        executeMutations([dirMutation(root, 'redirect/created', false)], 'apply')
      ).rejects.toThrow(/must not contain symlinks/);
      await expect(
        executeMutations([symlinkMutation(root, 'redirect/link', '../AGENTS.md', true)], 'apply')
      ).rejects.toThrow(/must not contain symlinks/);
      expect(await stat(outside)).toBeDefined();
      await expect(stat(path.join(outside, 'created'))).rejects.toThrow();
      await expect(lstat(path.join(outside, 'link'))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects deletion through an ancestor symlink but can remove a contained final symlink', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-mut-outside-'));
    try {
      const sentinel = path.join(outside, 'sentinel.txt');
      await writeFile(sentinel, 'outside', 'utf8');
      await symlink(outside, path.join(root, 'redirect'));

      await expect(
        executeMutations(
          [
            {
              kind: 'delete',
              path: 'redirect/sentinel.txt',
              absPath: path.join(root, 'redirect', 'sentinel.txt'),
              containmentRoot: root,
              desiredContent: null,
              currentContent: null,
              changed: true,
              deleteExpectation: { kind: 'file', content: 'outside' },
            },
          ],
          'apply'
        )
      ).rejects.toThrow(/must not contain symlinks/);
      expect(await readFile(sentinel, 'utf8')).toBe('outside');

      await executeMutations(
        [
          {
            kind: 'delete',
            path: 'redirect',
            absPath: path.join(root, 'redirect'),
            containmentRoot: root,
            desiredContent: null,
            currentContent: null,
            changed: true,
            deleteExpectation: { kind: 'symlink', target: outside },
          },
        ],
        'apply'
      );
      await expect(lstat(path.join(root, 'redirect'))).rejects.toThrow();
      expect(await readFile(sentinel, 'utf8')).toBe('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a non-canonical delete entry that would normalize to another file', async () => {
    const victim = path.join(root, 'victim.txt');
    await writeFile(victim, 'keep', 'utf8');
    const mutation: PlannedMutation = {
      kind: 'delete',
      path: 'nested/../victim.txt',
      absPath: path.join(root, 'nested') + `${path.sep}..${path.sep}victim.txt`,
      containmentRoot: root,
      desiredContent: null,
      currentContent: null,
      changed: true,
      deleteExpectation: { kind: 'file', content: 'keep' },
    };

    await expect(executeMutations([mutation], 'apply')).rejects.toThrow(/canonical relative path/);
    expect(await readFile(victim, 'utf8')).toBe('keep');
  });

  it('refuses a delete when a planned file is replaced by a directory', async () => {
    const victim = path.join(root, 'victim');
    await writeFile(victim, 'planned bytes', 'utf8');
    const mutation = deleteMutation(
      root,
      'victim',
      { kind: 'file', content: 'planned bytes' },
      true
    );
    await rm(victim);
    await mkdir(victim);
    await writeFile(path.join(victim, 'sentinel.txt'), 'keep', 'utf8');

    await expect(executeMutations([mutation], 'apply')).rejects.toThrow(
      /entry kind changed after planning/
    );
    expect(await readFile(path.join(victim, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('refuses a delete when a planned symlink is repointed', async () => {
    await writeFile(path.join(root, 'first.txt'), 'first', 'utf8');
    await writeFile(path.join(root, 'second.txt'), 'second', 'utf8');
    const linkPath = path.join(root, 'linked.txt');
    await symlink('first.txt', linkPath);
    const mutation = deleteMutation(
      root,
      'linked.txt',
      { kind: 'symlink', target: 'first.txt' },
      true
    );
    await rm(linkPath);
    await symlink('second.txt', linkPath);

    await expect(executeMutations([mutation], 'apply')).rejects.toThrow(
      /symlink target changed after planning/
    );
    expect(await readlink(linkPath)).toBe('second.txt');
  });

  it('preflights every delete before applying an earlier write', async () => {
    const victim = path.join(root, 'victim.txt');
    await writeFile(victim, 'planned bytes', 'utf8');
    const deletion = deleteMutation(
      root,
      'victim.txt',
      { kind: 'file', content: 'planned bytes' },
      true
    );
    await writeFile(victim, 'changed bytes', 'utf8');

    await expect(
      executeMutations([fileMut('earlier.txt', 'must not be written'), deletion], 'apply')
    ).rejects.toThrow(/file content changed after planning/);
    await expect(lstat(path.join(root, 'earlier.txt'))).rejects.toThrow();
    expect(await readFile(victim, 'utf8')).toBe('changed bytes');
  });

  it('rejects a symlink payload that escapes its owning root', async () => {
    await expect(
      executeMutations([symlinkMutation(root, 'nested/link', '../../outside.txt', true)], 'apply')
    ).rejects.toThrow(/resolves outside/);
    await expect(lstat(path.join(root, 'nested', 'link'))).rejects.toThrow();
    await expect(stat(path.join(root, 'nested'))).rejects.toThrow();
  });
});

describe('cross-planner delete collapse (publishInstallManifestsLast)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-dedupe-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collapses exact-duplicate deletes and keeps the first', () => {
    const del = (): PlannedMutation =>
      deleteMutation(root, 'CLAUDE.md', { kind: 'file', content: 'x' }, true);
    const ordered = publishInstallManifestsLast([del(), del()]);
    expect(ordered.filter((m) => m.kind === 'delete')).toHaveLength(1);
  });

  it('keeps a delete/write pair on one path for the executor to arbitrate', () => {
    const ordered = publishInstallManifestsLast([
      deleteMutation(root, 'CLAUDE.md', { kind: 'file', content: 'x' }, true),
      writeMutation(root, 'CLAUDE.md', 'y', 'x', true),
    ]);
    expect(ordered).toHaveLength(2);
  });

  it('applies a batch where two planners claimed one entry without the disappeared-after-planning throw', async () => {
    const target = path.join(root, 'CLAUDE.md');
    await writeFile(target, 'body', 'utf8');
    const del = (): PlannedMutation =>
      deleteMutation(root, 'CLAUDE.md', { kind: 'file', content: 'body' }, true);
    const result = await executeMutations(publishInstallManifestsLast([del(), del()]), 'apply');
    expect(result.changed).toHaveLength(1);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('linked-worktree hook deletes through the transactional executor', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-wt-del-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('plans and APPLIES a delete whose repo-relative path leads with ..', async () => {
    // A linked worktree's hooks live in the git COMMON dir, outside the
    // worktree root: the display path legally leads with `..` and the
    // containment root is the hooks dir. Both apply-time gates must accept
    // exactly what plan time accepted.
    const worktree = path.join(root, 'wt');
    const hooksDir = path.join(root, 'common', 'hooks');
    await mkdir(worktree, { recursive: true });
    await mkdir(hooksDir, { recursive: true });
    const hookAbs = path.join(hooksDir, 'post-merge');
    await writeFile(hookAbs, '# orcaops-hook v=1\n', { mode: 0o755 });

    const mutation: PlannedMutation = {
      kind: 'delete',
      path: path.relative(worktree, hookAbs),
      absPath: hookAbs,
      containmentRoot: hooksDir,
      desiredContent: null,
      currentContent: '# orcaops-hook v=1\n',
      changed: true,
      deleteExpectation: { kind: 'file', content: '# orcaops-hook v=1\n' },
    };
    expect(mutation.path.startsWith('..')).toBe(true);

    const result = await executeMutations([mutation], 'apply');
    expect(result.changed).toHaveLength(1);
    await expect(lstat(hookAbs)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('managed hook mode repair', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-hook-mode-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a content-identical hook that lost its exec bits is planned as a refresh and restored to 755', async () => {
    const hooksDir = path.join(root, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const version = '9.9.9';
    const created = await planGitHookMutation(root, hooksDir, 'post-merge', version, (abs) =>
      readRepositoryFileForOwnership(abs, hooksDir, 'Git hook post-merge')
    );
    await executeMutations([created.mutation], 'apply');
    const hookAbs = path.join(hooksDir, 'post-merge');
    await chmod(hookAbs, 0o644);

    const repair = await planGitHookMutation(root, hooksDir, 'post-merge', version, (abs) =>
      readRepositoryFileForOwnership(abs, hooksDir, 'Git hook post-merge')
    );
    expect(repair.action).toBe('refreshed');
    await executeMutations([repair.mutation], 'apply');
    expect(((await lstat(hookAbs)).mode & 0o111) !== 0).toBe(true);
  });
});

describe('planRemoveGitHooks (stamp-detected hook removal)', () => {
  const defaultHooksDir = path.join('/repo', '.git', 'hooks');

  it('removes a stamped hook, preserves an unstamped (user) hook', async () => {
    const reader = (abs: string): Promise<string | null> => {
      if (abs.endsWith(path.join('.git', 'hooks', 'post-merge'))) {
        return Promise.resolve('#!/bin/sh\n# orcaops-hook v=1.2.3\norcaops lineage\n');
      }
      if (abs.endsWith(path.join('.git', 'hooks', 'post-rewrite'))) {
        return Promise.resolve('#!/bin/sh\necho my own hook\n'); // unstamped
      }
      return Promise.resolve(null);
    };
    const r = await planRemoveGitHooks('/repo', [defaultHooksDir], reader, '9.9.9');
    expect(r.removed).toEqual([path.join('.git', 'hooks', 'post-merge')]);
    expect(r.preserved).toEqual([path.join('.git', 'hooks', 'post-rewrite')]);
    expect(r.unverified).toEqual([]);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0].kind).toBe('delete');
  });

  it('no hooks installed → nothing to remove or preserve', async () => {
    const r = await planRemoveGitHooks(
      '/repo',
      [defaultHooksDir],
      () => Promise.resolve(null),
      '9.9.9'
    );
    expect(r).toEqual({
      mutations: [],
      removed: [],
      preserved: [],
      preservedAhead: [],
      unverified: [],
    });
  });

  it('an AHEAD-stamped hook is preserved, never deleted (uninstall cannot downgrade)', async () => {
    const reader = (): Promise<string | null> =>
      Promise.resolve('#!/bin/sh\n# orcaops-hook v=99.0.0\norcaops sync\n');
    const r = await planRemoveGitHooks('/repo', [defaultHooksDir], reader, '0.0.5');
    expect(r.removed).toEqual([]);
    expect(r.mutations).toEqual([]);
    expect(r.preservedAhead.map((h) => h.stampedVersion)).toEqual(['99.0.0', '99.0.0']);
  });

  it('reports ownership conflicts separately from preserved hooks', async () => {
    const r = await planRemoveGitHooks(
      '/repo',
      [defaultHooksDir],
      () => Promise.resolve(FILE_OWNERSHIP_UNVERIFIED),
      '9.9.9'
    );
    expect(r).toEqual({
      mutations: [],
      removed: [],
      preserved: [],
      preservedAhead: [],
      unverified: [
        path.join('.git', 'hooks', 'post-merge'),
        path.join('.git', 'hooks', 'post-rewrite'),
      ],
    });
  });

  it('removes a hook the linked worktree reaches through a parent-relative path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oo-wt-hooks-'));
    try {
      const worktree = path.join(root, 'wt');
      const hooksDir = path.join(root, 'repo', '.git', 'hooks');
      await mkdir(worktree, { recursive: true });
      await mkdir(hooksDir, { recursive: true });
      const hook = path.join(hooksDir, 'post-merge');
      await writeFile(hook, '#!/bin/sh\n# orcaops-hook v=1.2.3\norcaops lineage\n', 'utf8');

      const plan = await planRemoveGitHooks(
        worktree,
        [hooksDir],
        (abs) => readFile(abs, 'utf8').catch(() => null),
        '9.9.9'
      );

      // The display path escapes the worktree root — that is the only honest
      // spelling for a hook the MAIN repo owns.
      expect(plan.mutations).toHaveLength(1);
      expect(plan.mutations[0].path.startsWith('..')).toBe(true);
      await executeMutations(plan.mutations, 'apply');
      await expect(lstat(hook)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scans the candidate union and dedupes repeated dirs', async () => {
    // A hook stranded in the default dir while core.hooksPath points at
    // another dir: both candidates are scanned, duplicate entries are not.
    const externalDir = path.join('/repo', '.husky');
    const reader = (abs: string): Promise<string | null> => {
      if (abs === path.join(defaultHooksDir, 'post-merge')) {
        return Promise.resolve('#!/bin/sh\n# orcaops-hook v=0.9.0\norcaops lineage\n');
      }
      return Promise.resolve(null);
    };
    const r = await planRemoveGitHooks(
      '/repo',
      [externalDir, defaultHooksDir, defaultHooksDir],
      reader,
      '9.9.9'
    );
    expect(r.removed).toEqual([path.join('.git', 'hooks', 'post-merge')]);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0].absPath).toBe(path.join(defaultHooksDir, 'post-merge'));
  });
});

describe('formatDryRunPreview', () => {
  it('renders the stamp-divergence note on a forced-downgrade line, kind as fallback', () => {
    const downgrade = fileMutation('/repo', {
      path: 's/SKILL.md',
      kind: 'generated-file',
      desiredContent: 'new',
      currentContent: 'old',
      action: 'replace',
      reason: 'forced-downgrade',
      onDiskVersion: '99.0.0',
      hash: 'H',
    });
    const plain = fileMutation('/repo', {
      path: 't/SKILL.md',
      kind: 'generated-file',
      desiredContent: 'new',
      currentContent: null,
      action: 'create',
      hash: 'H2',
    });
    const preview = formatDryRunPreview([downgrade, plain]);
    expect(preview).toContain('~ s/SKILL.md (forced-downgrade)');
    expect(preview).toContain('+ t/SKILL.md (create)');
  });

  it('a preserved-ahead mutation is changed:false and never appears in the preview', () => {
    const preserved = fileMutation('/repo', {
      path: 's/SKILL.md',
      kind: 'generated-file',
      desiredContent: 'new',
      currentContent: 'newer-generation bytes',
      action: 'unchanged',
      reason: 'preserved-ahead',
      onDiskVersion: '99.0.0',
      hash: 'H',
    });
    expect(preserved.changed).toBe(false);
    expect(preserved.note).toBe('preserved-ahead');
    expect(formatDryRunPreview([preserved])).toBe('Dry run: nothing to change.\n');
  });
});

describe('deleteMutation containment', () => {
  it('accepts an upward path when it stays under the explicit containment root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-del-root-'));
    const worktree = path.join(root, 'worktrees', 'feature');
    const target = path.join(root, 'orcaops', 'config.json');
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(target, '{}', 'utf8');
    try {
      const mutation = deleteMutation(
        worktree,
        path.relative(worktree, target),
        { kind: 'file', content: '{}' },
        true,
        root,
        target
      );
      expect(mutation.absPath).toBe(target);
      expect(mutation.containmentRoot).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still refuses an upward path with no explicit root', () => {
    expect(() =>
      deleteMutation('/tmp/repo', '../elsewhere/file', { kind: 'file', content: '' }, true)
    ).toThrow(/escapes upward/);
  });

  it('refuses an explicit target that escapes its own root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-del-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-del-out-'));
    try {
      expect(() =>
        deleteMutation(
          root,
          path.relative(root, path.join(outside, 'x')),
          { kind: 'file', content: '' },
          true,
          root,
          path.join(outside, 'x')
        )
      ).toThrow(/resolves outside/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
