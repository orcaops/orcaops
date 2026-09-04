import { describe, expect, it } from 'vitest';

import {
  collectArtifactDecisions,
  type CollectDecisionsInput,
  recordWindowFromFlags,
} from './decisions.js';

const BASE: CollectDecisionsInput = {
  planDecisions: [
    {
      decision: 'use redis',
      reason: 'already deployed',
      evidence: { kind: 'git-commit', commit_sha: 'a'.repeat(40), quote: 'use redis' },
      revision_n: 0,
    },
    {
      decision: 'load config from env',
      reason: 'per-route thresholds',
      alternatives_considered: [{ option: 'hardcode', rejected_because: 'unconfigurable' }],
      revision_n: 1,
    },
  ],
  revisionCapturedAt: new Map([
    [0, '2026-06-01T10:00:00.000Z'],
    [1, '2026-06-20T10:00:00.000Z'],
  ]),
  closedCheckpoints: [
    {
      n: 1,
      closed_at: '2026-06-21T12:00:00.000Z',
      decisions: [{ decision: 'adopt existing pattern', reason: 'less new surface' }],
    },
    {
      n: 2,
      closed_at: '2026-06-22T12:00:00.000Z',
      decisions: [
        // Malformed entries must be skipped, not crash.
        null,
        'not-an-object',
        { reason: 'no decision text' },
        { decision: 'split the module', reason: 'file too large' },
      ],
    },
  ],
  deferredDecisions: ['revisit sharding later'],
  summaryTs: '2026-06-23T09:00:00.000Z',
};

describe('collectArtifactDecisions', () => {
  it('merges the three sources with per-record ts and provenance', () => {
    const records = collectArtifactDecisions(BASE);
    expect(records).toHaveLength(5);

    const plan = records.filter((r) => r.source === 'plan');
    expect(plan.map((r) => r.ts)).toEqual(['2026-06-01T10:00:00.000Z', '2026-06-20T10:00:00.000Z']);
    expect(plan[1].alternatives_considered).toHaveLength(1);
    expect(plan[0].evidence).toEqual({
      kind: 'git-commit',
      commit_sha: 'a'.repeat(40),
      quote: 'use redis',
    });
    expect(plan.map((r) => r.revision_n)).toEqual([0, 1]);

    const cps = records.filter((r) => r.source === 'checkpoint');
    expect(cps.map((r) => r.checkpoint_n)).toEqual([1, 2]);
    expect(cps.map((r) => r.ts)).toEqual(['2026-06-21T12:00:00.000Z', '2026-06-22T12:00:00.000Z']);

    const deferred = records.filter((r) => r.source === 'summary_deferred');
    expect(deferred).toEqual([
      {
        source: 'summary_deferred',
        ts: '2026-06-23T09:00:00.000Z',
        decision: 'revisit sharding later',
        reason: null,
      },
    ]);
  });

  it('no window ⇒ all records', () => {
    expect(collectArtifactDecisions(BASE, {})).toHaveLength(5);
  });

  it('window filters records — cumulative plan decisions from old revisions drop out', () => {
    // The killer case: an artifact active recently must not surface its
    // years-old plan decisions when the caller asked for a recent window.
    const records = collectArtifactDecisions(BASE, { lower: '2026-06-21T00:00:00.000Z' });
    expect(records.map((r) => r.source)).toEqual(['checkpoint', 'checkpoint', 'summary_deferred']);

    const upper = collectArtifactDecisions(BASE, { upper: '2026-06-01T23:59:59.999Z' });
    expect(upper).toHaveLength(1);
    expect(upper[0]).toMatchObject({ source: 'plan', revision_n: 0 });
  });

  it('a record with no resolvable ts is dropped under a window but kept without one', () => {
    const input: CollectDecisionsInput = {
      ...BASE,
      revisionCapturedAt: new Map(), // revision rows missing → plan ts null
      closedCheckpoints: [],
      deferredDecisions: [],
      summaryTs: null,
    };
    expect(collectArtifactDecisions(input)).toHaveLength(2);
    expect(collectArtifactDecisions(input, { lower: '1970-01-01T00:00:00.000Z' })).toHaveLength(0);
  });
});

describe('recordWindowFromFlags', () => {
  it('empty flags ⇒ empty window', () => {
    expect(recordWindowFromFlags({})).toEqual({});
  });

  it('single pair passes through', () => {
    expect(
      recordWindowFromFlags({
        since: '2026-01-01T00:00:00.000Z',
        until: '2026-01-02T00:00:00.000Z',
      })
    ).toEqual({ lower: '2026-01-01T00:00:00.000Z', upper: '2026-01-02T00:00:00.000Z' });
  });

  it('both pairs intersect: latest lower, earliest upper', () => {
    expect(
      recordWindowFromFlags({
        since: '2026-01-01T00:00:00.000Z',
        activeSince: '2026-01-05T00:00:00.000Z',
        until: '2026-01-31T00:00:00.000Z',
        activeUntil: '2026-01-20T00:00:00.000Z',
      })
    ).toEqual({ lower: '2026-01-05T00:00:00.000Z', upper: '2026-01-20T00:00:00.000Z' });
  });
});
