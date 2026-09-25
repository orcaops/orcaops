import path from 'node:path';

import { emitOk, writeTerminalSafeStdout } from '../io/output.js';
import {
  artifactInspection,
  type ArtifactInspectionOptions,
  artifactInspectionOptions,
  renderArtifactInspection,
} from '../lib/artifact-inspection.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { readDatabaseShow, validateDatabaseShow } from '../lib/database-show.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import {
  emitInspectionError,
  EXPORT_BYTES,
  exportInspection,
  measuredInspection,
} from '../lib/inspection-output.js';
import { getInvocationCwd } from '../lib/invocation-context.js';

export type ShowOptions = ArtifactInspectionOptions;
export async function showAction(artifactId: string, opts: ShowOptions = {}): Promise<void> {
  try {
    const request = artifactInspectionOptions(opts);
    const selector = validateDatabaseShow(artifactId, request.read);
    const context = await resolveDatabaseHistoryCommandContext({ profile: 'exact', selector });
    let result: Awaited<ReturnType<typeof readDatabaseShow>>;
    try {
      result = await readDatabaseShow(context, artifactId, request.read);
    } catch (cause) {
      closeFailedHistoryRead(context.scope);
      throw cause;
    }
    context.scope.close();
    const inspection = artifactInspection(result, opts);
    if (opts.output)
      measuredInspection({
        schema_version: 4,
        representation: 'export_receipt',
        status: 'exported',
        selection: inspection.response.selection,
        completeness: result.completeness,
        file: { path: path.resolve(getInvocationCwd(), opts.output), bytes: EXPORT_BYTES },
      });
    const response = opts.output
      ? measuredInspection({
          schema_version: 4,
          representation: 'export_receipt',
          status: 'exported',
          selection: inspection.response.selection,
          completeness: result.completeness,
          file: await exportInspection(opts.output, inspection.exportValue),
        })
      : inspection.response;
    if (opts.json) emitOk(response);
    else
      writeTerminalSafeStdout(
        opts.output
          ? JSON.stringify(response) + '\n'
          : renderArtifactInspection(inspection.response)
      );
  } catch (cause) {
    const err = historyScopeCommandError(cause);
    emitInspectionError(err, opts.json ?? false);
  }
}
