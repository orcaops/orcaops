// What admission retains on a job so dispatch can re-read the right things before a provider is
// constructed. One definition, beside the writer that records it, because the worker that reads it
// back lives in another package and two copies of this shape would drift apart silently.
//
// The origin is a path and not an identity because configuration resolution is per checkout: §6
// requires the file that governs the worktree the capture was made in, and a deleted origin to
// pause its job rather than borrow another worktree's settings. Nothing in this store maps a
// registered worktree id back to a directory, so the directory is recorded at admission, where it
// is known.
//
// The artifact is recorded because a capture event is reachable only through the artifact that
// holds it, and scanning every artifact for one event id is not a lookup.
import path from 'node:path';
import { z } from 'zod';

const absoluteDirectory = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value, {
    message: 'must be an absolute, normalized directory path',
  });

export const ProcessingDispatchContextSchema = z
  .object({
    artifact_id: z.string().min(1),
    origin: z.object({ worktree_root: absoluteDirectory }).strict(),
  })
  .strict();
export type ProcessingDispatchContext = z.infer<typeof ProcessingDispatchContextSchema>;

export function processingDispatchContext(input: {
  artifactId: string;
  worktreeRoot: string;
}): ProcessingDispatchContext {
  return ProcessingDispatchContextSchema.parse({
    artifact_id: input.artifactId,
    origin: { worktree_root: input.worktreeRoot },
  });
}
