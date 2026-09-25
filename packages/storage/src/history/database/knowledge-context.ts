// One read that answers "what continuing knowledge bears on this?", composed from the boundary
// readers behind a single snapshot.
//
// Everything a surface needs about one identity — what stands, every revision visible at the
// boundary with its wording, the tasks that used it in two lists, and the sources to drill into —
// comes from one `governingStateReader`, so an identity is resolved once however many of those
// parts name it. **Nothing here defaults a boundary.** The caller names a write sequence or asks
// for `now`, exactly as `knowledgeReadRequest` requires: a composed answer that quietly picked its
// own would answer a question nobody asked.
//
// It writes nothing, opens nothing for writing, starts nothing and calls no model.
import { type ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type KnowledgeBoundary,
  type KnowledgeReadCoverage,
  knowledgeReadCoverage,
  knowledgeReadRequest,
  writeSequencesOf,
} from './knowledge-read-boundary.js';
import {
  type ProjectExpectationAssessment,
  readProjectExpectationAssessments,
} from './knowledge-read-evidence.js';
import { governingStateReader } from './knowledge-read-governing.js';
import {
  type ProjectInterpretationRead,
  readProjectKnowledgeInterpretations,
} from './knowledge-read-interpretations.js';
import {
  type ProjectLineageRevision,
  type ProjectLineageTip,
  readProjectLineageTips,
} from './knowledge-read-lineage.js';
import {
  type ProjectReconsiderationItem,
  readProjectReconsiderationItems,
} from './knowledge-reconsideration.js';
import { invalid } from './knowledge-record-input.js';
import {
  identitiesCitingSources,
  interpretationCandidateSourceState,
  knowledgeSourcesOfEvents,
  type RelatedKnowledgeBounds,
  type RelatedKnowledgeOmission,
  type RelatedKnowledgeRetrieval,
  type RelatedKnowledgeRoute,
  type RelatedKnowledgeSource,
  type RetrievedStatement,
  retrieveRelatedKnowledge,
} from './knowledge-retrieval.js';
import { published } from './knowledge-standing.js';
import { listProjectTaskUses, type ProjectTaskUseRow } from './knowledge-task-uses.js';
import { retainedIntendedScope, retainedRationale } from './knowledge-wording.js';
import type {
  ApplicabilityInputs,
  Attribution,
  AuthorityScope,
  ExpectationRevisionRef,
  RecordRevisionRef,
} from '../../schema/knowledge-contract.js';
import type {
  AssignmentStandingEntry,
  KnowledgeReadRequest,
  KnowledgeTarget,
  ResolvedKnowledge,
  SelectedImplementation,
  UnresolvedPoint,
} from '../../schema/knowledge-resolution.js';

/** How an identity reached this answer. `requested` is one the caller named itself. */
export type KnowledgeContextRoute = 'requested' | RelatedKnowledgeRoute;

const ROUTE_ORDER: readonly KnowledgeContextRoute[] = [
  'requested',
  'task_use',
  'source_reference',
  'artifact_event',
  'search_hit',
];

/** A retained source one of the identity's records cites, and the capture it is a field of. */
export interface ProjectKnowledgeReference {
  readonly sourceId: string;
  /** Both null for a source that is not a capture field — an instruction, a document revision. */
  readonly artifactId: string | null;
  readonly eventId: string | null;
  readonly accessRestriction: string | null;
  /**
   * The revisions of this identity a lookup column ties to this source: the revision a promoted
   * requirement's identity was promoted with, and the decision or claim revisions located at it.
   * Empty where the store holds no column tying a revision to the source, which is what a reader
   * that wants to name the wording a capture holds has to treat as unknown rather than guess.
   */
  readonly revisionIds: readonly string[];
}

/** The plan criterion a requirement is, for one promoted from a criterion. */
export interface PromotedCriterionOrigin {
  readonly artifactId: string;
  readonly planEventId: string;
  readonly criterionId: string;
}

export interface ProjectKnowledgeContextUse {
  readonly use: ProjectTaskUseRow;
  readonly writeSequence: number;
}

/** One assessment's conclusion about one exact revision of an identity, with its own basis. */
export interface ProjectKnowledgeContextAssessment {
  readonly expectation: ExpectationRevisionRef;
  readonly assessment: ProjectExpectationAssessment;
}

