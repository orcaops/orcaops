// What the store holds about one target identity, read from rows into the shared resolver's
// input, so a writer never decides on its own what currently stands.
//
// A mutation observes everything committed: the boundary is the highest write sequence there can
// be, no implementation is selected and no exception ending is judged, because none of the three
// takes part in the governing state a mutation validates.
//
// A value the resolver reads whole from an authored payload is parsed against the contract, and a
// payload that will not read as its contract record stops the write: an authority judgment that
// quietly skipped a row would under-report what stands. A passive read cannot stop over one row, so
// it asks for the tolerant mode and names what it could not read instead. Everything else is built
// from the lookup columns the writer kept beside the payload.
import { z } from 'zod';

import { type ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { integrity, invalid } from './knowledge-record-input.js';
import {
  type ApplicabilityInputs,
  type ApplicabilitySelector,
  ApplicabilitySelectorSchema,
  type Assignment,
  AssignmentSchema,
  type Attribution,
  type AttributionBasis,
  type AuthorityScope,
  AuthorizationSchema,
  checkExpectedState,
  ConflictAnswerSchema,
  type CorrectionAction,
  CorrectionActionSchema,
  type Designation,
  ExceptionSchema,
  type ExpectationRevisionRef,
  type ExpectedState,
  ExpectedStateSchema,
  type GoverningState,
  MAX_FOLLOWED_CHAIN,
  type RecordRevisionRef,
  type Relationship,
  RevocationSchema,
  type Selection,
} from '../../schema/knowledge-contract.js';
import {
  type BranchScopedRow,
  type KnowledgeAssignment,
  type KnowledgeReadRequest,
  type KnowledgeRecordKind,
  type KnowledgeRecords,
  type KnowledgeRevision,
  type KnowledgeTarget,
  type PublishedAct,
  type PublishedRecord,
  type RelationshipStanding,
  type ResolvedKnowledge,
  resolveKnowledge,
  type SourceStanding,
} from '../../schema/knowledge-resolution.js';

/** Everything a committed operation could have published is visible to the act being published. */
const EVERYTHING_COMMITTED = Number.MAX_SAFE_INTEGER;

export const scopeColumns = (scope: AuthorityScope): [kind: string, value: string | null] =>
  scope.kind === 'project' ? ['project', null] : ['artifact', scope.artifact_id];

export const sameScope = (left: AuthorityScope, right: AuthorityScope): boolean =>
  left.kind === 'project'
    ? right.kind === 'project' && left.project_id === right.project_id
    : right.kind === 'artifact' && left.artifact_id === right.artifact_id;

/**
 * Whether an act in one scope reaches what another scope holds, as the resolver reads it: project
 * scope applies in every artifact of the store's one project, and an artifact's scope applies only
 * there. A writer that judged this differently from a reader would let one narrow act decide a
 * wider one that no read ever sees it in.
 */
export const scopeReaches = (act: AuthorityScope, at: AuthorityScope): boolean =>
  sameScope(act, at) || (act.kind === 'project' && at.kind === 'artifact');

interface ScopeRow {
  scope_kind: string;
  scope_value: string | null;
}

/** A released row may carry a branch, which grants no authority and is reported as it is. */
const scopeOf = (row: ScopeRow, projectId: string): AuthorityScope | null => {
  if (row.scope_kind === 'project') return { kind: 'project', project_id: projectId };
  if (row.scope_kind === 'artifact' && row.scope_value !== null)
    return { kind: 'artifact', artifact_id: row.scope_value };
  return null;
};

/** A row whose payload will not read as its contract record, named rather than judged. */
export interface UnreadableKnowledgeRecord {
  record: KnowledgeRecordKind;
  record_id: string;
}

export interface KnowledgeRecordsOptions {
  /**
   * Supplying this list is what asks for a passive read: a record whose payload will not read as
   * its contract record is named here and left out, for the caller to return as an omission.
   * Without it a writer stops, because an authority judgment that quietly skipped a row would
   * under-report what stands.
   */
  unreadable?: UnreadableKnowledgeRecord[];
  /**
   * The read this record set is for. Supplying it is what asks for the assignments naming this
   * identity, because judging whether the rules one rests on still stand takes a read of its own.
   * Every writer leaves it out, which is also what keeps the judgment finite: those inner reads ask
   * for no assignments, so nothing here resolves in a circle.
   */
  assignments?: KnowledgeReadRequest;
}

/** Reads a retained payload as its contract record, strictly or as a passive read does. */
const reading =
  (options: KnowledgeRecordsOptions) =>
  <T>(
    schema: z.ZodType<T>,
    payload: string,
    what: string,
    record: KnowledgeRecordKind,
    recordId: string
  ): T | null => {
    const refuse = (message: string): null => {
      if (options.unreadable === undefined) integrity(message);
      options.unreadable.push({ record, record_id: recordId });
      return null;
    };
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return refuse(
        `A retained ${what} holds no readable JSON; preserve history for explicit repair`
      );
    }
    const parsed = schema.safeParse(value);
    return parsed.success
      ? parsed.data
      : refuse(
          `A retained ${what} does not read as its contract record; preserve history for explicit repair`
        );
  };

