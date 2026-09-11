import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { GitOidSchema, ManagedGitRefSchema } from '@orcaops/storage/history/git-ref-schema';
import { contained } from '@orcaops/storage/history/primitives';

import { runHistoryGit } from './git-context.js';

export interface ManagedGitRefObservation {
  fullRef: string;
  oid: string | null;
  symbolicTarget: string | null;
  issue: string | null;
}

export interface ManagedGitRefInspectionIssue {
  code: string;
  message: string;
  resourceId: string | null;
}

export async function inspectManagedGitRefs(
  cwd: string,
  commonDir: string
): Promise<{ refs: ManagedGitRefObservation[]; issues: ManagedGitRefInspectionIssue[] }> {
  const refs = new Map<string, ManagedGitRefObservation>();
  const issues: ManagedGitRefInspectionIssue[] = [];
  try {
    const result = await runHistoryGit(cwd, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(symref)',
      'refs/orcaops/',
    ]);
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const [fullRef, oid, symbolicTarget, extra] = line.split('\0');
      if (!fullRef?.startsWith('refs/orcaops/') || extra !== undefined)
        throw new Error('Git namespace enumeration returned an unclassified entry');
      refs.set(fullRef, {
        fullRef,
        oid: oid || null,
        symbolicTarget: symbolicTarget || null,
        issue:
          !ManagedGitRefSchema.safeParse(fullRef).success || !GitOidSchema.safeParse(oid).success
            ? 'Malformed managed ref is protected'
            : null,
      });
    }
  } catch (cause) {
    issues.push({ code: 'GIT_NAMESPACE_UNAVAILABLE', message: String(cause), resourceId: null });
  }
  const visit = async (relative: string): Promise<void> => {
    const full = path.join(commonDir, relative);
    let stat;
    try {
      stat = await lstat(contained(commonDir, full));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      issues.push({
        code: 'GIT_NAMESPACE_UNAVAILABLE',
        message: String(cause),
        resourceId: relative,
      });
      refs.set(relative, {
        fullRef: relative,
        oid: null,
        symbolicTarget: null,
        issue: 'Unsafe managed ref path is protected',
      });
      return;
    }
    if (stat.isDirectory()) {
      if (
        stat.mode & 0o022 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      )
        throw new Error('Managed ref directory has unsafe ownership or permissions');
      for (const name of (await readdir(full)).sort()) await visit(relative + '/' + name);
      return;
    }
    const found = refs.get(relative);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      stat.mode & 0o022
    ) {
      refs.set(relative, {
        fullRef: relative,
        oid: null,
        symbolicTarget: null,
        issue: 'Unsafe managed ref file is protected',
      });
    } else if (!found) {
      refs.set(relative, {
        fullRef: relative,
        oid: null,
        symbolicTarget: null,
        issue: 'Git could not resolve this managed ref',
      });
    }
  };
  try {
    await visit('refs/orcaops');
  } catch (cause) {
    issues.push({ code: 'GIT_NAMESPACE_UNAVAILABLE', message: String(cause), resourceId: null });
  }
  return { refs: [...refs.values()], issues };
}
