import { type CaptureSummaryInput, normalizeAcceptedWarningsForReplay } from '@orcaops/storage';

/**
 * Only agent-supplied fields participate in summary replay equality: `ts` and
 * `head_sha` are runtime-supplied (and inherited on a supersede), so a retried call
 * with the same intent replays instead of conflicting.
 */
export function summaryReplayPayload(input: CaptureSummaryInput, artifactId: string) {
  return {
    artifact_id: artifactId,
    outcome: input.outcome,
    tests_written: input.tests_written,
    tests_run: input.tests_run,
    open_items: input.open_items,
    deferred_decisions: input.deferred_decisions,
    accepted_warnings: normalizeAcceptedWarningsForReplay(input.accepted_warnings),
  };
}

export function extractSummaryReplayShape(priorPayload: unknown): unknown {
  if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
  const p = priorPayload as Record<string, unknown>;
  return {
    artifact_id: p.artifact_id,
    outcome: p.outcome,
    tests_written: p.tests_written,
    tests_run: p.tests_run,
    open_items: p.open_items,
    deferred_decisions: p.deferred_decisions,
    accepted_warnings: normalizeAcceptedWarningsForReplay(p.accepted_warnings),
  };
}
