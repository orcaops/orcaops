// The one shape every surface names when it asks what continuing knowledge bears on some work.
//
// Storage reads rows and knows nothing of an answer; this is where the two meet, exactly as the
// interpretation manifest meets bounded retrieval. The builders are pure over the composer's
// parts, so the same context and the same processing coverage always give the same answer, byte
// for byte, and freezing one into a plan, a manifest or a JSON envelope changes nothing.
//
// What it must keep apart, because conflating any pair of them is how an agent is misled:
// an adopted rule that applies here from useful background; a proposal from something that
// stands; an after-the-fact connection from a task's own selection; a later correction from the
// basis an historical answer was read on; and what was read from what was not.
import type {
  Applicability,
  AssignmentStandingEntry,
  Attribution,
  AuthorityScope,
  Designation,
  ExpectationRevisionRef,
  GoverningConflict,
  GoverningState,
  KnowledgeTarget,
  LaterKnowledgeRecord,
  ProposedCorrection,
  RecordRevisionRef,
  ResolvedKnowledge,
  RevisionStanding,
  SourceStanding,
  UnresolvedPoint,
} from '@orcaops/storage';
import type {
  KnowledgeContextRoute,
  KnowledgeReadCoverage,
  ProjectKnowledgeContext,
  ProjectKnowledgeContextEntry,
  ProjectKnowledgeContextUse,
  ProjectKnowledgeInterpretation,
  ProjectKnowledgeReference,
  PromotedCriterionOrigin,
  RevisionGoverningStanding,
} from '@orcaops/storage/history/database';

import type { KnowledgeProcessingCoverage } from './coverage.js';
import {
  type KnowledgeContextEvidence,
  knowledgeContextEvidence,
  type KnowledgeContextEvidenceBounds,
  type KnowledgeContextQuestion,
} from '../evidence/answer-evidence.js';
import type { AssessedSoftware } from '../evidence/relevance.js';

/** The question the answer answered. An answer that did not say this would answer none. */
export interface KnowledgeContextBasis {
  scope: AuthorityScope;
  mode: 'current' | 'historical';
  knowledge_boundary: number;
  /**
   * The software the question is about, or null when nobody named any. Null is not "none": an
   * assessment that identified no software matches the second and never the first, and an answer
   * that lost the difference would read an unasked question as an answered one.
   */
  software?: AssessedSoftware | null;
}

/**
 * Where an entry belongs in a reading order. `applicable` is the one a task must not miss: a
 * revision adopted in a scope this read reaches whose applicability this read does not rule out.
 * Everything else is background — useful, and never a rule the work has to meet.
 */
export type KnowledgeContextPlacement = 'applicable' | 'background';

export interface KnowledgeContextRevision {
  revision: RecordRevisionRef;
  standing: RevisionGoverningStanding;
  designation: Designation | null;
  /** Three-valued: an input nobody supplied leaves it unresolved, never waived. */
  applicability: Applicability;
  source_standing: SourceStanding | null;
  attributed_to: Attribution | null;
  /** Null when this store holds no readable wording for the revision. */
  statement: string | null;
  /** Retained explanation, when the revision supplies one. */
  rationale?: string | null;
  /** A revision no visible revision continues. A tip is not an adoption. */
  is_tip: boolean;
  /** Null for a revision the resolver named that no lineage row carries. */
  write_sequence: number | null;
}

export interface KnowledgeContextUse {
  artifact_id: string;
  plan_event_id: string;
  revision_id: string;
  role: string;
  step_id: string | null;
  criterion_id: string | null;
  exception_id: string | null;
  /** Null for a use selected with its plan; set for one connected later. */
  discovered_at: string | null;
  discovered_by: { kind: string; name: string | null; basis: string | null } | null;
  write_sequence: number;
}

