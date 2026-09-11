import { expect, it, vi } from 'vitest';

import { HistoryScopeError } from '@orcaops/project-scope/history';

import { validateDatabaseTaskOptions } from './database-task-context.js';
import { deriveThreadStatus } from './thread-status.js';
import { createDatabaseStatusAction } from '../commands/status.js';

const artifact = {
  id: 'original',
  task: 'Original task',
  branch: 'topic',
  status: 'active' as const,
  started_at: '2026-01-01T00:00:00Z',
  completed_at: null,
};
it('retains readiness and original evaluator supersession from detached metadata', () => {
  const input = {
    artifact,
    planStepCount: 1,
    checkpoints: [{ n: 1, status: 'closed' }],
    hasSummary: false,
    lifecycles: [{ fires_at: 'checkpoint-close', cp_n: 1 }],
    evaluatorRuns: [
      {
        evaluator_ref: 'core/check',
        run_id: 'failed',
        phase: 'checkpoint-close',
        severity: 'block',
        run_status: 'completed',
        verdict: 'violation',
        disposition: 'unresolved',
        checkpoint_n: 1,
      },
      {
        evaluator_ref: 'core/check',
        run_id: 'passed',
        phase: 'checkpoint-close',
        severity: 'block',
        run_status: 'completed',
        verdict: 'pass',
        disposition: null,
        checkpoint_n: 1,
      },
    ],
  };
  const before = structuredClone(input);
  expect(
    deriveThreadStatus({ ...input, evaluatorRuns: input.evaluatorRuns.slice(0, 1) })
      .blocking_evaluators
  ).toHaveLength(1);
  expect(deriveThreadStatus(input)).toMatchObject({
    thread: { 'eval-cp': { status: 'done' }, summary: { status: 'ready' } },
    blocking_evaluators: [],
    capture_health: 'ok',
  });
  expect(input).toEqual(before);
  expect(
    deriveThreadStatus({ ...input, checkpoints: [{ n: 2, status: 'open' }] }).thread.summary
  ).toMatchObject({ status: 'blocked', blocked_by: ['checkpoint'] });
});
it('rejects malformed and retired selectors before opening history', () => {
  for (const input of [
    null,
    [],
    { project: true },
    { json: 'yes' },
    { acceptDefault: true },
    { branch: '  ' },
  ])
    expect(() => validateDatabaseTaskOptions(input as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
});
it('does not turn a rejected scope into unavailable success', async () => {
  const openContext = vi
    .fn()
    .mockRejectedValue(new HistoryScopeError('SCOPE_CONFLICT', 'Original selector conflict'));
  const action = createDatabaseStatusAction({ openContext });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    await expect(action()).rejects.toMatchObject({ code: 1 });
    expect(output).not.toHaveBeenCalled();
    expect(openContext).toHaveBeenCalledOnce();
  } finally {
    output.mockRestore();
    error.mockRestore();
  }
});

it('closes before success and preserves a primary selector error when cleanup fails', async () => {
  const { getDefaultConfig } = await import('@orcaops/storage');
  const { ProjectDatabaseError } = await import('@orcaops/storage/history/database');
  const closed = new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Original cleanup failure');
  const context = {
    config: getDefaultConfig(),
    scope: {
      root: { resolvedRoot: '/unused', rootKey: 'a'.repeat(64) },
      kind: 'project' as const,
      selection: 'default' as const,
      branch: { value: 'topic', source: 'current' as const },
      gitContext: null,
      contextIssues: [],
      projects: [],
      completeness: { complete: true, issues: [] },
      close() {
        throw closed;
      },
    },
  };
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    const action = createDatabaseStatusAction({ openContext: async () => context });
    await expect(action({ json: true })).rejects.toMatchObject({ code: 1 });
    const envelope = JSON.parse(String(output.mock.calls[0][0]));
    expect(envelope.error.code).toBe('HISTORY_INACCESSIBLE');
    expect(output).toHaveBeenCalledOnce();
    output.mockClear();
    Object.defineProperty(context.scope, 'projects', {
      get() {
        throw new ProjectDatabaseError('CANCELLED', 'Original cancelled read');
      },
    });
    await expect(action({ json: true })).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse(String(output.mock.calls[0][0])).error.code).toBe('CANCELLED');
    expect(output).toHaveBeenCalledOnce();
    expect(
      error.mock.calls.some(([value]) => String(value).includes('Reader cleanup also failed'))
    ).toBe(true);
  } finally {
    output.mockRestore();
    error.mockRestore();
  }
});
