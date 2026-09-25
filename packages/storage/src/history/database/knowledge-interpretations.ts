import { createHash } from 'node:crypto';

import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { readRetainedCaptureField } from './knowledge-capture-fields.js';
import {
  actingField,
  actorColumns,
  type AuthoredRecord,
  authoredRecord,
  committedNothing,
  integrity,
  invalid,
  LabelSchema,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  publishUnlessRetained,
  replayOperation,
  requireRetainedSources,
  retriedOperation,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import type { ProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type Attribution,
  type ClaimRevision,
  ClaimRevisionSchema,
  type DecisionRevision,
  DecisionRevisionSchema,
  type InterpretationSupport,
  type KnowledgeEquivalenceDisposition,
  knowledgeEquivalenceDispositionId,
  KnowledgeEquivalenceDispositionSchema,
  type KnowledgeInterpretation,
  knowledgeInterpretationId,
  KnowledgeInterpretationSchema,
  type RequirementIdentity,
  RequirementIdentitySchema,
  type RequirementRevision,
  RequirementRevisionSchema,
  type SourceSelector,
} from '../../schema/knowledge-contract.js';
import type { ScheduledInterpretationSegment } from '../../schema/knowledge-processing-contract.js';
import { prepareInterpretationText } from '../../text/interpretation-preparation.js';

export type CandidateRevisionKind = 'requirement' | 'decision' | 'claim';

export interface ProjectCandidateRevisionProbe {
  kind: CandidateRevisionKind;
  identity?: unknown | null;
  record: unknown;
}

export interface ProjectCandidateRevisionCompatibility {
  target: { kind: CandidateRevisionKind; entity_id: string; revision_id: string };
  status: 'available' | 'compatible' | 'collision';
}

export interface PreparedKnowledgeInterpretation {
  readonly interpretation: KnowledgeInterpretation;
  readonly processorContract: string;
  readonly record: AuthoredRecord;
}

export type KnowledgeInterpretationPublication = {
  interpretationId: string;
  recordSha256: string;
  published: boolean;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const canonicalKeys = (values: readonly unknown[]) => values.map((value) => canonicalJson(value));

function requireCanonicalOrder(values: readonly unknown[], what: string): void {
  const keys = canonicalKeys(values);
  const canonical = [...keys].sort();
  if (new Set(keys).size !== keys.length || canonical.some((value, index) => value !== keys[index]))
    invalid(`${what} are canonicalized, exactly deduplicated and sorted`);
}

export function prepareProjectKnowledgeInterpretation(input: {
  readonly interpretation: unknown;
  readonly processorContract: string;
  readonly attributedTo: Attribution;
  readonly secretAllow: readonly string[];
}): PreparedKnowledgeInterpretation {
  const processorContract = parsed(
    LabelSchema,
    input.processorContract,
    'An interpretation processor contract'
  );
  const interpretation = parsed(
    KnowledgeInterpretationSchema,
    actingField(input.interpretation, 'attributed_to', input.attributedTo),
    'A knowledge interpretation'
  );
  requireCanonicalOrder(interpretation.evidence, 'Interpretation evidence');
  requireCanonicalOrder(interpretation.uncertainties, 'Interpretation uncertainties');
  for (const evidence of interpretation.evidence) {
    if (sha256(evidence.quote) !== evidence.passage_sha256)
      invalid('Interpretation evidence passage hash must cover its exact quote');
    if (
      Buffer.byteLength(evidence.quote, 'utf8') !==
      evidence.prepared_end_utf8 - evidence.prepared_start_utf8
    )
      invalid('Interpretation evidence prepared offsets must cover its exact quote bytes');
    if (
      evidence.original_ranges.reduce((total, range) => total + range.end - range.start, 0) !==
      Buffer.byteLength(evidence.quote, 'utf8')
    )
      invalid('Interpretation evidence original ranges must project its exact unchanged bytes');
  }
  const { interpretation_id: supplied, recorded_at: _recordedAt, ...identity } = interpretation;
  if (supplied !== knowledgeInterpretationId(processorContract, identity))
    invalid('The interpretation ID must hash its exact contract, semantics and evidence');
  return {
    interpretation,
    processorContract,
    record: authoredRecord(interpretation, secretAllowList(input.secretAllow)),
  };
}

export function retainedProjectKnowledgeInterpretation(
  view: ProjectReadView,
  prepared: PreparedKnowledgeInterpretation
): KnowledgeInterpretationPublication | null {
  const row = view.get<{ record_sha256: string; operation_id: string }>(
    `SELECT record_sha256, operation_id FROM knowledge_interpretations
     WHERE interpretation_id=?`,
    prepared.interpretation.interpretation_id
  );
  if (!row) return null;
  if (row.record_sha256 !== prepared.record.sha256)
    taken(
      `Interpretation ${prepared.interpretation.interpretation_id} is already retained as a different record`
    );
  const retainedEvidence = view.all<{
    position: number;
    source_id: string;
    segment_id: string;
    mapping_version: string;
    mapping_sha256: string;
    prepared_sha256: string;
    prepared_start_utf8: number;
    prepared_end_utf8: number;
    original_ranges_json: string;
    quote: string;
    passage_sha256: string;
    operation_id: string;
  }>(
    `SELECT position, source_id, segment_id, mapping_version, mapping_sha256,
       prepared_sha256, prepared_start_utf8, prepared_end_utf8, original_ranges_json,
       quote, passage_sha256, operation_id
     FROM knowledge_interpretation_evidence
     WHERE interpretation_id=? ORDER BY position`,
    prepared.interpretation.interpretation_id
  );
  const expectedEvidence = prepared.interpretation.evidence.map((evidence, position) => ({
    position,
    source_id: evidence.source_id,
    segment_id: evidence.segment_id,
    mapping_version: evidence.mapping_version,
    mapping_sha256: evidence.mapping_sha256,
    prepared_sha256: evidence.prepared_sha256,
    prepared_start_utf8: evidence.prepared_start_utf8,
    prepared_end_utf8: evidence.prepared_end_utf8,
    original_ranges_json: canonicalJson(evidence.original_ranges),
    quote: evidence.quote,
    passage_sha256: evidence.passage_sha256,
    operation_id: row.operation_id,
  }));
  if (canonicalJson(retainedEvidence) !== canonicalJson(expectedEvidence))
    integrity(
      `Interpretation ${prepared.interpretation.interpretation_id} conflicts with its retained evidence rows`
    );
  return {
    interpretationId: prepared.interpretation.interpretation_id,
    recordSha256: prepared.record.sha256,
    published: false,
  };
}

interface InterpretationPublicationContext {
  readonly segments: readonly ScheduledInterpretationSegment[];
  readonly canonicalSourceId: (requestedSourceId: string) => string;
}

const utf8Slice = (text: string, start: number, end: number): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(text, 'utf8').subarray(start, end)
    );
  } catch {
    invalid('An interpretation byte range must end on UTF-8 boundaries');
  }
};