export interface KnowledgeContextEntry {
  /** `<kind>:<entity id>`, which is how the lists below name an entry without repeating it. */
  key: string;
  target: KnowledgeTarget;
  routes: readonly KnowledgeContextRoute[];
  placement: KnowledgeContextPlacement;
  /** Why it is placed there: the scope, the selector and the adoption, in one line. */
  reason: string;
  governing_state: GoverningState;
  revisions: readonly KnowledgeContextRevision[];
  /** The uses a plan event's own operation wrote. */
  selected_with_plan: readonly KnowledgeContextUse[];
  /** The uses a later operation connected. Never folded in with the list above. */
  connected_later: readonly KnowledgeContextUse[];
  references: readonly ProjectKnowledgeReference[];
  criterion: PromotedCriterionOrigin | null;
  /**
   * What previously recorded assessments say about this identity, each with its own basis and its
   * relevance to the question. Absent when the read composed none — never a claim that none exist.
   */
  evidence?: KnowledgeContextEvidence;
  /**
   * The assignments in view for this identity: who may decide what about it on somebody's behalf,
   * what each delegates about it, and how each stood at this boundary. Absent when the read
   * composed none — never a claim that nobody delegated anything.
   */
  assignments?: readonly AssignmentStandingEntry[];
  /** The resolver's whole answer, for a surface that needs more than the summary above. */
  resolved: ResolvedKnowledge;
}

/** Something offered and not established: a proposed correction, or an extracted candidate. */
export interface KnowledgeContextProposal {
  key: string;
  kind: 'correction' | 'candidate_revision';
  correction: ProposedCorrection | null;
  revision: RecordRevisionRef | null;
  attributed_to: Attribution | null;
  /** What it is, in the words a reader sees beside it. */
  label: string;
}

export interface KnowledgeContextConflict {
  key: string;
  conflict: GoverningConflict;
}

export interface KnowledgeContextCoverage {
  read: KnowledgeReadCoverage;
  /** Null only where nothing knows the processing state — never as a shorthand for "fine". */
  processing: KnowledgeProcessingCoverage | null;
}

export interface KnowledgeContextLimit {
  kind: string;
  detail: string;
}

export interface KnowledgeContextAnswer {
  basis: KnowledgeContextBasis;
  entries: readonly KnowledgeContextEntry[];
  /** Entry keys, adopted and applying at this boundary. */
  applicable: readonly string[];
  background: readonly string[];
  proposals: readonly KnowledgeContextProposal[];
  interpretations?: readonly ProjectKnowledgeInterpretation[];
  conflicts: readonly KnowledgeContextConflict[];
  unresolved: readonly UnresolvedPoint[];
  /** Records published after the boundary. Separately dated; never part of the basis. */
  later_annotations: readonly LaterKnowledgeRecord[];
  coverage: KnowledgeContextCoverage;
  limits: readonly KnowledgeContextLimit[];
}

export const knowledgeContextKey = (target: KnowledgeTarget): string =>
  `${target.kind}:${target.entity_id}`;

/**
 * Whether a revision governs: adopted in a scope this read reaches, and not ruled out by an
 * applicability selector. An adopted revision whose applicability is merely unresolved governs — a
 * dimension nobody supplied is never waived and never assumed met.
 *
 * Exported because every surface that says what governs has to say it the same way. A second rule
 * written out beside this one is how `search` came to call a background designation governing.
 */
export const revisionGoverns = (revision: {
  readonly standing: RevisionGoverningStanding;
  readonly applicability: Applicability;
}): boolean => revision.standing === 'adopted' && revision.applicability !== 'does_not_apply';

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const scopeText = (scope: AuthorityScope | null): string => {
  if (scope === null) return 'no scope';
  return scope.kind === 'project' ? 'the project' : `artifact ${scope.artifact_id}`;
};

const PRECEDENCE: readonly RevisionGoverningStanding[] = [
  'adopted',
  'background',
  'departed',
  'not_standing',
];

