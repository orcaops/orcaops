// The store-side half of authority, shared by the acts that carry one.
//
// Authority is judged on an act's footprint, never on the records the act happens to name, and
// everything the judgment treats as store knowledge — the binding it cites, the earlier
// authorization, whether that authorization is still valid — is read inside the transaction that
// publishes the act. A dangling, narrower or differently purposed citation therefore adopts
// nothing.
import { z } from 'zod';

import { type ProjectReadView } from './connection.js';
import {
  InstantSchema,
  integrity,
  invalid,
  LabelSchema,
  missing,
  parsed,
  requireRetainedSources,
} from './knowledge-record-input.js';
import { revisionStands, scopeColumns } from './knowledge-standing.js';
import {
  type ActFootprint,
  type ApplicabilityInputs,
  ApprovalBindingSchema,
  type Assignment,
  AssignmentSchema,
  assignmentWindow,
  type Attribution,
  type AuthorityScope,
  type Authorization,
  type AuthorizationContext,
  type AuthorizationRecord,
  AuthorizationRecordSchema,
  type AuthorizationRefusal,
  checkAuthorization,
  evaluateApplicability,
  type RecordRevisionRef,
  SelectorResolutionSchema,
} from '../../schema/knowledge-contract.js';

/**
 * The work an act is done for, as the applicability inputs an earlier authorization's own context
 * is judged against. A dimension nobody supplied is unresolved, so an authorization narrowed to
 * work this act says nothing about is not reused.
 */
export const WorkContextSchema = z.strictObject({
  subject: z.array(LabelSchema).optional(),
  software_version: z.array(LabelSchema).optional(),
  environment: z.array(LabelSchema).optional(),
  work_context: z.array(LabelSchema).optional(),
  time: InstantSchema.optional(),
});

export const parseWorkContext = (value: unknown): ApplicabilityInputs =>
  parsed(WorkContextSchema, value ?? {}, 'The work this act is done for');

/** Project-wide scope is always explicit, and a store holds exactly one project. */
export function requireStoreScope(projectId: string, scope: AuthorityScope): AuthorityScope {
  if (scope.kind === 'project' && scope.project_id !== projectId)
    invalid('A project-scoped act names the project of the store that publishes it');
  return scope;
}

const REVISION_TABLE = {
  requirement: ['requirement_revisions', 'requirement_id'],
  decision: ['decision_revisions', 'decision_id'],
  claim: ['claim_revisions', 'claim_id'],
} as const;

export function retainedRecordRevision(view: ProjectReadView, ref: RecordRevisionRef): boolean {
  if (ref.kind === 'relationship')
    return !!view.get(
      'SELECT relationship_id FROM record_relationships WHERE relationship_id=?',
      ref.entity_id
    );
  const [table, column] = REVISION_TABLE[ref.kind];
  return !!view.get(
    `SELECT revision_id FROM ${table} WHERE ${column}=? AND revision_id=?`,
    ref.entity_id,
    ref.revision_id
  );
}

export function requireRetainedRevisions(
  view: ProjectReadView,
  refs: readonly RecordRevisionRef[],
  what: string
): void {
  for (const ref of refs)
    if (!retainedRecordRevision(view, ref))
      missing(`${what} names a ${ref.kind} revision this history does not hold`);
}

/** Every revision and source an embedded instruction names, so no act rests on a dangling one. */
export function requireAuthorizationReferences(
  view: ProjectReadView,
  authorization: Authorization,
  what: string
): void {
  if (
    authorization.kind !== 'informed_instruction' &&
    authorization.kind !== 'explicit_instruction'
  )
    return;
  requireRetainedSources(view, [authorization.instruction_source_id]);
  if (authorization.kind === 'informed_instruction')
    requireRetainedRevisions(view, authorization.acknowledged, `${what}'s instruction`);
}

const bindingRecord = (view: ProjectReadView, bindingId: string) => {
  const row = view.get<{ payload: string }>(
    'SELECT CAST(record_bytes AS TEXT) AS payload FROM approval_bindings WHERE binding_id=?',
    bindingId
  );
  if (row === null) return null;
  const parsedBinding = ApprovalBindingSchema.safeParse(JSON.parse(row.payload));
  if (!parsedBinding.success)
    integrity(
      'A retained approval binding does not read as its contract record; preserve history for explicit repair'
    );
  return parsedBinding.data;
};

const authorizationRecord = (view: ProjectReadView, authorizationId: string) => {
  const row = view.get<{ payload: string }>(
    'SELECT CAST(record_bytes AS TEXT) AS payload FROM knowledge_authorizations WHERE authorization_id=?',
    authorizationId
  );
  if (row === null) return null;
  const record = AuthorizationRecordSchema.safeParse(JSON.parse(row.payload));
  if (!record.success)
    integrity(
      'A retained authorization does not read as its contract record; preserve history for explicit repair'
    );
  return record.data;
};

