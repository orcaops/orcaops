import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { inspectHistoryPath } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

export async function createDatabaseSetupDirectory(
  root: string,
  directory: string,
  signal?: AbortSignal
): Promise<void> {
  await inspectHistoryPath(root, directory);
  const absent: string[] = [];
  let current = directory;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const ancestor = await lstat(current);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
        throw new ProjectDatabaseError(
          'HISTORY_UNWRITABLE',
          'Setup ancestor changed type; preserve it and inspect storage before retrying'
        );
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      absent.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) throw cause;
      current = parent;
    }
  }
  for (const next of absent) {
    signal?.throwIfAborted();
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }
    const info = await lstat(next, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== BigInt(process.getuid()))
    )
      throw new ProjectDatabaseError(
        'HISTORY_UNWRITABLE',
        'A setup directory has unknown type or ownership; preserve it and repair access before retrying'
      );
  }
  await syncAncestorEntries(directory, signal);
  const info = await inspectHistoryPath(root, directory);
  if (!info?.isDirectory())
    throw new ProjectDatabaseError(
      'HISTORY_UNWRITABLE',
      'Project destination is not an owned directory; preserve it and repair access before retrying'
    );
}

async function syncAncestorEntries(directory: string, signal?: AbortSignal): Promise<void> {
  let current = directory;
  for (;;) {
    signal?.throwIfAborted();
    const parentPath = path.dirname(current);
    if (parentPath === current) return;
    const [entry, parent] = await Promise.all([
      lstat(current, { bigint: true }),
      lstat(parentPath, { bigint: true }),
    ]);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !parent.isDirectory() ||
      parent.isSymbolicLink()
    )
      throw new ProjectDatabaseError(
        'HISTORY_UNWRITABLE',
        'Setup durability ancestors changed type; preserve them and inspect storage before retrying'
      );
    if (entry.dev !== parent.dev) return;
    const handle = await open(parentPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let failure: unknown;
    let failed = false;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory() || opened.dev !== parent.dev || opened.ino !== parent.ino)
        throw new ProjectDatabaseError(
          'HISTORY_UNWRITABLE',
          'Setup durability ancestor changed while opening; preserve it and retry after inspection'
        );
      await handle.sync();
    } catch (cause) {
      failed = true;
      failure = cause;
    }
    try {
      await handle.close();
    } catch (cause) {
      if (failed)
        throw new AggregateError(
          [failure, cause],
          'Directory sync failed and closing its handle also failed'
        );
      throw cause;
    }
    if (failed) throw failure;
    current = parentPath;
  }
}
