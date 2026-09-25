import {
  type HistoryFilters,
  HistoryScopeError,
  type HistorySelector,
  normalizeHistoryFilters,
  validateHistorySelector,
} from '@orcaops/project-scope/history';

import { knowledgeBoundaryOption, renderKnowledgeBlock } from './artifact-knowledge.js';
import type { readDatabaseProvenance } from './database-history-provenance.js';
import { validateExportPath } from './inspection-output.js';
import { PROVENANCE_FOLLOW_UP } from './provenance-json.js';
import { historicalProvenanceTask } from './provenance-output.js';

export interface CanonicalWhyOptions {
  scope?: HistorySelector['scope'];
  project?: string;
  branch?: string;
  origin?: HistoryFilters['origin'];
  touching?: string;
  at?: string;
  /**
   * The knowledge boundary, which is a write sequence of the project history — deliberately not
   * `--at`, which is a commit-ish. Code time and knowledge time are different clocks, and one flag
   * for both would answer at a boundary nobody named.
   */
  atBoundary?: number;
  all?: boolean;
  details?: boolean;
  candidate?: string;
  anchor?: string;
  section?: string;
  decision?: number;
  sectionOffset?: number;
  sectionLimit?: number;
  audit?: boolean;
  output?: string;
  view?: 'rationale';
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
          'atBoundary',
          'all',
          'details',
          'candidate',
          'anchor',
          'section',
          'decision',
          'sectionOffset',
          'sectionLimit',
          'audit',
          'output',
          'view',
          'limit',
          'offset',
          'json',
        ].includes(key)
    )
  )
    throw new HistoryScopeError('INVALID_INPUT', 'Unsupported or retired why option');
  if (input.details !== undefined && typeof input.details !== 'boolean')
    throw new HistoryScopeError('INVALID_INPUT', 'Why details must be a boolean');
  if (input.view !== undefined && input.view !== 'rationale')
    throw new HistoryScopeError('INVALID_INPUT', 'Why view must be rationale');
  if (input.view && input.details)
    throw new HistoryScopeError('INVALID_INPUT', 'Choose --view rationale or --details, not both');
  if (input.audit !== undefined && typeof input.audit !== 'boolean')
    throw new HistoryScopeError('INVALID_INPUT', 'Why audit must be a boolean');
  if (input.details && !input.candidate && !input.audit)
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Details requires --candidate <returned-id> --anchor <inspection.anchor>; use --details --audit only for bounded multi-candidate comparison.'
    );
  if ((input.candidate || input.anchor || input.audit || input.output) && !input.details)
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Candidate inspection, audit, and export require --details'
    );
  if (
    input.candidate &&
    (input.audit || input.all || input.limit !== undefined || input.offset !== undefined)
  )
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Exact candidate inspection does not use audit or candidate pagination'
    );
  if (
    Boolean(input.candidate) !== Boolean(input.anchor) ||
    (input.anchor && !/^why1\.[a-f0-9]{64}$/.test(input.anchor))
  )
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Use the returned candidate id and inspection anchor together'
    );
  if (input.candidate && !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(input.candidate))
    throw new HistoryScopeError('INVALID_INPUT', 'Use the complete returned candidate id');
  if (input.output !== undefined && !input.candidate)
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Why export requires an exact candidate and anchor'
    );
  if (
    [input.section, input.decision, input.sectionOffset, input.sectionLimit].some(
      (value) => value !== undefined
    ) &&
    !input.candidate
  )
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Candidate sections require an exact candidate and anchor'
    );
  if (
    input.section !== undefined &&
    ![
      'index',
      'checkpoint',
      'checkpoint-metadata',
      'plan',
      'source-plan',
      'checkpoint-decisions',
      'plan-decisions',
      'uncertainty',
      'files',
    ].includes(input.section)
  )
    throw new HistoryScopeError('INVALID_INPUT', 'Unknown candidate section');
  for (const [name, value, minimum, maximum] of [
    ['decision', input.decision, 1, Number.MAX_SAFE_INTEGER],
    ['section-offset', input.sectionOffset, 0, Number.MAX_SAFE_INTEGER],
    ['section-limit', input.sectionLimit, 1, 20],
  ] as const)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum))
      throw new HistoryScopeError('INVALID_INPUT', `Invalid ${name}`);
  const pagedSection = [
    'index',
    'checkpoint-decisions',
    'plan-decisions',
    'uncertainty',
    'files',
  ].includes(input.section ?? '');
  if (
    (input.sectionOffset !== undefined || input.sectionLimit !== undefined) &&
    (!pagedSection || input.decision !== undefined || input.output)
  )
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Section pagination requires an index or array section without an exact decision or export'
    );
  if (
    input.decision !== undefined &&
    !['checkpoint-decisions', 'plan-decisions'].includes(input.section ?? '')
  )
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Select checkpoint-decisions or plan-decisions with --decision'
    );
  validateExportPath(input.output);
  if (!raw || /[\r\n\0]/.test(raw))
    throw new HistoryScopeError('INVALID_INPUT', 'Why requires a file or file:line');
  const suffix = /:([^:]*)$/.exec(raw);
  const file = suffix ? raw.slice(0, suffix.index) : raw;
  const line = suffix ? Number(suffix[1]) : undefined;
  if (!file || (suffix && (!/^\d+$/.test(suffix[1]) || !Number.isSafeInteger(line) || line! < 1)))
    throw new HistoryScopeError('INVALID_INPUT', 'Why requires a positive integer line');
  if (input.at !== undefined && (!input.at || input.at.startsWith('-') || /[\s\0]/.test(input.at)))
    throw new HistoryScopeError('INVALID_INPUT', 'Why requires a non-option revision');
  const boundary = knowledgeBoundaryOption(input.atBoundary);
  const selector = { scope: input.scope, projectId: input.project, branch: input.branch };
  validateHistorySelector({ selector, profile: 'git-history' });
  const filters = normalizeHistoryFilters({
    origin: input.origin,
    touching: input.touching,
    limit: input.limit ?? (input.all ? 1000 : 5),
    offset: input.offset,
  });
  return { file, line, selector, filters, boundary };
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
    const task = historicalProvenanceTask(row);
    if (task) {
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
  // What stands, beside what this line came out of. A provenance answer says which checkpoint
  // wrote a line; it said nothing at all about the rules that line is answerable to.
  if (result.knowledge) lines.push(...renderKnowledgeBlock(result.knowledge));
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
