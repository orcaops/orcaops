import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearIdempotencyBlock,
  computePayloadHash,
  findArtifactScopedReplay,
  findThreeOutcomeIdempotency,
  lookupOrInsertPlanIdempotency,
  recordHardRejected,
  recordSoftBlocked,
} from './idempotency.js';
import { PlanIdempotencyPendingError } from '../artifacts/errors.js';
import { canonicalJson } from '../events/canonical-json.js';
import type { EventRecord, EventType, InlineEventRecord } from '../events/event-log.js';
import { Store } from '../store/sqlite.js';

function event(over: {
  event_id: string;
  type: EventType;
  ts?: string;
  idempotency_key?: string;
  payload?: unknown;
}): InlineEventRecord {
  const base = {
    event_id: over.event_id,
    type: over.type,
    ts: over.ts ?? '2026-04-26T12:00:00.000Z',
    schema_version: 1 as const,
    idempotency_key: over.idempotency_key ?? `${over.type}-${over.event_id}`,
    payload: over.payload ?? { id: over.event_id },
  };
  const checksum = createHash('sha256').update(canonicalJson(base), 'utf8').digest('hex');
  return { ...base, checksum };
}

describe('lookupOrInsertPlanIdempotency', () => {
  let tmpRoot: string;
  let store: Store;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-idem-'));
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns "created" with the minted artifact_id on first call for the key', async () => {
    let mintCount = 0;
    const mintArtifactId = (): string => {
      mintCount += 1;
      return `01999999-9999-7000-8000-00000000000${mintCount}`;
    };
    const result = await lookupOrInsertPlanIdempotency({
      store,
      idempotencyKey: 'plan-init-1',
      payload: { task: 't' },
      mintArtifactId,
      now: () => '2026-04-26T12:00:00.000Z',
    });
    expect(result.outcome).toBe('created');
    expect(result.artifactId).toBe('01999999-9999-7000-8000-000000000001');
    expect(mintCount).toBe(1);
    // Row landed in the table for the next call to find.
    expect(store.lookupPlanIdempotency('plan-init-1')).not.toBeNull();
  });

  it('returns "replay" on the second call with the same key (key-only matching)', async () => {
    const ctx = {
      store,
      payload: { task: 't' },
      mintArtifactId: () => '01999999-9999-7000-8000-000000000001',
      now: () => '2026-04-26T12:00:00.000Z',
    };
    const first = await lookupOrInsertPlanIdempotency({ ...ctx, idempotencyKey: 'plan-init-1' });
    expect(first.outcome).toBe('created');

    const second = await lookupOrInsertPlanIdempotency({
      ...ctx,
      idempotencyKey: 'plan-init-1',
      payload: { task: 'completely different' }, // ignored without loadPriorPayload
      mintArtifactId: () => 'should-not-be-called',
    });
    expect(second).toEqual({
      artifactId: '01999999-9999-7000-8000-000000000001',
      outcome: 'replay',
    });
  });

  it('refuses a planless reservation loudly instead of replaying, adopting, or stealing', async () => {
    const ctx = {
      store,
      payload: { task: 't' },
      mintArtifactId: () => '01999999-9999-7000-8000-000000000001',
      now: () => '2026-04-26T12:00:00.000Z',
    };
    const first = await lookupOrInsertPlanIdempotency({ ...ctx, idempotencyKey: 'plan-race-1' });
    expect(first.outcome).toBe('created');

    // The reservation exists but no plan was published (winner in
    // flight, or crashed): every prior design here — replay, adopt,
    // reclaim — produced a phantom success or duplicate artifacts under
    // some interleaving. The contract is a loud retryable refusal.
    await expect(
      lookupOrInsertPlanIdempotency({
        ...ctx,
        idempotencyKey: 'plan-race-1',
        mintArtifactId: () => 'should-not-be-called',
        hasPublishedPlan: () => false,
      })
    ).rejects.toThrow(PlanIdempotencyPendingError);

    // Once the plan is published, replay and payload conflict detection
    // behave exactly as before.
    const conflict = await lookupOrInsertPlanIdempotency({
      ...ctx,
      idempotencyKey: 'plan-race-1',
      payload: { task: 'completely different' },
      mintArtifactId: () => 'should-not-be-called',
      hasPublishedPlan: () => true,
      loadPriorPayload: () => ({ task: 't' }),
    });
    expect(conflict.outcome).toBe('conflict');
  });

  it('the insert-race loser also refuses a planless winner (no phantom replay path)', async () => {
    const ctx = {
      store,
      payload: { task: 't' },
      now: () => '2026-04-26T12:00:00.000Z',
      hasPublishedPlan: () => false,
    };
    // Simulate losing the PRIMARY KEY race: the winner's row is inserted
    // between our lookup miss and our insert. mintArtifactId is the
    // hook point that runs exactly in that window.
    const mintThenLose = (): string => {
      store.insertPlanIdempotency({
        idempotency_key: 'plan-race-2',
        artifact_id: '01999999-9999-7000-8000-00000000aaaa',
        created_at: '2026-04-26T12:00:00.000Z',
      });
      return '01999999-9999-7000-8000-00000000bbbb';
    };
    await expect(
      lookupOrInsertPlanIdempotency({
        ...ctx,
        idempotencyKey: 'plan-race-2',
        mintArtifactId: mintThenLose,
      })
    ).rejects.toThrow(PlanIdempotencyPendingError);
  });

  it('deletePlanIdempotencyIfUnpublished removes only an unpublished reservation', () => {
    const key = 'cond-del-1';
    const artifact = '01999999-9999-7000-8000-00000000cccc';
    store.insertPlanIdempotency({
      idempotency_key: key,
      artifact_id: artifact,
      created_at: '2026-04-26T12:00:00.000Z',
    });
    // Wrong artifact id: no-op.
    expect(store.deletePlanIdempotencyIfUnpublished(key, 'other')).toBe(false);
    expect(store.lookupPlanIdempotency(key)).not.toBeNull();
    // Unpublished: removed.
    expect(store.deletePlanIdempotencyIfUnpublished(key, artifact)).toBe(true);
    expect(store.lookupPlanIdempotency(key)).toBeNull();

    // Published plan: the NOT EXISTS guard prevents deletion.
    const published = '01999999-9999-7000-8000-00000000dddd';
    store.insertPlanIdempotency({
      idempotency_key: 'cond-del-2',
      artifact_id: published,
      created_at: '2026-04-26T12:00:00.000Z',
    });
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: published,
      branch: 'main',
      task: 't',
      agent: 'claude-code',
      base_sha: 'deadbeef',
      started_at: '2026-04-26T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    store.upsertPlanRevision({
      plan: {
        artifact_id: published,
        revision_n: 0,
        captured_at: '2026-04-26T12:00:00.000Z',
        label: 'l',
        rationale: null,
        touched_scope: '[]',
        non_goals: '[]',
        decisions: '[]',
        step_lineage: '{}',
        criterion_lineage: '{}',
        prior_event_id: null,
        source_event_id: 'ev-1',
      },
      steps: [],
    });
    expect(store.deletePlanIdempotencyIfUnpublished('cond-del-2', published)).toBe(false);
    expect(store.lookupPlanIdempotency('cond-del-2')).not.toBeNull();
  });

  it('detects payload conflicts when loadPriorPayload is supplied', async () => {
    const firstPayload = { task: 'original' };
    await lookupOrInsertPlanIdempotency({
      store,
      idempotencyKey: 'plan-init-1',
      payload: firstPayload,
      mintArtifactId: () => '01999999-9999-7000-8000-000000000001',
      now: () => '2026-04-26T12:00:00.000Z',
    });

    const second = await lookupOrInsertPlanIdempotency({
      store,
      idempotencyKey: 'plan-init-1',
      payload: { task: 'changed mid-flight' },
      mintArtifactId: () => 'should-not-be-called',
      now: () => '2026-04-26T12:00:01.000Z',
      loadPriorPayload: () => firstPayload, // simulates reading prior plan_captured event
    });
    expect(second.outcome).toBe('conflict');
    expect(second.artifactId).toBe('01999999-9999-7000-8000-000000000001');
  });

  it('treats structurally-equal payloads as replay (canonical-JSON comparison)', async () => {
    const a = { steps: ['a', 'b'], task: 't' };
    const b = { task: 't', steps: ['a', 'b'] }; // same data, different key order
    await lookupOrInsertPlanIdempotency({
      store,
      idempotencyKey: 'plan-init-1',
      payload: a,
      mintArtifactId: () => '01999999-9999-7000-8000-000000000001',
      now: () => '2026-04-26T12:00:00.000Z',
    });
    const second = await lookupOrInsertPlanIdempotency({
      store,
      idempotencyKey: 'plan-init-1',
      payload: b,
      mintArtifactId: () => 'should-not-be-called',
      now: () => '2026-04-26T12:00:01.000Z',
      loadPriorPayload: () => a,
    });
    expect(second.outcome).toBe('replay');
  });

  it('handles the race-lost path: insert throws PRIMARY KEY → re-read returns replay', async () => {
    // Plant a row to simulate "another process won the insert race."
    store.insertPlanIdempotency({
      idempotency_key: 'plan-race-1',
      artifact_id: '01999999-9999-7000-8000-000000000001',
      created_at: '2026-04-26T12:00:00.000Z',
    });

    // Stub the lookup to miss on the first read, then let the insert fail
    // on PRIMARY KEY — this is the in-flight race.
    let lookupCalls = 0;
    const racedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'lookupPlanIdempotency') {
          return (key: string) => {
            lookupCalls += 1;
            if (lookupCalls === 1) return null; // first lookup misses
            return target.lookupPlanIdempotency(key); // second lookup finds the winner
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;

    const result = await lookupOrInsertPlanIdempotency({
      store: racedStore,
      idempotencyKey: 'plan-race-1',
      payload: { task: 't' },
      mintArtifactId: () => '01999999-9999-7000-8000-000000000099',
      now: () => '2026-04-26T12:00:01.000Z',
    });
    expect(result).toEqual({
      artifactId: '01999999-9999-7000-8000-000000000001',
      outcome: 'replay',
    });
  });
});

