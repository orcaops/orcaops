import { expect, it } from 'vitest';

import { type EvaluatorFinding, EvaluatorFindingSchema } from '@orcaops/evaluator-protocol';

import { packRunFindings } from './findings.js';

const files = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    kind: 'file' as const,
    path: `src/file${index}.ts`,
  }));

it('retains the graded expectation and valid sibling findings when locations are bounded', () => {
  const criterion = { kind: 'acceptance-criterion' as const, criterion_id: 'criterion-local' };
  const finding: EvaluatorFinding = {
    title: 'Criterion met',
    conclusion: 'supported',
    locations: [...files(10), criterion],
  };
  expect(EvaluatorFindingSchema.safeParse(finding).success).toBe(true);
  const result = packRunFindings({
    run_id: 'run-local',
    source: 'envelope',
    read: { status: 'ok', findings: [{ title: 'Independent retained finding' }, finding] },
  });
  expect(result.status).toBe('established');
  if (result.status !== 'established') throw new Error('Expected bounded findings');
  expect(result.record.findings).toEqual([
    { title: 'Independent retained finding' },
    { ...finding, locations: [...files(9), criterion] },
  ]);
  expect(result.record.notice).toEqual({
    findings_dropped: 0,
    locations_dropped: 1,
    titles_shortened: 0,
    details_shortened: 0,
  });
});

it('preserves mixed expectation locations and leaves an exactly bounded finding unchanged', () => {
  const expectations: NonNullable<EvaluatorFinding['locations']> = [
    { kind: 'plan-step', step_id: 'step-local' },
    { kind: 'acceptance-criterion', criterion_id: 'criterion-local' },
    { kind: 'requirement', revision_id: 'requirement-local' },
    { kind: 'decision', revision_id: 'decision-local' },
  ];
  for (const count of [6, 10]) {
    const finding: EvaluatorFinding = {
      title: 'Expectations supported',
      conclusion: 'supported',
      locations: [...files(count), ...expectations],
    };
    const result = packRunFindings({
      run_id: 'run-local',
      source: 'envelope',
      read: { status: 'ok', findings: [finding] },
    });
    expect(result.status).toBe('established');
    if (result.status !== 'established') throw new Error('Expected bounded findings');
    expect(result.record.findings[0].locations).toEqual([...files(6), ...expectations]);
    expect(result.record.notice?.locations_dropped).toBe(count === 6 ? undefined : 4);
  }
});

it('still refuses an identifier damaged by secret scrubbing', () => {
  const result = packRunFindings({
    run_id: 'run-local',
    source: 'envelope',
    read: {
      status: 'ok',
      findings: [{ title: 'A secret-shaped key', key: 'ghp_' + 'a'.repeat(36) }],
    },
  });
  expect(result.status).toBe('unreadable');
});
