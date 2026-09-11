import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { measureDiffAttribution } from '../lib/database-diff.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import {
  type DatabaseStatsContext,
  type DatabaseStatsOptions,
  formatDatabaseStats,
  readDatabaseStats,
  validateDatabaseStats,
} from '../lib/database-stats.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';

export type StatsOptions = DatabaseStatsOptions;

export function createDatabaseStatsAction(dependencies: {
  openContext(options: ReturnType<typeof validateDatabaseStats>): Promise<DatabaseStatsContext>;
}) {
  return async (input: StatsOptions = {}): Promise<void> => {
    const json = !!input && typeof input === 'object' && input.json === true;
    try {
      // The caller's object is copied before the first await so a later
      // mutation cannot change the selection that the opened context serves.
      validateDatabaseStats(input);
      const options = { ...input };
      const prepared = validateDatabaseStats(options);
      const context = await dependencies.openContext(prepared);
      let result: ReturnType<typeof readDatabaseStats>;
      try {
        // Measured before the statistics read and outside every read
        // transaction: this is the one Git-side number in the output.
        const attribution = await measureDiffAttribution(context);
        result = readDatabaseStats(context, options, attribution);
      } catch (cause) {
        closeFailedHistoryRead(context.scope);
        throw cause;
      }
      context.scope.close();
      if (json) emitOk(result);
      else writeTerminalSafeStdout(formatDatabaseStats(result));
    } catch (cause) {
      const error = historyScopeCommandError(cause);
      if (json) emitError(error);
      writeErrorLine(error);
      throw new CliExit(1);
    }
  };
}

export const statsAction = createDatabaseStatsAction({
  openContext: ({ selector, profile }) =>
    resolveDatabaseHistoryCommandContext({ profile, selector }),
});

export {
  computeEvaluatorRates,
  computeRevisionChurn,
  computeDurationStats,
  type EvaluatorRateRow,
  type RevisionChurn,
  type DurationStats,
} from '../lib/history-views.js';
