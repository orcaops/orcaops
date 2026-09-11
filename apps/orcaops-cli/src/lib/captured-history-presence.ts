import { queryProjectArtifacts } from '@orcaops/storage/history/database';

import { resolveDatabaseHistoryCommandContext } from './database-history-context.js';

/**
 * Whether this repository has captured anything yet, asked of the project
 * database rather than of a legacy artifact directory.
 *
 * Purely advisory: every caller uses it to decide whether to OFFER something,
 * so an unreadable, unregistered or mid-conversion history answers "nothing
 * captured" rather than failing the command. It opens no store it has to
 * create — the scope reports an unavailable authority instead — and the row
 * read is bounded to one, because the question is existence, not a count.
 */
export async function repositoryHasCapturedHistory(
  cwd: string,
  options: { dataRoot?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<boolean> {
  let context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>;
  try {
    context = await resolveDatabaseHistoryCommandContext({
      profile: 'status',
      selector: { scope: 'project' },
      cwd,
      ...options,
    });
  } catch {
    return false;
  }
  try {
    for (const project of context.scope.projects) {
      if (project.database === null) continue;
      if (queryProjectArtifacts(project.database, { limit: 1 }).rows.length > 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    context.scope.close();
  }
}
