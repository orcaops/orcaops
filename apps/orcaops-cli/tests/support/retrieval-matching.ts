import { searchFieldsForEvent, tokenizeSearchText } from '@orcaops/storage/history/search-content';

import type { CorpusEvent, RetrievalCorpus } from './retrieval-corpus.js';
import type { readCanonicalSearch } from '../../src/lib/history-search.js';
import {
  fieldFamilies,
  type FieldFamily,
  type PhrasingClass,
  phrasingClasses,
  type RecordLocator,
  type RetrievalCase,
} from '../fixtures/retrieval-corpus/cases.js';

type SearchOutput = Awaited<ReturnType<typeof readCanonicalSearch>>;

/** `default` passes no `--limit`, so a change to the command's own default shows in the baseline. */
export const pageSizes = { default: null, tight: 3 } as const;
export type PageSize = keyof typeof pageSizes;

export function searchArgs(query: string, pageSize: PageSize): string[] {
  const limit = pageSizes[pageSize];
  return [
    'search',
    query,
    '--scope',
    'project',
    '--origin',
    'captured',
    ...(limit === null ? [] : ['--limit', String(limit)]),
    '--json',
  ];
}

export interface EventOutcome {
  artifact: string;
  event: string;
  /** Position among everything the command returned, derived rows included. */
  rank: number | null;
  /** Every query token occurs in the indexed text of the case's expected records in this event. */
  ownText: boolean;
  /** Query tokens that occur nowhere in the event's indexed text. */
  lacks: string[];
  /** Where the derived digest row of this event's artifact came back, if it did. */
  digestRank: number | null;
}

export interface QueryOutcome {
  case: string;
  family: FieldFamily;
  phrasing: PhrasingClass;
  query: string;
  pageSize: PageSize;
  expected: EventOutcome[];
  found: number;
  foundThroughOwnText: number;
  /** Expected events that did not come back although their artifact's digest row did. */
  digestOnly: number;
  superseded: EventOutcome[];
  /** A declared superseded source came back and no expected event did. */
  staleGuidanceOnly: boolean;
  /** Null unless both a declared superseded source and an expected event came back. */
  supersededOutranksStanding: boolean | null;
  /** Ranks of any superseded events that came back while the event standing in their place did not. */
  supersededWithoutSuccessor: number[];
  rows: { returned: number; digest: number; events: number; supersededEvents: number };
  page: {
    limit: number;
    truncated: boolean;
    nextOffset: number | null;
    matching: number | null;
    scanned: number;
  };
}

export interface RecallGroup {
  queries: number;
  fullyAnswered: number;
  partlyAnswered: number;
  unanswered: number;
  expectedEvents: number;
  foundEvents: number;
  recall: number;
  foundThroughOwnText: number;
  ownTextRecall: number;
  /** A case's queries taken together: an expected event counts once if any of them found it. */
  cases: number;
  caseExpectedEvents: number;
  caseFoundEvents: number;
  caseRecall: number;
  caseFoundThroughOwnText: number;
}

export interface PageSummary {
  limit: number;
  overall: RecallGroup;
  byPhrasing: Record<PhrasingClass, RecallGroup>;
  byFamily: Record<FieldFamily, RecallGroup>;
  /** Queries, counted from the superseded sources the cases declare. */
  staleGuidanceOnly: number;
  supersededOutranksStanding: number;
  /** Queries, counted from the standing of every returned event, declared by a case or not. */
  supersededWithoutSuccessor: number;
  digestOnlyAnswers: number;
  rows: QueryOutcome['rows'];
  scannedPerQuery: { min: number; max: number };
}

export interface MatchingMeasurement {
  corpus: {
    artifacts: number;
    events: number;
    searchSourceRows: number;
    cases: number;
    queries: number;
    queryEventPairs: number;
    distinctExpectedEvents: number;
  };
  outcomes: QueryOutcome[];
  summaries: Record<PageSize, PageSummary>;
  tightPage: {
    changed: Array<{ case: string; query: string; from: string; to: string }>;
    queriesCutShort: number;
    cutShortAndReportedTruncated: number;
  };
  hitFields: string[];
}

interface ExpectedEvent {
  artifact: string;
  event: string;
  artifactId: string;
  eventId: string;
  eventTokens: Set<string>;
  ownTokens: Set<string>;
}

