import type { BigIntStats } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { hardwareFlush, sameFile, validateAncestors, writeout } from './durability.js';
import { retentionCancelled, retentionGitEnvironment } from './git-process.js';
import { runGit } from '../../git/snapshots.js';
import {
  type RegisteredDatabaseContext,
  revalidateDatabaseExecutionContext,
} from '../context/execution.js';
import { inspectDatabaseFilesystem } from '../context/filesystem.js';

function unavailable(cause?: unknown, detail?: string): never {
  throw new ProjectDatabaseError(
    'HISTORY_INACCESSIBLE',
    'Snapshot evidence is unavailable because its complete owned Git object closure could not be established; use a self-contained complete repository and inspect storage access before explicitly retrying' +
      (detail ? `; ${detail}` : ''),
    { cause }
  );
}
async function inspectGit(cwd: string, args: string[], signal?: AbortSignal, stdin?: string) {
  const result = await runGit(cwd, args, {
    env: retentionGitEnvironment(),
    signal,
    commandTimeoutMs: 120_000,
    stdin,
  });
  retentionCancelled(signal);
  return result;
}
async function git(cwd: string, args: string[], signal?: AbortSignal, stdin?: string) {
  const result = await inspectGit(cwd, args, signal, stdin);
  if (result.code !== 0 || result.truncated) unavailable(new Error(result.stderr));
  return result.stdout.toString('utf8');
}
async function requireEmpty(file: string, device: bigint) {
  let before: BigIntStats;
  try {
    before = await lstat(file, { bigint: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.dev !== device ||
    before.nlink < 1n ||
    before.size > 16n * 1024n
  )
    unavailable(new Error('Unsupported Git borrowing or traversal metadata'));
  if ((await readFile(file, 'utf8')).trim())
    unavailable(new Error('Git borrowing or incomplete ancestry is configured'));
  const after = await lstat(file, { bigint: true });
  if (!sameFile(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs)
    unavailable(new Error('Git object ownership metadata changed during observation'));
}
export function unpairedPackFiles(names: readonly string[]): string[] {
  const selected = names.filter((name) => /\.(?:pack|idx)$/.test(name)).sort();
  const known = new Set(selected);
  // Git accepts arbitrary pack stems; filename hashes do not establish ownership.
  return selected.filter(
    (name) => !known.has(name.replace(/\.(?:pack|idx)$/, name.endsWith('.pack') ? '.idx' : '.pack'))
  );
}
async function packs(objects: string, device: bigint) {
  const directory = path.join(objects, 'pack');
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== device || info.nlink < 1n)
    unavailable(new Error('Git pack storage is not a linked same-device directory'));
  const names = await readdir(directory);
  if (names.some((name) => name.endsWith('.promisor')))
    unavailable(new Error('Git has promisor pack storage'));
  const selected = names.filter((name) => /\.(?:pack|idx)$/.test(name)).sort();
  const unpaired = unpairedPackFiles(selected);
  if (unpaired.length)
    unavailable(
      new Error('Git pack/index ownership is incomplete or unsupported'),
      `Unpaired Git pack/index files (${unpaired.length}): ${unpaired
        .slice(0, 3)
        .map((name) => JSON.stringify(name))
        .join(', ')}${unpaired.length > 3 ? ` and ${unpaired.length - 3} more` : ''}`
    );
  return { directory, info, names: selected };
}
export async function requireOwnedDatabaseGitObjects(
  expected: RegisteredDatabaseContext,
  options: { signal?: AbortSignal } = {}
) {
  const context = structuredClone(expected);
  const signal = options.signal;
  retentionCancelled(signal);
  const current = context;
  const common = current.git.commonDir;
  const objects = path.join(common, 'objects');
  await inspectDatabaseFilesystem(objects, signal);
  const commonInfo = await lstat(common, { bigint: true });
  const objectInfo = await lstat(objects, { bigint: true });
  if (
    !commonInfo.isDirectory() ||
    commonInfo.isSymbolicLink() ||
    commonInfo.nlink < 1n ||
    !objectInfo.isDirectory() ||
    objectInfo.isSymbolicLink() ||
    objectInfo.nlink < 1n ||
    commonInfo.dev !== objectInfo.dev
  )
    unavailable(new Error('Selected Git object storage has no linked same-device ownership'));
  const device = commonInfo.dev;
  await validateAncestors(common, path.join(objects, 'info', 'alternates'), device);
  await validateAncestors(common, path.join(common, 'info', 'grafts'), device);
  await requireEmpty(path.join(objects, 'info', 'alternates'), device);
  await requireEmpty(path.join(common, 'shallow'), device);
  await requireEmpty(path.join(common, 'info', 'grafts'), device);
  const borrowing = await inspectGit(
    current.git.worktreeRoot,
    ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'],
    signal
  );
  if (borrowing.code !== 1 || borrowing.stdout.length || borrowing.stderr)
    unavailable(new Error('Git partial-clone configuration is present or unavailable'));
  const format = (
    await git(current.git.worktreeRoot, ['rev-parse', '--show-object-format'], signal)
  ).trim();
  if (format !== 'sha1' && format !== 'sha256')
    unavailable(new Error('Unsupported Git object format'));
  const inventory = await packs(objects, device);
  // Refuse borrowing before context validation can ask Git to resolve HEAD.
  const validated = await revalidateDatabaseExecutionContext(context, { signal });
  return {
    context: validated,
    objects,
    device,
    format: format as 'sha1' | 'sha256',
    objectInfo,
    commonInfo,
    inventory,
  };
}
export async function prepareDatabaseGitClosure(
  expected: RegisteredDatabaseContext,
  objectOid: string,
  options: { signal?: AbortSignal } = {}
): Promise<{
  objectOid: string;
  treeOid: string;
  objectFormat: 'sha1' | 'sha256';
  objectCount: number;
}> {
  if (
    typeof objectOid !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(objectOid) ||
    /^0+$/.test(objectOid)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact nonzero original Git commit identity'
    );
  const context = structuredClone(expected);
  const signal = options.signal;
  try {
    const owned = await requireOwnedDatabaseGitObjects(context, { signal });
    const { objects, device, format, inventory } = owned;
    const cwd = owned.context.git.worktreeRoot;
    if (
      objectOid.length !== (format === 'sha1' ? 40 : 64) ||
      (await git(cwd, ['cat-file', '-t', objectOid], signal)).trim() !== 'commit'
    )
      unavailable(new Error('The exact original object is not the requested commit'));
    const treeOid = (await git(cwd, ['rev-parse', `${objectOid}^{tree}`], signal)).trim();
    const listed = await git(
      cwd,
      ['rev-list', '--objects', '--no-object-names', objectOid],
      signal
    );
    const ids = listed.trim().split('\n');
    const oidPattern = new RegExp(`^[a-f0-9]{${objectOid.length}}$`);
    if (
      !ids.length ||
      !ids.includes(objectOid) ||
      !ids.includes(treeOid) ||
      ids.some((id) => !oidPattern.test(id))
    )
      unavailable(new Error('Git returned an incomplete or malformed closure inventory'));
    const exact = [...new Set(ids)];
    const observed = new Map<string, BigIntStats>();
    const packedOnly = new Set<string>();
    for (let offset = 0; offset < exact.length; offset += 1024) {
      const batch = exact.slice(offset, offset + 1024);
      const output = await git(
        cwd,
        ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
        signal,
        batch.join('\n') + '\n'
      );
      const rows = output.trimEnd().split('\n');
      if (
        rows.length !== batch.length ||
        rows.some(
          (row, index) => !new RegExp(`^${batch[index]} (?:commit|tree|blob|tag)$`).test(row)
        )
      )
        unavailable(new Error('A required Git closure object is missing or unverified'));
      for (const id of batch) {
        retentionCancelled(signal);
        const file = path.join(objects, id.slice(0, 2), id.slice(2));
        await validateAncestors(objects, file, device);
        let info: BigIntStats;
        try {
          info = await lstat(file, { bigint: true });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
            if (!inventory.names.length)
              unavailable(
                new Error('A required loose object disappeared without owned pack storage')
              );
            packedOnly.add(file);
            continue;
          }
          throw cause;
        }
        await writeout(file, device, false);
        observed.set(file, info);
      }
    }
    for (const name of inventory.names) {
      retentionCancelled(signal);
      const file = path.join(inventory.directory, name);
      const info = await lstat(file, { bigint: true });
      await writeout(file, device, false);
      observed.set(file, info);
    }
    const directories = new Set([...observed.keys()].map((file) => path.dirname(file)));
    directories.add(inventory.directory);
    for (const directory of directories) await writeout(directory, device, true);
    await writeout(objects, device, true);
    await writeout(owned.context.git.commonDir, device, true);
    if (process.platform === 'darwin') await hardwareFlush(cwd, objects, device, format, signal);
    const final = await requireOwnedDatabaseGitObjects(owned.context, { signal });
    if (
      !sameFile(owned.objectInfo, final.objectInfo) ||
      !sameFile(owned.commonInfo, final.commonInfo) ||
      !sameFile(inventory.info, final.inventory.info) ||
      !isDeepStrictEqual(inventory.names, final.inventory.names)
    )
      unavailable(new Error('Git owned storage changed during closure writeout'));
    for (let offset = 0; offset < exact.length; offset += 1024) {
      const batch = exact.slice(offset, offset + 1024);
      const rows = (
        await git(
          cwd,
          ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
          signal,
          batch.join('\n') + '\n'
        )
      )
        .trimEnd()
        .split('\n');
      if (
        rows.length !== batch.length ||
        rows.some(
          (row, index) => !new RegExp(`^${batch[index]} (?:commit|tree|blob|tag)$`).test(row)
        )
      )
        unavailable(new Error('Required Git closure became unavailable after writeout'));
    }
    for (const file of packedOnly) {
      try {
        await lstat(file);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw cause;
      }
      unavailable(
        new Error('An unsynchronized loose representation appeared after packed-object observation')
      );
    }
    for (const [file, before] of observed) {
      const after = await lstat(file, { bigint: true });
      if (
        !sameFile(before, after) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs
      )
        unavailable(new Error('A required owned Git object representation changed after writeout'));
    }
    retentionCancelled(signal);
    return { objectOid, treeOid, objectFormat: format, objectCount: exact.length };
  } catch (cause) {
    retentionCancelled(signal);
    if (cause instanceof ProjectDatabaseError) throw cause;
    unavailable(cause);
  }
}
