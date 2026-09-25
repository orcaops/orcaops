// What continuing knowledge bears on one thread, for the detail pane.
//
// Watch reads it through the project database it already opens and shapes it with the same core
// function every other read surface uses, so the pane cannot report a different governing revision
// from `show` or the digest. It decides no standing of its own and writes nothing.
//
// It is NOT cached with the thread detail. A detail is cached against the artifact's revision
// token, and a requirement adopted or withdrawn elsewhere moves the project's write sequence while
// leaving every artifact revision alone — a pane holding a cached block would go on showing a rule
// that no longer stands.
import { knowledgeBlock, type KnowledgeBlock } from '@orcaops/core';
import {
  type ProjectReadView,
  projectTaskKnowledgeContext,
} from '@orcaops/storage/history/database';

/** One thread's block, as the read returns it. A list, because a database read carries JSON. */
export interface ThreadKnowledge {
  artifactId: string;
  block: KnowledgeBlock;
}

/**
 * Every selected thread's block in ONE snapshot, at the boundary this store is committed through.
 * One read for the tick keeps every pane of a refresh on one observation of the store.
 *
 * The shaping happens inside the read because only the block crosses the database boundary: the
 * composer's whole answer carries the resolver's working for every identity, and copying that out
 * per thread per tick would cost far more than the lines a pane prints.
 *
 * The processing coverage is null: Watch loads no configuration and evaluates no consent grant,
 * so it cannot derive the claim, and a claim it has not earned is worse than none. The block's
 * coverage statement says exactly that, and the pane prints it — so an answer with no entries
 * reads as what the coverage says, never as "this thread is answerable to nothing".
 */
export function readThreadsKnowledge(
  view: ProjectReadView,
  projectId: string,
  artifactIds: readonly string[]
): ThreadKnowledge[] {
  return artifactIds.map((artifactId) => {
    const task = projectTaskKnowledgeContext(view, {
      projectId,
      artifactId,
      boundary: 'now',
      plan: { kind: 'latest_visible' },
    });
    return {
      artifactId,
      block: knowledgeBlock(task.knowledge, {
        plan:
          task.selectedPlan === null
            ? null
            : { artifactId, planEventId: task.selectedPlan.planEventId },
      }),
    };
  });
}
