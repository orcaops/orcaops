import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { type HistoryAuthority, HistoryError, type HistoryRoot } from './types.js';
import { isUuidV7 } from '../ids/uuidv7.js';

export function historyRootKey(resolvedRoot: string): string {
  return createHash('sha256').update(resolvedRoot, 'utf8').digest('hex');
}

export async function normalizeHistoryRoot(
  options: { root?: string; env?: NodeJS.ProcessEnv; home?: string; cwd?: string } = {}
): Promise<HistoryRoot> {
  const env = options.env ?? process.env;
  const configured = options.root ?? env.ORCAOPS_DATA_DIR?.trim();
  const selected =
    configured ||
    (env.XDG_DATA_HOME?.trim()
      ? path.join(env.XDG_DATA_HOME.trim(), 'orcaops')
      : path.join(options.home ?? homedir(), '.orcaops'));
  let ancestor = path.resolve(options.cwd ?? process.cwd(), selected);
  const suffix: string[] = [];
  for (;;) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      const info = await lstat(resolvedAncestor);
      if (!info.isDirectory())
        throw new HistoryError('HISTORY_INACCESSIBLE', 'History root ancestor is not a directory', {
          path: ancestor,
        });
      await access(resolvedAncestor, constants.R_OK | constants.X_OK);
      const resolvedRoot = path.join(resolvedAncestor, ...suffix);
      return { resolvedRoot, rootKey: historyRootKey(resolvedRoot) };
    } catch (cause) {
      if (cause instanceof HistoryError) throw cause;
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new HistoryError('HISTORY_INACCESSIBLE', 'Cannot resolve the selected history root', {
          path: ancestor,
          cause,
        });
      }
      // A dangling alias is evidence, not a missing suffix we may recreate.
      const link = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw new HistoryError('HISTORY_INACCESSIBLE', 'Cannot inspect the selected history root', {
          path: ancestor,
          cause: error,
        });
      });
      if (link)
        throw new HistoryError(
          'HISTORY_INACCESSIBLE',
          'History root contains an unresolved alias',
          { path: ancestor }
        );
      const parent = path.dirname(ancestor);
      if (parent === ancestor)
        throw new HistoryError('HISTORY_INACCESSIBLE', 'No accessible history root ancestor', {
          path: ancestor,
        });
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function historyPaths(authority: HistoryAuthority) {
  if (!isUuidV7(authority.projectId) || !isUuidV7(authority.storeInstanceId)) {
    throw new HistoryError(
      'HISTORY_INTEGRITY_REQUIRED',
      'History authority contains an invalid identity'
    );
  }
  if (
    !path.isAbsolute(authority.resolvedRoot) ||
    path.normalize(authority.resolvedRoot) !== authority.resolvedRoot ||
    historyRootKey(authority.resolvedRoot) !== authority.rootKey
  ) {
    throw new HistoryError('AUTHORITY_MISMATCH', 'History authority root is not canonical', {
      authority,
    });
  }
  const projectDir = path.join(authority.resolvedRoot, 'projects', authority.projectId);
  return { projectDir };
}

export function historyCacheIdentity(authority: HistoryAuthority): string {
  historyPaths(authority);
  return createHash('sha256')
    .update(
      JSON.stringify([
        authority.rootKey,
        authority.projectId,
        authority.storeInstanceId,
        authority.formatVersion,
      ])
    )
    .digest('hex');
}
