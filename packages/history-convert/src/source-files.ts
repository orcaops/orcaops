import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { HistoryConversionError } from './errors.js';
import {
  containsExcludedLocation,
  isCanonicalTargetMember,
  isExcludedLegacyMember,
  type LegacySourceScope,
} from './source-omissions.js';

export interface LegacyFileIdentity {
  dev: string;
  ino: string;
  mode: string;
  uid: string;
  gid: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface LegacySourceFile {
  relativePath: string;
  identity: LegacyFileIdentity;
  sha256: string;
}

export type LegacyDirectoryIdentity = Pick<
  LegacyFileIdentity,
  'dev' | 'ino' | 'mode' | 'uid' | 'gid'
> &
  Partial<Pick<LegacyFileIdentity, 'size' | 'mtimeNs' | 'ctimeNs'>>;

export interface LegacySourceDirectory {
  relativePath: string;
  identity: LegacyDirectoryIdentity;
  members: readonly string[];
}

export interface LegacySourceInventory {
  scope: LegacySourceScope | null;
  root: string;
  files: readonly LegacySourceFile[];
  directories: readonly LegacySourceDirectory[];
  issues: readonly { relativePath: string; code: 'SOURCE_UNAVAILABLE'; reason: string }[];
  complete: boolean;
}

export function legacyFileIdentity(stat: BigIntStats): LegacyFileIdentity {
  return Object.fromEntries(
    ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [
      key,
      stat[key as keyof BigIntStats].toString(),
    ])
  ) as unknown as LegacyFileIdentity;
}

export function legacyDirectoryIdentity(
  stat: BigIntStats,
  location: string,
  scope?: LegacySourceScope | null
): LegacyDirectoryIdentity {
  const identity = legacyFileIdentity(stat);
  if (!containsExcludedLocation(location, scope)) return identity;
  // Excluded children may change timestamps; retained membership is checked separately.
  const { dev, ino, mode, uid, gid } = identity;
  return { dev, ino, mode, uid, gid };
}

async function directoryMembers(
  location: string,
  scope?: LegacySourceScope | null
): Promise<string[]> {
  let names = (await readdir(location))
    .filter((name) => !isExcludedLegacyMember(path.join(location, name), scope))
    .sort();
  if (
    scope?.kind === 'checkout' &&
    location === path.join(scope.root, '.orcaops') &&
    names.includes('cache')
  ) {
    const cache = path.join(location, 'cache');
    const stat = await lstat(cache, { bigint: true });
    if (stat.isDirectory() && (await readdir(cache)).every((name) => name === 'review-feedback')) {
      // An excluded-only cache directory contains no retained source membership.
      names = names.filter((name) => name !== 'cache');
    }
  }
  return names;
}

export async function assertLegacyDirectoryUnchanged(
  root: string,
  directory: LegacySourceDirectory,
  scope?: LegacySourceScope | null
): Promise<void> {
  const location = path.join(root, directory.relativePath);
  const now = await lstat(location, { bigint: true }).catch(() => changed(directory.relativePath));
  if (
    !now.isDirectory() ||
    JSON.stringify(legacyDirectoryIdentity(now, location, scope)) !==
      JSON.stringify(directory.identity) ||
    JSON.stringify(await directoryMembers(location, scope)) !== JSON.stringify(directory.members)
  )
    changed(directory.relativePath);
}

async function assertParentUnchanged(
  parent: { file: string; stat: BigIntStats; members: readonly string[] | null },
  scope?: LegacySourceScope | null
): Promise<void> {
  const now = await lstat(parent.file, { bigint: true });
  if (
    !now.isDirectory() ||
    JSON.stringify(legacyDirectoryIdentity(parent.stat, parent.file, scope)) !==
      JSON.stringify(legacyDirectoryIdentity(now, parent.file, scope)) ||
    (parent.members &&
      JSON.stringify(parent.members) !== JSON.stringify(await directoryMembers(parent.file, scope)))
  )
    changed(parent.file);
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return JSON.stringify(legacyFileIdentity(before)) === JSON.stringify(legacyFileIdentity(after));
}

function unavailable(relativePath: string, reason: string): never {
  throw new HistoryConversionError('SOURCE_UNAVAILABLE', reason, relativePath);
}

function changed(relativePath: string): never {
  throw new HistoryConversionError(
    'SOURCE_CHANGED',
    'The retained source changed while it was being inspected',
    relativePath
  );
}

function relativeParts(relativePath: string): string[] {
  const parts = relativePath.split('/');
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  )
    unavailable(relativePath, 'Source member is not a canonical relative path');
  return parts;
}

async function parents(root: string, relativePath: string, scope?: LegacySourceScope | null) {
  const parts = relativeParts(relativePath);
  const result: { file: string; stat: BigIntStats; members: readonly string[] | null }[] = [];
  for (let length = 0; length < parts.length; length++) {
    const file = path.join(root, ...parts.slice(0, length));
    const stat = await lstat(file, { bigint: true });
    if (!stat.isDirectory()) unavailable(relativePath, 'Source parent is not a regular directory');
    result.push({
      file,
      stat,
      members: containsExcludedLocation(file, scope) ? await directoryMembers(file, scope) : null,
    });
  }
  return result;
}

