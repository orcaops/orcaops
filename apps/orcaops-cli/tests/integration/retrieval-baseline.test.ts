import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tokenizeSearchText } from '@orcaops/storage/history/search-content';

import {
  fieldFamilies,
  phrasingClasses,
  type RecordLocator,
  retrievalCases,
} from '../fixtures/retrieval-corpus/cases.js';
import {
  baselineOf,
  measureRetrieval,
  type RetrievalResults,
} from '../support/retrieval-baseline.js';
import { buildRetrievalCorpus, type RetrievalCorpus } from '../support/retrieval-corpus.js';

const baselineFile = fileURLToPath(
  new URL('../fixtures/retrieval-corpus/baseline.json', import.meta.url)
);

// RETRIEVAL_RESULTS_FILE=<absolute path> also times the scan and writes the full results.
// UPDATE_RETRIEVAL_BASELINE=1 re-records baseline.json and then fails, so a re-recording run
// can never pass for a verified one. Re-record only when matching is meant to have changed.
const resultsFile = process.env.RETRIEVAL_RESULTS_FILE;
const recording = process.env.UPDATE_RETRIEVAL_BASELINE === '1';

/** The query's words form one unbroken run of a record's words, as search tokenizes them. */
function quotes(query: string, records: RecordLocator[]): boolean {
  const run = tokenizeSearchText(query);
  return records.some((record) => {
    const words = tokenizeSearchText(record.wording);
    return words.some((_, start) => run.every((word, offset) => words[start + offset] === word));
  });
}

let corpus: RetrievalCorpus;

beforeAll(async () => {
  // The CLI test setup moves each worker into a temporary directory, which would swallow a
  // relative path together with the results.
  if (resultsFile !== undefined && !path.isAbsolute(resultsFile))
    throw new Error('RETRIEVAL_RESULTS_FILE must be an absolute path');
  if (recording && process.env.CI)
    throw new Error('UPDATE_RETRIEVAL_BASELINE re-records the baseline and must not run in CI');
  corpus = await buildRetrievalCorpus();
}, 120_000);

afterAll(async () => {
  await corpus?.cleanup();
});

describe('retrieval corpus and cases', () => {
  it('captures ten artifacts across three branches', () => {
    const artifacts = Object.values(corpus.artifacts);
    expect(new Set(artifacts.map((artifact) => artifact.artifactId)).size).toBe(10);
    expect(new Set(artifacts.map((artifact) => artifact.branch))).toEqual(
      new Set(['main', 'sync-uploads', 'consent-gate'])
    );
  });

  it('resolves every case record to a captured event holding the stated wording', () => {
    const problems: string[] = [];
    for (const retrievalCase of retrievalCases) {
      const records = [
        ...retrievalCase.expected.map((record) => ({ record, superseded: false })),
        ...(retrievalCase.supersededSources ?? []).map((record) => ({
          record,
          superseded: true,
        })),
      ];
      for (const { record, superseded } of records) {
        const where = `${retrievalCase.name}: ${record.artifact} ${record.event} ${record.path}`;
        try {
          const resolved = corpus.resolve(record);
          if (resolved.text !== record.wording) problems.push(`${where} holds "${resolved.text}"`);
          if (resolved.superseded !== superseded)
            problems.push(`${where} is ${resolved.superseded ? '' : 'not '}superseded`);
        } catch (cause) {
          problems.push(`${where}: ${(cause as Error).message}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps every case inside its field family and phrasing class', () => {
    const problems: string[] = [];
    for (const retrievalCase of retrievalCases) {
      const { name, queries, expected, supersededSources = [], phrasing } = retrievalCase;
      if (queries.length === 0 || queries.some((query) => query.trim() === ''))
        problems.push(`${name}: needs non-blank queries`);
      if (expected.length === 0) problems.push(`${name}: needs an expected record`);
      for (const record of [...expected, ...supersededSources])
        if (!fieldFamilies[retrievalCase.family].test(record.path))
          problems.push(`${name}: ${record.path} is outside ${retrievalCase.family}`);
      if (phrasing === 'exact wording' && !queries.every((query) => quotes(query, expected)))
        problems.push(`${name}: an exact-wording query must quote an expected record`);
      if (
        phrasing === 'single keyword' &&
        !queries.every((query) => tokenizeSearchText(query).length === 1)
      )
        problems.push(`${name}: a single-keyword query must be one word`);
      if (
        (phrasing === 'partial wording' || phrasing === 'paraphrase') &&
        queries.some((query) => tokenizeSearchText(query).length < 2 || quotes(query, expected))
      )
        problems.push(
          `${name}: a ${phrasing} query is several words and quotes no expected record`
        );
      if ((phrasing === 'obsolete wording') !== supersededSources.length > 0)
        problems.push(`${name}: superseded sources belong to obsolete-wording cases only`);
      if (
        phrasing === 'obsolete wording' &&
        !queries.some((query) => quotes(query, supersededSources))
      )
        problems.push(`${name}: an obsolete-wording query must quote a superseded source`);
    }
    expect(problems).toEqual([]);
    expect(new Set(retrievalCases.map((retrievalCase) => retrievalCase.name)).size).toBe(
      retrievalCases.length
    );
  });

  it('has cases for every field family and phrasing class', () => {
    expect(new Set(retrievalCases.map((retrievalCase) => retrievalCase.family))).toEqual(
      new Set(Object.keys(fieldFamilies))
    );
    expect(new Set(retrievalCases.map((retrievalCase) => retrievalCase.phrasing))).toEqual(
      new Set(Object.keys(phrasingClasses))
    );
  });
});

describe('retrieval over the fixed corpus', () => {
  let results: RetrievalResults;

  beforeAll(async () => {
    results = await measureRetrieval(corpus, { speed: resultsFile !== undefined });
    if (resultsFile) await writeFile(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
  }, 180_000);

  it('retrieval recall matches the recorded baseline', async () => {
    const measured = baselineOf(results);
    if (recording) {
      await writeFile(baselineFile, `${JSON.stringify(measured, null, 2)}\n`);
      expect.fail('Re-recorded baseline.json: review its diff, then run without the flag');
    }
    expect(measured).toEqual(JSON.parse(await readFile(baselineFile, 'utf8')));
  });

  it('measures continuing records over the same bare superseded hits the matching pass counts', () => {
    const { continuingRecords, matching } = results;

    expect(continuingRecords.bareSuperseded).toBe(
      matching.summaries.default.supersededWithoutSuccessor
    );
    expect(continuingRecords.carryingStanding).toBeLessThanOrEqual(
      continuingRecords.bareSuperseded
    );
    expect(continuingRecords.namingTheReplacement).toBeLessThanOrEqual(
      continuingRecords.carryingStanding
    );
    // The recorded sentence and the count say the same thing, so neither can move alone.
    const sentences = Object.values(continuingRecords.bare).flatMap((queries) =>
      Object.values(queries)
    );
    expect(sentences).toHaveLength(continuingRecords.bareSuperseded);
    expect(
      sentences.filter((sentence) => !sentence.includes('no continuing record cites them'))
    ).toHaveLength(continuingRecords.carryingStanding);
  });

  it.skipIf(resultsFile === undefined)(
    'times the storage scan for every query without judging the numbers',
    () => {
      const queries = new Set(results.matching.outcomes.map((outcome) => outcome.query));
      const timings = results.speed!.scan.perQuery;
      expect(timings.map((timing) => timing.query).sort()).toEqual([...queries].sort());
      for (const timing of timings) expect(timing.samples).toBe(results.speed!.scan.repetitions);
    }
  );
});
