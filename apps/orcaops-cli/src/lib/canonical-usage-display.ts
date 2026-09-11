import {
  estimateArtifactUsage,
  USAGE_SCALARS,
  type UsageAccountingResult,
  usageModelKey,
  type UsageScalars,
} from '@orcaops/storage/history/usage-accounting';

export interface UsageScopeIssue {
  code: string;
  project_id: string | null;
  message: string;
}
export interface UsageDisplay {
  accounting: UsageAccountingResult;
  model_totals: Array<
    UsageScalars & { model: string; speed?: string; service_tier?: string; inference_geo?: string }
  > | null;
  estimates: Array<{
    project_id: string;
    artifact_id: string;
    estimate: ReturnType<typeof estimateArtifactUsage>;
  }>;
}
export function aggregateUsageModels(
  accounting: UsageAccountingResult
): UsageDisplay['model_totals'] {
  const models = new Map<string, NonNullable<UsageDisplay['model_totals']>[number]>();
  if (accounting.status === 'exact')
    for (const session of accounting.sessions)
      for (const entry of session.model_breakdown) {
        const key = usageModelKey(entry);
        const total = models.get(key) ?? {
          model: entry.model,
          ...(entry.speed === undefined ? {} : { speed: entry.speed }),
          ...(entry.service_tier === undefined ? {} : { service_tier: entry.service_tier }),
          ...(entry.inference_geo === undefined ? {} : { inference_geo: entry.inference_geo }),
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        };
        for (const field of USAGE_SCALARS) total[field] += entry.cumulative[field];
        models.set(key, total);
      }
  return accounting.status === 'exact'
    ? [...models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry)
    : null;
}

function tokens(value: UsageScalars): string {
  return `in ${value.input_tokens} · out ${value.output_tokens} · cache-write ${value.cache_creation_input_tokens} · cache-read ${value.cache_read_input_tokens}`;
}
export function renderCanonicalUsageLines(
  view: Pick<UsageDisplay, 'accounting' | 'estimates'>
): string[] {
  const lines = [`Agent usage: ${view.accounting.status}`];
  if (view.accounting.totals)
    lines.push(`Exact selected session totals: ${tokens(view.accounting.totals)}`);
  else if (view.accounting.known_exact_totals)
    lines.push(`Known complete sessions only: ${tokens(view.accounting.known_exact_totals)}`);
  for (const session of view.accounting.sessions) {
    lines.push(
      `${session.agent}/${session.session_id}: ${session.status === 'exact' ? `exact ${tokens(session.totals!)}` : 'incomplete'}`
    );
    for (const entry of session.model_breakdown)
      lines.push(
        `  ${entry.model}${entry.speed ? ` speed=${entry.speed}` : ''}${entry.service_tier ? ` tier=${entry.service_tier}` : ''}${entry.inference_geo ? ` geo=${entry.inference_geo}` : ''}: ${tokens(entry.cumulative)}`
      );
    if (session.dimensions)
      lines.push(`  source dimensions: ${JSON.stringify(session.dimensions)}`);
    lines.push(...session.reasons.map((reason) => `  ${reason}`));
  }
  for (const estimate of view.estimates)
    lines.push(
      `Artifact ${estimate.artifact_id} estimate (not additive): ${estimate.estimate.totals ? tokens(estimate.estimate.totals) : 'unavailable'}`
    );
  lines.push(...view.accounting.reasons);
  lines.push('USD: priced by the cloud');
  return lines;
}
