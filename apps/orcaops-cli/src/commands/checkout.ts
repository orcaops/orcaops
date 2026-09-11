import { publishDatabaseCheckout } from '@orcaops/core/history/database-checkout';
import { stringifyTerminalSafeJson } from '@orcaops/evaluator-protocol/terminal';
import { HistoryScopeError } from '@orcaops/project-scope/history';
import { HistoryError } from '@orcaops/storage/history/authority';
import { openProjectDatabase, ProjectDatabaseError } from '@orcaops/storage/history/database';

import { OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitOk,
  scrubOutboundText,
  toErrorEnvelope,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import {
  type DatabaseCheckoutOptions,
  prepareDatabaseCheckoutCommand,
} from '../lib/database-checkout.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';

export type CheckoutOptions = DatabaseCheckoutOptions;
export function createDatabaseCheckoutAction(dependencies: {
  prepare: typeof prepareDatabaseCheckoutCommand;
  openWriter: typeof openProjectDatabase;
  publish: typeof publishDatabaseCheckout;
}) {
  return async (received: CheckoutOptions): Promise<void> => {
    const json = !!received && typeof received === 'object' && received.json === true;
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    let identity: Awaited<ReturnType<typeof prepareDatabaseCheckoutCommand>>['identity'] | null =
      null;
    let committed: Awaited<ReturnType<typeof publishDatabaseCheckout>> | null = null;
    let waiting = false;
    try {
      const request = await dependencies.prepare(received, {
        signal: controller.signal,
        onWait: () => {
          if (!waiting) {
            waiting = true;
            writeTerminalSafeStderr(
              'Waiting for checkout on the selected project database; Ctrl-C cancels the wait.\n'
            );
          }
        },
      });
      identity = request.identity;
      if (controller.signal.aborted)
        throw new ProjectDatabaseError('CANCELLED', 'Checkout cancelled before opening the writer');
      const writer = await dependencies.openWriter({
        authority: request.authority,
        mode: 'writer',
        signal: controller.signal,
      });
      // An interrupt that lands while the writer is opening must be answered here rather
      // than at settlement, and the opened writer released rather than left behind.
      if (controller.signal.aborted) {
        closeFailedHistoryRead(writer);
        throw new ProjectDatabaseError('CANCELLED', 'Checkout cancelled while opening the writer');
      }
      try {
        committed = await dependencies.publish(writer, request.prepared);
      } catch (cause) {
        closeFailedHistoryRead(writer);
        throw cause;
      }
      if (committed.focus.state === 'failed') closeFailedHistoryRead(writer);
      else writer.close();
      const output = {
        schema_version: 3,
        project_id: request.authority.projectId,
        shell_key: request.shellKey,
        action:
          committed.focus.state === 'failed'
            ? 'partial'
            : committed.focus.publication?.replayed
              ? 'replayed'
              : committed.focus.state === 'cleared'
                ? 'cleared'
                : 'focused',
        artifact_id: committed.artifactId,
        operation_id: committed.operationId,
        focus_operation_id: committed.focus.operationId,
        binding: committed.binding
          ? { state: committed.binding.replayed ? 'replayed' : 'committed', ...committed.binding }
          : { state: 'unchanged' },
        focus: {
          state: committed.focus.publication?.replayed ? 'replayed' : committed.focus.state,
          original_state: committed.focus.state,
          publication: committed.focus.publication,
        },
      };
      if (committed.focus.state === 'failed') {
        if (json)
          process.stdout.write(
            stringifyTerminalSafeJson({ ...toErrorEnvelope(committed.focus.error), ...output }) +
              '\n'
          );
        else {
          writeTerminalSafeStdout(
            `Binding committed for ${committed.artifactId}; focus publication failed.\nOriginal checkout: ${committed.operationId}\nOriginal focus: ${committed.focus.operationId}\nRetry: orcaops checkout --operation-id ${committed.operationId}\n`
          );
          writeErrorLine(committed.focus.error);
        }
        throw new CliExit(1);
      }
      if (json) emitOk(output);
      else
        writeTerminalSafeStdout(
          committed.focus.publication?.replayed
            ? `Replayed original checkout receipt ${committed.operationId}; current focus was not changed.\n`
            : committed.focus.state === 'cleared'
              ? `Cleared session focus.\nOperation: ${committed.operationId}\n`
              : `Focused ${committed.artifactId}.\nBinding: ${committed.binding ? 'committed' : 'unchanged'}.\nOperation: ${committed.operationId}\n`
        );
    } catch (cause) {
      if (cause instanceof CliExit) throw cause;
      const error =
        cause instanceof ProjectDatabaseError
          ? cause
          : cause instanceof HistoryScopeError || cause instanceof HistoryError
            ? new OrcaopsError(cause.code, scrubOutboundText(cause.message))
            : cause;
      if (json)
        process.stdout.write(
          stringifyTerminalSafeJson({
            ...toErrorEnvelope(error),
            schema_version: 3,
            ...(identity
              ? {
                  operation_id: identity.operationId,
                  focus_operation_id: identity.focusOperationId,
                  artifact_id: identity.artifactId,
                }
              : {}),
            ...(committed
              ? {
                  binding: committed.binding
                    ? {
                        state: committed.binding.replayed ? 'replayed' : 'committed',
                        ...committed.binding,
                      }
                    : { state: 'unchanged' },
                  focus: {
                    state: committed.focus.publication?.replayed
                      ? 'replayed'
                      : committed.focus.state,
                    original_state: committed.focus.state,
                    publication: committed.focus.publication,
                  },
                }
              : {}),
          }) + '\n'
        );
      else {
        writeErrorLine(error);
        if (identity)
          writeTerminalSafeStderr(
            `Original operation: ${identity.operationId}; original focus: ${identity.focusOperationId}. Retain these IDs when inspecting or retrying checkout.\n`
          );
      }
      throw new CliExit(1);
    } finally {
      process.off('SIGINT', interrupt);
    }
  };
}
export const checkoutAction = createDatabaseCheckoutAction({
  prepare: prepareDatabaseCheckoutCommand,
  openWriter: openProjectDatabase,
  publish: publishDatabaseCheckout,
});
