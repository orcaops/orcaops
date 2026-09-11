import { HistoryScopeError, type HistorySelector } from '@orcaops/project-scope/history';
import { redactSecretsInObject } from '@orcaops/storage';
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
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import {
  type DatabaseResumeOptions,
  readDatabaseResume,
  validateDatabaseResume,
} from '../lib/database-resume.js';
import { readTaskAdvisories } from '../lib/database-task-advisories.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { formatDriftNudge } from '../lib/install-drift.js';
import { getInvocationEnv } from '../lib/invocation-context.js';
import { copyToClipboard } from '../lib/resume-clipboard.js';
import { renderRepoStateNote } from '../lib/resume-repo-note.js';

export type ResumeOptions = DatabaseResumeOptions;
export function createDatabaseResumeAction(dependencies: {
  openContext(
    selector: HistorySelector,
    env: NodeJS.ProcessEnv
  ): ReturnType<typeof resolveDatabaseHistoryCommandContext>;
  copy?: typeof copyToClipboard;
}) {
  return async (input: ResumeOptions = {}): Promise<void> => {
    const json =
      !!input && typeof input === 'object' && (input.json === true || input.format === 'json');
    try {
      const { options, selector } = validateDatabaseResume(input);
      const env = { ...getInvocationEnv() };
      const context = await dependencies.openContext(selector, env);
      let result: Awaited<ReturnType<typeof readDatabaseResume>>;
      let advisories: Awaited<ReturnType<typeof readTaskAdvisories>>;
      try {
        advisories = await readTaskAdvisories(context, env);
        result = await readDatabaseResume(context, options, env, advisories.acknowledgeByRef);
        if (context.config.digest.redact_secrets) result = redactSecretsInObject(result);
      } catch (cause) {
        closeFailedHistoryRead(context.scope);
        throw cause;
      }
      context.scope.close();
      if (!result.resolved) {
        if (json) emitOk(result);
        else {
          const lines = [`No task selected: ${result.reason}.`];
          for (const candidate of result.candidates)
            lines.push(
              `  ${candidate.artifact_id}  ${candidate.label}  (${candidate.eligibility.reason ?? 'eligible'})`,
              `    ${candidate.command}`
            );
          writeTerminalSafeStdout(lines.join('\n') + '\n');
        }
        if (result.reason !== 'NO_ELIGIBLE_ARTIFACT') throw new CliExit(1);
        return;
      }
      const copied = options.copy
        ? await (dependencies.copy ?? copyToClipboard)(result.artifact.agent_prompt)
        : false;
      if (json) {
        const { markdown: _markdown, ...output } = result;
        emitOk({
          ...output,
          artifact: { ...output.artifact, copied },
          ...(advisories.drift ? { drift: advisories.drift } : {}),
        });
      } else {
        const prefix =
          result.artifact.origin?.kind === 'git-import'
            ? 'Origin: imported Git evidence; not implicit task authority.\n\n'
            : '';
        writeTerminalSafeStdout(
          renderRepoStateNote(result.artifact.repo_state) + prefix + result.markdown
        );
        if (result.artifact.git_context.state === 'unavailable')
          writeTerminalSafeStdout(
            `\nGit evidence unavailable: ${result.artifact.git_context.reason}.\n`
          );
        if (options.copy)
          writeTerminalSafeStdout(
            copied ? '\nSuggested prompt copied to clipboard.\n' : '\nNo clipboard available.\n'
          );
        if (advisories.drift) writeTerminalSafeStdout(formatDriftNudge(advisories.drift) + '\n');
      }
    } catch (cause) {
      if (cause instanceof CliExit) throw cause;
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
export const resumeAction = createDatabaseResumeAction({
  openContext: (selector, env) =>
    resolveDatabaseHistoryCommandContext({ profile: 'resume', selector, env }),
});
