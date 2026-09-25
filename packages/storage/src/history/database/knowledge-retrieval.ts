// What continuing knowledge one source is related to, read at one knowledge boundary and bounded so
// that what comes back can never crowd out the source itself.
//
// Pure over the store: it writes nothing, calls no model and takes the boundary as an argument, so
// the same store and the same boundary always answer the same way. Every read goes through
// `knowledgeReadRequest`, so a boundary later than the committed sequence is refused rather than
// read as now.
//
// Candidates are found three ways, in this order, deduplicated by identity, and the order is what
// survives the bounds:
//
// 1. **Exact references from the source** — the task uses of its plan event, and the continuing
//    records that cite a retained source of its own event or of another event of its artifact.
// 2. **The existing search over structured captures** — one match call per term drawn from the
//    source text, all in one pass over the same `artifact_search_sources` rows and through the same
//    match function `search.ts` uses, and then the records that cite the hit events' sources.
// 3. **Wording match against continuing records** — the statements of the revisions found above
//    that share a term with the source. There is no index over revision statements, so this
//    finds no identity of its own: it orders the candidates the first two ways found, and says so
//    as a coverage limit rather than letting a bounded match read as a complete one.
//
// An identity is included whole or not at all: a half-read identity would show a rule without the
// act that stopped it. What is left out is named, with why.
import { type ProjectReadView } from './connection.js';
import {
  type KnowledgeReadCoverage,
  knowledgeReadCoverage,
  knowledgeReadRequest,
} from './knowledge-read-boundary.js';
import { governingStateReader } from './knowledge-read-governing.js';
import { readProjectLineageTips } from './knowledge-read-lineage.js';
import { readProjectTaskUsesAtBoundary } from './knowledge-read-task-uses.js';
import { restrictedSourceLabels, revisionSourceState } from './knowledge-revision-sources.js';
import { retainedIntendedScope, retainedRationale } from './knowledge-wording.js';
import type {
  AuthorityScope,
  KnowledgeInterpretation,
  RecordRevisionRef,
} from '../../schema/knowledge-contract.js';
import type {
  KnowledgeTarget,
  ResolvedKnowledge,
  UnresolvedPoint,
} from '../../schema/knowledge-resolution.js';
import { SEARCH_FIELD_MAP_VERSION, SEARCH_SOURCE_KINDS } from '../search-content/fields.js';
import { SEARCH_NORMALIZATION_VERSION, tokenizeSearchText } from '../search-content/matching.js';

/** The source one retrieval is about, as the worker holds it before any manifest exists. */
export interface RelatedKnowledgeSource {
  readonly artifactId: string;
  readonly eventId: string;
  /** The plan event a task use would name, when the artifact has one. */
  readonly planEventId: string | null;
  /** The authored text, which the search terms and the wording match are drawn from. */
  readonly text: string;
}

export interface RelatedKnowledgeBounds {
  /** How many identities one manifest may carry. */
  readonly maxIdentities: number;
  /** How many bytes of revision statements all of those identities may take together. */
  readonly maxStatementBytes: number;
  /** How many terms of the source text the search is asked about. */
  readonly maxSearchTerms: number;
  /** How many search rows are taken, over all terms together. */
  readonly maxSearchHits: number;
  /** How many retained sources any one route follows before it stops. */
  readonly maxSourcesFollowed: number;
}

export interface RetrieveRelatedKnowledgeInput {
  readonly source: RelatedKnowledgeSource;
  readonly projectId: string;
  /** The authority scope the source itself sits in, which every answer is read in. */
  readonly scope: AuthorityScope;
  /** A write sequence. Never `now`: an attempt names the boundary it was read at. */
  readonly boundary: number;
  readonly bounds: RelatedKnowledgeBounds;
}

/** How a candidate identity was reached. The order here is the order candidates are kept in. */
export type RelatedKnowledgeRoute =
  | 'task_use'
  | 'source_reference'
  | 'artifact_event'
  | 'search_hit';

const ROUTE_ORDER: readonly RelatedKnowledgeRoute[] = [
  'task_use',
  'source_reference',
  'artifact_event',
  'search_hit',
];

