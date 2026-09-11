// Typed writers and readers for the exact-revision families. They are deliberately not exported
// from any package barrel: the storage gate needs approved data APIs, not a public surface, and
// the behavioural writers and readers belong to the separately gated correction branch.
//
// Each writer prepares its row outside the transaction — validating input, resolving the exact
// endpoints it names and hashing the authored bytes — and settles inside the accepted operation
// runner, so a stale precondition refuses rather than retargets.
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type ProjectOperationOptions,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';

export type ExactRevisionEntityKind = 'claim' | 'decision';
export type ExactRevisionRelation = 'supersedes' | 'challenges';
export type ExactRevisionScope =
  | { readonly kind: 'project' }
  | { readonly kind: 'branch'; readonly branch: string };

/** The frozen occurrence identity of an existing record: source event, field path and position. */
export interface RecordOccurrence {
  readonly sourceEventId: string;
  readonly fieldPath: string;
  readonly position: number;
}

export interface CriterionLineageInput {
  readonly operationId: string;
  readonly occurrence: RecordOccurrence;
  readonly criterionId: string;
  readonly stepId: string;
  readonly artifactId: string;
  readonly artifactGeneration: number;
  readonly lineage: 'added' | 'carried' | 'rewritten';
  readonly priorCriterionId: string | null;
  readonly scope: ExactRevisionScope | { readonly kind: 'artifact'; readonly artifactId: string };
  readonly record: unknown;
}

export interface ClaimRevisionInput {
  readonly operationId: string;
  readonly claimId: string;
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
  readonly occurrence: RecordOccurrence;
  readonly assertedBy: string;
  readonly assertionSource: unknown;
  /** Agent-supplied evidence about a run. It is never proof and never becomes proof. */
  readonly agentReportedVerification: unknown | null;
  readonly record: unknown;
}

export interface DecisionRevisionInput {
  readonly operationId: string;
  readonly decisionId: string;
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
  readonly occurrence: RecordOccurrence;
  readonly authoredBy: string;
  readonly alternativeCount: number;
  readonly record: unknown;
}

export interface RecordRelationshipInput {
  readonly operationId: string;
  readonly relationshipId: string;
  readonly relation: ExactRevisionRelation;
  readonly from: {
    readonly kind: ExactRevisionEntityKind;
    readonly entityId: string;
    readonly revisionId: string;
  };
  readonly to: {
    readonly kind: ExactRevisionEntityKind;
    readonly entityId: string;
    readonly revisionId: string;
  };
  readonly scope: ExactRevisionScope;
  readonly attribution: { readonly kind: 'author' | 'detector'; readonly id: string };
  readonly sourceRefs: readonly string[];
}

export interface AdoptionInput {
  readonly operationId: string;
  readonly adoptionId: string;
  readonly target:
    | {
        readonly kind: ExactRevisionEntityKind;
        readonly entityId: string;
        readonly revisionId: string;
      }
    | { readonly kind: 'relationship'; readonly relationshipId: string };
  readonly approver: string;
  readonly approvedAt: string;
  readonly scope: ExactRevisionScope;
  readonly sourceRefs: readonly string[];
}

export interface AssessmentInput {
  readonly operationId: string;
  readonly assessmentId: string;
  readonly claimId: string;
  readonly claimRevisionId: string;
  readonly assessedBy: string;
  /** The counters the caller observed when it read the input this assessment is about. */
  readonly observed: { readonly writeSequence: number; readonly intentChangeCounter: number };
  readonly verification: unknown;
  readonly record: unknown;
}

