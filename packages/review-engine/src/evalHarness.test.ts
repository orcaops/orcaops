import { describe, expect, it } from 'vitest';

import {
  aggregate,
  blindForm,
  finalizeRow,
  type HarnessRow,
  HarnessRowError,
  nearestRank,
  parseJournal,
  platformGate,
} from '../tests/support/evalHarness.js';

const row = (over: Partial<HarnessRow>): HarnessRow => {
  const base = {
    schema_version: 1,
    runId: over.runId ?? 'r1',
    arm: 'two-lane' as const,
    subject: 's',
    startedAtMs: over.startedAtMs ?? 0,
    endedAtMs: over.endedAtMs ?? 100_000,
    phases: {
      dossierMs: 1500,
      laneWallMs: Math.max(0, (over.endedAtMs ?? 100_000) - (over.startedAtMs ?? 0) - 2000),
      mergeRenderMs: 500,
    },
    lanes: {
      account: { tokens: 50_000, durationMs: 90_000 },
      forensic: { tokens: 40_000, durationMs: 85_000 },
    },
    repairs: 0,
    repairPenaltyMs: 0,
    outcome: 'FULL' as const,
    totalTokens: 90_000,
    ...over,
  };
  if (base.arm === 'baseline') base.lanes = { account: null, forensic: null } as never;
  if (base.outcome === 'FAILED') base.lanes = { account: null, forensic: null } as never;
  if (base.outcome === 'DEGRADED') base.lanes = { ...base.lanes, forensic: null } as never;
  return finalizeRow(base);
};

describe('harness rows', () => {
  it('rejects hand-drift: unknown fields and missing phases fail loudly', () => {
    expect(() => finalizeRow({ schema_version: 1, runId: 'x', extra: true })).toThrow(
      HarnessRowError
    );
  });
});

describe('single population rule', () => {
  it('percentiles cover output-producing runs; rates cover everyone', () => {
    const rows = [
      row({ runId: 'a', endedAtMs: 100_000 }),
      row({ runId: 'b', endedAtMs: 200_000, outcome: 'DEGRADED' }),
      row({ runId: 'c', endedAtMs: 50_000, outcome: 'FAILED', totalTokens: 10_000 }),
      row({ runId: 'd', endedAtMs: 150_000, repairs: 1, repairPenaltyMs: 60_000 }),
    ];
    const rep = aggregate(rows);
    expect(rep.populationSize).toBe(4);
    expect(rep.outputProducing).toBe(3);
    expect(rep.failedRate).toBe(0.25);
    expect(rep.degradedRate).toBe(0.25);
    // p50 over [100k, 150k, 200k] (failed excluded) = 150k
    expect(rep.endToEndMs.p50).toBe(150_000);
    expect(rep.repairFrequency).toBe(0.25);
    expect(rep.meanRepairPenaltyMs).toBe(60_000);
  });
  it('nearest-rank matches the registered estimator', () => {
    expect(nearestRank([10, 20, 30, 40], 50)).toBe(20);
    expect(nearestRank([10, 20, 30, 40], 95)).toBe(40);
    expect(Number.isNaN(nearestRank([], 50))).toBe(true);
  });
});