const selectorResolutions = (view: ProjectReadView, bindingId: string) =>
  view
    .all<{ payload: string }>(
      `SELECT CAST(record_bytes AS TEXT) AS payload
       FROM selector_resolutions WHERE binding_id=? ORDER BY rowid`,
      bindingId
    )
    .map((row) => {
      const resolution = SelectorResolutionSchema.safeParse(JSON.parse(row.payload));
      if (!resolution.success)
        integrity(
          'A retained selector resolution does not read as its contract record; preserve history for explicit repair'
        );
      return resolution.data;
    });

export const assignmentRecord = (
  view: ProjectReadView,
  assignmentId: string
): Assignment | null => {
  const row = view.get<{ payload: string }>(
    'SELECT CAST(record_bytes AS TEXT) AS payload FROM assignments WHERE assignment_id=?',
    assignmentId
  );
  if (row === null) return null;
  const record = AssignmentSchema.safeParse(JSON.parse(row.payload));
  if (!record.success)
    integrity(
      'A retained assignment does not read as its contract record; preserve history for explicit repair'
    );
  return record.data;
};

/**
 * Whether a revocation that reaches this record's own scope has ended it. A narrower one ends it
 * only where that narrower scope reaches, which is what a read applies and therefore what a writer
 * has to judge: otherwise one artifact's instruction would end a project-wide record for everyone
 * while no read ever showed it ended.
 */
const revoked = (view: ProjectReadView, kind: string, id: string, at: AuthorityScope): boolean => {
  const [scopeKind, scopeValue] = scopeColumns(at);
  return !!view.get(
    `SELECT revocation_id FROM knowledge_revocations
     WHERE revoked_kind=? AND revoked_id=?
       AND (scope_kind='project' OR (scope_kind=? AND scope_value IS ?))`,
    kind,
    id,
    scopeKind,
    scopeValue
  );
};

/**
 * An authorization stops being valid once a revocation names it, or once a rule it departs from no
 * longer stands: leave to change a rule is not leave to change what replaced it.
 */
function stillValid(
  view: ProjectReadView,
  projectId: string,
  record: AuthorizationRecord,
  work: ApplicabilityInputs
): boolean {
  if (revoked(view, 'authorization', record.authorization_id, record.instruction.scope))
    return false;
  return record.departs_from.every((departure) =>
    revisionStands(view, projectId, departure.rule, record.instruction.scope, work)
  );
}

/**
 * An assignment stops being valid on exactly the two grounds an authorization does: a revocation
 * reaching its own scope names it, or a rule it rests on no longer stands. Both the obligations it
 * inherits and the rules it delegates a departure from are such rules — leave about a rule is not
 * leave about what replaced it, whichever half of the record named it.
 */
function assignmentStillValid(
  view: ProjectReadView,
  projectId: string,
  record: Assignment,
  work: ApplicabilityInputs
): boolean {
  if (revoked(view, 'assignment', record.assignment_id, record.scope)) return false;
  return [
    ...record.inherited,
    ...record.delegated.departs_from.map((departure) => departure.rule),
  ].every((rule) => revisionStands(view, projectId, rule, record.scope, work));
}

const EMPTY_CONTEXT: AuthorizationContext = { bindings: [], earlier: [], assignments: [] };

/**
 * What the act cites, read from the store. Only the cited binding, authorization or assignment is
 * loaded: an act is covered by what it names or by nothing, so no other row can decide it.
 */
export function authorizationContext(
  view: ProjectReadView,
  projectId: string,
  authorization: Authorization,
  work: ApplicabilityInputs
): AuthorizationContext {
  if (authorization.kind === 'approval_binding') {
    const binding = bindingRecord(view, authorization.binding_id);
    return {
      ...EMPTY_CONTEXT,
      bindings:
        binding === null
          ? []
          : [
              {
                ...binding,
                resolved_targets: selectorResolutions(view, binding.binding_id),
              },
            ],
    };
  }
  if (authorization.kind === 'assignment') {
    const record = assignmentRecord(view, authorization.assignment_id);
    if (record === null) return EMPTY_CONTEXT;
    return {
      ...EMPTY_CONTEXT,
      assignments: [
        {
          assignment_id: record.assignment_id,
          scope: record.scope,
          delegated: record.delegated,
          responsible: record.responsible,
          // The act's own judged time, which `before` reads exclusively and leaves unresolved when
          // the act named none: an act with no time under an assignment that ends is refused
          // rather than read as still covered.
          covers_this_work: evaluateApplicability(assignmentWindow(record.valid_until), work),
          valid: assignmentStillValid(view, projectId, record, work),
        },
      ],
    };
  }
  if (authorization.kind !== 'reused_authorization') return EMPTY_CONTEXT;
  const record = authorizationRecord(view, authorization.authorization_id);
  if (record === null) return EMPTY_CONTEXT;
  return {
    ...EMPTY_CONTEXT,
    earlier: [
      {
        authorization_id: record.authorization_id,
        adopts: record.adopts,
        departs_from: record.departs_from,
        restates: record.restates,
        scope: record.instruction.scope,
        covers_this_work:
          record.context === null ? 'applies' : evaluateApplicability(record.context, work),
        valid: stillValid(view, projectId, record, work),
      },
    ],
  };
}

