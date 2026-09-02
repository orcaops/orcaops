import { describe, expect, it } from 'vitest';

import {
  blockingEvaluatorFailureKind,
  EvaluatorRunPayloadSchema,
  isBlockingEligibleViolation,
  isBlockingEvaluatorFailure,
} from './run.js';

const baseRun = {
  schema: 'orcaops.evaluator_run/v1',
  run_id: '01HXRUN0000000000000000000',
  artifact_id: '01HXART0000000000000000000',
  evaluator_ref: 'core/plan-label-quality',
  package_id: 'core',
  evaluator_id: 'plan-label-quality',
  phase: 'post-plan' as const,
  severity: 'warn' as const,
  body: 'PASS\n\nLooks good.',
  ts: '2026-05-12T23:50:00.000Z',
};

describe('EvaluatorRunPayloadSchema (happy path)', () => {
  it('accepts a completed pass run', () => {
    const out = EvaluatorRunPayloadSchema.parse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'pass',
    });
    expect(out.verdict).toBe('pass');
    expect(out.run_status).toBe('completed');
  });

  it('accepts a completed violation run with optional fields', () => {
    const out = EvaluatorRunPayloadSchema.parse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'violation',
      body: 'VIOLATION\n\nReason',
      raw: { findings: ['x'] },
      metrics: { files_scanned: 12 },
      duration_ms: 42,
    });
    expect(out.raw).toEqual({ findings: ['x'] });
    expect(out.metrics).toEqual({ files_scanned: 12 });
    expect(out.duration_ms).toBe(42);
  });

  it('accepts an llm-engine completed run with tokens/model/cost', () => {
    const out = EvaluatorRunPayloadSchema.parse({
      ...baseRun,
      phase: 'checkpoint-close',
      run_status: 'completed',
      verdict: 'pass',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      tokens: { in: 100, out: 50, cache_read: 800 },
      cost_usd: 0.0012,
    });
    expect(out.tokens?.cache_read).toBe(800);
    expect(out.provider).toBe('claude');
    expect(out.cost_usd).toBe(0.0012);
  });

  it('accepts an errored run with verdict null and an error payload', () => {
    const out = EvaluatorRunPayloadSchema.parse({
      ...baseRun,
      run_status: 'error',
      verdict: null,
      body: 'ERROR\n\nSubprocess exit 1',
      error: { code: 'EXIT_CODE', message: 'non-zero exit' },
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('EXIT_CODE');
  });

  it('accepts a skipped run with verdict null and no error', () => {
    const out = EvaluatorRunPayloadSchema.parse({
      ...baseRun,
      run_status: 'skipped',
      verdict: null,
      body: 'SKIPPED\n\nfilters.paths disjoint',
    });
    expect(out.run_status).toBe('skipped');
    expect(out.verdict).toBeNull();
  });
});

describe('EvaluatorRunPayloadSchema — run_status × verdict invariant', () => {
  it('rejects completed run with verdict=null', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'completed',
      verdict: null,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].path).toEqual(['verdict']);
    }
  });

  it('rejects completed run with an error field', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'pass',
      error: { code: 'X', message: 'y' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects errored run with a non-null verdict', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'error',
      verdict: 'pass',
      error: { code: 'X', message: 'y' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects errored run missing error payload', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'error',
      verdict: null,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].path).toEqual(['error']);
    }
  });

  it('rejects skipped run with a non-null verdict', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'skipped',
      verdict: 'pass',
    });
    expect(res.success).toBe(false);
  });
});

describe('EvaluatorRunPayloadSchema (other failure modes)', () => {
  it('rejects unknown schema literal', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      schema: 'orcaops.evaluator_run/v2',
      run_status: 'completed',
      verdict: 'pass',
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'pass',
      unknown_key: 1,
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown token-usage keys', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'pass',
      tokens: { in: 100, out: 50, total: 150 },
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown evaluator-error keys', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'error',
      verdict: null,
      error: { code: 'EXIT_CODE', message: 'non-zero exit', retryable: false },
    });
    expect(res.success).toBe(false);
  });

  it('rejects invalid ts (not ISO 8601)', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'pass',
      ts: 'yesterday',
    });
    expect(res.success).toBe(false);
  });

  it('rejects negative duration_ms', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'pass',
      duration_ms: -1,
    });
    expect(res.success).toBe(false);
  });

  it('rejects non-positive checkpoint_n', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'pass',
      checkpoint_n: 0,
    });
    expect(res.success).toBe(false);
  });

  it('rejects an out-of-enum severity', () => {
    const res = EvaluatorRunPayloadSchema.safeParse({
      ...baseRun,
      severity: 'critical' as 'block',
      run_status: 'completed',
      verdict: 'pass',
    });
    expect(res.success).toBe(false);
  });
});

describe('blocking evaluator outcome predicates', () => {
  it('classifies violations separately from infrastructure errors', () => {
    expect(
      blockingEvaluatorFailureKind({
        severity: 'block',
        run_status: 'completed',
        verdict: 'violation',
      })
    ).toBe('violation');
    expect(
      blockingEvaluatorFailureKind({ severity: 'block', run_status: 'error', verdict: null })
    ).toBe('error');
    expect(
      blockingEvaluatorFailureKind({ severity: 'warn', run_status: 'error', verdict: null })
    ).toBeNull();
  });

  it('stops lifecycle progression for completed violations and infrastructure errors', () => {
    expect(
      isBlockingEvaluatorFailure({
        severity: 'block',
        run_status: 'completed',
        verdict: 'violation',
      })
    ).toBe(true);
    expect(
      isBlockingEvaluatorFailure({ severity: 'block', run_status: 'error', verdict: null })
    ).toBe(true);
  });

  it('does not turn infrastructure errors into disposition-eligible violations', () => {
    const errorRun = { severity: 'block', run_status: 'error', verdict: null } as const;
    expect(isBlockingEligibleViolation(errorRun)).toBe(false);
    expect(isBlockingEvaluatorFailure(errorRun)).toBe(true);
  });

  it('does not block on non-block errors, skips, or completed passes', () => {
    expect(
      isBlockingEvaluatorFailure({ severity: 'warn', run_status: 'error', verdict: null })
    ).toBe(false);
    expect(
      isBlockingEvaluatorFailure({ severity: 'block', run_status: 'skipped', verdict: null })
    ).toBe(false);
    expect(
      isBlockingEvaluatorFailure({ severity: 'block', run_status: 'completed', verdict: 'pass' })
    ).toBe(false);
  });
});
