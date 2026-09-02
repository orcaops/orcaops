import { describe, expect, it } from 'vitest';

import { computeCoverage } from './coverage.js';

describe('computeCoverage', () => {
  it('distinguishes open-declared work from closed-completed work', () => {
    expect(
      computeCoverage({
        planStepIds: ['s1', 's2', 's3'],
        closedCheckpoints: [{ completed_step_ids: ['s1'] }],
        openCheckpoints: [{ declared_step_ids: ['s2'] }],
      })
    ).toEqual({
      uncovered_step_ids: ['s3'],
      uncompleted_step_ids: ['s2', 's3'],
      plan_coverage_complete: false,
    });
  });

  it('preserves plan order and reports complete only when every step is closed-claimed', () => {
    expect(
      computeCoverage({
        planStepIds: ['s1', 's2'],
        closedCheckpoints: [{ completed_step_ids: ['s2', 's1'] }],
        openCheckpoints: [],
      })
    ).toEqual({
      uncovered_step_ids: [],
      uncompleted_step_ids: [],
      plan_coverage_complete: true,
    });
  });
});
