import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInInvocationContext } from './invocation-context.js';
import { bestEffortRealpath, resolveExplicitOverride, resolveOrcaopsRoot } from './resolve-root.js';
import { OrcaopsError } from '../io/errors.js';

describe('resolve-root primitives', () => {
  let tmp: string;
  beforeEach(async () => {
    // realpath up front so comparisons live in the canonical namespace
    // (macOS tmpdir is /var → /private/var).
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-resolve-root-')));
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

  describe('resolveOrcaopsRoot precedence', () => {
    it('honors the explicit programmatic root (highest precedence, no git needed)', async () => {
      const root = path.join(tmp, 'explicit');
      await mkdir(root);
      expect(await resolveOrcaopsRoot({ cwd: tmp, root })).toBe(await realpath(root));
    });

    it('resolves a RELATIVE programmatic root against cwd', async () => {
      await mkdir(path.join(tmp, 'rel'));
      expect(await resolveOrcaopsRoot({ cwd: tmp, root: 'rel' })).toBe(
        await realpath(path.join(tmp, 'rel'))
      );
    });

    it('honors the --root flag (ALS rootOverride) over ORCAOPS_ROOT env', async () => {
      const flagRoot = path.join(tmp, 'flag-root');
      const envRoot = path.join(tmp, 'env-root');
      await mkdir(flagRoot);
      await mkdir(envRoot);
      const resolved = await runInInvocationContext(
        { cwd: tmp, env: { ...process.env, ORCAOPS_ROOT: envRoot }, rootOverride: flagRoot },
        () => resolveOrcaopsRoot({ cwd: tmp })
      );
      expect(resolved).toBe(await realpath(flagRoot));
    });

    it('falls to ORCAOPS_ROOT env before git discovery', async () => {
      const envRoot = path.join(tmp, 'env-only');
      await mkdir(envRoot);
      const resolved = await runInInvocationContext(
        { cwd: tmp, env: { ...process.env, ORCAOPS_ROOT: envRoot } },
        () => resolveOrcaopsRoot({ cwd: tmp })
      );
      expect(resolved).toBe(await realpath(envRoot));
    });

    it('throws NOT_A_REPO when no override and cwd is not a git work tree', async () => {
      const run = () =>
        runInInvocationContext({ cwd: tmp, env: {} }, () => resolveOrcaopsRoot({ cwd: tmp }));
      await expect(run()).rejects.toBeInstanceOf(OrcaopsError);
      await expect(run()).rejects.toMatchObject({ code: 'NOT_A_REPO' });
    });

    it('discovers the git worktree root when no override is set', async () => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      await run('git', ['init'], { cwd: tmp });
      await run('git', ['config', 'user.email', 't@t'], { cwd: tmp });
      await run('git', ['config', 'user.name', 't'], { cwd: tmp });
      await run('git', ['commit', '--allow-empty', '-m', 'init', '--quiet'], { cwd: tmp });
      const nested = path.join(tmp, 'a', 'b');
      await mkdir(nested, { recursive: true });
      const resolved = await runInInvocationContext({ cwd: nested, env: {} }, () =>
        resolveOrcaopsRoot({ cwd: nested })
      );
      expect(resolved).toBe(await realpath(tmp));
    });
  });

  describe('resolveExplicitOverride', () => {
    it('returns null when neither the flag nor ORCAOPS_ROOT is set', async () => {
      const result = await runInInvocationContext({ cwd: tmp, env: {} }, () =>
        resolveExplicitOverride(tmp)
      );
      expect(result).toBeNull();
    });
  });
});