export interface RetrievedStatement {
  readonly revision: RecordRevisionRef;
  readonly text: string;
  readonly rationale?: string | null;
  readonly intended_scope?: KnowledgeInterpretation['intended_scope'];
  readonly intended_scope_status?: 'legacy_absent' | 'verified' | 'invalid';
}

export interface RetrievedKnowledge {
  readonly target: KnowledgeTarget;
  /** Every way this identity was reached, in the order the ways are tried. */
  readonly routes: readonly RelatedKnowledgeRoute[];
  readonly resolved: ResolvedKnowledge;
  readonly statements: readonly RetrievedStatement[];
  /** The UTF-8 bytes of those statements, which is what the byte bound is spent on. */
  readonly statementBytes: number;
  /** Whether any statement of this identity shares a search term with the source. */
  readonly sharesWording: boolean;
}

export type RelatedKnowledgeOmissionKind =
  | 'identity_count'
  | 'statement_bytes'
  | 'search_hit_cap'
  | 'sources_followed_cap'
  | 'search_index_stale'
  | 'later_than_boundary'
  | 'wording_match_bounded'
  | 'access_restricted';

export interface RelatedKnowledgeOmission {
  readonly kind: RelatedKnowledgeOmissionKind;
  readonly detail: string;
}

export interface RelatedKnowledgeCounts {
  readonly candidates: number;
  readonly included: number;
  readonly omitted: number;
  readonly searchTerms: number;
  readonly searchHits: number;
  readonly statementBytes: number;
}

export interface RelatedKnowledgeRetrieval {
  /** The write sequence every answer below was read at. */
  readonly boundary: number;
  readonly scope: AuthorityScope;
  readonly bounds: RelatedKnowledgeBounds;
  readonly coverage: KnowledgeReadCoverage;
  readonly entries: readonly RetrievedKnowledge[];
  readonly omissions: readonly RelatedKnowledgeOmission[];
  readonly counts: RelatedKnowledgeCounts;
}

/**
 * Words too common to distinguish one captured record from another. Kept small and fixed: a longer
 * list would be a ranking judgment nothing here measures, and every word left in costs one query
 * against a bound that is spent in order.
 */
const SEARCH_STOP_WORDS: ReadonlySet<string> = new Set([
  'about',
  'after',
  'again',
  'also',
  'because',
  'been',
  'before',
  'being',
  'between',
  'both',
  'came',
  'does',
  'done',
  'each',
  'else',
  'even',
  'ever',
  'every',
  'from',
  'have',
  'here',
  'into',
  'its',
  'just',
  'like',
  'made',
  'make',
  'many',
  'more',
  'most',
  'much',
  'must',
  'need',
  'only',
  'other',
  'over',
  'same',
  'shall',
  'should',
  'since',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'until',
  'upon',
  'very',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'would',
  'your',
]);

const MINIMUM_TERM_LENGTH = 4;

/**
 * The terms one source is searched by: its distinct words of four letters or more, without the
 * stop list, longest first and then alphabetically, capped. Longest first because a longer word
 * distinguishes more records, and the tie is broken alphabetically so the same source always asks
 * the same questions in the same order.
 */
export function relatedKnowledgeSearchTerms(text: string, cap: number): string[] {
  if (cap <= 0) return [];
  const distinct = new Set(
    tokenizeSearchText(text).filter(
      (token) => token.length >= MINIMUM_TERM_LENGTH && !SEARCH_STOP_WORDS.has(token)
    )
  );
  return [...distinct]
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, cap);
}

// A kind is one of a fixed set and holds no colon, so kind and id never run together ambiguously.
const identityKey = (target: KnowledgeTarget) => `${target.kind}:${target.entity_id}`;

interface Candidate {
  readonly target: KnowledgeTarget;
  readonly routes: Set<RelatedKnowledgeRoute>;
}

/** A source this read may follow, and the restriction that stops it being followed. */
export interface RetainedSourceRow extends SequencedRow {
  source_id: string;
  access_restriction: string | null;
}

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(',');

export interface InterpretationCandidateSourceState {
  readonly readable: boolean;
  readonly sourceIds: readonly string[];
  readonly restrictions: readonly string[];
}

