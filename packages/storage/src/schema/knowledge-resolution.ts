import {
  type Actor,
  type Applicability,
  type ApplicabilityInputs,
  type ApplicabilitySelector,
  type ApplicableAssignment,
  type Assessment,
  type Assignment,
  assignmentWindow,
  type Attribution,
  type AuthorityScope,
  type ConflictAnswer,
  type ConflictDisposition,
  conflictDisposition,
  type CorrectionAction,
  correctionFootprint,
  type Departure,
  type Designation,
  type EarlierConflictAnswer,
  evaluateApplicability,
  exceptionStanding,
  type ExpectationRevisionRef,
  type FollowedCorrection,
  type GoverningState,
  isProposingCorrection,
  type KnowledgeException,
  MAX_FOLLOWED_CHAIN,
  type RecordRevisionRef,
  type Relationship,
  type RequirementRevision,
  type Revocation,
  type Selection,
} from './knowledge-contract.js';

/** A record with the write sequence of the operation that published it. */
export interface PublishedRecord<T> {
  write_sequence: number;
  record: T;
}

/**
 * An act, with the authorization the writer retained for it. Every act
 * published under an embedded instruction records one, which is how a
 * revocation of that authorization is seen here at all.
 */
export interface PublishedAct<T> extends PublishedRecord<T> {
  authorization_id: string | null;
}

export type SourceStanding = RequirementRevision['source_standing'];

/** What a requirement, decision or claim revision contributes to an answer. */
export interface KnowledgeRevision {
  revision: RecordRevisionRef;
  applicability: ApplicabilitySelector;
  source_standing: SourceStanding;
  attributed_to: Attribution;
}

/**
 * A released row whose stored scope is a branch. A branch name grants no
 * authority, so the row is reported as it is and governs nothing.
 */
export interface BranchScopedRow {
  record_id: string;
  record: 'selection' | 'relationship';
  branch: string;
  target: RecordRevisionRef;
  designation: Designation | null;
}

export interface KnowledgeTarget {
  kind: RecordRevisionRef['kind'];
  entity_id: string;
}

/**
 * An assignment this read holds, with the one thing about it only the store can
 * say: whether every rule it inherits and every rule it delegates a departure
 * from still stands. Those rules belong to other identities, which resolving
 * this one does not read.
 */
export interface KnowledgeAssignment {
  assignment: Assignment;
  basis_stands: boolean;
}

/** Everything the store holds about one target identity. */
export interface KnowledgeRecords {
  target: KnowledgeTarget;
  replacement_graph_complete: boolean;
  revisions: readonly PublishedRecord<KnowledgeRevision>[];
  selections: readonly PublishedAct<Selection>[];
  corrections: readonly PublishedAct<CorrectionAction>[];
  relationships: readonly PublishedAct<Relationship>[];
  exceptions: readonly PublishedRecord<KnowledgeException>[];
  revocations: readonly PublishedRecord<Revocation>[];
  conflict_answers: readonly PublishedRecord<ConflictAnswer>[];
  branch_scoped_rows: readonly PublishedRecord<BranchScopedRow>[];
  /** Empty for a read that did not ask for them, which is every writer's read. */
  assignments?: readonly PublishedRecord<KnowledgeAssignment>[];
}

export type SelectedImplementation = Assessment['implementation'];

export interface KnowledgeReadRequest {
  scope: AuthorityScope;
  mode: 'current' | 'historical';
  /** Records at or before this write sequence are visible. */
  knowledge_boundary: number;
  implementation: SelectedImplementation;
  applicability: ApplicabilityInputs;
  /** When a time-ended exception is judged. `null` leaves it unresolved rather than assuming now. */
  exceptions_judged_at: string | null;
  /** Whether each exception's end condition is met, by exception id. An absent one stays unresolved. */
  exception_conditions: Readonly<Record<string, boolean>>;
  /**
   * Who the read is for, which only an assignment reads: it delegates to one
   * responsible party, so a rule it covers is covered for them and for nobody
   * else. A read that names nobody is asked about every conflict, which costs a
   * question rather than granting a permission nobody gave.
   */
  acting?: Attribution | null;
}

export type StandingEffect =
  | 'adopted'
  | 'designation_changed'
  | 'stands_as_replacement'
  | 'restored'
  | 'withdrawn'
  | 'replaced'
  | 'reversed'
  | 'corrected'
  | 'superseded_by_relationship';

/** Why an entry stands or stopped standing, by record id, in the order the records took effect. */
export interface StandingReason {
  record: 'selection' | 'correction' | 'relationship';
  record_id: string;
  effect: StandingEffect;
}

/**
 * An act in a scope this read reaches that departed from a revision standing in
 * a wider scope. The revision still stands where it was adopted; it does not
 * stand here.
 */
export interface ScopedDeparture {
  record_id: string;
  scope: AuthorityScope;
  effect: StandingEffect;
}

/** A correction that annotates a revision, and the acceptance that applied it, if any. */
export interface CorrectionMark {
  action_id: string;
  accepted_by: string | null;
}

/** An accepted selection carrying an entry whose authorization a revocation ended. */
export interface RevokedAuthority {
  selection_id: string;
  revocation_ids: readonly string[];
}

export interface RevisionStanding {
  revision: RecordRevisionRef;
  /** `unadopted` is a visible revision nothing makes stand and nothing stopped. */
  standing: 'stands' | 'stopped' | 'unadopted';
  scope: AuthorityScope | null;
  designation: Designation | null;
  applicability: Applicability;
  source_standing: SourceStanding | null;
  attributed_to: Attribution | null;
  challenged_by: readonly CorrectionMark[];
  account_corrected_by: readonly CorrectionMark[];
  corrected_basis: readonly CorrectionMark[];
  authority_revoked_by: readonly RevokedAuthority[];
  departed_in_scope: readonly ScopedDeparture[];
  in_replacement_cycle: boolean;
  /** The accepted selections making it stand now, apart from the whole history in `because`. */
  stood_by: readonly string[];
  because: readonly StandingReason[];
}

export interface GoverningConflict {
  /** `null` when the revisions are adopted in different scopes that both reach this read. */
  scope: AuthorityScope | null;
  revisions: readonly RecordRevisionRef[];
  /** `null` for a claim or relationship identity: a conflict answer names a requirement or decision. */
  disposition: ConflictDisposition | null;
}

export interface ProposedCorrection {
  action_id: string;
  kind: CorrectionAction['kind'];
  targets: readonly RecordRevisionRef[];
  scope: AuthorityScope;
  attributed_to: Attribution;
  accepted_by: string | null;
  retracted_by: string | null;
}

export interface CorrectionEffectStanding {
  action_id: string;
  standing: 'effective' | 'ended' | 'unresolved';
}

export interface SelectionEffectStanding {
  selection_id: string;
  standing: 'effective' | 'ended' | 'unresolved';
}

/** Why a relationship did not stop a revision standing in this answer. */
export type RelationshipNotApplied =
  | 'not_a_replacement'
  | 'suggested'
  | 'withdrawn'
  | 'detector_attribution'
  | 'replacement_cycle'
  | 'replacement_graph_incomplete'
  | 'another_identity';

export interface RelationshipStanding {
  relationship_id: string;
  relation: Relationship['relation'];
  from: RecordRevisionRef;
  to: RecordRevisionRef;
  scope: AuthorityScope;
  attributed_to: Attribution;
  standing: 'suggested' | 'established' | 'withdrawn';
  applied: boolean;
  not_applied: RelationshipNotApplied | null;
  /** The revocations that ended the authorization this relationship was established under. */
  authority_revoked_by: readonly string[];
  because: readonly StandingReason[];
}

