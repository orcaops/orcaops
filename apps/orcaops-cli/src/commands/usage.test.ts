import { describe, expect, it } from 'vitest';

import type { UsageSnapshotRow } from '@orcaops/storage';

import { aggregateModelTotals, collectCheckpointDeltas } from './usage.js';

describe('aggregateModelTotals', () => {
  const breakdown = (
    entries: Array<{ model: string; input?: number; output?: number }>
  ): { model_breakdown: string } => ({
    model_breakdown: JSON.stringify(
      entries.map((e) => ({
        model: e.model,
        cumulative: {
          input_tokens: e.input ?? 0,
          output_tokens: e.output ?? 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        delta: null,
      }))
    ),
  });

  it('sums per-model cumulative across sessions, sorted by model', () => {
    const out = aggregateModelTotals([
      breakdown([
        { model: 'claude-opus-4-8', input: 100, output: 10 },
        { model: 'claude-haiku-4-5', input: 5, output: 1 },
      ]),
      breakdown([{ model: 'claude-opus-4-8', input: 200, output: 20 }]),
    ]);
    expect(out.map((m) => m.model)).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
    expect(out[1].input_tokens).toBe(300);
    expect(out[1].output_tokens).toBe(30);
    expect(out[0].input_tokens).toBe(5);
  });

  it('skips malformed JSON, non-array payloads, and entries without model/cumulative', () => {
    const out = aggregateModelTotals([
      { model_breakdown: 'not json' },
      { model_breakdown: '{"model":"x"}' },
      { model_breakdown: JSON.stringify([{ nope: true }, { model: 42, cumulative: {} }]) },
      breakdown([{ model: 'claude-opus-4-8', input: 7 }]),
    ]);
    expect(out).toEqual([
      {
        model: 'claude-opus-4-8',
        input_tokens: 7,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    ]);
  });

  it('returns [] on empty input', () => {
    expect(aggregateModelTotals([])).toEqual([]);
  });
});

describe('collectCheckpointDeltas', () => {
  let seq = 0;
  const snap = (over: Partial<UsageSnapshotRow>): UsageSnapshotRow => {
    seq += 1;
    return {
      snapshot_id: `snap-${seq}`,
      idempotency_key: `key-${seq}`,
      artifact_id: 'art-1',
      source_plan_ref_id: null,
      agent: 'claude-code',
      session_id: 'sess-1',
      lifecycle_event: 'checkpoint-close',
      checkpoint_n: 1,
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
      cumulative_cache_creation_input_tokens: 0,
      cumulative_cache_read_input_tokens: 0,
      delta_input_tokens: 0,
      delta_output_tokens: 0,
      delta_cache_creation_input_tokens: 0,
      delta_cache_read_input_tokens: 0,
      baseline_kind: 'checkpoint_open',
      model_breakdown: '[]',
      dimensions: '{}',
      record_count: 1,
      as_of: '2026-07-01T00:00:00.000Z',
      ts: `2026-07-01T00:00:0${Math.min(seq, 9)}.000Z`,
      ...over,
    };
  };

  it('takes the LAST row per (checkpoint, agent, session) — never sums (150, not 250)', () => {
    // The ledger double-count fixture: two checkpoint_open-baselined stamps
    // inside one window, deltas 100 then 150 (cumulative-since-open).
    const out = collectCheckpointDeltas([
      snap({ delta_input_tokens: 100, lifecycle_event: 'pre-pr-check' }),
      snap({ delta_input_tokens: 150 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].deltas.input_tokens).toBe(150);
    expect(out[0].lifecycle_event).toBe('checkpoint-close');
  });

  it('skips non-checkpoint_open baselines, null checkpoint_n, and null deltas', () => {
    const out = collectCheckpointDeltas([
      snap({ baseline_kind: 'whole_session', delta_input_tokens: 999 }),
      snap({ checkpoint_n: null, delta_input_tokens: 999 }),
      snap({ delta_input_tokens: null }),
      snap({ delta_input_tokens: 42 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].deltas.input_tokens).toBe(42);
  });

  it('keeps separate entries per session and orders by checkpoint then agent/session', () => {
    const out = collectCheckpointDeltas([
      snap({ checkpoint_n: 2, session_id: 'sess-b', delta_input_tokens: 5 }),
      snap({ checkpoint_n: 1, session_id: 'sess-b', delta_input_tokens: 3 }),
      snap({ checkpoint_n: 1, session_id: 'sess-a', delta_input_tokens: 7 }),
    ]);
    expect(out.map((d) => [d.checkpoint_n, d.session_id])).toEqual([
      [1, 'sess-a'],
      [1, 'sess-b'],
      [2, 'sess-b'],
    ]);
  });
});