export function interpretationCandidateSourceState(
  view: ProjectReadView,
  target: KnowledgeTarget,
  revisionIds: readonly string[],
  boundary: number
): InterpretationCandidateSourceState {
  if (target.kind === 'relationship' || revisionIds.length === 0)
    return { readable: true, sourceIds: [], restrictions: [] };
  const ids = [...new Set(revisionIds)].sort();
  const sourceIds = new Set<string>();
  for (let start = 0; start < ids.length; start += 256) {
    const batch = ids.slice(start, start + 256);
    for (const row of view.all<{ origin_source_id: string; evidence_source_id: string | null }>(
      `SELECT i.origin_source_id, evidence.source_id AS evidence_source_id
       FROM knowledge_interpretations i
       JOIN operations o ON o.operation_id=i.operation_id
       LEFT JOIN knowledge_interpretation_evidence evidence
         ON evidence.interpretation_id=i.interpretation_id
       WHERE i.outcome_kind='candidate_revision' AND i.target_kind=? AND i.target_id=?
         AND i.target_revision_id IN (${placeholders(batch)})
         AND o.committed_write_sequence<=?`,
      target.kind,
      target.entity_id,
      ...batch,
      boundary
    )) {
      sourceIds.add(row.origin_source_id);
      if (row.evidence_source_id !== null) sourceIds.add(row.evidence_source_id);
    }
  }
  const revision = revisionSourceState(view, target, ids);
  for (const sourceId of revision.sourceIds) sourceIds.add(sourceId);
  if (!revision.readable) {
    const held = [...sourceIds].sort();
    return {
      readable: false,
      sourceIds: held,
      restrictions: restrictedSourceLabels(view, held),
    };
  }
  const held = [...sourceIds].sort();
  return {
    readable: true,
    sourceIds: held,
    restrictions: restrictedSourceLabels(view, held),
  };
}

/** Distinct and sorted, so the same store is asked the same question in the same order. */
const asked = (ids: readonly string[], cap: number) => [...new Set(ids)].sort().slice(0, cap);

/**
 * What a discovery query found, split at the boundary. Every way of reaching a candidate is bounded
 * the same way, because the resolver bounds what it says about an identity and not which identities
 * it is asked about: without it an answer already given at a boundary would gain identities, and
 * lose the ones they displaced, as later acts landed. What the boundary held back is counted rather
 * than dropped in silence.
 */
interface BoundedRows<Row> {
  readonly rows: readonly Row[];
  readonly later: number;
}

interface SequencedRow {
  write_sequence: number;
}

/** A read never writes, so a row with no receipt yet is later than any boundary it could be given. */
const COMMITTED_AT = `coalesce(o.committed_write_sequence, ${Number.MAX_SAFE_INTEGER}) AS write_sequence`;
const COMMITTING = 'LEFT JOIN operations o ON o.operation_id=r.operation_id';

const upTo = <Row extends SequencedRow>(rows: Row[], boundary: number): BoundedRows<Row> => ({
  rows: rows.filter((row) => row.write_sequence <= boundary),
  later: rows.reduce((count, row) => count + (row.write_sequence > boundary ? 1 : 0), 0),
});

/**
 * An artifact event carries no operation id of its own. The push that appended it wrote the
 * artifact revision beside it in the same operation, and every revision whose event count reaches
 * the event's ordinal covers it, so the earliest of those is the sequence the event committed at.
 */
const eventCommittedAt = (event: string) =>
  `(SELECT min(o.committed_write_sequence) FROM artifact_events c
      JOIN artifact_revisions v ON v.artifact_id=c.artifact_id AND v.event_count>=c.ordinal
      JOIN operations o ON o.operation_id=v.operation_id
     WHERE c.event_id=${event})`;