export interface ProjectKnowledgeContextEntry {
  readonly target: KnowledgeTarget;
  readonly routes: readonly KnowledgeContextRoute[];
  readonly resolved: ResolvedKnowledge;
  /** Every revision visible at the boundary, tips and predecessors alike. */
  readonly revisions: readonly ProjectLineageRevision[];
  readonly tips: readonly ProjectLineageTip[];
  /** The wording of the revisions this store can read, in the order the revisions were named. */
  readonly statements: readonly RetrievedStatement[];
  /** The uses a plan event's own operation wrote. */
  readonly selectedWithPlan: readonly ProjectKnowledgeContextUse[];
  /** The uses a later operation connected, each naming who found the connection and when. */
  readonly connectedLater: readonly ProjectKnowledgeContextUse[];
  readonly references: readonly ProjectKnowledgeReference[];
  /** Null for every identity but a requirement that is a plan's promoted criterion. */
  readonly criterion: PromotedCriterionOrigin | null;
  /**
   * The assessments that concluded about a revision of this identity, oldest first. Absent for an
   * entry composed by a caller that reads none, which is why it is optional rather than empty:
   * empty says this store holds none.
   */
  readonly assessments?: readonly ProjectKnowledgeContextAssessment[];
  /** The ids of assessments of this identity published after the boundary, named rather than hidden. */
  readonly laterAssessments?: readonly string[];
  /**
   * The reconsideration items open about this identity at the boundary, oldest first. Absent for
   * an entry composed by a caller that reads none, which is why it is optional rather than empty:
   * empty says nothing is open about it.
   */
  readonly openReconsiderations?: readonly ProjectReconsiderationItem[];
  /**
   * The assignments whose inherited or delegated footprint names this identity, with how each
   * stood at the boundary. Absent for an entry composed by a caller that reads none, which is why
   * it is optional rather than empty: empty says nobody delegated anything about it.
   */
  readonly assignments?: readonly AssignmentStandingEntry[];
}

export interface ProjectKnowledgeContext {
  /** The request every answer below was read under, echoing the boundary and the mode. */
  readonly request: KnowledgeReadRequest;
  readonly coverage: KnowledgeReadCoverage;
  /**
   * The project's intent counter at this read. An assessment stamps the counter it observed, and
   * whether recorded intent has moved since is how a reader judges that it has gone stale; it is
   * read here so the same snapshot answers both questions.
   */
  readonly intentCounter?: number;
  readonly entries: readonly ProjectKnowledgeContextEntry[];
  readonly interpretationRead?: ProjectInterpretationRead;
  /** Identities asked about that this store holds no record of at the boundary. */
  readonly absent: readonly KnowledgeTarget[];
  /** Null when the caller named exact identities, so nothing was retrieved. */
  readonly retrieval: RelatedKnowledgeRetrieval | null;
  /** What retrieval did not reach, in its own words. Empty for an identities request. */
  readonly omissions: readonly RelatedKnowledgeOmission[];
}

/**
 * What the answer is about: exact identities, every identity this store holds an adoption for, a
 * named subject, one captured event, a captured source, or free text.
 *
 * `captured_event` is the narrow question a search hit asks — which continuing identities cite
 * THIS event — and it follows no other event of the artifact and runs no wording search, so one
 * hit's knowledge can never crowd out an unrelated hit's.
 *
 * `adopted` is the one subject that finds candidates without a question to match them against. It
 * is what "what must this work not miss?" needs: a rule reached only by wording or by a reference
 * the work happens to carry would disappear from the answer exactly when the work never mentioned
 * it, which is the case the answer exists for.
 *
 * `task` is `adopted` plus the identities the named artifacts' plan events actually record a use
 * of. A read surface owes both: what this work must not miss, and what it said it used —
 * including a use of something nobody adopted, which `adopted` alone would drop exactly where the
 * reader most needs to be told the thing it named stands on nothing. It takes a list because a
 * review reads several threads under one answer and must not resolve one identity twice.
 */
export type KnowledgeContextSubject =
  | { readonly kind: 'identities'; readonly targets: readonly KnowledgeTarget[] }
  | { readonly kind: 'adopted' }
  | { readonly kind: 'task'; readonly artifactIds: readonly string[] }
  | { readonly kind: 'subject'; readonly subjectId: string }
  | {
      readonly kind: 'captured_event';
      readonly eventId: string;
      readonly preferredFieldPaths?: readonly string[];
    }
  | { readonly kind: 'source'; readonly source: RelatedKnowledgeSource }
  | { readonly kind: 'text'; readonly text: string };

