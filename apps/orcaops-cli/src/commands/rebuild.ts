import { rebuildProjectQueryMetadata } from '@orcaops/storage/history/database';

import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { requireRepositoryScope } from '../lib/database-branch-history.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';

export interface RebuildOptions {
  json?: boolean;
}

export async function rebuildAction(opts: RebuildOptions = {}): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  let context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>> | undefined;
  try {
    context = await resolveDatabaseHistoryCommandContext({ profile: 'git-history' });
    const selected = requireRepositoryScope(context.scope);
    let waiting = false;
    const result = await rebuildProjectQueryMetadata(
      { authority: selected.authority, authorize() {} },
      {
        signal: controller.signal,
        onWait() {
          if (waiting) return;
          waiting = true;
          writeTerminalSafeStderr('Waiting to rebuild project indexes; Ctrl-C cancels the wait.\n');
        },
      }
    );
    if (opts.json) {
      emitOk({
        artifacts: result.artifactCount,
        executions: result.executionCount,
        skipped_artifacts: 0,
        counters: result.counters,
      });
    } else {
      writeTerminalSafeStdout(
        `Rebuilt project query and search indexes from retained database history.\n` +
          `  artifacts: ${result.artifactCount}\n  executions: ${result.executionCount}\n`
      );
    }
  } catch (cause) {
    const error = historyScopeCommandError(cause);
    if (opts.json) emitError(error);
    writeErrorLine(error);
    throw new CliExit(1);
  } finally {
    context?.scope.close();
    process.off('SIGINT', interrupt);
  }
}
