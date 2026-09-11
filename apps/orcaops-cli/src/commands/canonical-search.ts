import { HistorySearchError } from '@orcaops/core/history/search';
import { HistoryScopeError, type HistorySelector } from '@orcaops/project-scope/history';
import { HistoryError } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';
import { HistoryPersistenceError } from '@orcaops/storage/history/primitives';

import { OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  scrubOutboundText,
  writeErrorLine,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import {
  type CanonicalSearchContext,
  type CanonicalSearchOptions,
  formatCanonicalSearch,
  readCanonicalSearch,
  validateCanonicalSearch,
} from '../lib/history-search.js';

export function createCanonicalSearchAction(dependencies: {
  openContext(selector: HistorySelector): Promise<CanonicalSearchContext>;
}) {
  return async (query: string, options: CanonicalSearchOptions = {}): Promise<void> => {
    options = { ...options };
    try {
      const prepared = validateCanonicalSearch(query, options);
      const context = await dependencies.openContext(prepared.selector);
      let result: Awaited<ReturnType<typeof readCanonicalSearch>>;
      try {
        result = await readCanonicalSearch(context, query, options);
      } catch (cause) {
        closeFailedHistoryRead(context.scope);
        throw cause;
      }
      context.scope.close();
      if (options.json) emitOk(result);
      else writeTerminalSafeStdout(formatCanonicalSearch(result));
    } catch (cause) {
      const error =
        cause instanceof ProjectDatabaseError
          ? cause
          : cause instanceof HistorySearchError ||
              cause instanceof HistoryScopeError ||
              cause instanceof HistoryError ||
              cause instanceof HistoryPersistenceError
            ? new OrcaopsError(cause.code, scrubOutboundText(cause.message))
            : cause;
      if (options.json) emitError(error);
      writeErrorLine(error);
      throw new CliExit(1);
    }
  };
}
