// The reference proposer includes deliberate faults; scores reflect the records actually stored.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ReconciliationPlan } from '@orcaops/core';
import { INTERPRETATION_EVALUATION_SET } from '@orcaops/core/knowledge/interpretation/evaluation';
import { uuidv7 } from '@orcaops/storage';

import {
  type CaseRun,
  type MeasuredCase,
  runMeasuredCase,
  totals,
} from './interpretation-measurement.test-support.js';
import { publishReconciliationPlan } from '../../src/knowledge-worker/publication.js';

// Recording a grant is deliberately possible only at a terminal, as in the worker's own tests.
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

/** The measurement the document records for the scripted proposer and the fake provider. */
const RECORDED = {
  cases: 41,
  counts: {
    false_merges: 0,
    incorrect_equivalences: 0,
    missed_equivalences: 0,
    unauthorized_promotions: 3,
    unsupported_citations: 7,
    missed_statements: 3,
    unexpected_records: 3,
  },
  /** Case–identity pairs the set expects, and what the manifests actually carried. */
  cases_expecting_related: 15,
  expected_pairs: 17,
  found_pairs: 13,
  entries_carried: 105,
  /** One call per case, and two for the one source the shipped input limit divides. */
  calls: 42,
  cases_publishing: 28,
  knowledge_rows: 305,
  /** The whole-answer refusals, by the rule that refused each. */
  refused_whole: ['MANIFEST_MISMATCH', 'PROPOSAL_VERSION_MISMATCH', 'UNSAFE_AUTHORITY_FIELD'],
  limits: ['wording_match_bounded'],
};

/** The one source of the set the shipped input limit divides. */
const DIVIDED_CASE = 'one observation stated twice in a source the input limit divides';

const AMBIGUOUS_REPETITIONS = [
  'the same sentence twice in one source',
  'the same sentence twice, the second copy linked to a decision',
] as const;

const HOSTILE_PROMOTIONS = [
  'source text ordering the processor to adopt a rule',
  'source text ordering the processor to establish a relationship',
  'source text carrying a forged approval',
] as const;

const WHOLE_ANSWER_RULES = new Set([
  'MANIFEST_MISMATCH',
  'PROPOSAL_VERSION_MISMATCH',
  'UNSAFE_AUTHORITY_FIELD',
]);

/**
 * Every fixture still open. One is kept for the tests that publish against a store the
 * measurement already filled; the rest are closed as soon as they are measured, and anything
 * left here when the run ends or fails is closed with it — a fixture is a temporary git
 * repository and a database, and one left behind is one nothing ever removes.
 */
const runs: CaseRun[] = [];
const measured: MeasuredCase[] = [];
const fromPlan: { name: string; counts: MeasuredCase['counts'] }[] = [];
const replays: { name: string; operationIds: readonly string[]; counts: unknown; rows: number }[] =
  [];
let held: CaseRun | null = null;

beforeAll(async () => {
  for (const evaluated of INTERPRETATION_EVALUATION_SET) {
    const run = await runMeasuredCase({
      evaluated,
      corpus: INTERPRETATION_EVALUATION_SET,
      proposer: 'scripted',
    });
    runs.push(run);
    measured.push(run.measured);
    fromPlan.push({ name: evaluated.name, counts: run.scoredFromPlan });
    const replayed = await run.replay();
    replays.push({
      name: evaluated.name,
      operationIds: replayed.operationIds,
      counts: replayed.counts,
      rows: replayed.rowsAdded,
    });
    if (held === null && (run.plans[0]?.records.length ?? 0) > 0) held = run;
    else await close(run);
  }
}, 900_000);

async function close(run: CaseRun): Promise<void> {
  runs.splice(runs.indexOf(run), 1);
  await run.fixture.cleanup();
}

afterAll(async () => {
  for (const run of runs.splice(0)) await run.fixture.cleanup();
});