describe('findArtifactScopedReplay', () => {
  it('returns first-call when there are no events', async () => {
    const result = await findArtifactScopedReplay({
      events: [],
      type: 'checkpoint_opened',
      idempotencyKey: 'cp-1',
      payload: { n: 1 },
      loadPriorPayload: () => undefined,
    });
    expect(result).toEqual({ kind: 'first-call' });
  });

  it('returns first-call when no event matches the (type, key) pair', async () => {
    const events: EventRecord[] = [
      event({ event_id: 'e-1', type: 'plan_captured', idempotency_key: 'cp-1' }),
      event({ event_id: 'e-2', type: 'checkpoint_opened', idempotency_key: 'cp-2' }),
    ];
    const result = await findArtifactScopedReplay({
      events,
      type: 'checkpoint_opened',
      idempotencyKey: 'cp-1', // matches a plan, NOT a checkpoint
      payload: { n: 1 },
      loadPriorPayload: () => undefined,
    });
    expect(result.kind).toBe('first-call');
  });

  it('returns "replay" when the matched event has a structurally-equal payload', async () => {
    const events: EventRecord[] = [
      event({
        event_id: 'cp-evt-1',
        type: 'checkpoint_opened',
        idempotency_key: 'cp-1',
        payload: { n: 1, summary: 's' },
      }),
    ];
    const result = await findArtifactScopedReplay({
      events,
      type: 'checkpoint_opened',
      idempotencyKey: 'cp-1',
      payload: { summary: 's', n: 1 }, // same data, different key order
      loadPriorPayload: (priorEvent) => ('payload' in priorEvent ? priorEvent.payload : undefined),
    });
    expect(result).toEqual({ kind: 'replay', priorEventId: 'cp-evt-1' });
  });

  it('returns "conflict" when the matched event has a different payload', async () => {
    const events: EventRecord[] = [
      event({
        event_id: 'cp-evt-1',
        type: 'checkpoint_opened',
        idempotency_key: 'cp-1',
        payload: { n: 1, summary: 'original' },
      }),
    ];
    const result = await findArtifactScopedReplay({
      events,
      type: 'checkpoint_opened',
      idempotencyKey: 'cp-1',
      payload: { n: 1, summary: 'changed mid-flight' },
      loadPriorPayload: (priorEvent) => ('payload' in priorEvent ? priorEvent.payload : undefined),
    });
    expect(result).toEqual({ kind: 'conflict', priorEventId: 'cp-evt-1' });
  });

  it('takes the LATEST matching event when the same key appears multiple times', async () => {
    // The architecture allows the same idempotency_key to appear multiple
    // times (legitimate replays of an in-flight operation). A subsequent
    // identical call should resolve as replay against the LATEST one — the
    // most recent state — not the oldest.
    const events: EventRecord[] = [
      event({
        event_id: 'cp-evt-old',
        type: 'checkpoint_opened',
        idempotency_key: 'cp-1',
        payload: { n: 1, summary: 's' },
      }),
      event({
        event_id: 'cp-evt-new',
        type: 'checkpoint_opened',
        idempotency_key: 'cp-1',
        payload: { n: 1, summary: 's' },
      }),
    ];
    const result = await findArtifactScopedReplay({
      events,
      type: 'checkpoint_opened',
      idempotencyKey: 'cp-1',
      payload: { n: 1, summary: 's' },
      loadPriorPayload: (priorEvent) => ('payload' in priorEvent ? priorEvent.payload : undefined),
    });
    expect(result).toEqual({ kind: 'replay', priorEventId: 'cp-evt-new' });
  });

  it('does not match across event types (a plan with key=K does not collide with a checkpoint with key=K)', async () => {
    const events: EventRecord[] = [
      event({
        event_id: 'plan-evt',
        type: 'plan_captured',
        idempotency_key: 'shared-key',
        payload: { task: 't' },
      }),
    ];
    const result = await findArtifactScopedReplay({
      events,
      type: 'checkpoint_opened',
      idempotencyKey: 'shared-key',
      payload: { n: 1 },
      loadPriorPayload: (priorEvent) => ('payload' in priorEvent ? priorEvent.payload : undefined),
    });
    expect(result.kind).toBe('first-call');
  });
});