/** The standing across every scope this read reaches, strongest first, as the readers rank it. */
function standingOf(entries: readonly RevisionStanding[]): RevisionGoverningStanding {
  let standing: RevisionGoverningStanding = 'not_standing';
  for (const entry of entries) {
    const here: RevisionGoverningStanding =
      entry.standing !== 'stands'
        ? 'not_standing'
        : entry.departed_in_scope.length > 0
          ? 'departed'
          : entry.designation === 'adopted'
            ? 'adopted'
            : 'background';
    if (PRECEDENCE.indexOf(here) < PRECEDENCE.indexOf(standing)) standing = here;
  }
  return standing;
}

/**
 * One applicability per revision from the resolver's per-scope entries. `applies` anywhere this
 * read reaches applies; otherwise an unresolved condition stays unresolved, because a dimension
 * nobody supplied is never assumed met and never waived.
 */
function applicabilityOf(entries: readonly RevisionStanding[]): Applicability {
  if (entries.length === 0) return 'unresolved';
  if (entries.some((entry) => entry.applicability === 'applies')) return 'applies';
  return entries.some((entry) => entry.applicability === 'unresolved')
    ? 'unresolved'
    : 'does_not_apply';
}

const first = <T>(
  entries: readonly RevisionStanding[],
  read: (entry: RevisionStanding) => T | null
) => entries.map(read).find((value) => value !== null) ?? null;

function contextUse(entry: ProjectKnowledgeContextUse): KnowledgeContextUse {
  return {
    artifact_id: entry.use.artifactId,
    plan_event_id: entry.use.planEventId,
    revision_id: entry.use.target.revisionId,
    role: entry.use.role,
    step_id: entry.use.stepId,
    criterion_id: entry.use.criterionId,
    exception_id: entry.use.exceptionId,
    discovered_at: entry.use.discoveredAt,
    discovered_by: entry.use.discoveredBy,
    write_sequence: entry.writeSequence,
  };
}

const orderedUses = (uses: readonly ProjectKnowledgeContextUse[]): KnowledgeContextUse[] =>
  uses
    .map(contextUse)
    .sort(
      (left, right) =>
        left.write_sequence - right.write_sequence ||
        byText(left.plan_event_id, right.plan_event_id) ||
        byText(left.revision_id, right.revision_id)
    );

function contextRevisions(entry: ProjectKnowledgeContextEntry): {
  revisions: KnowledgeContextRevision[];
  standing: Map<string, RevisionGoverningStanding>;
} {
  const statements = new Map(
    entry.statements.map((statement) => [statement.revision.revision_id, statement])
  );
  const tips = new Set(entry.tips.map((tip) => tip.revisionId));
  const sequences = new Map(
    entry.revisions.map((revision) => [revision.revisionId, revision.writeSequence])
  );
  const named = new Map<string, RecordRevisionRef>();
  for (const revision of entry.revisions)
    named.set(revision.revisionId, {
      kind: entry.target.kind,
      entity_id: entry.target.entity_id,
      revision_id: revision.revisionId,
    } as RecordRevisionRef);
  for (const standing of entry.resolved.revisions)
    if (!named.has(standing.revision.revision_id))
      named.set(standing.revision.revision_id, standing.revision);

  const standing = new Map<string, RevisionGoverningStanding>();
  const revisions = [...named.values()]
    .map((revision) => {
      const entries = entry.resolved.revisions.filter(
        (held) => held.revision.revision_id === revision.revision_id
      );
      const held = standingOf(entries);
      const wording = statements.get(revision.revision_id);
      standing.set(revision.revision_id, held);
      return {
        revision,
        standing: held,
        designation: first(entries, (value) => value.designation),
        applicability: applicabilityOf(entries),
        source_standing: first(entries, (value) => value.source_standing),
        attributed_to: first(entries, (value) => value.attributed_to),
        statement: wording?.text ?? null,
        ...(wording?.rationale === undefined ? {} : { rationale: wording.rationale }),
        is_tip: tips.has(revision.revision_id),
        write_sequence: sequences.get(revision.revision_id) ?? null,
      } satisfies KnowledgeContextRevision;
    })
    .sort(
      (left, right) =>
        (left.write_sequence ?? -1) - (right.write_sequence ?? -1) ||
        byText(left.revision.revision_id, right.revision.revision_id)
    );
  return { revisions, standing };
}

