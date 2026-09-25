import { describe, expect, it } from 'vitest';

import {
  type AssessedBasis,
  assessmentRelevance,
  type AssessmentRelevanceQuestion,
  type DimensionMatch,
  priorReportStanding,
  type RelevanceDimension,
} from './relevance.js';

const REVISION = {
  kind: 'requirement' as const,
  entity_id: 'requirement-offline',
  revision_id: 'revision-1',
};

const basis = (change: Partial<AssessedBasis> = {}): AssessedBasis => ({
  assessment_id: 'assessment-1',
  expectation: REVISION,
  conclusion: 'supported',
  implementation: {
    kind: 'selected',
    inputs: [{ kind: 'release', identity: '0.2.1' }],
    environment: 'ci-linux',
  },
  method: { name: 'release review', configuration_sha256: null },
  exception_ids: [],
  evidence: [{ kind: 'observation', id: 'observation-1', role: 'supports' }],
  check_states: [],
  observed_write_sequence: 12,
  observed_intent_counter: 3,
  write_sequence: 14,
  ...change,
});

const question = (
  change: Partial<AssessmentRelevanceQuestion> = {}
): AssessmentRelevanceQuestion => ({
  implementation: {
    kind: 'selected',
    inputs: [{ kind: 'release', identity: '0.2.1' }],
    environment: 'ci-linux',
  },
  expectations: [REVISION],
  exception_ids: [],
  method: { name: 'release review', configuration_sha256: null },
  evidence: [{ kind: 'observation', id: 'observation-1', role: 'supports' }],
  intent_counter: 3,
  ...change,
});

const dimension = (
  held: ReturnType<typeof assessmentRelevance>,
  name: RelevanceDimension
): { match: DimensionMatch; detail: string | null } => {
  const found = held.dimensions.find((entry) => entry.dimension === name);
  if (found === undefined) throw new Error(`no ${name} dimension`);
  return { match: found.match, detail: found.detail };
};

describe('judging one assessment against one question', () => {
  it('applies when every dimension matches', () => {
    const held = assessmentRelevance(basis(), question());
    expect(held.outcome).toBe('applies');
    expect(held.changed).toEqual([]);
    expect(held.dimensions.map((entry) => entry.match)).toEqual([
      'matches',
      'matches',
      'matches',
      'matches',
      'matches',
      'matches',
      'matches',
    ]);
  });

  it('is historical when it concluded about a revision the question does not name', () => {
    const held = assessmentRelevance(
      basis(),
      question({ expectations: [{ ...REVISION, revision_id: 'revision-2' }] })
    );
    expect(held.outcome).toBe('historical');
    expect(dimension(held, 'expectations').match).toBe('differs');
    expect(dimension(held, 'expectations').detail).toContain('revision-1');
    expect(held.statement).toContain('preserved');
  });

  it('is historical when the question names no revision in force', () => {
    const held = assessmentRelevance(basis(), question({ expectations: [] }));
    expect(held.outcome).toBe('historical');
    expect(dimension(held, 'expectations').match).toBe('unknown');
  });

  it('is insufficient for a new claim against another software version', () => {
    const held = assessmentRelevance(
      basis(),
      question({
        implementation: {
          kind: 'selected',
          inputs: [{ kind: 'release', identity: '0.3.0' }],
          environment: 'ci-linux',
        },
      })
    );
    expect(held.outcome).toBe('insufficient_for_a_new_claim');
    expect(held.changed).toEqual(['software']);
    expect(dimension(held, 'software').detail).toContain('0.3.0');
    expect(held.statement).toContain('verification gap');
    expect(held.statement).toContain('not an established defect');
  });

  it('reaches the same outcome for a contradicted assessment as for a supported one', () => {
    const asked = question({
      implementation: {
        kind: 'selected',
        inputs: [{ kind: 'release', identity: '0.3.0' }],
        environment: 'ci-linux',
      },
    });
    expect(assessmentRelevance(basis({ conclusion: 'contradicted' }), asked).outcome).toBe(
      assessmentRelevance(basis({ conclusion: 'supported' }), asked).outcome
    );
  });

  it('leaves software unknown, and nothing applying, when the question names none', () => {
    const held = assessmentRelevance(basis(), question({ implementation: null }));
    expect(held.outcome).toBe('insufficient_for_a_new_claim');
    expect(dimension(held, 'software').match).toBe('unknown');
    expect(dimension(held, 'conditions').match).toBe('unknown');
    expect(dimension(held, 'software').detail).toContain('satisfaction');
  });

  it('applies over dimensions the question placed no constraint on', () => {
    const held = assessmentRelevance(
      basis(),
      question({ method: null, evidence: null, exception_ids: null, intent_counter: null })
    );
    expect(held.outcome).toBe('applies');
    expect(held.changed).toEqual([]);
    expect(held.unstated).toEqual(['intent', 'exceptions', 'method', 'evidence']);
  });

  it('never applies over software the question left unstated', () => {
    const held = assessmentRelevance(
      basis(),
      question({ implementation: null, method: null, evidence: null, exception_ids: null })
    );
    expect(held.outcome).toBe('insufficient_for_a_new_claim');
    expect(held.changed).toEqual([]);
    expect(held.unstated).toContain('software');
  });

  it('separates naming no software from naming none', () => {
    const noneNamed = assessmentRelevance(
      basis({ implementation: { kind: 'none_selected' } }),
      question({ implementation: { kind: 'none_selected' } })
    );
    expect(dimension(noneNamed, 'software').match).toBe('matches');
    const nobodySaid = assessmentRelevance(
      basis({ implementation: { kind: 'none_selected' } }),
      question({ implementation: null })
    );
    expect(dimension(nobodySaid, 'software').match).toBe('unknown');
  });
});