function retainedCaptureField(
  view: ProjectReadView,
  sourceId: string,
  segment: ScheduledInterpretationSegment
): string {
  const retained = readRetainedCaptureField(view, sourceId);
  const occurrence = segment.occurrence;
  if (
    retained.occurrence.artifact_id !== occurrence.artifact_id ||
    retained.occurrence.event_id !== occurrence.event_id ||
    retained.occurrence.field_path !== occurrence.field_path ||
    retained.occurrence.position !== occurrence.position
  )
    invalid('A scheduled segment must name the exact retained source occurrence');
  return retained.text;
}

function projectedOriginalRanges(
  segment: ScheduledInterpretationSegment,
  start: number,
  end: number
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let covered = start;
  for (const run of segment.mapping) {
    const overlapStart = Math.max(start, run.prepared.start);
    const overlapEnd = Math.min(end, run.prepared.end);
    if (overlapStart >= overlapEnd) continue;
    if (run.kind !== 'copied') invalid('Interpretation evidence cannot quote substituted text');
    if (overlapStart !== covered)
      invalid('Interpretation evidence must map every prepared byte to unchanged source bytes');
    const projected = {
      start: run.original.start + overlapStart - run.prepared.start,
      end: run.original.start + overlapEnd - run.prepared.start,
    };
    const previous = ranges.at(-1);
    if (previous && previous.end === projected.start) previous.end = projected.end;
    else ranges.push(projected);
    covered = overlapEnd;
  }
  if (covered !== end)
    invalid('Interpretation evidence must map every prepared byte to unchanged source bytes');
  return ranges;
}