function placementOf(
  entry: ProjectKnowledgeContextEntry,
  revisions: readonly KnowledgeContextRevision[]
): { placement: KnowledgeContextPlacement; reason: string } {
  const adopted = revisions.filter((revision) => revision.standing === 'adopted');
  const applying = adopted.filter((revision) => revision.applicability !== 'does_not_apply');
  if (applying.length > 0) {
    const scopes = [
      ...new Set(
        entry.resolved.revisions
          .filter((held) =>
            applying.some((row) => row.revision.revision_id === held.revision.revision_id)
          )
          .map((held) => scopeText(held.scope))
      ),
    ].sort(byText);
    const unresolved = applying.some((revision) => revision.applicability === 'unresolved');
    return {
      placement: 'applicable',
      reason:
        `Adopted in ${scopes.join(' and ') || 'this read'}, and its applicability ` +
        `${unresolved ? 'is unresolved for this read rather than ruled out' : 'holds here'}.`,
    };
  }
  if (adopted.length > 0)
    return {
      placement: 'background',
      reason: 'Adopted, but its applicability selector does not cover this read.',
    };
  const departed = revisions.some((revision) => revision.standing === 'departed');
  if (departed)
    return {
      placement: 'background',
      reason:
        'Departed from in this scope on an informed instruction; it still stands where it was adopted.',
    };
  if (revisions.some((revision) => revision.standing === 'background'))
    return { placement: 'background', reason: 'Recorded as background, which adopts nothing.' };
  return {
    placement: 'background',
    reason: 'Visible at this boundary with no accepted selection making any revision stand.',
  };
}

/**
 * The revisions of this identity the question is about: the adopted ones whose applicability this
 * read does not rule out, or, where nothing is adopted, the tips.
 *
 * The fallback matters for the wording of an answer. An assessment of the tip of an identity
 * nobody adopted did judge the revision a reader is asking about, and calling it historical
 * because no adoption record exists would be a false reason attached to a true caution.
 */
function inForceExpectations(
  target: KnowledgeTarget,
  revisions: readonly KnowledgeContextRevision[]
): ExpectationRevisionRef[] {
  if (target.kind !== 'requirement' && target.kind !== 'decision') return [];
  const kind = target.kind;
  const adopted = revisions.filter(
    (revision) => revision.standing === 'adopted' && revision.applicability !== 'does_not_apply'
  );
  const chosen = adopted.length > 0 ? adopted : revisions.filter((revision) => revision.is_tip);
  return chosen.map((revision) => ({
    kind,
    entity_id: target.entity_id,
    revision_id: revision.revision.revision_id,
  }));
}

export function knowledgeContextEntry(
  entry: ProjectKnowledgeContextEntry,
  question?: KnowledgeContextQuestion,
  bounds?: KnowledgeContextEvidenceBounds
): KnowledgeContextEntry {
  const { revisions } = contextRevisions(entry);
  const { placement, reason } = placementOf(entry, revisions);
  const evidence =
    entry.assessments === undefined || question === undefined
      ? undefined
      : knowledgeContextEvidence({
          assessments: entry.assessments,
          later: entry.laterAssessments ?? [],
          inForce: inForceExpectations(entry.target, revisions),
          question,
          ...(bounds === undefined ? {} : { bounds }),
        });
  return {
    key: knowledgeContextKey(entry.target),
    ...(evidence === undefined ? {} : { evidence }),
    ...(entry.assignments === undefined ? {} : { assignments: entry.assignments }),
    target: entry.target,
    routes: entry.routes,
    placement,
    reason,
    governing_state: entry.resolved.governing_state,
    revisions,
    selected_with_plan: orderedUses(entry.selectedWithPlan),
    connected_later: orderedUses(entry.connectedLater),
    references: entry.references,
    criterion: entry.criterion,
    resolved: entry.resolved,
  };
}