export interface ProjectKnowledgeContextRequest {
  readonly projectId: string;
  readonly scope: AuthorityScope;
  /** A write sequence, or `now`. Never defaulted: every answer names the boundary it read at. */
  readonly boundary: KnowledgeBoundary;
  readonly mode: 'current' | 'historical';
  readonly subject: KnowledgeContextSubject;
  /**
   * Required for a source or text subject, which reach their identities through retrieval. These
   * bound what is READ. What an answer CARRIES is bounded where placement is known, which is not
   * here: an entry cannot be dropped in the right order before anyone knows what it is.
   */
  readonly bounds?: RelatedKnowledgeBounds;
  /** Separate interpretation selection must not repeat the composer's broad discovery read. */
  readonly interpretations?: boolean;
  /** Caps resolution work, including adopted and explicitly cited identities; omissions remain visible. */
  readonly maxResolvedIdentities?: number;
  readonly implementation?: SelectedImplementation;
  /**
   * Whether to read each identity's assessments and the intent counter beside them. Off by
   * default: a surface that does not show evidence pays nothing for it, and an answer that
   * composed none says so with an absent field rather than an empty list.
   */
  readonly assessments?: boolean;
  /**
   * Whether to read the reconsideration items open about each identity. Off by default, for the
   * reason assessments are: a surface that shows none pays nothing for them, and an answer that
   * composed none says so with an absent field rather than an empty list.
   */
  readonly reconsideration?: boolean;
  /**
   * Whether to read the assignments that name each identity, and let a conflict rest on one. Off by
   * default for the reason the two above are, and because judging an assignment's basis costs a
   * read per rule it names.
   */
  readonly assignments?: boolean;
  /**
   * Who the answer is for. Only an assignment reads it: it delegates to one responsible party, so a
   * conflict it covers is covered for them and for nobody else.
   */
  readonly acting?: Attribution | null;
  readonly applicability?: ApplicabilityInputs;
  readonly exceptionsJudgedAt?: string | null;
  readonly exceptionConditions?: Readonly<Record<string, boolean>>;
}

const identityKey = (target: KnowledgeTarget) => `${target.kind}:${target.entity_id}`;

/**
 * The requirements some revision of which names this subject, through the subject index on
 * `requirement_revisions`. A decision and a claim carry a subject too and nothing indexes it, so
 * this reaches requirements and says so rather than scanning every revision of the store.
 */
const SUBJECT_INDEX_ONLY: RelatedKnowledgeOmission = {
  kind: 'wording_match_bounded',
  detail:
    'A subject question reaches requirements through the subject index on requirement revisions. ' +
    'Decisions and claims record a subject with no index over it, so records of those kinds that ' +
    'name this subject were not looked for.',
};

/**
 * The identities whose records cite a retained source of one captured event. A restricted source
 * is not read, and its absence is said rather than left as a shorter answer, exactly as bounded
 * retrieval says it.
 */
function citedEventIdentities(
  view: ProjectReadView,
  eventId: string,
  boundary: number,
  preferredFieldPaths: readonly string[] = []
): {
  targets: readonly KnowledgeTarget[];
  preferred: ReadonlySet<string>;
  omissions: RelatedKnowledgeOmission[];
} {
  const restricted = new Set<string>();
  const open: string[] = [];
  const sources = knowledgeSourcesOfEvents(view, [eventId], boundary);
  for (const row of sources.rows) {
    if (row.access_restriction === null) open.push(row.source_id);
    else restricted.add(row.access_restriction);
  }
  const cited = identitiesCitingSources(view, open, boundary);
  const preferredPaths = new Set(preferredFieldPaths.slice(0, 128));
  const preferredSources = preferredPaths.size
    ? view
        .all<{ source_id: string; field_path: string | null }>(
          'SELECT source_id, field_path FROM knowledge_sources WHERE event_id=?',
          eventId
        )
        .filter(
          (row) =>
            open.includes(row.source_id) &&
            row.field_path &&
            preferredPaths.has(row.field_path.replace(/\[(\d+)\]/g, '.$1'))
        )
        .map((row) => row.source_id)
    : [];
  const preferred = new Set(
    identitiesCitingSources(view, preferredSources, boundary).rows.map(identityKey)
  );
  const later = sources.later + cited.later;
  return {
    targets: cited.rows,
    preferred,
    omissions: [
      ...(restricted.size === 0
        ? []
        : [
            {
              kind: 'access_restricted' as const,
              detail:
                `Retained source(s) under ${[...restricted].sort().join(', ')} were not read, so ` +
                `any record that only they cite is not here.`,
            },
          ]),
      ...(later === 0
        ? []
        : [
            {
              kind: 'later_than_boundary' as const,
              detail: `${later} row(s) this event's sources reach were published after the boundary and were not followed.`,
            },
          ]),
    ],
  };
}

/**
 * The identities somebody acted on with an adoption record, through the adoption target index.
 * Every kind of record can be adopted, and only a requirement or a decision is an expectation a
 * task can record a use of, so this reaches those two and says what it left out.
 */
const EXPECTATION_KINDS = ['requirement', 'decision'] as const;

const ADOPTED_EXPECTATIONS_ONLY: RelatedKnowledgeOmission = {
  kind: 'wording_match_bounded',
  detail:
    'The adopted question reaches the requirements and decisions this store holds an ' +
    'adoption-conferring act for. Claims and relationships can be adopted too and are not ' +
    'expectations a task records a use of, so acts on those kinds were not looked for.',
};