function countOccurrences(text: string, quote: string): number {
  let count = 0;
  let at = 0;
  while (at <= text.length - quote.length) {
    const found = text.indexOf(quote, at);
    if (found < 0) break;
    count += 1;
    at = found + 1;
  }
  return count;
}

export function checkProjectKnowledgeInterpretation(
  view: ProjectReadView,
  prepared: PreparedKnowledgeInterpretation,
  context: InterpretationPublicationContext
): void {
  const { interpretation } = prepared;
  requireRetainedSources(view, [
    interpretation.source_origin.source_id,
    ...interpretation.evidence.map((evidence) => evidence.source_id),
  ]);
  const segments = new Map(context.segments.map((segment) => [segment.segment_id, segment]));
  if (segments.size !== context.segments.length) invalid('Scheduled segment IDs are unique');
  const preparedText = new Map<string, string>();
  for (const evidence of interpretation.evidence) {
    const segment = segments.get(evidence.segment_id);
    if (!segment) invalid('Interpretation evidence names a segment supplied to this unit');
    const canonicalSourceId = context.canonicalSourceId(segment.source_id);
    if (canonicalSourceId !== evidence.source_id)
      invalid('Interpretation evidence names the canonical source of its scheduled segment');
    let text = preparedText.get(segment.segment_id);
    if (text === undefined) {
      const original = retainedCaptureField(view, canonicalSourceId, segment);
      const reproduced = prepareInterpretationText(original);
      if (
        reproduced.originalSha256 !== segment.original_sha256 ||
        reproduced.preparedSha256 !== segment.prepared_sha256 ||
        reproduced.mappingVersion !== segment.mapping_version ||
        reproduced.mappingSha256 !== segment.mapping_sha256 ||
        canonicalJson(reproduced.mapping) !== canonicalJson(segment.mapping)
      )
        invalid('The retained source does not reproduce its scheduled preparation mapping');
      text = reproduced.prepared;
      preparedText.set(segment.segment_id, text);
    }
    if (
      evidence.mapping_version !== segment.mapping_version ||
      evidence.mapping_sha256 !== segment.mapping_sha256 ||
      evidence.prepared_sha256 !== segment.prepared_sha256 ||
      evidence.prepared_start_utf8 < segment.prepared_range.start ||
      evidence.prepared_end_utf8 > segment.prepared_range.end
    )
      invalid('Interpretation evidence must remain inside its exact scheduled prepared segment');
    const quoted = utf8Slice(text, evidence.prepared_start_utf8, evidence.prepared_end_utf8);
    const supplied = utf8Slice(text, segment.prepared_range.start, segment.prepared_range.end);
    if (quoted !== evidence.quote || countOccurrences(supplied, evidence.quote) !== 1)
      invalid('Interpretation evidence quote must occur exactly once in its supplied segment');
    if (
      canonicalJson(
        projectedOriginalRanges(segment, evidence.prepared_start_utf8, evidence.prepared_end_utf8)
      ) !== canonicalJson(evidence.original_ranges)
    )
      invalid('Interpretation evidence must retain its exact derived original ranges');
  }
}

