import { blockingEvaluatorFailureKind } from '@orcaops/storage';

import type { BlockPhase, UnresolvedBlock } from './next-actions.js';

/** Structural view of storage's EvaluatorRunRow — the fields the block filter reads. */
interface EvaluatorRunLike {
  evaluator_ref: string;
  run_id: string;
  phase: string;
  severity: string;
  run_status: string;
  verdict: string | null;
  disposition: string | null;
  checkpoint_n?: number | null;
}

/**
 * Derive the currently-open lifecycle blockers from evaluator-run rows,
 * mirroring storage's ordered supersession (`computeOpenBlocksByRef` in
 * rebuilders.ts): for each `evaluator_ref`, only the latest decisive
 * block-severity run decides state. A later pass/info run clears the block,
 * a newer violation or error supersedes the older one, and a disposition on
 * the latest violation (reflected in its materialized `disposition` column)
 * clears it. Errors can only be cleared by a later successful run.
 *
 * `listEvaluatorRuns` returns rows in ascending (source_event_index,
 * local_kind_rank, local_index) order, so the last decisive block run seen
 * per ref is the current one. Filtering raw rows on `disposition ===
 * 'unresolved'` independently would resurface a stale
 * violation that a later passing `run-evaluators` already cleared — keeping
 * status/resume stuck on ack/dismiss after the artifact is no longer blocked.
 *
 * `checkpoint-open` rows are excluded — open-phase blocks are pre-append soft
 * rejections with no persisted run to ack/dismiss (defensive; they don't
 * reach this projection).
 */
export function computeUnresolvedBlocks(
  runRows: readonly EvaluatorRunLike[],
  acknowledgeByRef?: (ref: string) => boolean
): UnresolvedBlock[] {
  // Last decisive block-severity run wins per ref (rows are ascending).
  // Errors set a non-dispositionable blocker; completed pass/info clears;
  // skipped runs leave the current state unchanged.
  const latestByRef = new Map<string, EvaluatorRunLike>();
  for (const r of runRows) {
    if (r.severity === 'block' && (r.run_status === 'completed' || r.run_status === 'error')) {
      latestByRef.set(r.evaluator_ref, r);
    }
  }

  const blocks: UnresolvedBlock[] = [];
  for (const r of latestByRef.values()) {
    if (r.phase === 'checkpoint-open') continue;
    const kind = blockingEvaluatorFailureKind(r);
    if (kind === 'error' || (kind === 'violation' && r.disposition === 'unresolved')) {
      blocks.push({
        kind,
        evaluator_ref: r.evaluator_ref,
        run_id: r.run_id,
        phase: r.phase as BlockPhase,
        ...(r.checkpoint_n == null ? {} : { checkpoint_n: r.checkpoint_n }),
        acknowledge_enabled:
          kind === 'violation' && acknowledgeByRef ? acknowledgeByRef(r.evaluator_ref) : false,
      });
    }
  }
  return blocks;
}