/**
 * A candidate set is bounded exactly as the readers bound a record. An act committed after the
 * boundary is not part of the question a historical read asked, and an identity reached only
 * through one would otherwise enter an answer that never looked at it — an adoption made since
 * turning up as a background entry of a read at an older boundary, where its own records are not
 * visible for the resolver to place it by.
 */
const upToBoundary = <Row extends { write_sequence: number }>(
  rows: readonly Row[],
  boundary: number
): Row[] => rows.filter((row) => row.write_sequence <= boundary);

function adoptedIdentities(view: ProjectReadView, boundary: number): KnowledgeTarget[] {
  return EXPECTATION_KINDS.flatMap((kind) => {
    const rows = upToBoundary(
      [
        ...view.all<{ target_id: string; write_sequence: number }>(
          `${published('adoptions', 'r.target_id')} WHERE r.target_kind=? ORDER BY r.target_id`,
          kind
        ),
        ...view.all<{ target_id: string; write_sequence: number }>(
          `${published('correction_actions', 'r.adopted_id AS target_id')}
         WHERE r.adopted_kind=? AND r.adopted_id IS NOT NULL ORDER BY r.adopted_id`,
          kind
        ),
      ],
      boundary
    );
    return [...new Set(rows.map((row) => row.target_id))].map(
      (entity_id) => ({ kind, entity_id }) as KnowledgeTarget
    );
  });
}

/**
 * The identities one artifact's plan events record a use of, through the plan events of the
 * artifact and the task-use identity index over each. A use is keyed to the plan event, so this
 * reaches every revision of the thread's plan and the connections found after them alike.
 */
function taskIdentities(
  view: ProjectReadView,
  artifactIds: readonly string[],
  boundary: number
): KnowledgeTarget[] {
  // The plan events are not bounded here, because the uses are: a use commits in an operation of
  // its own, and a plan event appended after the boundary has no use committed at or before it.
  const planEvents = artifactIds.flatMap((artifactId) =>
    view
      .all<{ event_id: string }>(
        `SELECT event_id FROM artifact_events
         WHERE artifact_id=? AND event_type IN ('plan_captured','plan_revised') ORDER BY ordinal`,
        artifactId
      )
      .map((row) => row.event_id)
  );
  const seen = new Map<string, KnowledgeTarget>();
  for (const planEventId of planEvents)
    for (const row of upToBoundary(
      view.all<{ target_kind: string; target_id: string; write_sequence: number }>(
        `${published('task_uses', 'r.target_kind, r.target_id')} WHERE r.plan_event_id=?
         ORDER BY r.target_kind, r.target_id`,
        planEventId
      ),
      boundary
    ))
      seen.set(`${row.target_kind}:${row.target_id}`, {
        kind: row.target_kind,
        entity_id: row.target_id,
      } as KnowledgeTarget);
  return [...seen.values()];
}

function subjectIdentities(
  view: ProjectReadView,
  subjectId: string,
  boundary: number
): KnowledgeTarget[] {
  const rows = upToBoundary(
    view.all<{ requirement_id: string; write_sequence: number }>(
      `${published('requirement_revisions', 'r.requirement_id')} WHERE r.subject_id=?
       ORDER BY r.requirement_id`,
      subjectId
    ),
    boundary
  );
  return [...new Set(rows.map((row) => row.requirement_id))].map((entity_id) => ({
    kind: 'requirement' as const,
    entity_id,
  }));
}

/**
 * A text subject belongs to no capture, so the two exact-reference routes find nothing and only
 * the search over structured captures runs. No stored id is empty — every identifier column
 * checks a non-zero length — so these reach no row rather than the wrong one.
 */
const NO_CAPTURE = '';

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(',');

/** The plan events whose uses name this identity, through the task-use target index. */
function planEventsUsing(view: ProjectReadView, target: KnowledgeTarget): string[] {
  return view
    .all<{
      plan_event_id: string;
    }>(
      'SELECT DISTINCT plan_event_id FROM task_uses WHERE target_kind=? AND target_id=? ORDER BY plan_event_id',
      target.kind,
      target.entity_id
    )
    .map((row) => row.plan_event_id);
}

interface TaskUseLists {
  readonly selectedWithPlan: ProjectKnowledgeContextUse[];
  readonly connectedLater: ProjectKnowledgeContextUse[];
}

/**
 * This identity's uses at the boundary, in two lists. The store derived which list a use belongs
 * in when the row was written, from the operation that wrote it; nothing here reclassifies one,
 * and a third kind is refused rather than letting a use nobody can place vanish from both.
 */
function taskUsesOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  boundary: number
): TaskUseLists {
  const uses = planEventsUsing(view, target)
    .flatMap((planEventId) => listProjectTaskUses(view, planEventId))
    .filter((use) => use.target.kind === target.kind && use.target.entityId === target.entity_id);
  const sequences = writeSequencesOf(
    view,
    uses.map((use) => use.operationId)
  );
  const lists: TaskUseLists = { selectedWithPlan: [], connectedLater: [] };
  for (const use of uses) {
    const writeSequence = sequences.get(use.operationId);
    if (writeSequence === undefined || writeSequence > boundary) continue;
    const entry = { use, writeSequence };
    if (use.selectionKind === 'selected_with_plan') lists.selectedWithPlan.push(entry);
    else if (use.selectionKind === 'connected_later') lists.connectedLater.push(entry);
    else
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A retained task use records a selection this build does not understand; preserve history for explicit repair'
      );
  }
  return lists;
}

/** The intent counter as committed: the signal an assessment's staleness is judged against. */
function intentCounterAt(view: ProjectReadView): number {
  const row = view.get<{ intent_change_counter: number }>(
    'SELECT intent_change_counter FROM project_counters WHERE singleton = 1'
  );
  if (row === null || !Number.isSafeInteger(row.intent_change_counter))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The project intent counter is missing or outside the safe integer range; explicit repair is required'
    );
  return row.intent_change_counter;
}

/**
 * Only a requirement or a decision is an expectation an assessment can conclude about, which is
 * what `knowledge_assessment_conclusions.expectation_kind` holds. A claim or a relationship reaches
 * this with no revision an assessment could name, so no query is run for one.
 */
const ASSESSABLE_KINDS: readonly KnowledgeTarget['kind'][] = ['requirement', 'decision'];

/**
 * The assessments of this identity's revisions at the boundary, with the ones published after it
 * named apart. Every revision the answer carries is asked about, because an assessment of a
 * superseded revision is exactly the historical evidence a reader needs to see beside the one that
 * governs — hiding it would leave a question about that revision looking like one nobody assessed.
 */
function assessmentsOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  revisionIds: readonly string[],
  request: KnowledgeReadRequest
): { assessments: ProjectKnowledgeContextAssessment[]; later: string[] } {
  if (!ASSESSABLE_KINDS.includes(target.kind)) return { assessments: [], later: [] };
  const assessments: ProjectKnowledgeContextAssessment[] = [];
  const later = new Set<string>();
  for (const revisionId of [...new Set(revisionIds)].sort()) {
    const expectation = {
      kind: target.kind,
      entity_id: target.entity_id,
      revision_id: revisionId,
    } as ExpectationRevisionRef;
    const read = readProjectExpectationAssessments(view, expectation, request);
    for (const assessment of read.assessments) assessments.push({ expectation, assessment });
    for (const id of read.later) later.add(id);
  }
  assessments.sort(
    (left, right) =>
      left.assessment.writeSequence - right.assessment.writeSequence ||
      (left.assessment.assessmentId < right.assessment.assessmentId ? -1 : 1)
  );
  return { assessments, later: [...later].sort() };
}

interface RequirementOriginRow {
  first_revision_id: string;
  passage_source_id: string | null;
  criterion_artifact_id: string | null;
  criterion_plan_event_id: string | null;
  criterion_id: string | null;
}

/** The plan criterion a requirement was promoted from, which is the capture it came out of. */
function promotedCriterion(row: RequirementOriginRow | null): PromotedCriterionOrigin | null {
  if (
    row === null ||
    row.criterion_artifact_id === null ||
    row.criterion_plan_event_id === null ||
    row.criterion_id === null
  )
    return null;
  return {
    artifactId: row.criterion_artifact_id,
    planEventId: row.criterion_plan_event_id,
    criterionId: row.criterion_id,
  };
}

const requirementOrigin = (view: ProjectReadView, requirementId: string) =>
  view.get<RequirementOriginRow>(
    `SELECT first_revision_id, passage_source_id, criterion_artifact_id, criterion_plan_event_id,
       criterion_id
     FROM requirements WHERE requirement_id=?`,
    requirementId
  );

/**
 * The sources one identity's records cite, through the lookup columns beside each payload, with
 * the revisions those columns tie to each. A promoted requirement's passage is where its first
 * revision's own words live, which is why that source names that revision; a later requirement
 * revision cites its sources inside its payload and no column carries them, so its wording cannot
 * be tied to a source here and is not guessed at.
 */
