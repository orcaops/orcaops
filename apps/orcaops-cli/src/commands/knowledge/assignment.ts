// `orcaops knowledge assignment` — who may decide what on somebody else's behalf, what that
// delegates, and when it ends.
//
// `orcaops knowledge revoke` already means withdrawing this project's consent to background
// processing, so delegation is one family of its own rather than a second `assign` and `revoke`
// pair beside it: `assignment open`, `assignment list` and `assignment revoke <assignment>`.
//
// `open` writes one assignment and nothing else. The store judges the assigner's own authority over
// exactly the footprint being delegated inside the publishing transaction, so nothing here decides
// what may be delegated. `list` is a passive read at a boundary the answer names. `revoke` retains
// the reason as a source, then ends the assignment from now on: what was published under it before
// stays exactly as it was retained.
//
// Orcaops enforces that an act under an assignment CLAIMS the responsible identity. It does not
// authenticate it: a local invocation carries no authentication, so the identity a record here
// carries is an assertion.
import { createHash } from 'node:crypto';

import { type Actor, type AuthorityScope, uuidv7 } from '@orcaops/storage';
import {
  knowledgeReadRequest,
  listProjectAssignments,
  openProjectDatabase,
  type ProjectAssignment,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  publishProjectAssignment,
  publishProjectRevocationWithSource,
  readProjectAssignment,
} from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { readPayloadInput } from '../../io/input.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { knowledgeBoundaryOption } from '../../lib/artifact-knowledge.js';
import { resolveDatabaseHistoryCommandContext } from '../../lib/database-history-context.js';
import { ASSIGNMENT_STATEMENT } from '../../lib/knowledge-assignment-view.js';
import { processingActor } from '../../lib/knowledge-processing-actor.js';

export interface KnowledgeAssignmentOpenOptions {
  input?: string;
  json?: boolean;
}

export interface KnowledgeAssignmentListOptions {
  identity?: string;
  responsible?: string;
  atBoundary?: string;
  limit?: string;
  json?: boolean;
}

export interface KnowledgeAssignmentRevokeOptions {
  reason?: string;
  json?: boolean;
}

const DEFAULT_LISTED = 50;
const MAX_LISTED = 500;

const IDENTITY_KINDS = new Set(['requirement', 'decision', 'claim', 'relationship']);

/** The one place a local act learns who is acting: the account, never `authenticated`. */
const invokingActor = (): Actor => {
  const actor = processingActor();
  return { identity: actor.changedBy, basis: actor.changedByBasis };
};

interface ProjectTarget {
  authority: ProjectDatabaseAuthority;
  scope: AuthorityScope;
}

async function resolveProject(): Promise<ProjectTarget> {
  const context = await resolveDatabaseHistoryCommandContext({
    profile: 'status',
    selector: { scope: 'project' },
  });
  try {
    const project = context.scope.projects[0];
    const authority = project?.authority ?? null;
    if (!project?.database || authority === null)
      throw new OrcaopsError(
        ErrorCodes.UNINITIALIZED,
        project?.completeness.issues[0]?.message ??
          'This repository has no orcaops project history to hold an assignment yet.'
      );
    return {
      authority: { ...authority },
      scope: { kind: 'project', project_id: authority.projectId },
    };
  } finally {
    context.scope.close();
  }
}

async function withProject<T>(use: (target: ProjectTarget, handle: ProjectDatabase) => Promise<T>) {
  const target = await resolveProject();
  const handle = await openProjectDatabase({ authority: target.authority, mode: 'writer' });
  try {
    return await use(target, handle);
  } finally {
    handle.close();
  }
}

function boundedNumber(value: string, bounds: { min: number; max: number }, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `${flag} takes a whole number between ${bounds.min} and ${bounds.max}`,
      flag.replace(/^--/u, '')
    );
  return parsed;
}

