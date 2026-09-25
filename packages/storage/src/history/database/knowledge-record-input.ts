// What every continuing-knowledge writer shares: validation against the contract schemas, the
// authored bytes a record keeps once, the lookup columns the tables read it back through, and
// the typed refusals a writer returns instead of a driver error.
//
// Storage has no publishing session to learn an acting identity from, so each writer takes the
// acting actor as its own named argument and refuses a record that carries one. The caller
// still supplies it, but the field a session will own is a parameter rather than part of the
// record handed over, so there is one place per writer to change when a session exists.
import { z } from 'zod';

import { refuseJsonBytes } from './authored-bytes.js';
import { type ProjectCounters, type ProjectDatabase, type ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type ProjectOperation,
  type ProjectOperationOptions,
  type ProjectOperationResult,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import {
  type Actor,
  type Attribution,
  checkRevisionContinues,
  type RevisionLink,
} from '../../schema/knowledge-contract.js';
import { identifierText } from '../../text/control-chars.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';
import { digest } from '../event-integrity.js';
import type { DatabaseJson } from './values.js';

/** The same string shapes the contract's own record ids, labels and instants are built from. */
export const RecordIdSchema = identifierText(
  z.string().regex(/^\S+$/u, 'must not be blank or contain whitespace')
);
export const LabelSchema = identifierText(z.string().regex(/\S/u, 'must not be blank'));
export const InstantSchema = identifierText(z.string().datetime());

export function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}

export function missing(message: string): never {
  throw new ProjectDatabaseError('HISTORY_MISSING', message);
}

export function taken(message: string): never {
  throw new ProjectDatabaseError('IDEMPOTENCY_CONFLICT', message);
}

export function integrity(message: string): never {
  throw new ProjectDatabaseError('HISTORY_INTEGRITY_REQUIRED', message);
}

export function secretAllowList(allow: readonly string[]): readonly string[] {
  if (!Array.isArray(allow) || !allow.every((value) => typeof value === 'string'))
    invalid('Supply the approved secret refusal allowlist explicitly');
  return allow;
}

export function operationIdentity(value: string): string {
  if (!isUuidV7(value)) invalid('Provide an original operation UUID');
  return value;
}

export function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const at = issue.path.join('.');
  invalid(`${what}: ${at ? `${at} ` : ''}${issue.message}`);
}

/**
 * The acting attribution joins the record here, and only here: a caller that names it inside
 * the record is refused, so the one field a publishing session will own stays a parameter.
 */
export function actingField(record: unknown, field: string, acting: unknown): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record))
    invalid('An authored record is a JSON object');
  if (field in record)
    invalid(`The acting attribution is this writer's ${field} argument, not part of the record`);
  return { ...record, [field]: acting };
}

/**
 * Fields the writer takes from another record it already holds. A caller that names one of them
 * is refused, so the two records can never disagree about the same field.
 */
export function composedRecord(record: unknown, supplied: Record<string, unknown>): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record))
    invalid('An authored record is a JSON object');
  for (const field of Object.keys(supplied))
    if (field in record) invalid(`This writer supplies ${field}; the record must not name it`);
  return { ...record, ...supplied };
}

export interface AuthoredRecord {
  readonly bytes: Buffer;
  readonly sha256: string;
}

export function authoredRecord(record: unknown, allow: readonly string[]): AuthoredRecord {
  const json = canonicalJson(record);
  const bytes = Buffer.from(json);
  refuseJsonBytes(bytes, allow);
  return { bytes, sha256: digest(bytes) };
}

/**
 * Retained source text is held to the same secret refusal as an authored string: the same token
 * cannot be refused in a requirement's statement and kept verbatim in the source it quotes.
 * Bytes that are not text are retained as they are, because nothing can read a secret out of
 * them without deciding what they mean.
 */
export function refuseRetainedSecrets(bytes: Buffer, allow: readonly string[]): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  try {
    assertNoSecretsInPayload(text, allow);
  } catch (cause) {
    if (cause instanceof SecretInPayloadError)
      throw new ProjectDatabaseError(
        'SECRET_IN_PAYLOAD',
        'Secret refusal: remove or redescribe refused content before a new attempt',
        { cause }
      );
    throw cause;
  }
}

