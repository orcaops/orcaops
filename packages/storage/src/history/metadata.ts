import { constants, type Stats } from 'node:fs';
import { access, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { HistoryError } from './types.js';
import { fsyncDirStrict } from '../fs/durable.js';

export async function inspectHistoryPath(root: string, target: string): Promise<Stats | null> {
  const relative = path.relative(root, target);
  if (
    !path.isAbsolute(root) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new HistoryError('HISTORY_INACCESSIBLE', 'History path escapes its owner', {
      root,
      path: target,
    });
  }
  const segments = relative === '' ? [] : relative.split(path.sep);
  let current = root;
  for (let i = 0; i <= segments.length; i++) {
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        await accessibleAncestor(current);
        return null;
      }
      throw new HistoryError('HISTORY_INACCESSIBLE', 'Cannot inspect history metadata', {
        path: current,
        cause,
      });
    }
    if (info.isSymbolicLink())
      throw new HistoryError('HISTORY_INACCESSIBLE', 'History resource contains a symlink', {
        path: current,
      });
    if (process.getuid && info.uid !== process.getuid())
      throw new HistoryError(
        'HISTORY_UNEXPECTED_OWNER',
        'History resource has an unexpected owner',
        { path: current, uid: info.uid }
      );
    if (i < segments.length && !info.isDirectory())
      throw new HistoryError('HISTORY_INACCESSIBLE', 'History ancestor is not a directory', {
        path: current,
      });
    try {
      await access(current, constants.R_OK | (info.isDirectory() ? constants.X_OK : 0));
    } catch (cause) {
      // The two syscalls are not atomic, and SQLite creates and retires its own sidecars
      // while a writer initializes. A name that is gone by the second call is absent, which
      // this inspection already knows how to report; only a real access failure is a verdict.
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        await accessibleAncestor(current);
        return null;
      }
      throw new HistoryError('HISTORY_INACCESSIBLE', 'History resource is not readable', {
        path: current,
        cause,
      });
    }
    if (i === segments.length) return info;
    current = path.join(current, segments[i]);
  }
  return null;
}

async function accessibleAncestor(target: string): Promise<void> {
  let current = path.dirname(target);
  for (;;) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('not an accessible directory');
      await access(current, constants.R_OK | constants.X_OK);
      return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new HistoryError(
          'HISTORY_INACCESSIBLE',
          'Absence cannot be established through this ancestor',
          { path: current, cause }
        );
      const parent = path.dirname(current);
      if (parent === current)
        throw new HistoryError('HISTORY_INACCESSIBLE', 'No accessible history ancestor', {
          path: current,
        });
      current = parent;
    }
  }
}

export async function readHistoryMetadata(root: string, file: string): Promise<unknown | null> {
  const info = await inspectHistoryPath(root, file);
  if (!info) return null;
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new HistoryError(
      'HISTORY_INTEGRITY_REQUIRED',
      'History metadata is not a bounded regular file',
      { path: file }
    );
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
      throw new HistoryError(
        'HISTORY_INTEGRITY_REQUIRED',
        'History metadata changed while opening',
        { path: file }
      );
    const raw = await handle.readFile('utf8');
    const after = await lstat(file);
    if (
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    )
      throw new HistoryError(
        'HISTORY_INTEGRITY_REQUIRED',
        'History metadata changed while reading',
        { path: file }
      );
    const value: unknown = JSON.parse(raw);
    if (value === null) {
      throw new HistoryError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Occupied metadata cannot represent absence',
        { path: file }
      );
    }
    return value;
  } catch (cause) {
    if (cause instanceof HistoryError) throw cause;
    throw new HistoryError(
      cause instanceof SyntaxError ? 'HISTORY_INTEGRITY_REQUIRED' : 'HISTORY_INACCESSIBLE',
      'Cannot read history metadata',
      { path: file, cause }
    );
  } finally {
    await handle?.close();
  }
}

export async function createHistoryDirectory(root: string, directory: string): Promise<void> {
  if (await inspectHistoryPath(root, directory)) {
    if (!(await lstat(directory)).isDirectory())
      throw new HistoryError('HISTORY_UNWRITABLE', 'History destination is not a directory', {
        path: directory,
      });
    return;
  }
  const parent = path.dirname(directory);
  if (directory !== root) await createHistoryDirectory(root, parent);
  else {
    // Root aliases were resolved before activation; creation preserves the configured ancestor.
    const absent: string[] = [];
    let ancestor = parent;
    while (
      !(await lstat(ancestor).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return null;
        throw cause;
      }))
    ) {
      absent.unshift(ancestor);
      ancestor = path.dirname(ancestor);
    }
    for (const part of absent) {
      await mkdir(part, { mode: 0o700 });
      await fsyncDirStrict(path.dirname(part));
    }
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new HistoryError('HISTORY_UNWRITABLE', 'Cannot create history directory', {
        path: directory,
        cause,
      });
  }
  const info = await inspectHistoryPath(root, directory);
  if (!info?.isDirectory())
    throw new HistoryError('HISTORY_UNWRITABLE', 'History directory changed during creation', {
      path: directory,
    });
  await fsyncDirStrict(parent);
}
