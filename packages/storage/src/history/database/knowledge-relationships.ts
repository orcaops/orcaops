// Publishing a typed relationship: a replacement, a challenge, a dependency or a motivation
// between two exact revisions.
//
// Background processing may suggest one and nothing more, so an established relationship names an
// actor. Only an established replacement of a requirement or a decision changes what stands, so
// only it carries an authority to judge — an informed instruction, which the act also records an
// authorization for. A replacement that would close a cycle is refused against what the store
// still reports as standing, while imported cyclic history stays readable.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import {
  authorizationContext,
  parseWorkContext,
  requireAuthority,
  requireAuthorizationReferences,
  requireRetainedRevisions,
  requireStoreScope,
} from './knowledge-authority.js';
import {
  type ActAuthorization,
  prepareActAuthorization,
  recordsItsOwnAuthorization,
  settleActAuthorization,
} from './knowledge-authorizations.js';
import {
  actingField,
  type AuthoredRecord,
  authoredRecord,
  invalid,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  replayOperation,
  requireRetainedSources,
  retriedOperation,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import {
  relationshipStanding,
  resolveProjectKnowledge,
  scopeColumns,
  scopeReaches,
} from './knowledge-standing.js';
import { type ProjectOperation, runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type ApplicabilityInputs,
  type Attribution,
  type AuthorityScope,
  introducesReplacementCycle,
  type RecordRevisionRef,
  type Relationship,
  relationshipFootprint,
  RelationshipSchema,
} from '../../schema/knowledge-contract.js';

export interface PublishRelationship {
  readonly operationId: string;
  /** The relationship as authored, without `attributed_to`. */
  readonly relationship: unknown;
  /** Who suggested or established it, which a publishing session will own once storage has one. */
  readonly attributedTo: Attribution;
  /** When it was published, for the authorization an established replacement records for itself. */
  readonly recordedAt?: string;
  /** The work this act is done for, carried into the authorization recorded for it. */
  readonly work?: unknown;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type RelationshipPublication = {
  relationshipId: string;
  standing: Relationship['standing'];
  recordSha256: string;
  /** The authorization written for this act, when it was published on an embedded instruction. */
  authorizationId: string | null;
};

interface PreparedRelationship {
  readonly relationship: Relationship;
  readonly record: AuthoredRecord;
  readonly work: ApplicabilityInputs;
  readonly authorization: ActAuthorization | null;
}

function refuseTakenRelationshipId(view: ProjectReadView, relationshipId: string): void {
  if (
    view.get(
      'SELECT relationship_id FROM record_relationships WHERE relationship_id=?',
      relationshipId
    )
  )
    taken('That relationship ID already belongs to retained history');
}

interface EdgeRow {
  relationship_id: string;
  from_entity_kind: string;
  from_entity_id: string;
  from_revision_id: string;
  to_entity_kind: string;
  to_entity_id: string;
  to_revision_id: string;
  scope_kind: string;
  scope_value: string | null;
}

const ESTABLISHED_REPLACEMENTS = `SELECT relationship_id, from_entity_kind, from_entity_id, from_revision_id,
    to_entity_kind, to_entity_id, to_revision_id, scope_kind, scope_value
  FROM record_relationships WHERE relation='supersedes' AND standing='established'`;

const IDENTICAL_RELATIONSHIP = `SELECT relationship_id FROM record_relationships
  WHERE relation=? AND from_entity_kind=? AND from_entity_id=? AND from_revision_id=?
    AND to_entity_kind=? AND to_entity_id=? AND to_revision_id=?
    AND scope_kind=? AND scope_value IS ? AND standing=?`;

const endpointsOf = (row: EdgeRow) => ({
  relation: 'supersedes' as const,
  relationship_id: row.relationship_id,
  from: {
    kind: row.from_entity_kind,
    entity_id: row.from_entity_id,
    revision_id: row.from_revision_id,
  } as RecordRevisionRef,
  to: {
    kind: row.to_entity_kind,
    entity_id: row.to_entity_id,
    revision_id: row.to_revision_id,
  } as RecordRevisionRef,
});

/** A branch grants no authority, so a row scoped to one is no edge of any act's graph. */
const rowScope = (row: EdgeRow, projectId: string): AuthorityScope | null => {
  if (row.scope_kind === 'project') return { kind: 'project', project_id: projectId };
  if (row.scope_kind === 'artifact' && row.scope_value !== null)
    return { kind: 'artifact', artifact_id: row.scope_value };
  return null;
};

/**
 * A new replacement that would end up replacing itself. The rows are read first, because most acts
 * close no loop and the read is one indexed pass; only when the stored edges do form one is each
 * relationship's standing resolved, so a replacement a correction withdrew stops being an edge and
 * imported cyclic history still refuses nothing but a new cycle.
 */
function refuseReplacementCycle(
  view: ProjectReadView,
  prepared: PreparedRelationship,
  projectId: string
): void {
  const { relationship, work } = prepared;
  if (relationship.relation !== 'supersedes') return;
  const held = view.all<EdgeRow>(ESTABLISHED_REPLACEMENTS).flatMap((row) => {
    const scope = rowScope(row, projectId);
    if (scope === null) return [];
    return [{ scope, edge: endpointsOf(row) }];
  });
  const scopes =
    relationship.scope.kind === 'artifact'
      ? [relationship.scope]
      : [
          relationship.scope,
          ...[
            ...new Set(
              view
                .all<{ artifact_id: string }>(
                  `SELECT scope_value AS artifact_id FROM record_relationships
                   WHERE scope_kind='artifact'
                   UNION
                   SELECT scope_value AS artifact_id FROM correction_actions
                   WHERE scope_kind='artifact'`
                )
                .map((row) => row.artifact_id)
            ),
          ]
            .sort()
            .map((artifact_id) => ({ kind: 'artifact' as const, artifact_id })),
        ];
  for (const effectiveScope of scopes) {
    const visible = held.filter((entry) => scopeReaches(entry.scope, effectiveScope));
    if (
      !introducesReplacementCycle(
        visible.map((entry) => entry.edge),
        relationship
      )
    )
      continue;
    const resolved = resolveProjectKnowledge(
      view,
      { kind: relationship.from.kind, entity_id: relationship.from.entity_id },
      projectId,
      effectiveScope,
      work
    );
    if (resolved.unresolved.some((point) => point.reason === 'replacement_graph_incomplete'))
      invalid('The replacement graph is too large to prove this relationship stays acyclic');
    const standing = resolved.relationships
      .filter((entry) => entry.relation === 'supersedes' && entry.standing === 'established')
      .map((entry) => ({
        relation: entry.relation,
        relationship_id: entry.relationship_id,
        from: entry.from,
        to: entry.to,
      }));
    if (introducesReplacementCycle(standing, relationship))
      invalid(
        'This replacement would make a revision replace itself; withdraw a replacement on that path first'
      );
  }
}

/**
 * A new row identical to one that still stands: the same relation between the same endpoints, in
 * the same scope, with the same standing. One a correction withdrew is not one of these, so the
 * same relationship may be established again after a withdrawal, and an actor may establish what a
 * detector only suggested.
 */
function refuseRelationshipThatStillStands(
  view: ProjectReadView,
  prepared: PreparedRelationship,
  projectId: string
): void {
  const { relationship, work } = prepared;
  const [scopeKind, scopeValue] = scopeColumns(relationship.scope);
  const identical = view
    .all<{
      relationship_id: string;
    }>(
      IDENTICAL_RELATIONSHIP,
      relationship.relation,
      relationship.from.kind,
      relationship.from.entity_id,
      relationship.from.revision_id,
      relationship.to.kind,
      relationship.to.entity_id,
      relationship.to.revision_id,
      scopeKind,
      scopeValue,
      relationship.standing
    )
    .some(
      (row) =>
        relationshipStanding(view, projectId, row.relationship_id, relationship.scope, work) ===
        relationship.standing
    );
  if (identical) taken('This relationship already stands between these revisions in this scope');
}

/** Everything the store decides about a relationship, before the operation and again inside it. */
export function checkProjectRelationship(
  view: ProjectReadView,
  prepared: PreparedRelationship,
  projectId: string
): void {
  const { relationship, work } = prepared;
  refuseTakenRelationshipId(view, relationship.relationship_id);
  requireRetainedRevisions(view, [relationship.from, relationship.to], 'A relationship');
  requireRetainedSources(view, relationship.source_ids);
  if (relationship.authorization !== null)
    requireAuthorizationReferences(view, relationship.authorization, 'A relationship');
  refuseRelationshipThatStillStands(view, prepared, projectId);
  refuseReplacementCycle(view, prepared, projectId);
  // Only an established replacement of a requirement or a decision changes what stands, and the
  // record schema holds one to an informed instruction; everything else has no footprint to judge.
  if (relationship.authorization === null) return;
  requireAuthority({
    authorization: relationship.authorization,
    scope: relationship.scope,
    footprint: relationshipFootprint(relationship),
    acting: relationship.attributed_to,
    context: authorizationContext(view, projectId, relationship.authorization, work),
  });
}

/** 'author' is the released word for an actor, and a detector carries a name without a basis. */
const relationshipAttribution = (
  attribution: Attribution
): [kind: string, name: string | null, basis: string | null] =>
  attribution.kind === 'detector'
    ? ['detector', attribution.detector, null]
    : ['author', attribution.actor.identity, attribution.actor.basis];

export function settleProjectRelationship(
  transaction: ProjectSettlement,
  operation: Readonly<ProjectOperation>,
  prepared: PreparedRelationship,
  projectId: string
): RelationshipPublication {
  checkProjectRelationship(transaction, prepared, projectId);
  const { relationship, record } = prepared;
  const [scopeKind, scopeValue] = scopeColumns(relationship.scope);
  const [attributedKind, attributedTo, basis] = relationshipAttribution(relationship.attributed_to);
  // The authorization recorded for the act is written first, because the row that names it carries
  // an immediate reference to it.
  const authorizationId = settleActAuthorization(
    transaction,
    operation.operationId,
    prepared.authorization,
    { authorization: relationship.authorization, footprint: relationshipFootprint(relationship) }
  );
  // The table keeps no second copy of the payload, so the columns carry the authored relationship
  // and the operation receipt carries the hash of the whole of it.
  transaction.run(
    `INSERT INTO record_relationships (relationship_id, relation, from_entity_kind, from_entity_id,
       from_revision_id, to_entity_kind, to_entity_id, to_revision_id, scope_kind, scope_value,
       attributed_kind, attributed_to, attributed_basis, standing, explanation, source_refs_json,
       authorization_json, authorization_id, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    relationship.relationship_id,
    relationship.relation,
    relationship.from.kind,
    relationship.from.entity_id,
    relationship.from.revision_id,
    relationship.to.kind,
    relationship.to.entity_id,
    relationship.to.revision_id,
    scopeKind,
    scopeValue,
    attributedKind,
    attributedTo,
    basis,
    relationship.standing,
    relationship.explanation,
    canonicalJson([...relationship.source_ids]),
    relationship.authorization === null ? null : canonicalJson(relationship.authorization),
    authorizationId,
    operation.operationId
  );
  return {
    relationshipId: relationship.relationship_id,
    standing: relationship.standing,
    recordSha256: record.sha256,
    authorizationId,
  };
}

export function prepareProjectRelationship(
  input: Omit<PublishRelationship, 'operationId'>,
  projectId: string
): PreparedRelationship {
  const relationship = parsed(
    RelationshipSchema,
    actingField(input.relationship, 'attributed_to', input.attributedTo),
    'A relationship'
  );
  requireStoreScope(projectId, relationship.scope);
  if (input.recordedAt !== undefined && !recordsItsOwnAuthorization(relationship.authorization))
    invalid(
      'An act published on anything but an embedded instruction records no authorization of its own, and no time for one'
    );
  const work = parseWorkContext(input.work);
  return {
    relationship,
    record: authoredRecord(relationship, secretAllowList(input.secretAllow)),
    work,
    authorization: prepareActAuthorization({
      authorization: relationship.authorization,
      grantedBy: relationship.attributed_to,
      recordedAt: input.recordedAt,
      work,
      secretAllow: input.secretAllow,
    }),
  };
}

export async function publishProjectRelationship(
  handle: ProjectDatabase,
  input: PublishRelationship,
  options: ProjectOperationOptions = {}
) {
  const projectId = handle.authority.projectId;
  const prepared = prepareProjectRelationship(input, projectId);
  const { relationship } = prepared;
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.relationship.publish',
    target: {
      relationshipId: relationship.relationship_id,
      relation: relationship.relation,
      toRevisionId: relationship.to.revision_id,
    },
    payload: {
      record: prepared.record.sha256,
      recordedAt: prepared.authorization === null ? null : prepared.authorization.recordedAt,
      work: canonicalJson(prepared.work) ?? null,
    },
    expectedState: null,
    // A suggestion changes nothing; establishing a relationship is an authored change of intent.
    intentChange: relationship.standing === 'established',
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    checkProjectRelationship(view, prepared, projectId);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling) =>
      settleProjectRelationship(transaction, settling, prepared, projectId),
    options
  );
}

export interface ProjectRelationshipRow {
  readonly relationshipId: string;
  readonly relation: string;
  readonly from: { kind: string; entityId: string; revisionId: string };
  readonly to: { kind: string; entityId: string; revisionId: string };
  readonly scope: { kind: string; value: string | null };
  readonly standing: string;
  readonly attributedTo: { kind: string; identity: string | null; basis: string | null };
  readonly explanation: string | null;
  readonly sourceIds: readonly string[];
  readonly authorizationJson: string | null;
  readonly authorizationId: string | null;
  readonly operationId: string;
}

interface RelationshipRow extends EdgeRow {
  relation: string;
  attributed_kind: string;
  attributed_to: string | null;
  attributed_basis: string | null;
  standing: string;
  explanation: string | null;
  source_refs_json: string;
  authorization_json: string | null;
  authorization_id: string | null;
  operation_id: string;
}

const RELATIONSHIP_COLUMNS = `SELECT relationship_id, relation, from_entity_kind, from_entity_id,
    from_revision_id, to_entity_kind, to_entity_id, to_revision_id, scope_kind, scope_value,
    attributed_kind, attributed_to, attributed_basis, standing, explanation, source_refs_json,
    authorization_json, authorization_id, operation_id
  FROM record_relationships`;

const relationshipRow = (row: RelationshipRow): ProjectRelationshipRow => ({
  relationshipId: row.relationship_id,
  relation: row.relation,
  from: {
    kind: row.from_entity_kind,
    entityId: row.from_entity_id,
    revisionId: row.from_revision_id,
  },
  to: { kind: row.to_entity_kind, entityId: row.to_entity_id, revisionId: row.to_revision_id },
  scope: { kind: row.scope_kind, value: row.scope_value },
  standing: row.standing,
  attributedTo: {
    kind: row.attributed_kind,
    identity: row.attributed_to,
    basis: row.attributed_basis,
  },
  explanation: row.explanation,
  sourceIds: JSON.parse(row.source_refs_json) as readonly string[],
  authorizationJson: row.authorization_json,
  authorizationId: row.authorization_id,
  operationId: row.operation_id,
});

export function readProjectRelationship(
  view: ProjectReadView,
  relationshipId: string
): ProjectRelationshipRow | null {
  const row = view.get<RelationshipRow>(
    `${RELATIONSHIP_COLUMNS} WHERE relationship_id=?`,
    relationshipId
  );
  return row === null ? null : relationshipRow(row);
}

/** Every relationship with an endpoint of one identity, in the order they were retained. */
export function listProjectRelationships(
  view: ProjectReadView,
  endpoint: { kind: string; entityId: string }
): ProjectRelationshipRow[] {
  return view
    .all<RelationshipRow>(
      `${RELATIONSHIP_COLUMNS} WHERE (from_entity_kind=? AND from_entity_id=?)
         OR (to_entity_kind=? AND to_entity_id=?) ORDER BY rowid`,
      endpoint.kind,
      endpoint.entityId,
      endpoint.kind,
      endpoint.entityId
    )
    .map(relationshipRow);
}