export interface CriterionLineageRow {
  readonly occurrence: RecordOccurrence;
  readonly criterionId: string;
  readonly stepId: string;
  readonly artifactId: string;
  readonly artifactGeneration: number;
  readonly lineage: string;
  readonly priorCriterionId: string | null;
  readonly scopeKind: string;
  readonly scopeValue: string | null;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

export interface EntityRevisionRow {
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
  readonly occurrence: RecordOccurrence;
  readonly attributedTo: string;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

export interface ClaimRevisionRow extends EntityRevisionRow {
  readonly assertionSourceJson: string;
  readonly verificationJson: string | null;
  readonly verificationProvenance: string | null;
}

export interface DecisionRevisionRow extends EntityRevisionRow {
  readonly alternativeCount: number;
}

export interface RecordRelationshipRow {
  readonly relationshipId: string;
  readonly relation: string;
  readonly from: { kind: string; entityId: string; revisionId: string };
  readonly to: { kind: string; entityId: string; revisionId: string };
  readonly scopeKind: string;
  readonly scopeValue: string | null;
  readonly attribution: { kind: string; id: string };
  readonly sourceRefs: readonly string[];
  readonly operationId: string;
}

export interface AdoptionRow {
  readonly adoptionId: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly targetRevisionId: string;
  readonly approver: string;
  readonly approvedAt: string;
  readonly scopeKind: string;
  readonly scopeValue: string | null;
  readonly sourceRefs: readonly string[];
  readonly operationId: string;
}

export interface AssessmentRow {
  readonly assessmentId: string;
  readonly claimId: string;
  readonly claimRevisionId: string;
  readonly assessedBy: string;
  readonly observedWriteSequence: number;
  readonly observedIntentCounter: number;
  readonly verificationJson: string;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

const RELATIONS: readonly string[] = ['supersedes', 'challenges'];

function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}

function missing(message: string): never {
  throw new ProjectDatabaseError('HISTORY_MISSING', message);
}

function taken(message: string): never {
  throw new ProjectDatabaseError('IDEMPOTENCY_CONFLICT', message);
}

function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200)
    invalid(`Provide the existing ${label}`);
  return value;
}

function operation(value: string): string {
  if (!isUuidV7(value)) invalid('Provide an original operation UUID');
  return value;
}

function occurrence(value: RecordOccurrence): RecordOccurrence {
  if (!Number.isSafeInteger(value.position) || value.position < 0)
    invalid('Occurrence identity needs a non-negative position');
  return {
    sourceEventId: identifier(value.sourceEventId, 'source event ID'),
    fieldPath: identifier(value.fieldPath, 'field path'),
    position: value.position,
  };
}

function scopeColumns(scope: CriterionLineageInput['scope']): [string, string | null] {
  if (scope.kind === 'project') return ['project', null];
  if (scope.kind === 'branch') return ['branch', identifier(scope.branch, 'branch scope')];
  if (scope.kind === 'artifact')
    return ['artifact', identifier(scope.artifactId, 'scope artifact')];
  invalid('An applicability scope is project, branch or artifact');
}

function authored(record: unknown): { bytes: Buffer; sha256: string } {
  const json = canonicalJson(record);
  if (json === undefined) invalid('An authored payload must be serializable');
  const bytes = Buffer.from(json);
  return { bytes, sha256: digest(bytes) };
}

function refs(sourceRefs: readonly string[]): string {
  if (!Array.isArray(sourceRefs) || sourceRefs.some((ref) => typeof ref !== 'string'))
    invalid('Source references are a list of strings');
  return canonicalJson([...sourceRefs])!;
}

/**
 * An interrupted publication retries by its original operation ID. The receipt is the authority
 * on what it did, so a retry goes straight to the runner and never re-runs the preparation
 * checks, which would read the row the original attempt already wrote and refuse it as a
 * duplicate.
 */
function retriedOperation(handle: ProjectDatabase, operationId: string): boolean {
  return !!handle.read((view) =>
    view.get('SELECT operation_id FROM operations WHERE operation_id=?', operationId)
  ).value;
}

