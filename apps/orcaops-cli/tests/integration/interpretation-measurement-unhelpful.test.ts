// Scores come from stored records, not from the fake provider's proposals.
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { INTERPRETATION_EVALUATION_SET } from '@orcaops/core/knowledge/interpretation/evaluation';

import {
  type MeasuredCase,
  type MeasuredProposer,
  runMeasuredCase,
  totals,
} from './interpretation-measurement.test-support.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

const RECORDED = {
  empty: {
    counts: {
      false_merges: 0,
      incorrect_equivalences: 0,
      missed_equivalences: 0,
      unauthorized_promotions: 0,
      unsupported_citations: 0,
      missed_statements: 24,
      unexpected_records: 0,
    },
    knowledge_rows: 204,
    cases_publishing: 0,
    entries_carried: 104,
  },
  'every-line': {
    counts: {
      false_merges: 0,
      incorrect_equivalences: 0,
      missed_equivalences: 0,
      unauthorized_promotions: 153,
      unsupported_citations: 130,
      missed_statements: 13,
      unexpected_records: 160,
    },
    knowledge_rows: 888,
    cases_publishing: 41,
    entries_carried: 106,
  },
} as const;

async function measure(proposer: MeasuredProposer): Promise<MeasuredCase[]> {
  const cases: MeasuredCase[] = [];
  for (const evaluated of INTERPRETATION_EVALUATION_SET) {
    const run = await runMeasuredCase({
      evaluated,
      corpus: INTERPRETATION_EVALUATION_SET,
      proposer,
    });
    // A fixture is a temporary git repository and a database, so it is closed whatever the
    // measurement it came back with does next.
    try {
      cases.push(run.measured);
    } finally {
      await run.fixture.cleanup();
    }
  }
  return cases;
}

const measured: Record<string, MeasuredCase[]> = {};

beforeAll(async () => {
  measured.empty = await measure('empty');
  measured['every-line'] = await measure('every-line');
}, 900_000);

describe('a provider that proposes no statements', () => {
  it('publishes no semantic records while retained source provenance remains measurable', () => {
    const report = totals('empty', measured.empty!);
    expect({
      counts: report.counts,
      knowledge_rows: measured.empty!.reduce((total, entry) => total + entry.rowsAdded, 0),
      cases_publishing: measured.empty!.filter((entry) => entry.published.length > 0).length,
      entries_carried: report.entriesCarried,
    }).toEqual(RECORDED.empty);
    expect(measured.empty!.flatMap((entry) => entry.published)).toEqual([]);
  });
});

describe('a provider that makes every line a lasting rule', () => {
  it('is charged for unsupported and unauthorized records, and still merges nothing', () => {
    const report = totals('every-line', measured['every-line']!);
    expect({
      counts: report.counts,
      knowledge_rows: measured['every-line']!.reduce((total, entry) => total + entry.rowsAdded, 0),
      cases_publishing: measured['every-line']!.filter((entry) => entry.published.length > 0)
        .length,
      entries_carried: report.entriesCarried,
    }).toEqual(RECORDED['every-line']);
  });

  it.each(['empty', 'every-line'] as const)(
    '%s carries the related knowledge selected for each evolving boundary and planned call count',
    (proposer) => {
      const report = totals(proposer, measured[proposer]!);
      expect({
        proposer,
        expected_pairs: report.expectedPairs,
        found_pairs: report.foundPairs,
        entries_carried: report.entriesCarried,
        calls: report.calls,
      }).toEqual({
        proposer,
        expected_pairs: 17,
        found_pairs: 13,
        entries_carried: RECORDED[proposer].entries_carried,
        calls: 42,
      });
    }
  );
});