describe('findThreeOutcomeIdempotency (three-outcome model)', () => {
  let tmpRoot: string;
  let store: Store;
  const artifactId = '01999999-9999-7000-8000-000000000001';

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-idem3-'));
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: artifactId,
      branch: 'main',
      task: 't',
      agent: 'a',
      base_sha: 'sha',
      started_at: '2026-04-26T00:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const baseInput = {
    type: 'checkpoint_opened' as const,
    idempotencyKey: 'open-1',
    payload: { artifact_id: artifactId, declared_step_numbers: [1] },
    loadPriorPayload: (e: EventRecord) => ('payload' in e ? e.payload : undefined),
  };

  it('returns first-call when no event AND no idempotency_blocks record exists', async () => {
    const result = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events: [],
      artifactId,
    });
    expect(result).toEqual({ kind: 'first-call' });
  });

  it('returns replay-committed when matching event in log', async () => {
    const events = [
      event({
        event_id: 'e1',
        type: 'checkpoint_opened',
        idempotency_key: 'open-1',
        payload: { artifact_id: artifactId, declared_step_numbers: [1] },
      }),
    ];
    const result = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events,
      artifactId,
    });
    expect(result).toEqual({ kind: 'replay-committed', priorEventId: 'e1' });
  });

  it('returns conflict (priorOutcome=committed) when event exists with different payload', async () => {
    const events = [
      event({
        event_id: 'e1',
        type: 'checkpoint_opened',
        idempotency_key: 'open-1',
        payload: { artifact_id: artifactId, declared_step_numbers: [9] },
      }),
    ];
    const result = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events,
      artifactId,
    });
    expect(result).toEqual({ kind: 'conflict', priorOutcome: 'committed' });
  });

  it('returns replay-soft-blocked when soft_blocked record matches fingerprint and payload', async () => {
    recordSoftBlocked({
      store,
      artifactId,
      idempotencyKey: 'open-1',
      type: 'checkpoint_opened',
      payload: baseInput.payload,
      envelope: { ok: false, blocked: 'foo' },
      evaluatorFingerprint: 'fp-v1',
    });
    const result = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events: [],
      artifactId,
      currentFingerprint: 'fp-v1',
    });
    expect(result.kind).toBe('replay-soft-blocked');
    if (result.kind !== 'replay-soft-blocked') throw new Error('unreachable');
    expect(result.envelope).toEqual({ ok: false, blocked: 'foo' });
  });

  it('returns reevaluate (fingerprint-mismatch) when soft_blocked fingerprint is stale', async () => {
    recordSoftBlocked({
      store,
      artifactId,
      idempotencyKey: 'open-1',
      type: 'checkpoint_opened',
      payload: baseInput.payload,
      envelope: { ok: false, blocked: 'foo' },
      evaluatorFingerprint: 'fp-v1',
    });
    const result = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events: [],
      artifactId,
      currentFingerprint: 'fp-v2',
    });
    expect(result).toEqual({
      kind: 'reevaluate',
      priorOutcome: 'soft_blocked',
      reason: 'fingerprint-mismatch',
    });
  });

  it('returns reevaluate (hard-rejected-can-clear) when hard_rejected record matches payload', async () => {
    recordHardRejected({
      store,
      artifactId,
      idempotencyKey: 'open-1',
      type: 'checkpoint_opened',
      payload: baseInput.payload,
    });
    const result = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events: [],
      artifactId,
    });
    expect(result).toEqual({
      kind: 'reevaluate',
      priorOutcome: 'hard_rejected',
      reason: 'hard-rejected-can-clear',
    });
  });

  it('returns conflict (priorOutcome=hard_rejected) when hard_rejected payload differs', async () => {
    recordHardRejected({
      store,
      artifactId,
      idempotencyKey: 'open-1',
      type: 'checkpoint_opened',
      payload: { ...baseInput.payload, declared_step_numbers: [9] },
    });
    const result = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events: [],
      artifactId,
    });
    expect(result).toEqual({ kind: 'conflict', priorOutcome: 'hard_rejected' });
  });

  it('returns conflict (priorOutcome=soft_blocked) when soft_blocked payload differs', async () => {
    recordSoftBlocked({
      store,
      artifactId,
      idempotencyKey: 'open-1',
      type: 'checkpoint_opened',
      payload: { ...baseInput.payload, declared_step_numbers: [9] },
      envelope: { ok: false },
      evaluatorFingerprint: 'fp-v1',
    });
    const result = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events: [],
      artifactId,
      currentFingerprint: 'fp-v1',
    });
    expect(result).toEqual({ kind: 'conflict', priorOutcome: 'soft_blocked' });
  });

  it('clearIdempotencyBlock removes a prior record (used on hard_rejected → committed upgrade)', async () => {
    recordHardRejected({
      store,
      artifactId,
      idempotencyKey: 'open-1',
      type: 'checkpoint_opened',
      payload: baseInput.payload,
    });
    clearIdempotencyBlock({
      store,
      artifactId,
      idempotencyKey: 'open-1',
      type: 'checkpoint_opened',
    });
    const after = store.getIdempotencyBlock({
      artifact_id: artifactId,
      idempotency_key: 'open-1',
      event_type: 'checkpoint_opened',
    });
    expect(after).toBeNull();
  });

  it('hard_rejected upgrade flow: record → re-evaluate → clear → commit yields replay-committed', async () => {
    // 1. First call rejected.
    recordHardRejected({
      store,
      artifactId,
      idempotencyKey: 'open-1',
      type: 'checkpoint_opened',
      payload: baseInput.payload,
    });
    // 2. Lookup tells caller to re-evaluate.
    const lookup1 = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events: [],
      artifactId,
    });
    expect(lookup1.kind).toBe('reevaluate');

    // 3. Caller re-evaluates, succeeds, appends event, clears the block.
    clearIdempotencyBlock({
      store,
      artifactId,
      idempotencyKey: 'open-1',
      type: 'checkpoint_opened',
    });
    const events = [
      event({
        event_id: 'e1',
        type: 'checkpoint_opened',
        idempotency_key: 'open-1',
        payload: baseInput.payload,
      }),
    ];
    // 4. Subsequent replay hits the committed event.
    const lookup2 = await findThreeOutcomeIdempotency({
      ...baseInput,
      store,
      events,
      artifactId,
    });
    expect(lookup2).toEqual({ kind: 'replay-committed', priorEventId: 'e1' });
  });

  it('computePayloadHash is canonical-equal across key re-orderings', () => {
    const a = computePayloadHash({ b: 2, a: 1 });
    const b = computePayloadHash({ a: 1, b: 2 });
    expect(a).toBe(b);
  });
});