function replay(
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

function revisionExists(
  view: ProjectReadView,
  kind: string,
  entityId: string,
  revisionId: string
): boolean {
  if (kind === 'claim')
    return !!view.get(
      'SELECT revision_id FROM claim_revisions WHERE claim_id=? AND revision_id=?',
      entityId,
      revisionId
    );
  if (kind === 'decision')
    return !!view.get(
      'SELECT revision_id FROM decision_revisions WHERE decision_id=? AND revision_id=?',
      entityId,
      revisionId
    );
  invalid('An endpoint is a claim or a decision revision');
}

export async function publishProjectCriterionLineage(
  handle: ProjectDatabase,
  input: CriterionLineageInput,
  options: ProjectOperationOptions = {}
) {
  const operationId = operation(input.operationId);
  const key = occurrence(input.occurrence);
  const criterionId = identifier(input.criterionId, 'criterion ID');
  const stepId = identifier(input.stepId, 'step ID');
  const artifactId = identifier(input.artifactId, 'artifact ID');
  if (!Number.isSafeInteger(input.artifactGeneration) || input.artifactGeneration < 1)
    invalid('Name the exact artifact revision the criterion was recorded in');
  if (!['added', 'carried', 'rewritten'].includes(input.lineage))
    invalid('Criterion lineage is added, carried or rewritten');
  if ((input.lineage === 'added') !== (input.priorCriterionId === null))
    invalid('Only a carried or rewritten criterion has a prior criterion ID');
  const [scopeKind, scopeValue] = scopeColumns(input.scope);
  const record = authored(input.record);
  const op = {
    operationId,
    kind: 'criterion.lineage.publish',
    target: { criterionId, artifactId, generation: input.artifactGeneration },
    // Every authored field the row stores is in the retry comparison, so a retry under this
    // operation id with any of them altered conflicts rather than replaying the prior success.
    payload: {
      occurrence: { ...key },
      stepId,
      lineage: input.lineage,
      priorCriterionId: input.priorCriterionId,
      scope: { kind: scopeKind, value: scopeValue },
      sha256: record.sha256,
    },
    expectedState: null,
    intentChange: true,
  } as const;
  if (retriedOperation(handle, operationId)) return replay(handle, op, options);
  handle.read((view) => {
    if (
      !view.get(
        'SELECT event_id FROM artifact_events WHERE artifact_id=? AND event_id=?',
        artifactId,
        key.sourceEventId
      )
    )
      missing('The criterion lineage source event is not retained in this history');
    if (
      view.get(
        'SELECT criterion_id FROM criterion_lineage WHERE source_event_id=? AND field_path=? AND position=?',
        key.sourceEventId,
        key.fieldPath,
        key.position
      )
    )
      taken('That criterion occurrence already belongs to a retained lineage row');
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement) => {
      transaction.run(
        'INSERT INTO criterion_lineage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        key.sourceEventId,
        key.fieldPath,
        key.position,
        criterionId,
        stepId,
        artifactId,
        input.artifactGeneration,
        input.lineage,
        input.priorCriterionId,
        scopeKind,
        scopeValue,
        record.bytes,
        record.sha256,
        operationId
      );
      return { criterionId, occurrence: { ...key }, recordSha256: record.sha256 };
    },
    options
  );
}

export async function publishProjectClaimRevision(
  handle: ProjectDatabase,
  input: ClaimRevisionInput,
  options: ProjectOperationOptions = {}
) {
  const operationId = operation(input.operationId);
  const claimId = identifier(input.claimId, 'claim ID');
  const revisionId = identifier(input.revisionId, 'claim revision ID');
  const key = occurrence(input.occurrence);
  const assertedBy = identifier(input.assertedBy, 'asserting author');
  const source = canonicalJson(input.assertionSource);
  if (source === undefined) invalid('A claim revision records its exact assertion source');
  const verification =
    input.agentReportedVerification === null
      ? null
      : canonicalJson(input.agentReportedVerification);
  const record = authored(input.record);
  const op = {
    operationId,
    kind: 'claim.revision.publish',
    target: { claimId, revisionId },
    payload: {
      occurrence: { ...key },
      assertedBy,
      assertionSource: source,
      verification,
      sha256: record.sha256,
    },
    expectedState: { previousRevisionId: input.previousRevisionId },
    intentChange: true,
  } as const;
  if (retriedOperation(handle, operationId)) return replay(handle, op, options);
  const first = handle.read((view) => {
    if (view.get('SELECT revision_id FROM claim_revisions WHERE revision_id=?', revisionId))
      taken('That claim revision ID already belongs to retained history');
    if (
      view.get(
        'SELECT revision_id FROM claim_revisions WHERE source_event_id=? AND field_path=? AND position=?',
        key.sourceEventId,
        key.fieldPath,
        key.position
      )
    )
      taken('That occurrence already belongs to a retained claim revision');
    const tip = view.get<{ revision_id: string }>(
      'SELECT revision_id FROM claim_revisions WHERE claim_id=? AND revision_id NOT IN (SELECT previous_revision_id FROM claim_revisions WHERE claim_id=? AND previous_revision_id IS NOT NULL)',
      claimId,
      claimId
    );
    if (input.previousRevisionId === null) {
      if (tip) invalid('A continuing claim already exists; name the revision this one follows');
      return true;
    }
    if (!tip || tip.revision_id !== input.previousRevisionId)
      invalid('A claim revision continues the latest retained revision of its claim');
    return false;
  }).value;
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement) => {
      transaction.run(
        'INSERT INTO claim_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        revisionId,
        claimId,
        input.previousRevisionId,
        key.sourceEventId,
        key.fieldPath,
        key.position,
        assertedBy,
        source,
        verification,
        verification === null ? null : 'agent_reported',
        record.bytes,
        record.sha256,
        operationId
      );
      if (first)
        transaction.run('INSERT INTO claims VALUES (?,?,?)', claimId, revisionId, operationId);
      return { claimId, revisionId, recordSha256: record.sha256 };
    },
    options
  );
}

