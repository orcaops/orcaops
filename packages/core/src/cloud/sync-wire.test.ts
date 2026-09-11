import { describe, expect, it } from 'vitest';

import type { ArtifactUsageData } from './hash.js';
import { toWireEvaluators, toWireUsage } from './sync-wire.js';

describe('toWireEvaluators', () => {
  const baseRun = {
    schema: 'orcaops.evaluator_run/v1' as const,
    run_id: '01HXRUN0000000000000000000',
    artifact_id: '01HXART0000000000000000000',
    evaluator_ref: 'core/api-stability',
    package_id: 'core',
    evaluator_id: 'api-stability',
    severity: 'block' as const,
    run_status: 'completed' as const,
    verdict: 'violation' as const,
    body: 'VIOLATION',
    ts: '2026-05-12T20:30:00.000Z',
    source_event_index: 4,
    local_kind_rank: 0 as const,
    local_index: 0,
    disposition: 'unresolved' as const,
  };

  it('preserves checkpoint-open and checkpoint-close as distinct phases (no collapse)', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [
        { ...baseRun, run_id: 'r-open', phase: 'checkpoint-open' },
        {
          ...baseRun,
          run_id: 'r-close',
          phase: 'checkpoint-close',
          source_event_index: 5,
        },
      ],
      dispositions: [],
    }) as unknown as {
      runs: Array<{ phase: string; run_id: string }>;
      dispositions: unknown[];
    };
    const phases = wire.runs.map((r) => r.phase);
    expect(phases).toContain('checkpoint-open');
    expect(phases).toContain('checkpoint-close');
    expect(phases).not.toContain('post-checkpoint');
  });

  it('sends run_status, verdict, and disposition as separate fields', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [{ ...baseRun, phase: 'checkpoint-close' }],
      dispositions: [],
    }) as unknown as {
      runs: Array<{ run_status: string; verdict: string | null; disposition: string | null }>;
    };
    expect(wire.runs[0].run_status).toBe('completed');
    expect(wire.runs[0].verdict).toBe('violation');
    expect(wire.runs[0].disposition).toBe('unresolved');
  });

  it('keeps the local provider field off the frozen cloud wire', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [{ ...baseRun, phase: 'checkpoint-close', provider: 'claude' }],
      dispositions: [],
    });
    expect(wire.runs[0]).not.toHaveProperty('provider');
  });

  it('emits the dispositions[] array as a separate top-level field', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [{ ...baseRun, phase: 'checkpoint-close', disposition: 'acknowledged' }],
      dispositions: [
        {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: 'd-1',
          artifact_id: 'a-1',
          run_id: 'r-1',
          evaluator_ref: 'core/api-stability',
          disposition: 'acknowledged',
          reason: 'ack',
          agent_session_id: null,
          ts: '2026-05-12T20:35:00.000Z',
          source_event_index: 5,
          local_kind_rank: 1,
          local_index: 0,
        },
      ],
    }) as unknown as {
      dispositions: Array<{ disposition: string; run_id: string }>;
    };
    expect(wire.dispositions).toHaveLength(1);
    expect(wire.dispositions[0].disposition).toBe('acknowledged');
  });

  it('forwards order-key components on each run and disposition', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [
        {
          ...baseRun,
          phase: 'checkpoint-close',
          source_event_index: 7,
          local_kind_rank: 0,
          local_index: 2,
        },
      ],
      dispositions: [
        {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: 'd-1',
          artifact_id: 'a-1',
          run_id: 'r-1',
          evaluator_ref: 'core/api-stability',
          disposition: 'acknowledged',
          reason: 'ack',
          agent_session_id: null,
          ts: '2026-05-12T20:35:00.000Z',
          source_event_index: 8,
          local_kind_rank: 1,
          local_index: 0,
        },
      ],
    }) as unknown as {
      runs: Array<{
        source_event_index: number;
        local_kind_rank: number;
        local_index: number;
      }>;
      dispositions: Array<{
        source_event_index: number;
        local_kind_rank: number;
        local_index: number;
      }>;
    };
    expect(wire.runs[0]).toMatchObject({
      source_event_index: 7,
      local_kind_rank: 0,
      local_index: 2,
    });
    expect(wire.dispositions[0]).toMatchObject({
      source_event_index: 8,
      local_kind_rank: 1,
      local_index: 0,
    });
  });

  it('omits optional fields when not present on the materialized row', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [{ ...baseRun, phase: 'checkpoint-close' }],
      dispositions: [],
    }) as unknown as {
      runs: Array<Record<string, unknown>>;
    };
    expect(wire.runs[0].raw).toBeUndefined();
    expect(wire.runs[0].metrics).toBeUndefined();
    expect(wire.runs[0].tokens).toBeUndefined();
    expect(wire.runs[0].cost_usd).toBeUndefined();
    expect(wire.runs[0].model).toBeUndefined();
  });

  it('preserves null verdict and null disposition for errored / skipped runs', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [
        {
          ...baseRun,
          run_id: 'r-error',
          phase: 'checkpoint-close',
          run_status: 'error',
          verdict: null,
          body: 'ERROR',
          error: { code: 'TIMEOUT', message: 'timed out' },
          disposition: null,
        },
      ],
      dispositions: [],
    }) as unknown as {
      runs: Array<{ run_status: string; verdict: null; disposition: null; error: unknown }>;
    };
    expect(wire.runs[0].verdict).toBeNull();
    expect(wire.runs[0].disposition).toBeNull();
    expect(wire.runs[0].error).toEqual({ code: 'TIMEOUT', message: 'timed out' });
  });
});

