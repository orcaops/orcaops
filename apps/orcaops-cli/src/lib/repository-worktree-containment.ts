import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether `target` lies inside `repoRoot` or inside another worktree of the
 * same repository, judged by directory identity instead of spelling. On a
 * case-insensitive volume `RepoDir/home` and `repodir/home` are one directory
 * with two spellings, so comparing path strings trusts the second; device and
 * inode numbers are the same for both.
 *
 * `target` may not exist yet; its nearest existing ancestor stands in for it.
 * Throws when the identity of `repoRoot` or of an ancestor cannot be read, and
 * callers must treat that as inside.
 */
export function isInsideRepositoryWorktree(target: string, repoRoot: string): boolean {
  const worktrees = new Set([directoryIdentity(realpathSync.native(repoRoot))]);
  for (const root of otherWorktreeRoots(repoRoot)) {
    try {
      worktrees.add(directoryIdentity(root));
    } catch {
      // A pruned or moved worktree has no directory a store could sit in.
    }
  }

  let current = realpathSync.native(nearestExistingAncestor(target));
  for (;;) {
    if (worktrees.has(directoryIdentity(current))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function directoryIdentity(directory: string): string {
  const observed = statSync(directory, { bigint: true });
  return `${observed.dev}:${observed.ino}`;
}

function nearestExistingAncestor(target: string): string {
  let current = target;
  for (;;) {
    try {
      statSync(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * The main and linked worktree roots recorded in the repository's git
 * metadata, read from files so a synchronous grant read spawns nothing.
 * Whatever cannot be read is left out: this list only ever adds refusals to
 * the identity check on `repoRoot` itself.
 */
function otherWorktreeRoots(repoRoot: string): string[] {
  try {
    const commonDir = gitCommonDir(repoRoot);
    if (commonDir === null) return [];
    const roots = path.basename(commonDir) === '.git' ? [path.dirname(commonDir)] : [];
    const registry = path.join(commonDir, 'worktrees');
    for (const name of readdirIfPresent(registry)) {
      const adminDir = path.join(registry, name);
      const dotGitPath = readTrimmedIfPresent(path.join(adminDir, 'gitdir'));
      if (dotGitPath !== null) roots.push(path.dirname(path.resolve(adminDir, dotGitPath)));
    }
    return roots;
  } catch {
    return [];
  }
}

function gitCommonDir(worktreeRoot: string): string | null {
  const dotGit = path.join(worktreeRoot, '.git');
  let gitDir: string;
  try {
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit;
    } else {
      const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (pointer?.[1] === undefined) return null;
      gitDir = path.resolve(worktreeRoot, pointer[1].trim());
    }
  } catch {
    return null;
  }
  const commonLink = readTrimmedIfPresent(path.join(gitDir, 'commondir'));
  return commonLink === null ? gitDir : path.resolve(gitDir, commonLink);
}

function readTrimmedIfPresent(file: string): string | null {
  try {
    const contents = readFileSync(file, 'utf8').trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

function readdirIfPresent(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
