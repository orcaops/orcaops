import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { GitAdministrativeContext } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError, type RepositoryCreation } from '@orcaops/storage/history/database';

import { runDatabaseGit } from './git-process.js';
import { readGitAdministrativeText } from '../git-context.js';

export interface DatabaseGitContext extends GitAdministrativeContext {
  readonly repositoryCreation: RepositoryCreation;
  readonly administrativeIdentity: RepositoryCreation;
}
export interface DatabaseGitInventory {
  contexts: DatabaseGitContext[];
  unresolved: Array<{ worktreeRoot: string; reason: string }>;
  hash: string;
}
const line = (text: string) => text.replace(/\n$/, '');

async function observeDirectory(directory: string): Promise<RepositoryCreation> {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino <= 0n || info.nlink < 1n)
    throw new ProjectDatabaseError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Git administration lacks a linked directory identity; inspect or repair the repository before setup'
    );
  return Object.freeze({
    commonDirectory: directory,
    device: info.dev.toString(),
    inode: info.ino.toString(),
    birthtimeNs: info.birthtimeNs > 0n ? info.birthtimeNs.toString() : null,
  });
}
export function sameRepositoryCreation(
  left: RepositoryCreation,
  right: RepositoryCreation
): boolean {
  return (
    left.commonDirectory === right.commonDirectory &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}
export async function resolveDatabaseGitContext(input: {
  cwd: string;
  signal?: AbortSignal;
}): Promise<DatabaseGitContext> {
  const requested = input.cwd;
  const signal = input.signal;
  try {
    const cwd = await realpath(requested);
    const resolve = async (argument: string) =>
      realpath(
        line(
          (await runDatabaseGit(cwd, ['rev-parse', '--path-format=absolute', argument], signal))
            .stdout
        )
      );
    const worktreeRoot = await resolve('--show-toplevel');
    const gitDir = await resolve('--absolute-git-dir');
    const commonDir = await resolve('--git-common-dir');
    const repositoryCreation = await observeDirectory(commonDir);
    const administrativeIdentity = await observeDirectory(gitDir);
    const pointer = path.join(worktreeRoot, '.git');
    const pointerInfo = await lstat(pointer);
    if (pointerInfo.isSymbolicLink()) throw new Error('Git pointer is a symlink');
    if (gitDir === commonDir && pointerInfo.isDirectory()) {
      if ((await realpath(pointer)) !== gitDir) throw new Error('Main Git directory differs');
    } else {
      const value = line(await readGitAdministrativeText(pointer));
      if (
        !value.startsWith('gitdir: ') ||
        (await realpath(path.resolve(worktreeRoot, value.slice(8)))) !== gitDir
      )
        throw new Error('Git directory pointer differs');
      if (gitDir !== commonDir) {
        const backlink = line(await readGitAdministrativeText(path.join(gitDir, 'gitdir')));
        if ((await realpath(path.resolve(gitDir, backlink))) !== (await realpath(pointer)))
          throw new Error('Linked Git backlink differs');
        const commonLink = line(await readGitAdministrativeText(path.join(gitDir, 'commondir')));
        if ((await realpath(path.resolve(gitDir, commonLink))) !== commonDir)
          throw new Error('Linked common directory differs');
      }
    }
    if (
      !sameRepositoryCreation(repositoryCreation, await observeDirectory(commonDir)) ||
      !sameRepositoryCreation(administrativeIdentity, await observeDirectory(gitDir))
    )
      throw new Error('Git administration changed during inspection');
    return Object.freeze({
      worktreeRoot,
      gitDir,
      commonDir,
      repositoryCreation,
      administrativeIdentity,
      repositoryInstanceId: null,
      worktreeId: null,
      headOid: null,
      branch: null,
    });
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    throw new ProjectDatabaseError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Actual Git administration cannot be validated; inspect pointers, worktree availability and repository identity before setup',
      { cause }
    );
  }
}
export async function revalidateDatabaseGitContext(
  expected: DatabaseGitContext,
  signal?: AbortSignal
): Promise<DatabaseGitContext> {
  const current = await resolveDatabaseGitContext({ cwd: expected.worktreeRoot, signal });
  if (
    current.gitDir !== expected.gitDir ||
    !sameRepositoryCreation(current.repositoryCreation, expected.repositoryCreation) ||
    !sameRepositoryCreation(current.administrativeIdentity, expected.administrativeIdentity)
  )
    throw new ProjectDatabaseError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Git administration was replaced or relocated during setup; inspect the original repository and start a new validated attempt'
    );
  return current;
}
export async function enumerateDatabaseGitContexts(
  current: DatabaseGitContext,
  signal?: AbortSignal
): Promise<DatabaseGitInventory> {
  const before = (
    await runDatabaseGit(current.worktreeRoot, ['worktree', 'list', '--porcelain', '-z'], signal)
  ).stdout;
  const contexts: DatabaseGitContext[] = [];
  const unresolved: DatabaseGitInventory['unresolved'] = [];
  for (const record of before.split('\0\0').filter(Boolean)) {
    const fields = record.split('\0');
    const root = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    if (!root || fields.some((field) => field === 'bare' || field.startsWith('prunable'))) {
      unresolved.push({
        worktreeRoot: root ?? '',
        reason: 'Git worktree record is missing, bare or prunable',
      });
      continue;
    }
    try {
      const context = await resolveDatabaseGitContext({ cwd: root, signal });
      if (
        !sameRepositoryCreation(current.repositoryCreation, context.repositoryCreation) ||
        contexts.some(
          (other) => other.gitDir === context.gitDir || other.worktreeRoot === context.worktreeRoot
        )
      )
        throw new Error(
          'Enumerated Git administration is duplicated or belongs to another repository'
        );
      contexts.push(context);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      unresolved.push({
        worktreeRoot: root,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  const after = (
    await runDatabaseGit(current.worktreeRoot, ['worktree', 'list', '--porcelain', '-z'], signal)
  ).stdout;
  if (before !== after || !contexts.some((context) => context.gitDir === current.gitDir))
    unresolved.push({
      worktreeRoot: current.worktreeRoot,
      reason: 'Git worktree inventory changed or omitted the selected checkout',
    });
  await revalidateDatabaseGitContext(current, signal);
  return {
    contexts,
    unresolved,
    hash: createHash('sha256')
      .update(JSON.stringify([before, contexts, unresolved]))
      .digest('hex'),
  };
}
