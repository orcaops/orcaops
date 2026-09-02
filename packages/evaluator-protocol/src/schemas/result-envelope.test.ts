import { describe, expect, it } from 'vitest';

import { EvaluatorResultEnvelopeSchema } from './result-envelope.js';

describe('EvaluatorResultEnvelopeSchema (happy path)', () => {
  it('accepts a minimal pass envelope', () => {
    const out = EvaluatorResultEnvelopeSchema.parse({
      schema: 'orcaops.evaluator_result/v1',
      verdict: 'pass',
      body: 'PASS\n\nNothing to flag.',
    });
    expect(out.verdict).toBe('pass');
  });

  it('accepts a violation envelope with raw + metrics', () => {
    const out = EvaluatorResultEnvelopeSchema.parse({
      schema: 'orcaops.evaluator_result/v1',
      verdict: 'violation',
      body: 'VIOLATION\n\n## findings\n- foo',
      raw: { findings: [{ file: 'src/foo.py', line: 12 }] },
      metrics: { files_scanned: 42, findings_count: 1 },
    });
    expect(out.raw).toEqual({ findings: [{ file: 'src/foo.py', line: 12 }] });
    expect(out.metrics).toEqual({ files_scanned: 42, findings_count: 1 });
  });

  it('accepts an info envelope', () => {
    const out = EvaluatorResultEnvelopeSchema.parse({
      schema: 'orcaops.evaluator_result/v1',
      verdict: 'info',
      body: 'INFO\n\nObservation.',
    });
    expect(out.verdict).toBe('info');
  });
});

describe('EvaluatorResultEnvelopeSchema (failure modes)', () => {
  it('rejects a wrong schema literal', () => {
    const res = EvaluatorResultEnvelopeSchema.safeParse({
      schema: 'orcaops.evaluator_result/v0',
      verdict: 'pass',
      body: '',
    });
    expect(res.success).toBe(false);
  });

  it('rejects an out-of-enum verdict', () => {
    const res = EvaluatorResultEnvelopeSchema.safeParse({
      schema: 'orcaops.evaluator_result/v1',
      verdict: 'maybe' as 'pass',
      body: '',
    });
    expect(res.success).toBe(false);
  });

  it('rejects missing body', () => {
    const res = EvaluatorResultEnvelopeSchema.safeParse({
      schema: 'orcaops.evaluator_result/v1',
      verdict: 'pass',
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const res = EvaluatorResultEnvelopeSchema.safeParse({
      schema: 'orcaops.evaluator_result/v1',
      verdict: 'pass',
      body: 'x',
      stray: 1,
    });
    expect(res.success).toBe(false);
  });

  it('rejects non-numeric metrics values', () => {
    const res = EvaluatorResultEnvelopeSchema.safeParse({
      schema: 'orcaops.evaluator_result/v1',
      verdict: 'pass',
      body: 'x',
      metrics: { count: '12' as unknown as number },
    });
    expect(res.success).toBe(false);
  });
});
