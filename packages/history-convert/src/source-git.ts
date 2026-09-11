import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { HistoryConversionError } from './errors.js';
import { isUuidV7 } from './legacy/storage/ids/uuidv7.js';
import { observeLegacySourceFile } from './source-files.js';
import { runLegacyGit } from './source-git-process.js';
import { inspectLegacyPath } from './source-paths.js';

export interface LegacyGitContext {
  commonDir: string;
  gitDir: string;
  worktreeRoot: string;
  projectId: string | null;
  headOid: string | null;
  branch: string | null;
  administrativeFingerprint: string;
  canonicalMarkers: readonly string[];
}
export interface LegacyGitOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}
export interface LegacyGitInventory {
  contexts: LegacyGitContext[];
  unresolved: { worktreeRoot: string; reason: string }[];
  hash: string;
}
const line = (text: string) => text.replace(/\r?\n$/, '');
async function directoryIdentity(directory: string) {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino <= 0n || info.nlink < 1n)
    throw new HistoryConversionError(
      'SOURCE_UNAVAILABLE',
      'Git administration is not a linked directory',
      directory
    );
  return [
    directory,
    info.dev.toString(),
    info.ino.toString(),
    info.birthtimeNs > 0n ? info.birthtimeNs.toString() : null,
  ];
}
export async function readLegacyGitText(root: string, relativePath: string) {
  const info = await inspectLegacyPath(root, relativePath);
  if (!info?.isFile() || info.size > 1024n * 1024n)
    throw new HistoryConversionError(
      'SOURCE_UNAVAILABLE',
      'Git administrative pointer is not a bounded regular file',
      relativePath
    );
  const observed = await observeLegacySourceFile({ root, relativePath, includeBytes: true });
  return observed.bytes!.toString('utf8');
}
export async function resolveLegacyGitContext(
  input: LegacyGitOptions & { cwd: string }
): Promise<LegacyGitContext> {
  const { cwd: requested, signal } = input;
  const env = { ...(input.env ?? process.env) };
  const options = { env, signal };
  signal?.throwIfAborted();
  try {
    const cwd = await realpath(requested);
    const resolve = async (argument: string) =>
      realpath(
        line(
          (await runLegacyGit(cwd, ['rev-parse', '--path-format=absolute', argument], options))
            .stdout
        )
      );
    const worktreeRoot = await resolve('--show-toplevel');
    const gitDir = await resolve('--absolute-git-dir');
    const commonDir = await resolve('--git-common-dir');
    const identities = [await directoryIdentity(commonDir), await directoryIdentity(gitDir)];
    const pointer = path.join(worktreeRoot, '.git');
    const pointerInfo = await lstat(pointer);
    if (pointerInfo.isSymbolicLink()) throw new Error('Git pointer is a symlink');
    if (gitDir === commonDir && pointerInfo.isDirectory()) {
      if ((await realpath(pointer)) !== gitDir) throw new Error('Main Git directory differs');
    } else {
      const value = line(await readLegacyGitText(worktreeRoot, '.git'));
      if (
        !value.startsWith('gitdir: ') ||
        (await realpath(path.resolve(worktreeRoot, value.slice(8)))) !== gitDir
      )
        throw new Error('Git pointer differs');
      if (gitDir !== commonDir) {
        const backlink = line(await readLegacyGitText(gitDir, 'gitdir'));
        if ((await realpath(path.resolve(gitDir, backlink))) !== (await realpath(pointer)))
          throw new Error('Git backlink differs');
        const commonLink = line(await readLegacyGitText(gitDir, 'commondir'));
        if ((await realpath(path.resolve(gitDir, commonLink))) !== commonDir)
          throw new Error('Git common directory differs');
      }
    }
    const project = await runLegacyGit(
      cwd,
      ['config', '--local', '--get-all', 'orcaops.projectid'],
      { ...options, allowedExitCodes: [1] }
    );
    const values = project.stdout.split(/\r?\n/).filter(Boolean);
    if (values.length > 1 || (values.length === 1 && !isUuidV7(values[0])))
      throw new HistoryConversionError(
        'SOURCE_CONFLICT',
        'Git project identity is malformed or duplicated'
      );
    const head = await runLegacyGit(cwd, ['rev-parse', '--verify', 'HEAD'], {
      ...options,
      allowedExitCodes: [128],
    });
    const branch = await runLegacyGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      ...options,
      allowedExitCodes: [1],
    });
    const canonicalMarkers: string[] = [];
    for (const [base, relative] of [
      [commonDir, 'orcaops/registration.json'],
      [commonDir, 'orcaops/repository.json'],
      [commonDir, 'orcaops/authority.json'],
      [commonDir, 'orcaops/activation.json'],
      [gitDir, 'orcaops/worktree.json'],
    ])
      if (await inspectLegacyPath(base, relative)) canonicalMarkers.push(path.join(base, relative));
    if (
      JSON.stringify(identities) !==
      JSON.stringify([await directoryIdentity(commonDir), await directoryIdentity(gitDir)])
    )
      throw new HistoryConversionError(
        'SOURCE_CHANGED',
        'Git administration changed during inspection'
      );
    return {
      commonDir,
      gitDir,
      worktreeRoot,
      projectId: values[0] ?? null,
      headOid: head.code === 0 ? line(head.stdout) : null,
      branch: branch.code === 0 ? line(branch.stdout) : null,
      administrativeFingerprint: createHash('sha256')
        .update(JSON.stringify(identities))
        .digest('hex'),
      canonicalMarkers,
    };
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof HistoryConversionError) throw cause;
    throw new HistoryConversionError(
      'SOURCE_UNAVAILABLE',
      'Actual Git source administration cannot be validated',
      requested
    );
  }
}
export async function enumerateLegacyGitContexts(
  current: LegacyGitContext,
  options: LegacyGitOptions = {}
): Promise<LegacyGitInventory> {
  const before = (
    await runLegacyGit(current.worktreeRoot, ['worktree', 'list', '--porcelain', '-z'], options)
  ).stdout;
  const contexts: LegacyGitContext[] = [];
  const unresolved: LegacyGitInventory['unresolved'] = [];
  for (const record of before.split('\0\0').filter(Boolean)) {
    const fields = record.split('\0');
    const root = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    if (!root || fields.some((field) => field === 'bare' || field.startsWith('prunable'))) {
      unresolved.push({
        worktreeRoot: root ?? '',
        reason: 'Git worktree is unclassified, bare or prunable',
      });
      continue;
    }
    try {
      const context = await resolveLegacyGitContext({ cwd: root, ...options });
      if (
        context.commonDir !== current.commonDir ||
        contexts.some(
          (other) => other.gitDir === context.gitDir || other.worktreeRoot === context.worktreeRoot
        )
      )
        throw new Error(
          'Enumerated Git administration is duplicated or belongs to another repository'
        );
      contexts.push(context);
    } catch (cause) {
      options.signal?.throwIfAborted();
      unresolved.push({
        worktreeRoot: root,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  const after = (
    await runLegacyGit(current.worktreeRoot, ['worktree', 'list', '--porcelain', '-z'], options)
  ).stdout;
  const observed = await resolveLegacyGitContext({ cwd: current.worktreeRoot, ...options });
  if (
    before !== after ||
    !contexts.some((context) => context.gitDir === current.gitDir) ||
    JSON.stringify(observed) !== JSON.stringify(current)
  )
    unresolved.push({
      worktreeRoot: current.worktreeRoot,
      reason: 'Git source inventory changed or omitted the selected checkout',
    });
  return {
    contexts,
    unresolved,
    hash: createHash('sha256')
      .update(JSON.stringify([before, contexts, unresolved]))
      .digest('hex'),
  };
}
