import { describe, expect, it } from 'vitest';

import { MAX_EVALUATOR_FINDINGS } from './finding.js';
import {
  CURRENT_RESULT_ENVELOPE_SCHEMA,
  EvaluatorResultEnvelopeSchema,
  EvaluatorResultEnvelopeV2Schema,
  inspectResultEnvelopeProtocol,
  readResultEnvelope,
  REQUIRED_EVALUATOR_SDK_VERSION_LINE,
  unsupportedResultProtocolMessage,
} from './result-envelope.js';

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

  it('rejects the current literal, so a v2 producer is never read as a v1 one', () => {
    const res = EvaluatorResultEnvelopeSchema.safeParse({
      schema: CURRENT_RESULT_ENVELOPE_SCHEMA,
      verdict: 'pass',
      body: 'x',
    });
    expect(res.success).toBe(false);
  });
});

describe('EvaluatorResultEnvelopeV2Schema', () => {
  const base = { schema: CURRENT_RESULT_ENVELOPE_SCHEMA, verdict: 'pass', body: 'PASS' } as const;

  it('accepts an envelope carrying no findings', () => {
    const out = EvaluatorResultEnvelopeV2Schema.parse(base);
    expect(out.findings).toBeUndefined();
  });

  it('accepts an explicitly empty findings array', () => {
    expect(EvaluatorResultEnvelopeV2Schema.parse({ ...base, findings: [] }).findings).toEqual([]);
  });

  it('accepts findings under every verdict', () => {
    for (const verdict of ['pass', 'violation', 'info'] as const) {
      const res = EvaluatorResultEnvelopeV2Schema.safeParse({
        ...base,
        verdict,
        findings: [{ title: 'something worth saying' }],
      });
      expect(res.success).toBe(true);
    }
  });

  it('accepts findings alongside raw and metrics', () => {
    const out = EvaluatorResultEnvelopeV2Schema.parse({
      ...base,
      verdict: 'violation',
      raw: { scanned: ['a.ts'] },
      metrics: { files_scanned: 1 },
      findings: [
        {
          key: 'drift/a.ts',
          title: 'Exported signature changed without a note',
          locations: [{ kind: 'file', path: 'a.ts', start_line: 3 }],
        },
      ],
    });
    expect(out.findings).toHaveLength(1);
  });

  it('rejects the superseded literal', () => {
    expect(
      EvaluatorResultEnvelopeV2Schema.safeParse({ ...base, schema: 'orcaops.evaluator_result/v1' })
        .success
    ).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(EvaluatorResultEnvelopeV2Schema.safeParse({ ...base, stray: 1 }).success).toBe(false);
  });

  it('rejects an unknown key inside a finding', () => {
    expect(
      EvaluatorResultEnvelopeV2Schema.safeParse({
        ...base,
        findings: [{ title: 'x', severity: 'block' }],
      }).success
    ).toBe(false);
  });

  it('accepts more findings than the bound, which the runner truncates rather than refuses', () => {
    const many = Array.from({ length: MAX_EVALUATOR_FINDINGS + 1 }, (_, i) => ({
      title: `finding ${i}`,
    }));
    expect(EvaluatorResultEnvelopeV2Schema.safeParse({ ...base, findings: many }).success).toBe(
      true
    );
  });

  it('accepts a violation whose findings are over every bound, so no length decides a gate', () => {
    const res = EvaluatorResultEnvelopeV2Schema.safeParse({
      ...base,
      verdict: 'violation',
      findings: Array.from({ length: MAX_EVALUATOR_FINDINGS + 1 }, () => ({
        title: 'x'.repeat(5000),
        detail: 'd'.repeat(9000),
      })),
    });
    expect(res.success).toBe(true);
    expect(res.data?.verdict).toBe('violation');
  });

  it('rejects two findings claiming the same key', () => {
    expect(
      EvaluatorResultEnvelopeV2Schema.safeParse({
        ...base,
        findings: [
          { key: 'same', title: 'a' },
          { key: 'same', title: 'b' },
        ],
      }).success
    ).toBe(false);
  });
});

