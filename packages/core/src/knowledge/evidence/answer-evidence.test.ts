import { describe, expect, it } from 'vitest';

import type { ProjectKnowledgeContextAssessment } from '@orcaops/storage/history/database';

import { knowledgeContextEvidence, type KnowledgeContextQuestion } from './answer-evidence.js';

const REVISION = {
  kind: 'requirement' as const,
  entity_id: 'requirement-offline',
  revision_id: 'revision-1',
};

const held = (change: {
  id?: string;
  revisionId?: string;
  release?: string;
  conclusion?: string;
  writeSequence?: number;
}): ProjectKnowledgeContextAssessment => ({
  expectation: { ...REVISION, revision_id: change.revisionId ?? REVISION.revision_id },
  assessment: {
    assessmentId: change.id ?? 'assessment-1',
    assessedBy: 'levi',
    assessedByBasis: 'other_assertion',
    method: { name: 'release review', configurationSha256: null },
    implementation: {
      kind: 'selected',
      inputs: [{ kind: 'release', identity: change.release ?? '0.2.1' }],
      environment: null,
    },
    observedWriteSequence: 4,
    observedIntentCounter: 1,
    conclusions: [],
    evidence: [{ kind: 'observation', id: 'observation-1', role: 'supports' }],
    checkStates: [],
    recordHex: '',
    recordSha256: 'a'.repeat(64),
    operationId: 'operation-1',
    conclusion: change.conclusion ?? 'supported',
    writeSequence: change.writeSequence ?? 6,
    exceptionIds: [],
    coverageLimits: ['only the offline smoke ran'],
  },
});

const asking = (release: string | null): KnowledgeContextQuestion => ({
  software:
    release === null
      ? null
      : { kind: 'selected', inputs: [{ kind: 'release', identity: release }], environment: null },
  intentCounter: 1,
});

