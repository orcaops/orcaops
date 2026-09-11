import { z } from 'zod';

import { HistoryScopeError } from '@orcaops/project-scope/history';

import { OrcaopsError } from '../io/errors.js';

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
