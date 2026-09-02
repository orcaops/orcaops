// Execution-order outline — the deterministic, pre-narrative structure. Each
// artifact IS a thread; its closed checkpoints, chronological, are the thread's
// checkpoints.
//
// Identity: a thread's key is its ARTIFACT's identity, and a checkpoint's key is
// a `checkpointKey` over its single checkpoint ref. Both are stable under the
// regeneration that actually happens in production — an agent closing another
// checkpoint — so reviewer state marked against them survives a re-floor. (The
// thread key used to hash the artifact's checkpoint SET, which re-minted the key
// on every close and silently orphaned the reviewer's coverage. See keys.ts.)

import {
  checkpointKey,
  checkpointRef,
  type FloorCheckpoint,
  type FloorThread,
  type SliceRef,
  threadKey,
} from '@orcaops/review-core';

import {
  orderedCheckpoints,
  orderThreads,
  type ReviewArtifact,
  type ReviewCheckpoint,
} from './model.js';

/** Coverage/citation links resolved before the outline so checkpoints carry them. */
export interface OutlineLinks {
  /** `checkpointRef(artifact, n)` → the slices the checkpoint owns. */
  sliceRefsByCp: Map<string, SliceRef[]>;
  /** `checkpointRef(artifact, n)` → citation ids from the checkpoint. */
  citationIdsByCp: Map<string, string[]>;
}

function checkpointLabel(cp: ReviewCheckpoint): string | null {
  if (!cp.summary) return null;
  const firstLine = cp.summary.split('\n')[0].trim();
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine || null;
}

function threadTitle(artifact: ReviewArtifact, multiThread: boolean): string {
  const base = artifact.label ?? artifact.task ?? null;
  if (base && base.length > 0) return base.length > 72 ? `${base.slice(0, 71)}…` : base;
  return multiThread ? `Thread ${artifact.id.slice(0, 8)}` : 'Execution';
}

export async function buildThreads(
  artifacts: readonly ReviewArtifact[],
  links: OutlineLinks
): Promise<FloorThread[]> {
  const ordered = orderThreads(artifacts);
  const multiThread = ordered.filter((a) => orderedCheckpoints(a).length > 0).length > 1;

  const threads: FloorThread[] = [];
  let threadOrder = 1;

  for (const artifact of ordered) {
    const cps = orderedCheckpoints(artifact);
    if (cps.length === 0) continue;

    const checkpoints: FloorCheckpoint[] = [];
    let cpOrder = 1;
    for (const cp of cps) {
      const ref = checkpointRef(artifact.id, cp.n);
      checkpoints.push({
        checkpointKey: await checkpointKey([ref]),
        order: cpOrder,
        checkpoint: { artifact: artifact.id, cp: cp.n, label: checkpointLabel(cp) },
        summary: cp.summary,
        members: [{ artifact: artifact.id, cp: cp.n }],
        sliceRefs: links.sliceRefsByCp.get(ref) ?? [],
        citationIds: links.citationIdsByCp.get(ref) ?? [],
      });
      cpOrder += 1;
    }

    threads.push({
      // The artifact id, not the checkpoint set — see the header.
      threadKey: await threadKey(artifact.id),
      order: threadOrder,
      title: threadTitle(artifact, multiThread),
      artifact: artifact.id,
      checkpoints,
    });
    threadOrder += 1;
  }

  return threads;
}