function indexedFields(event: CorpusEvent) {
  const fields = searchFieldsForEvent(
    event.type as Parameters<typeof searchFieldsForEvent>[0],
    event.payload
  );
  return [...fields.intent, ...fields.body];
}

/** Several records of one case can sit in the same event; recall counts the event once. */
function expectedEvents(corpus: RetrievalCorpus, records: readonly RecordLocator[]) {
  const events = new Map<string, ExpectedEvent>();
  for (const record of records) {
    const { artifactId, eventId } = corpus.resolve(record);
    const fields = indexedFields(
      corpus.artifacts[record.artifact].events.find((event) => event.eventId === eventId)!
    );
    const key = `${record.artifact} ${record.event}`;
    const expected = events.get(key) ?? {
      artifact: record.artifact,
      event: record.event,
      artifactId,
      eventId,
      eventTokens: new Set(fields.flatMap((field) => field.tokens)),
      ownTokens: new Set<string>(),
    };
    // A record whose path search does not index, such as criterion lineage, has no own text.
    for (const token of fields.find((field) => field.path === record.path)?.tokens ?? [])
      expected.ownTokens.add(token);
    events.set(key, expected);
  }
  return [...events.values()];
}

function bestRank(outcomes: EventOutcome[]): number | null {
  const ranks = outcomes.flatMap((outcome) => (outcome.rank === null ? [] : [outcome.rank]));
  return ranks.length ? Math.min(...ranks) : null;
}

async function scoreQuery(
  corpus: RetrievalCorpus,
  successors: ReadonlyMap<string, string>,
  retrievalCase: RetrievalCase,
  query: string,
  pageSize: PageSize,
  hitFields: Set<string>
): Promise<QueryOutcome> {
  const raw = await corpus.agent.runRaw(searchArgs(query, pageSize));
  if (raw.exitCode !== 0) throw new Error(`search "${query}" failed: ${raw.stdout}${raw.stderr}`);
  const output = JSON.parse(raw.stdout) as SearchOutput;
  const hits = output.results;
  for (const hit of hits) for (const field of Object.keys(hit)) hitFields.add(field);
  const queryTokens = tokenizeSearchText(query);
  const rankWhere = (matches: (hit: (typeof hits)[number]) => boolean) => {
    const index = hits.findIndex(matches);
    return index < 0 ? null : index + 1;
  };
  const outcomesOf = (records: readonly RecordLocator[]): EventOutcome[] =>
    expectedEvents(corpus, records).map((expected) => ({
      artifact: expected.artifact,
      event: expected.event,
      rank: rankWhere(
        (hit) => hit.source_kind !== 'digest' && hit.source_event_id === expected.eventId
      ),
      ownText: queryTokens.every((token) => expected.ownTokens.has(token)),
      lacks: queryTokens.filter((token) => !expected.eventTokens.has(token)),
      digestRank: rankWhere(
        (hit) => hit.source_kind === 'digest' && hit.artifact_id === expected.artifactId
      ),
    }));
  const expected = outcomesOf(retrievalCase.expected);
  const superseded = outcomesOf(retrievalCase.supersededSources ?? []);
  const standingRank = bestRank(expected);
  const supersededRank = bestRank(superseded);
  const eventHits = hits.filter((hit) => hit.source_kind !== 'digest');
  const returnedEventIds = new Set(eventHits.map((hit) => hit.source_event_id));
  const supersededHits = hits.flatMap((hit, index) => {
    const successor =
      hit.source_event_id === null ? undefined : successors.get(hit.source_event_id);
    return successor === undefined ? [] : [{ rank: index + 1, successor }];
  });
  return {
    case: retrievalCase.name,
    family: retrievalCase.family,
    phrasing: retrievalCase.phrasing,
    query,
    pageSize,
    expected,
    found: expected.filter((outcome) => outcome.rank !== null).length,
    foundThroughOwnText: expected.filter((outcome) => outcome.rank !== null && outcome.ownText)
      .length,
    digestOnly: expected.filter((outcome) => outcome.rank === null && outcome.digestRank !== null)
      .length,
    superseded,
    staleGuidanceOnly: supersededRank !== null && standingRank === null,
    supersededOutranksStanding:
      supersededRank === null || standingRank === null ? null : supersededRank < standingRank,
    supersededWithoutSuccessor: supersededHits
      .filter((hit) => !returnedEventIds.has(hit.successor))
      .map((hit) => hit.rank),
    rows: {
      returned: hits.length,
      digest: hits.length - eventHits.length,
      events: returnedEventIds.size,
      supersededEvents: supersededHits.length,
    },
    page: {
      limit: output.page.limit,
      truncated: output.page.truncated,
      nextOffset: output.page.next_offset,
      matching: output.origin_counts.matching.captured,
      scanned: output.diagnostics.scanned_candidates,
    },
  };
}