type Reading = ReturnType<typeof reading>;

/** A row this very transaction wrote has no receipt yet, and is the newest thing there is. */
export const published = (table: string, columns: string) =>
  `SELECT ${columns}, coalesce(o.committed_write_sequence, ${EVERYTHING_COMMITTED}) AS write_sequence
   FROM ${table} r LEFT JOIN operations o ON o.operation_id=r.operation_id`;

interface SequencedRow {
  write_sequence: number;
}

interface RevisionRow extends SequencedRow {
  revision_id: string;
  source_standing: string | null;
  attributed_kind: string;
  attributed_to: string | null;
  attributed_basis: string | null;
  payload: string;
}

const attributionOf = (row: RevisionRow): Attribution | null => {
  if (row.attributed_kind === 'detector')
    return row.attributed_to === null ? null : { kind: 'detector', detector: row.attributed_to };
  if (row.attributed_basis === null) return null;
  return {
    kind: 'actor',
    actor: { identity: row.attributed_to, basis: row.attributed_basis as AttributionBasis },
  };
};

const REVISION_QUERY = {
  requirement: `${published(
    'requirement_revisions',
    `r.revision_id, r.source_standing, r.attributed_kind, r.attributed_to, r.attributed_basis,
     CAST(r.record_bytes AS TEXT) AS payload`
  )} WHERE r.requirement_id=?`,
  decision: `${published(
    'decision_revisions',
    `r.revision_id, r.source_standing, r.attributed_kind, r.authored_by AS attributed_to, r.attributed_basis,
     CAST(r.record_bytes AS TEXT) AS payload`
  )} WHERE r.decision_id=?`,
  claim: `${published(
    'claim_revisions',
    `r.revision_id, r.source_standing, r.attributed_kind, r.asserted_by AS attributed_to, r.attributed_basis,
     CAST(r.record_bytes AS TEXT) AS payload`
  )} WHERE r.claim_id=?`,
} as const;

function applicabilityOf(payload: string): ApplicabilitySelector | null {
  let value: unknown;
  try {
    value = JSON.parse(payload) as { applicability?: unknown };
  } catch {
    return null;
  }
  const parsed = ApplicabilitySelectorSchema.safeParse(
    (value as { applicability?: unknown }).applicability
  );
  return parsed.success ? parsed.data : null;
}

/**
 * A revision this store can state the standing and applicability of. A released row recorded
 * neither, so it is left for the resolver to report as not supplied rather than guessed at.
 */
function knowledgeRevisions(
  view: ProjectReadView,
  target: KnowledgeTarget
): PublishedRecord<KnowledgeRevision>[] {
  if (target.kind !== 'requirement' && target.kind !== 'decision' && target.kind !== 'claim')
    return [];
  return view.all<RevisionRow>(REVISION_QUERY[target.kind], target.entity_id).flatMap((row) => {
    const attributed_to = attributionOf(row);
    if (row.source_standing === null || attributed_to === null) return [];
    const applicability = applicabilityOf(row.payload);
    if (applicability === null) return [];
    return [
      {
        write_sequence: row.write_sequence,
        record: {
          revision: {
            kind: target.kind,
            entity_id: target.entity_id,
            revision_id: row.revision_id,
          } as RecordRevisionRef,
          applicability,
          source_standing: row.source_standing as SourceStanding,
          attributed_to,
        },
      },
    ];
  });
}

interface SelectionRow extends SequencedRow, ScopeRow {
  selection_id: string;
  selection_kind: string;
  target_kind: string;
  target_id: string;
  target_revision_id: string;
  actor: string | null;
  actor_basis: string;
  designation: string | null;
  authorization_json: string | null;
  authorization_id: string | null;
  expected_state_json: string | null;
}

const ADOPTION_QUERY = `${published(
  'adoptions',
  `r.adoption_id AS selection_id, 'accepted' AS selection_kind, r.target_kind, r.target_id,
   r.target_revision_id, r.approver AS actor, r.approver_basis AS actor_basis, r.scope_kind,
   r.scope_value, r.designation, r.authorization_json, r.authorization_id, o.expected_state_json`
)} WHERE r.target_kind=? AND r.target_id=?`;

