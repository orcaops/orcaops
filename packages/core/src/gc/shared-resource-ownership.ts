import type { Checkpoint, Summary } from '@orcaops/storage';

export const SHARED_RESOURCE_OWNERSHIP_UNCERTAIN =
  'The current worktree and optional archive cannot establish complete shared-resource ownership. ' +
  'A sibling capture may never have reached the archive; missing or malformed owners remain protected.';

export function classifySnapshotRefs(
  refs: ReadonlyArray<{ ref: string; n: number }>,
  owner: { summary: Summary | null; checkpoints: readonly Checkpoint[] } | null
): { unknown: string[]; unmodeled: string[] } {
  if (owner === null) return { unknown: refs.map(({ ref }) => ref), unmodeled: [] };
  if (owner.summary === null) return { unknown: [], unmodeled: [] };
  const modeled = new Set(owner.checkpoints.map(({ n }) => n));
  return {
    unknown: [],
    unmodeled: refs.filter(({ n }) => !modeled.has(n)).map(({ ref }) => ref),
  };
}
