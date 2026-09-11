import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { isUuidV7 } from '@orcaops/storage';

import { HistoryScopeError, type HistoryScopeInput } from './history-types.js';

export function validateHistorySelector(input: HistoryScopeInput): void {
  const selector = input.selector ?? {};
  if (Object.keys(selector).some((key) => !['scope', 'projectId', 'branch'].includes(key)))
    throw new HistoryScopeError('INVALID_INPUT', 'Unsupported history selector');
  if (
    input.profile !== undefined &&
    !['collection', 'exact', 'status', 'resume', 'git-history'].includes(input.profile)
  )
    throw new HistoryScopeError('INVALID_INPUT', 'Unknown history command profile');
  if (
    selector.scope !== undefined &&
    !['worktree', 'project', 'all-projects'].includes(selector.scope)
  )
    throw new HistoryScopeError('INVALID_INPUT', 'Unknown history scope');
  if (selector.projectId !== undefined && !isUuidV7(selector.projectId))
    throw new HistoryScopeError('INVALID_INPUT', 'Project identity must be a UUIDv7');
  if (
    selector.branch !== undefined &&
    (!selector.branch.trim() || /[\r\n\0]/.test(selector.branch))
  )
    throw new HistoryScopeError('INVALID_INPUT', 'Branch must be a nonempty literal name');
  if (
    selector.scope === 'all-projects' &&
    (selector.projectId !== undefined || input.gitRange !== undefined)
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'All-projects conflicts with project selection and Git ranges'
    );
  if (
    input.profile === 'exact' &&
    (selector.scope !== undefined || selector.branch !== undefined || input.gitRange !== undefined)
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'Exact history reads accept project qualification only'
    );
  if (
    (input.profile === 'resume' || input.profile === 'git-history') &&
    selector.scope === 'all-projects'
  )
    throw new HistoryScopeError('SCOPE_CONFLICT', 'This operation requires one project');
}

export async function hasGitBoundary(cwd: string): Promise<boolean> {
  let current = path.resolve(cwd);
  for (;;) {
    try {
      await lstat(path.join(current, '.git'));
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
