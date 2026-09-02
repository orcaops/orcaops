import { describe, expect, it } from 'vitest';

import { EvaluatorDispositionPayloadSchema } from './disposition.js';

const baseDispo = {
  schema: 'orcaops.evaluator_disposition/v1',
  disposition_id: '01HXDIS0000000000000000000',
  artifact_id: '01HXART0000000000000000000',
  run_id: '01HXRUN0000000000000000000',
  evaluator_ref: 'core/api-stability',
  reason: 'breaking change deliberate, see ADR-014',
  agent_session_id: null as string | null,
  ts: '2026-05-12T23:50:00.000Z',
};

describe('EvaluatorDispositionPayloadSchema (happy path)', () => {
  it('accepts an acknowledged disposition', () => {
    const out = EvaluatorDispositionPayloadSchema.parse({
      ...baseDispo,
      disposition: 'acknowledged',
    });
    expect(out.disposition).toBe('acknowledged');
  });

  it('accepts a dismissed disposition', () => {
    const out = EvaluatorDispositionPayloadSchema.parse({
      ...baseDispo,
      disposition: 'dismissed',
    });
    expect(out.disposition).toBe('dismissed');
  });

  it('accepts a policy-excepted disposition with an agent_session_id', () => {
    const out = EvaluatorDispositionPayloadSchema.parse({
      ...baseDispo,
      disposition: 'policy-excepted',
      agent_session_id: 'subagent-a',
    });
    expect(out.disposition).toBe('policy-excepted');
    expect(out.agent_session_id).toBe('subagent-a');
  });
});

describe('EvaluatorDispositionPayloadSchema (failure modes)', () => {
  it('rejects the materialized-only "unresolved" value', () => {
    // `unresolved` is a materialized-view-only value, never written.
    const res = EvaluatorDispositionPayloadSchema.safeParse({
      ...baseDispo,
      disposition: 'unresolved',
    });
    expect(res.success).toBe(false);
  });

  it('rejects an empty reason', () => {
    const res = EvaluatorDispositionPayloadSchema.safeParse({
      ...baseDispo,
      disposition: 'acknowledged',
      reason: '',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].path).toEqual(['reason']);
    }
  });

  it('rejects an out-of-enum disposition value', () => {
    const res = EvaluatorDispositionPayloadSchema.safeParse({
      ...baseDispo,
      disposition: 'forgotten' as 'dismissed',
    });
    expect(res.success).toBe(false);
  });

  it('rejects a wrong schema literal', () => {
    const res = EvaluatorDispositionPayloadSchema.safeParse({
      ...baseDispo,
      schema: 'orcaops.evaluator_disposition/v2',
      disposition: 'dismissed',
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const res = EvaluatorDispositionPayloadSchema.safeParse({
      ...baseDispo,
      disposition: 'dismissed',
      extra: 1,
    });
    expect(res.success).toBe(false);
  });
});