describe('pre-registered platform gate v2', () => {
  const base = aggregate([
    row({ runId: 'b1', arm: 'baseline', endedAtMs: 60_000, totalTokens: 30_000 }),
  ]);
  const extrasFor = (rows: HarnessRow[], repairs: HarnessRow[] = [], lane = true) => ({
    twoLaneRows: rows,
    inducedRepairRows: repairs,
    laneValueEvidenced: lane,
  });
  it('COMPETITIVE requires every term', () => {
    const rows = [row({ runId: 'g', endedAtMs: 110_000, totalTokens: 95_000 })];
    const good = aggregate(rows);
    const v = platformGate(good, base, extrasFor(rows));
    expect(v.verdict).toBe('PAUSE_AND_OPTIMIZE'); // 95k > 70k p50 tokens
    const cheapRows = [
      row({
        runId: 'g2',
        endedAtMs: 110_000,
        totalTokens: 65_000,
        lanes: {
          account: { tokens: 35_000, durationMs: 90_000 },
          forensic: { tokens: 30_000, durationMs: 85_000 },
        },
      }),
    ];
    const ok = platformGate(aggregate(cheapRows), base, extrasFor(cheapRows));
    expect(ok.verdict).toBe('COMPETITIVE');
  });
  it('reliability is part of the verdict: failures cannot hide in excluded percentiles', () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) =>
        row({ runId: `f${i}`, outcome: 'FAILED', endedAtMs: 300_000, totalTokens: 200_000 })
      ),
      row({
        runId: 'ok',
        endedAtMs: 100_000,
        totalTokens: 65_000,
        lanes: {
          account: { tokens: 35_000, durationMs: 90_000 },
          forensic: { tokens: 30_000, durationMs: 85_000 },
        },
      }),
    ];
    const v = platformGate(aggregate(rows), base, extrasFor(rows));
    expect(v.verdict).toBe('PAUSE_AND_OPTIMIZE');
    expect(v.reasons.join(' ')).toContain('failed happy-path');
    expect(v.reasons.join(' ')).toContain('ceiling breached');
  });
  it('enforces the absolute 180s floor even when relative passes', () => {
    const slowBase = aggregate([
      row({ runId: 'b2', arm: 'baseline', endedAtMs: 100_000, totalTokens: 30_000 }),
    ]);
    const rows = [
      row({
        runId: 's',
        endedAtMs: 190_000,
        totalTokens: 65_000,
        lanes: {
          account: { tokens: 35_000, durationMs: 90_000 },
          forensic: { tokens: 30_000, durationMs: 85_000 },
        },
      }),
    ];
    const v = platformGate(aggregate(rows), slowBase, extrasFor(rows));
    expect(v.verdict).toBe('PAUSE_AND_OPTIMIZE');
    expect(v.reasons.join(' ')).toContain('absolute p50');
  });
  it('requires repair recovery and lane value', () => {
    const rows = [
      row({
        runId: 'g3',
        endedAtMs: 110_000,
        totalTokens: 65_000,
        lanes: {
          account: { tokens: 35_000, durationMs: 90_000 },
          forensic: { tokens: 30_000, durationMs: 85_000 },
        },
      }),
    ];
    const badRepair = [
      row({
        runId: 'ir',
        arm: 'two-lane-induced-repair',
        outcome: 'DEGRADED',
        repairs: 1,
        repairPenaltyMs: 60_000,
        totalTokens: 90_000,
      }),
    ];
    const v1 = platformGate(aggregate(rows), base, extrasFor(rows, badRepair));
    expect(v1.reasons.join(' ')).toContain('repairs recovered 0/1');
    const v2 = platformGate(aggregate(rows), base, extrasFor(rows, [], false));
    expect(v2.reasons.join(' ')).toContain('lane value');
  });
  it('rejects impossible rows: end before start, FULL with one lane, over-credit repairs', () => {
    expect(() => row({ runId: 'x', endedAtMs: 0, startedAtMs: 5 })).toThrow();
    expect(() =>
      row({
        runId: 'y',
        lanes: { account: null, forensic: { tokens: 1, durationMs: 1 } },
        totalTokens: 1,
      })
    ).toThrow();
    expect(() => row({ runId: 'z', repairs: 2 })).toThrow();
  });
});

describe('journal extraction and blinding', () => {
  it('parses result lines mechanically', () => {
    const journal = [
      JSON.stringify({ type: 'started', agentId: 'a1' }),
      JSON.stringify({ type: 'result', agentId: 'a1', result: { findings: [] } }),
      '',
    ].join('\n');
    const agents = parseJournal(journal);
    expect(agents.length).toBe(1);
    expect(agents[0]!.agentId).toBe('a1');
  });
  it('blinded forms carry no identities and are deterministic', () => {
    const findings = [
      { claim: 'beta claim', file: 'b.ts', severity: 'CAUTION' },
      { claim: 'alpha claim', file: 'a.ts', severity: 'CRITICAL' },
    ];
    const f1 = blindForm('salt', findings);
    const f2 = blindForm('salt', [...findings].reverse());
    expect(JSON.stringify(f1)).toBe(JSON.stringify(f2));
    expect(JSON.stringify(f1)).not.toContain('two-lane');
    expect(JSON.stringify(f1)).not.toContain('account');
  });
});
