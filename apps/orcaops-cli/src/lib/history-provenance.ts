import {
  type HistoryFilters,
  HistoryScopeError,
  type HistorySelector,
  normalizeHistoryFilters,
  validateHistorySelector,
} from '@orcaops/project-scope/history';

import type { readDatabaseProvenance } from './database-history-provenance.js';
import { PROVENANCE_FOLLOW_UP } from './provenance-json.js';

export interface CanonicalWhyOptions {
  scope?: HistorySelector['scope'];
  project?: string;
  branch?: string;
  origin?: HistoryFilters['origin'];
  touching?: string;
  at?: string;
  all?: boolean;
  details?: boolean;
  limit?: number;
  offset?: number;
  json?: boolean;
}

export function validateCanonicalWhy(raw: string, input: CanonicalWhyOptions = {}) {
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'scope',
          'project',
          'branch',
          'origin',
          'touching',
          'at',
          'all',
          'details',
          'limit',
          'offset',
          'json',
        ].includes(key)
    )
  )
    throw new HistoryScopeError('INVALID_INPUT', 'Unsupported or retired why option');
  if (input.details !== undefined && typeof input.details !== 'boolean')
    throw new HistoryScopeError('INVALID_INPUT', 'Why details must be a boolean');
  if (!raw || /[\r\n\0]/.test(raw))
    throw new HistoryScopeError('INVALID_INPUT', 'Why requires a file or file:line');
  const suffix = /:([^:]*)$/.exec(raw);
  const file = suffix ? raw.slice(0, suffix.index) : raw;
  const line = suffix ? Number(suffix[1]) : undefined;
  if (!file || (suffix && (!/^\d+$/.test(suffix[1]) || !Number.isSafeInteger(line) || line! < 1)))
    throw new HistoryScopeError('INVALID_INPUT', 'Why requires a positive integer line');
  if (input.at !== undefined && (!input.at || input.at.startsWith('-') || /[\s\0]/.test(input.at)))
    throw new HistoryScopeError('INVALID_INPUT', 'Why requires a non-option revision');
  const selector = { scope: input.scope, projectId: input.project, branch: input.branch };
  validateHistorySelector({ selector, profile: 'git-history' });
  const filters = normalizeHistoryFilters({
    origin: input.origin,
    touching: input.touching,
    limit: input.limit ?? (input.all ? 1000 : 25),
    offset: input.offset,
  });
  return { file, line, selector, filters };
}

export function formatCanonicalWhy(
  result: Awaited<ReturnType<typeof readDatabaseProvenance>>,
  all = false
) {
  const rows = all ? result.results : result.best ? [result.best] : result.results;
  const lines = [
    `${result.target.file}${result.target.line === null ? '' : `:${result.target.line}`} — ${result.conclusion}`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.project_id}/${row.artifact_id}${row.checkpoint ? ` checkpoint ${row.checkpoint.n}` : ' plan'}: ${row.confidence}; ${row.reachability}`
    );
    if (row.origin === 'imported') lines.push('  Origin: imported from git history (synthesized)');
    const plan = row.plan_support.plan;
    if (plan) {
      const members = plan.origin?.member_shas?.length;
      const task =
        row.origin === 'imported' && !plan.origin?.enriched_at && members
          ? `${plan.task.split('\n')[0]} … (${members} commits)`
          : plan.task;
      lines.push(row.origin === 'imported' ? `  Task: ${task}` : `  ${task}`);
    }
    if (row.checkpoint) lines.push(`  ${row.checkpoint.summary}`);
    for (const reason of row.reasons) lines.push(`  ${reason}`);
    for (const decision of row.plan_support.plan?.decisions ?? [])
      lines.push(`  ${decision.decision}: ${decision.reason}`);
    for (const decision of row.checkpoint?.decisions ?? [])
      lines.push(`  ${decision.decision}: ${decision.reason}`);
    for (const uncertainty of row.checkpoint?.uncertainty ?? [])
      lines.push(`  Uncertainty: ${uncertainty}`);
    if (row.enrichment)
      lines.push(
        `  Later enrichment: ${row.enrichment.checkpoint_summary ?? row.enrichment.plan?.task ?? 'Supplemental context available'}`
      );
  }
  for (const message of result.uncertainty) lines.push(message);
  if (!result.completeness.complete) lines.push('Provenance evidence is incomplete.');
  if (!result.candidate_selection.complete)
    lines.push(`${result.candidate_selection.omitted} candidate artifacts omitted.`);
  if (result.candidate_selection.support_omitted)
    lines.push(`${result.candidate_selection.support_omitted} overlap support artifacts omitted.`);
  const declinedArea = result.project_coverage.declined_area;
  if (declinedArea !== null) {
    const argument = "'" + declinedArea.replaceAll("'", "'\\''") + "'";
    lines.push(
      `Git history imports for ${declinedArea} were declined. ` +
        `Allow future suggestions with: orcaops seed status --offer-again ${argument}`
    );
  }
  if (result.seed_guidance.command) lines.push(result.seed_guidance.command);
  lines.push(...PROVENANCE_FOLLOW_UP);
  if (result.pagination.has_more)
    lines.push(
      `More evaluated results: repeat with --all --offset ${result.pagination.offset + result.results.length} --limit ${result.pagination.limit}`
    );
  return lines.join('\n');
}
