// What a hit carries once the corpus's own criterion lineage and plan decisions are published as
// continuing records: for every query that returns a superseded event without the event that
// replaced it, whether the hit names the record it cites, the standing of its own wording, and the
// wording that governs now.
//
// Deterministic throughout: the records come from lineage the capture path itself wrote, through
// the public writers, with no model, no worker and no extraction.
//
// This pass PUBLISHES, so it runs last. Every other measurement is over the corpus as captured, and
// moving this one earlier would change what they see.
import type { RetrievalCorpus } from './retrieval-corpus.js';
import { publishCorpusKnowledge } from './retrieval-knowledge.js';
import { searchArgs } from './retrieval-matching.js';
import type { readCanonicalSearch } from '../../src/lib/history-search.js';
import type { RetrievalCase } from '../fixtures/retrieval-corpus/cases.js';

type SearchOutput = Awaited<ReturnType<typeof readCanonicalSearch>>;
type SearchGroups = SearchOutput['knowledge']['groups'];
type SearchRecord = NonNullable<SearchOutput['results'][number]['knowledge']>['records'][number];

export interface ContinuingRecordMeasurement {
  published: { requirements: number; decisions: number; decisionRevisions: number };
  /** The page these are read at. The baseline's bare-superseded count is the same at both sizes. */
  limit: number;
  /** Queries returning a superseded event without the event that replaced it. */
  bareSuperseded: number;
  /** Of those, how many have at least one bare hit naming a continuing record. */
  carryingStanding: number;
  /** Of those, how many reach a wording that governs in place of the superseded one. */
  namingTheReplacement: number;
  /** One sentence per bare query: case name → query → what its bare hits carry. */
  bare: Record<string, Record<string, string>>;
}

/** The wording that governs the record now, as the composer answered it. */
function standingStatements(record: SearchRecord, groups: SearchGroups): string[] {
  const group = groups.find((entry) => entry.key === record.group);
  if (group === undefined) return [];
  return group.revisions
    .filter((revision) => group.governing.includes(revision.revision_id))
    .flatMap((revision) => (revision.statement === null ? [] : [revision.statement]));
}

function describeRecord(record: SearchRecord, groups: SearchGroups): string {
  const stands = standingStatements(record, groups);
  if (record.wording === 'superseded')
    return stands.length === 0
      ? 'superseded, with no wording standing in its place'
      : 'superseded, with the wording that stands beside it';
  if (record.wording === 'withdrawn') return 'withdrawn, with nothing standing in its place';
  if (record.wording === 'stands') return 'stands';
  return 'wording not tied to a revision this read can name';
}

export async function measureContinuingRecords(
  corpus: RetrievalCorpus,
  cases: readonly RetrievalCase[]
): Promise<ContinuingRecordMeasurement> {
  const published = await publishCorpusKnowledge(corpus);
  const successors = new Map(
    Object.values(corpus.artifacts).flatMap((artifact) =>
      artifact.events.flatMap((event) =>
        event.supersededBy === null ? [] : [[event.eventId, event.supersededBy] as const]
      )
    )
  );

  const bare: ContinuingRecordMeasurement['bare'] = {};
  let limit = 0;
  let carryingStanding = 0;
  let namingTheReplacement = 0;
  for (const retrievalCase of cases)
    for (const query of retrievalCase.queries) {
      const raw = await corpus.agent.runRaw(searchArgs(query, 'default'));
      if (raw.exitCode !== 0)
        throw new Error(`search "${query}" failed: ${raw.stdout}${raw.stderr}`);
      const envelope = JSON.parse(raw.stdout) as SearchOutput;
      limit = envelope.page.limit;
      const returned = new Set(
        envelope.results
          .filter((row) => row.source_kind !== 'digest')
          .map((row) => row.source_event_id)
      );
      const orphans = envelope.results.filter((row) => {
        const successor =
          row.source_event_id === null ? undefined : successors.get(row.source_event_id);
        return successor !== undefined && !returned.has(successor);
      });
      if (orphans.length === 0) continue;

      const records = orphans.flatMap((row) => row.knowledge?.records ?? []);
      // Sorted so the sentence does not depend on the order the store happens to return records in.
      const clauses = [
        ...new Set(records.map((record) => describeRecord(record, envelope.knowledge.groups))),
      ].sort();
      const hits = `${orphans.length} bare superseded hit(s)`;
      (bare[retrievalCase.name] ??= {})[query] =
        records.length === 0
          ? `${hits}; no continuing record cites them`
          : `${hits} citing ${records.length} record(s): ${clauses.join('; ')}`;
      if (records.length > 0) carryingStanding += 1;
      if (
        records.some(
          (record) =>
            record.wording === 'superseded' &&
            standingStatements(record, envelope.knowledge.groups).length > 0
        )
      )
        namingTheReplacement += 1;
    }

  return {
    published: {
      requirements: published.rules.length,
      decisions: 1,
      decisionRevisions: published.decision.wordings.length,
    },
    limit,
    bareSuperseded: Object.values(bare).reduce(
      (total, queries) => total + Object.keys(queries).length,
      0
    ),
    carryingStanding,
    namingTheReplacement,
    bare,
  };
}
