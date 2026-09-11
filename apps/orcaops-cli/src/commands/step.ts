import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import {
  type DatabaseStepBriefContext,
  type DatabaseStepBriefOptions,
  formatDatabaseStepBrief,
  readDatabaseStepBrief,
  validateDatabaseStepBrief,
} from '../lib/database-step.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';

export type StepBriefOptions = DatabaseStepBriefOptions;

export function createDatabaseStepBriefAction(dependencies: {
  openContext(
    options: ReturnType<typeof validateDatabaseStepBrief>
  ): Promise<DatabaseStepBriefContext>;
}) {
  return async (stepId: string, input: StepBriefOptions = {}): Promise<void> => {
    const json = !!input && typeof input === 'object' && input.json === true;
    try {
      // The caller's object is copied before the first await so a later
      // mutation cannot change the selection that the opened context serves.
      validateDatabaseStepBrief(stepId, input);
      const options = { ...input };
      const prepared = validateDatabaseStepBrief(stepId, options);
      const context = await dependencies.openContext(prepared);
      let result: ReturnType<typeof readDatabaseStepBrief>;
      try {
        result = readDatabaseStepBrief(context, stepId, options);
      } catch (cause) {
        closeFailedHistoryRead(context.scope);
        throw cause;
      }
      context.scope.close();
      if (json) emitOk(result);
      else writeTerminalSafeStdout(formatDatabaseStepBrief(result));
    } catch (cause) {
      const error = historyScopeCommandError(cause);
      if (json) emitError(error);
      writeErrorLine(error);
      throw new CliExit(1);
    }
  };
}

export const stepBriefAction = createDatabaseStepBriefAction({
  openContext: ({ selector, profile }) =>
    resolveDatabaseHistoryCommandContext({ profile, selector }),
});

export {
  buildStepBrief,
  type StepBrief,
  type StepBriefInput,
  type StepClaimState,
} from '../lib/history-views.js';
