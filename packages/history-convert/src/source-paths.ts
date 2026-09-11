import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { HistoryConversionError } from './errors.js';

export interface LegacyRoot {
  resolvedRoot: string;
  rootKey: string;
}
export async function normalizeLegacyRoot(options: {
  root?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
}): Promise<LegacyRoot> {
  const env = options.env ?? process.env;
  const selected =
    options.root ||
    env.ORCAOPS_DATA_DIR?.trim() ||
    (env.XDG_DATA_HOME?.trim()
      ? path.join(env.XDG_DATA_HOME.trim(), 'orcaops')
      : path.join(options.home ?? homedir(), '.orcaops'));
  let ancestor = path.resolve(options.cwd ?? process.cwd(), selected);
  const suffix: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(ancestor);
      if (!(await lstat(resolved)).isDirectory()) throw new Error('Not a directory');
      await access(resolved, constants.R_OK | constants.X_OK);
      const resolvedRoot = path.join(resolved, ...suffix);
      return { resolvedRoot, rootKey: createHash('sha256').update(resolvedRoot).digest('hex') };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new HistoryConversionError(
          'SOURCE_UNAVAILABLE',
          'Cannot resolve selected source root',
          ancestor
        );
      const info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw new HistoryConversionError(
          'SOURCE_UNAVAILABLE',
          'Cannot inspect selected source root',
          ancestor
        );
      });
      if (info)
        throw new HistoryConversionError(
          'SOURCE_UNAVAILABLE',
          'Source root contains an unresolved alias',
          ancestor
        );
      const parent = path.dirname(ancestor);
      if (parent === ancestor)
        throw new HistoryConversionError(
          'SOURCE_UNAVAILABLE',
          'No accessible source root ancestor'
        );
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
export async function inspectLegacyPath(root: string, relative: string) {
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || relative.includes('\\'))
    throw new HistoryConversionError('SOURCE_UNAVAILABLE', 'Invalid source path', relative);
  for (let n = 0; n <= parts.length; n++) {
    const file = path.join(root, ...parts.slice(0, n));
    const info = await lstat(file, { bigint: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null;
      throw new HistoryConversionError(
        'SOURCE_UNAVAILABLE',
        'Source path cannot be inspected',
        relative
      );
    });
    if (!info) return null;
    if (info.isSymbolicLink() || (n < parts.length && !info.isDirectory()))
      throw new HistoryConversionError('SOURCE_UNAVAILABLE', 'Unsupported source parent', relative);
    if (n === parts.length) return info;
  }
  return null;
}