export async function publishProjectDecisionRevision(
  handle: ProjectDatabase,
  input: DecisionRevisionInput,
  options: ProjectOperationOptions = {}
) {
  const operationId = operation(input.operationId);
  const decisionId = identifier(input.decisionId, 'decision ID');
  const revisionId = identifier(input.revisionId, 'decision revision ID');
  const key = occurrence(input.occurrence);
  const authoredBy = identifier(input.authoredBy, 'authoring agent');
  if (!Number.isSafeInteger(input.alternativeCount) || input.alternativeCount < 0)
    invalid('An alternative count is a non-negative integer');
  const record = authored(input.record);
  const op = {
    operationId,
    kind: 'decision.revision.publish',
    target: { decisionId, revisionId },
    payload: {
      occurrence: { ...key },
      authoredBy,
      alternativeCount: input.alternativeCount,
      sha256: record.sha256,
    },
    expectedState: { previousRevisionId: input.previousRevisionId },
    intentChange: true,
  } as const;
  if (retriedOperation(handle, operationId)) return replay(handle, op, options);
  const first = handle.read((view) => {
    if (view.get('SELECT revision_id FROM decision_revisions WHERE revision_id=?', revisionId))
      taken('That decision revision ID already belongs to retained history');
    if (
      view.get(
        'SELECT revision_id FROM decision_revisions WHERE source_event_id=? AND field_path=? AND position=?',
        key.sourceEventId,
        key.fieldPath,
        key.position
      )
    )
      taken('That occurrence already belongs to a retained decision revision');
    const tip = view.get<{ revision_id: string }>(
      'SELECT revision_id FROM decision_revisions WHERE decision_id=? AND revision_id NOT IN (SELECT previous_revision_id FROM decision_revisions WHERE decision_id=? AND previous_revision_id IS NOT NULL)',
      decisionId,
      decisionId
    );
    if (input.previousRevisionId === null) {
      if (tip) invalid('A continuing decision already exists; name the revision this one follows');
      return true;
    }
    if (!tip || tip.revision_id !== input.previousRevisionId)
      invalid('A decision revision continues the latest retained revision of its decision');
    return false;
  }).value;
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement) => {
      transaction.run(
        'INSERT INTO decision_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        revisionId,
        decisionId,
        input.previousRevisionId,
        key.sourceEventId,
        key.fieldPath,
        key.position,
        authoredBy,
        input.alternativeCount,
        record.bytes,
        record.sha256,
        operationId
      );
      if (first)
        transaction.run(
          'INSERT INTO decisions VALUES (?,?,?)',
          decisionId,
          revisionId,
          operationId
        );
      return { decisionId, revisionId, recordSha256: record.sha256 };
    },
    options
  );
}