describe('inspectResultEnvelopeProtocol', () => {
  it('reports the current literal', () => {
    expect(inspectResultEnvelopeProtocol({ schema: CURRENT_RESULT_ENVELOPE_SCHEMA })).toEqual({
      status: 'current',
    });
  });

  it('reports the old literal as superseded, not as a malformed envelope', () => {
    expect(
      inspectResultEnvelopeProtocol({
        schema: 'orcaops.evaluator_result/v1',
        verdict: 'pass',
        body: 'PASS',
      })
    ).toEqual({ status: 'superseded', schema: 'orcaops.evaluator_result/v1' });
  });

  it('reports an unrecognised literal as unknown, carrying it for the diagnostic', () => {
    expect(inspectResultEnvelopeProtocol({ schema: 'orcaops.evaluator_result/v9' })).toEqual({
      status: 'unknown',
      schema: 'orcaops.evaluator_result/v9',
    });
  });

  it('reports a value that declares no usable literal as undeclared', () => {
    for (const value of [
      null,
      undefined,
      'a string',
      42,
      [],
      [{ schema: CURRENT_RESULT_ENVELOPE_SCHEMA }],
      {},
      { verdict: 'pass', body: 'PASS' },
      { schema: 7 },
      { schema: '' },
      { schema: null },
    ]) {
      expect(inspectResultEnvelopeProtocol(value)).toEqual({ status: 'undeclared' });
    }
  });

  it('declines to negotiate over an over-long literal', () => {
    expect(inspectResultEnvelopeProtocol({ schema: 'x'.repeat(201) })).toEqual({
      status: 'undeclared',
    });
  });
});

describe('unsupportedResultProtocolMessage', () => {
  it('tells an author with a v1 producer which package to upgrade and to rebuild', () => {
    const message = unsupportedResultProtocolMessage({
      status: 'superseded',
      schema: 'orcaops.evaluator_result/v1',
    });
    expect(message).toContain('orcaops.evaluator_result/v1');
    expect(message).toContain('no longer runs');
    expect(message).toContain('@orcaops/evaluator-sdk');
    expect(message).toContain(REQUIRED_EVALUATOR_SDK_VERSION_LINE);
    expect(message).toContain('rebuild the pack');
    expect(message).toContain(CURRENT_RESULT_ENVELOPE_SCHEMA);
  });

  it('names an unrecognised literal and what this release does read', () => {
    const message = unsupportedResultProtocolMessage({
      status: 'unknown',
      schema: 'orcaops.evaluator_result/v9',
    });
    expect(message).toContain('orcaops.evaluator_result/v9');
    expect(message).toContain('does not recognise');
    expect(message).toContain(CURRENT_RESULT_ENVELOPE_SCHEMA);
    expect(message).toContain(REQUIRED_EVALUATOR_SDK_VERSION_LINE);
  });

  it('gives both engines one wording', () => {
    const protocol = { status: 'unknown', schema: 'x' } as const;
    expect(unsupportedResultProtocolMessage(protocol)).toBe(
      unsupportedResultProtocolMessage(protocol)
    );
  });
});

describe('readResultEnvelope', () => {
  const base = { schema: CURRENT_RESULT_ENVELOPE_SCHEMA, verdict: 'violation', body: 'VIOLATION' };

  it('reads an envelope that supplies no findings', () => {
    const read = readResultEnvelope(base);
    expect(read.status).toBe('ok');
    expect(read.status === 'ok' && read.findings.status).toBe('absent');
  });

  it('reads the findings an envelope supplies', () => {
    const read = readResultEnvelope({ ...base, findings: [{ key: 'k', title: 'a finding' }] });
    expect(read.status === 'ok' && read.findings.status).toBe('ok');
  });

  it('keeps the verdict when only the findings fail', () => {
    const read = readResultEnvelope({ ...base, findings: [{ title: 'x', severity: 'block' }] });
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.envelope.verdict).toBe('violation');
    expect(read.findings.status).toBe('unreadable');
  });

  it('keeps the verdict when the findings are not even an array', () => {
    const read = readResultEnvelope({ ...base, findings: 'lots' });
    expect(read.status === 'ok' && read.findings.status).toBe('unreadable');
  });

  it('keeps the verdict when two findings claim one key', () => {
    const read = readResultEnvelope({
      ...base,
      findings: [
        { key: 'same', title: 'a' },
        { key: 'same', title: 'b' },
      ],
    });
    expect(read.status === 'ok' && read.findings.status).toBe('unreadable');
  });

  it('reports an envelope wrong anywhere else as invalid, which is still an error run', () => {
    for (const value of [
      { ...base, verdict: 'maybe' },
      { ...base, body: 7 },
      { ...base, stray: 1 },
      { schema: 'orcaops.evaluator_result/v1', verdict: 'pass', body: '' },
      'not an object',
    ]) {
      expect(readResultEnvelope(value).status).toBe('invalid');
    }
  });

  it('accepts findings over every bound, leaving truncation to the caller', () => {
    const read = readResultEnvelope({
      ...base,
      findings: Array.from({ length: MAX_EVALUATOR_FINDINGS + 5 }, () => ({
        title: 'x'.repeat(2000),
      })),
    });
    expect(read.status === 'ok' && read.findings.status).toBe('ok');
  });
});
