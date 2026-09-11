import { execFile } from 'node:child_process';
import { lstat, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

const execute = promisify(execFile);
const localLinuxTypes = new Set([0xef53n, 0x58465342n, 0x9123683en]);

export function parseDarwinMounts(
  text: string
): Array<{ mountpoint: string; type: string; local: boolean }> {
  const result = [];
  for (const line of text.trimEnd().split('\n')) {
    const options = / \(([^()\r\n]+)\)$/.exec(line);
    if (!options) throw new Error('Unclassified mount record');
    const prefix = line.slice(0, options.index);
    const splits = [...prefix.matchAll(/ on (?=\/)/g)];
    if (splits.length !== 1) throw new Error('Ambiguous mountpoint record');
    const mountpoint = prefix.slice(splits[0].index! + 4);
    if (path.normalize(mountpoint) !== mountpoint || /[\r\n\0]/.test(mountpoint))
      throw new Error('Invalid mountpoint');
    const flags = options[1].split(', ');
    result.push({ mountpoint, type: flags[0], local: flags.includes('local') });
  }
  return result;
}
function observeWithCancellation<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(signal.reason);
    signal.addEventListener('abort', cancelled, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
    if (signal.aborted) cancelled();
  });
}
export async function inspectDatabaseFilesystem(root: string, signal?: AbortSignal): Promise<void> {
  try {
    signal?.throwIfAborted();
    let ancestor = root;
    let info;
    for (;;) {
      try {
        info = await observeWithCancellation(lstat(ancestor, { bigint: true }), signal);
        break;
      } catch (cause) {
        if (
          (cause as NodeJS.ErrnoException).code !== 'ENOENT' ||
          path.dirname(ancestor) === ancestor
        )
          throw cause;
        ancestor = path.dirname(ancestor);
      }
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Existing storage ancestor is not a directory');
    const filesystem = await observeWithCancellation(statfs(ancestor, { bigint: true }), signal);
    if (process.platform === 'darwin') {
      const { stdout } = await execute('/sbin/mount', [], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5000,
        signal,
      });
      const candidates = [];
      for (const entry of parseDarwinMounts(stdout)) {
        signal?.throwIfAborted();
        if (!entry.local || !['apfs', 'hfs'].includes(entry.type)) continue;
        const observed = await observeWithCancellation(
          stat(entry.mountpoint, { bigint: true }),
          signal
        );
        if (observed.dev === info.dev) {
          const mounted = await observeWithCancellation(
            statfs(entry.mountpoint, { bigint: true }),
            signal
          );
          if (mounted.type !== filesystem.type)
            throw new Error('Selected filesystem type differs from the named local mount');
          candidates.push(entry);
        }
      }
      if (
        !candidates.length ||
        candidates.some((entry) => !entry.local || !['apfs', 'hfs'].includes(entry.type)) ||
        new Set(candidates.map((entry) => entry.type)).size !== 1
      )
        throw new Error('Mount observations do not establish supported local APFS/HFS storage');
    } else if (process.platform !== 'linux' || !localLinuxTypes.has(filesystem.type)) {
      throw new Error('Filesystem is not positively identified as supported durable local storage');
    }
    const after = await observeWithCancellation(lstat(ancestor, { bigint: true }), signal);
    if (after.dev !== info.dev || after.ino !== info.ino)
      throw new Error('Storage ancestor changed during capability inspection');
    signal?.throwIfAborted();
  } catch (cause) {
    if (signal?.aborted)
      throw new ProjectDatabaseError(
        'CANCELLED',
        'Storage capability inspection cancelled before setup; retry only if still wanted',
        { cause }
      );
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Storage locality or durability is unavailable or unsupported; select supported local APFS/HFS or ext/XFS/Btrfs storage and retry without replacing expected history',
      { cause }
    );
  }
}