/**
 * A detector's revision is an extracted candidate that verified nothing, and a proposing
 * correction changes nothing that stands. Both stay labelled candidates here rather than being
 * read as something adopted, and neither is ever asked about.
 */
function proposalsOf(entry: KnowledgeContextEntry): KnowledgeContextProposal[] {
  const proposals: KnowledgeContextProposal[] = entry.resolved.proposals.map((correction) => ({
    key: entry.key,
    kind: 'correction' as const,
    correction,
    revision: null,
    attributed_to: correction.attributed_to,
    label:
      `Proposed ${correction.kind.replaceAll('_', ' ')}` +
      `${correction.accepted_by === null ? ', not accepted, so it changes nothing that stands' : ', accepted'}.`,
  }));
  for (const revision of entry.revisions)
    if (revision.source_standing === 'extracted_candidate' && revision.standing !== 'adopted')
      proposals.push({
        key: entry.key,
        kind: 'candidate_revision',
        correction: null,
        revision: revision.revision,
        attributed_to: revision.attributed_to,
        label: 'An extracted candidate: nobody adopted it and nothing verified it.',
      });
  return proposals;
}

/** What the caller asked about, beside the scope and boundary the composer's request carries. */
export interface KnowledgeContextAsked {
  /** The software the question is about. Omitted means nobody named any, which is not "none". */
  readonly software?: AssessedSoftware | null;
}

export interface KnowledgeContextBounds {
  /** How many continuing identities the answer may carry. */
  maxEntries?: number;
  /** Combined byte budget for revision wording, including statements and rationales. */
  maxStatementBytes?: number;
}

/** How many keys a bound names before it stops counting them out loud. */
const NAMED_IN_A_LIMIT = 5;

/**
 * How much evidence one identity may carry. The count is fixed: an identity with a thousand
 * assessments is a reading a lookup by name is for, and `boundedEntries` cannot see inside an
 * entry. The bytes are a share of the statement budget, so an answer asked for less carries less
 * evidence too.
 */
const MAX_ASSESSMENTS_PER_ENTRY = 20;
const EVIDENCE_SHARE_OF_STATEMENT_BYTES = 4;

const evidenceBoundsOf = (maxStatementBytes: number): KnowledgeContextEvidenceBounds => ({
  maxAssessments: MAX_ASSESSMENTS_PER_ENTRY,
  maxBytes: Math.floor(maxStatementBytes / EVIDENCE_SHARE_OF_STATEMENT_BYTES),
});

const statementBytesOf = (entry: KnowledgeContextEntry): number =>
  entry.revisions.reduce(
    (total, revision) =>
      total +
      (revision.statement === null ? 0 : Buffer.byteLength(revision.statement, 'utf8')) +
      Buffer.byteLength(revision.rationale ?? '', 'utf8'),
    0
  );

const namedKeys = (keys: readonly string[]): string =>
  keys.length <= NAMED_IN_A_LIMIT
    ? keys.join(', ')
    : `${keys.slice(0, NAMED_IN_A_LIMIT).join(', ')} and ${keys.length - NAMED_IN_A_LIMIT} more`;

/**
 * What the bounds leave room for, and what they left out by name.
 *
 * **Applicable before background, always.** The bounds are spent in placement order, and no
 * background entry is admitted once either bound has left an applicable one out, so an adopted rule
 * that applies here is never dropped while a background entry remains: an answer that quietly cut
 * the one rule a task has to meet, and said only how many it cut, is worse than no answer.
 * Within a placement the order is the answer's own, so the same question always keeps the same
 * entries. An entry is carried whole or not at all, exactly as bounded retrieval carries one: a
 * half-read identity would show a rule without the act that stopped it.
 */
