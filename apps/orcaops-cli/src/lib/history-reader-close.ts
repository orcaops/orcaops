import { toErrorEnvelope, writeTerminalSafeStderr } from '../io/output.js';

export function closeFailedHistoryRead(scope: { close(): void }): void {
  try {
    scope.close();
  } catch (cause) {
    try {
      const { error } = toErrorEnvelope(cause);
      writeTerminalSafeStderr(
        `note: Reader cleanup also failed [${error.code}${error.reason ? `; ${error.reason}` : ''}]: ${error.message}\n`
      );
    } catch {
      // Cleanup diagnostics must not replace the original read failure.
    }
  }
}
