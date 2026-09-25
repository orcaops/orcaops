// What the integration boundary reads, in one snapshot, for `authorityAtBoundary` to judge.
//
// The same seam the consequence explanation uses: storage owns the reading, core owns the
// comparison. Everything below happens inside ONE `handle.read`, so the uses a plan recorded, the
// revisions that govern now and the standing of every authority an act rests on are all observed
// at one boundary — two readings of one store is how two surfaces start refusing for different
// reasons at the same instant.
//
// Nothing here writes, opens anything for writing, starts a worker or calls a model.
import {
  type ActAuthority,
  type IntegrationAuthorityFacts,
  knowledgeContextAnswer,
  type RecordedAct,
  type RecordedActKind,
} from '@orcaops/core';
import type { AuthorityScope, Authorization } from '@orcaops/storage';
import {
  authorizationContext,
  knowledgeReadRequest,
  listProjectRevocations,
  projectActCurrentlyEffective,
  type ProjectDatabase,
  projectKnowledgeContext,
  type ProjectReadView,
  projectTaskKnowledgeContext,
  readProjectAssignment,
  readProjectAuthorization,
  scopeReaches,
  writeSequencesOf,
} from '@orcaops/storage/history/database';

import { processingActor } from './knowledge-processing-actor.js';

/** The identity a local pass acts as: the account, claimed and never authenticated. */
export const integrationActingIdentity = (): string | null => processingActor().changedBy;

interface ActRow {
  id: string;
  scope_kind: string;
  scope_value: string | null;
  attributed_to: string | null;
  recorded_at: string | null;
  authorization_json: string | null;
  /** The authorization record written for this very act, set only under an embedded instruction. */
  authorization_id: string | null;
  operation_id: string;
}

/**
 * Every act this store holds that cites an authority a revocation can end.
 *
 * An adoption and a relationship keep what they cited in a column of their own; an exception and a
 * correction keep it inside the record, where `json_extract` reaches it without this module having
 * to parse a contract record it does not otherwise need.
 */
const ACT_QUERIES: readonly [RecordedActKind, string][] = [
  [
    'selection',
    `SELECT adoption_id AS id, scope_kind, scope_value, approver AS attributed_to,
       approved_at AS recorded_at, authorization_json, authorization_id, operation_id
     FROM adoptions WHERE authorization_json IS NOT NULL`,
  ],
  [
    'relationship',
    `SELECT relationship_id AS id, scope_kind, scope_value, attributed_to,
       NULL AS recorded_at, authorization_json, authorization_id, operation_id
     FROM record_relationships WHERE authorization_json IS NOT NULL`,
  ],
  [
    'exception',
    `SELECT exception_id AS id, scope_kind, scope_value, granted_by AS attributed_to,
       NULL AS recorded_at,
       json_extract(CAST(record_bytes AS TEXT), '$.authorization') AS authorization_json,
       NULL AS authorization_id, operation_id
     FROM knowledge_exceptions`,
  ],
  [
    'correction',
    `SELECT action_id AS id, scope_kind, scope_value, attributed_to,
       json_extract(CAST(record_bytes AS TEXT), '$.recorded_at') AS recorded_at,
       json_extract(CAST(record_bytes AS TEXT), '$.authorization') AS authorization_json,
       authorization_id, operation_id
     FROM correction_actions WHERE authorization_kind IS NOT NULL`,
  ],
];

/** A branch grants no authority, so a released branch-scoped row is in no scope this compares. */
function scopeOf(row: ActRow, projectId: string): AuthorityScope | null {
  if (row.scope_kind === 'project') return { kind: 'project', project_id: projectId };
  if (row.scope_kind === 'artifact' && row.scope_value !== null)
    return { kind: 'artifact', artifact_id: row.scope_value };
  return null;
}

interface CitedAuthority {
  kind: 'authorization' | 'assignment';
  id: string;
  /** What the act cited, as the contract spells it, for the store's own judgment of validity. */
  authorization: Authorization;
}

/**
 * What an act rests on that a revocation can reach.
 *
 * An act under an embedded instruction rests on the authorization recorded for that very act, which
 * is why the column is read even though the citation names an instruction: a revocation of that
 * authorization is the same case as a revocation of a reused one.
 */
function citedAuthorityOf(row: ActRow): CitedAuthority | null {
  if (row.authorization_json === null) return null;
  const authorization = JSON.parse(row.authorization_json) as { kind?: unknown } & Record<
    string,
    unknown
  >;
  if (typeof authorization.kind !== 'string') return null;
  if (authorization.kind === 'assignment' && typeof authorization.assignment_id === 'string')
    return {
      kind: 'assignment',
      id: authorization.assignment_id,
      authorization: authorization as unknown as Authorization,
    };
  if (
    authorization.kind === 'reused_authorization' &&
    typeof authorization.authorization_id === 'string'
  )
    return {
      kind: 'authorization',
      id: authorization.authorization_id,
      authorization: authorization as unknown as Authorization,
    };
  if (row.authorization_id !== null)
    return {
      kind: 'authorization',
      id: row.authorization_id,
      authorization: { kind: 'reused_authorization', authorization_id: row.authorization_id },
    };
  return null;
}

