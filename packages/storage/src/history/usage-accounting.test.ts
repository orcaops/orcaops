import { describe, expect, it } from 'vitest';

import {
  aggregateCanonicalUsage,
  deriveCanonicalUsageSnapshot,
  estimateArtifactUsage,
  type UsageAccountingEvent,
  usageModelKey,
  usageSessionKey,
} from './usage-accounting.js';
import { uuidv7 } from '../ids/uuidv7.js';
import type { AgentUsageSnapshotPayload } from '../schema/usage-ledger.js';
import { deriveUsageLedgerRecord } from '../usage/record.js';
import type { RecordUsageSnapshotInput } from '../usage/snapshot-input.js';

function counters(input: number) {
  return {
    input_tokens: input,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}
function observation(
  input: number,
  options: Partial<AgentUsageSnapshotPayload> = {},
  ts = '2026-09-05T00:00:00.000Z'
): UsageAccountingEvent {
  const payload: AgentUsageSnapshotPayload = {
    snapshot_id: uuidv7(),
    idempotency_key: uuidv7(),
    agent: 'codex',
    session_id: 'session',
    artifact_id: 'artifact',
    source_plan_ref_id: null,
    lifecycle_event: 'plan',
    checkpoint_n: null,
    cumulative_usage: counters(input),
    delta_usage: null,
    baseline_kind: 'first_observation',
    model_breakdown: [{ model: 'model', cumulative: counters(input), delta: null }],
    record_count: 1,
    as_of: ts,
    ...options,
  };
  const { record } = deriveUsageLedgerRecord({
    type: 'agent_usage_snapshot_recorded',
    ts,
    idempotency_key: payload.idempotency_key,
    payload,
  });
  return { record, payload, completeness: { state: 'complete', reasons: [] } };
}
function sourceLink(artifactId: string, time: string): UsageAccountingEvent {
  const payload = {
    artifact_id: artifactId,
    canonical_ref_id: 'cloud:plan',
    linked_at: time,
    pinned_version: '2',
  };
  const { record } = deriveUsageLedgerRecord({
    type: 'source_plan_linked',
    ts: time,
    idempotency_key: uuidv7(),
    payload,
  });
  return { record, payload, completeness: { state: 'complete', reasons: [] } };
}
function input(count = 200): RecordUsageSnapshotInput {
  return {
    agent: 'codex',
    session_id: 'session',
    artifact_id: 'artifact',
    lifecycle_event: 'checkpoint_close',
    checkpoint_n: 1,
    cumulative_usage: { ...counters(count), dimensions: { reasoning: 7 } },
    model_breakdown: [{ model: 'model', cumulative: counters(count) }],
    record_count: 2,
    as_of: '2026-09-05T00:03:00.000Z',
    ts: '2026-09-05T00:03:00.000Z',
    baseline_hint: 'prior_same_artifact',
    idempotency_key: 'next',
  };
}

describe('canonical usage accounting', () => {
  it('deduplicates mirrored snapshots and shared sessions before exact totals', () => {
    const first = observation(100);
    const second = observation(200, { artifact_id: 'other' }, '2026-09-05T00:01:00.000Z');
    const result = aggregateCanonicalUsage(
      [
        { projectId: 'a', events: [first, second] },
        { projectId: 'b', events: [first, second] },
      ],
      { artifactIds: ['artifact'] }
    );
    expect(result).toMatchObject({ status: 'exact', totals: counters(200) });
    expect(result.sessions).toHaveLength(1);
    expect(estimateArtifactUsage([first, second], 'artifact').totals).toEqual(counters(0));
  });

  it('distinguishes the full agent-session tuple across projects', () => {
    expect(usageSessionKey('a:b', 'c')).not.toBe(usageSessionKey('a', 'b:c'));
    const result = aggregateCanonicalUsage([
      { projectId: 'a', events: [observation(100)] },
      { projectId: 'b', events: [observation(200, { agent: 'claude-code' })] },
    ]);
    expect(result.totals).toEqual(counters(300));
    expect(result.sessions).toHaveLength(2);
  });

  it('preserves each model rate and geography partition and rich high-water ordering', () => {
    const partitions = [
      { model: 'model' },
      { model: 'model', speed: 'fast' },
      { model: 'model', service_tier: 'priority' },
      { model: 'model', inference_geo: 'us' },
    ].map((rate) => ({ ...rate, cumulative: counters(25), delta: null }));
    expect(new Set(partitions.map(usageModelKey)).size).toBe(4);
    const first = observation(100, { model_breakdown: partitions });
    const second = observation(
      100,
      {
        model_breakdown: partitions,
        cumulative_usage: { ...counters(100), dimensions: { reasoning: 10 } },
      },
      '2026-09-05T00:01:00.000Z'
    );
    const result = aggregateCanonicalUsage([{ projectId: 'a', events: [second, first] }]);
    expect(result.status).toBe('exact');
    expect(result.sessions[0]).toMatchObject({
      model_breakdown: partitions,
      dimensions: { reasoning: 10 },
    });
  });

  it('chooses newer source facts on equal counters even when their capture timestamp is older', () => {
    const old = observation(100, { as_of: '2026-09-05T01:00:00Z' }, '2026-09-05T04:00:00Z');
    const newer = observation(
      100,
      {
        as_of: '2026-09-05T02:00:00Z',
        record_count: 2,
        cumulative_usage: { ...counters(100), dimensions: { reasoning: 20 } },
        model_breakdown: [
          {
            model: 'model',
            cumulative: { ...counters(100), dimensions: { reasoning: 20 } },
            delta: null,
          },
        ],
      },
      '2026-09-05T03:00:00Z'
    );
    const result = aggregateCanonicalUsage([{ projectId: 'a', events: [old, newer] }]);
    expect(result.status).toBe('exact');
    expect(result.sessions[0]).toMatchObject({
      as_of: '2026-09-05T02:00:00Z',
      record_count: 2,
      dimensions: { reasoning: 20 },
      model_breakdown: [{ cumulative: { dimensions: { reasoning: 20 } } }],
    });
  });

  it('uses source-plan links as time-bounded session selection while retaining session lifetime totals', () => {
    const early = observation(100, { artifact_id: null, source_plan_ref_id: 'cloud:plan' });
    const later = observation(
      200,
      { artifact_id: null, source_plan_ref_id: 'cloud:plan' },
      '2026-09-05T00:02:00.000Z'
    );
    const unrelated = observation(
      900,
      { session_id: 'late-session', artifact_id: null, source_plan_ref_id: 'cloud:plan' },
      '2026-09-05T00:02:00.000Z'
    );
    const events = [early, later, unrelated, sourceLink('target', '2026-09-05T00:01:00.000Z')];
    expect(
      aggregateCanonicalUsage([{ projectId: 'a', events }], { artifactIds: ['target'] }).totals
    ).toEqual(counters(200));
    expect(estimateArtifactUsage(events, 'target').totals).toEqual(counters(0));
  });

  it('retains observed scalar high-water while refusing incompatible resets as exact', () => {
    const first = observation(200);
    const second = observation(100, {}, '2026-09-05T00:01:00.000Z');
    const result = aggregateCanonicalUsage([{ projectId: 'a', events: [second, first] }]);
    expect(result).toMatchObject({ status: 'partial', totals: null, known_exact_totals: null });
    expect(result.sessions[0]).toMatchObject({ totals: null, observed_high_water: counters(200) });
    expect(result.sessions[0].reasons).toContain('incompatible cumulative counter reset');
  });

  it('marks both sessions affected by a divergent duplicate event identity', () => {
    const first = observation(100);
    const second = observation(200, { agent: 'claude-code' });
    second.record = deriveUsageLedgerRecord({
      event_id: first.record.event_id,
      type: second.record.type,
      ts: second.record.ts,
      idempotency_key: second.record.idempotency_key,
      payload: second.payload,
    }).record;
    const result = aggregateCanonicalUsage([
      { projectId: 'a', events: [first] },
      { projectId: 'b', events: [second] },
    ]);
    expect(result.status).toBe('partial');
    expect(result.sessions.every((session) => session.status === 'incomplete')).toBe(true);
    expect(result.known_exact_totals).toBeNull();
  });

  it('never reports missing schema facts or unavailable ledgers as exact zero', () => {
    const event = observation(100);
    delete (event.payload as Record<string, unknown>).model_breakdown;
    event.completeness = {
      state: 'incomplete',
      reasons: ['historical model dimensions unavailable'],
    };
    const missing = aggregateCanonicalUsage([{ projectId: 'a', events: [event] }]);
    expect(missing).toMatchObject({
      status: 'unavailable',
      totals: null,
      known_exact_totals: null,
    });
    expect(missing.reasons).toContain('historical model dimensions unavailable');
    const partial = aggregateCanonicalUsage([
      { projectId: 'a', events: [observation(100)] },
      { projectId: 'b', events: [], unavailable: ['source unavailable'] },
    ]);
    expect(partial).toMatchObject({
      status: 'partial',
      totals: null,
      known_exact_totals: counters(100),
    });
  });

  it('reports lost model dimensions and inconsistent partitions explicitly', () => {
    const first = observation(100, {
      model_breakdown: [
        {
          model: 'model',
          cumulative: { ...counters(100), dimensions: { reasoning: 4 } },
          delta: null,
        },
      ],
    });
    const second = observation(200, {}, '2026-09-05T00:01:00.000Z');
    expect(
      aggregateCanonicalUsage([{ projectId: 'a', events: [first, second] }]).sessions[0].reasons
    ).toContain('incomplete model dimensions history');
    const inconsistent = observation(100, {
      model_breakdown: [{ model: 'model', cumulative: counters(10), delta: null }],
    });
    expect(
      aggregateCanonicalUsage([{ projectId: 'a', events: [inconsistent] }]).sessions[0].reasons
    ).toContain('model partitions do not match session counters');
  });

  it('preserves first-observation, same-artifact, checkpoint and whole-session baselines', () => {
    expect(deriveCanonicalUsageSnapshot(input(), []).delta_usage).toBeNull();
    const first = observation(100, { checkpoint_n: 1, lifecycle_event: 'checkpoint_open' });
    const same = deriveCanonicalUsageSnapshot(input(), [first]);
    expect(same).toMatchObject({
      baseline_kind: 'prior_same_artifact',
      delta_usage: counters(100),
      cumulative_usage: { dimensions: { reasoning: 7 } },
    });
    const checkpoint = deriveCanonicalUsageSnapshot(
      { ...input(), baseline_hint: 'checkpoint_open' },
      [first]
    );
    expect(checkpoint).toMatchObject({
      baseline_kind: 'checkpoint_open',
      delta_usage: counters(100),
    });
    const resumed = deriveCanonicalUsageSnapshot({ ...input(), session_id: 'resumed' }, [first]);
    expect(resumed).toMatchObject({ baseline_kind: 'whole_session', delta_usage: counters(200) });
    expect(resumed.delta_usage).not.toHaveProperty('dimensions');
  });

  it('uses the source-plan baseline and avoids a future snapshot', () => {
    const earlier = observation(100, { artifact_id: null, source_plan_ref_id: 'cloud:plan' });
    const future = observation(
      500,
      { artifact_id: null, source_plan_ref_id: 'cloud:plan' },
      '2026-09-05T00:05:00.000Z'
    );
    const result = deriveCanonicalUsageSnapshot(
      {
        ...input(),
        artifact_id: null,
        source_plan_ref_id: 'cloud:plan',
        baseline_hint: 'prior_same_source_plan',
      },
      [future, earlier]
    );
    expect(result).toMatchObject({
      baseline_kind: 'prior_same_source_plan',
      delta_usage: counters(100),
    });
    earlier.completeness = { state: 'incomplete', reasons: ['source incomplete'] };
    expect(() =>
      deriveCanonicalUsageSnapshot(
        {
          ...input(),
          artifact_id: null,
          source_plan_ref_id: 'cloud:plan',
          baseline_hint: 'prior_same_source_plan',
        },
        [earlier]
      )
    ).toThrow('incomplete retained source facts');
  });

  it('keeps attribution estimates separate and selects the last checkpoint stamp', () => {
    const first = observation(100, { checkpoint_n: 1, lifecycle_event: 'checkpoint_open' });
    const middle = observation(
      200,
      {
        checkpoint_n: 1,
        lifecycle_event: 'checkpoint_close',
        baseline_kind: 'checkpoint_open',
        delta_usage: counters(100),
      },
      '2026-09-05T00:01:00.000Z'
    );
    const last = observation(
      250,
      {
        checkpoint_n: 1,
        lifecycle_event: 'checkpoint_close',
        baseline_kind: 'checkpoint_open',
        delta_usage: counters(150),
      },
      '2026-09-05T00:02:00.000Z'
    );
    const events = [last, middle, first, last];
    const estimate = estimateArtifactUsage(events, 'artifact');
    expect(estimate).toMatchObject({ kind: 'estimate', totals: counters(150) });
    expect(estimate.checkpoints).toHaveLength(1);
    expect(estimate.checkpoints[0].deltas).toEqual(counters(150));
    expect(aggregateCanonicalUsage([{ projectId: 'a', events }]).totals).toEqual(counters(250));
  });

  it('refuses an aggregate beyond safe integer precision', () => {
    const result = aggregateCanonicalUsage([
      {
        projectId: 'a',
        events: [observation(Number.MAX_SAFE_INTEGER), observation(1, { session_id: 'other' })],
      },
    ]);
    expect(result).toMatchObject({ status: 'partial', totals: null, known_exact_totals: null });
    expect(result.reasons).toContain('aggregate exceeds safe integer precision');
  });
});