function citedSources(
  view: ProjectReadView,
  target: KnowledgeTarget,
  revisionIds: readonly string[],
  origin: RequirementOriginRow | null,
  boundary: number
): Map<string, string[]> {
  const cited = new Map<string, string[]>();
  for (const row of view.all<{ source_id: string; revision_id: string }>(
    `SELECT DISTINCT e.source_id, i.target_revision_id AS revision_id
     FROM knowledge_interpretations i
     JOIN knowledge_interpretation_evidence e ON e.interpretation_id=i.interpretation_id
     JOIN operations o ON o.operation_id=i.operation_id
     WHERE i.outcome_kind='candidate_revision' AND i.target_kind=? AND i.target_id=?
       AND o.committed_write_sequence<=? ORDER BY e.source_id, i.target_revision_id`,
    target.kind,
    target.entity_id,
    boundary
  )) {
    if (!revisionIds.includes(row.revision_id)) continue;
    const held = cited.get(row.source_id) ?? [];
    held.push(row.revision_id);
    cited.set(row.source_id, held);
  }
  if (target.kind === 'requirement') {
    if (origin?.passage_source_id != null)
      cited.set(origin.passage_source_id, [origin.first_revision_id]);
    return cited;
  }
  const ids = [...new Set(revisionIds)].sort();
  if (ids.length === 0) return cited;
  const table = target.kind === 'decision' ? 'decision_revisions' : 'claim_revisions';
  for (const row of view.all<{ revision_id: string; source_event_id: string }>(
    `SELECT revision_id, source_event_id FROM ${table} WHERE revision_id IN (${placeholders(ids)})
     ORDER BY source_event_id, revision_id`,
    ...ids
  )) {
    const held = cited.get(row.source_event_id);
    if (held === undefined) cited.set(row.source_event_id, [row.revision_id]);
    else held.push(row.revision_id);
  }
  return cited;
}

function referencesOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  revisionIds: readonly string[],
  origin: RequirementOriginRow | null,
  boundary: number
): ProjectKnowledgeReference[] {
  const cited = citedSources(view, target, revisionIds, origin, boundary);
  const sourceIds = [...cited.keys()];
  if (sourceIds.length === 0) return [];
  return view
    .all<{
      source_id: string;
      artifact_id: string | null;
      event_id: string | null;
      access_restriction: string | null;
    }>(
      `SELECT source_id, artifact_id, event_id, access_restriction FROM knowledge_sources
       WHERE source_id IN (${placeholders(sourceIds)}) ORDER BY source_id`,
      ...sourceIds
    )
    .map((row) => ({
      sourceId: row.source_id,
      artifactId: row.artifact_id,
      eventId: row.event_id,
      accessRestriction: row.access_restriction,
      revisionIds: cited.get(row.source_id) ?? [],
    }));
}

