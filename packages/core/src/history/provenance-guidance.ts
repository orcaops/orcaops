import type { ProvenanceResolution } from './provenance-resolver.js';
import { TRIVIAL_LINE_MIN_BYTES } from '../attribution/line-match.js';
import { normalizeLineBody } from '../diff-fingerprint/adapter.js';

export interface ProvenanceCoverage {
  complete: boolean;
  unknown_associations: number;
  unqualified_indexes: number;
  captured_commit: boolean;
  imported_commit: boolean;
  seed_state: 'complete' | 'unknown' | 'pending';
  declined_area: string | null;
}

export function provenanceSeedGuidance(input: {
  resolution: ProvenanceResolution;
  coverage: ProvenanceCoverage;
  narrowed: boolean;
  candidatesOmitted: number;
}) {
  const { resolution, coverage } = input;
  const reasons: string[] = [];
  if (input.narrowed) reasons.push('QUERY_NARROWED');
  if (input.candidatesOmitted) reasons.push('CANDIDATES_OMITTED');
  if (!resolution.completeness.complete) reasons.push('PROVENANCE_INCOMPLETE');
  if (!coverage.complete) reasons.push('PROJECT_COVERAGE_INCOMPLETE');
  if (coverage.unknown_associations) reasons.push('UNKNOWN_WORKTREE_ASSOCIATION');
  if (coverage.unqualified_indexes) reasons.push('PROVENANCE_INDEX_INCOMPLETE');
  if (coverage.seed_state !== 'complete') reasons.push('SEED_COVERAGE_UNAVAILABLE');
  if (
    resolution.target.state !== 'available' ||
    resolution.target.line === null ||
    resolution.target.line_content === null ||
    resolution.target.blame.status !== 'committed' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(resolution.target.blame.sha ?? '')
  )
    reasons.push('TARGET_COVERAGE_UNAVAILABLE');
  if (
    resolution.target.line_content !== null &&
    normalizeLineBody(new TextEncoder().encode(resolution.target.line_content)).length <
      TRIVIAL_LINE_MIN_BYTES
  )
    reasons.push('TRIVIAL_TARGET');
  if (resolution.matches.length) reasons.push('RELATED_HISTORY_PRESENT');
  if (coverage.captured_commit || coverage.imported_commit) reasons.push('COMMIT_HISTORY_PRESENT');
  if (reasons.length) return { state: 'suppressed' as const, command: null, reasons };
  if (coverage.declined_area !== null)
    return {
      state: 'declined' as const,
      command: null,
      reasons: ['AREA_PREVIOUSLY_DECLINED'],
    };
  return {
    state: 'offer' as const,
    command: `orcaops seed --commit ${resolution.target.blame.sha}`,
    reasons: [],
  };
}
