import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo } from '@orcaops/test-harness';

import { bestEffortRealpath, discoverGitRoot, resolveExplicitOverride } from './resolve-root.js';

const execFileAsync = promisify(execFile);

describe('resolve-root primitives (project-scope, ALS-free)', () => {
  let tmp: string;
  beforeEach(async () => {
    // realpath up front so comparisons live in the canonical namespace
    // (macOS tmpdir is /var → /private/var).
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-ps-resolve-')));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe('bestEffortRealpath', () => {
    it('realpaths an existing path', async () => {
      const sub = path.join(tmp, 'a', 'b');
      await mkdir(sub, { recursive: true });
      expect(await bestEffortRealpath(sub)).toBe(await realpath(sub));
    });

    it('realpaths the longest existing prefix and re-appends the missing tail', async () => {
      const existing = path.join(tmp, 'exists');
      await mkdir(existing);
      const target = path.join(existing, 'missing', 'deep.ts');
      expect(await bestEffortRealpath(target)).toBe(
        path.join(await realpath(existing), 'missing', 'deep.ts')
      );
    });

    it('resolves through a symlinked ancestor', async () => {
      const real = path.join(tmp, 'real');
      await mkdir(real);
      const link = path.join(tmp, 'link');
      await symlink(real, link);
      expect(await bestEffortRealpath(path.join(link, 'child.ts'))).toBe(
        path.join(await realpath(real), 'child.ts')
      );
    });

    it('never throws on a wholly non-existent path', async () => {
      const bogus = path.join(tmp, 'no', 'such', 'thing');
      await expect(bestEffortRealpath(bogus)).resolves.toBe(bogus);
    });
  });

  describe('resolveExplicitOverride (cwd, env, rootOverride)', () => {
    it('returns null when neither the flag nor ORCAOPS_ROOT is set', async () => {
      expect(await resolveExplicitOverride(tmp, {})).toBeNull();
      expect(await resolveExplicitOverride(tmp, {}, undefined)).toBeNull();
      // An empty --root value is treated as "no override" (matches the CLI).
      expect(await resolveExplicitOverride(tmp, { ORCAOPS_ROOT: '' }, '')).toBeNull();
    });

    it('honors the rootOverride argument over ORCAOPS_ROOT env', async () => {
      const flagRoot = path.join(tmp, 'flag-root');
      const envRoot = path.join(tmp, 'env-root');
      await mkdir(flagRoot);
      await mkdir(envRoot);
      expect(await resolveExplicitOverride(tmp, { ORCAOPS_ROOT: envRoot }, flagRoot)).toBe(
        await realpath(flagRoot)
      );
    });

    it('falls back to ORCAOPS_ROOT env when no flag is given', async () => {
      const envRoot = path.join(tmp, 'env-only');
      await mkdir(envRoot);
      expect(await resolveExplicitOverride(tmp, { ORCAOPS_ROOT: envRoot })).toBe(
        await realpath(envRoot)
      );
    });

    it('resolves a RELATIVE override against cwd', async () => {
      await mkdir(path.join(tmp, 'rel'));
      expect(await resolveExplicitOverride(tmp, {}, 'rel')).toBe(
        await realpath(path.join(tmp, 'rel'))
      );
    });
  });

  describe('discoverGitRoot', () => {
    it('returns null outside a git work tree', async () => {
      expect(await discoverGitRoot(tmp)).toBeNull();
    });

    it('does not treat a standalone .orcaops directory as a worktree root', async () => {
      await mkdir(path.join(tmp, '.orcaops'));
      expect(await discoverGitRoot(tmp)).toBeNull();
    });

    it('discovers the worktree root from a nested subdir', async () => {
      const repo = await createTempRepo({ initialBranch: 'main' });
      try {
        const nested = path.join(repo.path, 'a', 'b');
        await mkdir(nested, { recursive: true });
        expect(await discoverGitRoot(nested)).toBe(await realpath(repo.path));
      } finally {
        await repo.cleanup();
      }
    });

    it('retains an initialized worktree root when Git metadata is unreadable', async () => {
      const repo = await createTempRepo({ initialBranch: 'main' });
      try {
        await mkdir(path.join(repo.path, '.orcaops'));
        const nested = path.join(repo.path, 'a', 'b');
        await mkdir(nested, { recursive: true });
        const configPath = path.join(repo.path, '.git', 'config');
        const healthyConfig = await readFile(configPath);
        await writeFile(configPath, '[broken\n', 'utf8');
        expect(await discoverGitRoot(nested)).toBe(await realpath(repo.path));
        await writeFile(configPath, healthyConfig);
      } finally {
        await repo.cleanup();
      }
    });

    it('does not cross a nearer nested repository boundary', async () => {
      const repo = await createTempRepo({ initialBranch: 'main' });
      try {
        await mkdir(path.join(repo.path, '.orcaops'));
        const nestedRepo = path.join(repo.path, 'nested');
        await mkdir(nestedRepo);
        await execFileAsync('git', ['init'], { cwd: nestedRepo });
        const nestedChild = path.join(nestedRepo, 'child');
        await mkdir(nestedChild);
        await writeFile(path.join(nestedRepo, '.git', 'config'), '[broken\n', 'utf8');
        expect(await discoverGitRoot(nestedChild)).toBeNull();
      } finally {
        await repo.cleanup();
      }
    });
  });
});
