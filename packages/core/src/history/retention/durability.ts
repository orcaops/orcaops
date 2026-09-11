import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { retentionGitUnavailable, runRetentionGit } from './git-process.js';

export function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && right.nlink > 0n;
}
export async function validateAncestors(
  common: string,
  file: string,
  device: bigint
): Promise<void> {
  const relative = path.relative(common, path.dirname(file));
  if (relative.startsWith('..') || path.isAbsolute(relative))
    retentionGitUnavailable(
      new Error('Git publication path escaped its original common directory')
    );
  let current = common;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    let info: BigIntStats;
    try {
      info = await lstat(current, { bigint: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== device || info.nlink < 1n)
      retentionGitUnavailable(
        new Error('Git publication ancestor is not a linked same-device directory')
      );
  }
}
export async function writeout(
  file: string,
  device: bigint,
  directory: boolean,
  verify?: (text: string) => void
): Promise<void> {
  const before = await lstat(file, { bigint: true });
  if (
    before.dev !== device ||
    before.isSymbolicLink() ||
    before.nlink < 1n ||
    (directory ? !before.isDirectory() : !before.isFile())
  )
    retentionGitUnavailable(
      new Error('Git publication representation is not a linked same-device file or directory')
    );
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let failure: unknown;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened))
      retentionGitUnavailable(new Error('Git publication representation changed while opening'));
    if (verify) {
      if (opened.size > 8n * 1024n * 1024n)
        retentionGitUnavailable(
          new Error('Git reference representation exceeds its bounded inspection size')
        );
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (BigInt(offset) !== opened.size)
        retentionGitUnavailable(new Error('Git reference representation changed while reading'));
      verify(bytes.subarray(0, offset).toString('utf8'));
    }
    await handle.sync();
    const after = await lstat(file, { bigint: true });
    if (
      !sameFile(opened, after) ||
      (!directory && (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs))
    )
      retentionGitUnavailable(new Error('Git publication representation changed during writeout'));
  } catch (cause) {
    failure = cause;
  }
  try {
    await handle.close();
  } catch (cause) {
    failure =
      failure === undefined
        ? cause
        : new AggregateError([failure, cause], 'Git writeout and descriptor cleanup failed');
  }
  if (failure !== undefined) {
    const primary = failure instanceof AggregateError ? failure.errors[0] : failure;
    if (primary instanceof ProjectDatabaseError)
      throw new ProjectDatabaseError(primary.code, primary.message, { cause: failure });
    retentionGitUnavailable(failure);
  }
}
export async function hardwareFlush(
  cwd: string,
  objects: string,
  device: bigint,
  format: 'sha1' | 'sha256',
  signal?: AbortSignal
) {
  const before = await lstat(objects, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.dev !== device ||
    before.nlink < 1n
  )
    retentionGitUnavailable(
      new Error('Git object directory does not share the publication device')
    );
  const bytes = Buffer.from(`Orcaops immutable durability acknowledgement ${randomUUID()}\n`);
  const oid = createHash(format)
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
  await validateAncestors(objects, path.join(objects, oid.slice(0, 2), oid.slice(2)), device);
  const exists = await runRetentionGit(cwd, ['cat-file', '--batch-check'], {
    input: Buffer.from(`${oid}\n`),
    signal,
  });
  if (exists.stdout !== `${oid} missing\n`)
    retentionGitUnavailable(
      new Error('Fresh durability object already exists; retry with a new acknowledgement')
    );
  const result = await runRetentionGit(
    cwd,
    [
      '-c',
      'core.fsync=loose-object',
      '-c',
      'core.fsyncMethod=fsync',
      'hash-object',
      '-w',
      '--stdin',
    ],
    { input: bytes, signal, traceFlush: true }
  );
  if (result.stdout.trim() !== oid || result.hardwareFlushes < 1)
    retentionGitUnavailable(
      new Error('Git did not acknowledge a fresh immutable-object hardware flush')
    );
  const after = await lstat(objects, { bigint: true });
  const object = await lstat(path.join(objects, oid.slice(0, 2), oid.slice(2)), { bigint: true });
  if (
    !sameFile(before, after) ||
    !object.isFile() ||
    object.isSymbolicLink() ||
    object.dev !== device ||
    object.nlink < 1n
  )
    retentionGitUnavailable(
      new Error('Fresh Git durability object changed device or representation')
    );
}