/** An unknown actor has no name; a named actor says how the name is known. */
export const actorColumns = (actor: Actor): [string | null, string] => [
  actor.identity,
  actor.basis,
];

export const attributionColumns = (
  attribution: Attribution
): [kind: string, name: string | null, basis: string | null] =>
  attribution.kind === 'detector'
    ? ['detector', attribution.detector, null]
    : ['actor', attribution.actor.identity, attribution.actor.basis];

/** Only an actor's record is a change of intent; a detector derives candidates. */
export const advancesIntent = (attribution: Attribution): boolean => attribution.kind === 'actor';

/**
 * An interrupted publication retries by its original operation ID. The receipt is the authority
 * on what it did, so a retry goes straight to the runner and never re-runs the preparation
 * checks, which would read the rows the original attempt already wrote and refuse them.
 */
export function retriedOperation(handle: ProjectDatabase, operationId: string): boolean {
  return !!handle.read((view) =>
    view.get('SELECT operation_id FROM operations WHERE operation_id=?', operationId)
  ).value;
}

export function replayOperation(
  handle: ProjectDatabase,
  operation: Parameters<typeof runProjectOperation>[1],
  options: ProjectOperationOptions
) {
  return runProjectOperation(
    handle,
    operation,
    () => {
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The original publication receipt disappeared; preserve history for explicit repair'
      );
    },
    options
  );
}

/**
 * The record a settlement found already retained. Thrown so the transaction rolls back and
 * writes nothing: `runProjectOperation` rethrows a `ProjectDatabaseError` unchanged once it has
 * rolled back, and {@link publishUnlessRetained} turns it back into the record. It never reaches
 * a caller.
 */
export class AlreadyRetained extends ProjectDatabaseError {
  constructor(readonly retained: DatabaseJson) {
    super('IDEMPOTENCY_CONFLICT', 'This record is already retained; the publication wrote nothing');
  }
}

/**
 * The result of a call that committed nothing: no row, no receipt, and neither counter moved.
 * `replayed` is what says so — these writers set it whenever the call wrote nothing at all,
 * whether that was a receipt replay, a repeat the store already held, or a change this store
 * does not record.
 */
export function committedNothing<T>(
  handle: ProjectDatabase,
  value: T
): { value: T; replayed: true; counters: ProjectCounters } {
  return { value, replayed: true, counters: handle.read(() => null).counters };
}

/**
 * Publishing, unless the settlement finds the record already there. A repeat must move neither
 * counter, and `intentChange` is fixed before the settlement runs, so the only honest way to
 * repeat is to write nothing at all: the settlement throws what it found, the transaction rolls
 * back, and the existing record is returned with counters read fresh.
 */
export async function publishUnlessRetained<T extends DatabaseJson>(
  handle: ProjectDatabase,
  operation: ProjectOperation,
  settle: (transaction: ProjectSettlement, prepared: Readonly<ProjectOperation>) => T,
  options: ProjectOperationOptions
): Promise<ProjectOperationResult<T>> {
  try {
    return await runProjectOperation(handle, operation, settle, options);
  } catch (error) {
    if (error instanceof AlreadyRetained) return committedNothing(handle, error.retained as T);
    throw error;
  }
}

export function requireRetainedSources(view: ProjectReadView, sourceIds: readonly string[]): void {
  for (const sourceId of sourceIds)
    if (!view.get('SELECT source_id FROM knowledge_sources WHERE source_id=?', sourceId))
      missing('The record cites a knowledge source this history does not hold');
}

export function requireRetainedSubject(
  view: ProjectReadView,
  subject: { subject_id: string; subject_revision_id: string } | null
): void {
  if (subject === null) return;
  if (
    !view.get(
      'SELECT revision_id FROM subject_revisions WHERE subject_id=? AND revision_id=?',
      subject.subject_id,
      subject.subject_revision_id
    )
  )
    missing('The record names a subject revision this history does not hold');
}

const EXPECTATION_REVISION_TABLE = {
  requirement: ['requirement_revisions', 'requirement_id'],
  decision: ['decision_revisions', 'decision_id'],
} as const;

