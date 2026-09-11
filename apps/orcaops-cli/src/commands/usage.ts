import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { renderCanonicalUsageLines } from '../lib/canonical-usage-display.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import {
  type DatabaseUsageOptions,
  readDatabaseUsage,
  validateDatabaseUsage,
} from '../lib/database-usage.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';

export type UsageOptions = DatabaseUsageOptions;

export async function usageAction(opts: DatabaseUsageOptions = {}): Promise<void> {
  const json = opts !== null && typeof opts === 'object' && opts.json === true;
  try {
    validateDatabaseUsage(opts);
    opts = { ...opts };
    const { selector, profile } = validateDatabaseUsage(opts);
    const context = await resolveDatabaseHistoryCommandContext({ profile, selector });
    let result: ReturnType<typeof readDatabaseUsage>;
    try {
      result = readDatabaseUsage(context, opts);
    } catch (cause) {
      closeFailedHistoryRead(context.scope);
      throw cause;
    }
    context.scope.close();
    if (json) emitOk(result);
    else writeTerminalSafeStdout(renderCanonicalUsageLines(result.usage).join('\n') + '\n');
  } catch (cause) {
    const error = historyScopeCommandError(cause);
    if (json) emitError(error);
    writeErrorLine(error);
    throw new CliExit(1);
  }
}