/** The sources the act rests on: its own instruction, or the evidence behind what it cites. */
export function authorizationSources(
  view: ProjectReadView,
  authorization: Authorization
): string[] {
  if (
    authorization.kind === 'informed_instruction' ||
    authorization.kind === 'explicit_instruction'
  )
    return [authorization.instruction_source_id];
  if (authorization.kind === 'approval_binding') {
    const binding = bindingRecord(view, authorization.binding_id);
    return binding === null ? [] : [binding.authorization_evidence_source_id];
  }
  if (authorization.kind === 'assignment') {
    const assignment = assignmentRecord(view, authorization.assignment_id);
    return assignment === null ? [] : [assignment.source_id];
  }
  const record = authorizationRecord(view, authorization.authorization_id);
  return record === null ? [] : [record.instruction.instruction_source_id];
}

/** Exported so a replay can hold the contract's own code to the message it is refused with. */
export const AUTHORITY_REFUSAL: Record<AuthorizationRefusal, string> = {
  NOTHING_TO_AUTHORIZE: 'This act adopts nothing, departs from nothing and restates nothing',
  SCOPE_EXCEEDS_AUTHORIZATION: 'The authority this act cites was given in another scope',
  RULE_NOT_ACKNOWLEDGED:
    'This act departs from a rule its instruction never acknowledged; ask about the conflict before recording it',
  BINDING_NOT_FOUND: 'The approval binding this act cites is not retained in this history',
  BINDING_DOES_NOT_COVER_ADOPTION:
    'The approval bound another revision, scope or designation than this act adopts',
  BINDING_DOES_NOT_COVER_DEPARTURE:
    'The approver was never shown this departure in this scope; an approval to change one rule is no approval to retire another',
  BINDING_DOES_NOT_COVER_RESTATEMENT: 'An approval binding covers no restatement',
  AUTHORIZATION_NOT_FOUND: 'The authorization this act reuses is not retained in this history',
  AUTHORIZATION_NOT_VALID:
    'The authorization this act reuses was revoked, or a rule it departs from no longer stands',
  AUTHORIZATION_DOES_NOT_COVER_THIS_WORK:
    'The authorization this act reuses was given for work its context does not definitely cover',
  AUTHORIZATION_DOES_NOT_COVER_ADOPTION:
    'The authorization this act reuses was recorded for another adoption',
  AUTHORIZATION_DOES_NOT_COVER_DEPARTURE:
    'The authorization this act reuses was recorded for another departure; leave for one is never leave for another',
  AUTHORIZATION_DOES_NOT_COVER_RESTATEMENT:
    'The authorization this act reuses was recorded for another restatement',
  ASSIGNMENT_NOT_FOUND: 'The assignment this act rests on is not retained in this history',
  ASSIGNMENT_NOT_VALID:
    'The assignment this act rests on was revoked, a rule it rests on no longer stands, or its validity does not cover this act at the time the act was judged at',
  ACTOR_NOT_RESPONSIBLE:
    'This act does not claim the identity the assignment made responsible; an assignment delegates to one party and to nobody else',
  ASSIGNMENT_DOES_NOT_COVER_ADOPTION: 'The assignment delegates no such adoption',
  ASSIGNMENT_DOES_NOT_COVER_DEPARTURE:
    'The assignment delegates no such departure; leave for one is never leave for another',
  ASSIGNMENT_DOES_NOT_COVER_RESTATEMENT: 'The assignment delegates no such restatement',
};

const NOT_RETAINED: readonly AuthorizationRefusal[] = [
  'BINDING_NOT_FOUND',
  'AUTHORIZATION_NOT_FOUND',
  'ASSIGNMENT_NOT_FOUND',
];

/** The typed refusal for an authority code, wherever the judgment came from. */
export function refuseAuthority(code: AuthorizationRefusal): never {
  const message = AUTHORITY_REFUSAL[code];
  if (NOT_RETAINED.includes(code)) missing(message);
  invalid(message);
}

/** Whatever an act cites must cover its whole footprint, in the same scope, for whoever acts. */
export function requireAuthority(input: {
  authorization: Authorization;
  scope: AuthorityScope;
  footprint: ActFootprint;
  /** The act's own attribution, which only an assignment reads. */
  acting: Attribution | null;
  context: AuthorizationContext;
}): void {
  const outcome = checkAuthorization(input);
  if (!outcome.ok) refuseAuthority(outcome.code);
}
