import type { EvaluatorRunPayload } from '@orcaops/evaluator-protocol';

export function classifyFinishPrePr(
  runs: readonly EvaluatorRunPayload[],
  blocking: boolean
):
  | { kind: 'blocked' }
  | { kind: 'clean' }
  | { kind: 'needs_attention'; runs: EvaluatorRunPayload[]; acceptance_allowed: boolean } {
  if (blocking) return { kind: 'blocked' };
  const attention = runs.filter(
    (run) =>
      run.severity === 'warn' &&
      (run.run_status === 'error' ||
        (run.run_status === 'completed' && run.verdict === 'violation'))
  );
  if (attention.length === 0) return { kind: 'clean' };
  return {
    kind: 'needs_attention',
    runs: attention,
    acceptance_allowed: !attention.some((run) => run.run_status === 'error'),
  };
}