describe('toWireUsage', () => {
  const ISO = '2026-01-01T00:00:00.000Z';
  const snapshot = (over: Record<string, unknown> = {}) =>
    ({
      snapshot_id: 'snap-1',
      idempotency_key: 'idem-1',
      session_id: 'sess-1',
      agent: 'claude-code',
      artifact_id: 'a1',
      source_plan_ref_id: null,
      lifecycle_event: 'checkpoint_close',
      checkpoint_n: 2,
      cumulative_input_tokens: 10,
      cumulative_output_tokens: 5,
      cumulative_cache_creation_input_tokens: 1,
      cumulative_cache_read_input_tokens: 20,
      delta_input_tokens: 4,
      delta_output_tokens: 2,
      delta_cache_creation_input_tokens: 0,
      delta_cache_read_input_tokens: 8,
      baseline_kind: 'checkpoint_open',
      model_breakdown: JSON.stringify([
        {
          model: 'm',
          cumulative: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 20,
          },
          delta: {
            input_tokens: 4,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 8,
          },
        },
      ]),
      record_count: 3,
      as_of: ISO,
      ts: ISO,
      ...over,
    }) as unknown as ArtifactUsageData['snapshots'][number];
  const mk = (over: Partial<ArtifactUsageData> = {}): ArtifactUsageData => ({
    sessions: [],
    snapshots: [snapshot()],
    modelBreakdowns: [],
    source_plan_links: [],
    anchor: 'x',
    ...over,
  });
  const session = (over: Record<string, unknown> = {}) =>
    ({
      agent: 'claude-code',
      session_id: 'sess-1',
      cumulative_input_tokens: 10,
      cumulative_output_tokens: 5,
      cumulative_cache_creation_input_tokens: 1,
      cumulative_cache_read_input_tokens: 20,
      as_of: ISO,
      record_count: 3,
      ...over,
    }) as unknown as ArtifactUsageData['sessions'][number];
  const modelBreakdown = (json: string) =>
    ({
      agent: 'claude-code',
      session_id: 'sess-1',
      model_breakdown: json,
    }) as unknown as ArtifactUsageData['modelBreakdowns'][number];

  it('renames native token names to wire names and drops every delta (cumulative-only)', () => {
    const wire = toWireUsage(mk(), 'a1');
    expect(wire.schema_version).toBe(1);
    expect(wire.artifact_id).toBe('a1');
    expect(wire.snapshots[0].cumulative).toEqual({
      in: 10,
      out: 5,
      cache_read: 20,
      cache_write: 1,
    });
    expect(Object.keys(wire.snapshots[0]).some((k) => k.includes('delta'))).toBe(false);
    expect(wire.snapshots[0].model_breakdown[0]).toEqual({
      model: 'm',
      cumulative: { in: 10, out: 5, cache_read: 20, cache_write: 1 },
    });
    expect(wire.snapshots[0].model_breakdown[0]).not.toHaveProperty('delta');
  });

  it('treats malformed stored model_breakdown JSON as empty', () => {
    const wire = toWireUsage(
      mk({
        sessions: [session()],
        snapshots: [snapshot({ model_breakdown: '{' })],
        modelBreakdowns: [modelBreakdown('{')],
      }),
      'a1'
    );

    expect(wire.sessions[0].model_breakdown).toEqual([]);
    expect(wire.snapshots[0].model_breakdown).toEqual([]);
  });

  it('treats schema-invalid stored model_breakdown JSON as empty', () => {
    const invalidBreakdown = JSON.stringify([
      {
        model: 'm',
        cumulative: { input_tokens: 10 },
        delta: null,
      },
    ]);
    const wire = toWireUsage(
      mk({
        sessions: [session()],
        snapshots: [snapshot({ model_breakdown: invalidBreakdown })],
        modelBreakdowns: [modelBreakdown(invalidBreakdown)],
      }),
      'a1'
    );

    expect(wire.sessions[0].model_breakdown).toEqual([]);
    expect(wire.snapshots[0].model_breakdown).toEqual([]);
  });

  it('omits checkpoint_n / pinned_version when null and passes a null artifact_id through', () => {
    const wire = toWireUsage(
      mk({
        snapshots: [
          snapshot({
            checkpoint_n: null,
            artifact_id: null,
            source_plan_ref_id: 'cloud:ext1',
            baseline_kind: 'first_observation',
          }),
        ],
        source_plan_links: [
          {
            source_plan_ref_id: 'cloud:ext1',
            artifact_id: 'a1',
            linked_at: ISO,
            pinned_version: null,
          } as unknown as ArtifactUsageData['source_plan_links'][number],
        ],
      }),
      'a1'
    );
    expect(wire.snapshots[0]).not.toHaveProperty('checkpoint_n');
    expect(wire.snapshots[0].artifact_id).toBeNull();
    expect(wire.source_plan_links[0]).not.toHaveProperty('pinned_version');
    expect(wire.source_plan_links[0].source_plan_ref_id).toBe('cloud:ext1');
  });

  it('emits dimensions + rate classes on the session total, per-model cumulative, and the snapshot', () => {
    const richBreakdown = JSON.stringify([
      {
        model: 'claude-haiku-4-5-20251001',
        speed: 'fast',
        service_tier: 'batch',
        inference_geo: 'us',
        cumulative: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 20,
          dimensions: { cache_creation_5m_input_tokens: 1, web_search_requests: 2 },
        },
        delta: null,
      },
    ]);
    const wire = toWireUsage(
      mk({
        sessions: [session()],
        snapshots: [
          snapshot({
            model_breakdown: richBreakdown,
            dimensions: JSON.stringify({ cache_creation_1h_input_tokens: 7 }),
          }),
        ],
        modelBreakdowns: [
          {
            agent: 'claude-code',
            session_id: 'sess-1',
            model_breakdown: richBreakdown,
            dimensions: JSON.stringify({
              cache_creation_1h_input_tokens: 7,
              cache_creation_5m_input_tokens: 1,
            }),
          } as unknown as ArtifactUsageData['modelBreakdowns'][number],
        ],
      }),
      'a1'
    );
    // The session total carries the high-water session-total dimensions (joined
    // from the per-session breakdown row, since CodingSessionRow has no JSON column).
    expect(wire.sessions[0].total.dimensions).toEqual({
      cache_creation_1h_input_tokens: 7,
      cache_creation_5m_input_tokens: 1,
    });
    // The per-model entry carries the three rate classes + the per-model dimensions.
    const pm = wire.sessions[0].model_breakdown[0];
    expect(pm.speed).toBe('fast');
    expect(pm.service_tier).toBe('batch');
    expect(pm.inference_geo).toBe('us');
    expect(pm.cumulative.dimensions).toEqual({
      cache_creation_5m_input_tokens: 1,
      web_search_requests: 2,
    });
    // The snapshot cumulative carries the snapshot-total dimensions column, and the
    // snapshot's own per-model breakdown carries the rate classes too.
    expect(wire.snapshots[0].cumulative.dimensions).toEqual({ cache_creation_1h_input_tokens: 7 });
    expect(wire.snapshots[0].model_breakdown[0].speed).toBe('fast');
  });

  it('omits dimensions + rate classes entirely for a default session (byte-identical wire)', () => {
    const plainBreakdown = JSON.stringify([
      {
        model: 'm',
        cumulative: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 20,
        },
        delta: null,
      },
    ]);
    const wire = toWireUsage(
      mk({
        sessions: [session()],
        snapshots: [snapshot({ model_breakdown: plainBreakdown })],
        modelBreakdowns: [modelBreakdown(plainBreakdown)],
      }),
      'a1'
    );
    expect(wire.sessions[0].total).not.toHaveProperty('dimensions');
    expect(wire.snapshots[0].cumulative).not.toHaveProperty('dimensions');
    const pm = wire.sessions[0].model_breakdown[0];
    expect(pm).not.toHaveProperty('speed');
    expect(pm).not.toHaveProperty('service_tier');
    expect(pm).not.toHaveProperty('inference_geo');
    expect(pm.cumulative).not.toHaveProperty('dimensions');
  });
});