const STATEMENT_COLUMN: Readonly<Record<string, { table: string; field: string }>> = {
  requirement: { table: 'requirement_revisions', field: 'statement' },
  // A decision's statement is the approach it chose; its reason and alternatives sit beside it in
  // the same payload and are not what the revision states.
  decision: { table: 'decision_revisions', field: 'chosen_approach' },
  claim: { table: 'claim_revisions', field: 'statement' },
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
 * The wording of these revisions. A revision whose record this store cannot read is simply
 * absent — the answer says so through the resolver's own `revision_not_supplied` point — and
 * nothing here invents one.
 */
function statementsOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  revisions: readonly RecordRevisionRef[],
  boundary: number
): RetrievedStatement[] {
  const query = STATEMENT_COLUMN[target.kind];
  const ids = [...new Set(revisions.map((revision) => revision.revision_id))].sort();
  if (query === undefined || ids.length === 0) return [];
  const wording = new Map<string, Omit<RetrievedStatement, 'revision'>>();
  for (const row of view.all<{ revision_id: string; payload: string }>(
    `SELECT revision_id, CAST(record_bytes AS TEXT) AS payload
     FROM ${query.table} WHERE revision_id IN (${placeholders(ids)})`,
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
  const seen = new Set<string>();
  const statements: RetrievedStatement[] = [];
  for (const revision of revisions) {
    if (seen.has(revision.revision_id)) continue;
    seen.add(revision.revision_id);
    const wordingOfRevision = wording.get(revision.revision_id);
    if (wordingOfRevision !== undefined) statements.push({ revision, ...wordingOfRevision });
  }
  return statements;
}

/**
 * The identities a source or text subject is related to, and how each was reached. Retrieval
 * reads under a current-mode request of its own, so what it contributes here is the candidate set
 * and the coverage it could not reach — never an answer. Every identity below is resolved under
 * THIS read's basis, which a historical boundary or an applicability input would otherwise make
 * a different question.
 */
function retrievedCandidates(
  view: ProjectReadView,
  input: ProjectKnowledgeContextRequest,
  boundary: number
): {
  retrieval: RelatedKnowledgeRetrieval | null;
  routes: Map<string, Set<KnowledgeContextRoute>>;
} {
  const routes = new Map<string, Set<KnowledgeContextRoute>>();
  if (input.subject.kind !== 'source' && input.subject.kind !== 'text')
    return { retrieval: null, routes };
  if (input.bounds === undefined)
    invalid(
      'A source or text question reaches its identities through bounded retrieval, which needs its bounds'
    );
  const source =
    input.subject.kind === 'source'
      ? input.subject.source
      : {
          artifactId: NO_CAPTURE,
          eventId: NO_CAPTURE,
          planEventId: null,
          text: input.subject.text,
        };
  const retrieval = retrieveRelatedKnowledge(view, {
    source,
    projectId: input.projectId,
    scope: input.scope,
    boundary,
    bounds: input.bounds,
  });
  for (const entry of retrieval.entries)
    routes.set(identityKey(entry.target), new Set<KnowledgeContextRoute>(entry.routes));
  return { retrieval, routes };
}

export function projectKnowledgeContext(
  view: ProjectReadView,
  input: ProjectKnowledgeContextRequest
): ProjectKnowledgeContext {
  if (
    input.maxResolvedIdentities !== undefined &&
    (!Number.isSafeInteger(input.maxResolvedIdentities) || input.maxResolvedIdentities < 1)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The identity resolution limit must be a positive safe integer'
    );
  const request = knowledgeReadRequest(view, {
    scope: input.scope,
    mode: input.mode,
    boundary: input.boundary,
    ...(input.implementation === undefined ? {} : { implementation: input.implementation }),
    ...(input.applicability === undefined ? {} : { applicability: input.applicability }),
    ...(input.exceptionsJudgedAt === undefined
      ? {}
      : { exceptionsJudgedAt: input.exceptionsJudgedAt }),
    ...(input.exceptionConditions === undefined
      ? {}
      : { exceptionConditions: input.exceptionConditions }),
    ...(input.acting === undefined ? {} : { acting: input.acting }),
  });
  const { retrieval, routes } = retrievedCandidates(view, input, request.knowledge_boundary);
  const cited =
    input.subject.kind === 'captured_event'
      ? citedEventIdentities(
          view,
          input.subject.eventId,
          request.knowledge_boundary,
          input.subject.preferredFieldPaths
        )
      : {
          targets: [] as readonly KnowledgeTarget[],
          preferred: new Set<string>(),
          omissions: [] as RelatedKnowledgeOmission[],
        };
  const named =
    input.subject.kind === 'identities'
      ? input.subject.targets
      : input.subject.kind === 'adopted'
        ? adoptedIdentities(view, request.knowledge_boundary)
        : input.subject.kind === 'task'
          ? [
              ...adoptedIdentities(view, request.knowledge_boundary),
              ...taskIdentities(view, input.subject.artifactIds, request.knowledge_boundary),
            ]
          : input.subject.kind === 'subject'
            ? subjectIdentities(view, input.subject.subjectId, request.knowledge_boundary)
            : [];
  const targets = new Map<string, KnowledgeTarget>();
  for (const target of named) {
    const key = identityKey(target);
    routes.set(key, (routes.get(key) ?? new Set()).add('requested'));
    targets.set(key, target);
  }
  const citedOnly = new Set<string>();
  for (const target of cited.targets) {
    const key = identityKey(target);
    routes.set(key, (routes.get(key) ?? new Set()).add('source_reference'));
    targets.set(key, target);
    citedOnly.add(key);
  }
  for (const entry of retrieval?.entries ?? [])
    targets.set(identityKey(entry.target), entry.target);

  const governing = governingStateReader(
    view,
    input.projectId,
    request,
    input.assignments === true ? { assignments: request } : {}
  );
  const unresolved: UnresolvedPoint[] = [];
  const coverageAnswers: ResolvedKnowledge[] = [];
  const absent: KnowledgeTarget[] = [];
  const restrictedCandidates = new Set<string>();
  const entries = [...targets.values()]
    .sort(
      (left, right) =>
        Number(cited.preferred.has(identityKey(right))) -
          Number(cited.preferred.has(identityKey(left))) ||
        (identityKey(left) < identityKey(right) ? -1 : 1)
    )
    .slice(0, input.maxResolvedIdentities)
    .flatMap((target) => {
      const resolved = governing.at(target);
      const lineage = readProjectLineageTips(view, target, input.projectId, request, governing);
      // An identity this store holds no record of at the boundary is not knowledge: its records
      // were published later, or in a scope this read does not reach, or there are none. It is
      // named in the answer's coverage rather than carried as an entry that stands for nothing.
      // Relationships have no revision rows; their matching resolved edge establishes presence.
      const hasRelationship =
        target.kind === 'relationship' &&
        resolved.relationships.some(
          (relationship) => relationship.relationship_id === target.entity_id
        );
      if (resolved.revisions.length === 0 && lineage.revisions.length === 0 && !hasRelationship) {
        coverageAnswers.push(resolved);
        absent.push(target);
        return [];
      }
      const namedRevisions = [
        ...resolved.revisions.map((entry) => entry.revision),
        ...lineage.tips.map((tip) => tip.revision),
      ];
      const sourceState = interpretationCandidateSourceState(
        view,
        target,
        namedRevisions.map((revision) => revision.revision_id),
        request.knowledge_boundary
      );
      if (sourceState.restrictions.length > 0) {
        for (const restriction of sourceState.restrictions) restrictedCandidates.add(restriction);
        return [];
      }
      coverageAnswers.push(resolved);
      unresolved.push(...lineage.coverage.unresolved);
      if (!sourceState.readable) {
        const alreadyUnsupplied = new Set(
          lineage.coverage.unresolved
            .filter((point) => point.reason === 'revision_not_supplied')
            .flatMap((point) => point.record_ids)
        );
        const recordIds = namedRevisions
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
      const uses = taskUsesOf(view, target, request.knowledge_boundary);
      const origin =
        target.kind === 'requirement' ? requirementOrigin(view, target.entity_id) : null;
      const evidence =
        input.assessments === true
          ? assessmentsOf(
              view,
              target,
              [
                ...lineage.revisions.map((revision) => revision.revisionId),
                ...namedRevisions.map((revision) => revision.revision_id),
              ],
              request
            )
          : null;
      return [
        {
          target,
          routes: ROUTE_ORDER.filter(
            (route) => routes.get(identityKey(target))?.has(route) === true
          ),
          resolved,
          revisions: lineage.revisions,
          tips: lineage.tips,
          statements: statementsOf(view, target, namedRevisions, request.knowledge_boundary),
          selectedWithPlan: uses.selectedWithPlan,
          connectedLater: uses.connectedLater,
          references: referencesOf(
            view,
            target,
            lineage.revisions.map((revision) => revision.revisionId),
            origin,
            request.knowledge_boundary
          ),
          criterion: promotedCriterion(origin),
          ...(evidence === null
            ? {}
            : { assessments: evidence.assessments, laterAssessments: evidence.later }),
          ...(resolved.assignments === undefined ? {} : { assignments: resolved.assignments }),
          ...(input.reconsideration === true
            ? {
                openReconsiderations: readProjectReconsiderationItems(view, request, {
                  affected: { kind: target.kind, id: target.entity_id },
                }).items,
              }
            : {}),
        } satisfies ProjectKnowledgeContextEntry,
      ];
    })
    // An identity only a citation found, which the resolver knew nothing about at this boundary,
    // is not knowledge that bears here: its records were published later, or in a scope this read
    // does not reach. Bounded retrieval drops such a candidate for the same reason. A caller that
    // NAMED an identity is answered about it either way, because that is the question it asked.
    .filter(
      (entry) =>
        entry.resolved.revisions.length > 0 ||
        entry.routes.some((route) => route === 'requested') ||
        !citedOnly.has(identityKey(entry.target))
    );

  return {
    request,
    coverage: knowledgeReadCoverage(request, coverageAnswers, unresolved),
    ...(input.assessments === true ? { intentCounter: intentCounterAt(view) } : {}),
    entries,
    ...(input.interpretations === false
      ? {}
      : {
          interpretationRead: readProjectKnowledgeInterpretations(view, {
            projectId: input.projectId,
            boundary: request.knowledge_boundary,
            artifactIds:
              input.subject.kind === 'task'
                ? input.subject.artifactIds
                : input.subject.kind === 'source'
                  ? [input.subject.source.artifactId]
                  : input.scope.kind === 'artifact'
                    ? [input.scope.artifact_id]
                    : [],
            eventIds:
              input.subject.kind === 'captured_event'
                ? [input.subject.eventId]
                : input.subject.kind === 'source'
                  ? [input.subject.source.eventId]
                  : [],
            targets: entries.flatMap((entry) =>
              entry.target.kind === 'relationship'
                ? []
                : entry.revisions.map((revision) => ({
                    kind: entry.target.kind as 'requirement' | 'decision' | 'claim',
                    entity_id: entry.target.entity_id,
                    revision_id: revision.revisionId,
                  }))
            ),
            projectFallback:
              input.subject.kind === 'task' ||
              input.subject.kind === 'adopted' ||
              input.subject.kind === 'text',
          }),
        }),
    absent,
    retrieval,
    omissions: [
      ...(input.maxResolvedIdentities !== undefined && targets.size > input.maxResolvedIdentities
        ? [
            {
              kind: 'identity_count' as const,
              detail: `${targets.size - input.maxResolvedIdentities} selected identities were not resolved within the identity allowance.`,
            },
          ]
        : []),
      ...(input.subject.kind === 'subject' ? [SUBJECT_INDEX_ONLY] : []),
      ...cited.omissions,
      ...(input.subject.kind === 'adopted' || input.subject.kind === 'task'
        ? [ADOPTED_EXPECTATIONS_ONLY]
        : []),
      ...(retrieval?.omissions ?? []),
      ...(restrictedCandidates.size === 0
        ? []
        : [
            {
              kind: 'access_restricted' as const,
              detail: `Interpretation-backed candidate(s) under ${[...restrictedCandidates]
                .sort()
                .join(', ')} were not read.`,
            },
          ]),
    ],
  };
}
