import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProvenanceRepository } from './provenance-target.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  return (await exec('git', ['-C', root, ...args], { env })).stdout.trim();
}

async function fixture(format: 'sha1' | 'sha256' = 'sha1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orcaops-provenance-'));
  roots.push(root);
  await git(root, ['init', '-q', '--initial-branch=main', `--object-format=${format}`]);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.test']);
  await writeFile(
    path.join(root, 'selected.ts'),
    'const selected = "original";\nconst retained = true;\n'
  );
  await git(root, ['add', 'selected.ts']);
  await git(root, ['commit', '-qm', 'original']);
  const original = await git(root, ['rev-parse', 'HEAD']);
  await writeFile(
    path.join(root, 'selected.ts'),
    'const selected = "current";\nconst retained = true;\n'
  );
  await git(root, ['commit', '-qam', 'current']);
  const current = await git(root, ['rev-parse', 'HEAD']);
  return { root, original, current, repo: new ProvenanceRepository(root) };
}

async function inventory(root: string, relative = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      result[file] = 'directory';
      Object.assign(result, await inventory(root, file));
    } else
      result[file] = createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex');
  }
  return result;
}

describe('selected provenance target', { timeout: 30_000 }, () => {
  it.each(['sha1', 'sha256'] as const)(
    'keeps %s revision content and blame together with one blame',
    async (format) => {
      const f = await fixture(format);
      const before = await inventory(f.root);
      const blame = vi.spyOn(f.repo, 'blame');
      const selected = await f.repo.resolveTarget({ file: 'selected.ts', line: 1, at: f.original });
      expect(selected).toMatchObject({
        selection: 'revision',
        commit_sha: f.original,
        state: 'available',
        dirty: false,
        line_content: 'const selected = "original";',
        blame: { status: 'committed', sha: f.original },
        issues: [],
      });
      expect(selected.tree_sha).toBe(await git(f.root, ['rev-parse', `${f.original}^{tree}`]));
      expect(selected.committed_blob_sha).toBe(
        await git(f.root, ['rev-parse', `${f.original}:selected.ts`])
      );
      expect(blame).toHaveBeenCalledTimes(1);
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected.blame)).toBe(true);
      expect(await inventory(f.root)).toEqual(before);
    }
  );

  it('reads current edits once and keeps uncommitted and unchanged lines distinct', async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.root, 'selected.ts'),
      'const selected = "local";\nconst retained = true;\n'
    );
    const before = await inventory(f.root);
    const local = await f.repo.resolveTarget({ file: 'selected.ts', line: 1 });
    expect(local).toMatchObject({
      commit_sha: f.current,
      dirty: true,
      line_content: 'const selected = "local";',
      blame: { status: 'uncommitted', sha: null },
    });
    const retained = await f.repo.resolveTarget({ file: 'selected.ts', line: 2 });
    expect(retained).toMatchObject({
      dirty: true,
      blame: { status: 'committed', sha: f.original },
    });
    expect(await inventory(f.root)).toEqual(before);
  });

  it('uses captured content when the file changes immediately before blame', async () => {
    const f = await fixture();
    const blame = f.repo.blame.bind(f.repo);
    vi.spyOn(f.repo, 'blame').mockImplementation(async (...args) => {
      await writeFile(path.join(f.root, 'selected.ts'), 'Different content\n');
      return blame(...args);
    });
    const selected = await f.repo.resolveTarget({ file: 'selected.ts', line: 1 });
    expect(selected).toMatchObject({
      line_content: 'const selected = "current";',
      blame: { status: 'committed', sha: f.current },
    });
  });

  it('refuses a changed checkout revision without retrying blame', async () => {
    const f = await fixture();
    const blame = f.repo.blame.bind(f.repo);
    const spy = vi.spyOn(f.repo, 'blame').mockImplementation(async (...args) => {
      await git(f.root, ['checkout', '--detach', f.original]);
      return blame(...args);
    });
    const selected = await f.repo.resolveTarget({ file: 'selected.ts', line: 1 });
    expect(selected).toMatchObject({
      state: 'unavailable',
      blame: { status: 'unavailable', sha: null },
    });
    expect(selected.issues).toContain('CODE_EVIDENCE_UNAVAILABLE');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps deleted files and absent lines explicit without blame', async () => {
    const f = await fixture();
    const blame = vi.spyOn(f.repo, 'blame');
    await rm(path.join(f.root, 'selected.ts'));
    expect(await f.repo.resolveTarget({ file: 'selected.ts', line: 1 })).toMatchObject({
      state: 'deleted',
      dirty: true,
      content: null,
      issues: ['CODE_PATH_ABSENT'],
    });
    expect(await f.repo.resolveTarget({ file: 'absent.ts', at: f.current })).toMatchObject({
      state: 'deleted',
      dirty: false,
    });
    expect(
      await f.repo.resolveTarget({ file: 'selected.ts', line: 3, at: f.current })
    ).toMatchObject({ state: 'available', line_content: null, issues: ['CODE_LINE_ABSENT'] });
    expect(blame).not.toHaveBeenCalled();
  });

  it('reports unknown missing objects even when the two requested IDs are equal', async () => {
    const f = await fixture();
    const missing = 'f'.repeat(40);
    expect(await f.repo.reachability(missing, missing)).toBe('unknown');
    expect(await f.repo.reachability(missing, f.current)).toBe('unknown');
    expect(await f.repo.reachability(f.original, f.current)).toBe('reachable');
    expect(await f.repo.reachability(f.current, f.original)).toBe('unreachable');
    expect(await f.repo.resolveTarget({ file: 'selected.ts', at: missing })).toMatchObject({
      state: 'unavailable',
      commit_sha: null,
    });
    const blob = await git(f.root, ['rev-parse', 'HEAD:selected.ts']);
    await rm(path.join(f.root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    expect(
      await new ProvenanceRepository(f.root).resolveTarget({ file: 'selected.ts' })
    ).toMatchObject({ state: 'unavailable', issues: ['CODE_EVIDENCE_UNAVAILABLE'] });
  });

  it('does not call truncated or grafted ancestry proven non-ancestry', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, '.git', 'shallow'), `${f.current}\n`);
    expect(await f.repo.reachability(f.original, f.current)).toBe('unknown');
    expect(await f.repo.resolveTarget({ file: 'selected.ts', line: 2 })).toMatchObject({
      blame: { status: 'unavailable', sha: null },
      issues: ['CODE_BLAME_UNAVAILABLE'],
    });
    await rm(path.join(f.root, '.git', 'shallow'));
    await writeFile(path.join(f.root, '.git', 'info', 'grafts'), `${f.current}\n`);
    expect(await f.repo.reachability(f.original, f.current)).toBe('unknown');
    expect(await f.repo.resolveTarget({ file: 'selected.ts', line: 2 })).toMatchObject({
      blame: { status: 'unavailable', sha: null },
    });
  });

  it('ignores foreign Git administration, index, object and configuration environment', async () => {
    const f = await fixture();
    const foreign = await fixture();
    await writeFile(path.join(foreign.root, 'selected.ts'), 'Foreign repository\n');
    await git(foreign.root, ['commit', '-qam', 'foreign']);
    const env = {
      ...process.env,
      GIT_DIR: path.join(foreign.root, '.git'),
      GIT_WORK_TREE: foreign.root,
      GIT_COMMON_DIR: path.join(foreign.root, '.git'),
      GIT_INDEX_FILE: '/missing-index',
      GIT_OBJECT_DIRECTORY: '/missing-objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/missing-alternate',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_SHALLOW_FILE: '/missing-shallow',
    };
    const repo = new ProvenanceRepository(f.root, env);
    const before = await inventory(foreign.root);
    expect(
      await repo.resolveTarget({ file: 'selected.ts', line: 1, at: f.original })
    ).toMatchObject({ state: 'available', commit_sha: f.original, blame: { sha: f.original } });
    expect(await repo.reachability(f.original, f.current)).toBe('reachable');
    expect(await inventory(foreign.root)).toEqual(before);
    expect(env.GIT_DIR).toBe(path.join(foreign.root, '.git'));
  });

  it('reports Git execution failure as unavailable rather than absence or non-ancestry', async () => {
    const f = await fixture();
    const repo = new ProvenanceRepository(f.root, { PATH: '/missing-git' });
    expect(await repo.resolveTarget({ file: 'selected.ts' })).toMatchObject({
      state: 'unavailable',
      issues: ['CODE_EVIDENCE_UNAVAILABLE'],
    });
    expect(await repo.reachability(f.original, f.current)).toBe('unknown');
  });

  it('discloses bounded content refusal without blaming a partial file', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'selected.ts'), Buffer.alloc(8 * 1024 * 1024 + 1, 'a'));
    const blame = vi.spyOn(f.repo, 'blame');
    expect(await f.repo.resolveTarget({ file: 'selected.ts', line: 1 })).toMatchObject({
      state: 'unavailable',
    });
    expect(blame).not.toHaveBeenCalled();
  });

  it('rejects unsafe selections before Git and preserves literal unusual filenames', async () => {
    const f = await fixture();
    for (const file of [
      '',
      '../selected.ts',
      '/selected.ts',
      '.git/config',
      'dir/../selected.ts',
      'dir\\file',
      'a\0b',
    ])
      await expect(f.repo.resolveTarget({ file })).rejects.toThrow('repository-relative');
    for (const at of ['', '--help', 'HEAD\n--all'])
      await expect(f.repo.resolveTarget({ file: 'selected.ts', at })).rejects.toThrow('non-option');
    await expect(f.repo.resolveTarget({ file: 'selected.ts', line: 0 })).rejects.toThrow(
      'positive'
    );
    const file = '-literal[1].ts';
    await writeFile(path.join(f.root, file), 'Literal file\n');
    await git(f.root, ['add', '--', file]);
    await git(f.root, ['commit', '-qm', 'literal']);
    expect(await f.repo.resolveTarget({ file, line: 1 })).toMatchObject({
      state: 'available',
      line_content: 'Literal file',
      dirty: false,
    });
  });

  it('does not interpret symlinks, binary content or untracked empty files as clean code', async () => {
    const f = await fixture();
    await symlink('/missing-target', path.join(f.root, 'linked'));
    expect(await f.repo.resolveTarget({ file: 'linked/file.ts' })).toMatchObject({
      state: 'unavailable',
    });
    await writeFile(path.join(f.root, 'binary'), Buffer.from([0, 1]));
    expect(await f.repo.resolveTarget({ file: 'binary' })).toMatchObject({
      state: 'unavailable',
      issues: ['CODE_CONTENT_UNSUPPORTED'],
    });
    await writeFile(path.join(f.root, 'empty'), '');
    expect(await f.repo.resolveTarget({ file: 'empty' })).toMatchObject({
      state: 'available',
      dirty: true,
      committed_blob_sha: null,
    });
    await mkdir(path.join(f.root, 'nested'));
    expect(
      await new ProvenanceRepository(path.join(f.root, 'nested')).resolveTarget({
        file: 'selected.ts',
      })
    ).toMatchObject({ state: 'unavailable' });
  });
});