function boundedEntries(
  entries: readonly KnowledgeContextEntry[],
  maxEntries: number,
  maxStatementBytes: number
): { kept: KnowledgeContextEntry[]; limits: KnowledgeContextLimit[] } {
  const ordered = [
    ...entries.filter((entry) => entry.placement === 'applicable'),
    ...entries.filter((entry) => entry.placement === 'background'),
  ];
  const kept: KnowledgeContextEntry[] = [];
  const byCount: string[] = [];
  const byBytes: string[] = [];
  let bytes = 0;
  let applicableLeftOut = false;
  for (const entry of ordered) {
    if (kept.length >= maxEntries) {
      byCount.push(entry.key);
      continue;
    }
    // The count bound is spent in placement order and can never reach background while an
    // applicable entry waits; the byte bound can, because a big entry that does not fit leaves
    // room a small one takes. So the moment bytes leave an applicable entry out, background stops
    // being admitted: spending the last bytes on useful background while the one rule the work has
    // to meet was dropped is exactly the answer this order exists to prevent. A smaller applicable
    // entry still fits and is still carried — losing a second rule helps nobody.
    if (applicableLeftOut && entry.placement === 'background') {
      byBytes.push(entry.key);
      continue;
    }
    const cost = statementBytesOf(entry);
    if (bytes + cost > maxStatementBytes) {
      byBytes.push(entry.key);
      if (entry.placement === 'applicable') applicableLeftOut = true;
      continue;
    }
    kept.push(entry);
    bytes += cost;
  }
  const limits: KnowledgeContextLimit[] = [];
  if (byCount.length > 0)
    limits.push({
      kind: 'identity_count',
      detail:
        `${byCount.length} identit(y/ies) were left out: this answer carries at most ` +
        `${maxEntries}, background before applicable. Left out: ${namedKeys(byCount)}.`,
    });
  if (byBytes.length > 0)
    limits.push({
      kind: 'statement_bytes',
      detail:
        `${byBytes.length} identit(y/ies) were left out whole: their revision wording ` +
        `(statements and rationales) did not fit the ` +
        `${maxStatementBytes} bytes this answer gives them. Applicable entries are offered these ` +
        `bytes first, and once one of them is left out no background entry is carried after it. ` +
        `Left out: ${namedKeys(byBytes)}.`,
    });
  return { kept, limits };
}

/**
 * The composer's parts as one answer. The processing coverage is passed in because storage cannot
 * see configuration, consent or the queue's meaning; where nothing knows it, it is `null` and
 * never a claim.
 *
 * The bounds are applied HERE, after every identity has been resolved and placed, because only a
 * placed entry can be dropped in the right order. Storage bounds what it reads; it cannot bound
 * what an answer carries without knowing what each entry turned out to be.
 */
