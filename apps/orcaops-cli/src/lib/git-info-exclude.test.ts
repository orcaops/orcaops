import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLinkedWorktree, createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  PERSONAL_EXCLUDE_LINES,
  reconcileInfoExclude,
  resolveInfoExcludePath,
} from './git-info-exclude.js';
import { ORCAOPS_MANAGED_BLOCK_END, ORCAOPS_MANAGED_BLOCK_START } from './managed-line-block.js';
import { executeMutations, writeMutation } from './mutations.js';

/**
 * The `.git/info/exclude` reconciler (personal install
 * scope). Mirrors gitignore.test.ts: managed-section append, user-line
 * preservation, stale-managed pruning, null-when-unchanged. Path resolution
 * goes through `git rev-parse --git-path`, so every case runs against a REAL
 * repo (fabricated `.git` layouts are not valid git dirs), and roots are
 * realpath'd because the resolver canonicalizes (macOS /var → /private/var).
 */

describe('reconcileInfoExclude', () => {
  let repo: TempRepo;
  let repoRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialCommit: false });
    repoRoot = await realpath(repo.path);
    // Drop git-init's template exclude so content assertions start clean.
    await rm(path.join(repoRoot, '.git', 'info', 'exclude'), { force: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const excludePath = (): string => path.join(repoRoot, '.git', 'info', 'exclude');
  const block = (lines: string[]): string =>
    `${ORCAOPS_MANAGED_BLOCK_START}\n${lines.join('\n')}\n${ORCAOPS_MANAGED_BLOCK_END}\n`;

  it('appends the managed section to an absent file', async () => {
    const plan = await reconcileInfoExclude(repoRoot, PERSONAL_EXCLUDE_LINES);
    expect(plan.excludePath).toBe(excludePath());
    expect(plan.added).toEqual(PERSONAL_EXCLUDE_LINES);
    expect(plan.desiredContent).toBe(block(PERSONAL_EXCLUDE_LINES));
  });

  it('preserves user lines and appends the managed section after them', async () => {
    await writeFile(excludePath(), '*.swp\n.my-scratch/\n', 'utf8');
    const plan = await reconcileInfoExclude(repoRoot, PERSONAL_EXCLUDE_LINES);
    expect(plan.desiredContent).toBe(`*.swp\n.my-scratch/\n\n${block(PERSONAL_EXCLUDE_LINES)}`);
  });

  it('is idempotent: a matching file returns desiredContent null', async () => {
    const first = await reconcileInfoExclude(repoRoot, PERSONAL_EXCLUDE_LINES);
    await writeFile(excludePath(), first.desiredContent as string, 'utf8');
    const second = await reconcileInfoExclude(repoRoot, PERSONAL_EXCLUDE_LINES);
    expect(second.desiredContent).toBeNull();
    expect(second.added).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  it('prunes stale managed lines while keeping user lines untouched', async () => {
    await writeFile(
      excludePath(),
      `keep-me.txt\n\n${block(['.orcaops/', 'old-managed-line.md'])}`,
      'utf8'
    );
    const plan = await reconcileInfoExclude(repoRoot, ['.orcaops/', 'CLAUDE.local.md']);
    expect(plan.removed).toEqual(['old-managed-line.md']);
    expect(plan.added).toEqual(['CLAUDE.local.md']);
    expect(plan.desiredContent).toBe(`keep-me.txt\n\n${block(['.orcaops/', 'CLAUDE.local.md'])}`);
  });

  it('removing every managed line leaves only the user content', async () => {
    await writeFile(excludePath(), `mine.txt\n\n${block(['.orcaops/'])}`, 'utf8');
    const plan = await reconcileInfoExclude(repoRoot, []);
    expect(plan.desiredContent).toBe('mine.txt\n');
  });

  it('preserves matching user lines outside the bounded block while reconciling and stripping', async () => {
    await writeFile(
      excludePath(),
      `.orcaops/\nuser.log\n\n${block(['.orcaops/', 'CLAUDE.local.md'])}`,
      'utf8'
    );

    const updated = await reconcileInfoExclude(repoRoot, ['.orcaops/']);
    expect(updated.desiredContent).toBe(`.orcaops/\nuser.log\n\n${block(['.orcaops/'])}`);

    await writeFile(excludePath(), updated.desiredContent as string, 'utf8');
    const stripped = await reconcileInfoExclude(repoRoot, []);
    expect(stripped.desiredContent).toBe('.orcaops/\nuser.log\n');
  });

  it('refuses an ancestor symlink without reading or changing the external file', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-exclude-outside-'));
    const external = path.join(outside, 'exclude');
    await writeFile(external, 'outside\n', 'utf8');
    await rm(path.join(repoRoot, '.git', 'info'), { recursive: true, force: true });
    await symlink(outside, path.join(repoRoot, '.git', 'info'));

    try {
      await expect(reconcileInfoExclude(repoRoot, PERSONAL_EXCLUDE_LINES)).rejects.toThrow(
        /must not contain symlinks|resolves outside/
      );
      expect(await readFile(external, 'utf8')).toBe('outside\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a final symlink without reading or changing the external file', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-exclude-outside-'));
    const external = path.join(outside, 'exclude');
    await writeFile(external, 'outside\n', 'utf8');
    await symlink(external, excludePath());

    try {
      await expect(reconcileInfoExclude(repoRoot, PERSONAL_EXCLUDE_LINES)).rejects.toThrow(
        /must not contain symlinks|resolves outside/
      );
      expect(await readFile(external, 'utf8')).toBe('outside\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('resolveInfoExcludePath', () => {
  it('resolves a normal clone to .git/info/exclude', async () => {
    const repo = await createTempRepo({ initialCommit: false });
    try {
      const root = await realpath(repo.path);
      expect(await resolveInfoExcludePath(root)).toBe(path.join(root, '.git', 'info', 'exclude'));
    } finally {
      await repo.cleanup();
    }
  });

  it('resolves a linked worktree to the MAIN repo common dir', async () => {
    const main = await createTempRepo();
    const wt = await createLinkedWorktree(main.path);
    try {
      const mainRoot = await realpath(main.path);
      const commonExclude = path.join(mainRoot, '.git', 'info', 'exclude');
      expect(await resolveInfoExcludePath(wt.path)).toBe(commonExclude);

      const wtRoot = await realpath(wt.path);
      const plan = await reconcileInfoExclude(wtRoot, PERSONAL_EXCLUDE_LINES);
      await executeMutations(
        [
          writeMutation(
            wtRoot,
            path.relative(wtRoot, plan.excludePath),
            plan.desiredContent as string,
            plan.currentContent,
            true,
            plan.containmentRoot,
            plan.excludePath
          ),
        ],
        'apply'
      );
      expect(await readFile(commonExclude, 'utf8')).toContain(ORCAOPS_MANAGED_BLOCK_START);
    } finally {
      await wt.cleanup();
      await main.cleanup();
    }
  });

  it('resolves from a subdirectory root (init --here) to the enclosing repo', async () => {
    const repo = await createTempRepo({ initialCommit: false });
    try {
      const root = await realpath(repo.path);
      const subdir = path.join(root, 'packages', 'app');
      await mkdir(subdir, { recursive: true });
      expect(await resolveInfoExcludePath(subdir)).toBe(path.join(root, '.git', 'info', 'exclude'));
    } finally {
      await repo.cleanup();
    }
  });

  it('reads back what it wrote (round-trip through the real file)', async () => {
    const repo = await createTempRepo({ initialCommit: false });
    try {
      const root = await realpath(repo.path);
      const plan = await reconcileInfoExclude(root, PERSONAL_EXCLUDE_LINES);
      await writeFile(plan.excludePath, plan.desiredContent as string, 'utf8');
      const written = await readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
      expect(written).toContain(ORCAOPS_MANAGED_BLOCK_START);
      const second = await reconcileInfoExclude(root, PERSONAL_EXCLUDE_LINES);
      expect(second.desiredContent).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });
});
