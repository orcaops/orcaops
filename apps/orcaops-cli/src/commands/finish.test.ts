import { describe, expect, it } from 'vitest';

import type { EvaluatorRunPayload } from '@orcaops/evaluator-protocol';

import { classifyFinishPrePr } from './finish.js';

const run = (overrides: Partial<EvaluatorRunPayload>): EvaluatorRunPayload => ({
  schema: 'orcaops.evaluator_run/v1',
  run_id: 'run-1',
  artifact_id: 'artifact-1',
  evaluator_ref: 'test/review',
  package_id: 'test',
  evaluator_id: 'review',
  phase: 'pre-pr',
  severity: 'warn',
  run_status: 'completed',
  verdict: 'pass',
  body: 'PASS',
  ts: '2026-08-31T12:00:00.000Z',
  ...overrides,
});

describe('classifyFinishPrePr', () => {
  it('continues through information errors and ordinary passes', () => {
    expect(
      classifyFinishPrePr(
        [run({ severity: 'info', run_status: 'error', verdict: null, body: 'ERROR' })],
        false
      )
    ).toEqual({ kind: 'clean' });
  });

  it('pauses on warning violations and permits exact acceptance', () => {
    expect(
      classifyFinishPrePr([run({ verdict: 'violation', body: 'VIOLATION' })], false)
    ).toMatchObject({ kind: 'needs_attention', acceptance_allowed: true });
  });

  it('requires a rerun for warning errors and never offers acceptance', () => {
    expect(
      classifyFinishPrePr([run({ run_status: 'error', verdict: null, body: 'ERROR' })], false)
    ).toMatchObject({ kind: 'needs_attention', acceptance_allowed: false });
  });

  it('honors the shared blocking result before warning policy', () => {
    expect(classifyFinishPrePr([], true)).toEqual({ kind: 'blocked' });
  });
});
