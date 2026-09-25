import {
  type ContinuingRecordMeasurement,
  measureContinuingRecords,
} from './retrieval-continuing-records.js';
import type { RetrievalCorpus } from './retrieval-corpus.js';
import {
  describeOutcome,
  type MatchingMeasurement,
  measureMatching,
} from './retrieval-matching.js';
import { measureScanSpeed, type SpeedMeasurement } from './retrieval-speed.js';
import {
  measureStructuredReads,
  type StructuredReadMeasurement,
} from './retrieval-structured-reads.js';
import { type RetrievalCase, retrievalCases } from '../fixtures/retrieval-corpus/cases.js';

export interface RetrievalResults {
  matching: MatchingMeasurement;
  structuredReads: StructuredReadMeasurement;
  /** Null unless timing was asked for: it is never part of the baseline. */
  speed: SpeedMeasurement | null;
  continuingRecords: ContinuingRecordMeasurement;
}

export async function measureRetrieval(
  corpus: RetrievalCorpus,
  options: { speed: boolean; cases?: readonly RetrievalCase[] }
): Promise<RetrievalResults> {
  const cases = options.cases ?? retrievalCases;
  return {
    matching: await measureMatching(corpus, cases),
    structuredReads: await measureStructuredReads(corpus, cases),
    speed: options.speed ? await measureScanSpeed(corpus, cases) : null,
    // Last on purpose: it publishes continuing records over the corpus, and every pass above
    // measures the corpus as captured.
    continuingRecords: await measureContinuingRecords(corpus, cases),
  };
}

/** The part of the results that is the same on every machine and run: no ids, times, or sizes. */
export function baselineOf(results: RetrievalResults) {
  const { matching, structuredReads, continuingRecords } = results;
  const cases: Record<string, Record<string, Record<string, string>>> = {};
  for (const outcome of matching.outcomes)
    ((cases[outcome.case] ??= {})[outcome.query] ??= {})[outcome.pageSize] =
      describeOutcome(outcome);
  return {
    corpus: matching.corpus,
    summaries: matching.summaries,
    tightPage: {
      queriesCutShort: matching.tightPage.queriesCutShort,
      cutShortAndReportedTruncated: matching.tightPage.cutShortAndReportedTruncated,
    },
    hitFields: matching.hitFields,
    structuredReads,
    continuingRecords,
    cases,
  };
}
