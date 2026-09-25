import {
  type ProcessingDispatchContext,
  ProcessingDispatchContextSchema,
} from '@orcaops/storage/history/database';

/**
 * Reading back what admission retained on a job. The shape itself lives beside
 * the writer in storage, so the worker and the capture settlement cannot drift
 * apart about it.
 */

export type { ProcessingDispatchContext } from '@orcaops/storage/history/database';

export type DispatchContextRead =
  | { ok: true; context: ProcessingDispatchContext }
  | { ok: false; detail: string };

/**
 * The admission record as the job retains it, which is opaque JSON here.
 * A job that carries no usable context is never dispatched on a guess.
 */
export function readDispatchContext(admission: unknown): DispatchContextRead {
  const context =
    admission !== null && typeof admission === 'object' && !Array.isArray(admission)
      ? (admission as Record<string, unknown>).context
      : undefined;
  const parsed = ProcessingDispatchContextSchema.safeParse(context);
  if (parsed.success) return { ok: true, context: parsed.data };
  return {
    ok: false,
    detail:
      'The job does not retain the artifact and originating worktree dispatch needs. ' +
      'It cannot be processed without borrowing another checkout’s configuration, which is ' +
      'never done.',
  };
}