export function settleProjectKnowledgeInterpretation(
  transaction: ProjectSettlement,
  operationId: string,
  prepared: PreparedKnowledgeInterpretation,
  context: InterpretationPublicationContext
): KnowledgeInterpretationPublication {
  checkProjectKnowledgeInterpretation(transaction, prepared, context);
  const { interpretation, record } = prepared;
  const task = interpretation.source_origin.task;
  const scope = interpretation.intended_scope;
  const outcome = interpretation.canonical_outcome;
  const target = outcome.target;
  transaction.run(
    `INSERT INTO knowledge_interpretations
       (interpretation_id, origin_source_id, origin_artifact_id, origin_plan_event_id,
        source_form, proposed_record_kind, intended_scope_kind, intended_scope_value,
        outcome_kind, target_kind, target_id, target_revision_id,
        attributed_kind, attributed_to, attributed_basis,
        record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    interpretation.interpretation_id,
    interpretation.source_origin.source_id,
    task?.artifact_id ?? null,
    task?.plan_event_id ?? null,
    interpretation.source_form,
    interpretation.proposed_record,
    scope.kind,
    scope.kind === 'artifact' ? scope.artifact_id : null,
    outcome.kind,
    target?.kind ?? null,
    target?.entity_id ?? null,
    target?.revision_id ?? null,
    'detector',
    interpretation.attributed_to.detector,
    null,
    record.bytes,
    record.sha256,
    operationId
  );
  interpretation.evidence.forEach((evidence, position) =>
    transaction.run(
      `INSERT INTO knowledge_interpretation_evidence
         (interpretation_id, position, source_id, segment_id, mapping_version, mapping_sha256,
          prepared_sha256, prepared_start_utf8, prepared_end_utf8, original_ranges_json,
          quote, passage_sha256, operation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      interpretation.interpretation_id,
      position,
      evidence.source_id,
      evidence.segment_id,
      evidence.mapping_version,
      evidence.mapping_sha256,
      evidence.prepared_sha256,
      evidence.prepared_start_utf8,
      evidence.prepared_end_utf8,
      canonicalJson(evidence.original_ranges),
      evidence.quote,
      evidence.passage_sha256,
      operationId
    )
  );
  return {
    interpretationId: interpretation.interpretation_id,
    recordSha256: record.sha256,
    published: true,
  };
}

export function requireInterpretationSupport(
  view: ProjectReadView,
  kind: 'requirement' | 'decision' | 'claim',
  entityId: string,
  revisionId: string,
  support: InterpretationSupport | null | undefined,
  passages: readonly SourceSelector[]
): void {
  if (support === null || support === undefined) return;
  const retained = view.get<{
    proposed_record_kind: string;
    outcome_kind: string;
    target_kind: string | null;
    target_id: string | null;
    target_revision_id: string | null;
    attributed_kind: string;
  }>(
    `SELECT proposed_record_kind, outcome_kind, target_kind, target_id, target_revision_id,
       attributed_kind FROM knowledge_interpretations WHERE interpretation_id=?`,
    support.interpretation_id
  );
  if (!retained) missing('An interpretation-backed revision requires its retained interpretation');
  if (
    retained.attributed_kind !== 'detector' ||
    retained.proposed_record_kind !== kind ||
    retained.outcome_kind !== 'candidate_revision' ||
    retained.target_kind !== kind ||
    retained.target_id !== entityId ||
    retained.target_revision_id !== revisionId
  )
    invalid('A revision interpretation must name this exact detector candidate outcome');
  for (const passage of passages) {
    const match = /^prepared-bytes:(\d+)-(\d+)$/u.exec(passage.location);
    if (!match) invalid('An interpretation-backed passage uses prepared UTF-8 byte coordinates');
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !view.get(
        `SELECT 1 FROM knowledge_interpretation_evidence
         WHERE interpretation_id=? AND source_id=? AND prepared_start_utf8=?
           AND prepared_end_utf8=? AND passage_sha256=?`,
        support.interpretation_id,
        passage.source_id,
        start,
        end,
        passage.passage_sha256
      )
    )
      invalid('An interpretation-backed passage must select exact retained evidence');
  }
}

function revisionSemantics(
  revision: RequirementRevision | DecisionRevision | ClaimRevision
): unknown {
  const common = {
    previous_revision_id: revision.previous_revision_id,
    applicability: revision.applicability,
  };
  if ('requirement_id' in revision)
    return {
      ...common,
      statement: revision.statement,
      rationale: revision.rationale,
      subject: revision.subject,
      duration: revision.duration,
    };
  if ('decision_id' in revision)
    return {
      ...common,
      chosen_approach: revision.chosen_approach,
      rationale: revision.rationale,
      alternatives: revision.alternatives,
      assumptions: revision.assumptions,
      reconsideration_conditions: revision.reconsideration_conditions,
      subject: revision.subject,
      derivation:
        revision.derivation === null
          ? null
          : {
              parent: revision.derivation.derived_from,
              explanation: revision.derivation.explanation,
            },
    };
  return {
    ...common,
    statement: revision.statement,
    subject: revision.subject,
    observation_ids: revision.observation_ids,
    verification: revision.verification,
  };
}

