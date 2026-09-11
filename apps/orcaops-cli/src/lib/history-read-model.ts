import {
  type ArtifactThread,
  type Plan,
  PlanSchema,
  reconstructArtifactThread,
} from '@orcaops/storage';

export function historyPlanRevisions(thread: ArtifactThread) {
  const plans = new Map<number, Plan>();
  for (const [index, event] of thread.events.entries()) {
    let plan: Plan | null = null;
    if (event.record.type === 'plan_captured' || event.record.type === 'plan_revised')
      plan = PlanSchema.parse({
        ...(event.payload as Record<string, unknown>),
        source_event_id: event.record.event_id,
      });
    else if (event.record.type === 'git_import_enriched')
      plan = reconstructArtifactThread(thread.artifactId, thread.events.slice(0, index + 1)).plan;
    if (plan) plans.set(plan.revision_n, plan);
  }
  return [...plans.values()].sort((a, b) => a.revision_n - b.revision_n);
}