describe('each dimension makes an earlier assessment insufficient on its own', () => {
  it('names an advance of the intent counter', () => {
    const held = assessmentRelevance(basis(), question({ intent_counter: 5 }));
    expect(held.outcome).toBe('insufficient_for_a_new_claim');
    expect(held.changed).toEqual(['intent']);
    expect(dimension(held, 'intent').detail).toContain('2 time(s)');
  });

  it('does not treat an intent counter behind the stamped one as a change', () => {
    expect(
      dimension(assessmentRelevance(basis(), question({ intent_counter: 3 })), 'intent').match
    ).toBe('matches');
  });

  it('names a different selected input', () => {
    const held = assessmentRelevance(
      basis(),
      question({
        implementation: {
          kind: 'selected',
          inputs: [{ kind: 'git_commit', identity: 'abc123' }],
          environment: 'ci-linux',
        },
      })
    );
    expect(held.changed).toEqual(['software']);
  });

  it('names a different environment', () => {
    const held = assessmentRelevance(
      basis(),
      question({
        implementation: {
          kind: 'selected',
          inputs: [{ kind: 'release', identity: '0.2.1' }],
          environment: 'ci-macos',
        },
      })
    );
    expect(held.outcome).toBe('insufficient_for_a_new_claim');
    expect(held.changed).toEqual(['conditions']);
    expect(dimension(held, 'conditions').detail).toContain('ci-macos');
  });

  it('names a different set of exceptions in force', () => {
    const held = assessmentRelevance(basis(), question({ exception_ids: ['exception-1'] }));
    expect(held.changed).toEqual(['exceptions']);
    expect(dimension(held, 'exceptions').detail).toContain('exception-1');
  });

  it('names a different method configuration', () => {
    const held = assessmentRelevance(
      basis(),
      question({ method: { name: 'release review', configuration_sha256: 'a'.repeat(64) } })
    );
    expect(held.changed).toEqual(['method']);
    expect(dimension(held, 'method').detail).toContain('unrecorded');
  });

  it('names different evidence', () => {
    const held = assessmentRelevance(
      basis(),
      question({ evidence: [{ kind: 'observation', id: 'observation-2', role: 'supports' }] })
    );
    expect(held.changed).toEqual(['evidence']);
    expect(dimension(held, 'evidence').detail).toContain('observation-2');
  });

  it('ignores the order inputs, exceptions and evidence were written in', () => {
    const held = assessmentRelevance(
      basis({
        implementation: {
          kind: 'selected',
          inputs: [
            { kind: 'release', identity: '0.2.1' },
            { kind: 'git_commit', identity: 'abc123' },
          ],
          environment: 'ci-linux',
        },
        exception_ids: ['exception-2', 'exception-1'],
      }),
      question({
        implementation: {
          kind: 'selected',
          inputs: [
            { kind: 'git_commit', identity: 'abc123' },
            { kind: 'release', identity: '0.2.1' },
          ],
          environment: 'ci-linux',
        },
        exception_ids: ['exception-1', 'exception-2'],
      })
    );
    expect(held.outcome).toBe('applies');
  });
});

describe('what a later assessment does to the report before it', () => {
  const failed = basis({
    assessment_id: 'assessment-report',
    conclusion: 'contradicted',
    evidence: [{ kind: 'observation', id: 'observation-1', role: 'contradicts' }],
  });

  it('establishes only what a clean rerun of the same basis observed', () => {
    const standing = priorReportStanding(
      failed,
      basis({ assessment_id: 'assessment-rerun', conclusion: 'supported' })
    );
    expect(standing.effect).toBe('observed_the_same_basis_later');
    expect(standing.prior_conclusion).toBe('contradicted');
    expect(standing.statement).toContain('never refutes the earlier report');
    expect(standing.statement).toContain('stands as a report about its own inputs');
  });

  it('treats a later fix at another version as an observation of another basis', () => {
    const standing = priorReportStanding(
      failed,
      basis({
        assessment_id: 'assessment-fixed',
        conclusion: 'supported',
        implementation: {
          kind: 'selected',
          inputs: [{ kind: 'release', identity: '0.2.2' }],
          environment: 'ci-linux',
        },
      })
    );
    expect(standing.effect).toBe('observed_another_basis');
    expect(standing.prior_conclusion).toBe('contradicted');
    expect(standing.statement).toContain('not evidence that the earlier report was wrong');
  });

  it('treats a run that reached no conclusion as establishing nothing', () => {
    const standing = priorReportStanding(
      failed,
      basis({
        assessment_id: 'assessment-skipped',
        conclusion: 'not_assessed',
        evidence: [],
        check_states: [{ check: 'offline smoke', state: 'skipped' }],
      })
    );
    expect(standing.effect).toBe('observed_nothing');
    expect(standing.statement).toContain('offline smoke (skipped)');
    expect(standing.statement).toContain('refutes nothing');
  });

  it('treats a changed method configuration as another basis, not a refutation', () => {
    const standing = priorReportStanding(
      failed,
      basis({
        assessment_id: 'assessment-reconfigured',
        conclusion: 'supported',
        method: { name: 'release review', configuration_sha256: 'b'.repeat(64) },
      })
    );
    expect(standing.effect).toBe('observed_another_basis');
    expect(standing.prior_conclusion).toBe('contradicted');
  });
});