const RECORDED_CHOICE_QUERY = `${published(
  'recorded_choices',
  `r.selection_id, r.selection_kind, r.target_kind, r.target_id, r.target_revision_id,
   r.selected_by AS actor, r.selected_by_basis AS actor_basis, r.scope_kind, r.scope_value,
   NULL AS designation, NULL AS authorization_json, NULL AS authorization_id, o.expected_state_json`
)} WHERE r.target_kind=? AND r.target_id=?`;

/**
 * The precondition an act observed is kept on its operation receipt rather than in the row, and
 * the resolver reads none; a row whose receipt carries no expected state observed nothing this
 * store recorded.
 */
const observedState = (row: SelectionRow): ExpectedState => {
  if (row.expected_state_json === null) return { kind: 'initial' };
  try {
    const parsed = ExpectedStateSchema.safeParse(JSON.parse(row.expected_state_json));
    return parsed.success ? parsed.data : { kind: 'initial' };
  } catch {
    return { kind: 'initial' };
  }
};

function selectionsOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  branchScoped: PublishedRecord<BranchScopedRow>[],
  read: Reading
): PublishedAct<Selection>[] {
  const rows = [
    ...view.all<SelectionRow>(ADOPTION_QUERY, target.kind, target.entity_id),
    ...view.all<SelectionRow>(RECORDED_CHOICE_QUERY, target.kind, target.entity_id),
  ];
  const selections: PublishedAct<Selection>[] = [];
  for (const row of rows) {
    const reference = {
      kind: row.target_kind,
      entity_id: row.target_id,
      revision_id: row.target_revision_id,
    } as RecordRevisionRef;
    const scope = scopeOf(row, projectId);
    if (scope === null) {
      branchScoped.push({
        write_sequence: row.write_sequence,
        record: {
          record_id: row.selection_id,
          record: 'selection',
          branch: row.scope_value ?? '',
          target: reference,
          designation: row.designation as Designation | null,
        },
      });
      continue;
    }
    // The authority an act rests on is part of the act, so a selection whose authorization cannot be
    // read is left out whole rather than reported as an act that rested on nothing.
    const authorization =
      row.authorization_json === null
        ? null
        : read(
            AuthorizationSchema,
            row.authorization_json,
            'authorization',
            'selection',
            row.selection_id
          );
    if (row.authorization_json !== null && authorization === null) continue;
    selections.push({
      write_sequence: row.write_sequence,
      authorization_id: row.authorization_id,
      record: {
        selection_id: row.selection_id,
        kind: row.selection_kind as Selection['kind'],
        target: reference,
        scope,
        designation: row.designation as Designation | null,
        selected_by: { identity: row.actor, basis: row.actor_basis as AttributionBasis },
        authorization,
        expected_state: observedState(row),
      },
    });
  }
  return selections;
}

interface RelationshipRow extends SequencedRow, ScopeRow {
  relationship_id: string;
  relation: string;
  from_entity_kind: string;
  from_entity_id: string;
  from_revision_id: string;
  to_entity_kind: string;
  to_entity_id: string;
  to_revision_id: string;
  attributed_kind: string;
  attributed_to: string | null;
  attributed_basis: string | null;
  standing: string;
  explanation: string | null;
  authorization_json: string | null;
  authorization_id: string | null;
}

const RELATIONSHIP_QUERY = `${published(
  'record_relationships',
  `r.relationship_id, r.relation, r.from_entity_kind, r.from_entity_id, r.from_revision_id,
   r.to_entity_kind, r.to_entity_id, r.to_revision_id, r.scope_kind, r.scope_value,
   r.attributed_kind, r.attributed_to, r.attributed_basis, r.standing, r.explanation,
   r.authorization_json, r.authorization_id`
)} WHERE r.relation<>'supersedes'
     AND ((? AND r.relationship_id=?) OR (r.from_entity_kind=? AND r.from_entity_id=?)
       OR (r.to_entity_kind=? AND r.to_entity_id=?))`;

const DIRECT_SUPERSEDES_QUERY = `${published(
  'record_relationships',
  `r.relationship_id, r.relation, r.from_entity_kind, r.from_entity_id, r.from_revision_id,
   r.to_entity_kind, r.to_entity_id, r.to_revision_id, r.scope_kind, r.scope_value,
   r.attributed_kind, r.attributed_to, r.attributed_basis, r.standing, r.explanation,
   r.authorization_json, r.authorization_id`
)} WHERE r.relation='supersedes'
     AND ((? AND r.relationship_id=?) OR (r.from_entity_kind=? AND r.from_entity_id=?)
       OR (r.to_entity_kind=? AND r.to_entity_id=?))
     AND (r.standing<>'established'
       OR coalesce(o.committed_write_sequence, ${EVERYTHING_COMMITTED})>?
       OR NOT (r.scope_kind='project' OR (r.scope_kind=? AND r.scope_value IS ?)))
   ORDER BY r.relationship_id`;

