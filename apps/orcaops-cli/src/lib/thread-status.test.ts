import { describe, expect, it } from 'vitest';

import { deriveThreadStatus } from './thread-status.js';

type Input = Parameters<typeof deriveThreadStatus>[0];

function input(overrides: Partial<Input> = {}): Input {
  return {
    artifact: {
      id: 'artifact',
      task: 'A task',
      branch: 'topic',
      status: 'active',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: null,
    },
    planStepCount: 2,
    checkpoints: [{ n: 1, status: 'closed' }],
    hasSummary: false,
    lifecycles: [],
    evaluatorRuns: [],
    ...overrides,
  };
}

function run(runId: string, verdict: 'violation' | 'pass'): Input['evaluatorRuns'][number] {
  return {
    run_id: runId,
    evaluator_ref: 'test/blocker',
    phase: 'checkpoint-close',
    severity: 'block',
    run_status: 'completed',
    verdict,
    disposition: verdict === 'violation' ? 'unresolved' : null,
  };
}

describe('thread summary readiness', () => {
  it('allows summary without a pre-PR run when no checkpoint or evaluator blocks it', () => {
    const status = deriveThreadStatus(input());
    expect(status.thread['eval-pr']).toMatchObject({ status: 'ready' });
    expect(status.thread.summary).toEqual({ status: 'ready', blocked_by: [] });
    expect(status.blocking_evaluators).toEqual([]);
  });

  it('blocks summary on an open checkpoint without requiring pre-PR', () => {
    const status = deriveThreadStatus(input({ checkpoints: [{ n: 1, status: 'open' }] }));
    expect(status.thread.summary).toEqual({ status: 'blocked', blocked_by: ['checkpoint'] });
  });

  it('maps an unresolved evaluator violation to its phase', () => {
    const status = deriveThreadStatus(input({ evaluatorRuns: [run('failed', 'violation')] }));
    expect(status.thread.summary).toEqual({ status: 'blocked', blocked_by: ['eval-cp'] });
    expect(status.blocking_evaluators).toMatchObject([
      { evaluator_ref: 'test/blocker', run_id: 'failed', failure_kind: 'violation' },
    ]);
  });

  it('keeps an evaluator error blocking until a successful rerun', () => {
    const error = { ...run('error', 'violation'), run_status: 'error', verdict: null };
    const blocked = deriveThreadStatus(input({ evaluatorRuns: [error] }));
    expect(blocked.thread.summary.status).toBe('blocked');
    expect(blocked.blocking_evaluators).toMatchObject([{ run_id: 'error', failure_kind: 'error' }]);
    const cleared = deriveThreadStatus(input({ evaluatorRuns: [error, run('passed', 'pass')] }));
    expect(cleared.blocking_evaluators).toEqual([]);
    expect(cleared.thread.summary).toEqual({ status: 'ready', blocked_by: [] });
  });

  it('lets a passing rerun supersede an earlier violation', () => {
    const status = deriveThreadStatus(
      input({ evaluatorRuns: [run('failed', 'violation'), run('passed', 'pass')] })
    );
    expect(status.blocking_evaluators).toEqual([]);
    expect(status.thread.summary).toEqual({ status: 'ready', blocked_by: [] });
  });
});
