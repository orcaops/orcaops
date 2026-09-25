import { describe, expect, it } from 'vitest';

import { knowledgeProcessingCoverage, type KnowledgeProcessingFacts } from './coverage.js';

const SETTLED = { open: 0, waiting: 0, awaiting_model_resume: 0, completed: 3, gave_up: 0 };

const facts = (change: Partial<KnowledgeProcessingFacts> = {}): KnowledgeProcessingFacts => ({
  enabled: true,
  configuration_source: { kind: 'worktree', path: '/repo/.orcaops/config.json' },
  pause_reasons: [],
  consent: { granted: true, reason: null },
  project_paused: false,
  history_problem: null,
  jobs: SETTLED,
  latest_admitted_sequence: 40,
  eligible_sources: 3,
  missing_eligible_sources: 0,
  latest_eligible_sequence: 40,
  boundary: 40,
  ...change,
});

function extraction(): NonNullable<KnowledgeProcessingFacts['extraction']> {
  const counts = () => ({ statements: 0, corrections: 0, links: 0, uncertainties: 0 });
  return {
    sampledJobs: 1,
    omittedJobs: 4,
    notStartedJobs: 0,
    unreadableJobs: 0,
    scheduledUnits: 2,
    settledUnits: 1,
    outcomes: { accepted: 0, partial: 0, all_rejected: 1, empty: 0 },
    items: {
      proposed: { ...counts(), statements: 1 },
      accepted: counts(),
      heldBack: counts(),
      rejected: { ...counts(), statements: 1 },
    },
    diagnosticsTotal: 1,
    scheduledFieldOmissions: 2,
    fields: [],
    omittedFieldDetails: 1,
    omissions: [],
    omittedOmissionDetails: 2,
  };
}