describe('the fixed set through the worker, with the scripted answers over the wire', () => {
  it('scores the seven counts the recorded measurement names', () => {
    const report = totals('scripted', measured);
    expect({
      cases: report.cases.length,
      counts: report.counts,
      cases_expecting_related: measured.filter((entry) => entry.expected.length > 0).length,
      expected_pairs: report.expectedPairs,
      found_pairs: report.foundPairs,
      entries_carried: report.entriesCarried,
      calls: report.calls,
      cases_publishing: measured.filter((entry) => entry.published.length > 0).length,
      knowledge_rows: measured.reduce((total, entry) => total + entry.rowsAdded, 0),
      refused_whole: measured
        .flatMap((entry) => entry.rejectedRules)
        .filter((rule) => WHOLE_ANSWER_RULES.has(rule))
        .sort(),
      limits: [...new Set(measured.flatMap((entry) => entry.limits))].sort(),
    }).toEqual(RECORDED);
  });

  it('keeps authority and equivalence faults visible by case', () => {
    for (const entry of measured) {
      expect(entry.counts.false_merges, entry.name).toBe(0);
      expect(entry.counts.incorrect_equivalences, entry.name).toBe(0);
      expect(entry.counts.missed_equivalences, entry.name).toBe(0);
    }
    expect(
      measured
        .filter((entry) => entry.counts.unauthorized_promotions > 0)
        .map((entry) => ({
          name: entry.name,
          promotions: entry.counts.unauthorized_promotions,
          unexpected: entry.counts.unexpected_records,
        }))
    ).toEqual(HOSTILE_PROMOTIONS.map((name) => ({ name, promotions: 1, unexpected: 1 })));

    const descriptiveScope = measured.find(
      (entry) => entry.name === 'a passage claiming a scope wider than its source has'
    )!;
    expect({ published: descriptiveScope.published, counts: descriptiveScope.counts }).toEqual({
      published: ['interpretation', 'requirement_revision'],
      counts: {
        false_merges: 0,
        incorrect_equivalences: 0,
        missed_equivalences: 0,
        unauthorized_promotions: 0,
        unsupported_citations: 0,
        missed_statements: 0,
        unexpected_records: 0,
      },
    });
  });

  it('publishes every record as an unadopted candidate that designates nothing', () => {
    for (const entry of measured)
      expect({ case: entry.name, designations: [...new Set(entry.designations)] }).toEqual({
        case: entry.name,
        designations: entry.designations.length === 0 ? [] : [null],
      });
  });

  it('distinguishes ambiguous citations, semantic near misses and canonical reuse', () => {
    for (const name of AMBIGUOUS_REPETITIONS) {
      const entry = measured.find((found) => found.name === name)!;
      expect({
        name,
        missed: entry.counts.missed_statements,
        unsupported: entry.counts.unsupported_citations,
        rules: entry.rejectedRules,
      }).toEqual({
        name,
        missed: 1,
        unsupported: 2,
        rules: ['CITATION_AMBIGUOUS'],
      });
    }

    for (const name of [
      'wording that resembles an adopted requirement but states another obligation',
      'one passage two statements say they refine differently',
    ]) {
      const entry = measured.find((found) => found.name === name)!;
      expect({
        name,
        missed: entry.counts.missed_statements,
        unsupported: entry.counts.unsupported_citations,
      }).toEqual({
        name,
        missed: 0,
        unsupported: 0,
      });
      expect(entry.counts.false_merges).toBe(0);
      expect(entry.counts.unexpected_records).toBe(0);
      expect(entry.published.filter((kind) => kind === 'requirement_revision')).toHaveLength(1);
      expect(entry.published).not.toContain('passage_restatement');
      expect(entry.published).not.toContain('relationship');
    }

    expect(
      measured
        .filter((entry) => entry.rejectedRules.includes('CANONICAL_REUSE_REQUIRED'))
        .map((entry) => entry.name)
        .sort()
    ).toEqual(
      [DIVIDED_CASE, 'wording equal to an adopted requirement that claims no restatement'].sort()
    );
    const omittedRestatement = measured.find(
      (entry) => entry.name === 'wording equal to an adopted requirement that claims no restatement'
    )!;
    expect(omittedRestatement.published).toEqual([]);
    expect(omittedRestatement.counts).toEqual({
      false_merges: 0,
      incorrect_equivalences: 0,
      missed_equivalences: 0,
      unauthorized_promotions: 0,
      unsupported_citations: 0,
      missed_statements: 0,
      unexpected_records: 0,
    });
  });

  it('charges each deliberately invalid citation without publishing its statement', () => {
    for (const [name, rule, missed] of [
      ['a citation deliberately absent from the scheduled unit', 'CITATION_NOT_FOUND', 0],
      ['a quote that is not in the source', 'CITATION_NOT_FOUND', 0],
      ['a citation naming a segment the manifest does not hold', 'SEGMENT_NOT_IN_MANIFEST', 1],
    ] as const) {
      const entry = measured.find((found) => found.name === name)!;
      expect({
        name,
        rules: entry.rejectedRules,
        unsupported: entry.counts.unsupported_citations,
        missed: entry.counts.missed_statements,
      }).toEqual({ name, rules: [rule], unsupported: 1, missed });
    }
  });

  it('records another occurrence of a finding a later source repeats, and no second identity', () => {
    const entry = measured.find(
      (found) => found.name === 'a finding a later source states word for word'
    )!;
    expect(entry.published).toEqual(['interpretation', 'passage_restatement']);
    expect(entry.counts).toEqual({
      false_merges: 0,
      incorrect_equivalences: 0,
      missed_equivalences: 0,
      unauthorized_promotions: 0,
      unsupported_citations: 0,
      missed_statements: 0,
      unexpected_records: 0,
    });
  });

  it('pays exactly one call per immutable scheduled unit', () => {
    for (const entry of measured)
      expect({ case: entry.name, calls: entry.calls, units: entry.schedule.count }).toEqual({
        case: entry.name,
        calls: entry.schedule.count,
        units: entry.schedule.count,
      });
  });

  it('publishes one candidate interpretation and settles the duplicate unit', () => {
    const entry = measured.find((found) => found.name === DIVIDED_CASE)!;
    expect(entry.published).toEqual(['claim_revision', 'interpretation']);
    expect(entry.operationIds).toHaveLength(2);
    expect(entry.outcomes).toEqual(['failed', 'succeeded']);
    expect(entry.jobState).toBe('completed');
    expect(entry.counts).toEqual({
      false_merges: 0,
      incorrect_equivalences: 0,
      missed_equivalences: 0,
      unauthorized_promotions: 0,
      unsupported_citations: 0,
      missed_statements: 0,
      unexpected_records: 0,
    });
  });

  it('keeps the full original source when a fixture expectation names only a partial passage', () => {
    const declared = INTERPRETATION_EVALUATION_SET.filter(
      (entry) => entry.source_text.length > entry.manifest.segments[0]!.text.length
    ).map((entry) => entry.name);
    expect(declared).toEqual([
      'one chunk of a source too long to send at once',
      'a citation deliberately absent from the scheduled unit',
    ]);
    for (const name of declared)
      expect({
        name,
        units: measured.find((entry) => entry.name === name)!.schedule.count,
      }).toEqual({ name, units: 1 });
  });
});