describe('previously recorded assessments under the identity they judged', () => {
  it('says what applies when the question names the software an assessment judged', () => {
    const evidence = knowledgeContextEvidence({
      assessments: [held({})],
      later: [],
      inForce: [REVISION],
      question: asking('0.2.1'),
    });

    expect(evidence.assessments[0]?.relevance.outcome).toBe('applies');
    expect(evidence.statement).toContain('1 of 1 assessment(s) apply');
    expect(evidence.needed).toEqual([]);
    expect(evidence.assessments[0]?.coverage_limits).toEqual(['only the offline smoke ran']);
  });

  it('answers a certification question with no applicable assessment and what would be needed', () => {
    const evidence = knowledgeContextEvidence({
      assessments: [held({ conclusion: 'supported' })],
      later: [],
      inForce: [REVISION],
      question: asking('0.3.0'),
    });

    expect(evidence.assessments[0]?.relevance.outcome).toBe('insufficient_for_a_new_claim');
    expect(evidence.statement).toContain('no applicable assessment');
    expect(evidence.statement).not.toContain('satisfied');
    expect(evidence.needed).toEqual([
      'assessment assessment-1: release 0.2.1 was assessed, and this question is about release 0.3.0',
    ]);
  });

  it('asks only for what moved when an assessment already names the revision and the software', () => {
    const evidence = knowledgeContextEvidence({
      assessments: [held({})],
      later: [],
      inForce: [REVISION],
      question: { ...asking('0.2.1'), intentCounter: 2 },
    });

    expect(evidence.assessments[0]?.relevance.outcome).toBe('insufficient_for_a_new_claim');
    expect(evidence.assessments[0]?.relevance.changed).toEqual(['intent']);
    expect(evidence.needed).toEqual([
      "assessment assessment-1: the project's intent changed since this assessment; reassess " +
        'against the expectation as it stands now, or record that the expectation is unchanged',
    ]);
    expect(evidence.needed.join(' ')).not.toContain('revision-1');
    expect(evidence.needed.join(' ')).not.toContain('0.2.1');
  });

  it('falls back to the question when no assessment names a revision in force', () => {
    const evidence = knowledgeContextEvidence({
      assessments: [held({ revisionId: 'revision-0' })],
      later: [],
      inForce: [REVISION],
      question: asking('0.3.0'),
    });

    expect(evidence.assessments[0]?.relevance.outcome).toBe('historical');
    expect(evidence.needed).toEqual([
      'a conclusion about revision(s) revision-1',
      'software release 0.3.0',
    ]);
  });

  it('makes nothing apply, and says so, when the question named no software', () => {
    const evidence = knowledgeContextEvidence({
      assessments: [held({})],
      later: [],
      inForce: [REVISION],
      question: asking(null),
    });

    expect(evidence.assessments.every((entry) => entry.relevance.outcome !== 'applies')).toBe(true);
    expect(evidence.statement).toContain('This question named no software');
    expect(evidence.needed).toEqual([
      'the software it judged, which this question did not name: no assessment is read as ' +
        'satisfaction of unspecified software',
    ]);
  });

  it('says there is no applicable assessment when this history holds none', () => {
    const evidence = knowledgeContextEvidence({
      assessments: [],
      later: [],
      inForce: [REVISION],
      question: asking('0.3.0'),
    });

    expect(evidence.statement).toContain('holds no assessment');
    expect(evidence.statement).toContain('not a defect');
    expect(evidence.needed).toHaveLength(2);
  });

  it('reads a later assessment of the same revision as observing only what it observed', () => {
    const evidence = knowledgeContextEvidence({
      assessments: [
        held({ id: 'assessment-report', conclusion: 'contradicted', writeSequence: 6 }),
        held({ id: 'assessment-rerun', conclusion: 'supported', writeSequence: 9 }),
      ],
      later: [],
      inForce: [REVISION],
      question: asking('0.2.1'),
    });

    expect(evidence.succession).toHaveLength(1);
    expect(evidence.succession[0]).toMatchObject({
      prior_assessment_id: 'assessment-report',
      later_assessment_id: 'assessment-rerun',
      effect: 'observed_the_same_basis_later',
      prior_conclusion: 'contradicted',
    });
    expect(evidence.assessments[0]?.conclusion).toBe('contradicted');
  });

  it('compares no assessments of different revisions with one another', () => {
    const evidence = knowledgeContextEvidence({
      assessments: [
        held({ id: 'assessment-older', revisionId: 'revision-0' }),
        held({ id: 'assessment-newer' }),
      ],
      later: [],
      inForce: [REVISION],
      question: asking('0.2.1'),
    });

    expect(evidence.succession).toEqual([]);
    expect(evidence.assessments[0]?.relevance.outcome).toBe('historical');
    expect(evidence.assessments[1]?.relevance.outcome).toBe('applies');
  });

  it('carries the newest assessments of one identity and names the ones it left out', () => {
    const many = Array.from({ length: 1000 }, (_, index) =>
      held({ id: `assessment-${index}`, writeSequence: index + 1 })
    );

    const evidence = knowledgeContextEvidence({
      assessments: many,
      later: [],
      inForce: [REVISION],
      question: asking('0.2.1'),
      bounds: { maxAssessments: 20, maxBytes: 1_000_000 },
    });

    expect(evidence.assessments).toHaveLength(20);
    expect(evidence.assessments.at(-1)?.assessment_id).toBe('assessment-999');
    expect(evidence.omitted).toHaveLength(980);
    expect(evidence.omitted[0]).toBe('assessment-0');
    expect(evidence.succession).toHaveLength(19);
    expect(evidence.statement).toContain('980 older assessment(s)');
    expect(JSON.stringify(evidence).length).toBeLessThan(100_000);
  });

  it('carries whole assessments only, and says so when the byte share fits none', () => {
    const evidence = knowledgeContextEvidence({
      assessments: [held({ id: 'assessment-old' }), held({ id: 'assessment-new' })],
      later: [],
      inForce: [REVISION],
      question: asking('0.2.1'),
      bounds: { maxAssessments: 20, maxBytes: 10 },
    });

    expect(evidence.assessments).toEqual([]);
    expect(evidence.omitted).toEqual(['assessment-old', 'assessment-new']);
    expect(evidence.statement).toContain('carries none of this identity');
    expect(evidence.statement).not.toContain('holds no assessment');
  });

  it('carries the ids of assessments published after the boundary', () => {
    expect(
      knowledgeContextEvidence({
        assessments: [],
        later: ['assessment-later'],
        inForce: [REVISION],
        question: asking(null),
      }).later
    ).toEqual(['assessment-later']);
  });
});
