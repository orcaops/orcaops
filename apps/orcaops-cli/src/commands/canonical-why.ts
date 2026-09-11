import type { HistorySelector } from '@orcaops/project-scope/history';

import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import type { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import {
  readDatabaseCanonicalWhy,
  readDatabaseProvenance,
} from '../lib/database-history-provenance.js';
import {
  type CanonicalWhyOptions,
  formatCanonicalWhy,
  validateCanonicalWhy,
} from '../lib/history-provenance.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';

export function createCanonicalWhyAction(dependencies: {
  openContext(
    selector: HistorySelector
  ): Promise<Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>>;
}) {
  return async (query: string, options: CanonicalWhyOptions = {}): Promise<void> => {
    options = { ...options };
    try {
      const prepared = validateCanonicalWhy(query, options);
      const context = await dependencies.openContext(prepared.selector);
      try {
        if (options.json) emitOk(await readDatabaseCanonicalWhy(context, query, options));
        else
          writeTerminalSafeStdout(
            formatCanonicalWhy(await readDatabaseProvenance(context, query, options), options.all)
          );
      } finally {
        context.scope.close();
      }
    } catch (cause) {
      const error = historyScopeCommandError(cause);
      if (options.json) emitError(error);
      writeErrorLine(error);
      throw new CliExit(1);
    }
  };
}
