import { z } from 'zod';

import { HistoryScopeError } from '@orcaops/project-scope/history';

import { OrcaopsError } from '../io/errors.js';

// A store this build cannot open because it needs the explicit upgrade, or because a newer
// build wrote it, is not a selection mistake: the caller chose the right project and the
// store's own refusal names the command or the build to use. Every other condition keeps the
// selection wording it has always had.
const SELF_EXPLAINING_HISTORY_ISSUES = new Set([
  'HISTORY_UPGRADE_REQUIRED',
  'HISTORY_FORMAT_NEWER',
]);

/** The refusal for a command whose selected project has no history it can open. */
export function unavailableHistoryRefusal(
  issue: { code: string; message: string } | undefined,
  selectionFailure: { code: string; message: string }
): HistoryScopeError {
  return issue && SELF_EXPLAINING_HISTORY_ISSUES.has(issue.code)
    ? new HistoryScopeError(issue.code, issue.message)
    : new HistoryScopeError(issue?.code ?? selectionFailure.code, selectionFailure.message);
}

const candidates = z.array(
  z.object({ project_id: z.string(), artifact_id: z.string(), command: z.string() })
);
export function historyScopeCommandError(cause: unknown): unknown {
  if (!(cause instanceof HistoryScopeError)) return cause;
  // Candidates travel with any refusal that carries them, not just an ambiguity:
  // an incomplete selection or a missing project qualification leaves the caller
  // needing the same labelled list to name what it wanted.
  const selection = candidates.safeParse(cause.context.candidates);
  const inputPath =
    typeof cause.context.inputPath === 'string' ? cause.context.inputPath : undefined;
  return new OrcaopsError(
    cause.code,
    cause.message,
    inputPath,
    selection.success
      ? {
          history_candidates: selection.data.map(({ project_id, artifact_id, command }) => ({
            id: artifact_id,
            project_id,
            command,
          })),
          ...(typeof cause.context.truncated === 'boolean'
            ? { truncated: cause.context.truncated }
            : {}),
        }
      : undefined
  );
}
