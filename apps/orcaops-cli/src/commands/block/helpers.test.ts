import { describe, expect, it } from 'vitest';

import { resolveTargetRun, type RunRow } from './helpers.js';

const row = (overrides: Partial<RunRow> = {}): RunRow => ({
  run_id: 'run-1',
  evaluator_ref: 'core/x',
  phase: 'pre-pr',
  severity: 'block',
  run_status: 'completed',
  verdict: 'violation',
  disposition: 'unresolved',
  ...overrides,
});

const context = (rows: RunRow[]) => ({
  store: { store: { listEvaluatorRuns: () => rows } },
});

describe('resolveTargetRun', () => {
  it('resolves the current policy violation', () => {
    expect(
      resolveTargetRun(context([row()]), { artifact: 'A', evaluator: 'x' }, 'core/x', 'dismiss')
    ).toEqual({ run_id: 'run-1', evaluator_ref: 'core/x' });
  });

  it('refuses to disposition the current evaluator error', () => {
    const error = row({
      run_id: 'run-error',
      run_status: 'error',
      verdict: null,
      disposition: null,
    });
    expect(() =>
      resolveTargetRun(context([error]), { artifact: 'A', evaluator: 'x' }, 'core/x', 'dismiss')
    ).toThrow(/evaluator error.*rerun its pre-pr phase/i);
    expect(() =>
      resolveTargetRun(
        context([error]),
        { artifact: 'A', evaluator: 'x', runId: 'run-error' },
        'core/x',
        'acknowledge'
      )
    ).toThrow(/evaluator error.*rerun its pre-pr phase/i);
  });
});