interface RevocationReport {
  revocation_id: string;
  revoked_by: string | null;
  recorded_at: string | null;
}

/** The revocations of one record that reach its own scope at this boundary. */
function revocationsReaching(
  view: ProjectReadView,
  projectId: string,
  revokes: { kind: string; id: string },
  scope: AuthorityScope,
  boundary: number
): RevocationReport[] {
  const rows = listProjectRevocations(view, revokes);
  const sequences = writeSequencesOf(
    view,
    rows.map((row) => row.operationId)
  );
  return rows
    .filter((row) => {
      const writeSequence = sequences.get(row.operationId);
      if (writeSequence === undefined || writeSequence > boundary) return false;
      const at: AuthorityScope | null =
        row.scope.kind === 'project'
          ? { kind: 'project', project_id: projectId }
          : row.scope.value === null
            ? null
            : { kind: 'artifact', artifact_id: row.scope.value };
      return at !== null && scopeReaches(at, scope);
    })
    .map((row) => ({
      revocation_id: row.revocationId,
      revoked_by: row.revokedBy.identity,
      recorded_at:
        (
          JSON.parse(Buffer.from(row.recordHex, 'hex').toString('utf8')) as {
            recorded_at?: string;
          }
        ).recorded_at ?? null,
    }));
}

/**
 * How the authority an act rests on stood at the boundary.
 *
 * An assignment's own reader already judges revocation, its basis and its validity window and says
 * why in one line, so nothing is judged twice here. An authorization has no such reader: the
 * store's `authorizationContext` says whether it is still valid, and the revocations that reach it
 * are what tells a revoked one from one whose departed rule stopped standing.
 */
function authorityStandingOf(
  view: ProjectReadView,
  input: {
    projectId: string;
    cited: CitedAuthority;
    boundary: number;
    judgedAt: string;
    request: ReturnType<typeof knowledgeReadRequest>;
  }
): ActAuthority {
  const { projectId, cited, boundary, judgedAt } = input;
  const work = { time: judgedAt };
  if (cited.kind === 'assignment') {
    const assignment = readProjectAssignment(view, projectId, cited.id, input.request);
    if (assignment === null)
      return {
        kind: 'assignment',
        id: cited.id,
        standing: 'revoked',
        reason: 'This history holds no such assignment at this boundary.',
        revocations: [],
      };
    return {
      kind: 'assignment',
      id: cited.id,
      standing: assignment.standing,
      reason: assignment.reason,
      revocations:
        assignment.revokedBy.length === 0
          ? []
          : revocationsReaching(
              view,
              projectId,
              { kind: 'assignment', id: cited.id },
              assignment.record.scope,
              boundary
            ).filter((revocation) => assignment.revokedBy.includes(revocation.revocation_id)),
    };
  }
  const record = readProjectAuthorization(view, cited.id);
  if (record === null)
    return {
      kind: 'authorization',
      id: cited.id,
      standing: 'revoked',
      reason: 'This history holds no such authorization at this boundary.',
      revocations: [],
    };
  const authorization = JSON.parse(
    Buffer.from(record.recordHex, 'hex').toString('utf8')
  ) as AuthorizationRecordShape;
  const scope = authorization.instruction.scope;
  const context = authorizationContext(view, projectId, cited.authorization, work);
  const valid = context.earlier[0]?.valid ?? false;
  if (valid)
    return {
      kind: 'authorization',
      id: cited.id,
      standing: 'valid',
      reason: 'No revocation reaches it and every rule it departs from still stands.',
      revocations: [],
    };
  const revocations = revocationsReaching(
    view,
    projectId,
    { kind: 'authorization', id: cited.id },
    scope,
    boundary
  );
  if (revocations.length > 0)
    return {
      kind: 'authorization',
      id: cited.id,
      standing: 'revoked',
      reason: 'A revocation reaching its scope ended it.',
      revocations,
    };
  const answer = knowledgeContextAnswer(
    projectKnowledgeContext(view, {
      projectId,
      scope,
      boundary,
      mode: 'current',
      subject: {
        kind: 'identities',
        targets: authorization.departs_from.map(({ rule }) => ({
          kind: rule.kind,
          entity_id: rule.entity_id,
        })),
      },
      applicability: work,
    }),
    null
  );
  const ended = authorization.departs_from
    .map((departure) => departure.rule)
    .filter(
      (rule) =>
        (answer.entries
          .find(
            (entry) => entry.target.kind === rule.kind && entry.target.entity_id === rule.entity_id
          )
          ?.revisions.find((revision) => revision.revision.revision_id === rule.revision_id)
          ?.standing ?? 'not_standing') === 'not_standing'
    );
  return {
    kind: 'authorization',
    id: cited.id,
    standing: 'basis_ended',
    reason:
      ended.length === 0
        ? 'A rule it departs from no longer stands.'
        : `A rule it departs from no longer stands: ${ended
            .map((rule) => `${rule.kind}:${rule.entity_id}@${rule.revision_id}`)
            .join(', ')}.`,
    revocations: [],
  };
}