function identityOf(value: string): { kind: string; entityId: string } {
  const at = value.indexOf(':');
  const kind = at < 0 ? '' : value.slice(0, at);
  const entityId = at < 0 ? '' : value.slice(at + 1);
  if (!IDENTITY_KINDS.has(kind) || entityId.length === 0)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `--identity takes <kind>:<id>, where kind is one of ${[...IDENTITY_KINDS].sort().join(', ')}`,
      'identity'
    );
  return { kind, entityId };
}

/**
 * The document `open` reads: the assignment as authored, with the assigner and the operation
 * identity taken out of it. A document that names an assigner wins, basis and all, and nothing here
 * verifies that basis — exactly as nothing in the store does.
 */
async function readAssignmentDocument(inputPath: string | undefined): Promise<{
  assignment: Record<string, unknown>;
  assignedBy: Actor;
  operationId: string;
}> {
  const document = await readPayloadInput({ inputPath });
  if (document === null || typeof document !== 'object' || Array.isArray(document))
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Provide the assignment as a YAML or JSON object.'
    );
  const {
    assigned_by: assigner,
    operation_id: operationId,
    ...record
  } = document as Record<string, unknown>;
  if (operationId !== undefined && typeof operationId !== 'string')
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'operation_id is the identity an interrupted publication repeats under.',
      'operation_id'
    );
  const fixedOperationId = operationId ?? uuidv7();
  return {
    assignment: { assignment_id: fixedOperationId, ...record },
    assignedBy: assigner === undefined || assigner === null ? invokingActor() : (assigner as Actor),
    operationId: fixedOperationId,
  };
}

export interface AssignmentListReport {
  basis: { scope: AuthorityScope; mode: 'current' | 'historical'; knowledge_boundary: number };
  assignments: readonly {
    assignment_id: string;
    objective: string;
    responsible: { identity: string | null; basis: string };
    assigned_by: { identity: string | null; basis: string };
    scope: { kind: string; value: string | null };
    authorization_kind: string;
    valid_until: string | null;
    standing: string;
    reason: string;
    revoked_by: readonly string[];
    inherited: number;
    delegates: { adopts: number; departs_from: number; restates: number };
    allowed_changes: readonly string[];
    escalation_conditions: readonly string[];
  }[];
  later: number;
  truncated: number;
  coverage: { statement: string };
}

const listedAssignment = (row: ProjectAssignment) => ({
  assignment_id: row.assignmentId,
  objective: row.objective,
  responsible: row.responsible,
  assigned_by: row.assignedBy,
  scope: row.scope,
  authorization_kind: row.authorizationKind,
  valid_until: row.validUntil,
  standing: row.standing,
  reason: row.reason,
  revoked_by: row.revokedBy,
  inherited: row.record.inherited.length,
  delegates: {
    adopts: row.record.delegated.adopts.length,
    departs_from: row.record.delegated.departs_from.length,
    restates: row.record.delegated.restates.length,
  },
  allowed_changes: row.record.allowed_changes,
  escalation_conditions: row.record.escalation_conditions,
});

/**
 * `orcaops knowledge assignment open --input -` — retain one assignment.
 *
 * It writes the assignment and nothing else: no adoption, no exception, no reconsideration item and
 * no processing job. Whether the assigner actually holds what it delegates is decided in the store,
 * inside the transaction that publishes it.
 */