export async function publishProjectRecordRelationship(
  handle: ProjectDatabase,
  input: RecordRelationshipInput,
  options: ProjectOperationOptions = {}
) {
  const operationId = operation(input.operationId);
  const relationshipId = identifier(input.relationshipId, 'relationship ID');
  if (!RELATIONS.includes(input.relation))
    invalid('Phase 1 relationships are supersedes or challenges');
  const from = {
    kind: input.from.kind,
    entityId: identifier(input.from.entityId, 'from entity ID'),
    revisionId: identifier(input.from.revisionId, 'from revision ID'),
  };
  const to = {
    kind: input.to.kind,
    entityId: identifier(input.to.entityId, 'to entity ID'),
    revisionId: identifier(input.to.revisionId, 'to revision ID'),
  };
  if (from.revisionId === to.revisionId) invalid('A relationship joins two distinct revisions');
  const [scopeKind, scopeValue] = scopeColumns(input.scope);
  const attributedTo = identifier(input.attribution.id, 'author or detector');
  if (!['author', 'detector'].includes(input.attribution.kind))
    invalid('A relationship is attributed to an author or a detector');
  const sourceRefs = refs(input.sourceRefs);
  const op = {
    operationId,
    kind: 'record.relationship.publish',
    target: { relationshipId },
    payload: {
      relation: input.relation,
      from: { ...from },
      to: { ...to },
      scope: { kind: scopeKind, value: scopeValue },
      attribution: { kind: input.attribution.kind, id: attributedTo },
      sourceRefs,
    },
    expectedState: null,
    intentChange: true,
  } as const;
  if (retriedOperation(handle, operationId)) return replay(handle, op, options);
  handle.read((view) => {
    if (
      view.get(
        'SELECT relationship_id FROM record_relationships WHERE relationship_id=?',
        relationshipId
      )
    )
      taken('That relationship ID already belongs to retained history');
    if (!revisionExists(view, from.kind, from.entityId, from.revisionId))
      missing('The relationship names a from endpoint revision this history does not hold');
    if (!revisionExists(view, to.kind, to.entityId, to.revisionId))
      missing('The relationship names a to endpoint revision this history does not hold');
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement) => {
      transaction.run(
        'INSERT INTO record_relationships VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        relationshipId,
        input.relation,
        from.kind,
        from.entityId,
        from.revisionId,
        to.kind,
        to.entityId,
        to.revisionId,
        scopeKind,
        scopeValue,
        input.attribution.kind,
        attributedTo,
        sourceRefs,
        operationId
      );
      return { relationshipId, relation: input.relation };
    },
    options
  );
}