export interface RecordedChoice {
  selection_id: string;
  kind: 'working' | 'final_recorded';
  target: RecordRevisionRef;
  scope: AuthorityScope;
  selected_by: Selection['selected_by'];
}

export interface ExceptionStandingEntry {
  exception_id: string;
  expectation: ExpectationRevisionRef;
  scope: AuthorityScope;
  standing: 'in_effect' | 'ended' | 'unresolved';
  end_behavior: KnowledgeException['end_behavior'];
  context_applies: Applicability;
  revoked_by: readonly string[];
  expectation_stands: boolean;
}

/**
 * Why an assignment does not stand for this read. `not_judgeable` is a validity
 * window this read supplied no time to judge: nobody can call that valid, and
 * nobody can call it expired either.
 */
export type AssignmentStanding = 'valid' | 'revoked' | 'basis_ended' | 'expired' | 'not_judgeable';

/** One assignment in view for an identity, and what it delegates about that identity. */
export interface AssignmentStandingEntry {
  assignment_id: string;
  objective: string;
  responsible: Actor;
  scope: AuthorityScope;
  /** The obligations it inherits that name this identity. */
  inherits: readonly ExpectationRevisionRef[];
  /** What it delegates about this identity, and nothing it delegates about another. */
  delegates: {
    adopts: readonly { revision: RecordRevisionRef; designation: Designation }[];
    departs_from: readonly Departure[];
    restates: readonly RecordRevisionRef[];
  };
  escalation_conditions: readonly string[];
  valid_until: string | null;
  standing: AssignmentStanding;
  /** Why it stands or does not, in one line a reader can check against the record. */
  reason: string;
  revoked_by: readonly string[];
}

export type KnowledgeRecordKind =
  | 'revision'
  | 'selection'
  | 'correction'
  | 'relationship'
  | 'exception'
  | 'revocation'
  | 'conflict_answer'
  | 'assignment'
  | 'branch_scoped_row';

export interface ResolutionOmission {
  record: KnowledgeRecordKind;
  record_id: string;
  reason: 'another_scope' | 'another_identity' | 'branch_scope';
}

/**
 * A record published after the boundary. It carries enough for a surface to say
 * what happened later without a second lookup, and never enters the basis.
 */
export interface LaterKnowledgeRecord {
  record: KnowledgeRecordKind;
  record_id: string;
  write_sequence: number;
  correction: { kind: CorrectionAction['kind']; targets: readonly RecordRevisionRef[] } | null;
  /** The record's own recorded time, where the contract type has one. */
  recorded_at: string | null;
}

export type UnresolvedReason =
  | 'adopted_while_replaced'
  | 'applicability_inputs_missing'
  | 'conflict_unanswered'
  | 'correction_kind_not_understood'
  | 'detector_cannot_act'
  | 'end_condition_not_supplied'
  | 'end_time_not_readable'
  | 'end_unknown'
  | 'evidence_not_attached'
  | 'followed_action_cycle'
  | 'followed_action_not_supplied'
  | 'followed_chain_too_long'
  | 'replacement_cycle'
  | 'replacement_graph_incomplete'
  | 'revision_not_supplied';

/** `record_ids` names records, or revisions by their revision id where the point is about one. */
export interface UnresolvedPoint {
  about: 'conflict' | 'correction' | 'evidence' | 'exception' | 'relationship' | 'revision';
  record_ids: readonly string[];
  reason: UnresolvedReason;
}

/**
 * Step 5 of the resolution order attaches evidence and assessment standing.
 * That is delivered with evidence, so every answer says so in one place
 * instead of leaving a surface to read an absent field as "no evidence".
 */
export interface EvidenceStanding {
  kind: 'not_attached';
}

export interface KnowledgeReadBasis {
  scope: AuthorityScope;
  mode: 'current' | 'historical';
  knowledge_boundary: number;
  implementation: SelectedImplementation;
  applicability: ApplicabilityInputs;
  exceptions_judged_at: string | null;
  /** Absent for a read that named nobody, which is not the same as a read for nobody. */
  acting?: Attribution | null;
}

export interface ResolvedKnowledge {
  target: KnowledgeTarget;
  basis: KnowledgeReadBasis;
  revisions: readonly RevisionStanding[];
  governing_state: GoverningState;
  conflicts: readonly GoverningConflict[];
  proposals: readonly ProposedCorrection[];
  selection_effects: readonly SelectionEffectStanding[];
  correction_effects: readonly CorrectionEffectStanding[];
  relationships: readonly RelationshipStanding[];
  recorded_choices: readonly RecordedChoice[];
  exceptions: readonly ExceptionStandingEntry[];
  /**
   * The assignments whose inherited or delegated footprint names this identity. Absent for a read
   * that did not ask for them, which is why it is optional rather than empty: empty says this
   * store holds none.
   */
  assignments?: readonly AssignmentStandingEntry[];
  branch_scoped: readonly BranchScopedRow[];
  later_annotations: readonly LaterKnowledgeRecord[];
  omissions: readonly ResolutionOmission[];
  unresolved: readonly UnresolvedPoint[];
  evidence: EvidenceStanding;
}

/**
 * What an assignment's three facts make of it, in one place, so a boundary read
 * and a resolution never word the same standing differently. A revocation is
 * named first because it is the one that prevents every later act however the
 * rest reads.
 */
export function assignmentStandingOf(facts: {
  revoked: boolean;
  basis_stands: boolean;
  window: Applicability;
}): { standing: AssignmentStanding; reason: string } {
  const standing: AssignmentStanding = facts.revoked
    ? 'revoked'
    : !facts.basis_stands
      ? 'basis_ended'
      : facts.window === 'does_not_apply'
        ? 'expired'
        : facts.window === 'unresolved'
          ? 'not_judgeable'
          : 'valid';
  return { standing, reason: ASSIGNMENT_REASON[standing] };
}

const ASSIGNMENT_REASON: Record<AssignmentStanding, string> = {
  valid:
    'No revocation reaching its scope names it, every rule it rests on still stands, and its validity covers this read.',
  revoked:
    'A revocation reaching its scope ended it. What was published under it before then stands exactly as it was retained.',
  basis_ended:
    'A rule it inherits or delegates a departure from no longer stands; leave about a rule is not leave about what replaced it.',
  expired: 'Its validity ended before the time this read judges at.',
  not_judgeable:
    'It ends at a stated time and this read named none, so nothing here can say whether it still covers an act.',
};

const scopeKey = (scope: AuthorityScope | null) => {
  if (scope === null) return 'none';
  return scope.kind === 'project' ? `project:${scope.project_id}` : `artifact:${scope.artifact_id}`;
};

const revisionKey = (ref: RecordRevisionRef) => `${ref.kind}:${ref.entity_id}:${ref.revision_id}`;

/**
 * Project scope applies in every artifact of the store's one project; an
 * artifact's scope applies only there, so an artifact-scoped act never changes
 * what stands for the project.
 */
const scopeReaches = (act: AuthorityScope, at: AuthorityScope) =>
  scopeKey(act) === scopeKey(at) || (act.kind === 'project' && at.kind === 'artifact');

const isExpectationRef = (ref: RecordRevisionRef): ref is ExpectationRevisionRef =>
  ref.kind === 'requirement' || ref.kind === 'decision';

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const followedActionId = (action: CorrectionAction) => {
  if (action.kind === 'reversal') return action.reverses_action_id;
  return action.kind === 'acceptance' ? action.accepts_action_id : null;
};