interface AuthorizationRecordShape {
  instruction: { scope: AuthorityScope };
  departs_from: readonly {
    rule: { kind: 'requirement' | 'decision'; entity_id: string; revision_id: string };
  }[];
}

/** Revising the plan changes selected uses, not the lifetime of acts this task published. */
function initialPlanWriteSequence(view: ProjectReadView, artifactId: string): number | null {
  const row = view.get<{ operation_id: string }>(
    `SELECT r.operation_id FROM artifact_revisions r
     JOIN artifact_events e ON e.artifact_id=r.artifact_id AND e.event_id=r.tail_event_id
     WHERE r.artifact_id=?
       AND e.ordinal >= (SELECT min(ordinal) FROM artifact_events WHERE artifact_id=? AND event_type='plan_captured')
     ORDER BY r.generation LIMIT 1`,
    artifactId,
    artifactId
  );
  if (row === null) return null;
  return writeSequencesOf(view, [row.operation_id]).get(row.operation_id) ?? null;
}

export interface IntegrationAuthorityRead {
  facts: IntegrationAuthorityFacts;
  planEventId: string;
  judgedAt: string;
  actingIdentity: string | null;
}

/**
 * One snapshot of everything the boundary compares, or null for an artifact whose plan this store
 * holds no event of — there is then no selection to compare and no act to attribute, and a check
 * that invented one would report a move nobody made.
 *
 * The answer is composed with NO bounds. Every other surface caps what it carries because a reader
 * can ask for more; a gate cannot, because an identity the bounds dropped is a finding nobody would
 * ever see.
 */
export function readIntegrationAuthority(
  handle: ProjectDatabase,
  input: { projectId: string; artifactId: string; judgedAt?: string }
): IntegrationAuthorityRead | null {
  return handle.read((view) => readIntegrationAuthorityAtView(view, input)).value;
}

export function readIntegrationAuthorityAtView(
  view: ProjectReadView,
  input: { projectId: string; artifactId: string; judgedAt?: string }
): IntegrationAuthorityRead | null {
  const judgedAt = input.judgedAt ?? new Date().toISOString();
  const actingIdentity = integrationActingIdentity();
  const scope: AuthorityScope = { kind: 'artifact', artifact_id: input.artifactId };
  const request = knowledgeReadRequest(view, {
    scope,
    mode: 'current',
    boundary: 'now',
    exceptionsJudgedAt: judgedAt,
    acting:
      actingIdentity === null
        ? null
        : { kind: 'actor', actor: { identity: actingIdentity, basis: 'other_assertion' } },
  });
  const task = projectTaskKnowledgeContext(view, {
    projectId: input.projectId,
    artifactId: input.artifactId,
    boundary: 'now',
    plan: { kind: 'latest_visible' },
    exceptionsJudgedAt: judgedAt,
  });
  if (task.selectedPlan === null) return null;
  const planSequence = initialPlanWriteSequence(view, input.artifactId);
  if (planSequence === null) return null;
  const boundary = task.knowledge.request.knowledge_boundary;
  const acts: RecordedAct[] = [];
  for (const [kind, query] of ACT_QUERIES)
    for (const row of view.all<ActRow>(query)) {
      const actScope = scopeOf(row, input.projectId);
      const cited = citedAuthorityOf(row);
      if (actScope === null || cited === null) continue;
      const writeSequence = writeSequencesOf(view, [row.operation_id]).get(row.operation_id);
      if (writeSequence === undefined || writeSequence > boundary) continue;
      if (
        !projectActCurrentlyEffective(view, {
          kind,
          id: row.id,
          projectId: input.projectId,
          scope: actScope,
          judgedAt,
        })
      )
        continue;
      acts.push({
        kind,
        id: row.id,
        scope: actScope,
        attributed_to: row.attributed_to,
        recorded_at: row.recorded_at,
        write_sequence: writeSequence,
        authority: authorityStandingOf(view, {
          projectId: input.projectId,
          cited,
          boundary,
          judgedAt,
          request,
        }),
      });
    }
  return {
    facts: {
      boundary,
      plan_write_sequence: planSequence,
      answer: knowledgeContextAnswer(task.knowledge, null),
      acts,
    },
    planEventId: task.selectedPlan.planEventId,
    judgedAt,
    actingIdentity,
  } satisfies IntegrationAuthorityRead;
}
