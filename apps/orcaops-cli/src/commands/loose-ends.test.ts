import { describe, expect, it } from 'vitest';

import { collectLooseEnds, type LooseEndsInput } from './loose-ends.js';

const NOW = '2026-07-01T12:00:00.000Z';

const STEPS = [
  { step_id: 's1', label: 'Step one', text: 'do the first thing' },
  { step_id: 's2', label: 'Step two', text: 'do the second thing' },
  { step_id: 's3', label: 'Step three', text: 'do the third thing' },
];

describe('collectLooseEnds', () => {
  it('surfaces the exercised finding kinds with provenance', () => {
    const input: LooseEndsInput = {
      planSteps: STEPS,
      closedCheckpoints: [
        {
          n: 1,
          closed_at: '2026-06-30T10:00:00.000Z',
          completed_step_ids: ['s1'],
          uncertainty: ['TTL strategy unclear', 'schema shape guessed'],
        },
      ],
      openCheckpoints: [{ n: 2, opened_at: '2026-07-01T11:00:00.000Z', declared_step_ids: ['s2'] }],
      summary: null,
      now: NOW,
    };
    const le = collectLooseEnds(input);

    expect(le.uncertainty).toEqual([
      {
        checkpoint_n: 1,
        closed_at: '2026-06-30T10:00:00.000Z',
        entries: ['TTL strategy unclear', 'schema shape guessed'],
      },
    ]);
    // s1 claimed (closed), s2 declared (open) → only s3 uncovered.
    expect(le.uncovered_steps).toEqual([
      { step_id: 's3', label: 'Step three', text: 'do the third thing' },
    ]);
    expect(le.open_checkpoints).toEqual([
      { n: 2, opened_at: '2026-07-01T11:00:00.000Z', age_seconds: 3600 },
    ]);
    expect(le.no_summary).toBe(true);
    // 2 uncertainty + 1 uncovered + 1 open cp + 1 no_summary
    expect(le.finding_count).toBe(5);
  });

  it('summary findings carry the summary ts', () => {
    const le = collectLooseEnds({
      planSteps: [],
      closedCheckpoints: [],
      openCheckpoints: [],
      summary: {
        open_items: ['revisit rate limits'],
        deferred_decisions: ['sharding later'],
        ts: '2026-06-30T18:00:00.000Z',
      },
      now: NOW,
    });
    expect(le.open_items).toEqual([
      { text: 'revisit rate limits', ts: '2026-06-30T18:00:00.000Z' },
    ]);
    expect(le.deferred_decisions).toEqual([
      { text: 'sharding later', ts: '2026-06-30T18:00:00.000Z' },
    ]);
    expect(le.no_summary).toBe(false);
    expect(le.finding_count).toBe(2);
  });

  it('a fully-delivered summarized artifact has zero findings', () => {
    const le = collectLooseEnds({
      planSteps: [STEPS[0]],
      closedCheckpoints: [
        {
          n: 1,
          closed_at: '2026-06-30T10:00:00.000Z',
          completed_step_ids: ['s1'],
          uncertainty: [],
        },
      ],
      openCheckpoints: [],
      summary: { open_items: [], deferred_decisions: [], ts: '2026-06-30T18:00:00.000Z' },
      now: NOW,
    });
    expect(le.finding_count).toBe(0);
  });

  it('counts an unreadable artifact even when every derived bucket is empty', () => {
    const le = collectLooseEnds({
      planSteps: [STEPS[0]],
      closedCheckpoints: [
        {
          n: 1,
          closed_at: '2026-06-30T10:00:00.000Z',
          completed_step_ids: ['s1'],
          uncertainty: [],
        },
      ],
      openCheckpoints: [],
      summary: { open_items: [], deferred_decisions: [], ts: '2026-06-30T18:00:00.000Z' },
      artifactUnreadable: true,
      now: NOW,
    });
    expect(le.finding_count).toBe(1);
  });

  it('a bare plan with no work and no summary is itself a loose end', () => {
    const le = collectLooseEnds({
      planSteps: [STEPS[0]],
      closedCheckpoints: [],
      openCheckpoints: [],
      summary: null,
      now: NOW,
    });
    // 1 uncovered step + no_summary
    expect(le.finding_count).toBe(2);
    expect(le.no_summary).toBe(true);
  });

  it('open-checkpoint age clamps to zero for clock skew', () => {
    const le = collectLooseEnds({
      planSteps: [],
      closedCheckpoints: [],
      openCheckpoints: [{ n: 1, opened_at: '2026-07-01T12:00:05.000Z', declared_step_ids: [] }],
      summary: null,
      now: NOW,
    });
    expect(le.open_checkpoints[0].age_seconds).toBe(0);
  });
});