const ratio = (found: number, expected: number) =>
  expected === 0 ? 0 : Number((found / expected).toFixed(3));

function recallOf(outcomes: QueryOutcome[]): RecallGroup {
  const sum = (pick: (outcome: QueryOutcome) => number) =>
    outcomes.reduce((total, outcome) => total + pick(outcome), 0);
  const expectedEvents = sum((outcome) => outcome.expected.length);
  const foundEvents = sum((outcome) => outcome.found);
  const foundThroughOwnText = sum((outcome) => outcome.foundThroughOwnText);
  const fullyAnswered = outcomes.filter(
    (outcome) => outcome.found === outcome.expected.length
  ).length;
  const unanswered = outcomes.filter((outcome) => outcome.found === 0).length;

  const caseEvents = new Map<string, { found: boolean; ownText: boolean }>();
  for (const outcome of outcomes)
    for (const event of outcome.expected) {
      const key = `${outcome.case}\n${event.artifact} ${event.event}`;
      const seen = caseEvents.get(key) ?? { found: false, ownText: false };
      seen.found ||= event.rank !== null;
      seen.ownText ||= event.rank !== null && event.ownText;
      caseEvents.set(key, seen);
    }
  const caseFoundEvents = [...caseEvents.values()].filter((event) => event.found).length;
  return {
    queries: outcomes.length,
    fullyAnswered,
    partlyAnswered: outcomes.length - fullyAnswered - unanswered,
    unanswered,
    expectedEvents,
    foundEvents,
    recall: ratio(foundEvents, expectedEvents),
    foundThroughOwnText,
    ownTextRecall: ratio(foundThroughOwnText, expectedEvents),
    cases: new Set(outcomes.map((outcome) => outcome.case)).size,
    caseExpectedEvents: caseEvents.size,
    caseFoundEvents,
    caseRecall: ratio(caseFoundEvents, caseEvents.size),
    caseFoundThroughOwnText: [...caseEvents.values()].filter((event) => event.ownText).length,
  };
}

function groupRecall<Key extends string>(
  keys: readonly Key[],
  outcomes: QueryOutcome[],
  keyOf: (outcome: QueryOutcome) => Key
): Record<Key, RecallGroup> {
  return Object.fromEntries(
    keys.map((key) => [key, recallOf(outcomes.filter((outcome) => keyOf(outcome) === key))])
  ) as Record<Key, RecallGroup>;
}

function summarize(outcomes: QueryOutcome[]): PageSummary {
  const sum = (pick: (rows: QueryOutcome['rows']) => number) =>
    outcomes.reduce((total, outcome) => total + pick(outcome.rows), 0);
  const scanned = outcomes.map((outcome) => outcome.page.scanned);
  return {
    limit: outcomes[0]!.page.limit,
    overall: recallOf(outcomes),
    byPhrasing: groupRecall(
      Object.keys(phrasingClasses) as PhrasingClass[],
      outcomes,
      (outcome) => outcome.phrasing
    ),
    byFamily: groupRecall(
      Object.keys(fieldFamilies) as FieldFamily[],
      outcomes,
      (outcome) => outcome.family
    ),
    staleGuidanceOnly: outcomes.filter((outcome) => outcome.staleGuidanceOnly).length,
    supersededOutranksStanding: outcomes.filter(
      (outcome) => outcome.supersededOutranksStanding === true
    ).length,
    supersededWithoutSuccessor: outcomes.filter(
      (outcome) => outcome.supersededWithoutSuccessor.length > 0
    ).length,
    digestOnlyAnswers: outcomes.filter((outcome) => outcome.digestOnly > 0).length,
    rows: {
      returned: sum((rows) => rows.returned),
      digest: sum((rows) => rows.digest),
      events: sum((rows) => rows.events),
      supersededEvents: sum((rows) => rows.supersededEvents),
    },
    scannedPerQuery: { min: Math.min(...scanned), max: Math.max(...scanned) },
  };
}