export async function observeLegacySourceFile(input: {
  root: string;
  relativePath: string;
  scope?: LegacySourceScope | null;
  includeBytes?: boolean;
  signal?: AbortSignal;
}): Promise<{ file: LegacySourceFile; bytes: Buffer | null }> {
  const { signal, includeBytes } = input;
  const scope = input.scope ? { ...input.scope } : null;
  signal?.throwIfAborted();
  const root = path.resolve(input.root);
  const relativePath = input.relativePath;
  if (isCanonicalTargetMember(path.join(root, relativePath), scope))
    unavailable(
      relativePath,
      'Canonical project database is a conversion target, not a legacy source'
    );
  if (isExcludedLegacyMember(path.join(root, relativePath), scope))
    unavailable(relativePath, 'Task Review source is intentionally omitted');
  const chain = await parents(root, relativePath, scope);
  const file = path.join(root, ...relativeParts(relativePath));
  const before = await lstat(file, { bigint: true });
  if (!before.isFile()) unavailable(relativePath, 'Source member is not a regular file');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!unchanged(before, await handle.stat({ bigint: true }))) changed(relativePath);
    const digest = createHash('sha256');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0n;
    for (;;) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer);
      if (!read.bytesRead) break;
      const bytes = buffer.subarray(0, read.bytesRead);
      digest.update(bytes);
      size += BigInt(read.bytesRead);
      if (includeBytes) chunks.push(Buffer.from(bytes));
    }
    if (size !== before.size || !unchanged(before, await handle.stat({ bigint: true })))
      changed(relativePath);
    if (!unchanged(before, await lstat(file, { bigint: true }))) changed(relativePath);
    for (const parent of chain) await assertParentUnchanged(parent, scope);
    return {
      file: { relativePath, identity: legacyFileIdentity(before), sha256: digest.digest('hex') },
      bytes: includeBytes ? Buffer.concat(chunks) : null,
    };
  } finally {
    await handle.close();
  }
}

export async function inventoryLegacySource(input: {
  root: string;
  scope?: LegacySourceScope | null;
  signal?: AbortSignal;
}): Promise<LegacySourceInventory> {
  const { signal } = input;
  const scope = input.scope ? { ...input.scope } : null;
  signal?.throwIfAborted();
  const root = await realpath(input.root);
  const files: LegacySourceFile[] = [];
  const directories: LegacySourceDirectory[] = [];
  const issues: { relativePath: string; code: 'SOURCE_UNAVAILABLE'; reason: string }[] = [];
  const issue = (relativePath: string, reason: string) =>
    issues.push({ relativePath, code: 'SOURCE_UNAVAILABLE', reason });
  const visit = async (relativePath: string): Promise<void> => {
    signal?.throwIfAborted();
    const directory = path.join(root, relativePath);
    let before: BigIntStats;
    let names: string[];
    try {
      const chain = await parents(root, relativePath ? relativePath + '/member' : 'member', scope);
      before = await lstat(directory, { bigint: true });
      if (!before.isDirectory()) return void issue(relativePath, 'Source directory is not regular');
      names = await directoryMembers(directory, scope);
      for (const parent of chain) await assertParentUnchanged(parent, scope);
    } catch (cause) {
      if (cause instanceof HistoryConversionError && cause.code === 'SOURCE_CHANGED') throw cause;
      return void issue(relativePath, 'Source directory cannot be inspected');
    }
    const entry = {
      relativePath,
      identity: legacyDirectoryIdentity(before, directory, scope),
      members: names,
    };
    directories.push(entry);
    for (const name of names) {
      signal?.throwIfAborted();
      const relative = relativePath ? relativePath + '/' + name : name;
      try {
        const stat = await lstat(path.join(root, relative), { bigint: true });
        if (stat.isDirectory()) await visit(relative);
        else if (stat.isFile())
          files.push(
            (await observeLegacySourceFile({ root, relativePath: relative, scope, signal })).file
          );
        else issue(relative, 'Source member is a symlink or unsupported filesystem resource');
      } catch (cause) {
        if (signal?.aborted) throw cause;
        if (cause instanceof HistoryConversionError && cause.code === 'SOURCE_CHANGED') throw cause;
        issue(relative, 'Source member cannot be inspected');
      }
    }
    await assertLegacyDirectoryUnchanged(root, entry, scope);
  };
  await visit('');
  for (const directory of directories) await assertLegacyDirectoryUnchanged(root, directory, scope);
  for (const entry of files) {
    signal?.throwIfAborted();
    let current: BigIntStats;
    try {
      current = await lstat(path.join(root, entry.relativePath), { bigint: true });
    } catch {
      changed(entry.relativePath);
    }
    if (JSON.stringify(entry.identity) !== JSON.stringify(legacyFileIdentity(current)))
      changed(entry.relativePath);
  }
  return { root, scope, files, directories, issues, complete: issues.length === 0 };
}