export async function knowledgeAssignmentOpenAction(
  opts: KnowledgeAssignmentOpenOptions = {}
): Promise<void> {
  const json = opts.json === true;
  try {
    const document = await readAssignmentDocument(opts.input);
    const written = await withProject(async (_target, handle) =>
      publishProjectAssignment(handle, {
        operationId: document.operationId,
        assignment: document.assignment,
        assignedBy: document.assignedBy,
        secretAllow: [],
      })
    );
    if (json) {
      emitOk({
        assignment_id: written.value.assignmentId,
        responsible: written.value.responsible,
        record_sha256: written.value.recordSha256,
        operation_id: document.operationId,
        counters: written.counters,
        coverage: { statement: ASSIGNMENT_STATEMENT },
      });
      return;
    }
    writeTerminalSafeStdout(
      `Retained assignment ${written.value.assignmentId}, responsible ` +
        `${written.value.responsible ?? 'nobody named'}.\n` +
        `${ASSIGNMENT_STATEMENT}\n`
    );
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/**
 * `orcaops knowledge assignment list` — the assignments at a boundary, with how each stood then. A
 * passive read: it asks nothing, writes nothing and starts no worker.
 */
export async function knowledgeAssignmentListAction(
  opts: KnowledgeAssignmentListOptions = {}
): Promise<void> {
  const json = opts.json === true;
  try {
    const boundary = knowledgeBoundaryOption(opts.atBoundary);
    const mode = boundary === 'now' ? ('current' as const) : ('historical' as const);
    const maxItems =
      opts.limit === undefined
        ? DEFAULT_LISTED
        : boundedNumber(opts.limit, { min: 1, max: MAX_LISTED }, '--limit');
    const identity = opts.identity === undefined ? undefined : identityOf(opts.identity);
    const context = await resolveDatabaseHistoryCommandContext({
      profile: 'status',
      selector: { scope: 'project' },
    });
    let report: AssignmentListReport;
    try {
      const project = context.scope.projects[0];
      const authority = project?.authority ?? null;
      if (!project?.database || authority === null)
        throw new OrcaopsError(
          ErrorCodes.UNINITIALIZED,
          project?.completeness.issues[0]?.message ??
            'This repository has no orcaops project history to hold an assignment yet.'
        );
      const scope: AuthorityScope = { kind: 'project', project_id: authority.projectId };
      report = project.database.read((view) => {
        const request = knowledgeReadRequest(view, { scope, mode, boundary });
        const read = listProjectAssignments(view, authority.projectId, request, {
          ...(identity === undefined ? {} : { identity }),
          ...(opts.responsible === undefined ? {} : { responsible: opts.responsible }),
          maxItems,
        });
        return {
          basis: { scope, mode, knowledge_boundary: request.knowledge_boundary },
          assignments: read.assignments.map(listedAssignment),
          later: read.later,
          truncated: read.truncated,
          coverage: { statement: ASSIGNMENT_STATEMENT },
        } satisfies AssignmentListReport;
      }).value;
    } finally {
      context.scope.close();
    }
    if (json) {
      emitOk({ ...report });
      return;
    }
    writeTerminalSafeStdout(formatAssignmentList(report));
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function formatAssignmentList(report: AssignmentListReport): string {
  const scope =
    report.basis.scope.kind === 'project'
      ? `project ${report.basis.scope.project_id}`
      : `artifact ${report.basis.scope.artifact_id}`;
  const lines = [
    `Assignments read at write sequence ${report.basis.knowledge_boundary} ` +
      `(${report.basis.mode}), ${scope}.`,
    report.assignments.length === 0
      ? 'Assignments (0): nobody has delegated anything here.'
      : `Assignments (${report.assignments.length})`,
  ];
  for (const assignment of report.assignments) {
    lines.push(
      `  - ${assignment.assignment_id} — ${assignment.standing}` +
        `${assignment.valid_until === null ? '' : `, until ${assignment.valid_until}`}`
    );
    lines.push(`    "${assignment.objective}"`);
    lines.push(
      `    responsible ${assignment.responsible.identity ?? 'nobody named'} ` +
        `(${assignment.responsible.basis}), assigned by ` +
        `${assignment.assigned_by.identity ?? 'nobody named'} on ` +
        `${assignment.authorization_kind.replaceAll('_', ' ')}`
    );
    lines.push(
      `    delegates ${assignment.delegates.adopts} adoption(s), ` +
        `${assignment.delegates.departs_from} departure(s), ` +
        `${assignment.delegates.restates} restatement(s); inherits ${assignment.inherited} rule(s)`
    );
    for (const allowed of assignment.allowed_changes) lines.push(`    allows: ${allowed}`);
    for (const escalate of assignment.escalation_conditions)
      lines.push(`    escalate: ${escalate}`);
    lines.push(`    Why: ${assignment.reason}`);
    if (assignment.revoked_by.length > 0)
      lines.push(`    revoked by ${assignment.revoked_by.join(', ')}`);
  }
  if (report.later > 0)
    lines.push(`${report.later} assignment(s) were opened after this boundary.`);
  if (report.truncated > 0)
    lines.push(`${report.truncated} assignment(s) were left out by --limit.`);
  lines.push(report.coverage.statement);
  return `${lines.join('\n')}\n`;
}

/**
 * `orcaops knowledge assignment revoke <assignment> --reason <text>` — end a delegation from now on.
 *
 * The reason source and revocation settle together, because a refused revocation must not retain an
 * instruction that did not take effect. Ending an assignment prevents every later act under it;
 * what was published under it before stays exactly as it was retained, and the assignment row is
 * never deleted or edited.
 */
export async function knowledgeAssignmentRevokeAction(
  assignmentId: string,
  opts: KnowledgeAssignmentRevokeOptions = {}
): Promise<void> {
  const json = opts.json === true;
  try {
    const reason = (opts.reason ?? '').trim();
    if (reason.length === 0)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--reason says why the delegation is ending; a revocation with no reason records nothing',
        'reason'
      );
    const revokedBy = invokingActor();
    const operationId = uuidv7();
    const written = await withProject(async (target, handle) => {
      const request = handle.read((view) =>
        knowledgeReadRequest(view, { scope: target.scope, mode: 'current', boundary: 'now' })
      ).value;
      const assignment = handle.read((view) =>
        readProjectAssignment(view, target.authority.projectId, assignmentId, request)
      ).value;
      if (assignment === null)
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `No assignment ${assignmentId} is retained in this history.`
        );
      const scope: AuthorityScope =
        assignment.scope.kind === 'project'
          ? { kind: 'project', project_id: target.authority.projectId }
          : { kind: 'artifact', artifact_id: assignment.scope.value as string };
      const bytes = Buffer.from(reason, 'utf8');
      const sourceId = uuidv7();
      return publishProjectRevocationWithSource(handle, {
        operationId,
        source: {
          source: {
            source_id: sourceId,
            occurrence: {
              kind: 'user_instruction',
              retention: {
                kind: 'bytes',
                content_sha256: createHash('sha256').update(bytes).digest('hex'),
              },
              location: `orcaops knowledge assignment revoke ${assignmentId}`,
              source_time: new Date().toISOString(),
            },
            source_author: revokedBy,
            interpreted_by: null,
            access_restriction: null,
          },
          recordedBy: revokedBy,
          retainedBytes: bytes,
          secretAllow: [],
        },
        revocation: {
          revocation_id: uuidv7(),
          revokes: { kind: 'assignment', id: assignmentId },
          scope,
          source_id: sourceId,
          instruction: {
            kind: 'explicit_instruction',
            instruction_source_id: sourceId,
            scope,
          },
          recorded_at: new Date().toISOString(),
        },
        revokedBy,
        secretAllow: [],
      });
    });
    if (json) {
      emitOk({
        revocation_id: written.value.revocationId,
        revokes: written.value.revokes,
        record_sha256: written.value.recordSha256,
        operation_id: operationId,
        counters: written.counters,
      });
      return;
    }
    writeTerminalSafeStdout(
      `Revoked assignment ${assignmentId} with revocation ${written.value.revocationId}.\n` +
        'Every later act under it is refused. What was published under it before stays exactly as ' +
        'it was retained, and the assignment itself is still readable.\n'
    );
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
