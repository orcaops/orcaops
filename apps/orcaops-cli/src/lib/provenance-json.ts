import type { readDatabaseProvenance } from './database-history-provenance.js';
import {
  compactProvenanceCandidate,
  compactProvenanceIssues,
  compactSourceVersions,
  PROVENANCE_PREVIEW_CHARACTERS,
  PROVENANCE_PREVIEW_ITEMS,
} from './provenance-output.js';

export const PROVENANCE_FOLLOW_UP = [
  'Explain a target: orcaops why <file> --json --view rationale --limit 5.',
  'Inspect one candidate: repeat why with --details --candidate <returned-id> --anchor <inspection.anchor> --json, preserving target and scope.',
  'Only for missing broader chronology: orcaops show <artifact_id> --project <project_id> --json.',
  'show inspects artifact history; it does not reproduce an exact historical candidate view.',
] as const;

export function projectProvenanceJson(
  result: Awaited<ReturnType<typeof readDatabaseProvenance>>,
  details: boolean
) {
  const compact = (row: NonNullable<typeof result.best>, index: number) =>
    compactProvenanceCandidate(row, result.target.file, result.target_facts.results[index]);
  const returned = result.results.length;
  return {
    schema_version: 4 as const,
    representation: details ? ('details' as const) : ('compact' as const),
    scope: result.scope,
    code_revision: result.code_revision,
    target: result.target,
    filters: result.filters,
    conclusion: result.conclusion,
    best:
      details || result.best === null
        ? result.best
        : compactProvenanceCandidate(
            result.best,
            result.target.file,
            result.target_facts.best ?? undefined
          ),
    results: details ? result.results : result.results.map(compact),
    completeness: {
      complete: result.completeness.complete,
      issues: details
        ? result.completeness.issues
        : compactProvenanceIssues(result.completeness.issues),
    },
    pagination: {
      offset: result.pagination.offset,
      limit: result.pagination.limit,
      total: result.pagination.total,
      total_basis: 'evaluated_matches' as const,
      returned,
      has_more: result.pagination.has_more,
      next_offset: result.pagination.has_more ? result.pagination.offset + returned : null,
    },
    candidate_selection: result.candidate_selection,
    knowledge: result.knowledge,
    project_coverage: {
      ...result.project_coverage,
      issues: details
        ? result.project_coverage.issues
        : compactProvenanceIssues(result.project_coverage.issues),
    },
    source_versions: details
      ? result.source_versions
      : compactSourceVersions(result.source_versions),
    integrity: result.integrity,
    uncertainty: result.uncertainty,
    seed_guidance: result.seed_guidance,
    detail_omissions: {
      results: !details,
      best: !details && result.best !== null,
      shared_diagnostics: !details,
      source_versions: !details,
      compact_fields: [
        'plan_support.plan',
        'source_plan.content',
        'checkpoint',
        'enrichment.plan',
        'enrichment.checkpoint_summary',
      ],
      preview_limits: {
        items: PROVENANCE_PREVIEW_ITEMS,
        characters: PROVENANCE_PREVIEW_CHARACTERS,
      },
    },
    follow_up: PROVENANCE_FOLLOW_UP,
  };
}