function requirementIdentitySemantics(identity: RequirementIdentity): unknown {
  const { origin } = identity;
  if (origin.kind === 'interpreted_source') return { kind: origin.kind };
  if (origin.kind !== 'derived') return origin;
  return {
    kind: origin.kind,
    derived_from: origin.derived_from,
    explanation: origin.explanation,
  };
}

function decodedRecord<T>(
  text: string,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  what: string
): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    integrity(`A retained ${what} record cannot be decoded`);
  }
  const parsedRecord = schema.safeParse(value);
  if (!parsedRecord.success) integrity(`A retained ${what} record has an unsupported shape`);
  return parsedRecord.data!;
}

export function readProjectCandidateRevisionCompatibilityFromView(
  view: ProjectReadView,
  input: ProjectCandidateRevisionProbe
): ProjectCandidateRevisionCompatibility {
  const revision =
    input.kind === 'requirement'
      ? parsed(RequirementRevisionSchema, input.record, 'A candidate requirement revision')
      : input.kind === 'decision'
        ? parsed(DecisionRevisionSchema, input.record, 'A candidate decision revision')
        : parsed(ClaimRevisionSchema, input.record, 'A candidate claim revision');
  const entityId =
    'requirement_id' in revision
      ? revision.requirement_id
      : 'decision_id' in revision
        ? revision.decision_id
        : revision.claim_id;
  const target = {
    kind: input.kind,
    entity_id: entityId,
    revision_id: revision.revision_id,
  };
  const table =
    input.kind === 'requirement'
      ? { revisions: 'requirement_revisions', entity: 'requirement_id', identities: 'requirements' }
      : input.kind === 'decision'
        ? { revisions: 'decision_revisions', entity: 'decision_id', identities: null }
        : { revisions: 'claim_revisions', entity: 'claim_id', identities: null };
  const retained = view.get<{ entityId: string; record: string }>(
    `SELECT ${table.entity} AS entityId, CAST(record_bytes AS TEXT) AS record
       FROM ${table.revisions} WHERE revision_id=?`,
    revision.revision_id
  );
  if (retained != null) {
    if (retained.entityId !== entityId) return { target, status: 'collision' };
    const schema =
      input.kind === 'requirement'
        ? RequirementRevisionSchema
        : input.kind === 'decision'
          ? DecisionRevisionSchema
          : ClaimRevisionSchema;
    const retainedRevision = decodedRecord(
      retained.record,
      schema as { safeParse(value: unknown): { success: boolean; data?: typeof revision } },
      `${input.kind} revision`
    );
    if (
      canonicalJson(revisionSemantics(retainedRevision)) !==
      canonicalJson(revisionSemantics(revision))
    )
      return { target, status: 'collision' };
    if (input.kind === 'requirement' && input.identity !== null && input.identity !== undefined) {
      const identity = parsed(
        RequirementIdentitySchema,
        input.identity,
        'A candidate requirement identity'
      );
      const retainedIdentity = view.get<{ record: string }>(
        'SELECT CAST(record_bytes AS TEXT) AS record FROM requirements WHERE requirement_id=?',
        entityId
      );
      if (
        retainedIdentity == null ||
        canonicalJson(
          requirementIdentitySemantics(
            decodedRecord(
              retainedIdentity.record,
              RequirementIdentitySchema,
              'requirement identity'
            )
          )
        ) !== canonicalJson(requirementIdentitySemantics(identity))
      )
        return { target, status: 'collision' };
    }
    return { target, status: 'compatible' };
  }
  const continues = revision.previous_revision_id !== null;
  const identityExists =
    input.kind === 'requirement'
      ? view.get('SELECT requirement_id FROM requirements WHERE requirement_id=?', entityId) != null
      : view.get(
          `SELECT revision_id FROM ${table.revisions} WHERE ${table.entity}=? LIMIT 1`,
          entityId
        ) != null;
  if (!continues && identityExists) return { target, status: 'collision' };
  if (input.kind === 'requirement' && input.identity !== null && input.identity !== undefined) {
    const identity = parsed(
      RequirementIdentitySchema,
      input.identity,
      'A candidate requirement identity'
    );
    if (identity.requirement_id !== entityId)
      invalid('A candidate requirement identity and revision name the same requirement');
  }
  return { target, status: 'available' };
}