export function knowledgeSourcesOfEvents(
  view: ProjectReadView,
  eventIds: readonly string[],
  boundary: number
): BoundedRows<RetainedSourceRow> {
  if (eventIds.length === 0) return { rows: [], later: 0 };
  return upTo(
    view.all<RetainedSourceRow>(
      `SELECT r.source_id, r.access_restriction, ${COMMITTED_AT} FROM knowledge_sources r ${COMMITTING}
       WHERE r.source_kind='capture_field' AND r.event_id IN (${placeholders(eventIds)})
       ORDER BY r.source_id`,
      ...eventIds
    ),
    boundary
  );
}

/**
 * The continuing records that cite one of these retained sources, through the lookup columns the
 * writers keep beside each payload: a requirement promoted from a passage of the source, a decision
 * or claim revision located at it, and a passage restatement that names it. Nothing here reads a
 * payload to find a row.
 */
export function identitiesCitingSources(
  view: ProjectReadView,
  sourceIds: readonly string[],
  boundary: number
): BoundedRows<KnowledgeTarget> & { unavailable: number } {
  if (sourceIds.length === 0) return { rows: [], later: 0, unavailable: 0 };
  const list = placeholders(sourceIds);
  const found: KnowledgeTarget[] = [];
  let later = 0;
  let unavailable = 0;
  const citing = <Row extends SequencedRow>(
    query: string,
    target: (row: Row) => KnowledgeTarget,
    include: (row: Row, target: KnowledgeTarget) => boolean = () => true
  ) => {
    const bounded = upTo(view.all<Row>(query, ...sourceIds), boundary);
    for (const row of bounded.rows) {
      const resolved = target(row);
      if (include(row, resolved)) found.push(resolved);
      else unavailable++;
    }
    later += bounded.later;
  };
  citing<{ requirement_id: string } & SequencedRow>(
    `SELECT r.requirement_id, ${COMMITTED_AT} FROM requirements r ${COMMITTING}
     WHERE r.origin_kind='promoted_source' AND r.passage_source_id IN (${list})
     ORDER BY r.requirement_id`,
    (row) => ({ kind: 'requirement', entity_id: row.requirement_id })
  );
  citing<{ decision_id: string; revision_id: string } & SequencedRow>(
    `SELECT r.decision_id, r.revision_id, ${COMMITTED_AT}
     FROM decision_revisions r ${COMMITTING}
     WHERE r.source_event_id IN (${list})
     ORDER BY r.decision_id`,
    (row) => ({ kind: 'decision', entity_id: row.decision_id }),
    (row, target) => {
      const state = revisionSourceState(view, target, [row.revision_id]);
      return state.readable && restrictedSourceLabels(view, state.sourceIds).length === 0;
    }
  );
  citing<{ claim_id: string; revision_id: string } & SequencedRow>(
    `SELECT r.claim_id, r.revision_id, ${COMMITTED_AT}
     FROM claim_revisions r ${COMMITTING}
     WHERE r.source_event_id IN (${list})
     ORDER BY r.claim_id`,
    (row) => ({ kind: 'claim', entity_id: row.claim_id }),
    (row, target) => {
      const state = revisionSourceState(view, target, [row.revision_id]);
      return state.readable && restrictedSourceLabels(view, state.sourceIds).length === 0;
    }
  );
  citing<{ restates_kind: string; restates_id: string } & SequencedRow>(
    `SELECT DISTINCT r.restates_kind, r.restates_id, ${COMMITTED_AT} FROM passage_restatements r ${COMMITTING}
     WHERE r.passage_source_id IN (${list}) ORDER BY r.restates_kind, r.restates_id`,
    (row) => ({ kind: row.restates_kind as KnowledgeTarget['kind'], entity_id: row.restates_id })
  );
  citing<
    {
      target_kind: string;
      target_id: string;
      target_revision_id: string;
    } & SequencedRow
  >(
    `SELECT r.target_kind, r.target_id, r.target_revision_id, ${COMMITTED_AT}
     FROM knowledge_interpretation_evidence e
     JOIN knowledge_interpretations r ON r.interpretation_id=e.interpretation_id
     ${COMMITTING}
     WHERE r.outcome_kind='candidate_revision' AND e.source_id IN (${list})
     ORDER BY r.target_kind, r.target_id`,
    (row) => ({ kind: row.target_kind as KnowledgeTarget['kind'], entity_id: row.target_id }),
    (row, target) => {
      const state = interpretationCandidateSourceState(
        view,
        target,
        [row.target_revision_id],
        boundary
      );
      return state.readable && state.restrictions.length === 0;
    }
  );
  return { rows: found, later, unavailable };
}

