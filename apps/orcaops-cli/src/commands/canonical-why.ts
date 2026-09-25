import { stringifyTerminalSafeJson } from '@orcaops/evaluator-protocol/terminal';
import type { HistorySelector } from '@orcaops/project-scope/history';

import { emitOk, writeTerminalSafeStdout } from '../io/output.js';
import type { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { readDatabaseCanonicalWhy } from '../lib/database-history-provenance.js';
import { type CanonicalWhyOptions, validateCanonicalWhy } from '../lib/history-provenance.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import { emitInspectionError } from '../lib/inspection-output.js';
import { formatRationaleWhy } from '../lib/provenance-rationale.js';

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
        const result = await readDatabaseCanonicalWhy(context, query, options);
        if (options.json) emitOk(result);
        else
          writeTerminalSafeStdout(
            'knowledge' in result
              ? formatRationaleWhy(result)
              : stringifyTerminalSafeJson({ ok: true, ...result }) + '\n'
          );
      } finally {
        context.scope.close();
      }
    } catch (cause) {
      emitInspectionError(historyScopeCommandError(cause), options.json ?? false);
    }
  };
}
