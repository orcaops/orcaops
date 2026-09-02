import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readUsageLedger } from './ledger-log.js';
import {
  rebuildUsageLedger,
  type RecordUsageSnapshotInput,
  replayUsageEventsIntoStore,
  UsageLedger,
} from './ledger.js';
import { usageLedgerPath, usageSidecarsDir } from '../artifacts/paths.js';
import { type AgentUsage } from '../schema/usage-ledger.js';
import { Store } from '../store/sqlite.js';

let tmp: string;
let store: Store;
let ledger: UsageLedger;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'orcaops-usage-'));
  store = new Store(path.join(tmp, '.orcaops', 'cache', 'cache.db'));
  ledger = new UsageLedger({ repoRoot: tmp, store });
});
afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

function mkUsage(i = 0, o = 0, cw = 0, cr = 0): AgentUsage {
  return {
    input_tokens: i,
    output_tokens: o,
    cache_creation_input_tokens: cw,
    cache_read_input_tokens: cr,
  };
}

function mk(over: Partial<RecordUsageSnapshotInput>): RecordUsageSnapshotInput {
  return {
    agent: 'claude-code',
    session_id: 's1',
    artifact_id: 'a1',
    source_plan_ref_id: null,
    lifecycle_event: 'checkpoint_close',
    checkpoint_n: null,
    cumulative_usage: mkUsage(0),
    model_breakdown: [],
    record_count: 1,
    as_of: '2026-01-01T00:00:00.000Z',
    ts: '2026-01-01T00:00:00.000Z',
    baseline_hint: 'prior_same_artifact',
    idempotency_key: 'k',
    ...over,
  };
}