/**
 * Every event of the artifact, oldest first, which is the order its records were published in and
 * so the order the boundary divides them in: a later event is always beyond the ones this read may
 * follow, never in place of one.
 */
function artifactEventIds(
  view: ProjectReadView,
  artifactId: string,
  cap: number,
  boundary: number
): BoundedRows<string> {
  const page = upTo(
    view.all<{ event_id: string } & SequencedRow>(
      `SELECT e.event_id, coalesce(${eventCommittedAt('e.event_id')}, ${Number.MAX_SAFE_INTEGER}) AS write_sequence
       FROM artifact_events e WHERE e.artifact_id=? ORDER BY e.ordinal LIMIT ?`,
      artifactId,
      cap
    ),
    boundary
  );
  return { rows: page.rows.map((row) => row.event_id), later: page.later };
}

/** The search source kinds this retrieval asks about: every authored one, and no derived digest. */
const RETRIEVAL_SEARCH_KINDS = SEARCH_SOURCE_KINDS.filter((kind) => kind !== 'digest');

interface SearchHitRow {
  artifact_id: string;
  source_event_id: string | null;
}

/**
 * The search projection is rewritten whole at every push, so a hit row carries no operation of its
 * own and a row for an event appended after the boundary sits beside the rest. The event it names
 * is what dates it; a row that names none is left to the sources it leads to, which carry their
 * own operation and are bounded there.
 */
const HIT_EVENT = "json_extract(s.payload_json,'$.metadata.source_event_id')";
const HIT_COMMITTED_AT = eventCommittedAt(HIT_EVENT);

/**
 * The artifacts' structured captures that match any one of these terms, through the same rows and
 * the same match function `queryProjectSearch` uses. One term per call, because the match function
 * requires every term of a query to be present and a whole source's vocabulary is never all in one
 * record; a disjunction over the terms keeps that to one pass over the rows.
 *
 * Matching is a function over each row's tokens, so no index can serve it and this scans the search
 * projection exactly as the search command does.
 */
function searchHits(
  view: ProjectReadView,
  terms: readonly string[],
  limit: number,
  boundary: number
): BoundedRows<SearchHitRow> {
  if (terms.length === 0 || limit <= 0) return { rows: [], later: 0 };
  const match = terms.map(() => 'orcaops_search_match(s.tokens_json, ?) IS NOT NULL').join(' OR ');
  const matching = `FROM artifact_search_sources s
     WHERE s.source_kind IN (${placeholders(RETRIEVAL_SEARCH_KINDS)}) AND (${match})`;
  const asked = [
    ...RETRIEVAL_SEARCH_KINDS,
    ...terms.map((term) => JSON.stringify([term])),
    boundary,
  ];
  const rows = view.all<SearchHitRow>(
    `SELECT s.artifact_id, ${HIT_EVENT} AS source_event_id ${matching}
       AND (${HIT_COMMITTED_AT} IS NULL OR ${HIT_COMMITTED_AT}<=?)
     ORDER BY s.artifact_id, s.source_id LIMIT ?`,
    ...asked,
    limit
  );
  const later =
    view.get<{ later: number }>(
      `SELECT count(*) AS later ${matching} AND ${HIT_COMMITTED_AT}>?`,
      ...asked
    )?.later ?? 0;
  return { rows, later };
}

/**
 * Whether any artifact's search rows are missing or built by another build. The search command
 * refuses outright; retrieval reports it, because a stale projection makes the second way
 * incomplete and makes nothing else wrong.
 */
function staleSearchArtifacts(view: ProjectReadView): number {
  return (
    view.get<{ stale: number }>(
      `SELECT count(*) AS stale FROM artifacts a
       LEFT JOIN artifact_search_state s ON s.artifact_id=a.artifact_id
       WHERE s.artifact_id IS NULL OR s.generation<>a.current_generation
         OR s.normalization_version<>? OR s.field_map_version<>?
         OR s.source_count<>(SELECT count(*) FROM artifact_search_sources r WHERE r.artifact_id=a.artifact_id)`,
      SEARCH_NORMALIZATION_VERSION,
      SEARCH_FIELD_MAP_VERSION
    )?.stale ?? 0
  );
}

