import { computeUnresolvedBlocks } from '@orcaops/core';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';

/**
 * The evaluator-run fields block-target resolution reads. A superset of what
 * `computeUnresolvedBlocks` keys on (severity / run_status / verdict / phase /
 * disposition), so `listEvaluatorRuns` rows flow straight through it.
 */
export interface RunRow {
  run_id: string;
  evaluator_ref: string;
  phase: string;
  severity: string;
  run_status: string;
  verdict: string | null;
  disposition: 'unresolved' | 'acknowledged' | 'dismissed' | 'policy-excepted' | null;
}

export interface TargetRun {
  run_id: string;
  evaluator_ref: string;
}

/**
 * Resolve the evaluator run a `block acknowledge` / `block dismiss` targets:
 * an explicit `--run-id`, else the current block for the ref.
 *
 * Resolution goes through `computeUnresolvedBlocks` — the SAME latest-per-ref
 * supersession status/next_actions use — so a violation a later passing run
 * already superseded can't be targeted, and `--run-id` must name the CURRENT
 * unresolved block, not merely a historically-unresolved row (the raw-row
 * stale-target hazard, the block-command analogue of the status filter).
 *
 * Shared by acknowledge and dismiss — `verb` only varies the
 * "nothing to <verb>" message.
 */
export function resolveTargetRun(
  ctx: { store: { store: { listEvaluatorRuns(id: string): readonly RunRow[] } } },
  opts: { artifact: string; evaluator: string; runId?: string },
  evaluatorRef: string,
  verb: 'acknowledge' | 'dismiss'
): TargetRun {
  const rows = ctx.store.store.listEvaluatorRuns(opts.artifact);
  // Current block set, latest-per-ref (a later pass / disposition supersedes an
  // earlier violation) — the single supersession used across the lifecycle.
  const current = computeUnresolvedBlocks(rows);

  if (opts.runId !== undefined) {
    const row = rows.find((r) => r.run_id === opts.runId);
    if (!row) {
      throw new OrcaopsError(
        ErrorCodes.NO_BLOCKING_RUN,
        `Run "${opts.runId}" not found on artifact "${opts.artifact}".`,
        'run_id'
      );
    }
    if (row.evaluator_ref !== evaluatorRef) {
      throw new OrcaopsError(
        ErrorCodes.NO_BLOCKING_RUN,
        `Run "${opts.runId}" belongs to evaluator "${row.evaluator_ref}", ` +
          `not "${evaluatorRef}".`,
        'run_id'
      );
    }
    const currentBlock = current.find((b) => b.run_id === opts.runId);
    if (currentBlock?.kind === 'error') {
      throw new OrcaopsError(
        ErrorCodes.NO_BLOCKING_RUN,
        `Run "${opts.runId}" is an evaluator error; rerun its ${currentBlock.phase} phase instead of trying to ${verb} it.`,
        'run_id'
      );
    }
    if (row.disposition !== 'unresolved') {
      throw new OrcaopsError(
        ErrorCodes.NO_BLOCKING_RUN,
        `Run "${opts.runId}" already has disposition "${row.disposition ?? 'null'}"; ` +
          `nothing to ${verb}.`,
        'run_id'
      );
    }
    // Historically unresolved is not enough — the run must be the CURRENT block
    // (a later run for the same ref can supersede it).
    if (!current.some((b) => b.run_id === opts.runId)) {
      throw new OrcaopsError(
        ErrorCodes.NO_BLOCKING_RUN,
        `Run "${opts.runId}" is not the current unresolved block for "${evaluatorRef}" — ` +
          `a later run for this evaluator superseded it; nothing to ${verb}.`,
        'run_id'
      );
    }
    return { run_id: row.run_id, evaluator_ref: row.evaluator_ref };
  }

  const block = current.find((b) => b.evaluator_ref === evaluatorRef);
  if (!block) {
    throw new OrcaopsError(
      ErrorCodes.NO_BLOCKING_RUN,
      `No unresolved blocking run found for evaluator "${evaluatorRef}" on ` +
        `artifact "${opts.artifact}". Either the evaluator hasn't violated, or its ` +
        `block was already resolved (a later passing run can supersede an earlier violation).`,
      'evaluator'
    );
  }
  if (block.kind === 'error') {
    throw new OrcaopsError(
      ErrorCodes.NO_BLOCKING_RUN,
      `The current blocking run for "${evaluatorRef}" is an evaluator error; rerun its ${block.phase} phase instead of trying to ${verb} it.`,
      'evaluator'
    );
  }
  return { run_id: block.run_id, evaluator_ref: block.evaluator_ref };
}