export function readProjectCandidateRevisionCompatibility(
  handle: ProjectDatabase,
  input: ProjectCandidateRevisionProbe
): ProjectCandidateRevisionCompatibility {
  return handle.read((view) => readProjectCandidateRevisionCompatibilityFromView(view, input))
    .value;
}

export interface RejectKnowledgeEquivalence {
  readonly operationId: string;
  readonly disposition: unknown;
  readonly decidedBy: KnowledgeEquivalenceDisposition['decided_by'];
  readonly secretAllow: readonly string[];
}

export type KnowledgeEquivalenceRejection = {
  dispositionId: string;
  interpretationId: string;
  recordSha256: string;
  published: boolean;
};

function prepareDisposition(input: RejectKnowledgeEquivalence): {
  disposition: KnowledgeEquivalenceDisposition;
  record: AuthoredRecord;
} {
  const disposition = parsed(
    KnowledgeEquivalenceDispositionSchema,
    actingField(input.disposition, 'decided_by', input.decidedBy),
    'An equivalence disposition'
  );
  const { disposition_id: supplied, recorded_at: _recordedAt, ...identity } = disposition;
  if (supplied !== knowledgeEquivalenceDispositionId(identity))
    invalid('The equivalence disposition ID must hash its exact rejection account');
  return {
    disposition,
    record: authoredRecord(disposition, secretAllowList(input.secretAllow)),
  };
}

export async function rejectProjectKnowledgeEquivalence(
  handle: ProjectDatabase,
  input: RejectKnowledgeEquivalence,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const prepared = prepareDisposition(input);
  const { disposition, record } = prepared;
  const result = (published: boolean): KnowledgeEquivalenceRejection => ({
    dispositionId: disposition.disposition_id,
    interpretationId: disposition.interpretation_id,
    recordSha256: record.sha256,
    published,
  });
  const existing = handle.read((view) =>
    view.get<{ disposition_id: string; record_sha256: string }>(
      'SELECT disposition_id, record_sha256 FROM knowledge_equivalence_dispositions WHERE interpretation_id=?',
      disposition.interpretation_id
    )
  ).value;
  if (existing) {
    if (
      existing.disposition_id !== disposition.disposition_id ||
      existing.record_sha256 !== record.sha256
    )
      taken('That proposed equivalence already has a different retained rejection');
    return committedNothing(handle, result(false));
  }
  const operation: ProjectOperation = {
    operationId,
    kind: 'knowledge.equivalence.reject',
    target: { interpretationId: disposition.interpretation_id },
    payload: { disposition: record.sha256 },
    expectedState: [],
    intentChange: false,
  };
  if (retriedOperation(handle, operationId)) return replayOperation(handle, operation, options);
  return publishUnlessRetained(
    handle,
    operation,
    (transaction) => {
      const retained = transaction.get<{ disposition_id: string; record_sha256: string }>(
        'SELECT disposition_id, record_sha256 FROM knowledge_equivalence_dispositions WHERE interpretation_id=?',
        disposition.interpretation_id
      );
      if (retained) {
        if (
          retained.disposition_id !== disposition.disposition_id ||
          retained.record_sha256 !== record.sha256
        )
          taken('That proposed equivalence already has a different retained rejection');
        return result(false);
      }
      const interpretation = transaction.get<{ outcome_kind: string }>(
        'SELECT outcome_kind FROM knowledge_interpretations WHERE interpretation_id=?',
        disposition.interpretation_id
      );
      if (!interpretation) missing('An equivalence rejection requires its retained interpretation');
      if (interpretation.outcome_kind !== 'proposed_equivalence')
        invalid('Only a proposed equivalence can be rejected');
      const [decidedBy, basis] = actorColumns(disposition.decided_by);
      transaction.run(
        `INSERT INTO knowledge_equivalence_dispositions
           (disposition_id, interpretation_id, disposition, decided_by, decided_by_basis,
            record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        disposition.disposition_id,
        disposition.interpretation_id,
        disposition.disposition,
        decidedBy,
        basis,
        record.bytes,
        record.sha256,
        operationId
      );
      return result(true);
    },
    options
  );
}