/** The answer owns what it echoes: freezing it and then changing the request changes nothing. */
const copyApplicability = (inputs: ApplicabilityInputs): ApplicabilityInputs => {
  const copy: ApplicabilityInputs = {};
  if (inputs.subject !== undefined) copy.subject = [...inputs.subject];
  if (inputs.software_version !== undefined) copy.software_version = [...inputs.software_version];
  if (inputs.environment !== undefined) copy.environment = [...inputs.environment];
  if (inputs.work_context !== undefined) copy.work_context = [...inputs.work_context];
  if (inputs.time !== undefined) copy.time = inputs.time;
  return copy;
};

const copyImplementation = (implementation: SelectedImplementation): SelectedImplementation =>
  implementation.kind === 'selected'
    ? { ...implementation, inputs: implementation.inputs.map((input) => ({ ...input })) }
    : { kind: 'none_selected' };

interface ReplacementEdge {
  relationship_id: string;
  from: string;
  to: string;
}

/**
 * The replacement edges that lie on a cycle, found in one traversal with
 * Tarjan's strongly connected components, iteratively: an edge whose endpoints
 * share a component can be walked back to, and a component of one is a cycle
 * only through a self-referencing row. Imported history with many edges stays
 * linear and nothing recurses.
 */
function cyclicReplacements(edges: readonly ReplacementEdge[]): Set<string> {
  const successors = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const component = new Map<string, number>();
  const onStack = new Set<string>();
  const pending: string[] = [];
  let counter = 0;
  let components = 0;
  const enter = (node: string) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    pending.push(node);
    onStack.add(node);
  };
  const lowOf = (node: string) => low.get(node) ?? 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    enter(root);
    const work: { node: string; child: number }[] = [{ node: root, child: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; child: number };
      const children = successors.get(frame.node) ?? [];
      if (frame.child < children.length) {
        const child = children[frame.child] as string;
        frame.child += 1;
        if (!index.has(child)) {
          enter(child);
          work.push({ node: child, child: 0 });
        } else if (onStack.has(child))
          low.set(frame.node, Math.min(lowOf(frame.node), index.get(child) ?? 0));
        continue;
      }
      work.pop();
      if (lowOf(frame.node) === index.get(frame.node)) {
        for (;;) {
          const popped = pending.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.set(popped, components);
          if (popped === frame.node) break;
        }
        components += 1;
      }
      const parent = work[work.length - 1];
      if (parent !== undefined)
        low.set(parent.node, Math.min(lowOf(parent.node), lowOf(frame.node)));
    }
  }
  const size = new Map<number, number>();
  for (const id of component.values()) size.set(id, (size.get(id) ?? 0) + 1);
  const cyclic = new Set<string>();
  for (const edge of edges) {
    const from = component.get(edge.from);
    if (from === undefined || from !== component.get(edge.to)) continue;
    if (edge.from === edge.to || (size.get(from) ?? 0) > 1) cyclic.add(edge.relationship_id);
  }
  return cyclic;
}

interface ScopedStanding {
  scope: AuthorityScope;
  designation: Designation;
  standing: boolean;
  supporting: string[];
  authorityRevoked: Map<string, string[]>;
  departedHere: ScopedDeparture[];
  departedCorrectionEffects: Map<string, string>;
  because: StandingReason[];
  correctionEffect: string | null;
}

interface RevisionState {
  revision: RecordRevisionRef;
  known: KnowledgeRevision | null;
  scoped: Map<string, ScopedStanding>;
  published: boolean;
  publishedBecause: StandingReason[];
  publishedCorrectionEffect: string | null;
  challenged: CorrectionMark[];
  accountCorrected: CorrectionMark[];
  basisCorrected: CorrectionMark[];
  inCycle: boolean;
}

interface RelationshipState {
  record: Relationship;
  authorization_id: string | null;
  standing: RelationshipStanding['standing'];
  notApplied: RelationshipNotApplied | null;
  because: StandingReason[];
  correctionEffect: string | null;
}

interface ChainMemo {
  chain: FollowedCorrection | null;
  links: number;
  broken: UnresolvedReason | null;
}

/**
 * What stands for one target identity, and why. Pure: every input, including
 * the time a time-ended exception is judged at, is a parameter, so the same
 * records and the same request always give the same answer.
 *
 * It judges no authority. A stored act was already judged by the writer that
 * published it, inside its transaction; re-deciding it here from a reader's
 * partial view could only disagree with the store. Its one defensive exception
 * is attribution: rows reach a store by upgrade, import and sync, which no
 * writer of this build judged, and a detector may only ever propose.
 */
