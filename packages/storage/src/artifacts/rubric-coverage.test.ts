import { describe, expect, it } from 'vitest';

import {
  missingCriteriaOnCaptureMessage,
  missingCriteriaOnNewStepMessage,
  NO_CRITERIA_RECORDED,
  rewrittenHistoricalStepMessage,
  rubricCoverage,
  rubricCoverageSentence,
  rubricRemovedMessage,
} from './acceptance-criteria.js';

describe('rubric coverage', () => {
  const step = (step_id: string, criteria: string[]) => ({
    step_id,
    label: step_id,
    acceptance_criteria: criteria.map((text) => ({ text })),
  });

  const plan = (revision_n: number, steps: ReturnType<typeof step>[]) => ({
    revision_n,
    plan_steps: steps,
  });

  it('counts a fully covered plan', () => {
    const c = rubricCoverage(plan(0, [step('a', ['x']), step('b', ['y'])]));
    expect(c).toEqual({
      revision_n: 0,
      total: 2,
      covered: 2,
      missing: 0,
      missing_step_ids: [],
    });
    expect(rubricCoverageSentence(c)).toBe(
      'Recorded acceptance criteria: 2 of 2 steps (revision 0).'
    );
  });

  it('counts a mixed plan and names the missing steps', () => {
    const c = rubricCoverage(plan(1, [step('a', ['x']), step('b', []), step('c', [])]));
    expect(c).toMatchObject({ total: 3, covered: 1, missing: 2, missing_step_ids: ['b', 'c'] });
    expect(rubricCoverageSentence(c)).toBe(
      'Recorded acceptance criteria: 1 of 3 steps (revision 1); 2 steps have no recorded criteria.'
    );
  });

  it('counts an all-empty plan without claiming anything was graded', () => {
    const c = rubricCoverage(plan(0, [step('a', []), step('b', [])]));
    expect(c).toMatchObject({ total: 2, covered: 0, missing: 2 });
    const sentence = rubricCoverageSentence(c);
    expect(sentence).toBe(
      'Recorded acceptance criteria: 0 of 2 steps (revision 0); 2 steps have no recorded criteria.'
    );
    expect(sentence).not.toMatch(/exempt|approved|graded|verified|delivered/i);
  });

  it('treats a blank-only criterion as no criterion', () => {
    const c = rubricCoverage(plan(0, [step('a', ['   '])]));
    expect(c).toMatchObject({ covered: 0, missing: 1, missing_step_ids: ['a'] });
  });

  it('narrows to the claimed steps and ignores ids outside the revision', () => {
    const c = rubricCoverage(plan(2, [step('a', ['x']), step('b', [])]), ['b', 'gone']);
    expect(c).toMatchObject({ revision_n: 2, total: 1, covered: 0, missing: 1 });
  });

  it('carries the revision it measured so counts cannot be read against another', () => {
    const older = rubricCoverage(plan(1, [step('a', [])]));
    const newer = rubricCoverage(plan(2, [step('a', ['x'])]));
    expect(older.revision_n).toBe(1);
    expect(newer.revision_n).toBe(2);
    expect(rubricCoverageSentence(older)).toContain('revision 1');
    expect(rubricCoverageSentence(newer)).toContain('revision 2');
  });

  it('reports exact counts when a claim mixes covered and rubric-free steps', () => {
    const c = rubricCoverage(plan(0, [step('a', ['x']), step('bare', []), step('c', ['y'])]), [
      'a',
      'bare',
    ]);
    expect(c).toMatchObject({ total: 2, covered: 1, missing: 1, missing_step_ids: ['bare'] });
    expect(rubricCoverageSentence(c)).toContain('1 of 2 steps');
  });

  it('reports a claimed historical rubric-free step as uncovered', () => {
    const c = rubricCoverage(plan(0, [step('bare', []), step('c', ['y'])]), ['bare']);
    expect(c).toMatchObject({ total: 1, covered: 0, missing: 1, missing_step_ids: ['bare'] });
  });

  it('says nothing is in scope rather than implying full coverage', () => {
    const c = rubricCoverage(plan(0, [step('a', ['x'])]), []);
    expect(c).toMatchObject({ total: 0, covered: 0, missing: 0 });
    expect(rubricCoverageSentence(c)).toBe('Recorded acceptance criteria: no steps in scope.');
  });

  it('states what a missing rubric leaves unverified', () => {
    expect(NO_CRITERIA_RECORDED).toMatch(/criterion-level completion is unverified/);
    expect(NO_CRITERIA_RECORDED).not.toMatch(/command|exempt|approved/i);
  });
});

describe('missing-rubric guidance', () => {
  const step = { position: 1, label: 'Wire the reader' };

  it('teaches the nested YAML shape on capture and on a new revision step', () => {
    for (const message of [
      missingCriteriaOnCaptureMessage([step]),
      missingCriteriaOnNewStepMessage([step]),
    ]) {
      expect(message).toContain('#1 "Wire the reader"');
      expect(message).toContain('acceptance_criteria:');
      expect(message).toContain('- text: |-');
    }
  });

  it('offers the conditional skill-update remedy for every required-criteria error', () => {
    for (const message of [
      missingCriteriaOnCaptureMessage([step]),
      missingCriteriaOnNewStepMessage([step]),
      rubricRemovedMessage([step]),
      rewrittenHistoricalStepMessage([step]),
    ]) {
      expect(message).toContain('orcaops update');
      expect(message).toContain('If your installed capture instructions');
      expect(message).not.toMatch(/your skills are stale|outdated skill detected/i);
    }
  });
});
