import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { gitClient } from '@orcaops/test-harness';

import {
  createHistoryRepo,
  createRepoTemplate,
  createTempRepo,
  FIXTURE_IDENTITY_CONFIG,
  type TempRepo,
} from './temp-repo.js';

const execFileAsync = promisify(execFile);

describe('createTempRepo', () => {
  let repo: TempRepo | null = null;

  afterEach(async () => {
    if (repo) {
      await repo.cleanup();
      repo = null;
    }
  });

  it('creates a directory containing a .git folder', async () => {
    repo = await createTempRepo();
    const gitDir = await stat(path.join(repo.path, '.git'));
    expect(gitDir.isDirectory()).toBe(true);
  });

  it('initial commit gives the repo a HEAD on the requested branch', async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    const git = gitClient(repo.path);
    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    expect(branch).toBe('main');
    const head = (await git.revparse(['HEAD'])).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('cleanup removes the directory', async () => {
    const tmp = await createTempRepo();
    await tmp.cleanup();
    await expect(stat(tmp.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('createHistoryRepo', () => {
  let repo: TempRepo | null = null;

  afterEach(async () => {
    if (repo) await repo.cleanup();
    repo = null;
  });

  it('builds labeled branch and merge histories with deterministic dates', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', files: { 'root.txt': 'root\n' } },
      { type: 'branch', name: 'feature' },
      { type: 'checkout', branch: 'feature' },
      { type: 'commit', label: 'feature', files: { 'feature.txt': 'feature\n' } },
      { type: 'checkout', branch: 'main' },
      { type: 'commit', label: 'mainline', files: { 'main.txt': 'main\n' } },
      { type: 'merge', label: 'merged', branch: 'feature', body: 'Feature context' },
      { type: 'tag', name: 'v1', ref: 'merged' },
    ]);
    repo = history;

    expect(Object.keys(history.shas)).toEqual(['root', 'feature', 'mainline', 'merged']);
    expect(await gitClient(history.path).revparse(['v1'])).toContain(history.shas.merged);
    const commitTimes = (
      await gitClient(history.path).raw(['log', '--reverse', '--format=%cI', 'main'])
    )
      .trim()
      .split('\n')
      .map(Date.parse);
    expect(commitTimes).toEqual([
      Date.parse('2025-01-01T00:00:00Z'),
      Date.parse('2025-01-01T01:00:00Z'),
      Date.parse('2025-01-01T02:00:00Z'),
      Date.parse('2025-01-01T03:00:00Z'),
    ]);
  });
});

describe('FIXTURE_IDENTITY_CONFIG', () => {
  it('begins on its own line', () => {
    // Asserted on the exported value, not a copy: an earlier version of this
    // guard was written into a test that rebuilt the block itself, so it passed
    // while the shipped append had no leading newline at all.
    expect(FIXTURE_IDENTITY_CONFIG.startsWith('\n')).toBe(true);
  });

  it('still sets the identity when appended to a config with no trailing newline', async () => {
    // git terminates its last line today, so this hazard cannot be produced
    // through createTempRepo itself — the append is exercised directly instead.
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-nonl-'));
    try {
      await execFileAsync('git', ['init', '-q', '--initial-branch', 'main'], { cwd: dir });
      const cfg = path.join(dir, '.git', 'config');
      await writeFile(cfg, (await readFile(cfg, 'utf8')).replace(/\n$/, ''), 'utf8');
      await appendFile(cfg, FIXTURE_IDENTITY_CONFIG, 'utf8');
      const read = async (key: string): Promise<string> =>
        (
          await execFileAsync('git', ['config', '--local', '--get', key], { cwd: dir })
        ).stdout.trim();
      expect(await read('user.email')).toBe('test@orcaops.local');
      expect(await read('user.name')).toBe('orcaops test');
      expect(await read('commit.gpgsign')).toBe('false');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createRepoTemplate', () => {
  it('gives each checkout its own project identity', async () => {
    // `orcaops init` mints orcaops.projectid into .git/config; copying the
    // template verbatim would hand every test in a file the same one.
    const template = createRepoTemplate(async (repoPath) => {
      await execFileAsync('git', ['config', '--local', 'orcaops.projectid', 'template-id'], {
        cwd: repoPath,
      });
    });
    try {
      const [a, b] = [await template.checkout(), await template.checkout()];
      const read = async (dir: string): Promise<string> => {
        const { stdout } = await execFileAsync(
          'git',
          ['config', '--local', '--get', 'orcaops.projectid'],
          { cwd: dir }
        ).catch(() => ({ stdout: '' }));
        return stdout.trim();
      };
      expect(await read(a.path)).toBe('');
      expect(await read(b.path)).toBe('');
    } finally {
      await template.destroy();
    }
  });

  it('retries the build instead of serving a cached rejection', async () => {
    let attempts = 0;
    const template = createRepoTemplate(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('build boom');
    });
    try {
      await expect(template.checkout()).rejects.toThrow('build boom');
      // A cached rejection would fail every later test in the file with the
      // first error; the second checkout must build again and succeed.
      const second = await template.checkout();
      expect(attempts).toBe(2);
      expect(existsSync(second.path)).toBe(true);
    } finally {
      await template.destroy();
    }
  });

  it('destroys the template of a failed build without throwing', async () => {
    const seen: string[] = [];
    const template = createRepoTemplate(async (repoPath) => {
      seen.push(repoPath);
      throw new Error('build boom');
    });
    await expect(template.checkout()).rejects.toThrow('build boom');
    await expect(template.destroy()).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(existsSync(seen[0])).toBe(false);
  });

  it('re-roots an absolute symlink that points into the template', async () => {
    // Node's `cp` absolutizes a relative symlink unless verbatimSymlinks is set,
    // and a link that is absolute to begin with survives the copy pointing at
    // the template. Either way the copy must not reach outside itself.
    const template = createRepoTemplate(async (repoPath) => {
      await writeFile(path.join(repoPath, 'AGENTS.md'), 'agents\n', 'utf8');
      await symlink(path.join(repoPath, 'AGENTS.md'), path.join(repoPath, 'ABS.md'));
      // realpath form: on macOS os.tmpdir() is /var/folders/… which realpath
      // resolves to /private/var/folders/…, the form orcaops' own path
      // canonicalization produces.
      await symlink(
        path.join(await realpath(repoPath), 'AGENTS.md'),
        path.join(repoPath, 'REAL.md')
      );
    });
    try {
      const copy = await template.checkout();
      for (const link of ['ABS.md', 'REAL.md']) {
        const target = await readlink(path.join(copy.path, link));
        const resolved = path.isAbsolute(target) ? target : path.join(copy.path, target);
        const rel = path.relative(await realpath(copy.path), await realpath(resolved));
        expect(rel.startsWith('..'), `${link} -> ${target} escaped the copy`).toBe(false);
      }
    } finally {
      await template.destroy();
    }
  });

  it('leaves a symlink pointing outside the template alone', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-outside-'));
    await writeFile(path.join(outside, 'external.md'), 'external\n', 'utf8');
    const template = createRepoTemplate(async (repoPath) => {
      await symlink(path.join(outside, 'external.md'), path.join(repoPath, 'OUT.md'));
    });
    try {
      const copy = await template.checkout();
      expect(await readlink(path.join(copy.path, 'OUT.md'))).toBe(
        path.join(outside, 'external.md')
      );
    } finally {
      await template.destroy();
      await rm(outside, { recursive: true, force: true });
    }
  });
});