const STATEMENT_QUERY: Readonly<Record<string, { table: string; column: string; field: string }>> =
  {
    requirement: { table: 'requirement_revisions', column: 'revision_id', field: 'statement' },
    // A decision's statement is the approach it chose; its reason and alternatives are beside it in
    // the same payload and are not what a revision states.
    decision: { table: 'decision_revisions', column: 'revision_id', field: 'chosen_approach' },
    claim: { table: 'claim_revisions', column: 'revision_id', field: 'statement' },
  };

function statementOf(payload: string, field: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const stated = (value as Record<string, unknown>)[field];
  return typeof stated === 'string' && stated.length > 0 ? stated : null;
}

/**
 * The wording of these revisions of one identity, by revision id. A revision whose record this
 * store cannot read is simply absent: the manifest reports it as a statement that was not
 * retained, and nothing here invents one.
 */
function statementsOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  revisionIds: readonly string[],
  boundary: number
): Map<string, Omit<RetrievedStatement, 'revision'>> {
  const query = STATEMENT_QUERY[target.kind];
  if (query === undefined || revisionIds.length === 0) return new Map();
  const ids = [...new Set(revisionIds)].sort();
  const wording = new Map<string, Omit<RetrievedStatement, 'revision'>>();
  for (const row of view.all<{ revision_id: string; payload: string }>(
    `SELECT ${query.column} AS revision_id, CAST(record_bytes AS TEXT) AS payload
     FROM ${query.table} WHERE ${query.column} IN (${placeholders(ids)})`,
    ...ids
  )) {
    const text = statementOf(row.payload, query.field);
    const rationale = retainedRationale(row.payload, target.kind);
    const intendedScope = retainedIntendedScope(
      view,
      row.payload,
      { ...target, revision_id: row.revision_id },
      boundary
    );
    if (text !== null)
      wording.set(row.revision_id, {
        text,
        ...(rationale === undefined ? {} : { rationale }),
        ...intendedScope,
      });
  }
  return wording;
}

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

