import { describe, expect, it } from 'vitest';

import type { CodingSessionRow, EvaluatorRunStatsRow } from '@orcaops/storage';

import {
  computeDurationStats,
  computeEvaluatorRates,
  computeRevisionChurn,
  mergeCodingSessions,
} from './stats.js';

/** Pure stats collectors. Raw-row sources are store-tested. */

describe('computeEvaluatorRates', () => {
  const row = (over: Partial<EvaluatorRunStatsRow>): EvaluatorRunStatsRow => ({
    evaluator_ref: 'core/x',
    phase: 'checkpoint-close',
    total: 0,
    completed: 0,
    pass: 0,
    violation: 0,
    info: 0,
    error: 0,
    skipped: 0,
    ...over,
  });

  it('pass_rate = pass / (pass + violation); info/error/skipped excluded', () => {
    const [r] = computeEvaluatorRates([
      row({ total: 10, completed: 7, pass: 3, violation: 1, info: 3, error: 2, skipped: 1 }),
    ]);
    expect(r.pass_rate).toBe(0.75);
  });

  it('null on a zero denominator (nothing graded)', () => {
    const [infoOnly, skippedOnly] = computeEvaluatorRates([
      row({ total: 2, completed: 2, info: 2 }),
      row({ total: 1, skipped: 1 }),
    ]);
    expect(infoOnly.pass_rate).toBeNull();
    expect(skippedOnly.pass_rate).toBeNull();
  });
});

describe('computeRevisionChurn', () => {
  it('histogram + revised count + max/mean over per-artifact latest revision_n', () => {
    const churn = computeRevisionChurn([
      { max_revision_n: 0 },
      { max_revision_n: 0 },
      { max_revision_n: 2 },
      { max_revision_n: 6 },
    ]);
    expect(churn).toEqual({
      artifacts_with_plan: 4,
      revised_artifacts: 2,
      max_revisions: 6,
      mean_revisions: 2,
      histogram: { '0': 2, '2': 1, '6': 1 },
    });
  });

  it('zero-shaped on empty input', () => {
    expect(computeRevisionChurn([])).toEqual({
      artifacts_with_plan: 0,
      revised_artifacts: 0,
      max_revisions: 0,
      mean_revisions: 0,
      histogram: {},
    });
  });
});

describe('computeDurationStats', () => {
  const interval = (minutes: number): { opened_at: string; closed_at: string } => ({
    opened_at: '2026-06-29T00:00:00.000Z',
    closed_at: `2026-06-29T00:${String(minutes).padStart(2, '0')}:00.000Z`,
  });

  it('odd count: median is the middle; p90 is nearest-rank', () => {
    const s = computeDurationStats([interval(1), interval(3), interval(10)]);
    expect(s.closed_total).toBe(3);
    expect(s.min_ms).toBe(60_000);
    expect(s.max_ms).toBe(600_000);
    expect(s.median_ms).toBe(180_000);
    // ceil(0.9 * 3) - 1 = 2 → the 10-minute interval.
    expect(s.p90_ms).toBe(600_000);
    expect(s.mean_ms).toBe(((1 + 3 + 10) / 3) * 60_000);
  });

  it('even count: median averages the two middles', () => {
    const s = computeDurationStats([interval(1), interval(2), interval(4), interval(8)]);
    expect(s.median_ms).toBe(180_000);
    // ceil(0.9 * 4) - 1 = 3 → the 8-minute interval.
    expect(s.p90_ms).toBe(480_000);
  });

  it('null aggregates on zero closed checkpoints', () => {
    expect(computeDurationStats([])).toEqual({
      closed_total: 0,
      min_ms: null,
      max_ms: null,
      mean_ms: null,
      median_ms: null,
      p90_ms: null,
    });
  });
});

describe('mergeCodingSessions', () => {
  const session = (over: Partial<CodingSessionRow>): CodingSessionRow => ({
    agent: 'codex',
    session_id: 'session-1',
    cumulative_input_tokens: 0,
    cumulative_output_tokens: 0,
    cumulative_cache_creation_input_tokens: 0,
    cumulative_cache_read_input_tokens: 0,
    as_of: '2026-08-01T00:00:00.000Z',
    record_count: 1,
    ...over,
  });

  it('deduplicates mirrored identities with fieldwise cumulative maxima', () => {
    expect(
      mergeCodingSessions([
        [session({ cumulative_input_tokens: 10, cumulative_output_tokens: 30 })],
        [
          session({
            cumulative_input_tokens: 20,
            cumulative_output_tokens: 25,
            cumulative_cache_read_input_tokens: 40,
            as_of: '2026-08-02T00:00:00.000Z',
            record_count: 2,
          }),
          session({ session_id: 'session-2', cumulative_input_tokens: 5 }),
        ],
      ])
    ).toEqual([
      session({
        cumulative_input_tokens: 20,
        cumulative_output_tokens: 30,
        cumulative_cache_read_input_tokens: 40,
        as_of: '2026-08-02T00:00:00.000Z',
        record_count: 2,
      }),
      session({ session_id: 'session-2', cumulative_input_tokens: 5 }),
    ]);
  });
});
