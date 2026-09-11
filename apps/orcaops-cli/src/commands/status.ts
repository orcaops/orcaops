import { HistoryScopeError, type HistorySelector } from '@orcaops/project-scope/history';
import type { DatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { type Config, ConfigValidationError } from '@orcaops/storage';
import { HistoryError } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  scrubOutboundText,
  writeErrorLine,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { readTaskAdvisories } from '../lib/database-task-advisories.js';
import {
  type DatabaseTaskOptions,
  readDatabaseStatus,
  validateDatabaseTaskOptions,
} from '../lib/database-task-context.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { formatDriftNudge } from '../lib/install-drift.js';
import { getInvocationEnv } from '../lib/invocation-context.js';

type DatabaseTaskCommandContext = { scope: DatabaseHistoryScope; config: Config };

export type StatusOptions = DatabaseTaskOptions;
export function createDatabaseStatusAction(dependencies: {
  openContext(
    selector: HistorySelector,
    env: NodeJS.ProcessEnv
  ): Promise<DatabaseTaskCommandContext>;
}) {
  return async (input: StatusOptions = {}) => {
    const json = input !== null && typeof input === 'object' && input.json === true;
    try {
      const { selector } = validateDatabaseTaskOptions(input);
      const env = { ...getInvocationEnv() };
      let context: DatabaseTaskCommandContext;
      try {
        context = await dependencies.openContext(selector, env);
      } catch (cause) {
        if (
          !(cause instanceof HistoryScopeError) ||
          cause.code !== 'PROJECT_REQUIRED' ||
          selector.projectId !== undefined ||
          selector.scope !== undefined
        )
          throw cause;
        const output = {
          schema_version: 3,
          branch: null,
          context: { git: null, issues: [{ code: cause.code, message: cause.message }] },
          history: {
            state: 'unavailable',
            complete: false,
            projects: [],
            issues: [{ code: cause.code, message: cause.message }],
          },
          focus: [],
          binding: [],
          eligibility: { state: 'unavailable', reason: cause.code },
          eligible_tasks: [],
          artifacts: [],
          imported_artifacts: { count: null, known_count: 0, artifacts: [] },
          coding_sessions: [],
          cloud_sync: { state: 'unavailable', pending_count: null, stuck_count: null },
        };
        if (json) emitOk(output);
        else
          writeTerminalSafeStdout(
            'Task context unavailable: select a project or enter a registered checkout.\n'
          );
        return;
      }
      let result: ReturnType<typeof readDatabaseStatus>;
      let advisories: Awaited<ReturnType<typeof readTaskAdvisories>>;
      try {
        advisories = await readTaskAdvisories(context, env);
        result = readDatabaseStatus(context, env, Date.now(), advisories.acknowledgeByRef);
      } catch (cause) {
        closeFailedHistoryRead(context.scope);
        throw cause;
      }
      context.scope.close();
      if (json)
        emitOk({
          ...result,
          ...(advisories.drift ? { drift: advisories.drift } : {}),
          index_conflicts: advisories.index,
        });
      else {
        const lines = [
          `Branch: ${result.branch ?? 'unavailable or all branches'}`,
          `History: ${result.history.complete ? 'complete' : 'incomplete'}`,
        ];
        for (const issue of result.history.issues) lines.push(`  ${issue.code}: ${issue.message}`);
        for (const project of result.focus)
          if (project.pin)
            lines.push(
              `Focus: ${project.pin.artifact_id} (${project.assessment?.reason ?? 'valid'})`
            );
        for (const artifact of result.artifacts) {
          lines.push(
            '',
            `${artifact.id}  ${artifact.task}`,
            `  state: ${artifact.state}  capture_health: ${artifact.capture_health}`
          );
          for (const [name, value] of Object.entries(artifact.thread))
            lines.push(`  ${name}: ${value.status}`);
          for (const action of artifact.next_actions) lines.push(`  ${action.command}`);
        }
        if (advisories.index.state === 'available' && advisories.index.unmerged_paths.length)
          lines.push(`Unmerged index paths: ${advisories.index.unmerged_paths.join(', ')}`);
        if (!result.artifacts.length) lines.push('No live artifacts in this selection.');
        if (result.imported_artifacts.count)
          lines.push(
            `Imported evidence: ${result.imported_artifacts.count} artifact(s); not implicit task authority.`
          );
        if (advisories.drift) lines.push(formatDriftNudge(advisories.drift));
        writeTerminalSafeStdout(lines.join('\n') + '\n');
      }
    } catch (cause) {
      const error =
        cause instanceof ProjectDatabaseError
          ? cause
          : cause instanceof ConfigValidationError
            ? new OrcaopsError(ErrorCodes.INVALID_CONFIG, cause.message, cause.path)
            : cause instanceof HistoryScopeError || cause instanceof HistoryError
              ? new OrcaopsError(cause.code, scrubOutboundText(cause.message))
              : cause;
      if (json) emitError(error);
      writeErrorLine(error);
      throw new CliExit(1);
    }
  };
}
export const statusAction = createDatabaseStatusAction({
  openContext: (selector, env) =>
    resolveDatabaseHistoryCommandContext({ profile: 'status', selector, env }),
});