export function describeOutcome(outcome: QueryOutcome): string {
  const total = outcome.expected.length;
  const clauses = [
    outcome.found === 0
      ? `found 0 of ${total}`
      : `found ${outcome.found} of ${total} (ranks ${outcome.expected
          .map((event) => event.rank ?? '-')
          .join(', ')}), ${outcome.foundThroughOwnText} through own text`,
  ];
  const missed = outcome.expected.filter((event) => event.rank === null);
  const unmatched = missed.filter((event) => event.lacks.length > 0);
  if (unmatched.length > 0)
    clauses.push(`unmatched lack: ${unmatched.map((event) => event.lacks.join(', ')).join(' / ')}`);
  if (missed.length > unmatched.length)
    clauses.push(`${missed.length - unmatched.length} matched but fell outside the page`);
  const digestRanks = missed.flatMap((event) => event.digestRank ?? []);
  if (digestRanks.length > 0)
    clauses.push(`digest of an expected artifact at rank ${Math.min(...digestRanks)}`);
  if (outcome.superseded.length > 0) {
    const supersededRank = bestRank(outcome.superseded);
    clauses.push(
      supersededRank === null
        ? 'superseded source not returned'
        : `superseded source at rank ${supersededRank}, ${
            outcome.staleGuidanceOnly
              ? 'returned without its standing'
              : outcome.supersededOutranksStanding
                ? 'above the standing event'
                : 'below the standing event'
          }`
    );
  } else if (outcome.supersededWithoutSuccessor.length > 0)
    clauses.push(
      `superseded event at rank ${outcome.supersededWithoutSuccessor.join(', ')} without its successor`
    );
  return clauses.join('; ');
}

/**
 * Scores every query of every case at event level: an expected record counts as found when
 * the event holding it is returned, whichever field matched. Own text says whether the
 * expected records themselves could have matched.
 */
export async function measureMatching(
  corpus: RetrievalCorpus,
  cases: readonly RetrievalCase[]
): Promise<MatchingMeasurement> {
  const artifacts = Object.values(corpus.artifacts);
  const successors = new Map(
    artifacts.flatMap((artifact) =>
      artifact.events.flatMap((event) =>
        event.supersededBy === null ? [] : [[event.eventId, event.supersededBy] as const]
      )
    )
  );
  const hitFields = new Set<string>();
  const outcomes: QueryOutcome[] = [];
  for (const pageSize of Object.keys(pageSizes) as PageSize[])
    for (const retrievalCase of cases)
      for (const query of retrievalCase.queries)
        outcomes.push(
          await scoreQuery(corpus, successors, retrievalCase, query, pageSize, hitFields)
        );

  const at = (pageSize: PageSize) => outcomes.filter((outcome) => outcome.pageSize === pageSize);
  const tight = at('tight');
  const pairs = at('default').map((full, index) => ({ full, tight: tight[index]! }));
  const cutShort = pairs.filter((pair) => pair.full.rows.returned > pageSizes.tight);
  const expectedKeys = cases.flatMap((retrievalCase) =>
    retrievalCase.expected.map((record) => `${record.artifact} ${record.event}`)
  );
  return {
    corpus: {
      artifacts: artifacts.length,
      events: artifacts.reduce((sum, artifact) => sum + artifact.events.length, 0),
      searchSourceRows: corpus.searchSourceRows,
      cases: cases.length,
      queries: tight.length,
      queryEventPairs: tight.reduce((sum, outcome) => sum + outcome.expected.length, 0),
      distinctExpectedEvents: new Set(expectedKeys).size,
    },
    outcomes,
    summaries: { default: summarize(at('default')), tight: summarize(tight) },
    tightPage: {
      changed: pairs
        .filter((pair) => describeOutcome(pair.full) !== describeOutcome(pair.tight))
        .map((pair) => ({
          case: pair.full.case,
          query: pair.full.query,
          from: describeOutcome(pair.full),
          to: describeOutcome(pair.tight),
        })),
      queriesCutShort: cutShort.length,
      cutShortAndReportedTruncated: cutShort.filter(
        (pair) => pair.tight.page.truncated && pair.tight.page.nextOffset === pageSizes.tight
      ).length,
    },
    hitFields: [...hitFields].sort(),
  };
}