export async function publishProjectAdoption(
  handle: ProjectDatabase,
  input: AdoptionInput,
  options: ProjectOperationOptions = {}
) {
  const operationId = operation(input.operationId);
  const adoptionId = identifier(input.adoptionId, 'adoption ID');
  const approver = identifier(input.approver, 'approver');
  const approvedAt = identifier(input.approvedAt, 'approval time');
  const [scopeKind, scopeValue] = scopeColumns(input.scope);
  const sourceRefs = refs(input.sourceRefs);
  const target =
    input.target.kind === 'relationship'
      ? {
          kind: 'relationship',
          id: identifier(input.target.relationshipId, 'relationship ID'),
          revisionId: identifier(input.target.relationshipId, 'relationship ID'),
        }
      : {
          kind: input.target.kind,
          id: identifier(input.target.entityId, 'approval target ID'),
          revisionId: identifier(input.target.revisionId, 'approval target revision ID'),
        };
  const op = {
    operationId,
    kind: 'adoption.publish',
    // The adoption's own id is in the target too: without it a retry under this operation id with
    // a changed adoption id would match on the approval target alone and replay the prior adoption.
    target: { adoptionId, kind: target.kind, id: target.id, revisionId: target.revisionId },
    payload: {
      approver,
      approvedAt,
      scope: { kind: scopeKind, value: scopeValue },
      sourceRefs,
    },
    expectedState: null,
    intentChange: true,
  } as const;
  if (retriedOperation(handle, operationId)) return replay(handle, op, options);
  handle.read((view) => {
    if (view.get('SELECT adoption_id FROM adoptions WHERE adoption_id=?', adoptionId))
      taken('That adoption ID already belongs to retained history');
    const present =
      target.kind === 'relationship'
        ? !!view.get(
            'SELECT relationship_id FROM record_relationships WHERE relationship_id=?',
            target.id
          )
        : revisionExists(view, target.kind, target.id, target.revisionId);
    if (!present)
      missing('The adoption names an approval target revision this history does not hold');
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement) => {
      transaction.run(
        'INSERT INTO adoptions VALUES (?,?,?,?,?,?,?,?,?,?)',
        adoptionId,
        target.kind,
        target.id,
        target.revisionId,
        approver,
        approvedAt,
        scopeKind,
        scopeValue,
        sourceRefs,
        operationId
      );
      return { adoptionId, target: { ...target } };
    },
    options
  );
}

export async function publishProjectAssessment(
  handle: ProjectDatabase,
  input: AssessmentInput,
  options: ProjectOperationOptions = {}
) {
  const operationId = operation(input.operationId);
  const assessmentId = identifier(input.assessmentId, 'assessment ID');
  const claimId = identifier(input.claimId, 'claim ID');
  const claimRevisionId = identifier(input.claimRevisionId, 'claim revision ID');
  const assessedBy = identifier(input.assessedBy, 'assessing agent');
  const verification = canonicalJson(input.verification);
  if (verification === undefined) invalid('An assessment records its existing verification fields');
  const observed = input.observed;
  if (
    !Number.isSafeInteger(observed?.writeSequence) ||
    observed.writeSequence < 0 ||
    !Number.isSafeInteger(observed.intentChangeCounter) ||
    observed.intentChangeCounter < 0
  )
    invalid('An assessment stamps the counters observed when its input was read');
  const record = authored(input.record);
  // Publishing an assessment advances the write sequence but never the intent-change counter, so
  // a later reader can tell whether intent moved after the assessment was taken.
  const op = {
    operationId,
    kind: 'assessment.publish',
    target: { assessmentId, claimId, claimRevisionId },
    payload: {
      assessedBy,
      observedWriteSequence: observed.writeSequence,
      observedIntentCounter: observed.intentChangeCounter,
      verification,
      sha256: record.sha256,
    },
    expectedState: null,
    intentChange: false,
  } as const;
  if (retriedOperation(handle, operationId)) return replay(handle, op, options);
  const current = handle.read((view) => {
    if (view.get('SELECT assessment_id FROM assessments WHERE assessment_id=?', assessmentId))
      taken('That assessment ID already belongs to retained history');
    if (
      !view.get(
        'SELECT revision_id FROM claim_revisions WHERE claim_id=? AND revision_id=?',
        claimId,
        claimRevisionId
      )
    )
      missing('The assessment names a claim revision this history does not hold');
    return null;
  }).counters;
  if (
    observed.writeSequence > current.writeSequence ||
    observed.intentChangeCounter > current.intentChangeCounter
  )
    invalid('An assessment cannot record counters this history has not reached');
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement) => {
      transaction.run(
        'INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        assessmentId,
        claimId,
        claimRevisionId,
        assessedBy,
        observed.writeSequence,
        observed.intentChangeCounter,
        verification,
        'agent_reported',
        record.bytes,
        record.sha256,
        operationId
      );
      return {
        assessmentId,
        observedWriteSequence: observed.writeSequence,
        observedIntentCounter: observed.intentChangeCounter,
      };
    },
    options
  );
}