describe('the processing coverage claim', () => {
  it('does not confuse a completed queue with accepted output or complete field coverage', () => {
    const report = knowledgeProcessingCoverage(facts({ extraction: extraction() }));
    expect(report.claim).toBe('complete');
    expect(report.statement).toContain('1/2 scheduled unit(s) settled');
    expect(report.statement).toContain('1 all rejected');
    expect(report.statement).toContain('2 field omission(s)');
    expect(report.statement).toContain('4 other job(s) outside the sample');
    expect(report.statement).toContain('Settled does not mean semantically correct or approved.');
  });

  it('keeps earlier partial work visible after an unsuccessful job and disabling processing', () => {
    const report = knowledgeProcessingCoverage(
      facts({
        enabled: false,
        jobs: { ...SETTLED, completed: 0, gave_up: 1 },
        extraction: extraction(),
      })
    );
    expect(report.claim).toBe('not_processed');
    expect(report.statement).toContain('retains 1 settled unit(s)');
    expect(report.statement).not.toContain('has interpreted nothing');
  });

  it('does not infer that failed jobs published nothing when their progress is unreadable', () => {
    const report = knowledgeProcessingCoverage(
      facts({
        enabled: false,
        jobs: { ...SETTLED, completed: 0, gave_up: 1 },
        extraction: { ...extraction(), settledUnits: 0, unreadableJobs: 1 },
      })
    );
    expect(report.statement).toContain('may include earlier partial work');
    expect(report.statement).toContain('1 job(s) with unreadable progress');
  });
  it('reads not processed, with no completeness number, while processing is off', () => {
    const coverage = knowledgeProcessingCoverage(facts({ enabled: false }));

    expect(coverage.claim).toBe('not_processed');
    expect(coverage.completed_through).toBeNull();
    expect(coverage.statement).toContain('claims no completeness');
  });

  it('reads not processed when no eligible source was ever captured', () => {
    expect(
      knowledgeProcessingCoverage(
        facts({
          latest_admitted_sequence: null,
          eligible_sources: 0,
          latest_eligible_sequence: null,
        })
      ).claim
    ).toBe('not_processed');
    expect(
      knowledgeProcessingCoverage(
        facts({
          history_problem: { code: 'no_history', message: 'No project history here yet.' },
          jobs: { ...SETTLED, completed: 0 },
          latest_admitted_sequence: null,
          eligible_sources: 0,
          latest_eligible_sequence: null,
        })
      ).claim
    ).toBe('not_processed');
  });

  it('reads not processed for a repository with no history and so no queue to read', () => {
    const coverage = knowledgeProcessingCoverage(
      facts({
        history_problem: { code: 'no_history', message: 'No project history here yet.' },
        jobs: null,
        latest_admitted_sequence: null,
        eligible_sources: 0,
        latest_eligible_sequence: null,
        boundary: null,
      })
    );

    expect(coverage.claim).toBe('not_processed');
    expect(coverage.completed_through).toBeNull();
    expect(coverage.statement).toContain('has interpreted nothing here');
    expect(coverage.statement).toContain('claims no completeness');
  });

  it('reads unknown when the queue could not be read and the history is there', () => {
    expect(knowledgeProcessingCoverage(facts({ jobs: null })).claim).toBe('unknown');
  });

  it('reads unknown, with no completeness number, when the history cannot be read', () => {
    for (const code of ['upgrade_required', 'unreadable'] as const) {
      const coverage = knowledgeProcessingCoverage(
        facts({ history_problem: { code, message: 'Run the explicit upgrade.' }, jobs: null })
      );
      expect(coverage.claim).toBe('unknown');
      expect(coverage.completed_through).toBeNull();
      expect(coverage.statement).toContain('Run the explicit upgrade.');
    }
  });

  it('reads partial while any admitted job is open, gave up, or the project is paused', () => {
    expect(knowledgeProcessingCoverage(facts({ jobs: { ...SETTLED, open: 1 } })).claim).toBe(
      'partial'
    );
    expect(knowledgeProcessingCoverage(facts({ jobs: { ...SETTLED, gave_up: 1 } })).claim).toBe(
      'partial'
    );
    expect(knowledgeProcessingCoverage(facts({ project_paused: true })).claim).toBe('partial');
  });

  it('reads partial while an eligible source has no admitted job', () => {
    const coverage = knowledgeProcessingCoverage(facts({ missing_eligible_sources: 1 }));

    expect(coverage.claim).toBe('partial');
    expect(coverage.completed_through).toBeNull();
    expect(coverage.statement).toContain(
      'Current processing status is behind for the eligible-source cohort selected through write sequence 40'
    );
    expect(coverage.statement).toContain('claims no completeness');
  });

  it('reports the newest eligible source selected through a historical boundary', () => {
    const historical = knowledgeProcessingCoverage(
      facts({
        latest_admitted_sequence: 12,
        eligible_sources: 1,
        latest_eligible_sequence: 12,
        boundary: 12,
      })
    );

    expect(historical.claim).toBe('complete');
    expect(historical.completed_through).toBe(12);
    expect(historical.statement).toContain('source sequence 12');
    expect(historical.statement).not.toContain('source sequence 40');
  });

  it('ignores unrelated writes after the newest eligible source', () => {
    const coverage = knowledgeProcessingCoverage(facts({ boundary: 90 }));

    expect(coverage.claim).toBe('complete');
    expect(coverage.completed_through).toBe(40);
    expect(coverage.statement).toContain(
      'Current processing status is complete for eligible sources admitted through source sequence 40'
    );
    expect(coverage.statement).toContain(
      "This answer's knowledge is independently limited to write sequence 90"
    );
    expect(coverage.statement).toContain(
      'interpretation output committed after that boundary may be absent'
    );
  });

  it('says what was interpreted before processing was turned off', () => {
    const after = knowledgeProcessingCoverage(facts({ enabled: false }));

    expect(after.claim).toBe('not_processed');
    expect(after.statement).toContain('3 job(s) were interpreted earlier and nothing since');
    expect(after.statement).toContain('claims no completeness');

    const never = knowledgeProcessingCoverage(
      facts({ enabled: false, jobs: { ...SETTLED, completed: 0 } })
    );
    expect(never.statement).toContain('has interpreted nothing here');
  });

  it('reads complete only once every admitted job settled through the boundary', () => {
    const coverage = knowledgeProcessingCoverage(facts());

    expect(coverage.claim).toBe('complete');
    expect(coverage.completed_through).toBe(40);
    expect(coverage.statement).toContain(
      'not proof that every requirement in those sources was found'
    );
  });
});