export function resolveKnowledge(
  records: KnowledgeRecords,
  request: KnowledgeReadRequest
): ResolvedKnowledge {
  const later: LaterKnowledgeRecord[] = [];
  const omissions: ResolutionOmission[] = [];
  const unresolved: UnresolvedPoint[] = [];

  const plain = (record_id: string, recorded_at: string | null = null) => ({
    record_id,
    correction: null,
    recorded_at,
  });

  const visible = <W extends PublishedRecord<unknown>>(
    entries: readonly W[],
    record: KnowledgeRecordKind,
    describe: (value: W['record']) => Omit<LaterKnowledgeRecord, 'record' | 'write_sequence'>
  ): W[] =>
    entries.filter((entry) => {
      if (entry.write_sequence <= request.knowledge_boundary) return true;
      later.push({ record, write_sequence: entry.write_sequence, ...describe(entry.record) });
      return false;
    });

  const omit = (
    record: KnowledgeRecordKind,
    record_id: string,
    reason: ResolutionOmission['reason']
  ) => omissions.push({ record, record_id, reason });

  const ours = (ref: RecordRevisionRef) => ref.entity_id === records.target.entity_id;

  const visibleRevisions = visible(records.revisions, 'revision', (value) =>
    plain(value.revision.revision_id)
  );
  const visibleSelections = visible(records.selections, 'selection', (value) =>
    plain(value.selection_id)
  );
  const visibleCorrections = visible(records.corrections, 'correction', (value) => ({
    record_id: value.action_id,
    correction: { kind: value.kind, targets: [...value.targets] },
    recorded_at: null,
  }));
  const visibleRelationships = visible(records.relationships, 'relationship', (value) =>
    plain(value.relationship_id)
  );
  const visibleExceptions = visible(records.exceptions, 'exception', (value) =>
    plain(value.exception_id)
  );
  const visibleRevocations = visible(records.revocations, 'revocation', (value) =>
    plain(value.revocation_id, value.recorded_at)
  );
  const visibleAnswers = visible(records.conflict_answers, 'conflict_answer', (value) =>
    plain(value.answer_id, value.answered_at)
  );
  const visibleAssignments = visible(records.assignments ?? [], 'assignment', (value) =>
    plain(value.assignment.assignment_id)
  );
  const visibleBranchRows = visible(records.branch_scoped_rows, 'branch_scoped_row', (value) =>
    plain(value.record_id)
  );

  const branchScoped: BranchScopedRow[] = [];
  for (const entry of visibleBranchRows) {
    const row = entry.record;
    if (!ours(row.target)) {
      omit('branch_scoped_row', row.record_id, 'another_identity');
      continue;
    }
    omit('branch_scoped_row', row.record_id, 'branch_scope');
    branchScoped.push({ ...row, target: { ...row.target } });
  }

  const states = new Map<string, RevisionState>();
  const stateFor = (revision: RecordRevisionRef) => {
    const key = revisionKey(revision);
    const existing = states.get(key);
    if (existing !== undefined) return existing;
    const created: RevisionState = {
      revision,
      known: null,
      scoped: new Map(),
      published: true,
      publishedBecause: [],
      publishedCorrectionEffect: null,
      challenged: [],
      accountCorrected: [],
      basisCorrected: [],
      inCycle: false,
    };
    states.set(key, created);
    return created;
  };

  for (const entry of visibleRevisions) {
    if (!ours(entry.record.revision)) {
      omit('revision', entry.record.revision.revision_id, 'another_identity');
      continue;
    }
    stateFor(entry.record.revision).known = entry.record;
  }

  const relationships = new Map<string, RelationshipState>();
  for (const entry of visibleRelationships) {
    const relationship = entry.record;
    // A relationship is an identity of its own as well as a link between two
    // revisions, so a read of that identity concerns it however it points.
    const anotherIdentity =
      (records.target.kind !== 'relationship' ||
        relationship.relationship_id !== records.target.entity_id) &&
      !ours(relationship.from) &&
      !ours(relationship.to);
    if (anotherIdentity && relationship.relation !== 'supersedes') {
      omit('relationship', relationship.relationship_id, 'another_identity');
      continue;
    }
    if (!scopeReaches(relationship.scope, request.scope)) {
      omit('relationship', relationship.relationship_id, 'another_scope');
      continue;
    }
    relationships.set(relationship.relationship_id, {
      record: relationship,
      authorization_id: entry.authorization_id,
      standing: relationship.standing,
      notApplied: null,
      because: [],
      correctionEffect: null,
    });
  }

  const revokedBy = new Map<string, string[]>();
  for (const entry of visibleRevocations) {
    const revocation = entry.record;
    if (!scopeReaches(revocation.scope, request.scope)) {
      omit('revocation', revocation.revocation_id, 'another_scope');
      continue;
    }
    const named = revokedBy.get(revocation.revokes.id) ?? [];
    named.push(revocation.revocation_id);
    revokedBy.set(revocation.revokes.id, named);
  }
  const revocationScopes = new Map(
    visibleRevocations.map((entry) => [entry.record.revocation_id, entry.record.scope])
  );
  const revocationsReaching = (id: string | null, at: AuthorityScope) =>
    (id === null ? [] : (revokedBy.get(id) ?? [])).filter((revocationId) => {
      const scope = revocationScopes.get(revocationId);
      return scope !== undefined && scopeReaches(scope, at);
    });

  const recordedChoices: RecordedChoice[] = [];
  const proposals = new Map<string, ProposedCorrection>();
  const activeProposalEffects = new Set<string>();
  const correctionResolution = new Map<string, 'resolved' | 'unresolved'>();
  const governingCorrections = new Set<string>();

  const actions = new Map<string, CorrectionAction>(
    visibleCorrections.map((entry) => [entry.record.action_id, entry.record])
  );

  /**
   * The chain a reversal or acceptance is judged with. Each action shares the
   * chain of the action it follows, so building every chain costs one walk in
   * total, and the contract's bound keeps each one short enough for the
   * footprint recursion that reads it.
   */
  const memos = new Map<string, ChainMemo>();
  const chainFor = (action: CorrectionAction): ChainMemo => {
    const memo = memos.get(action.action_id);
    if (memo !== undefined) return memo;
    const descent: CorrectionAction[] = [];
    const onPath = new Set<string>();
    let result: ChainMemo = { chain: null, links: 0, broken: null };
    let node: CorrectionAction = action;
    for (;;) {
      const known = memos.get(node.action_id);
      if (known !== undefined) {
        result = known;
        break;
      }
      if (onPath.has(node.action_id)) {
        result = { chain: null, links: 0, broken: 'followed_action_cycle' };
        break;
      }
      onPath.add(node.action_id);
      const nextId = followedActionId(node);
      if (nextId === null) break;
      const next = actions.get(nextId);
      if (next === undefined) {
        result = { chain: null, links: 0, broken: 'followed_action_not_supplied' };
        break;
      }
      descent.push(node);
      node = next;
    }
    memos.set(node.action_id, result);
    for (let step = descent.length - 1; step >= 0; step -= 1) {
      const current = descent[step] as CorrectionAction;
      const followedAction =
        step + 1 < descent.length ? (descent[step + 1] as CorrectionAction) : node;
      if (result.broken !== null) result = { chain: null, links: 0, broken: result.broken };
      else if (result.links + 1 > MAX_FOLLOWED_CHAIN)
        result = { chain: null, links: 0, broken: 'followed_chain_too_long' };
      else
        result = {
          chain: { action: followedAction, followed: result.chain },
          links: result.links + 1,
          broken: null,
        };
      memos.set(current.action_id, result);
    }
    return result;
  };

  type Act =
    | { write_sequence: number; id: string; kind: 'selection'; act: PublishedAct<Selection> }
    | {
        write_sequence: number;
        id: string;
        kind: 'correction';
        act: PublishedAct<CorrectionAction>;
      };

  const acts: Act[] = [];
  for (const entry of visibleSelections) {
    const selection = entry.record;
    if (!ours(selection.target)) {
      omit('selection', selection.selection_id, 'another_identity');
      continue;
    }
    if (!scopeReaches(selection.scope, request.scope)) {
      omit('selection', selection.selection_id, 'another_scope');
      continue;
    }
    if (selection.kind !== 'accepted') {
      recordedChoices.push({
        selection_id: selection.selection_id,
        kind: selection.kind,
        target: selection.target,
        scope: selection.scope,
        selected_by: selection.selected_by,
      });
      continue;
    }
    acts.push({
      write_sequence: entry.write_sequence,
      id: selection.selection_id,
      kind: 'selection',
      act: entry,
    });
  }
  // A correction reaches this read when it names a revision of this identity or
  // a relationship this read loaded: withdrawing an established replacement is
  // how the revision it points at comes back, and that act names neither
  // endpoint.
  const namesALoadedRelationship = (refs: readonly RecordRevisionRef[]) =>
    refs.some((ref) => ref.kind === 'relationship' && relationships.has(ref.entity_id));
  for (const entry of visibleCorrections) {
    const action = entry.record;
    const followedTargets = actions.get(followedActionId(action) ?? '')?.targets ?? [];
    const footprint = correctionFootprint(action, chainFor(action).chain);
    const footprintReferences = [
      ...footprint.adopts.map((adoption) => adoption.revision),
      ...footprint.departs_from.map((departure) => departure.rule),
      ...footprint.restates,
    ];
    const touches =
      action.targets.some(ours) ||
      footprintReferences.some(ours) ||
      namesALoadedRelationship(action.targets) ||
      namesALoadedRelationship(followedTargets) ||
      (action.kind === 'accepted_replacement' && ours(action.replacement)) ||
      (action.kind === 'reversal' &&
        action.resulting_selection.kind === 'revision' &&
        ours(action.resulting_selection.revision));
    if (!touches) {
      omit('correction', action.action_id, 'another_identity');
      continue;
    }
    if (!scopeReaches(action.scope, request.scope)) {
      omit('correction', action.action_id, 'another_scope');
      continue;
    }
    acts.push({
      write_sequence: entry.write_sequence,
      id: action.action_id,
      kind: 'correction',
      act: entry,
    });
  }

  // Acts take effect in the order they were published. Two adopted revisions
  // that overlap at the end are a conflict, never a race the later one wins.
  acts.sort(
    (left, right) => left.write_sequence - right.write_sequence || byText(left.id, right.id)
  );

  let changed = false;
  const stand = (
    revision: RecordRevisionRef,
    scope: AuthorityScope,
    designation: Designation,
    reason: StandingReason
  ) => {
    const state = stateFor(revision);
    const key = scopeKey(scope);
    state.publishedCorrectionEffect = null;
    for (const entry of state.scoped.values()) entry.departedCorrectionEffects.delete(key);
    const current = state.scoped.get(key);
    if (current === undefined) {
      state.scoped.set(key, {
        scope,
        designation,
        standing: true,
        supporting: reason.record === 'selection' ? [reason.record_id] : [],
        authorityRevoked: new Map(),
        departedHere: [],
        departedCorrectionEffects: new Map(),
        because: [reason],
        correctionEffect: reason.record === 'correction' ? reason.record_id : null,
      });
      changed = true;
      return;
    }
    if (current.standing && current.designation === designation) {
      if (reason.record === 'selection') current.supporting.push(reason.record_id);
      current.because.push(reason);
      changed = true;
      return;
    }
    // A later act on the same revision in the same scope re-states it: the
    // selections that carried the old designation no longer carry this one.
    const redesignated = current.standing && current.designation !== designation;
    current.standing = true;
    current.designation = designation;
    current.supporting = reason.record === 'selection' ? [reason.record_id] : [];
    current.because.push(redesignated ? { ...reason, effect: 'designation_changed' } : reason);
    current.correctionEffect = reason.record === 'correction' ? reason.record_id : null;
    changed = true;
  };

  const stopRevision = (
    revision: RecordRevisionRef,
    actScope: AuthorityScope,
    reason: StandingReason
  ) => {
    const state = stateFor(revision);
    for (const entry of state.scoped.values()) {
      if (!entry.standing) continue;
      if (scopeReaches(actScope, entry.scope)) {
        entry.standing = false;
        entry.supporting = [];
        entry.because.push(reason);
        entry.correctionEffect = reason.record === 'correction' ? reason.record_id : null;
        changed = true;
        continue;
      }
      // An act in a narrower scope departs from the rule for that scope only:
      // the instruction behind it already acknowledged the rule, so this is not
      // a conflict to ask about, and the wider scope keeps its rule.
      if (!scopeReaches(entry.scope, actScope)) continue;
      entry.departedHere.push({
        record_id: reason.record_id,
        scope: actScope,
        effect: reason.effect,
      });
      if (reason.record === 'correction')
        entry.departedCorrectionEffects.set(scopeKey(actScope), reason.record_id);
      changed = true;
    }
    if (state.published) {
      state.published = false;
      state.publishedBecause.push(reason);
      state.publishedCorrectionEffect = reason.record === 'correction' ? reason.record_id : null;
      changed = true;
    }
  };

  const stopTarget = (
    target: RecordRevisionRef,
    actScope: AuthorityScope,
    reason: StandingReason
  ) => {
    if (target.kind === 'relationship') {
      const relationship = relationships.get(target.entity_id);
      if (relationship === undefined || relationship.standing === 'withdrawn') return;
      if (relationship.standing === 'established') changed = true;
      relationship.standing = 'withdrawn';
      relationship.because.push(reason);
      relationship.correctionEffect = reason.record === 'correction' ? reason.record_id : null;
      return;
    }
    if (!ours(target)) return;
    stopRevision(target, actScope, reason);
  };

  const mark = (
    list: (state: RevisionState) => CorrectionMark[],
    targets: readonly RecordRevisionRef[],
    entry: CorrectionMark
  ) => {
    for (const target of targets) {
      if (target.kind === 'relationship' || !ours(target)) continue;
      list(stateFor(target)).push(entry);
      if (entry.accepted_by !== null) changed = true;
    }
  };

  const listFor = (kind: CorrectionAction['kind']) => {
    if (kind === 'challenge') return (state: RevisionState) => state.challenged;
    if (kind === 'factual_correction') return (state: RevisionState) => state.accountCorrected;
    return (state: RevisionState) => state.basisCorrected;
  };

  const qualifiesGrouping = (kind: CorrectionAction['kind']) =>
    kind === 'identity_correction' || kind === 'use_correction';

  for (const act of acts) {
    changed = false;
    if (act.kind === 'selection') {
      const selection = act.act.record;
      stand(selection.target, selection.scope, selection.designation as Designation, {
        record: 'selection',
        record_id: selection.selection_id,
        effect: 'adopted',
      });
      const rests = selection.authorization;
      const ended = [
        ...revocationsReaching(act.act.authorization_id, selection.scope),
        ...(rests !== null && rests.kind === 'reused_authorization'
          ? revocationsReaching(rests.authorization_id, selection.scope)
          : []),
      ];
      if (ended.length > 0)
        stateFor(selection.target)
          .scoped.get(scopeKey(selection.scope))
          ?.authorityRevoked.set(selection.selection_id, ended);
      continue;
    }
    const action = act.act.record;
    // Everything background processing writes is attributed to a detector, and a
    // detector only ever proposes. Released and imported rows were not judged by
    // any writer of this build, so an act that claims otherwise is reported
    // rather than applied.
    if (action.attributed_to.kind === 'detector' && !isProposingCorrection(action.kind)) {
      correctionResolution.set(action.action_id, 'unresolved');
      unresolved.push({
        about: 'correction',
        record_ids: [action.action_id],
        reason: 'detector_cannot_act',
      });
      continue;
    }
    const followedChain = chainFor(action);
    if (followedChain.broken !== null) {
      correctionResolution.set(action.action_id, 'unresolved');
      unresolved.push({
        about: 'correction',
        record_ids: [action.action_id],
        reason: followedChain.broken,
      });
    } else correctionResolution.set(action.action_id, 'resolved');
    const followed = followedChain.chain;
    if (isProposingCorrection(action.kind)) {
      proposals.set(action.action_id, {
        action_id: action.action_id,
        kind: action.kind,
        targets: [...action.targets],
        scope: action.scope,
        attributed_to: action.attributed_to,
        accepted_by: null,
        retracted_by: null,
      });
      // An identity or use correction marks nothing itself; the resolver shows
      // what rests on the corrected basis, whether or not it was accepted.
      if (qualifiesGrouping(action.kind))
        mark(listFor(action.kind), action.targets, {
          action_id: action.action_id,
          accepted_by: null,
        });
    } else if (action.kind === 'withdrawal') {
      for (const target of action.targets)
        stopTarget(target, action.scope, {
          record: 'correction',
          record_id: action.action_id,
          effect: 'withdrawn',
        });
    } else if (action.kind === 'accepted_replacement') {
      for (const target of action.targets)
        stopTarget(target, action.scope, {
          record: 'correction',
          record_id: action.action_id,
          effect: 'replaced',
        });
      if (ours(action.replacement))
        stand(action.replacement, action.scope, action.designation, {
          record: 'correction',
          record_id: action.action_id,
          effect: 'stands_as_replacement',
        });
    } else if (action.kind === 'acceptance' && followed !== null) {
      const proposed = followed.action;
      mark(listFor(proposed.kind), proposed.targets, {
        action_id: proposed.action_id,
        accepted_by: action.action_id,
      });
    } else if (action.kind === 'reversal' && followed !== null) {
      // A reversal names its resulting selection: what the action it follows
      // made stand stops standing, and nothing else is silently restored.
      const named = new Set<string>();
      for (const adoption of correctionFootprint(followed.action, followed.followed).adopts) {
        named.add(revisionKey(adoption.revision));
        stopTarget(adoption.revision, action.scope, {
          record: 'correction',
          record_id: action.action_id,
          effect: 'reversed',
        });
      }
      const undone = followed.action;
      if (undone.kind === 'withdrawal' || undone.kind === 'accepted_replacement')
        for (const target of undone.targets)
          if (target.kind === 'relationship') {
            const relationship = relationships.get(target.entity_id);
            if (relationship === undefined || relationship.standing !== 'withdrawn') continue;
            relationship.standing = relationship.record.standing;
            relationship.because.push({
              record: 'correction',
              record_id: action.action_id,
              effect: 'restored',
            });
            relationship.correctionEffect = action.action_id;
            if (relationship.standing === 'established') changed = true;
          }
      if (
        action.resulting_selection.kind === 'revision' &&
        ours(action.resulting_selection.revision)
      ) {
        named.add(revisionKey(action.resulting_selection.revision));
        stand(
          action.resulting_selection.revision,
          action.scope,
          action.resulting_selection.designation,
          { record: 'correction', record_id: action.action_id, effect: 'restored' }
        );
      }
      // A reversal that restores nothing still changes the standing of every
      // rule the action it follows stopped or corrected, so it is not invisible.
      const whole = correctionFootprint(action, followed);
      const corrected = [
        ...whole.departs_from.map((departure) => departure.rule),
        ...whole.restates,
      ];
      for (const revision of corrected) {
        if (!ours(revision) || named.has(revisionKey(revision))) continue;
        named.add(revisionKey(revision));
        const state = stateFor(revision);
        const reason: StandingReason = {
          record: 'correction',
          record_id: action.action_id,
          effect: 'corrected',
        };
        const scoped = [...state.scoped.values()].filter((entry) =>
          scopeReaches(action.scope, entry.scope)
        );
        if (scoped.length === 0) {
          state.publishedBecause.push(reason);
          state.publishedCorrectionEffect = action.action_id;
        } else
          for (const entry of scoped) {
            entry.because.push(reason);
            entry.correctionEffect = action.action_id;
          }
        changed = true;
      }
    } else if (action.kind !== 'acceptance' && action.kind !== 'reversal') {
      // Hide least applies to what the resolver does not understand: a kind it
      // cannot apply is reported rather than passed over.
      unresolved.push({
        about: 'correction',
        record_ids: [act.id],
        reason: 'correction_kind_not_understood',
      });
      correctionResolution.set(action.action_id, 'unresolved');
    }
    if (changed) governingCorrections.add(action.action_id);
  }

  const reversalFollowers = new Map<string, string[]>();
  for (const action of actions.values()) {
    if (action.kind !== 'reversal' || correctionResolution.get(action.action_id) !== 'resolved')
      continue;
    reversalFollowers.set(action.reverses_action_id, [
      ...(reversalFollowers.get(action.reverses_action_id) ?? []),
      action.action_id,
    ]);
  }
  const reversedMemo = new Map<string, boolean>();
  const isReversed = (actionId: string, path: Set<string> = new Set()): boolean => {
    const memo = reversedMemo.get(actionId);
    if (memo !== undefined) return memo;
    if (path.has(actionId)) return false;
    const nextPath = new Set(path).add(actionId);
    const reversed = (reversalFollowers.get(actionId) ?? []).some(
      (followerId) => !isReversed(followerId, nextPath)
    );
    reversedMemo.set(actionId, reversed);
    return reversed;
  };
  const rootProposal = (action: CorrectionAction): CorrectionAction | null => {
    const chain = chainFor(action);
    if (chain.broken !== null) return null;
    let root = action;
    for (let link = chain.chain; link !== null; link = link.followed) root = link.action;
    return isProposingCorrection(root.kind) ? root : null;
  };
  const correctionSequence = new Map(
    visibleCorrections.map((entry) => [entry.record.action_id, entry.write_sequence])
  );
  const byCorrectionOrder = (left: CorrectionAction, right: CorrectionAction) =>
    (correctionSequence.get(left.action_id) ?? 0) -
      (correctionSequence.get(right.action_id) ?? 0) || byText(left.action_id, right.action_id);

  for (const state of states.values())
    for (const marks of [state.challenged, state.accountCorrected, state.basisCorrected]) {
      const retained = marks.filter((mark) => !proposals.has(mark.action_id));
      marks.length = 0;
      marks.push(...retained);
    }
  for (const [proposalId, proposalEntry] of proposals) {
    const proposal = actions.get(proposalId);
    if (proposal === undefined) continue;
    const acceptances = [...actions.values()]
      .filter(
        (action) =>
          action.kind === 'acceptance' &&
          action.accepts_action_id === proposalId &&
          correctionResolution.get(action.action_id) === 'resolved' &&
          !isReversed(action.action_id)
      )
      .sort(byCorrectionOrder);
    const retractions = [...actions.values()]
      .filter(
        (action) =>
          action.kind === 'reversal' &&
          action.reverses_action_id === proposalId &&
          correctionResolution.get(action.action_id) === 'resolved' &&
          !isReversed(action.action_id)
      )
      .sort(byCorrectionOrder);
    proposalEntry.accepted_by = acceptances.at(-1)?.action_id ?? null;
    proposalEntry.retracted_by = retractions.at(-1)?.action_id ?? null;
    if (retractions.length === 0 || acceptances.length > 0) activeProposalEffects.add(proposalId);
    for (const acceptance of acceptances) {
      activeProposalEffects.add(acceptance.action_id);
      mark(listFor(proposal.kind), proposal.targets, {
        action_id: proposalId,
        accepted_by: acceptance.action_id,
      });
    }
    if (acceptances.length === 0 && retractions.length === 0 && qualifiesGrouping(proposal.kind))
      mark(listFor(proposal.kind), proposal.targets, {
        action_id: proposalId,
        accepted_by: null,
      });
  }
  for (const action of actions.values())
    if (
      action.kind === 'reversal' &&
      correctionResolution.get(action.action_id) === 'resolved' &&
      rootProposal(action) !== null &&
      !isReversed(action.action_id)
    )
      activeProposalEffects.add(action.action_id);

  const replacements = [...relationships.values()].filter(
    (entry) => entry.record.relation === 'supersedes'
  );
  const cyclic = cyclicReplacements(
    replacements
      .filter((entry) => entry.standing === 'established')
      .map((entry) => ({
        relationship_id: entry.record.relationship_id,
        from: revisionKey(entry.record.from),
        to: revisionKey(entry.record.to),
      }))
  );
  if (cyclic.size > 0)
    unresolved.push({
      about: 'relationship',
      record_ids: [...cyclic].sort(byText),
      reason: 'replacement_cycle',
    });
  if (!records.replacement_graph_complete)
    unresolved.push({
      about: 'relationship',
      record_ids: replacements.map((entry) => entry.record.relationship_id).sort(byText),
      reason: 'replacement_graph_incomplete',
    });

  for (const entry of relationships.values()) {
    const { record } = entry;
    if (record.relation !== 'supersedes') entry.notApplied = 'not_a_replacement';
    else if (entry.standing === 'withdrawn') entry.notApplied = 'withdrawn';
    else if (entry.standing === 'suggested') entry.notApplied = 'suggested';
    else if (record.attributed_to.kind === 'detector') entry.notApplied = 'detector_attribution';
    else if (cyclic.has(record.relationship_id)) entry.notApplied = 'replacement_cycle';
    else if (!records.replacement_graph_complete) entry.notApplied = 'replacement_graph_incomplete';
    else if (!ours(record.to)) entry.notApplied = 'another_identity';
  }

  // A cycle may run through another identity's revision. That endpoint is
  // named as an omission rather than pulled into this answer as one of ours.
  const foreignEndpoints = new Set<string>();
  for (const entry of replacements) {
    if (!cyclic.has(entry.record.relationship_id)) continue;
    for (const endpoint of [entry.record.from, entry.record.to]) {
      if (ours(endpoint)) {
        stateFor(endpoint).inCycle = true;
        continue;
      }
      if (foreignEndpoints.has(revisionKey(endpoint))) continue;
      foreignEndpoints.add(revisionKey(endpoint));
      omit('revision', endpoint.revision_id, 'another_identity');
    }
  }

  // An established replacement replaces the revision it points at for as long
  // as it stands. A cyclic one, and one a detector only suggested however its
  // row reads, are reported instead of applied, so inconsistent imported
  // history hides nothing.
  const contradicted = new Map<string, RecordRevisionRef>();
  for (const entry of relationships.values()) {
    if (entry.notApplied !== null) continue;
    const { record } = entry;
    const state = states.get(revisionKey(record.to));
    const carried = [...(state?.scoped.values() ?? [])].some(
      (scoped) =>
        scoped.standing && scoped.supporting.length > 0 && scopeReaches(record.scope, scoped.scope)
    );
    if (carried) contradicted.set(revisionKey(record.to), record.to);
    stopRevision(record.to, record.scope, {
      record: 'relationship',
      record_id: record.relationship_id,
      effect: 'superseded_by_relationship',
    });
  }
  // An adoption of a revision an established replacement points at contradicts
  // that replacement. Decision 10 leaves the replacement standing; the answer
  // says so instead of dropping the adoption in silence.
  for (const revision of [...contradicted.entries()]
    .sort(([left], [right]) => byText(left, right))
    .map(([, value]) => value))
    unresolved.push({
      about: 'revision',
      record_ids: [revision.revision_id],
      reason: 'adopted_while_replaced',
    });

  const entries: RevisionStanding[] = [];
  for (const state of states.values()) {
    const applicability =
      state.known === null
        ? 'unresolved'
        : evaluateApplicability(state.known.applicability, request.applicability);
    if (state.known === null)
      unresolved.push({
        about: 'revision',
        record_ids: [state.revision.revision_id],
        reason: 'revision_not_supplied',
      });
    const common = {
      revision: state.revision,
      applicability,
      source_standing: state.known?.source_standing ?? null,
      attributed_to: state.known?.attributed_to ?? null,
      challenged_by: [...state.challenged],
      account_corrected_by: [...state.accountCorrected],
      corrected_basis: [...state.basisCorrected],
      in_replacement_cycle: state.inCycle,
    };
    if (state.scoped.size === 0) {
      entries.push({
        ...common,
        standing: state.published ? 'unadopted' : 'stopped',
        scope: null,
        designation: null,
        authority_revoked_by: [],
        departed_in_scope: [],
        stood_by: [],
        because: [...state.publishedBecause],
      });
      continue;
    }
    for (const scoped of state.scoped.values()) {
      const supporting = [...scoped.supporting].sort(byText);
      entries.push({
        ...common,
        standing: scoped.standing ? 'stands' : 'stopped',
        scope: scoped.scope,
        designation: scoped.designation,
        // Carried per supporting selection: an entry a later, unrevoked adoption
        // also carries does not read as resting on revoked authority.
        authority_revoked_by: supporting
          .map((selection_id) => ({
            selection_id,
            revocation_ids: [...(scoped.authorityRevoked.get(selection_id) ?? [])].sort(byText),
          }))
          .filter((revoked) => revoked.revocation_ids.length > 0),
        departed_in_scope: [...scoped.departedHere],
        stood_by: supporting,
        because: [...scoped.because],
      });
    }
  }
  entries.sort(
    (left, right) =>
      byText(left.revision.kind, right.revision.kind) ||
      byText(left.revision.entity_id, right.revision.entity_id) ||
      byText(left.revision.revision_id, right.revision.revision_id) ||
      byText(scopeKey(left.scope), scopeKey(right.scope))
  );

  const standing = entries.filter((entry) => entry.standing === 'stands');
  const standingKeys = new Set(standing.map((entry) => revisionKey(entry.revision)));
  for (const entry of standing)
    if (entry.applicability === 'unresolved' && entry.source_standing !== null)
      unresolved.push({
        about: 'revision',
        record_ids: [entry.revision.revision_id],
        reason: 'applicability_inputs_missing',
      });

  // An assignment reaches this read when its inherited obligations or its
  // delegated footprint name this identity. Its validity window is judged at the
  // same time an exception's end is, so one read never says an assignment
  // expired and an exception did not at the same instant.
  const assignmentEntries: AssignmentStandingEntry[] = [];
  const applicableAssignments: ApplicableAssignment[] = [];
  for (const entry of visibleAssignments) {
    const { assignment, basis_stands } = entry.record;
    if (!scopeReaches(assignment.scope, request.scope)) {
      omit('assignment', assignment.assignment_id, 'another_scope');
      continue;
    }
    const inherits = assignment.inherited.filter(ours);
    const delegates = {
      adopts: assignment.delegated.adopts.filter((adoption) => ours(adoption.revision)),
      departs_from: assignment.delegated.departs_from.filter((departure) => ours(departure.rule)),
      restates: assignment.delegated.restates.filter(ours),
    };
    const names =
      inherits.length > 0 ||
      delegates.adopts.length > 0 ||
      delegates.departs_from.length > 0 ||
      delegates.restates.length > 0;
    if (!names) {
      omit('assignment', assignment.assignment_id, 'another_identity');
      continue;
    }
    const ended = revocationsReaching(assignment.assignment_id, assignment.scope).sort(byText);
    const window = evaluateApplicability(assignmentWindow(assignment.valid_until), {
      ...(request.exceptions_judged_at === null ? {} : { time: request.exceptions_judged_at }),
    });
    const { standing, reason } = assignmentStandingOf({
      revoked: ended.length > 0,
      basis_stands,
      window,
    });
    assignmentEntries.push({
      assignment_id: assignment.assignment_id,
      objective: assignment.objective,
      responsible: assignment.responsible,
      scope: assignment.scope,
      inherits,
      delegates,
      escalation_conditions: [...assignment.escalation_conditions],
      valid_until: assignment.valid_until,
      standing,
      reason,
      revoked_by: ended,
    });
    applicableAssignments.push({
      assignment_id: assignment.assignment_id,
      responsible: assignment.responsible,
      departs_from: assignment.delegated.departs_from,
      valid: ended.length === 0 && basis_stands,
      covers_this_work: window,
    });
  }

  const earlierAnswers: EarlierConflictAnswer[] = [];
  for (const entry of visibleAnswers) {
    const answer = entry.record;
    if (!scopeReaches(answer.scope, request.scope)) {
      omit('conflict_answer', answer.answer_id, 'another_scope');
      continue;
    }
    if (!ours(answer.rule)) {
      omit('conflict_answer', answer.answer_id, 'another_identity');
      continue;
    }
    earlierAnswers.push({
      answer_id: answer.answer_id,
      rule: answer.rule,
      outcome: answer.outcome,
      answered_at: answer.answered_at,
      covers_this_work: evaluateApplicability(answer.context, request.applicability),
      valid:
        revocationsReaching(answer.answer_id, answer.scope).length === 0 &&
        standingKeys.has(revisionKey(answer.rule)),
    });
  }

  // Every adopted revision of one identity overlaps every other, so a read has
  // at most one conflict and every rule in it is asked about once. A revision an
  // act in this read's scope departed from takes no part in it.
  const adopted = standing.filter(
    (entry) => entry.designation === 'adopted' && entry.departed_in_scope.length === 0
  );
  const distinctAdopted = [
    ...new Map(adopted.map((entry) => [revisionKey(entry.revision), entry.revision])).values(),
  ];
  const conflicts: GoverningConflict[] = [];
  if (distinctAdopted.length > 1) {
    const scopes = new Set(adopted.map((entry) => scopeKey(entry.scope)));
    const disposition = distinctAdopted.every(isExpectationRef)
      ? conflictDisposition({
          conflicting: distinctAdopted as readonly ExpectationRevisionRef[],
          acknowledged: [],
          earlier: earlierAnswers,
          assignments: applicableAssignments,
          acting: request.acting ?? null,
        })
      : null;
    conflicts.push({
      scope: scopes.size === 1 ? (adopted[0]?.scope ?? null) : null,
      revisions: distinctAdopted,
      disposition,
    });
    if (disposition?.action === 'ask_once')
      unresolved.push({
        about: 'conflict',
        record_ids: disposition.unacknowledged.map((rule) => rule.revision_id).sort(byText),
        reason: 'conflict_unanswered',
      });
  }

  const exceptions: ExceptionStandingEntry[] = [];
  for (const entry of visibleExceptions) {
    const exception = entry.record;
    if (!ours(exception.expectation)) {
      omit('exception', exception.exception_id, 'another_identity');
      continue;
    }
    if (!scopeReaches(exception.scope, request.scope)) {
      omit('exception', exception.exception_id, 'another_scope');
      continue;
    }
    const ended = revocationsReaching(exception.exception_id, exception.scope);
    const standingNow = exceptionStanding(exception, {
      time: request.exceptions_judged_at ?? undefined,
      // Own properties only: an id that happens to name something on the
      // prototype is not a supplied condition.
      condition_met: Object.hasOwn(request.exception_conditions, exception.exception_id)
        ? request.exception_conditions[exception.exception_id]
        : undefined,
      revoked: ended.length > 0,
    });
    if (standingNow === 'unresolved')
      unresolved.push({
        about: 'exception',
        record_ids: [exception.exception_id],
        reason:
          exception.ends.kind === 'until_condition'
            ? 'end_condition_not_supplied'
            : exception.ends.kind === 'until_time'
              ? 'end_time_not_readable'
              : 'end_unknown',
      });
    exceptions.push({
      exception_id: exception.exception_id,
      expectation: exception.expectation,
      scope: exception.scope,
      standing: standingNow,
      end_behavior: exception.end_behavior,
      context_applies: evaluateApplicability(exception.context, request.applicability),
      revoked_by: [...ended].sort(byText),
      expectation_stands: standingKeys.has(revisionKey(exception.expectation)),
    });
  }

  unresolved.push({ about: 'evidence', record_ids: [], reason: 'evidence_not_attached' });

  // Ending the authorization an established replacement rests on preserves what was done under it,
  // exactly as decision 1 reads it for a selection: the relationship still stands, and the entry
  // names the revocations that ended the authority behind it.
  const relationshipEntries: RelationshipStanding[] = [...relationships.values()].map((entry) => ({
    relationship_id: entry.record.relationship_id,
    relation: entry.record.relation,
    from: entry.record.from,
    to: entry.record.to,
    scope: entry.record.scope,
    attributed_to: entry.record.attributed_to,
    standing: entry.standing,
    applied: entry.notApplied === null,
    not_applied: entry.notApplied,
    authority_revoked_by: revocationsReaching(entry.authorization_id, entry.record.scope).sort(
      byText
    ),
    because: entry.because,
  }));

  const effectiveCorrections = new Set<string>();
  for (const state of states.values()) {
    if (state.publishedCorrectionEffect !== null)
      effectiveCorrections.add(state.publishedCorrectionEffect);
    for (const scoped of state.scoped.values())
      if (scoped.correctionEffect !== null) effectiveCorrections.add(scoped.correctionEffect);
    for (const scoped of state.scoped.values())
      for (const effect of scoped.departedCorrectionEffects.values())
        effectiveCorrections.add(effect);
    for (const mark of [...state.challenged, ...state.accountCorrected, ...state.basisCorrected])
      if (mark.accepted_by !== null) effectiveCorrections.add(mark.accepted_by);
  }
  for (const relationship of relationships.values())
    if (relationship.correctionEffect !== null)
      effectiveCorrections.add(relationship.correctionEffect);
  for (const actionId of activeProposalEffects) effectiveCorrections.add(actionId);
  const correctionReferences = (action: CorrectionAction): RecordRevisionRef[] => [
    ...action.targets,
    ...(action.kind === 'accepted_replacement' ? [action.replacement] : []),
    ...(action.kind === 'reversal' && action.resulting_selection.kind === 'revision'
      ? [action.resulting_selection.revision]
      : []),
  ];
  const correctionEffects: CorrectionEffectStanding[] = [...correctionResolution].map(
    ([action_id, resolution]) => ({
      action_id,
      standing:
        resolution === 'unresolved' ||
        (actions.has(action_id) &&
          correctionReferences(actions.get(action_id) as CorrectionAction).some(
            (target) =>
              target.kind !== 'relationship' && ours(target) && stateFor(target).known === null
          ))
          ? 'unresolved'
          : effectiveCorrections.has(action_id)
            ? 'effective'
            : 'ended',
    })
  );
  const effectiveSelections = new Set(
    entries.flatMap((entry) => (entry.standing === 'stands' ? entry.stood_by : []))
  );
  const selectionEffects: SelectionEffectStanding[] = acts.flatMap((act) => {
    if (act.kind !== 'selection') return [];
    return [
      {
        selection_id: act.id,
        standing:
          stateFor(act.act.record.target).known === null
            ? ('unresolved' as const)
            : effectiveSelections.has(act.id)
              ? ('effective' as const)
              : ('ended' as const),
      },
    ];
  });

  return {
    target: { ...records.target },
    basis: {
      scope: request.scope,
      mode: request.mode,
      knowledge_boundary: request.knowledge_boundary,
      implementation: copyImplementation(request.implementation),
      applicability: copyApplicability(request.applicability),
      exceptions_judged_at: request.exceptions_judged_at,
      ...(request.acting === undefined ? {} : { acting: request.acting }),
    },
    revisions: entries,
    governing_state: {
      selection_ids: [...new Set(standing.flatMap((entry) => entry.stood_by))].sort(byText),
      correction_action_ids: [...governingCorrections].sort(byText),
    },
    conflicts,
    proposals: [...proposals.values()].sort((left, right) =>
      byText(left.action_id, right.action_id)
    ),
    selection_effects: selectionEffects.sort((left, right) =>
      byText(left.selection_id, right.selection_id)
    ),
    correction_effects: correctionEffects.sort((left, right) =>
      byText(left.action_id, right.action_id)
    ),
    relationships: relationshipEntries.sort((left, right) =>
      byText(left.relationship_id, right.relationship_id)
    ),
    recorded_choices: recordedChoices.sort((left, right) =>
      byText(left.selection_id, right.selection_id)
    ),
    exceptions: exceptions.sort((left, right) => byText(left.exception_id, right.exception_id)),
    ...(records.assignments === undefined
      ? {}
      : {
          assignments: assignmentEntries.sort((left, right) =>
            byText(left.assignment_id, right.assignment_id)
          ),
        }),
    branch_scoped: branchScoped.sort((left, right) => byText(left.record_id, right.record_id)),
    later_annotations: later.sort(
      (left, right) =>
        left.write_sequence - right.write_sequence || byText(left.record_id, right.record_id)
    ),
    omissions: omissions.sort(
      (left, right) => byText(left.record, right.record) || byText(left.record_id, right.record_id)
    ),
    unresolved: unresolved.sort(
      (left, right) =>
        byText(left.about, right.about) ||
        byText(left.reason, right.reason) ||
        byText(left.record_ids.join(','), right.record_ids.join(','))
    ),
    evidence: { kind: 'not_attached' },
  };
}

/**
 * What a mutation observes: the selections that stand and the corrections that
 * changed what stands. A proposal is not part of it, so a detector's challenge
 * can never make an authorized write stale.
 */
export function governingStateOf(
  records: KnowledgeRecords,
  request: KnowledgeReadRequest
): GoverningState {
  return resolveKnowledge(records, request).governing_state;
}