describe('UsageLedger baseline semantics', () => {
  it('a genuinely first stamp is first_observation with NULL delta', async () => {
    const r = await ledger.appendUsageSnapshot(
      mk({ cumulative_usage: mkUsage(100, 50, 10, 200), idempotency_key: 'k1' })
    );
    expect(r.replayed).toBe(false);
    expect(r.snapshot.baseline_kind).toBe('first_observation');
    expect(r.snapshot.delta_usage).toBeNull();

    const sessions = store.listCodingSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cumulative_input_tokens).toBe(100);
    // delta NULL → contributes nothing to the (estimated) attribution
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(0);
  });

  it('a later same-session stamp deltas against the prior (prior_same_artifact)', async () => {
    await ledger.appendUsageSnapshot(
      mk({
        cumulative_usage: mkUsage(100, 50, 10, 200),
        idempotency_key: 'k1',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    const r2 = await ledger.appendUsageSnapshot(
      mk({
        cumulative_usage: mkUsage(180, 70, 10, 300),
        idempotency_key: 'k2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    expect(r2.snapshot.baseline_kind).toBe('prior_same_artifact');
    expect(r2.snapshot.delta_usage).toEqual(mkUsage(80, 20, 0, 100));

    // exact session total = MAX(cumulative)
    expect(store.listCodingSessions()[0].cumulative_input_tokens).toBe(180);
    // attribution = SUM(delta) = first(null) + 80
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(80);
  });

  it('checkpoint_open baselines a close against its open (close − open)', async () => {
    await ledger.appendUsageSnapshot(
      mk({
        lifecycle_event: 'checkpoint_open',
        checkpoint_n: 1,
        cumulative_usage: mkUsage(100),
        idempotency_key: 'open1',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    const close = await ledger.appendUsageSnapshot(
      mk({
        lifecycle_event: 'checkpoint_close',
        checkpoint_n: 1,
        cumulative_usage: mkUsage(170),
        baseline_hint: 'checkpoint_open',
        idempotency_key: 'close1',
        ts: '2026-01-01T00:10:00.000Z',
      })
    );
    expect(close.snapshot.baseline_kind).toBe('checkpoint_open');
    expect(close.snapshot.delta_usage).toEqual(mkUsage(70));
  });

  it('keys on (agent, session_id): a different agent with the same session_id is a separate session', async () => {
    await ledger.appendUsageSnapshot(
      mk({
        agent: 'claude-code',
        session_id: 'shared',
        cumulative_usage: mkUsage(100),
        idempotency_key: 'k1',
      })
    );
    const r = await ledger.appendUsageSnapshot(
      mk({
        agent: 'codex',
        session_id: 'shared',
        cumulative_usage: mkUsage(50),
        idempotency_key: 'k2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    // never subtract across the agent boundary: codex's first leg is whole_session
    expect(r.snapshot.baseline_kind).toBe('whole_session');
    expect(r.snapshot.delta_usage).toEqual(mkUsage(50));

    const sessions = store.listCodingSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.agent).sort()).toEqual(['claude-code', 'codex']);
  });

  it('a resumed leg (artifact seen under a different session) auto-baselines whole_session', async () => {
    await ledger.appendUsageSnapshot(
      mk({ session_id: 's1', cumulative_usage: mkUsage(100), idempotency_key: 'k1' })
    );
    const r = await ledger.appendUsageSnapshot(
      mk({
        session_id: 's2',
        cumulative_usage: mkUsage(40, 10, 0, 5),
        idempotency_key: 'k2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    expect(r.snapshot.baseline_kind).toBe('whole_session');
    expect(r.snapshot.delta_usage).toEqual(mkUsage(40, 10, 0, 5)); // re-orientation captured from session-start

    expect(store.listCodingSessions()).toHaveLength(2);
    // a1 attribution = s1 first(null) + s2 whole_session(40)
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(40);
  });

  it('a fresh unrelated second session on a NEW artifact is first_observation, not whole_session', async () => {
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's1',
        artifact_id: 'a1',
        cumulative_usage: mkUsage(100),
        idempotency_key: 'k1',
      })
    );
    const r = await ledger.appendUsageSnapshot(
      mk({
        session_id: 's2',
        artifact_id: 'a2',
        cumulative_usage: mkUsage(50),
        idempotency_key: 'k2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    expect(r.snapshot.baseline_kind).toBe('first_observation');
    expect(r.snapshot.delta_usage).toBeNull();
  });
});

describe('UsageLedger idempotency + concurrency', () => {
  it('reapplies session invalidation when a projected snapshot is replayed after restoration', async () => {
    const input = mk({ cumulative_usage: mkUsage(100), idempotency_key: 'restored-replay' });
    await ledger.appendUsageSnapshot(input);
    store.upsertArtifact({
      id: 'a1',
      branch: 'main',
      task: 'restored',
      label: 'restored',
      agent: 'codex',
      base_sha: 'sha',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: null,
      status: 'active',
      non_goals: '[]',
    });
    store.setCloudSyncState('a1', {
      syncedAt: '2026-01-01T00:01:00.000Z',
      hash: 'restored-hash',
      externalId: 'a1',
      orgId: 'org',
    });

    const replay = await ledger.appendUsageSnapshot(input);

    expect(replay.replayed).toBe(true);
    expect(store.getCloudSyncStateForArtifact('a1')?.pending).toBe(true);
    expect(store.getCloudSyncRawHash('a1')).toMatch(/^dirty:[^:]+:restored-hash$/);
  });

  it('projects the last valid form when an archive contains a repaired duplicate key', async () => {
    await ledger.appendUsageSnapshot(
      mk({ artifact_id: 'a1', cumulative_usage: mkUsage(100), idempotency_key: 'duplicate' })
    );
    const [original] = await readUsageLedger({
      ledgerPath: usageLedgerPath(tmp),
      sidecarsDir: usageSidecarsDir(tmp),
      containmentRoot: tmp,
    });
    expect(original).toBeDefined();
    const replacement = {
      ...original!,
      payload: {
        ...(original!.payload as Record<string, unknown>),
        artifact_id: 'a2',
      },
    };

    store.clearUsageProjection();
    const result = replayUsageEventsIntoStore(store, [original!, replacement]);

    expect(result.snapshots).toBe(1);
    expect(store.getUsageSnapshotByKey('duplicate')?.artifact_id).toBe('a2');
  });

  it('projects only the last source-plan link when repair appends an authoritative form', () => {
    const original = {
      event_id: '01999999-9999-7000-8000-000000000001',
      type: 'source_plan_linked' as const,
      ts: '2026-01-01T00:00:00.000Z',
      idempotency_key: 'duplicate-link',
      payload: {
        canonical_ref_id: 'cloud:divergent',
        artifact_id: 'a1',
        linked_at: '2026-01-01T00:00:00.000Z',
        pinned_version: null,
      },
    };
    const replacement = {
      ...original,
      payload: { ...original.payload, canonical_ref_id: 'cloud:authoritative' },
    };

    const result = replayUsageEventsIntoStore(store, [original, replacement]);

    expect(result.links).toBe(1);
    expect(store.hasSourcePlanLink('cloud:divergent', 'a1')).toBe(false);
    expect(store.hasSourcePlanLink('cloud:authoritative', 'a1')).toBe(true);
  });

  it('re-appending the same idempotency_key is a no-op replay (no SUM(delta) inflation)', async () => {
    await ledger.appendUsageSnapshot(mk({ cumulative_usage: mkUsage(100), idempotency_key: 'k1' }));
    await ledger.appendUsageSnapshot(
      mk({ cumulative_usage: mkUsage(180), idempotency_key: 'k2', ts: '2026-01-01T00:05:00.000Z' })
    );
    const attributedBefore = store.attributedArtifactUsage('a1').input_tokens; // 80

    const replay = await ledger.appendUsageSnapshot(
      mk({ cumulative_usage: mkUsage(180), idempotency_key: 'k2', ts: '2026-01-01T00:05:00.000Z' })
    );
    expect(replay.replayed).toBe(true);
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(attributedBefore);
    expect(store.readUsageSnapshots('a1')).toHaveLength(2);
  });

  it('concurrent same-session stamps of the same read telescope (no SUM(delta) inflation)', async () => {
    // 5 subagents that each read the transcript at the SAME cumulative and stamp.
    const inputs = Array.from({ length: 5 }, (_, i) =>
      mk({
        cumulative_usage: mkUsage(100, 20, 0, 0),
        idempotency_key: `c${i}`,
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    const results = await Promise.all(inputs.map((i) => ledger.appendUsageSnapshot(i)));

    // all 5 recorded (lock serialized them; UNIQUE keys, no crash)
    expect(results.every((r) => !r.replayed)).toBe(true);
    expect(store.readUsageSnapshots('a1')).toHaveLength(5);
    // exactly one first_observation; the rest delta against the same cumulative → 0
    const nullDeltas = store.readUsageSnapshots('a1').filter((r) => r.delta_input_tokens === null);
    expect(nullDeltas).toHaveLength(1);
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(0); // NOT 5×100
    expect(store.listCodingSessions()[0].cumulative_input_tokens).toBe(100); // exact total stays right
  });
});

describe('UsageLedger order-independent attribution', () => {
  it('reversed-order same-scope stamps attribute the same as chronological', async () => {
    // Record the LATER cumulative FIRST, then the EARLIER one. SUM(delta) gives
    // 0 here (the later stamp is first_observation/null; the earlier one clamps
    // to 0 against the future-ts high-water row) — the order-dependence bug.
    await ledger.appendUsageSnapshot(
      mk({
        cumulative_usage: mkUsage(180, 70, 10, 300),
        idempotency_key: 'late',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        cumulative_usage: mkUsage(100, 50, 10, 200),
        idempotency_key: 'early',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    // High-water span = MAX(cumulative) − first-by-ts floor — identical to the
    // chronological result (mkUsage(80,20,0,100)), independent of insertion order.
    expect(store.attributedArtifactUsage('a1')).toEqual({
      input_tokens: 80,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 100,
    });
    // The beforeTs bound also keeps the audit delta sane: the out-of-order
    // 'early' stamp does NOT baseline against the future-ts 'late' row.
    const early = store.getUsageSnapshotByKey('early');
    expect(early?.baseline_kind).toBe('first_observation');
  });

  it('overlapping checkpoint windows do not double-count the overlap', async () => {
    // Two overlapping checkpoints in one session: cp1 [100→200], cp2 [150→250].
    // The 150→200 span sits in BOTH close deltas, so SUM(delta) overcounts
    // (50 + 100 + 100 = 250). The high-water span is the true 250−100 = 150.
    const open1 = mk({
      lifecycle_event: 'checkpoint_open',
      checkpoint_n: 1,
      cumulative_usage: mkUsage(100),
      idempotency_key: 'o1',
      ts: '2026-01-01T00:00:00.000Z',
    });
    const open2 = mk({
      lifecycle_event: 'checkpoint_open',
      checkpoint_n: 2,
      cumulative_usage: mkUsage(150),
      idempotency_key: 'o2',
      ts: '2026-01-01T00:05:00.000Z',
    });
    const close1 = mk({
      lifecycle_event: 'checkpoint_close',
      checkpoint_n: 1,
      baseline_hint: 'checkpoint_open',
      cumulative_usage: mkUsage(200),
      idempotency_key: 'c1',
      ts: '2026-01-01T00:10:00.000Z',
    });
    const close2 = mk({
      lifecycle_event: 'checkpoint_close',
      checkpoint_n: 2,
      baseline_hint: 'checkpoint_open',
      cumulative_usage: mkUsage(250),
      idempotency_key: 'c2',
      ts: '2026-01-01T00:15:00.000Z',
    });
    for (const i of [open1, open2, close1, close2]) await ledger.appendUsageSnapshot(i);

    // Sanity: the embedded deltas DO overcount (audit-only) — 50+100+100 = 250…
    const sumDelta = store
      .readUsageSnapshots('a1')
      .reduce((s, r) => s + (r.delta_input_tokens ?? 0), 0);
    expect(sumDelta).toBe(250);
    // …but the attribution span is the true session work (250 − 100 floor).
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(150);
    expect(store.listCodingSessions()[0].cumulative_input_tokens).toBe(250);
  });

  it('a whole_session first row floors at zero (counts from session start)', async () => {
    await ledger.appendUsageSnapshot(
      mk({
        baseline_hint: 'whole_session',
        cumulative_usage: mkUsage(120, 40, 0, 0),
        idempotency_key: 'w1',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        cumulative_usage: mkUsage(200, 60, 0, 0),
        idempotency_key: 'w2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    // whole_session first → floor 0, so the span is the full MAX(cumulative).
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(200);
  });
});

describe('UsageLedger source-plan linking', () => {
  it('flows non-null source-plan deltas to the artifact, time-bounded to linked_at', async () => {
    const ref = 'cloud:ext1';
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: null,
        source_plan_ref_id: ref,
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        cumulative_usage: mkUsage(20),
        idempotency_key: 'r1',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: null,
        source_plan_ref_id: ref,
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        cumulative_usage: mkUsage(50),
        idempotency_key: 'r2',
        ts: '2026-01-01T00:10:00.000Z',
      })
    ); // delta 30

    const link = await ledger.appendSourcePlanLink({
      canonical_ref_id: ref,
      artifact_id: 'a1',
      linked_at: '2026-01-01T00:20:00.000Z',
      pinned_version: '2',
      idempotency_key: 'L1',
    });
    expect(link.linked).toBe(true);
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(30);

    // a review stamp AFTER linked_at must not inflate the captured artifact
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: null,
        source_plan_ref_id: ref,
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        cumulative_usage: mkUsage(90),
        idempotency_key: 'r3',
        ts: '2026-01-01T00:30:00.000Z',
      })
    );
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(30); // time-bound holds
  });

  it('linking is idempotent on (ref, artifact)', async () => {
    const ref = 'cloud:ext1';
    const a = await ledger.appendSourcePlanLink({
      canonical_ref_id: ref,
      artifact_id: 'a1',
      linked_at: '2026-01-01T00:00:00.000Z',
      pinned_version: '2',
      idempotency_key: 'L1',
    });
    const b = await ledger.appendSourcePlanLink({
      canonical_ref_id: ref,
      artifact_id: 'a1',
      linked_at: '2026-01-01T09:00:00.000Z',
      pinned_version: '3',
      idempotency_key: 'L2',
    });
    expect(a.linked).toBe(true);
    expect(b.linked).toBe(false);
    expect(store.hasSourcePlanLink(ref, 'a1')).toBe(true);
  });
});

describe('UsageLedger view + rebuild', () => {
  it('two artifacts in one session: one exact session row, separate per-artifact attribution', async () => {
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: 'a1',
        cumulative_usage: mkUsage(100),
        idempotency_key: 'k1',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: 'a1',
        cumulative_usage: mkUsage(150),
        idempotency_key: 'k2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: 'a2',
        cumulative_usage: mkUsage(220),
        idempotency_key: 'k3',
        ts: '2026-01-01T00:10:00.000Z',
      })
    );

    const sessions = store.listCodingSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cumulative_input_tokens).toBe(220); // exact whole-session total

    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(50); // delta from k2
    expect(store.attributedArtifactUsage('a2').input_tokens).toBe(0); // first touch → null
  });

  it('reset() then re-migrate recreates the coding_sessions view cleanly (reset spares views)', async () => {
    await ledger.appendUsageSnapshot(mk({ cumulative_usage: mkUsage(100), idempotency_key: 'k1' }));
    expect(store.listCodingSessions()).toHaveLength(1);

    store.reset(); // drops tables (view survives + dangles), migrate() recreates both

    expect(store.listCodingSessions()).toHaveLength(0); // queryable, empty — no dangling-view error
    await ledger.appendUsageSnapshot(mk({ cumulative_usage: mkUsage(100), idempotency_key: 'k2' }));
    expect(store.listCodingSessions()).toHaveLength(1);
  });

  it('rebuild replays snapshots (incl NULL-artifact) and links deterministically from the ledger', async () => {
    // Two source-plan (NULL-artifact) review snapshots: r1 first (null delta),
    // r2 a non-null +30 delta — so the link flows a real number we can trace.
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: null,
        source_plan_ref_id: 'cloud:ext1',
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        cumulative_usage: mkUsage(20),
        idempotency_key: 'r1',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: null,
        source_plan_ref_id: 'cloud:ext1',
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        cumulative_usage: mkUsage(50),
        idempotency_key: 'r2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: 'a1',
        cumulative_usage: mkUsage(100),
        idempotency_key: 'k1',
        ts: '2026-01-01T00:08:00.000Z',
      })
    );
    await ledger.appendSourcePlanLink({
      canonical_ref_id: 'cloud:ext1',
      artifact_id: 'a1',
      linked_at: '2026-01-01T00:10:00.000Z',
      pinned_version: '2',
      idempotency_key: 'L1',
    });

    const sessionsBefore = store.listCodingSessions();
    const snapshotsBefore = store.readUsageSnapshots('a1').length;
    const attributedBefore = store.attributedArtifactUsage('a1');
    expect(attributedBefore.input_tokens).toBe(30); // r2's delta via the link

    store.reset(); // wipe the SQLite projection
    expect(store.listCodingSessions()).toHaveLength(0);

    const counts = await rebuildUsageLedger(store, tmp);
    expect(counts).toEqual({ snapshots: 3, links: 1 }); // counts split, not summed

    expect(store.listCodingSessions()).toEqual(sessionsBefore);
    expect(store.readUsageSnapshots('a1').length).toBe(snapshotsBefore);
    // the NULL-artifact source-plan snapshots survived rebuild (else attribution → 0)
    expect(store.attributedArtifactUsage('a1')).toEqual(attributedBefore);
  });

  it('rebuild is idempotent — re-running does not double-project (OR IGNORE on the UNIQUE key)', async () => {
    await ledger.appendUsageSnapshot(mk({ cumulative_usage: mkUsage(100), idempotency_key: 'k1' }));
    await ledger.appendUsageSnapshot(
      mk({ cumulative_usage: mkUsage(150), idempotency_key: 'k2', ts: '2026-01-01T00:05:00.000Z' })
    );
    store.reset();
    await rebuildUsageLedger(store, tmp);
    await rebuildUsageLedger(store, tmp); // re-run must not throw or duplicate
    expect(store.readUsageSnapshots('a1')).toHaveLength(2);
  });
});

describe('UsageLedger per-model breakdown', () => {
  it('computes per-model deltas against the prior snapshot', async () => {
    await ledger.appendUsageSnapshot(
      mk({
        cumulative_usage: mkUsage(100, 20, 0, 0),
        model_breakdown: [{ model: 'claude-opus-4-8', cumulative: mkUsage(100, 20, 0, 0) }],
        idempotency_key: 'k1',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    const r = await ledger.appendUsageSnapshot(
      mk({
        cumulative_usage: mkUsage(160, 50, 0, 0),
        model_breakdown: [
          { model: 'claude-opus-4-8', cumulative: mkUsage(130, 35, 0, 0) },
          { model: 'claude-sonnet-4-6', cumulative: mkUsage(30, 15, 0, 0) },
        ],
        idempotency_key: 'k2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    const byModel = Object.fromEntries(r.snapshot.model_breakdown.map((m) => [m.model, m.delta]));
    expect(byModel['claude-opus-4-8']).toEqual(mkUsage(30, 15, 0, 0)); // 130-100, 35-20
    expect(byModel['claude-sonnet-4-6']).toEqual(mkUsage(30, 15, 0, 0)); // new model → delta == cumulative
  });
});

describe('Store.readSourcePlanLinks', () => {
  it('returns an artifact links ordered by linked_at, scoped to the artifact, empty when none', async () => {
    expect(store.readSourcePlanLinks('a1')).toEqual([]);

    // out of order on linked_at; readSourcePlanLinks must return ASC
    await ledger.appendSourcePlanLink({
      canonical_ref_id: 'cloud:ext2',
      artifact_id: 'a1',
      linked_at: '2026-01-02T00:00:00.000Z',
      pinned_version: '3',
      idempotency_key: 'L2',
    });
    await ledger.appendSourcePlanLink({
      canonical_ref_id: 'cloud:ext1',
      artifact_id: 'a1',
      linked_at: '2026-01-01T00:00:00.000Z',
      pinned_version: null,
      idempotency_key: 'L1',
    });
    // a link on another artifact must not leak
    await ledger.appendSourcePlanLink({
      canonical_ref_id: 'cloud:ext9',
      artifact_id: 'a2',
      linked_at: '2026-01-01T12:00:00.000Z',
      pinned_version: null,
      idempotency_key: 'L9',
    });

    const links = store.readSourcePlanLinks('a1');
    expect(links.map((l) => l.source_plan_ref_id)).toEqual(['cloud:ext1', 'cloud:ext2']);
    expect(links.every((l) => l.artifact_id === 'a1')).toBe(true);
    expect(links[0].pinned_version).toBeNull();
    expect(links[1].pinned_version).toBe('3');
  });
});

describe('Store.artifactSessionModelBreakdowns', () => {
  it('returns each in-scope session high-water breakdown, never an earlier baseline', async () => {
    // s1 on a1: a low-cumulative single-model baseline, then a higher two-model peak
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's1',
        cumulative_usage: mkUsage(10, 0, 0, 0),
        model_breakdown: [{ model: 'claude-opus-4-8', cumulative: mkUsage(10, 0, 0, 0) }],
        idempotency_key: 's1k1',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's1',
        cumulative_usage: mkUsage(100, 40, 0, 5),
        model_breakdown: [
          { model: 'claude-opus-4-8', cumulative: mkUsage(70, 30, 0, 5) },
          { model: 'claude-sonnet-4-6', cumulative: mkUsage(30, 10, 0, 0) },
        ],
        idempotency_key: 's1k2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    // s2 on a different artifact must not leak into a1
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's2',
        artifact_id: 'a2',
        cumulative_usage: mkUsage(999, 0, 0, 0),
        model_breakdown: [{ model: 'claude-haiku-4-5', cumulative: mkUsage(999, 0, 0, 0) }],
        idempotency_key: 's2k1',
        ts: '2026-01-01T00:01:00.000Z',
      })
    );

    const rows = store.artifactSessionModelBreakdowns('a1');
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('s1');
    const models = (JSON.parse(rows[0].model_breakdown) as Array<{ model: string }>)
      .map((m) => m.model)
      .sort();
    expect(models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']); // the peak breakdown, not the 1-model baseline
  });

  it('picks the GLOBAL session high-water even when the peak is on another artifact', async () => {
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's1',
        artifact_id: 'a1',
        cumulative_usage: mkUsage(50, 0, 0, 0),
        model_breakdown: [{ model: 'claude-opus-4-8', cumulative: mkUsage(50, 0, 0, 0) }],
        idempotency_key: 'x1',
        ts: '2026-01-01T00:00:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's1',
        artifact_id: 'a2', // same session continues on another artifact, with the peak
        cumulative_usage: mkUsage(200, 0, 0, 0),
        model_breakdown: [
          { model: 'claude-opus-4-8', cumulative: mkUsage(150, 0, 0, 0) },
          { model: 'claude-sonnet-4-6', cumulative: mkUsage(50, 0, 0, 0) },
        ],
        idempotency_key: 'x2',
        ts: '2026-01-01T00:05:00.000Z',
      })
    );

    const rows = store.artifactSessionModelBreakdowns('a1');
    expect(rows).toHaveLength(1);
    const models = (JSON.parse(rows[0].model_breakdown) as Array<{ model: string }>)
      .map((m) => m.model)
      .sort();
    expect(models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']); // a2's peak breakdown, matching the global MAX total
  });

  it('is empty when the artifact has no sessions', () => {
    expect(store.artifactSessionModelBreakdowns('nope')).toEqual([]);
  });
});

describe('Store.artifactScopedUsageSnapshots', () => {
  it('includes own + source-plan-linked (ts<=linked_at) snapshots, excludes post-linked_at', async () => {
    // the artifact's own snapshot
    await ledger.appendUsageSnapshot(
      mk({ idempotency_key: 'own1', cumulative_usage: mkUsage(5), ts: '2026-01-01T00:00:00.000Z' })
    );
    // a source-plan snapshot (artifact_id=null) recorded BEFORE linked_at → in scope
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: null,
        source_plan_ref_id: 'cloud:ext1',
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        idempotency_key: 'sp-in',
        cumulative_usage: mkUsage(10),
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    // a source-plan snapshot recorded AFTER linked_at → out of scope
    await ledger.appendUsageSnapshot(
      mk({
        artifact_id: null,
        source_plan_ref_id: 'cloud:ext1',
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        idempotency_key: 'sp-out',
        cumulative_usage: mkUsage(20),
        ts: '2026-01-01T00:30:00.000Z',
      })
    );
    await ledger.appendSourcePlanLink({
      canonical_ref_id: 'cloud:ext1',
      artifact_id: 'a1',
      linked_at: '2026-01-01T00:10:00.000Z',
      pinned_version: null,
      idempotency_key: 'L1',
    });

    const keys = store.artifactScopedUsageSnapshots('a1').map((s) => s.idempotency_key);
    expect(keys).toContain('own1'); // own snapshot
    expect(keys).toContain('sp-in'); // source-plan, ts <= linked_at
    expect(keys).not.toContain('sp-out'); // source-plan, ts > linked_at → excluded
    // the artifact-only readUsageSnapshots is strictly narrower (own only)
    expect(store.readUsageSnapshots('a1').map((s) => s.idempotency_key)).toEqual(['own1']);
  });
});

describe('scoped usage readers agree on the attribution scope (no drift)', () => {
  // One fixture exercised by all four scope-readers, asserting they apply the
  // SAME own + source-plan-linked (ts <= linked_at) predicate — the single
  // ARTIFACT_USAGE_SCOPE_PREDICATE. Guards against a future re-inline of any one
  // reader silently drifting emission scope away from attribution scope.
  beforeEach(async () => {
    // own (in scope): session s-own, artifact a1 — two snapshots so the
    // attribution span is a non-zero 100 input tokens.
    await ledger.appendUsageSnapshot(
      mk({ session_id: 's-own', idempotency_key: 'own1', cumulative_usage: mkUsage(0) })
    );
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's-own',
        idempotency_key: 'own2',
        cumulative_usage: mkUsage(100),
        ts: '2026-01-01T00:02:00.000Z',
      })
    );
    // source-plan (in scope): session s-in, ts <= linked_at.
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's-in',
        artifact_id: null,
        source_plan_ref_id: 'cloud:ext1',
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        idempotency_key: 'sp-in',
        cumulative_usage: mkUsage(0),
        ts: '2026-01-01T00:05:00.000Z',
      })
    );
    // source-plan (OUT of scope): session s-out, two snapshots AFTER linked_at;
    // if the predicate drifted to include them they would add 777 input tokens.
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's-out',
        artifact_id: null,
        source_plan_ref_id: 'cloud:ext1',
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        idempotency_key: 'sp-out1',
        cumulative_usage: mkUsage(0),
        ts: '2026-01-01T00:30:00.000Z',
      })
    );
    await ledger.appendUsageSnapshot(
      mk({
        session_id: 's-out',
        artifact_id: null,
        source_plan_ref_id: 'cloud:ext1',
        lifecycle_event: 'plan_review',
        baseline_hint: 'prior_same_source_plan',
        idempotency_key: 'sp-out2',
        cumulative_usage: mkUsage(777),
        ts: '2026-01-01T00:40:00.000Z',
      })
    );
    await ledger.appendSourcePlanLink({
      canonical_ref_id: 'cloud:ext1',
      artifact_id: 'a1',
      linked_at: '2026-01-01T00:10:00.000Z',
      pinned_version: null,
      idempotency_key: 'L1',
    });
  });

  it('all four readers include own + in-scope source-plan and exclude the post-linked_at session', () => {
    const inScopeSessions = ['s-in', 's-own']; // sorted

    // 1. snapshot-level scope: own + the in-scope source-plan snapshot only.
    const snapKeys = store
      .artifactScopedUsageSnapshots('a1')
      .map((s) => s.idempotency_key)
      .sort();
    expect(snapKeys).toEqual(['own1', 'own2', 'sp-in']);

    // 2 + 3. session-level scope: both session readers agree, excluding s-out.
    const sessionsA = store
      .artifactCodingSessions('a1')
      .map((s) => s.session_id)
      .sort();
    const sessionsB = store
      .artifactSessionModelBreakdowns('a1')
      .map((s) => s.session_id)
      .sort();
    expect(sessionsA).toEqual(inScopeSessions);
    expect(sessionsB).toEqual(inScopeSessions);

    // 4. attribution draws from the SAME scope: the in-scope span is 100 input
    // tokens; the out-of-scope s-out (which would add 777) is excluded.
    expect(store.attributedArtifactUsage('a1').input_tokens).toBe(100);
  });
});

describe('UsageLedger dimensions + rate classes', () => {
  it('round-trips total dimensions + per-model rate classes through SQLite', async () => {
    const cumulative: AgentUsage = {
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 5,
      dimensions: { cache_creation_1h_input_tokens: 20, cache_creation_5m_input_tokens: 10 },
    };
    await ledger.appendUsageSnapshot(
      mk({
        idempotency_key: 'dk1',
        baseline_hint: 'whole_session',
        cumulative_usage: cumulative,
        model_breakdown: [
          {
            model: 'claude-opus-4-8',
            speed: 'fast',
            cumulative: {
              input_tokens: 80,
              output_tokens: 8,
              cache_creation_input_tokens: 30,
              cache_read_input_tokens: 5,
              dimensions: { cache_creation_1h_input_tokens: 20 },
            },
          },
          { model: 'claude-opus-4-8', cumulative: mkUsage(20, 2) },
        ],
      })
    );
    // Read the stored row back — the SQLite round-trip (dimensions column + JSON).
    const row = store.getUsageSnapshotByKey('dk1')!;
    expect(JSON.parse(row.dimensions)).toEqual({
      cache_creation_1h_input_tokens: 20,
      cache_creation_5m_input_tokens: 10,
    });
    const mb = JSON.parse(row.model_breakdown) as Array<{
      model: string;
      speed?: string;
      cumulative: AgentUsage;
    }>;
    expect(mb.find((e) => e.speed === 'fast')!.cumulative.dimensions).toEqual({
      cache_creation_1h_input_tokens: 20,
    });
    expect(mb.find((e) => e.speed === undefined)!.model).toBe('claude-opus-4-8');

    // A replay reconstructs cumulative_usage.dimensions from the stored row.
    const replay = await ledger.appendUsageSnapshot(
      mk({ idempotency_key: 'dk1', baseline_hint: 'whole_session', cumulative_usage: cumulative })
    );
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.cumulative_usage.dimensions).toEqual({
      cache_creation_1h_input_tokens: 20,
      cache_creation_5m_input_tokens: 10,
    });
  });

  it('never writes dimensions onto a delta (scalar-only), even for whole_session', async () => {
    const withDim: AgentUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
      dimensions: { web_search_requests: 3 },
    };
    const r = await ledger.appendUsageSnapshot(
      mk({
        idempotency_key: 'dk2',
        baseline_hint: 'whole_session', // whole_session delta = scalarOnly(cumulative)
        cumulative_usage: withDim,
        model_breakdown: [{ model: 'm', cumulative: withDim }],
      })
    );
    expect(r.snapshot.delta_usage).not.toBeNull();
    expect((r.snapshot.delta_usage as AgentUsage).dimensions).toBeUndefined();
    const entry = r.snapshot.model_breakdown[0];
    expect(entry.delta).not.toBeNull();
    expect(entry.delta!.dimensions).toBeUndefined();
    expect(entry.cumulative.dimensions).toEqual({ web_search_requests: 3 }); // cumulative keeps it
  });

  it('keys per-model deltas by the full rate class (no cross-subtraction)', async () => {
    await ledger.appendUsageSnapshot(
      mk({
        idempotency_key: 'rk1',
        baseline_hint: 'prior_same_artifact', // no prior yet → first_observation
        ts: '2026-01-01T00:00:00.000Z',
        cumulative_usage: mkUsage(140),
        model_breakdown: [
          { model: 'opus', cumulative: mkUsage(100) },
          { model: 'opus', speed: 'fast', cumulative: mkUsage(40) },
        ],
      })
    );
    const r2 = await ledger.appendUsageSnapshot(
      mk({
        idempotency_key: 'rk2',
        baseline_hint: 'prior_same_artifact',
        ts: '2026-01-01T00:01:00.000Z',
        cumulative_usage: mkUsage(160),
        model_breakdown: [
          { model: 'opus', cumulative: mkUsage(110) }, // +10 vs the prior opus-standard (100)
          { model: 'opus', speed: 'fast', cumulative: mkUsage(50) }, // +10 vs the prior opus-fast (40)
        ],
      })
    );
    const std = r2.snapshot.model_breakdown.find((e) => e.speed === undefined)!;
    const fast = r2.snapshot.model_breakdown.find((e) => e.speed === 'fast')!;
    expect(std.delta!.input_tokens).toBe(10); // 110 - 100, NOT 110 - 40
    expect(fast.delta!.input_tokens).toBe(10); // 50 - 40, NOT 50 - 100
  });
});
