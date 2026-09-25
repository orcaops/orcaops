// Recording what a task does with an exact requirement or decision revision.
//
// A use is keyed to the immutable plan event, so a checkpoint inherits the uses of the plan
// revision it opened against. Whether it was an original selection is derived from the
// operation that wrote it: the plan event's own settlement selected it with the plan, and any
// later operation has to say who found the connection and when. A repeat of the same use is the
// same use, never a second row.
import { z } from 'zod';

import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import {
  attributionColumns,
  authoredRecord,
  committedNothing,
  eventOperation,
  InstantSchema,
  integrity,
  invalid,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  replayOperation,
  retainedExpectationRevision,
  retriedOperation,
  secretAllowList,
} from './knowledge-record-input.js';
import { planCaptureCommand, type PreparedPlanCaptureCommand } from './plan-capture-input.js';
import { type ProjectOperation, runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import type { KnowledgeUseInput } from '../../schema/capture-input.js';
import {
  AttributionSchema,
  type TaskUse,
  TaskUseSchema,
  taskUseSelection,
} from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

/** A use as authored. The selection is the store's to derive, so it is not part of the input. */
const TaskUseFieldsSchema = TaskUseSchema.omit({ selection: true });
type TaskUseFields = z.infer<typeof TaskUseFieldsSchema>;

/** Who found a connection, and when, for a use recorded after its plan event. */
const TaskUseDiscoverySchema = z.strictObject({
  discovered_at: InstantSchema,
  discovered_by: AttributionSchema,
});
export type TaskUseDiscovery = z.infer<typeof TaskUseDiscoverySchema>;

export interface RecordTaskUses {
  readonly operationId: string;
  /** Each use as authored, without `selection`. */
  readonly uses: readonly unknown[];
  readonly discovery: unknown;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type TaskUseRecording = {
  uses: {
    artifactId: string;
    planEventId: string;
    targetRevisionId: string;
    role: string;
    selectionKind: string;
    recordSha256: string;
    /** False when this exact use was already recorded, so no second row was written. */
    published: boolean;
  }[];
};

export interface PreparedTaskUses {
  readonly uses: readonly TaskUseFields[];
  readonly allow: readonly string[];
  readonly authoredSha256: readonly string[];
}

interface AcceptedPlanTaskUses {
  readonly operationId: string;
  readonly uses: readonly TaskUseFields[];
}

const acceptedPlanTaskUses = new WeakMap<PreparedTaskUses, AcceptedPlanTaskUses>();

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function canonicalRecord(record: unknown) {
  const bytes = Buffer.from(canonicalJson(record));
  return { bytes, sha256: digest(bytes) };
}

/**
 * A detector's use is a connection found after the task, and a connection found after the task
 * proves nothing about what the task intended. `implement`, `preserve`, `assess` and
 * `propose_change` are all claims about that intent, which only the capturing agent can make, so
 * a detector's use is `background` or it is refused. The role is the caller's word and no schema
 * pairs it with the discoverer, so this is where the pairing is held.
 */
function requireDetectorUsesBackground(
  uses: readonly TaskUseFields[],
  discovery: TaskUseDiscovery | null
): void {
  if (discovery === null || discovery.discovered_by.kind !== 'detector') return;
  if (uses.some((use) => use.role !== 'background'))
    invalid(
      'A connection a detector found after the task is recorded as background; implementing, ' +
        'preserving, assessing or proposing a change is what the task intended, which only the ' +
        'agent that captured it may say'
    );
}

export function prepareProjectTaskUses(
  uses: readonly unknown[],
  secretAllow: readonly string[],
  discovery: TaskUseDiscovery | null
): PreparedTaskUses {
  if (!Array.isArray(uses) || uses.length === 0) invalid('Record at least one task use');
  const allow = secretAllowList(secretAllow);
  const parsedUses = uses.map((use) => parsed(TaskUseFieldsSchema, use, 'A task use'));
  requireDetectorUsesBackground(parsedUses, discovery);
  return {
    uses: parsedUses,
    allow,
    authoredSha256: parsedUses.map((use) => authoredRecord(use, allow).sha256),
  };
}

/**
 * The uses a plan event selects, as the capture paths hand them over: the authored input, plus the
 * artifact and plan event the settling operation is about to write. No discovery accompanies them,
 * because a use settled in the plan event's own operation IS the original selection and one
 * settled in any other operation must not read as one — `settleProjectTaskUses` refuses it with
 * `DISCOVERY_REQUIRED` rather than quietly recording a connection nobody found.
 */
function planTaskUseFields(input: {
  artifactId: string;
  planEventId: string;
  uses: readonly KnowledgeUseInput[] | undefined;
}): TaskUseFields[] {
  return (input.uses ?? []).map((use) =>
    parsed(
      TaskUseFieldsSchema,
      {
        artifact_id: input.artifactId,
        plan_event_id: input.planEventId,
        target: { kind: use.kind, entity_id: use.entity_id, revision_id: use.revision_id },
        role: use.role,
        local: null,
        exception_id: use.exception_id ?? null,
      },
      'A task use'
    )
  );
}

export function preparePlanTaskUses(input: {
  artifactId: string;
  planEventId: string;
  uses: readonly KnowledgeUseInput[] | undefined;
  secretAllow: readonly string[];
}): PreparedTaskUses | null {
  const uses = planTaskUseFields(input);
  if (uses.length === 0) return null;
  return prepareProjectTaskUses(
    uses,
    input.secretAllow,
    // A plan's own selection carries no discovery: the person who captured the plan selected these.
    null
  );
}

export function retainedPlanTaskUseHashes(command: PreparedPlanCaptureCommand): readonly string[] {
  const record = planCaptureCommand(command);
  // Receipt replay checks the original accepted bytes, not today's secret allowlist.
  return planTaskUseFields({
    artifactId: record.artifactId,
    planEventId: record.planEventId,
    uses: record.authored.knowledge_uses,
  }).map((use) => digest(Buffer.from(canonicalJson(use))));
}

export function restoreAcceptedPlanTaskUses(
  command: PreparedPlanCaptureCommand
): PreparedTaskUses | null {
  const record = planCaptureCommand(command);
  const uses = freeze(
    planTaskUseFields({
      artifactId: record.artifactId,
      planEventId: record.planEventId,
      uses: record.authored.knowledge_uses,
    })
  );
  if (uses.length === 0) return null;
  const prepared = freeze({
    uses,
    allow: [] as string[],
    authoredSha256: uses.map((use) => canonicalRecord(use).sha256),
  });
  acceptedPlanTaskUses.set(prepared, { operationId: record.originalOperationId, uses });
  return prepared;
}

/**
 * The targets, read before anything is opened for writing, so a plan naming a revision this
 * history does not retain is refused with the writer's own code and captures nothing. The
 * settlement checks them again against the transaction it writes in; this is the early refusal,
 * never the authority.
 */
export function requireRetainedUseTargets(view: ProjectReadView, prepared: PreparedTaskUses): void {
  for (const use of prepared.uses) {
    if (!retainedExpectationRevision(view, use.target))
      missing('The task use names an expectation revision this history does not hold');
    if (
      use.exception_id !== null &&
      !view.get(
        'SELECT exception_id FROM knowledge_exceptions WHERE exception_id=?',
        use.exception_id
      )
    )
      missing('The task use cites an exception this history does not hold');
  }
}

/** Preparation for a use the caller offers no discovery for, so nothing is dereferenced blind. */
export function prepareTaskUseDiscovery(discovery: unknown): TaskUseDiscovery | null {
  return discovery === null || discovery === undefined
    ? null
    : parsed(TaskUseDiscoverySchema, discovery, 'A task use discovery');
}

const IDENTITY =
  'SELECT record_sha256, selection_kind FROM task_uses WHERE plan_event_id=? AND target_kind=? AND target_revision_id=? AND role=? AND step_id IS ? AND criterion_id IS ? AND exception_id IS ?';

interface RetainedUse {
  record_sha256: string;
  selection_kind: string;
}

const retainedRow = (view: ProjectReadView, use: TaskUseFields) =>
  view.get<RetainedUse>(
    IDENTITY,
    use.plan_event_id,
    use.target.kind,
    use.target.revision_id,
    use.role,
    use.local === null ? null : use.local.step_id,
    use.local === null ? null : use.local.criterion_id,
    use.exception_id
  );

const recordedUse = (use: TaskUseFields, row: RetainedUse) => ({
  artifactId: use.artifact_id,
  planEventId: use.plan_event_id,
  targetRevisionId: use.target.revision_id,
  role: use.role,
  selectionKind: row.selection_kind,
  recordSha256: row.record_sha256,
  published: false,
});

const retainedUse = (view: ProjectReadView, use: TaskUseFields) => {
  const row = retainedRow(view, use);
  return row ? recordedUse(use, row) : null;
};

/** The use this store already holds for a prepared one, so a caller's own operation can tell a
 * repeat from a new connection before it starts. */
export const retainedProjectTaskUse = (
  view: ProjectReadView,
  use: PreparedTaskUses['uses'][number]
) => retainedUse(view, use);

function requireReferences(view: ProjectReadView, use: TaskUseFields): void {
  if (
    !view.get(
      "SELECT event_id FROM artifact_events WHERE artifact_id=? AND event_id=? AND event_type IN ('plan_captured','plan_revised')",
      use.artifact_id,
      use.plan_event_id
    )
  )
    missing('A task use is keyed to a retained plan event of its artifact');
  if (!retainedExpectationRevision(view, use.target))
    missing('The task use names an expectation revision this history does not hold');
  if (
    use.exception_id !== null &&
    !view.get(
      'SELECT exception_id FROM knowledge_exceptions WHERE exception_id=?',
      use.exception_id
    )
  )
    missing('The task use cites an exception this history does not hold');
}

function storedUse(
  transaction: ProjectSettlement,
  use: TaskUseFields,
  writingOperationId: string,
  discovery: TaskUseDiscovery | null
): TaskUse {
  const planEventOperationId = eventOperation(transaction, use.artifact_id, use.plan_event_id);
  if (planEventOperationId === null)
    integrity(
      'The plan event this use names has no retained artifact revision; preserve history for explicit repair'
    );
  const selected = taskUseSelection({
    plan_event_operation_id: planEventOperationId,
    writing_operation_id: writingOperationId,
    discovery,
  });
  if (!selected.ok)
    invalid(
      'A use recorded after its plan event names who found the connection and when; a later connection is no original selection'
    );
  return parsed(TaskUseSchema, { ...use, selection: selected.selection }, 'A task use');
}

/**
 * The in-transaction writer, so the settlement that publishes a plan event records the uses that
 * event selected in the same operation.
 *
 * The writing operation is the one `runProjectOperation` hands its settle callback, never a
 * caller's argument: whether a use was an original selection is a fact about which operation
 * wrote it, so no caller can name an operation that wrote nothing and have the row read as
 * selected with the plan.
 */
export function settleProjectTaskUses(
  transaction: ProjectSettlement,
  operation: Readonly<ProjectOperation>,
  prepared: PreparedTaskUses,
  discovery: TaskUseDiscovery | null
): TaskUseRecording {
  const writingOperationId = operation.operationId;
  const accepted = acceptedPlanTaskUses.get(prepared);
  if (accepted && (accepted.operationId !== writingOperationId || discovery !== null))
    integrity('Accepted plan task uses belong only to their exact original plan settlement');
  const uses = (accepted?.uses ?? prepared.uses).map((authored) => {
    requireReferences(transaction, authored);
    const use = storedUse(transaction, authored, writingOperationId, discovery);
    // The retained command receipt already accepted these exact authored fields. Derived
    // selection fields are schema-checked above and cannot turn them into new authored input.
    const record = accepted ? canonicalRecord(use) : authoredRecord(use, prepared.allow);
    const common = {
      artifactId: use.artifact_id,
      planEventId: use.plan_event_id,
      targetRevisionId: use.target.revision_id,
      role: use.role,
      selectionKind: use.selection.kind,
    };
    const existing = retainedRow(transaction, authored);
    if (existing) return recordedUse(authored, existing);
    const found = use.selection.kind === 'connected_later' ? use.selection : null;
    const [foundKind, foundBy, foundBasis] =
      found === null ? [null, null, null] : attributionColumns(found.discovered_by);
    transaction.run(
      `INSERT INTO task_uses (artifact_id, plan_event_id, target_kind, target_id, target_revision_id,
         role, step_id, criterion_id, exception_id, selection_kind, discovered_at, discovered_kind,
         discovered_by, discovered_by_basis, record_bytes, record_sha256, operation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      use.artifact_id,
      use.plan_event_id,
      use.target.kind,
      use.target.entity_id,
      use.target.revision_id,
      use.role,
      use.local === null ? null : use.local.step_id,
      use.local === null ? null : use.local.criterion_id,
      use.exception_id,
      use.selection.kind,
      found === null ? null : found.discovered_at,
      foundKind,
      foundBy,
      foundBasis,
      record.bytes,
      record.sha256,
      writingOperationId
    );
    return { ...common, recordSha256: record.sha256, published: true };
  });
  return { uses };
}

export async function recordProjectTaskUses(
  handle: ProjectDatabase,
  input: RecordTaskUses,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const discovery = prepareTaskUseDiscovery(input.discovery);
  const prepared = prepareProjectTaskUses(input.uses, input.secretAllow, discovery);
  // Every authored field of every use, and the discovery offered for them, take part in retry
  // equality; the selection the store derives from them does not.
  const payload = {
    uses: prepared.authoredSha256.slice(),
    discovery:
      discovery === null
        ? null
        : { at: discovery.discovered_at, by: attributionColumns(discovery.discovered_by) },
  };
  const op = {
    operationId,
    kind: 'knowledge.task.uses.record',
    target: {
      uses: prepared.uses.map((use) => ({
        artifactId: use.artifact_id,
        planEventId: use.plan_event_id,
        targetRevisionId: use.target.revision_id,
      })),
    },
    payload,
    expectedState: null,
    // A task use records what a task did with a rule, not a change to the rule.
    intentChange: false,
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  const held = handle.read((view) =>
    prepared.uses.map((use) => {
      requireReferences(view, use);
      return retainedUse(view, use);
    })
  ).value;
  // A repeat of the same use is the same use, so a call every one of whose uses is already
  // recorded runs no operation: no receipt, and neither counter moves.
  if (held.every((entry) => entry !== null))
    return committedNothing(handle, { uses: held as TaskUseRecording['uses'] });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling) =>
      settleProjectTaskUses(transaction, settling, prepared, discovery),
    options
  );
}

export interface ProjectTaskUseRow {
  readonly artifactId: string;
  readonly planEventId: string;
  readonly target: { kind: string; entityId: string; revisionId: string };
  readonly role: string;
  readonly stepId: string | null;
  readonly criterionId: string | null;
  readonly exceptionId: string | null;
  readonly selectionKind: string;
  readonly discoveredAt: string | null;
  /** Null for a use selected with its plan; an actor or a detector for one connected later. */
  readonly discoveredBy: { kind: string; name: string | null; basis: string | null } | null;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

export function listProjectTaskUses(
  view: ProjectReadView,
  planEventId: string
): ProjectTaskUseRow[] {
  return view
    .all<{
      artifact_id: string;
      plan_event_id: string;
      target_kind: string;
      target_id: string;
      target_revision_id: string;
      role: string;
      step_id: string | null;
      criterion_id: string | null;
      exception_id: string | null;
      selection_kind: string;
      discovered_at: string | null;
      discovered_kind: string | null;
      discovered_by: string | null;
      discovered_by_basis: string | null;
      record_hex: string;
      record_sha256: string;
      operation_id: string;
    }>(
      'SELECT artifact_id, plan_event_id, target_kind, target_id, target_revision_id, role, step_id, criterion_id, exception_id, selection_kind, discovered_at, discovered_kind, discovered_by, discovered_by_basis, hex(record_bytes) AS record_hex, record_sha256, operation_id FROM task_uses WHERE plan_event_id=? ORDER BY rowid',
      planEventId
    )
    .map((row) => ({
      artifactId: row.artifact_id,
      planEventId: row.plan_event_id,
      target: {
        kind: row.target_kind,
        entityId: row.target_id,
        revisionId: row.target_revision_id,
      },
      role: row.role,
      stepId: row.step_id,
      criterionId: row.criterion_id,
      exceptionId: row.exception_id,
      selectionKind: row.selection_kind,
      discoveredAt: row.discovered_at,
      discoveredBy:
        row.discovered_kind === null
          ? null
          : { kind: row.discovered_kind, name: row.discovered_by, basis: row.discovered_by_basis },
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
}
