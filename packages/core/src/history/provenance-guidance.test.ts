import { describe, expect, it } from 'vitest';

import { type ProvenanceCoverage, provenanceSeedGuidance } from './provenance-guidance.js';
import type { ProvenanceResolution } from './provenance-resolver.js';

function input() {
  const resolution: ProvenanceResolution = {
    target: {
      selection: 'current',
      requested_ref: null,
      commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      committed_blob_sha: 'c'.repeat(40),
      content_hash: 'd'.repeat(64),
      file: 'src/code.ts',
      line: 1,
      content: 'const original = true;\n',
      line_content: 'const original = true;',
      state: 'available',
      dirty: false,
      blame: { status: 'committed', sha: 'a'.repeat(40) },
      issues: [],
    },
    best: null,
    matches: [],
    conclusion: 'none',
    uncertainty: [],
    source_versions: [],
    completeness: { complete: true, issues: [] },
  };
  const coverage: ProvenanceCoverage = {
    complete: true,
    unknown_associations: 0,
    unqualified_indexes: 0,
    captured_commit: false,
    imported_commit: false,
    seed_state: 'complete',
    declined_area: null,
  };
  return { resolution, coverage, narrowed: false, candidatesOmitted: 0 };
}
describe('provenance seed guidance', () => {
  it('offers only the verified selected commit after complete project coverage', () => {
    expect(provenanceSeedGuidance(input())).toEqual({
      state: 'offer',
      command: `orcaops seed --commit ${'a'.repeat(40)}`,
      reasons: [],
    });
  });
  it.each([
    [
      'QUERY_NARROWED',
      (value: ReturnType<typeof input>) => {
        value.narrowed = true;
      },
    ],
    [
      'CANDIDATES_OMITTED',
      (value: ReturnType<typeof input>) => {
        value.candidatesOmitted = 1;
      },
    ],
    [
      'PROVENANCE_INCOMPLETE',
      (value: ReturnType<typeof input>) => {
        value.resolution.completeness.complete = false;
      },
    ],
    [
      'PROJECT_COVERAGE_INCOMPLETE',
      (value: ReturnType<typeof input>) => {
        value.coverage.complete = false;
      },
    ],
    [
      'UNKNOWN_WORKTREE_ASSOCIATION',
      (value: ReturnType<typeof input>) => {
        value.coverage.unknown_associations = 1;
      },
    ],
    [
      'PROVENANCE_INDEX_INCOMPLETE',
      (value: ReturnType<typeof input>) => {
        value.coverage.unqualified_indexes = 1;
      },
    ],
    [
      'SEED_COVERAGE_UNAVAILABLE',
      (value: ReturnType<typeof input>) => {
        value.coverage.seed_state = 'pending';
      },
    ],
    [
      'COMMIT_HISTORY_PRESENT',
      (value: ReturnType<typeof input>) => {
        value.coverage.captured_commit = true;
      },
    ],
    [
      'COMMIT_HISTORY_PRESENT',
      (value: ReturnType<typeof input>) => {
        value.coverage.imported_commit = true;
      },
    ],
  ])('suppresses guidance for %s', (reason, change) => {
    const value = input();
    change(value);
    expect(provenanceSeedGuidance(value)).toMatchObject({
      state: 'suppressed',
      command: null,
      reasons: expect.arrayContaining([reason]),
    });
  });
  it('does not offer unavailable, uncommitted, whole-file or trivial targets', () => {
    for (const patch of [
      { state: 'deleted' as const },
      { line: null },
      { line_content: '}' },
      { blame: { status: 'uncommitted' as const, sha: null } },
      { blame: { status: 'committed' as const, sha: '-invalid' } },
    ]) {
      const value = input();
      value.resolution.target = { ...value.resolution.target, ...patch };
      expect(provenanceSeedGuidance(value).state).toBe('suppressed');
    }
  });
  it('honors a known declined area independently of its original timestamp', () => {
    const value = input();
    value.coverage.declined_area = 'src';
    expect(provenanceSeedGuidance(value)).toEqual({
      state: 'declined',
      command: null,
      reasons: ['AREA_PREVIOUSLY_DECLINED'],
    });
  });
});
