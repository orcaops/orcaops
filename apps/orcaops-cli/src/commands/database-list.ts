import { HistoryScopeError, type HistorySelector } from '@orcaops/project-scope/history';
import { HistoryError } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  scrubOutboundText,
  writeErrorLine,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { formatDatabaseRangeList, readDatabaseRangeList } from '../lib/database-list-range.js';
import {
  type DatabaseListContext,
  type DatabaseListOptions,
  formatDatabaseList,
  readDatabaseList,
  validateDatabaseList,
} from '../lib/database-list.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';

export function createDatabaseListAction(dependencies: {
  openContext(selector: HistorySelector, between?: string): Promise<DatabaseListContext>;
}) {
  return async (input: DatabaseListOptions = {}): Promise<void> => {
    const json = input !== null && typeof input === 'object' && input.json === true;
    try {
      validateDatabaseList(input);
      const options = { ...input };
      const prepared = validateDatabaseList(options);
      const context = await dependencies.openContext(prepared.selector, options.between);
      let result:
        | ReturnType<typeof readDatabaseList>
        | Awaited<ReturnType<typeof readDatabaseRangeList>>;
      let human = '';
      try {
        if (options.between === undefined) {
          result = readDatabaseList(context, options);
          if (!json) human = formatDatabaseList(result);
        } else {
          const range = await readDatabaseRangeList(context, options);
          result = range;
          if (!json) human = formatDatabaseRangeList(range);
        }
      } catch (cause) {
        closeFailedHistoryRead(context.scope);
        throw cause;
      }
      context.scope.close();
      if (json) emitOk(result);
      else writeTerminalSafeStdout(human);
    } catch (cause) {
      const error =
        cause instanceof ProjectDatabaseError
          ? cause
          : cause instanceof HistoryScopeError || cause instanceof HistoryError
            ? new OrcaopsError(cause.code, scrubOutboundText(cause.message))
            : cause;
      if (json) emitError(error);
      writeErrorLine(error);
      throw new CliExit(1);
    }
  };
}