export function knowledgeContextAnswer(
  context: ProjectKnowledgeContext,
  processing: KnowledgeProcessingCoverage | null,
  bounds: KnowledgeContextBounds = {},
  asked: KnowledgeContextAsked = {}
): KnowledgeContextAnswer {
  const question: KnowledgeContextQuestion = {
    software: asked.software ?? null,
    intentCounter: context.intentCounter ?? null,
  };
  const maxEntries = bounds.maxEntries ?? Number.MAX_SAFE_INTEGER;
  const maxStatementBytes = bounds.maxStatementBytes ?? Number.MAX_SAFE_INTEGER;
  const evidenceBounds = evidenceBoundsOf(maxStatementBytes);
  const placed = context.entries.map((entry) =>
    knowledgeContextEntry(entry, question, evidenceBounds)
  );
  const bounded = boundedEntries(placed, maxEntries, maxStatementBytes);
  const entries = bounded.kept;
  const interpretations: ProjectKnowledgeInterpretation[] = [];
  const interpretationLimits: KnowledgeContextLimit[] = [];
  const omittedByRoute = new Map<string, number>();
  let bytes = entries.reduce((total, entry) => total + statementBytesOf(entry), 0);
  const applicableOmitted = placed.some(
    (entry) => entry.placement === 'applicable' && !entries.includes(entry)
  );
  for (const interpretation of context.interpretationRead?.interpretations ?? []) {
    const cost = Buffer.byteLength(JSON.stringify(interpretation), 'utf8');
    if (
      applicableOmitted ||
      entries.length + interpretations.length >= maxEntries ||
      bytes + cost > maxStatementBytes
    ) {
      omittedByRoute.set(interpretation.route, (omittedByRoute.get(interpretation.route) ?? 0) + 1);
      continue;
    }
    interpretations.push(interpretation);
    bytes += cost;
  }
  for (const [route, count] of omittedByRoute)
    interpretationLimits.push({
      kind: 'interpretation_bounds',
      detail: `${count} unapproved interpretation(s) on route ${route} were left out of the shared entry/byte allowance; applicable rules have priority.`,
    });
  const conflicts = entries
    .flatMap((entry) => entry.resolved.conflicts.map((conflict) => ({ key: entry.key, conflict })))
    .sort((left, right) => byText(left.key, right.key));
  const proposals = entries
    .flatMap(proposalsOf)
    .sort(
      (left, right) =>
        byText(left.key, right.key) ||
        byText(left.kind, right.kind) ||
        byText(
          left.correction?.action_id ?? left.revision?.revision_id ?? '',
          right.correction?.action_id ?? right.revision?.revision_id ?? ''
        )
    );
  return {
    basis: {
      scope: context.request.scope,
      mode: context.request.mode,
      knowledge_boundary: context.request.knowledge_boundary,
      software: question.software,
    },
    entries,
    applicable: entries
      .filter((entry) => entry.placement === 'applicable')
      .map((entry) => entry.key),
    background: entries
      .filter((entry) => entry.placement === 'background')
      .map((entry) => entry.key),
    proposals,
    interpretations,
    conflicts,
    unresolved: context.coverage.unresolved,
    later_annotations: context.coverage.later,
    coverage: { read: context.coverage, processing },
    limits: [
      ...context.omissions.map((omission) => ({
        kind: omission.kind,
        detail: omission.detail,
      })),
      ...absentLimits(context.absent),
      ...bounded.limits,
      ...(context.interpretationRead?.limits ?? []),
      ...interpretationLimits,
      ...evidenceLimits(entries, evidenceBounds),
    ],
  };
}

/**
 * The assessments the evidence bound left out of the entries this answer carries, by name.
 *
 * An omitted assessment is a record this history holds and this answer does not show, so it is
 * named where every other thing the bounds cut is named.
 */
function evidenceLimits(
  entries: readonly KnowledgeContextEntry[],
  bounds: KnowledgeContextEvidenceBounds
): KnowledgeContextLimit[] {
  const cut = entries.filter((entry) => (entry.evidence?.omitted.length ?? 0) > 0);
  if (cut.length === 0) return [];
  const left = cut.reduce((total, entry) => total + (entry.evidence?.omitted.length ?? 0), 0);
  return [
    {
      kind: 'evidence_truncated',
      detail:
        `${left} assessment(s) were left out of ${cut.length} identit(y/ies): this answer carries ` +
        `at most ${bounds.maxAssessments} per identity and ${bounds.maxBytes} bytes of them, ` +
        `newest first. Left out: ${cut
          .map((entry) => `${entry.key} (${namedKeys(entry.evidence?.omitted ?? [])})`)
          .join('; ')}.`,
    },
  ];
}

/**
 * An identity this store holds no record of at the boundary read at. It is named rather than
 * carried as an empty entry: an entry that stands for nothing would read as a rule with nothing
 * behind it, and a reader that asked about it deserves to be told there is no such record.
 */
function absentLimits(absent: readonly KnowledgeTarget[]): KnowledgeContextLimit[] {
  if (absent.length === 0) return [];
  const keys = absent.map(knowledgeContextKey).sort(byText);
  return [
    {
      kind: 'no_record_at_boundary',
      detail:
        `${keys.length} identit(y/ies) asked about have no such record at this boundary — none ` +
        `here, or their records were published later or in a scope this read does not reach: ` +
        `${namedKeys(keys)}.`,
    },
  ];
}