export function retrieveRelatedKnowledge(
  view: ProjectReadView,
  input: RetrieveRelatedKnowledgeInput
): RelatedKnowledgeRetrieval {
  const { bounds, projectId, source } = input;
  const request = knowledgeReadRequest(view, {
    scope: input.scope,
    mode: 'current',
    boundary: input.boundary,
  });
  const omissions: RelatedKnowledgeOmission[] = [];
  const candidates = new Map<string, Candidate>();
  const unresolved: UnresolvedPoint[] = [];
  const restricted = new Set<string>();

  const add = (target: KnowledgeTarget, route: RelatedKnowledgeRoute) => {
    const key = identityKey(target);
    const held = candidates.get(key);
    if (held === undefined) candidates.set(key, { target, routes: new Set([route]) });
    else held.routes.add(route);
  };

  const boundary = request.knowledge_boundary;
  /** Rows every way of finding a candidate saw and did not follow, because a later act wrote them. */
  let laterThanBoundary = 0;

  /** The sources of these events this read may follow, with the restricted ones set aside. */
  const followable = (eventIds: readonly string[]): string[] => {
    const found = knowledgeSourcesOfEvents(
      view,
      asked(eventIds, bounds.maxSourcesFollowed),
      boundary
    );
    laterThanBoundary += found.later;
    const open: string[] = [];
    for (const row of found.rows) {
      if (row.access_restriction === null) open.push(row.source_id);
      else restricted.add(row.access_restriction);
    }
    return open;
  };

  /** The identities these sources are cited by, each counted once against the boundary. */
  const citedBy = (sourceIds: readonly string[]): readonly KnowledgeTarget[] => {
    const found = identitiesCitingSources(view, sourceIds, boundary);
    laterThanBoundary += found.later;
    return found.rows;
  };

  const governing = governingStateReader(view, projectId, request);
  const taskUses =
    source.planEventId === null
      ? null
      : // The same reader every candidate is resolved through, so an identity this plan event
        // uses is not resolved once here and again below.
        readProjectTaskUsesAtBoundary(view, source.planEventId, projectId, request, governing);
  if (taskUses !== null)
    for (const use of [...taskUses.selectedWithPlan, ...taskUses.connectedLater])
      add(
        {
          kind: use.use.target.kind as KnowledgeTarget['kind'],
          entity_id: use.use.target.entityId,
        },
        'task_use'
      );

  for (const target of citedBy(followable([source.eventId]))) add(target, 'source_reference');

  const events = artifactEventIds(view, source.artifactId, bounds.maxSourcesFollowed + 1, boundary);
  laterThanBoundary += events.later;
  const artifactEvents = events.rows.filter((eventId) => eventId !== source.eventId);
  if (artifactEvents.length > bounds.maxSourcesFollowed)
    omissions.push({
      kind: 'sources_followed_cap',
      detail:
        `Artifact ${source.artifactId} holds more than ${bounds.maxSourcesFollowed} other events; ` +
        `the records published from the ones beyond that were not looked for.`,
    });
  for (const target of citedBy(followable(artifactEvents))) add(target, 'artifact_event');

  const terms = relatedKnowledgeSearchTerms(source.text, bounds.maxSearchTerms);
  const stale = staleSearchArtifacts(view);
  if (stale > 0)
    omissions.push({
      kind: 'search_index_stale',
      detail:
        `${stale} artifact(s) hold no search projection this build can read, so the search over ` +
        `structured captures did not cover them. An explicit index rebuild covers them again.`,
    });
  const hits = searchHits(view, terms, bounds.maxSearchHits + 1, boundary);
  if (hits.rows.length > bounds.maxSearchHits)
    omissions.push({
      kind: 'search_hit_cap',
      detail:
        `The search over structured captures matched more than ${bounds.maxSearchHits} rows for ` +
        `${terms.length} term(s); the rows beyond that were not followed.`,
    });
  laterThanBoundary += hits.later;
  const hitEvents = hits.rows
    .slice(0, bounds.maxSearchHits)
    .flatMap((hit) => (hit.source_event_id === null ? [] : [hit.source_event_id]));
  for (const target of citedBy(followable(hitEvents))) add(target, 'search_hit');

  if (laterThanBoundary > 0)
    omissions.push({
      kind: 'later_than_boundary',
      detail:
        `${laterThanBoundary} capture event(s), retained source(s), continuing record(s) or ` +
        `search row(s) that a way of finding related knowledge reached were committed after write ` +
        `sequence ${boundary}; a read at that boundary does not follow them.`,
    });

  const termSet = new Set(terms);
  const read = [...candidates.values()].flatMap((candidate) => {
    const resolved = governing.at(candidate.target);
    // The same reader, so an identity resolved for the manifest is not resolved again for the
    // revisions the resolver was not given.
    const tips = readProjectLineageTips(view, candidate.target, projectId, request, governing);
    const named = [
      ...resolved.revisions.map((entry) => entry.revision),
      ...tips.tips.map((tip) => tip.revision),
    ];
    const sourceState = interpretationCandidateSourceState(
      view,
      candidate.target,
      named.map((revision) => revision.revision_id),
      request.knowledge_boundary
    );
    if (sourceState.restrictions.length > 0) {
      for (const restriction of sourceState.restrictions) restricted.add(restriction);
      return [];
    }
    unresolved.push(...tips.coverage.unresolved);
    if (!sourceState.readable) {
      const alreadyUnsupplied = new Set(
        tips.coverage.unresolved
          .filter((point) => point.reason === 'revision_not_supplied')
          .flatMap((point) => point.record_ids)
      );
      const recordIds = named
        .map((revision) => revision.revision_id)
        .filter((revisionId) => !alreadyUnsupplied.has(revisionId));
      if (recordIds.length > 0)
        unresolved.push({
          about: 'revision',
          record_ids: recordIds,
          reason: 'revision_not_supplied',
        });
      return [];
    }
    const wording = statementsOf(
      view,
      candidate.target,
      named.map((revision) => revision.revision_id),
      request.knowledge_boundary
    );
    const seen = new Set<string>();
    const statements: RetrievedStatement[] = [];
    for (const revision of named) {
      if (seen.has(revision.revision_id)) continue;
      seen.add(revision.revision_id);
      const stated = wording.get(revision.revision_id);
      if (stated !== undefined) statements.push({ revision, ...stated });
    }
    // Only the revisions the resolver named reach the manifest, so only they are charged for. A
    // lineage tip the resolver did not name is read to find the wording match and costs nothing.
    const carried = new Set(resolved.revisions.map((entry) => entry.revision.revision_id));
    const statementBytes = statements
      .filter((statement) => carried.has(statement.revision.revision_id))
      .reduce(
        (total, statement) =>
          total + byteLength(statement.text) + byteLength(statement.rationale ?? ''),
        0
      );
    const sharesWording = statements.some((statement) =>
      tokenizeSearchText(statement.text).some((token) => termSet.has(token))
    );
    return [
      {
        target: candidate.target,
        routes: ROUTE_ORDER.filter((route) => candidate.routes.has(route)),
        resolved,
        statements,
        statementBytes,
        sharesWording,
      } satisfies RetrievedKnowledge,
    ];
  });

  // An identity the resolver knew nothing about at this boundary is not related knowledge: its
  // records were published later, or in a scope this read does not reach. It is dropped rather
  // than carried as an empty answer, and the coverage says which records came later and which
  // were omitted, so its absence is stated and not silent.
  const visible = read.filter((entry) => entry.resolved.revisions.length > 0);

  if (restricted.size > 0)
    omissions.push({
      kind: 'access_restricted',
      detail:
        `Retained source(s) under ${[...restricted].sort().join(', ')} were not read, so any ` +
        `record that only they cite is not here.`,
    });

  const rank = (entry: RetrievedKnowledge) => ROUTE_ORDER.indexOf(entry.routes[0]!);
  const ordered = [...visible].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      Number(right.sharesWording) - Number(left.sharesWording) ||
      (identityKey(left.target) < identityKey(right.target) ? -1 : 1)
  );

  const entries: RetrievedKnowledge[] = [];
  let statementBytes = 0;
  let byCount = 0;
  let byBytes = 0;
  for (const entry of ordered) {
    if (entries.length >= bounds.maxIdentities) {
      byCount += 1;
      continue;
    }
    if (statementBytes + entry.statementBytes > bounds.maxStatementBytes) {
      byBytes += 1;
      continue;
    }
    entries.push(entry);
    statementBytes += entry.statementBytes;
  }
  if (byCount > 0)
    omissions.push({
      kind: 'identity_count',
      detail: `${byCount} related identit(y/ies) were left out: this manifest carries at most ${bounds.maxIdentities}.`,
    });
  if (byBytes > 0)
    omissions.push({
      kind: 'statement_bytes',
      detail:
        `${byBytes} related identit(y/ies) were left out whole: their statements did not fit the ` +
        `${bounds.maxStatementBytes} bytes this manifest gives related knowledge.`,
    });
  omissions.push({
    kind: 'wording_match_bounded',
    detail:
      `Wording match ran over the ${visible.length} identit(y/ies) the exact references and the ` +
      `search found, and over no others: this store has no index over revision statements, so a ` +
      `record whose words resemble the source and which nothing cites was not looked for.`,
  });

  return {
    boundary: request.knowledge_boundary,
    scope: input.scope,
    bounds,
    // The identities THIS retrieval asked about, never every answer the reader holds: the reader is
    // shared with the task-uses read, and a coverage statement reports what its own read reached.
    coverage: knowledgeReadCoverage(
      request,
      read.map((entry) => entry.resolved),
      unresolved
    ),
    entries,
    omissions,
    counts: {
      candidates: visible.length,
      included: entries.length,
      omitted: visible.length - entries.length,
      searchTerms: terms.length,
      searchHits: Math.min(hits.rows.length, bounds.maxSearchHits),
      statementBytes,
    },
  };
}
