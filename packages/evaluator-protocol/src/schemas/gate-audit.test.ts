import { describe, expect, it } from 'vitest';

import {
  GateAuditDispositionSchema,
  GateAuditPayloadSchema,
  GateAuditRunSchema,
} from './gate-audit.js';

const baseRun = {
  run_id: '01HXRUN0000000000000000000',
  evaluator_ref: 'core/checkpoint-scope-density',
  phase: 'checkpoint-open' as const,
  severity: 'block' as const,
  body: 'VIOLATION\n\nThis open declares 4 of 5 plan steps.',
  ts: '2026-05-12T23:50:00.000Z',
};

describe('GateAuditRunSchema', () => {
  it('accepts a completed violation', () => {
    const out = GateAuditRunSchema.parse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'violation',
      provider: 'codex',
      duration_ms: 38,
    });
    expect(out.verdict).toBe('violation');
    expect(out.provider).toBe('codex');
  });

  it('accepts an errored open-gate run', () => {
    const out = GateAuditRunSchema.parse({
      ...baseRun,
      run_status: 'error',
      verdict: null,
      error: { code: 'TIMEOUT', message: '5000ms' },
    });
    expect(out.run_status).toBe('error');
  });

  it('rejects a non-checkpoint-open phase', () => {
    const res = GateAuditRunSchema.safeParse({
      ...baseRun,
      phase: 'checkpoint-close',
      run_status: 'completed',
      verdict: 'pass',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'phase');
      expect(issue?.message).toMatch(/gate_audit runs must carry/);
    }
  });

  it('rejects a parent-derived field (artifact_id) appearing on the embedded row (strict)', () => {
    const res = GateAuditRunSchema.safeParse({
      ...baseRun,
      run_status: 'completed',
      verdict: 'pass',
      artifact_id: 'should-not-appear-here',
    });
    expect(res.success).toBe(false);
  });

  it('rejects completed run with verdict=null (same invariant as full run schema)', () => {
    const res = GateAuditRunSchema.safeParse({
      ...baseRun,
      run_status: 'completed',
      verdict: null,
    });
    expect(res.success).toBe(false);
  });

  it('rejects errored run without an error payload', () => {
    const res = GateAuditRunSchema.safeParse({
      ...baseRun,
      run_status: 'error',
      verdict: null,
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown nested run-result keys', () => {
    expect(
      GateAuditRunSchema.safeParse({
        ...baseRun,
        run_status: 'completed',
        verdict: 'pass',
        tokens: { in: 10, out: 5, total: 15 },
      }).success
    ).toBe(false);
    expect(
      GateAuditRunSchema.safeParse({
        ...baseRun,
        run_status: 'error',
        verdict: null,
        error: { code: 'TIMEOUT', message: '5000ms', retryable: true },
      }).success
    ).toBe(false);
  });
});

describe('GateAuditDispositionSchema', () => {
  it('accepts a policy-excepted disposition', () => {
    const out = GateAuditDispositionSchema.parse({
      disposition_id: '01HXDIS0000000000000000000',
      run_id: '01HXRUN0000000000000000000',
      evaluator_ref: 'core/checkpoint-scope-density',
      disposition: 'policy-excepted',
      reason: 'intentional batching for prep refactor',
      ts: '2026-05-12T23:50:00.000Z',
    });
    expect(out.disposition).toBe('policy-excepted');
  });

  it('rejects a parent-derived field (artifact_id) on the embedded row (strict)', () => {
    const res = GateAuditDispositionSchema.safeParse({
      disposition_id: '01HXDIS0000000000000000000',
      run_id: '01HXRUN0000000000000000000',
      evaluator_ref: 'core/checkpoint-scope-density',
      disposition: 'policy-excepted',
      reason: 'x',
      ts: '2026-05-12T23:50:00.000Z',
      artifact_id: 'leak',
    });
    expect(res.success).toBe(false);
  });

  it('rejects empty reason', () => {
    const res = GateAuditDispositionSchema.safeParse({
      disposition_id: '01HXDIS0000000000000000000',
      run_id: '01HXRUN0000000000000000000',
      evaluator_ref: 'core/checkpoint-scope-density',
      disposition: 'policy-excepted',
      reason: '',
      ts: '2026-05-12T23:50:00.000Z',
    });
    expect(res.success).toBe(false);
  });

  it('rejects the materialized-only "unresolved" value', () => {
    const res = GateAuditDispositionSchema.safeParse({
      disposition_id: '01HXDIS0000000000000000000',
      run_id: '01HXRUN0000000000000000000',
      evaluator_ref: 'core/checkpoint-scope-density',
      disposition: 'unresolved',
      reason: 'x',
      ts: '2026-05-12T23:50:00.000Z',
    });
    expect(res.success).toBe(false);
  });
});

describe('GateAuditPayloadSchema', () => {
  it('accepts a payload with empty runs and dispositions', () => {
    const out = GateAuditPayloadSchema.parse({});
    expect(out.runs).toEqual([]);
    expect(out.dispositions).toEqual([]);
  });

  it('accepts a payload with one run and one disposition', () => {
    const out = GateAuditPayloadSchema.parse({
      runs: [
        {
          ...baseRun,
          run_status: 'completed',
          verdict: 'violation',
        },
      ],
      dispositions: [
        {
          disposition_id: '01HXDIS0000000000000000000',
          run_id: baseRun.run_id,
          evaluator_ref: baseRun.evaluator_ref,
          disposition: 'policy-excepted',
          reason: 'intentional batching',
          ts: baseRun.ts,
        },
      ],
    });
    expect(out.runs).toHaveLength(1);
    expect(out.dispositions).toHaveLength(1);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const res = GateAuditPayloadSchema.safeParse({ runs: [], dispositions: [], extra: 1 });
    expect(res.success).toBe(false);
  });
});
