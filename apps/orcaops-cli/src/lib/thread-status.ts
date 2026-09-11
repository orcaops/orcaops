import { computeUnresolvedBlocks } from '@orcaops/core';

export type ThreadStateName =
  | 'plan'
  | 'eval-plan'
  | 'checkpoint'
  | 'eval-cp'
  | 'eval-pr'
  | 'summary'
  | 'digest';

export type ThreadEntry =
  | { status: 'done'; [k: string]: unknown }
  | { status: 'ready'; blocked_by: ThreadStateName[] }
  | { status: 'blocked'; blocked_by: ThreadStateName[] };

export interface ArtifactThreadStatus {
  id: string;
  task: string;
  branch: string;
  status: 'active' | 'complete';
  started_at: string;
  completed_at: string | null;
  thread: Record<ThreadStateName, ThreadEntry>;
  blocking_evaluators: Array<{
    evaluator_ref: string;
    severity: string;
    run_id: string;
    failure_kind: 'violation' | 'error';
  }>;
  capture_health: 'ok' | 'no-summary' | 'incomplete-checkpoints';
}

export function deriveThreadStatus(input: {
  artifact: Pick<
    ArtifactThreadStatus,
    'task' | 'branch' | 'status' | 'started_at' | 'completed_at'
  > & { id: string };
  planStepCount: number;
  checkpoints: readonly { n: number; status: string }[];
  hasSummary: boolean;
  lifecycles: readonly { fires_at: string; cp_n: number | null }[];
  evaluatorRuns: Parameters<typeof computeUnresolvedBlocks>[0];
}): ArtifactThreadStatus {
  const { artifact, checkpoints, lifecycles } = input;
  const summaryRow = input.hasSummary;
  const hasPostPlan = lifecycles.some((l) => l.fires_at === 'post-plan');
  const hasPrePr = lifecycles.some((l) => l.fires_at === 'pre-pr');

  // eval-cp is "done" once every existing checkpoint has a
  // checkpoint-close lifecycle entry. If no checkpoints yet, treat as
  // 'ready'.
  const cpLifecycles = new Set(
    lifecycles.filter((l) => l.fires_at === 'checkpoint-close').map((l) => l.cp_n)
  );
  // Only closed cps need to have fired the post-close lifecycle.
  const closedCheckpoints = checkpoints.filter((cp) => cp.status === 'closed');
  const allCheckpointsEvaluated =
    closedCheckpoints.length > 0 && closedCheckpoints.every((cp) => cpLifecycles.has(cp.n));

  const openCheckpoints = checkpoints.filter((cp) => cp.status === 'open');

  // Currently-blocking evaluators, via the SAME supersession `next_actions`
  // uses (computeUnresolvedBlocks): the latest completed block-severity run per
  // ref wins, so a later passing run clears a stale violation. A raw
  // `disposition === 'unresolved'` filter would have no supersession and could
  // disagree with next_actions in the same `status --json` payload. Shape
  // is preserved (`severity` is always 'block' here, by construction).
  const unresolvedBlocks = computeUnresolvedBlocks(input.evaluatorRuns);
  const blockingEvaluators = unresolvedBlocks.map((b) => ({
    evaluator_ref: b.evaluator_ref,
    severity: 'block' as const,
    run_id: b.run_id,
    failure_kind: b.kind,
  }));

  // A block phase maps to the thread node that "owns" it, for summary's
  // blocked_by below: post-plan(-revision) → eval-plan; checkpoint-close →
  // eval-cp; pre-pr → eval-pr.
  const blockPhaseToNode: Record<string, ThreadStateName> = {
    'post-plan': 'eval-plan',
    'post-plan-revision': 'eval-plan',
    'checkpoint-close': 'eval-cp',
    'pre-pr': 'eval-pr',
  };

  const thread: Record<ThreadStateName, ThreadEntry> = {
    plan: input.planStepCount > 0 ? { status: 'done' } : { status: 'ready', blocked_by: [] },
    'eval-plan': hasPostPlan ? { status: 'done' } : { status: 'ready', blocked_by: [] },
    checkpoint:
      // Only closed cps count toward checkpoint progress. Open cps
      // are in-flight and abandoned cps explicitly didn't claim
      // work — neither moves the artifact forward. Same filter the
      // eval-readiness check (allCheckpointsEvaluated) uses above.
      closedCheckpoints.length > 0
        ? {
            status: 'done',
            count: closedCheckpoints.length,
            latest_n: closedCheckpoints[closedCheckpoints.length - 1].n,
          }
        : { status: 'ready', blocked_by: [] },
    'eval-cp': allCheckpointsEvaluated
      ? { status: 'done' }
      : { status: 'ready', blocked_by: closedCheckpoints.length === 0 ? ['checkpoint'] : [] },
    'eval-pr': hasPrePr ? { status: 'done' } : { status: 'ready', blocked_by: [] },
    // capture summary's REAL gate (store.writeSummary): no open checkpoint +
    // no unresolved block. pre-pr is NOT a gate — a never-run pre-pr must not
    // block summary. An unresolved pre-pr-phase BLOCK does block (and
    // maps to eval-pr below); a missing pre-pr does not.
    summary: summaryRow
      ? { status: 'done' }
      : openCheckpoints.length === 0 && unresolvedBlocks.length === 0
        ? { status: 'ready', blocked_by: [] }
        : {
            status: 'blocked',
            blocked_by: [
              ...(openCheckpoints.length > 0 ? (['checkpoint'] as ThreadStateName[]) : []),
              ...Array.from(
                new Set(unresolvedBlocks.map((b) => blockPhaseToNode[b.phase] ?? 'eval-cp'))
              ),
            ],
          },
    digest: summaryRow
      ? { status: 'ready', blocked_by: [] }
      : { status: 'blocked', blocked_by: ['summary'] },
  };

  let captureHealth: ArtifactThreadStatus['capture_health'] = 'ok';
  if (artifact.status === 'complete' && !summaryRow) captureHealth = 'no-summary';
  else if (closedCheckpoints.length > 0 && !allCheckpointsEvaluated)
    captureHealth = 'incomplete-checkpoints';

  return {
    id: artifact.id,
    task: artifact.task,
    branch: artifact.branch,
    status: artifact.status,
    started_at: artifact.started_at,
    completed_at: artifact.completed_at,
    thread,
    blocking_evaluators: blockingEvaluators,
    capture_health: captureHealth,
  };
}