const REPLACEMENT_GRAPH_QUERY = `${published(
  'record_relationships',
  `r.relationship_id, r.relation, r.from_entity_kind, r.from_entity_id, r.from_revision_id,
   r.to_entity_kind, r.to_entity_id, r.to_revision_id, r.scope_kind, r.scope_value,
   r.attributed_kind, r.attributed_to, r.attributed_basis, r.standing, r.explanation,
   r.authorization_json, r.authorization_id`
)} WHERE r.relation='supersedes'
     AND r.standing='established'
     AND ((? AND r.relationship_id=?) OR (r.from_entity_kind=? AND r.from_entity_id=?)
       OR (r.to_entity_kind=? AND r.to_entity_id=?))
     AND coalesce(o.committed_write_sequence, ${EVERYTHING_COMMITTED})<=?
     AND (r.scope_kind='project' OR (r.scope_kind=? AND r.scope_value IS ?))
   ORDER BY r.relationship_id LIMIT ?`;

/**
 * The resolver reads a relationship's relation, endpoints, scope, standing and attribution; its
 * explanation and sources are not among them, and a released row records no explanation at all.
 * 'author' is the released word for an actor.
 */
function relationshipsOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  branchScoped: PublishedRecord<BranchScopedRow>[],
  read: Reading
): PublishedAct<Relationship>[] {
  const rows = view.all<RelationshipRow>(
    RELATIONSHIP_QUERY,
    Number(target.kind === 'relationship'),
    target.entity_id,
    target.kind,
    target.entity_id,
    target.kind,
    target.entity_id
  );
  return relationshipsFromRows(rows, projectId, branchScoped, read);
}

function relationshipsFromRows(
  rows: readonly RelationshipRow[],
  projectId: string,
  branchScoped: PublishedRecord<BranchScopedRow>[],
  read: Reading
): PublishedAct<Relationship>[] {
  const relationships: PublishedAct<Relationship>[] = [];
  for (const row of rows) {
    const to = {
      kind: row.to_entity_kind,
      entity_id: row.to_entity_id,
      revision_id: row.to_revision_id,
    } as RecordRevisionRef;
    const scope = scopeOf(row, projectId);
    if (scope === null) {
      branchScoped.push({
        write_sequence: row.write_sequence,
        record: {
          record_id: row.relationship_id,
          record: 'relationship',
          branch: row.scope_value ?? '',
          target: to,
          designation: null,
        },
      });
      continue;
    }
    const authorization =
      row.authorization_json === null
        ? null
        : read(
            AuthorizationSchema,
            row.authorization_json,
            'authorization',
            'relationship',
            row.relationship_id
          );
    if (row.authorization_json !== null && authorization === null) continue;
    relationships.push({
      write_sequence: row.write_sequence,
      authorization_id: row.authorization_id,
      record: {
        relationship_id: row.relationship_id,
        relation: row.relation as Relationship['relation'],
        from: {
          kind: row.from_entity_kind,
          entity_id: row.from_entity_id,
          revision_id: row.from_revision_id,
        } as RecordRevisionRef,
        to,
        scope,
        standing: row.standing as Relationship['standing'],
        attributed_to:
          row.attributed_kind === 'detector'
            ? { kind: 'detector', detector: row.attributed_to ?? '' }
            : {
                kind: 'actor',
                actor: {
                  identity: row.attributed_to,
                  basis: (row.attributed_basis ?? 'unknown') as AttributionBasis,
                },
              },
        authorization,
        source_ids: [],
        explanation: row.explanation ?? '',
      },
    });
  }
  return relationships;
}

const MAX_REPLACEMENT_GRAPH_EDGES = 10_000;

/**
 * Incident replacements outside the active graph remain presentation facts. Keeping them apart
 * lets historical and other-scope reads name those rows without letting them spend the traversal
 * bound; active established rows enter only through the bounded closure below.
 */
function directSupersedesOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  request: KnowledgeReadRequest,
  branchScoped: PublishedRecord<BranchScopedRow>[],
  read: Reading
): PublishedAct<Relationship>[] {
  const [scopeKind, scopeValue] = scopeColumns(request.scope);
  const rows = view.all<RelationshipRow>(
    DIRECT_SUPERSEDES_QUERY,
    Number(target.kind === 'relationship'),
    target.entity_id,
    target.kind,
    target.entity_id,
    target.kind,
    target.entity_id,
    request.knowledge_boundary,
    scopeKind,
    scopeValue
  );
  return relationshipsFromRows(rows, projectId, branchScoped, read);
}

function replacementRelationshipsOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  request: KnowledgeReadRequest,
  read: Reading
): PublishedAct<Relationship>[] {
  const [scopeKind, scopeValue] = scopeColumns(request.scope);
  const rows = view.all<RelationshipRow>(
    REPLACEMENT_GRAPH_QUERY,
    Number(target.kind === 'relationship'),
    target.entity_id,
    target.kind,
    target.entity_id,
    target.kind,
    target.entity_id,
    request.knowledge_boundary,
    scopeKind,
    scopeValue,
    MAX_REPLACEMENT_GRAPH_EDGES + 1
  );
  return relationshipsFromRows(rows, projectId, [], read);
}

function replacementGraphOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  request: KnowledgeReadRequest,
  read: Reading
): { relationships: PublishedAct<Relationship>[]; complete: boolean } {
  const relationships = new Map<string, PublishedAct<Relationship>>();
  const pending = [target];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop() as KnowledgeTarget;
    const key = `${current.kind}:${current.entity_id}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const entry of replacementRelationshipsOf(view, current, projectId, request, read)) {
      const relationship = entry.record;
      if (relationships.has(relationship.relationship_id)) continue;
      if (relationships.size === MAX_REPLACEMENT_GRAPH_EDGES)
        return { relationships: [...relationships.values()], complete: false };
      relationships.set(relationship.relationship_id, entry);
      for (const endpoint of [relationship.from, relationship.to])
        pending.push({ kind: endpoint.kind, entity_id: endpoint.entity_id });
    }
  }
  return { relationships: [...relationships.values()], complete: true };
}

interface PayloadRow extends SequencedRow {
  payload: string;
}

interface CorrectionRow extends PayloadRow {
  action_id: string;
  authorization_id: string | null;
}

const payloadQuery = (table: string, where: string, columns = '') =>
  `${published(table, `CAST(r.record_bytes AS TEXT) AS payload${columns}`)} WHERE ${where}`;

const CORRECTIONS_BY_TARGET = payloadQuery(
  'correction_actions',
  `r.action_id IN (SELECT t.action_id FROM correction_targets t WHERE t.target_kind=? AND t.target_id=?)
     OR (r.adopted_kind=? AND r.adopted_id=?)`,
  ', r.action_id, r.authorization_id'
);

const correctionsByRelationshipsQuery = (count: number) =>
  payloadQuery(
    'correction_actions',
    `r.action_id IN (SELECT t.action_id FROM correction_targets t
       WHERE t.target_kind='relationship' AND t.target_id IN (${Array.from(
         { length: count },
         () => '?'
       ).join(',')}))`,
    ', r.action_id, r.authorization_id'
  );

const CORRECTION_BY_ID = payloadQuery(
  'correction_actions',
  'r.action_id=?',
  ', r.action_id, r.authorization_id'
);

/**
 * Every correction that names a revision of this identity, makes one stand, or names a relationship
 * this read loaded, with the chain each follows: a reversal or an acceptance is never judged without
 * the action it follows, and the contract bounds how far that chain runs.
 *
 * The relationships matter because withdrawing an established replacement is how the revision it
 * points at comes back, and that act names neither endpoint. Without them the read would apply a
 * replacement nobody had withdrawn.
 */
function correctionsOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  relationshipIds: readonly string[],
  read: Reading
): PublishedAct<CorrectionAction>[] {
  const found = new Map<string, PublishedAct<CorrectionAction>>();
  /** The action this one follows, once it is loaded. */
  const add = (row: CorrectionRow): string | null => {
    const action = read(
      CorrectionActionSchema,
      row.payload,
      'correction action',
      'correction',
      row.action_id
    );
    if (action === null) return null;
    if (!found.has(action.action_id))
      found.set(action.action_id, {
        write_sequence: row.write_sequence,
        authorization_id: row.authorization_id,
        record: action,
      });
    if (action.kind === 'reversal') return action.reverses_action_id;
    return action.kind === 'acceptance' ? action.accepts_action_id : null;
  };
  // Each chain is bounded on its own: a budget shared across every correction on one identity
  // would leave the last chains' followed actions unloaded, and the resolver would report them as
  // not supplied rather than judge them.
  const follow = (start: string | null) => {
    let next = start;
    for (let link = 0; next !== null && link < MAX_FOLLOWED_CHAIN; link += 1) {
      if (found.has(next)) return;
      const row = view.get<CorrectionRow>(CORRECTION_BY_ID, next);
      if (row === null) return;
      next = add(row);
    }
  };
  for (const row of view.all<CorrectionRow>(
    CORRECTIONS_BY_TARGET,
    target.kind,
    target.entity_id,
    target.kind,
    target.entity_id
  ))
    follow(add(row));
  for (let offset = 0; offset < relationshipIds.length; offset += 500) {
    const ids = relationshipIds.slice(offset, offset + 500);
    for (const row of view.all<CorrectionRow>(correctionsByRelationshipsQuery(ids.length), ...ids))
      follow(add(row));
  }
  return [...found.values()];
}

const EXCEPTIONS_QUERY = payloadQuery(
  'knowledge_exceptions',
  'r.expectation_kind=? AND r.expectation_id=?',
  ', r.exception_id'
);
// The contract picks the latest answer, and of two at one instant the refusal; two authorized ones
// at one instant leave both its keys equal, so the row order decides and is made the last key.
const ANSWERS_QUERY = `${payloadQuery(
  'conflict_answers',
  'r.rule_kind=? AND r.rule_id=?',
  ', r.answer_id'
)} ORDER BY r.answer_id`;

// Every assignment whose inherited or delegated footprint names this identity, found on the member
// index rather than by reading every assignment's payload.
const ASSIGNMENTS_BY_MEMBER = `${payloadQuery(
  'assignments',
  `r.assignment_id IN (SELECT m.assignment_id FROM assignment_members m
     WHERE m.member_kind=? AND m.member_id=?)`,
  ', r.assignment_id'
)} ORDER BY r.assignment_id`;

/**
 * Whether every rule an assignment rests on still stands, judged under the same read the assignment
 * is being reported in. Both halves count: an obligation it inherits and a rule it delegates a
 * departure from are each a rule leave was given about, and leave about a rule is not leave about
 * what replaced it.
 */
export function assignmentBasisStands(
  view: ProjectReadView,
  projectId: string,
  assignment: Assignment,
  request: KnowledgeReadRequest
): boolean {
  return [
    ...assignment.inherited,
    ...assignment.delegated.departs_from.map((departure) => departure.rule),
  ].every((rule) =>
    revisionStandsInRead(view, projectId, rule, { ...request, scope: assignment.scope })
  );
}

function assignmentsOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  request: KnowledgeReadRequest,
  read: Reading
): PublishedRecord<KnowledgeAssignment>[] {
  return view
    .all<
      PayloadRow & { assignment_id: string }
    >(ASSIGNMENTS_BY_MEMBER, target.kind, target.entity_id)
    .flatMap((row) => {
      const assignment = read(
        AssignmentSchema,
        row.payload,
        'assignment',
        'assignment',
        row.assignment_id
      );
      return assignment === null
        ? []
        : [
            {
              write_sequence: row.write_sequence,
              record: {
                assignment,
                basis_stands: assignmentBasisStands(view, projectId, assignment, request),
              },
            },
          ];
    });
}

type RevokedIds = readonly (readonly [kind: string, ids: readonly string[]])[];

/** The revocation index leads with the kind, so each group of ids is asked for under its own. */
const revocationsQuery = (groups: RevokedIds) =>
  payloadQuery(
    'knowledge_revocations',
    groups
      .map(([, ids]) => `(r.revoked_kind=? AND r.revoked_id IN (${ids.map(() => '?').join(',')}))`)
      .join(' OR '),
    ', r.revocation_id'
  );

const revocationsFor = (view: ProjectReadView, groups: RevokedIds, read: Reading) => {
  const asked = groups.filter(([, ids]) => ids.length > 0);
  if (asked.length === 0) return [];
  return view
    .all<
      PayloadRow & { revocation_id: string }
    >(revocationsQuery(asked), ...asked.flatMap(([kind, ids]) => [kind, ...ids]))
    .flatMap((row) => {
      const record = read(
        RevocationSchema,
        row.payload,
        'revocation',
        'revocation',
        row.revocation_id
      );
      return record === null ? [] : [{ write_sequence: row.write_sequence, record }];
    });
};

/**
 * Everything the store holds about one target identity, as the resolver's input. A writer takes it
 * strictly; a passive read supplies `unreadable` and gets the records it could read, with the rows
 * it could not named there.
 */
export function knowledgeRecordsOf(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  request: KnowledgeReadRequest,
  options: KnowledgeRecordsOptions = {}
): KnowledgeRecords {
  const read = reading(options);
  const branch_scoped_rows: PublishedRecord<BranchScopedRow>[] = [];
  const selections = selectionsOf(view, target, projectId, branch_scoped_rows, read);
  const directRelationships = relationshipsOf(view, target, projectId, branch_scoped_rows, read);
  const directSupersedes = directSupersedesOf(
    view,
    target,
    projectId,
    request,
    branch_scoped_rows,
    read
  );
  const replacementGraph = replacementGraphOf(view, target, projectId, request, read);
  const relationships = [
    ...new Map(
      [...directRelationships, ...directSupersedes, ...replacementGraph.relationships].map(
        (entry) => [entry.record.relationship_id, entry]
      )
    ).values(),
  ];
  const expectation = target.kind === 'requirement' || target.kind === 'decision';
  const exceptions = expectation
    ? view
        .all<PayloadRow & { exception_id: string }>(EXCEPTIONS_QUERY, target.kind, target.entity_id)
        .flatMap((row) => {
          const record = read(
            ExceptionSchema,
            row.payload,
            'exception',
            'exception',
            row.exception_id
          );
          return record === null ? [] : [{ write_sequence: row.write_sequence, record }];
        })
    : [];
  const conflict_answers = expectation
    ? view
        .all<PayloadRow & { answer_id: string }>(ANSWERS_QUERY, target.kind, target.entity_id)
        .flatMap((row) => {
          const record = read(
            ConflictAnswerSchema,
            row.payload,
            'conflict answer',
            'conflict_answer',
            row.answer_id
          );
          return record === null ? [] : [{ write_sequence: row.write_sequence, record }];
        })
    : [];
  const unique = (ids: readonly string[]) => [...new Set(ids)];
  const assignments =
    options.assignments === undefined
      ? []
      : assignmentsOf(view, target, projectId, options.assignments, read);
  const corrections = correctionsOf(
    view,
    target,
    unique(relationships.map((entry) => entry.record.relationship_id)),
    read
  );
  // Both halves of "what an act cited and what was recorded for it are two facts": the
  // authorization each act recorded for itself, and the earlier one a selection reuses.
  const authorizations = [
    ...[...selections, ...relationships, ...corrections].flatMap((entry) =>
      entry.authorization_id === null ? [] : [entry.authorization_id]
    ),
    ...selections.flatMap((entry) =>
      entry.record.authorization?.kind === 'reused_authorization'
        ? [entry.record.authorization.authorization_id]
        : []
    ),
  ];
  const revocations = revocationsFor(
    view,
    [
      ['exception', unique(exceptions.map((entry) => entry.record.exception_id))],
      ['conflict_answer', unique(conflict_answers.map((entry) => entry.record.answer_id))],
      ['authorization', unique(authorizations)],
      ['assignment', unique(assignments.map((entry) => entry.record.assignment.assignment_id))],
    ],
    read
  );
  return {
    target,
    replacement_graph_complete: replacementGraph.complete,
    revisions: knowledgeRevisions(view, target),
    selections,
    corrections,
    relationships,
    exceptions,
    revocations,
    conflict_answers,
    assignments,
    branch_scoped_rows,
  };
}

/**
 * What a mutation observes. A selected implementation, an exception's end and a knowledge boundary
 * change nothing in the governing state, so the read that judges an act names none of them and
 * sees everything committed.
 */
export const mutationRequest = (
  scope: AuthorityScope,
  work: ApplicabilityInputs
): KnowledgeReadRequest => ({
  scope,
  mode: 'current',
  knowledge_boundary: EVERYTHING_COMMITTED,
  implementation: { kind: 'none_selected' },
  applicability: work,
  exceptions_judged_at: null,
  exception_conditions: {},
});

export function resolveProjectKnowledge(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  scope: AuthorityScope,
  work: ApplicabilityInputs
): ResolvedKnowledge {
  const request = mutationRequest(scope, work);
  return resolveKnowledge(knowledgeRecordsOf(view, target, projectId, request), request);
}

/**
 * What an identity's records say now, and what they would say with the correction this transaction
 * is about to append. A row this transaction wrote is the newest thing there is, and a row it has
 * not written yet is read the same way, which is how a writer records what its own act changed in
 * the row that act writes.
 */
export function resolveWithPendingCorrection(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  scope: AuthorityScope,
  work: ApplicabilityInputs,
  pending: readonly CorrectionAction[]
): { before: ResolvedKnowledge; after: ResolvedKnowledge } {
  const request = mutationRequest(scope, work);
  const records = knowledgeRecordsOf(view, target, projectId, request);
  const held = new Set(records.corrections.map((entry) => entry.record.action_id));
  const corrections = [
    ...records.corrections,
    ...pending
      .filter((action) => !held.has(action.action_id))
      .map((record) => ({
        write_sequence: EVERYTHING_COMMITTED,
        authorization_id: null,
        record,
      })),
  ];
  return {
    before: resolveKnowledge(records, request),
    after: resolveKnowledge({ ...records, corrections }, request),
  };
}

/**
 * How a relationship stands where an act in this scope can see it, corrections included: an
 * established one a withdrawal named no longer stands, and one a reversal put back does again.
 * `null` is a relationship this read does not hold at all.
 */
export function relationshipStanding(
  view: ProjectReadView,
  projectId: string,
  relationshipId: string,
  scope: AuthorityScope,
  work: ApplicabilityInputs
): RelationshipStanding['standing'] | null {
  const resolved = resolveProjectKnowledge(
    view,
    { kind: 'relationship', entity_id: relationshipId },
    projectId,
    scope,
    work
  );
  const entry = resolved.relationships.find(
    (candidate) => candidate.relationship_id === relationshipId
  );
  return entry === undefined ? null : entry.standing;
}

/**
 * Whether a revision still stands under one read. The read carries its own boundary, so an
 * assignment's basis is judged at the boundary the answer is about and not at the committed
 * sequence, which is what makes a read at an earlier boundary an answer about then.
 */
export function revisionStandsInRead(
  view: ProjectReadView,
  projectId: string,
  revision: RecordRevisionRef,
  request: KnowledgeReadRequest
): boolean {
  const resolved = resolveKnowledge(
    knowledgeRecordsOf(
      view,
      { kind: revision.kind, entity_id: revision.entity_id },
      projectId,
      request
    ),
    request
  );
  return resolved.revisions.some(
    (entry) => entry.standing === 'stands' && entry.revision.revision_id === revision.revision_id
  );
}

/** Whether a revision still stands where an act in the given scope can see it. */
export function revisionStands(
  view: ProjectReadView,
  projectId: string,
  revision: RecordRevisionRef,
  scope: AuthorityScope,
  work: ApplicabilityInputs
): boolean {
  return revisionStandsInRead(view, projectId, revision, mutationRequest(scope, work));
}

/**
 * The revisions of one identity that stand as adopted where they reach the act's own scope.
 * Adopting beside one of them creates a governing conflict the authorization has to acknowledge —
 * a project rule reaches every artifact, so an act at one artifact stands beside it and departs
 * from it there. An adopted revision and a background one are compatible, so a background
 * designation stands beside nothing.
 */
export function adoptedBeside(
  resolved: ResolvedKnowledge,
  target: RecordRevisionRef,
  scope: AuthorityScope,
  designation: Designation | null
): ExpectationRevisionRef[] {
  if (designation !== 'adopted') return [];
  const beside = new Map<string, ExpectationRevisionRef>();
  for (const entry of resolved.revisions) {
    if (entry.standing !== 'stands' || entry.designation !== 'adopted') continue;
    if (entry.scope === null || !scopeReaches(entry.scope, scope)) continue;
    const { revision } = entry;
    if (revision.revision_id === target.revision_id) continue;
    if (revision.kind !== 'requirement' && revision.kind !== 'decision') continue;
    beside.set(revision.revision_id, {
      kind: revision.kind,
      entity_id: revision.entity_id,
      revision_id: revision.revision_id,
    });
  }
  return [...beside.values()];
}

/**
 * An act that makes a revision stand while an established replacement points at it, refused by the
 * name of the relationship to withdraw. Resolution decision 10: the replacement is state, so it
 * replaces the revision for as long as it stands, and no act of this build both withdraws it and
 * adopts what it points at — a correction that names a relationship adopts no revision of its own.
 */
export function refuseAdoptingReplaced(
  resolved: ResolvedKnowledge,
  target: RecordRevisionRef
): void {
  const replacement = replacedBy(resolved, target);
  if (replacement !== null)
    invalid(
      `Relationship ${replacement} replaces this revision; withdraw that replacement before adopting it again`
    );
}

/** An established replacement that points at a revision and still stands in a reaching scope. */
export function replacedBy(resolved: ResolvedKnowledge, target: RecordRevisionRef): string | null {
  const replacement = resolved.relationships.find(
    (entry) =>
      entry.applied &&
      entry.relation === 'supersedes' &&
      entry.standing === 'established' &&
      entry.to.entity_id === target.entity_id &&
      entry.to.revision_id === target.revision_id
  );
  return replacement === undefined ? null : replacement.relationship_id;
}

/**
 * A stale mutation fails atomically and carries the state that governs now, so a caller reads what
 * moved and decides again instead of overwriting a newer selection.
 */
export class StaleKnowledgeState extends ProjectDatabaseError {
  constructor(readonly current: GoverningState) {
    super(
      'STALE_CONTEXT',
      'What governs this target moved since the state this act observed; read the current state and decide again'
    );
  }
}

export function requireExpectedState(expected: ExpectedState, current: GoverningState): void {
  const outcome = checkExpectedState(expected, current);
  if (!outcome.ok) throw new StaleKnowledgeState(outcome.current);
}