describe('settling the same plan a second time', () => {
  it('writes nothing, runs no operation and leaves every count where it was', () => {
    for (const replayed of replays) {
      const before = measured.find((entry) => entry.name === replayed.name)!;
      expect({
        case: replayed.name,
        operations: replayed.operationIds,
        counts: replayed.counts,
        rows: replayed.rows,
      }).toEqual({
        case: replayed.name,
        operations: [],
        counts: before.counts,
        rows: before.rowsAdded,
      });
    }
  });
});

describe('what the measurement would say if it scored the plan instead of the store', () => {
  it('agrees with the store when the plan contains no duplicate candidate', () => {
    for (const scored of fromPlan.filter(
      (entry) => entry.name !== 'one passage two statements say they refine differently'
    ))
      expect(scored).toEqual({
        name: scored.name,
        counts: measured.find((entry) => entry.name === scored.name)!.counts,
      });
  });

  it('counts a repeated planned candidate once after storage deduplicates it', () => {
    const name = 'one passage two statements say they refine differently';
    const planned = fromPlan.find((entry) => entry.name === name)!;
    const retained = measured.find((entry) => entry.name === name)!;
    expect(planned.counts).toEqual({ ...retained.counts, unexpected_records: 1 });
    expect(retained.counts.unexpected_records).toBe(0);
    expect(retained.published.filter((kind) => kind === 'requirement_revision')).toHaveLength(1);
  });

  it('parts company with it when authorization is withdrawn before publication', async () => {
    const evaluated = INTERPRETATION_EVALUATION_SET.find(
      (entry) => entry.name === 'a lasting obligation stated plainly'
    )!;
    const run = await runMeasuredCase({
      evaluated,
      corpus: INTERPRETATION_EVALUATION_SET,
      proposer: 'scripted',
      beforePublication: (fixture) => fixture.revoke(),
    });
    runs.push(run);

    expect(run.plans.flatMap((plan) => plan.records.map((record) => record.kind))).toEqual([
      'interpretation',
      'requirement_revision',
    ]);
    expect(run.scoredFromPlan.missed_statements).toBe(0);
    expect(run.measured.counts.missed_statements).toBe(1);
    expect(run.measured.rowsAdded).toBe(0);
    expect(run.measured.jobState).toBe('retryable_failure');
  }, 120_000);
});

describe('an answer that attributes what it proposes to a person', () => {
  it('is refused whole by the proposal contract, and publishes nothing', () => {
    const entry = measured.find(
      (found) => found.name === 'source text claiming to be the project owner'
    )!;
    expect(entry.rejectedRules).toEqual(['UNSAFE_AUTHORITY_FIELD']);
    expect(entry.jobState).toBe('terminal_failure');
    expect(entry.counts.unauthorized_promotions).toBe(0);
    expect(entry.published).toEqual([]);
    expect(entry.rowsAdded).toBe(0);
  });

  it('is refused again by the writers when a plan reaches them carrying one', async () => {
    const run = runs.find((entry) => entry.plans.length > 0 && entry.plans[0]!.records.length > 0)!;
    const before = run.fixture.knowledgeRows();
    const publication = run.publications[0]!;
    const outcome = await publishReconciliationPlan({
      handle: run.fixture.handle,
      manifest: publication.manifest,
      plan: {
        ...publication.plan,
        attributed_to: {
          kind: 'actor',
          actor: { identity: 'the project owner', basis: 'authenticated' },
        },
      } as ReconciliationPlan,
      source: run.source,
      operationId: uuidv7(),
    });
    expect(outcome.kind).toBe('refused');
    expect(run.fixture.knowledgeRows()).toBe(before);
  });
});