interface StoredOccurrence {
  source_event_id: string;
  field_path: string;
  position: number;
}

const storedOccurrence = (row: StoredOccurrence): RecordOccurrence => ({
  sourceEventId: row.source_event_id,
  fieldPath: row.field_path,
  position: row.position,
});

export function readProjectCriterionLineage(
  view: ProjectReadView,
  criterionId: string
): CriterionLineageRow[] {
  return view
    .all<
      StoredOccurrence & {
        criterion_id: string;
        step_id: string;
        artifact_id: string;
        artifact_generation: number;
        lineage: string;
        prior_criterion_id: string | null;
        scope_kind: string;
        scope_value: string | null;
        record_hex: string;
        record_sha256: string;
        operation_id: string;
      }
    >(
      'SELECT source_event_id, field_path, position, criterion_id, step_id, artifact_id, artifact_generation, lineage, prior_criterion_id, scope_kind, scope_value, hex(record_bytes) AS record_hex, record_sha256, operation_id FROM criterion_lineage WHERE criterion_id=? ORDER BY source_event_id, field_path, position',
      criterionId
    )
    .map((row) => ({
      occurrence: storedOccurrence(row),
      criterionId: row.criterion_id,
      stepId: row.step_id,
      artifactId: row.artifact_id,
      artifactGeneration: row.artifact_generation,
      lineage: row.lineage,
      priorCriterionId: row.prior_criterion_id,
      scopeKind: row.scope_kind,
      scopeValue: row.scope_value,
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
}

export function readProjectClaim(
  view: ProjectReadView,
  claimId: string
): { claimId: string; firstRevisionId: string; revisions: ClaimRevisionRow[] } | null {
  const claim = view.get<{ claim_id: string; first_revision_id: string }>(
    'SELECT claim_id, first_revision_id FROM claims WHERE claim_id=?',
    claimId
  );
  if (!claim) return null;
  const revisions = view
    .all<
      StoredOccurrence & {
        revision_id: string;
        previous_revision_id: string | null;
        asserted_by: string;
        assertion_source_json: string;
        verification_json: string | null;
        verification_provenance: string | null;
        record_hex: string;
        record_sha256: string;
        operation_id: string;
      }
    >(
      'SELECT revision_id, previous_revision_id, source_event_id, field_path, position, asserted_by, assertion_source_json, verification_json, verification_provenance, hex(record_bytes) AS record_hex, record_sha256, operation_id FROM claim_revisions WHERE claim_id=? ORDER BY rowid',
      claimId
    )
    .map((row) => ({
      revisionId: row.revision_id,
      previousRevisionId: row.previous_revision_id,
      occurrence: storedOccurrence(row),
      attributedTo: row.asserted_by,
      assertionSourceJson: row.assertion_source_json,
      verificationJson: row.verification_json,
      verificationProvenance: row.verification_provenance,
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
  return { claimId: claim.claim_id, firstRevisionId: claim.first_revision_id, revisions };
}

export function readProjectDecision(
  view: ProjectReadView,
  decisionId: string
): { decisionId: string; firstRevisionId: string; revisions: DecisionRevisionRow[] } | null {
  const decision = view.get<{ decision_id: string; first_revision_id: string }>(
    'SELECT decision_id, first_revision_id FROM decisions WHERE decision_id=?',
    decisionId
  );
  if (!decision) return null;
  const revisions = view
    .all<
      StoredOccurrence & {
        revision_id: string;
        previous_revision_id: string | null;
        authored_by: string;
        alternative_count: number;
        record_hex: string;
        record_sha256: string;
        operation_id: string;
      }
    >(
      'SELECT revision_id, previous_revision_id, source_event_id, field_path, position, authored_by, alternative_count, hex(record_bytes) AS record_hex, record_sha256, operation_id FROM decision_revisions WHERE decision_id=? ORDER BY rowid',
      decisionId
    )
    .map((row) => ({
      revisionId: row.revision_id,
      previousRevisionId: row.previous_revision_id,
      occurrence: storedOccurrence(row),
      attributedTo: row.authored_by,
      alternativeCount: row.alternative_count,
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
  return {
    decisionId: decision.decision_id,
    firstRevisionId: decision.first_revision_id,
    revisions,
  };
}

export function listProjectRecordRelationships(
  view: ProjectReadView,
  selection: { toRevisionId?: string; fromRevisionId?: string } = {}
): RecordRelationshipRow[] {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  if (selection.toRevisionId !== undefined) {
    clauses.push('to_revision_id=?');
    parameters.push(selection.toRevisionId);
  }
  if (selection.fromRevisionId !== undefined) {
    clauses.push('from_revision_id=?');
    parameters.push(selection.fromRevisionId);
  }
  return view
    .all<{
      relationship_id: string;
      relation: string;
      from_entity_kind: string;
      from_entity_id: string;
      from_revision_id: string;
      to_entity_kind: string;
      to_entity_id: string;
      to_revision_id: string;
      scope_kind: string;
      scope_value: string | null;
      attributed_kind: string;
      attributed_to: string;
      source_refs_json: string;
      operation_id: string;
    }>(
      `SELECT * FROM record_relationships${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY relationship_id`,
      ...parameters
    )
    .map((row) => ({
      relationshipId: row.relationship_id,
      relation: row.relation,
      from: {
        kind: row.from_entity_kind,
        entityId: row.from_entity_id,
        revisionId: row.from_revision_id,
      },
      to: { kind: row.to_entity_kind, entityId: row.to_entity_id, revisionId: row.to_revision_id },
      scopeKind: row.scope_kind,
      scopeValue: row.scope_value,
      attribution: { kind: row.attributed_kind, id: row.attributed_to },
      sourceRefs: JSON.parse(row.source_refs_json) as string[],
      operationId: row.operation_id,
    }));
}

export function listProjectAdoptions(
  view: ProjectReadView,
  selection: { targetRevisionId?: string } = {}
): AdoptionRow[] {
  return view
    .all<{
      adoption_id: string;
      target_kind: string;
      target_id: string;
      target_revision_id: string;
      approver: string;
      approved_at: string;
      scope_kind: string;
      scope_value: string | null;
      source_refs_json: string;
      operation_id: string;
    }>(
      `SELECT * FROM adoptions${selection.targetRevisionId === undefined ? '' : ' WHERE target_revision_id=?'} ORDER BY adoption_id`,
      ...(selection.targetRevisionId === undefined ? [] : [selection.targetRevisionId])
    )
    .map((row) => ({
      adoptionId: row.adoption_id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      targetRevisionId: row.target_revision_id,
      approver: row.approver,
      approvedAt: row.approved_at,
      scopeKind: row.scope_kind,
      scopeValue: row.scope_value,
      sourceRefs: JSON.parse(row.source_refs_json) as string[],
      operationId: row.operation_id,
    }));
}

export function listProjectAssessments(view: ProjectReadView, claimId: string): AssessmentRow[] {
  return view
    .all<{
      assessment_id: string;
      claim_id: string;
      claim_revision_id: string;
      assessed_by: string;
      observed_write_sequence: number;
      observed_intent_counter: number;
      verification_json: string;
      record_hex: string;
      record_sha256: string;
      operation_id: string;
    }>(
      'SELECT assessment_id, claim_id, claim_revision_id, assessed_by, observed_write_sequence, observed_intent_counter, verification_json, hex(record_bytes) AS record_hex, record_sha256, operation_id FROM assessments WHERE claim_id=? ORDER BY assessment_id',
      claimId
    )
    .map((row) => ({
      assessmentId: row.assessment_id,
      claimId: row.claim_id,
      claimRevisionId: row.claim_revision_id,
      assessedBy: row.assessed_by,
      observedWriteSequence: row.observed_write_sequence,
      observedIntentCounter: row.observed_intent_counter,
      verificationJson: row.verification_json,
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
}
