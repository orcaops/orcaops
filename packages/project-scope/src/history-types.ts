import type { DatabaseHistoryContext } from '@orcaops/core/history/database-read';

export type HistoryScopeKind = 'worktree' | 'project' | 'all-projects';
export type HistoryProfile = 'collection' | 'exact' | 'status' | 'resume' | 'git-history';

export interface HistoryIssue {
  code: string;
  project_id: string | null;
  artifact_id?: string;
  count?: number;
  resource?: string;
  message: string;
}

export interface HistoryCompleteness {
  complete: boolean;
  issues: HistoryIssue[];
}

export interface HistorySelector {
  scope?: HistoryScopeKind;
  projectId?: string;
  branch?: string;
}

export interface HistoryScopeInput {
  // Canonical data root; CLI --root and ORCAOPS_ROOT select the checkout supplied as cwd.
  root?: string;
  cacheRoot?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  selector?: HistorySelector;
  profile?: HistoryProfile;
  gitRange?: string;
  gitContext?: DatabaseHistoryContext['git'] | null;
}

export class HistoryScopeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'HistoryScopeError';
  }
}

export function unavailableProjectError(
  issues: readonly HistoryIssue[],
  fallback: { code: string; message: string } = {
    code: 'HISTORY_INACCESSIBLE',
    message: 'Selected project history is unavailable',
  },
  context: Record<string, unknown> = {}
): HistoryScopeError {
  const first = issues[0];
  return new HistoryScopeError(first?.code ?? fallback.code, first?.message ?? fallback.message, {
    ...context,
    issues: [...issues],
  });
}