export function retainedExpectationRevision(
  view: ProjectReadView,
  ref: { kind: 'requirement' | 'decision'; entity_id: string; revision_id: string }
): boolean {
  const [table, column] = EXPECTATION_REVISION_TABLE[ref.kind];
  return !!view.get(
    `SELECT revision_id FROM ${table} WHERE ${column}=? AND revision_id=?`,
    ref.entity_id,
    ref.revision_id
  );
}

export function revisionLineage(
  view: ProjectReadView,
  table: string,
  column: string,
  entityId: string
): RevisionLink[] {
  return view
    .all<{
      revision_id: string;
      previous_revision_id: string | null;
    }>(
      `SELECT revision_id, previous_revision_id FROM ${table} WHERE ${column}=? ORDER BY rowid`,
      entityId
    )
    .map((row) => ({
      revision_id: row.revision_id,
      previous_revision_id: row.previous_revision_id,
    }));
}

const CONTINUATION_REFUSAL = {
  REVISION_ID_REUSED: 'That revision ID already belongs to retained history',
  LINEAGE_ALREADY_ROOTED:
    'This record already has a first revision; name the revision this one continues',
  PREDECESSOR_NOT_IN_LINEAGE:
    'A revision continues a retained revision of its own record; this predecessor belongs to another',
} as const;

/**
 * A revision may continue any retained revision of its own identity, siblings included. The
 * lineage is read from the store inside the publishing transaction; the caller's word for what
 * it continues is only the predecessor it names.
 */
export function requireRevisionContinues(lineage: readonly RevisionLink[], next: RevisionLink) {
  const outcome = checkRevisionContinues(lineage, next);
  if (outcome.ok) return;
  if (outcome.code === 'REVISION_ID_REUSED') taken(CONTINUATION_REFUSAL[outcome.code]);
  invalid(CONTINUATION_REFUSAL[outcome.code]);
}

// A criterion lives inside its plan event's retained bytes; no released build writes lineage
// rows, so there is nowhere else to look for one.
const CRITERION_IN_EVENT = `
  e.event_type IN ('plan_captured','plan_revised')
  AND json_valid(CAST(e.record_bytes AS TEXT))
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(CAST(e.record_bytes AS TEXT), '$.payload.plan_steps')) step,
         json_each(json_extract(step.value, '$.acceptance_criteria')) criterion
    WHERE json_extract(criterion.value, '$.criterion_id')=?
  )`;

export function criterionInPlanEvent(
  view: ProjectReadView,
  criterion: { artifact_id: string; plan_event_id: string; criterion_id: string }
): boolean {
  return !!view.get(
    `SELECT e.event_id FROM artifact_events e WHERE e.artifact_id=? AND e.event_id=? AND ${CRITERION_IN_EVENT} LIMIT 1`,
    criterion.artifact_id,
    criterion.plan_event_id,
    criterion.criterion_id
  );
}

export function criterionHoldsIdentity(view: ProjectReadView, criterionId: string): boolean {
  return !!view.get(
    `SELECT e.event_id FROM artifact_events e WHERE ${CRITERION_IN_EVENT} LIMIT 1`,
    criterionId
  );
}

/**
 * Which artifacts' plans hold a criterion id. More than one means the id was repeated as a
 * criterion of another plan, which the contract forbids, so nothing may be promoted under it.
 * Capped at two, because that is all the answer needs.
 */
export function criterionArtifacts(view: ProjectReadView, criterionId: string): string[] {
  return view
    .all<{
      artifact_id: string;
    }>(
      `SELECT DISTINCT e.artifact_id FROM artifact_events e WHERE ${CRITERION_IN_EVENT} LIMIT 2`,
      criterionId
    )
    .map((row) => row.artifact_id);
}

/**
 * The operation that appended an event is the one that wrote the first artifact revision whose
 * cumulative event count reaches that event's ordinal.
 */
export function eventOperation(
  view: ProjectReadView,
  artifactId: string,
  eventId: string
): string | null {
  const row = view.get<{ operation_id: string }>(
    `SELECT r.operation_id FROM artifact_revisions r
     WHERE r.artifact_id=?
       AND r.event_count >= (SELECT ordinal FROM artifact_events WHERE artifact_id=? AND event_id=?)
     ORDER BY r.generation LIMIT 1`,
    artifactId,
    artifactId,
    eventId
  );
  return row ? row.operation_id : null;
}

export type { ProjectOperationOptions, ProjectSettlement };
