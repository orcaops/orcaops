import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '../events/canonical-json.js';
import type { EventType } from '../events/event-log.js';
import { identifierText, proseText } from '../text/control-chars.js';

const recordId = () =>
  identifierText(z.string().regex(/^\S+$/u, 'must not be blank or contain whitespace'));
const label = () => identifierText(z.string().regex(/\S/u, 'must not be blank'));
const sha256 = () => identifierText(z.string().regex(/^[0-9a-f]{64}$/u));
const instant = () => identifierText(z.string().datetime());

const unique = (values: readonly string[]) => new Set(values).size === values.length;
const sameMembers = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

export const AttributionBasisSchema = z.enum([
  'authenticated',
  'source_attributed',
  'agent_reported_user_instruction',
  'other_assertion',
  'unknown',
]);
export type AttributionBasis = z.infer<typeof AttributionBasisSchema>;

/**
 * Unknown stays unknown: an actor with no identity can only have the `unknown`
 * basis, and a named actor says how the name is known. The basis is recorded
 * as given; nothing here can verify it, so a writer never raises one.
 */
export const ActorSchema = z
  .strictObject({
    identity: label().nullable(),
    basis: AttributionBasisSchema,
  })
  .refine((actor) => (actor.identity === null) === (actor.basis === 'unknown'), {
    message: 'an unknown actor has no identity, and a named actor states its attribution basis',
  });
export type Actor = z.infer<typeof ActorSchema>;

/**
 * An actor authors; a detector only derives. Everything background processing
 * writes is detector attributed, which is what lets the store keep derived
 * output from establishing anything or moving the intent counter. Every field
 * that says who did something is one of these, so a detector is never recorded
 * in a field whose purpose is to name a person.
 */
export const AttributionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('actor'), actor: ActorSchema }),
  z.strictObject({ kind: z.literal('detector'), detector: label() }),
]);
export type Attribution = z.infer<typeof AttributionSchema>;

const CaptureFieldOccurrenceSchema = z.strictObject({
  kind: z.literal('capture_field'),
  artifact_id: recordId(),
  event_id: recordId(),
  field_path: label(),
  position: z.number().int().nonnegative(),
});

/**
 * Every non-capture source carries a content hash, so a mutable URL alone can
 * never be recorded as a source: `external_reference` still needs retained
 * bytes or an immutable retained reference.
 */
const RetainedSourceOccurrenceSchema = z.strictObject({
  kind: z.enum([
    'user_instruction',
    'document_revision',
    'review_comment',
    'evaluator_result',
    'external_reference',
  ]),
  retention: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('bytes'), content_sha256: sha256() }),
    z.strictObject({
      kind: z.literal('retained_reference'),
      reference: label(),
      content_sha256: sha256(),
    }),
  ]),
  location: label().nullable(),
  source_time: instant().nullable(),
});

/**
 * Who wrote it, who recorded it here and who read a meaning into it are three
 * separate facts. Only the first two are people: interpreting is what
 * background processing does, so the interpreter is an attribution, and a
 * source nobody interpreted (`null`) stays distinguishable from one a detector
 * interpreted.
 */
export const SourceOccurrenceSchema = z.strictObject({
  source_id: recordId(),
  occurrence: z.union([CaptureFieldOccurrenceSchema, RetainedSourceOccurrenceSchema]),
  source_author: ActorSchema,
  recorded_by: ActorSchema,
  interpreted_by: AttributionSchema.nullable(),
  access_restriction: label().nullable(),
});
export type SourceOccurrence = z.infer<typeof SourceOccurrenceSchema>;

export const CriterionReferenceSchema = z.strictObject({
  artifact_id: recordId(),
  plan_event_id: recordId(),
  criterion_id: recordId(),
});
export type CriterionReference = z.infer<typeof CriterionReferenceSchema>;

export const ExpectationRevisionRefSchema = z.strictObject({
  kind: z.enum(['requirement', 'decision']),
  entity_id: recordId(),
  revision_id: recordId(),
});
export type ExpectationRevisionRef = z.infer<typeof ExpectationRevisionRefSchema>;

/** A relationship has no revisions of its own, so a reference to one names it twice. */
export const RecordRevisionRefSchema = z
  .strictObject({
    kind: z.enum(['requirement', 'decision', 'claim', 'relationship']),
    entity_id: recordId(),
    revision_id: recordId(),
  })
  .refine((ref) => ref.kind !== 'relationship' || ref.entity_id === ref.revision_id, {
    path: ['revision_id'],
    message: 'a relationship is its own revision',
  });
export type RecordRevisionRef = z.infer<typeof RecordRevisionRefSchema>;

export const InterpretationEvidenceSchema = z
  .strictObject({
    source_id: recordId(),
    segment_id: recordId(),
    mapping_version: label(),
    mapping_sha256: sha256(),
    prepared_sha256: sha256(),
    prepared_start_utf8: z.number().int().nonnegative().safe(),
    prepared_end_utf8: z.number().int().positive().safe(),
    original_ranges: z
      .array(
        z.strictObject({
          start: z.number().int().nonnegative().safe(),
          end: z.number().int().positive().safe(),
        })
      )
      .min(1),
    quote: proseText(),
    passage_sha256: sha256(),
  })
  .superRefine((evidence, ctx) => {
    if (evidence.prepared_start_utf8 >= evidence.prepared_end_utf8)
      ctx.addIssue({
        code: 'custom',
        path: ['prepared_end_utf8'],
        message: 'prepared evidence ends after it starts',
      });
    let previousEnd = -1;
    evidence.original_ranges.forEach((range, index) => {
      if (range.start >= range.end)
        ctx.addIssue({
          code: 'custom',
          path: ['original_ranges', index, 'end'],
          message: 'an original evidence range ends after it starts',
        });
      if (range.start < previousEnd)
        ctx.addIssue({
          code: 'custom',
          path: ['original_ranges', index, 'start'],
          message: 'original evidence ranges are ordered and do not overlap',
        });
      previousEnd = range.end;
    });
  });
export type InterpretationEvidence = z.infer<typeof InterpretationEvidenceSchema>;

export const InterpretationTargetSchema = z.strictObject({
  kind: z.enum(['requirement', 'decision', 'claim']),
  entity_id: recordId(),
  revision_id: recordId(),
});
export type InterpretationTarget = z.infer<typeof InterpretationTargetSchema>;

export const InterpretationSupportSchema = z.strictObject({
  interpretation_id: recordId(),
  evidence_relation: z.literal('supports'),
});
export type InterpretationSupport = z.infer<typeof InterpretationSupportSchema>;

const InterpretationOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none'), target: z.null() }),
  z.strictObject({ kind: z.literal('exact_restatement'), target: InterpretationTargetSchema }),
  z.strictObject({ kind: z.literal('proposed_equivalence'), target: InterpretationTargetSchema }),
  z.strictObject({ kind: z.literal('candidate_revision'), target: InterpretationTargetSchema }),
]);

export const KnowledgeInterpretationSchema = z
  .strictObject({
    interpretation_id: recordId(),
    source_origin: z.strictObject({
      source_id: recordId(),
      task: z.strictObject({ artifact_id: recordId(), plan_event_id: recordId() }).nullable(),
    }),
    wording: proseText(),
    source_form: z.enum([
      'stated_obligation',
      'stated_decision',
      'task_local_criterion',
      'test_or_check',
      'observation',
      'question',
    ]),
    proposed_record: z.enum(['requirement', 'decision', 'claim', 'none']),
    intended_scope: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('project') }),
      z.strictObject({ kind: z.literal('artifact'), artifact_id: recordId() }),
      z.strictObject({ kind: z.literal('unknown') }),
    ]),
    rationale: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('stated'),
        wording: proseText(),
        evidence_positions: z.array(z.number().int().nonnegative().safe()).min(1),
      }),
      z.strictObject({ kind: z.literal('unknown') }),
    ]),
    uncertainties: z.array(
      z.strictObject({
        about: z.enum(['meaning', 'scope', 'equivalence']),
        note: proseText(),
      })
    ),
    evidence: z.array(InterpretationEvidenceSchema),
    canonical_outcome: InterpretationOutcomeSchema,
    attributed_to: z.strictObject({
      kind: z.literal('detector'),
      detector: label(),
    }),
    recorded_at: instant(),
  })
  .superRefine((interpretation, ctx) => {
    if (interpretation.proposed_record !== 'none' && interpretation.evidence.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'an interpretation that proposes a record cites evidence',
      });
    if (
      interpretation.canonical_outcome.target !== null &&
      interpretation.proposed_record !== interpretation.canonical_outcome.target.kind
    )
      ctx.addIssue({
        code: 'custom',
        path: ['canonical_outcome', 'target', 'kind'],
        message: 'the interpretation outcome has the proposed record kind',
      });
    if (interpretation.rationale.kind === 'stated') {
      if (!unique(interpretation.rationale.evidence_positions.map(String)))
        ctx.addIssue({
          code: 'custom',
          path: ['rationale', 'evidence_positions'],
          message: 'rationale evidence positions are unique',
        });
      interpretation.rationale.evidence_positions.forEach((position, index) => {
        if (position >= interpretation.evidence.length)
          ctx.addIssue({
            code: 'custom',
            path: ['rationale', 'evidence_positions', index],
            message: 'rationale evidence positions name retained evidence',
          });
      });
    }
  });
export type KnowledgeInterpretation = z.infer<typeof KnowledgeInterpretationSchema>;

const derivedKnowledgeId = (value: unknown): string => {
  const hex = createHash('sha256').update(canonicalJson(value)).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
};

export type KnowledgeInterpretationIdentity = Omit<
  KnowledgeInterpretation,
  'interpretation_id' | 'recorded_at'
>;

export function knowledgeInterpretationId(
  processorContract: string,
  interpretation: KnowledgeInterpretationIdentity
): string {
  const outcome = interpretation.canonical_outcome;
  return derivedKnowledgeId([
    'interpretation@1',
    processorContract,
    {
      ...interpretation,
      canonical_outcome: outcome.kind === 'candidate_revision' ? { kind: outcome.kind } : outcome,
    },
  ]);
}

export const KnowledgeEquivalenceDispositionSchema = z.strictObject({
  disposition_id: recordId(),
  interpretation_id: recordId(),
  disposition: z.literal('rejected'),
  reason: proseText().nullable(),
  decided_by: ActorSchema,
  recorded_at: instant(),
});
export type KnowledgeEquivalenceDisposition = z.infer<typeof KnowledgeEquivalenceDispositionSchema>;

export function knowledgeEquivalenceDispositionId(
  disposition: Omit<KnowledgeEquivalenceDisposition, 'disposition_id' | 'recorded_at'>
): string {
  return derivedKnowledgeId(['equivalence-disposition@1', disposition]);
}

interface RevisionRef {
  kind: string;
  entity_id: string;
  revision_id: string;
}

const sameRevision = (left: RevisionRef, right: RevisionRef) =>
  left.kind === right.kind &&
  left.entity_id === right.entity_id &&
  left.revision_id === right.revision_id;

const isExpectation = (ref: RevisionRef) => ref.kind === 'requirement' || ref.kind === 'decision';

const revisionKey = (ref: RevisionRef) =>
  JSON.stringify([ref.kind, ref.entity_id, ref.revision_id]);

/** An immutable passage: the source occurrence, a location in it, and the passage's content hash. */
export const SourceSelectorSchema = z.strictObject({
  source_id: recordId(),
  location: label(),
  passage_sha256: sha256(),
});
export type SourceSelector = z.infer<typeof SourceSelectorSchema>;

export const RequirementOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('promoted_criterion'), criterion: CriterionReferenceSchema }),
  z.strictObject({
    kind: z.literal('promoted_source'),
    passage: SourceSelectorSchema,
    promoted_at: instant(),
  }),
  z.strictObject({
    kind: z.literal('derived'),
    derived_from: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('criterion'), criterion: CriterionReferenceSchema }),
      z.strictObject({
        kind: z.literal('expectation'),
        expectation: ExpectationRevisionRefSchema,
      }),
    ]),
    explanation: proseText(),
    source_id: recordId(),
    derived_at: instant(),
  }),
  z.strictObject({ kind: z.literal('authored'), source_id: recordId() }),
  z.strictObject({ kind: z.literal('interpreted_source'), interpretation_id: recordId() }),
]);

/**
 * One lineage per continuing expectation. A promoted criterion's requirement
 * IS that criterion, so it takes the criterion's id; a different proposition
 * derived from it must not, or the two obligations would share an identity.
 * Whether any other origin's id is fresh can only be seen in the store: the
 * writer refuses an id an existing criterion or requirement already holds.
 */
export const RequirementIdentitySchema = z
  .strictObject({
    requirement_id: recordId(),
    origin: RequirementOriginSchema,
  })
  .superRefine((identity, ctx) => {
    const { origin } = identity;
    if (
      origin.kind === 'promoted_criterion' &&
      origin.criterion.criterion_id !== identity.requirement_id
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['requirement_id'],
        message: 'a promoted criterion keeps its criterion id as the requirement identity',
      });
    }
    if (origin.kind !== 'derived') return;
    const sourceId =
      origin.derived_from.kind === 'criterion'
        ? origin.derived_from.criterion.criterion_id
        : origin.derived_from.expectation.entity_id;
    if (sourceId === identity.requirement_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['requirement_id'],
        message: 'a derived obligation is a distinct proposition and needs its own identity',
      });
    }
  });
export type RequirementIdentity = z.infer<typeof RequirementIdentitySchema>;

const ApplicabilityConditionSchema = z.discriminatedUnion('operator', [
  z.strictObject({
    dimension: z.enum(['subject', 'software_version', 'environment', 'work_context']),
    operator: z.literal('any_of'),
    values: z.array(label()).min(1),
  }),
  z.strictObject({
    dimension: z.literal('time'),
    operator: z.literal('before'),
    instant: instant(),
  }),
  z.strictObject({
    dimension: z.literal('time'),
    operator: z.literal('from'),
    instant: instant(),
  }),
]);

export const ApplicabilitySelectorSchema = z.strictObject({
  all_of: z.array(ApplicabilityConditionSchema),
});
export type ApplicabilitySelector = z.infer<typeof ApplicabilitySelectorSchema>;

export interface ApplicabilityInputs {
  subject?: readonly string[];
  software_version?: readonly string[];
  environment?: readonly string[];
  work_context?: readonly string[];
  time?: string;
}

export type Applicability = 'applies' | 'does_not_apply' | 'unresolved';

/**
 * Three-valued conjunction. A condition whose input is missing, empty or
 * unreadable is unresolved: it is never waived and never assumed met. One
 * definitely false condition still settles the whole selector. `before` is
 * exclusive and `from` inclusive, so a rule that ends at an instant and its
 * successor that starts there leave no gap and no overlap.
 */
export function evaluateApplicability(
  selector: ApplicabilitySelector,
  inputs: ApplicabilityInputs
): Applicability {
  let unresolved = false;
  for (const condition of selector.all_of) {
    if (condition.operator === 'any_of') {
      const known = inputs[condition.dimension];
      if (known === undefined || known.length === 0) unresolved = true;
      else if (!condition.values.some((value) => known.includes(value))) return 'does_not_apply';
      continue;
    }
    const at = inputs.time === undefined ? Number.NaN : Date.parse(inputs.time);
    const bound = Date.parse(condition.instant);
    if (Number.isNaN(at) || Number.isNaN(bound)) unresolved = true;
    else if (condition.operator === 'before' ? at >= bound : at < bound) return 'does_not_apply';
  }
  return unresolved ? 'unresolved' : 'applies';
}

const DurationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('continuing') }),
  z.strictObject({ kind: z.literal('until_time'), until: instant() }),
  z.strictObject({ kind: z.literal('until_condition'), condition: proseText() }),
  z.strictObject({ kind: z.literal('unknown') }),
]);

export const SourceStandingSchema = z.enum([
  'explicit_instruction',
  'agent_proposal',
  'extracted_candidate',
]);

const revisionCommon = {
  revision_id: recordId(),
  previous_revision_id: recordId().nullable(),
  applicability: ApplicabilitySelectorSchema,
  source_ids: z.array(recordId()).min(1),
  /** The exact passages of those sources this revision restates; a selector resolves only to one. */
  passages: z.array(SourceSelectorSchema),
  source_standing: SourceStandingSchema,
  attributed_to: AttributionSchema,
  interpretation: InterpretationSupportSchema.nullable().optional(),
  recorded_at: instant(),
};

const derivedRevisionIsACandidate = (revision: {
  attributed_to: Attribution;
  source_standing: z.infer<typeof SourceStandingSchema>;
}) =>
  revision.attributed_to.kind !== 'detector' || revision.source_standing === 'extracted_candidate';

const candidateIssue = {
  path: ['source_standing'],
  message: 'a revision derived by a detector is an extracted candidate',
};

/**
 * A decision and a claim are each located by the one exact passage they occur
 * at, because neither has an identity record to carry an origin the way a
 * requirement does. A location nobody authored is not a location, so the
 * passage a revision cites is the only thing its occurrence can be, and a
 * revision that cites none has nothing to be keyed on.
 */
const locatedPassages = z.array(SourceSelectorSchema).min(1, 'cites at least one exact passage');

export const SubjectRevisionSchema = z.strictObject({
  subject_id: recordId(),
  revision_id: recordId(),
  previous_revision_id: recordId().nullable(),
  label: proseText(),
  kind: z.enum(['capability', 'service', 'api', 'workflow', 'project', 'other']),
  description: proseText(),
  source_ids: z.array(recordId()).min(1),
  authored_by: ActorSchema,
  recorded_at: instant(),
});
export type SubjectRevision = z.infer<typeof SubjectRevisionSchema>;

const SubjectRefSchema = z.strictObject({
  subject_id: recordId(),
  subject_revision_id: recordId(),
});

export const RequirementRevisionSchema = z
  .strictObject({
    ...revisionCommon,
    requirement_id: recordId(),
    statement: proseText(),
    rationale: proseText().nullable(),
    subject: SubjectRefSchema.nullable(),
    duration: DurationSchema,
  })
  .refine(derivedRevisionIsACandidate, candidateIssue);
export type RequirementRevision = z.infer<typeof RequirementRevisionSchema>;

/**
 * Where a decision came from, when it came from a rule that already stood. A
 * requirement records this in its identity; a decision's identity carries
 * nothing, so its derivation lives on the revision that mints it and on no
 * other, where it would read as a change of ancestry rather than an origin.
 * Without it a derived decision's lineage is only a suggested relationship,
 * which anyone may withdraw.
 */
export const DecisionDerivationSchema = z.strictObject({
  derived_from: ExpectationRevisionRefSchema,
  explanation: proseText(),
  source_id: recordId(),
  derived_at: instant(),
});
export type DecisionDerivation = z.infer<typeof DecisionDerivationSchema>;

export const DecisionRevisionSchema = z
  .strictObject({
    ...revisionCommon,
    passages: locatedPassages,
    decision_id: recordId(),
    chosen_approach: proseText(),
    rationale: proseText().nullable(),
    alternatives: z.array(z.strictObject({ option: proseText(), rejected_because: proseText() })),
    assumptions: z.array(proseText()),
    reconsideration_conditions: z.array(proseText()),
    subject: SubjectRefSchema.nullable(),
    derivation: DecisionDerivationSchema.nullable(),
  })
  .superRefine((revision, ctx) => {
    if (!derivedRevisionIsACandidate(revision)) ctx.addIssue({ code: 'custom', ...candidateIssue });
    if (revision.derivation === null) return;
    if (revision.previous_revision_id !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['derivation'],
        message: 'a decision records where it came from on the revision that mints its identity',
      });
    if (revision.derivation.derived_from.entity_id === revision.decision_id)
      ctx.addIssue({
        code: 'custom',
        path: ['decision_id'],
        message: 'a derived decision is a distinct proposition and needs its own identity',
      });
  });
export type DecisionRevision = z.infer<typeof DecisionRevisionSchema>;

/**
 * What somebody reported about checking a claim. `agent_reported` is the only
 * provenance there is: nothing here reproduced or confirmed anything, so an
 * account of a run is evidence and never proof. A run that was actually
 * established against identified inputs is an {@link ObservationSchema}, and
 * what it settles about an expectation is an {@link AssessmentSchema}; neither
 * is a property of the statement that cites it.
 */
export const ClaimVerificationSchema = z.strictObject({
  provenance: z.literal('agent_reported'),
  account: proseText(),
  reported_by: ActorSchema,
});
export type ClaimVerification = z.infer<typeof ClaimVerificationSchema>;

/**
 * A factual statement or finding: what happened, what was observed, what an
 * evaluator retained. Never a desired behavior — that is a requirement.
 *
 * What the revision asserts and what anybody reports about checking it are
 * kept apart, so nothing an assertion says about itself can be read as
 * verification of it. A detector's revision is an extracted candidate like
 * everything else background processing writes, and it verifies nothing:
 * reading a statement out of a source is not running anything.
 *
 * `observation_ids` names the observations the finding rests on, which is
 * where its producer, method, configuration, execution context, input
 * identities and limits live. Without it a retained evaluator finding
 * published as a claim would keep its statement and lose all of that. It may
 * be empty: a finding somebody simply wrote down observed nothing.
 */
export const ClaimRevisionSchema = z
  .strictObject({
    ...revisionCommon,
    passages: locatedPassages,
    claim_id: recordId(),
    statement: proseText(),
    subject: SubjectRefSchema.nullable(),
    observation_ids: z.array(recordId()),
    verification: ClaimVerificationSchema.nullable(),
  })
  .superRefine((revision, ctx) => {
    if (!derivedRevisionIsACandidate(revision)) ctx.addIssue({ code: 'custom', ...candidateIssue });
    if (revision.attributed_to.kind === 'detector' && revision.verification !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['verification'],
        message: 'a detector extracts a candidate; it verifies nothing',
      });
  });
export type ClaimRevision = z.infer<typeof ClaimRevisionSchema>;

export interface RevisionLink {
  revision_id: string;
  previous_revision_id: string | null;
}

/** Every revision nobody continues. More than one is a sibling set, not an error. */
export function revisionTips(revisions: readonly RevisionLink[]): string[] {
  const continued = new Set(revisions.map((revision) => revision.previous_revision_id));
  return revisions
    .map((revision) => revision.revision_id)
    .filter((revisionId) => !continued.has(revisionId));
}

export type RevisionRefusal =
  | 'REVISION_ID_REUSED'
  | 'LINEAGE_ALREADY_ROOTED'
  | 'PREDECESSOR_NOT_IN_LINEAGE';

/**
 * A revision may continue any retained revision of its own identity, including
 * one that already has a successor. What it may not do is name a predecessor
 * from another identity or start a second root.
 */
export function checkRevisionContinues(
  lineage: readonly RevisionLink[],
  next: RevisionLink
): { ok: true } | { ok: false; code: RevisionRefusal } {
  if (lineage.some((revision) => revision.revision_id === next.revision_id))
    return { ok: false, code: 'REVISION_ID_REUSED' };
  if (next.previous_revision_id === null)
    return lineage.length === 0 ? { ok: true } : { ok: false, code: 'LINEAGE_ALREADY_ROOTED' };
  return lineage.some((revision) => revision.revision_id === next.previous_revision_id)
    ? { ok: true }
    : { ok: false, code: 'PREDECESSOR_NOT_IN_LINEAGE' };
}

/** Finding a connection is what background processing does, so the discoverer is an attribution. */
const TaskUseSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('selected_with_plan') }),
  z.strictObject({
    kind: z.literal('connected_later'),
    discovered_at: instant(),
    discovered_by: AttributionSchema,
  }),
]);
export type TaskUseSelection = z.infer<typeof TaskUseSelectionSchema>;

export const TaskUseSchema = z.strictObject({
  artifact_id: recordId(),
  plan_event_id: recordId(),
  target: ExpectationRevisionRefSchema,
  role: z.enum(['implement', 'preserve', 'assess', 'background', 'propose_change']),
  local: z.strictObject({ step_id: recordId(), criterion_id: recordId().nullable() }).nullable(),
  exception_id: recordId().nullable(),
  selection: TaskUseSelectionSchema,
});
export type TaskUse = z.infer<typeof TaskUseSchema>;

/**
 * Whether a use was an original task selection is a fact about which operation
 * wrote it, never something the writer's caller may assert: a connection found
 * after the task does not prove the task selected or considered the requirement.
 */
export function taskUseSelection(input: {
  plan_event_operation_id: string;
  writing_operation_id: string;
  discovery: { discovered_at: string; discovered_by: Attribution } | null;
}): { ok: true; selection: TaskUseSelection } | { ok: false; code: 'DISCOVERY_REQUIRED' } {
  if (input.plan_event_operation_id === input.writing_operation_id)
    return { ok: true, selection: { kind: 'selected_with_plan' } };
  return input.discovery === null
    ? { ok: false, code: 'DISCOVERY_REQUIRED' }
    : { ok: true, selection: { kind: 'connected_later', ...input.discovery } };
}

/**
 * The action is the discriminator on purpose: an edit that names neither
 * action fails to parse, so the shared-record writer can write nothing for it
 * and nothing guesses an action from the wording. The ordinary capture that
 * carried the edit is still retained; only the shared change is refused.
 */
export const PromotedCriterionEditSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('revise_shared_requirement'),
    requirement: ExpectationRevisionRefSchema,
    proposed_statement: proseText(),
    rationale: proseText(),
  }),
  z.strictObject({
    action: z.literal('change_task_acceptance'),
    requirement: ExpectationRevisionRefSchema,
    artifact_id: recordId(),
    step_id: recordId(),
    criterion_text: proseText(),
  }),
]);
export type PromotedCriterionEdit = z.infer<typeof PromotedCriterionEditSchema>;

/** Branch, worktree and task ownership are deliberately absent: they grant no authority. */
export const AuthorityScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), project_id: recordId() }),
  z.strictObject({ kind: z.literal('artifact'), artifact_id: recordId() }),
]);
export type AuthorityScope = z.infer<typeof AuthorityScopeSchema>;

const scopeKey = (scope: AuthorityScope) =>
  JSON.stringify(
    scope.kind === 'project' ? ['project', scope.project_id] : ['artifact', scope.artifact_id]
  );
const sameScope = (left: AuthorityScope, right: AuthorityScope) =>
  scopeKey(left) === scopeKey(right);

const DesignationSchema = z.enum(['adopted', 'background']);
export type Designation = z.infer<typeof DesignationSchema>;

export const AuthorizationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('informed_instruction'),
    instruction_source_id: recordId(),
    acknowledged: z.array(ExpectationRevisionRefSchema).min(1),
    scope: AuthorityScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('explicit_instruction'),
    instruction_source_id: recordId(),
    scope: AuthorityScopeSchema,
  }),
  z.strictObject({ kind: z.literal('approval_binding'), binding_id: recordId() }),
  z.strictObject({ kind: z.literal('reused_authorization'), authorization_id: recordId() }),
  /**
   * A standing delegation the act falls inside, which is what lets routine
   * preauthorized work proceed without asking again. Unlike the four above it
   * names nobody's permission for this act in particular: the store judges the
   * act against the footprint the assignment delegates, its validity, and
   * whether the acting identity is the one it made responsible.
   */
  z.strictObject({ kind: z.literal('assignment'), assignment_id: recordId() }),
]);
export type Authorization = z.infer<typeof AuthorizationSchema>;

const AdoptionSchema = z.strictObject({
  revision: RecordRevisionRefSchema,
  designation: DesignationSchema,
});

/**
 * How an act departs from a rule. Excepting a rule, replacing it, withdrawing
 * it, accepting a correction to it, and deliberately adopting a revision that
 * stands beside it are different permissions: authority given for one is never
 * authority for another.
 */
const DepartureSchema = z
  .strictObject({
    rule: ExpectationRevisionRefSchema,
    how: z.enum(['excepts', 'replaces', 'withdraws', 'corrects', 'stands_beside']),
    exception_id: recordId().nullable(),
    replaced_by: RecordRevisionRefSchema.nullable(),
  })
  .superRefine((departure, ctx) => {
    if ((departure.how === 'excepts') !== (departure.exception_id !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['exception_id'],
        message: 'an excepting departure, and only an excepting departure, names its exception',
      });
    if ((departure.how === 'replaces') !== (departure.replaced_by !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['replaced_by'],
        message:
          'a replacing departure, and only a replacing departure, names what replaces the rule',
      });
  });
export type Departure = z.infer<typeof DepartureSchema>;

/**
 * What an act does to what stands: the revisions it makes stand, the rules it
 * departs from and how, and the findings and relationships whose recorded
 * standing it changes. Authority is always judged on this footprint, never on
 * the list of records an act happens to name as its targets.
 */
export interface ActFootprint {
  adopts: readonly { revision: RecordRevisionRef; designation: Designation }[];
  departs_from: readonly Departure[];
  restates: readonly RecordRevisionRef[];
}

const NOTHING: ActFootprint = { adopts: [], departs_from: [], restates: [] };

const footprintIsEmpty = (footprint: ActFootprint) =>
  footprint.adopts.length === 0 &&
  footprint.departs_from.length === 0 &&
  footprint.restates.length === 0;

const sameDeparture = (left: Departure, right: Departure) =>
  sameRevision(left.rule, right.rule) &&
  left.how === right.how &&
  left.exception_id === right.exception_id &&
  (left.replaced_by === null
    ? right.replaced_by === null
    : right.replaced_by !== null && sameRevision(left.replaced_by, right.replaced_by));

const acknowledgesEvery = (
  acknowledged: readonly ExpectationRevisionRef[],
  departures: readonly Departure[]
) => departures.every((departure) => acknowledged.some((ack) => sameRevision(ack, departure.rule)));

/**
 * What can be seen without the store. An instruction embedded in an act is the
 * direction for that very act, so it is judged on scope and on the rules it
 * acknowledges, not on how the act departs. A binding or a reused
 * authorization was given for something else, earlier, and is judged against
 * the store by {@link checkAuthorization}.
 */
function instructionIssues(
  authorization: Authorization,
  scope: AuthorityScope,
  footprint: ActFootprint
): string[] {
  if (
    authorization.kind !== 'informed_instruction' &&
    authorization.kind !== 'explicit_instruction'
  )
    return [];
  const issues: string[] = [];
  if (!sameScope(authorization.scope, scope))
    issues.push('an instruction authorizes only in its own scope');
  const acknowledged =
    authorization.kind === 'informed_instruction' ? authorization.acknowledged : [];
  if (!acknowledgesEvery(acknowledged, footprint.departs_from))
    issues.push('an instruction departs only from the rules it acknowledges');
  return issues;
}

export const ExpectedStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('initial') }),
  z
    .strictObject({
      kind: z.literal('observed'),
      selection_ids: z.array(recordId()),
      correction_action_ids: z.array(recordId()),
    })
    .refine((state) => unique(state.selection_ids) && unique(state.correction_action_ids), {
      message: 'an observed state names each governing record once',
    }),
]);
export type ExpectedState = z.infer<typeof ExpectedStateSchema>;

/**
 * What governs a target: the selections that stand and the corrections that
 * changed what stands. A proposal governs nothing, so a detector's challenge
 * can never make an authorized write stale.
 */
export interface GoverningState {
  selection_ids: readonly string[];
  correction_action_ids: readonly string[];
}

/**
 * Creation has no prior token to present, so `initial` is its own
 * precondition: it holds only while nothing governs the target yet.
 */
export function checkExpectedState(
  expected: ExpectedState,
  current: GoverningState
): { ok: true } | { ok: false; code: 'STALE_SELECTION'; current: GoverningState } {
  const matches =
    expected.kind === 'initial'
      ? current.selection_ids.length === 0 && current.correction_action_ids.length === 0
      : sameMembers(expected.selection_ids, current.selection_ids) &&
        sameMembers(expected.correction_action_ids, current.correction_action_ids);
  return matches ? { ok: true } : { ok: false, code: 'STALE_SELECTION', current };
}

/**
 * Working choice, final recorded choice and explicit acceptance never imply
 * each other. Only an acceptance designates and needs authority; finishing a
 * task records a choice and adopts nothing.
 */
export const SelectionSchema = z
  .strictObject({
    selection_id: recordId(),
    kind: z.enum(['working', 'final_recorded', 'accepted']),
    target: RecordRevisionRefSchema,
    scope: AuthorityScopeSchema,
    designation: DesignationSchema.nullable(),
    selected_by: ActorSchema,
    authorization: AuthorizationSchema.nullable(),
    expected_state: ExpectedStateSchema,
  })
  .superRefine((selection, ctx) => {
    const accepted = selection.kind === 'accepted';
    if (accepted !== (selection.designation !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['designation'],
        message: 'only an accepted selection designates its target as adopted or background',
      });
    if (accepted !== (selection.authorization !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['authorization'],
        message: 'an accepted selection, and only an accepted selection, rests on an authorization',
      });
    if (selection.authorization !== null)
      for (const message of instructionIssues(
        selection.authorization,
        selection.scope,
        selectionFootprint(selection, [])
      ))
        ctx.addIssue({ code: 'custom', path: ['authorization'], message });
  });
export type Selection = z.infer<typeof SelectionSchema>;

/**
 * Adopting a revision beside another adopted revision of the same identity in
 * the same scope replaces nothing, but it creates a governing conflict, and a
 * conflict is only ever accepted deliberately. The writer finds those
 * revisions in the store and passes them here, so the authorization has to
 * acknowledge each one; otherwise the conflict is asked about, not recorded.
 */
export function selectionFootprint(
  selection: Pick<Selection, 'target' | 'designation'>,
  adoptedBeside: readonly ExpectationRevisionRef[]
): ActFootprint {
  if (selection.designation === null) return NOTHING;
  return {
    adopts: [{ revision: selection.target, designation: selection.designation }],
    departs_from: departing(adoptedBeside, 'stands_beside'),
    restates: [],
  };
}

export const ApprovalTargetSchema = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('revision'), revision: RecordRevisionRefSchema }),
    z.strictObject({ kind: z.literal('source_selector'), selector: SourceSelectorSchema }),
  ]),
  scope: AuthorityScopeSchema,
  designation: DesignationSchema,
});
export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>;

const sameSelector = (left: SourceSelector, right: SourceSelector) =>
  left.source_id === right.source_id &&
  left.location === right.location &&
  left.passage_sha256 === right.passage_sha256;

const boundSubjectKey = (target: ApprovalTarget) =>
  JSON.stringify([
    target.target.kind === 'revision'
      ? [
          'revision',
          target.target.revision.kind,
          target.target.revision.entity_id,
          target.target.revision.revision_id,
        ]
      : [
          'source_selector',
          target.target.selector.source_id,
          target.target.selector.location,
          target.target.selector.passage_sha256,
        ],
    scopeKey(target.scope),
  ]);

const approvalTargetKey = (target: ApprovalTarget) =>
  JSON.stringify([boundSubjectKey(target), target.designation]);

const ApprovalSchema = z.strictObject({
  source_plan_ref: label(),
  version: label(),
  plan_content_sha256: sha256(),
});

const ApprovedDepartureSchema = z.strictObject({
  departure: DepartureSchema,
  scope: AuthorityScopeSchema,
});

/**
 * `targets` may be empty: that is a plan approved as a plan, adopting nothing.
 * One target in one scope is bound once, so a binding can never say both
 * adopted and background about the same thing. `departures` lists, per scope,
 * exactly the departures the approver was shown; an approval that adopts a new
 * rule gives no authority to retire an old one it never mentioned, and an
 * approval to replace a rule is no approval to withdraw it. The authorization
 * evidence is its own retained source, independent of the plan-body hash.
 */
export const ApprovalBindingSchema = z
  .strictObject({
    binding_id: recordId(),
    approval: ApprovalSchema,
    targets: z.array(ApprovalTargetSchema),
    departures: z.array(ApprovedDepartureSchema),
    approved_by: ActorSchema,
    authorization_evidence_source_id: recordId(),
  })
  .refine((binding) => unique(binding.targets.map(boundSubjectKey)), {
    path: ['targets'],
    message: 'a binding names one target in one scope once',
  });
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

type BoundApproval = Pick<ApprovalBinding, 'approval' | 'targets' | 'departures'>;

const departureKey = (departure: Departure) =>
  JSON.stringify([
    revisionKey(departure.rule),
    departure.how,
    departure.exception_id,
    departure.replaced_by === null ? null : revisionKey(departure.replaced_by),
  ]);

const approvedDepartureKey = (entry: ApprovalBinding['departures'][number]) =>
  JSON.stringify([departureKey(entry.departure), scopeKey(entry.scope)]);

/**
 * A later binding stays covered by an approval only when it is the same
 * approval of the same plan bytes AND names an identical set of targets,
 * scopes, designations and departures. Byte-identical plan text with a changed
 * binding inherits nothing.
 */
export function bindingCoveredByApproval(prior: BoundApproval, next: BoundApproval): boolean {
  return (
    prior.approval.source_plan_ref === next.approval.source_plan_ref &&
    prior.approval.version === next.approval.version &&
    prior.approval.plan_content_sha256 === next.approval.plan_content_sha256 &&
    sameMembers(prior.targets.map(approvalTargetKey), next.targets.map(approvalTargetKey)) &&
    sameMembers(
      prior.departures.map(approvedDepartureKey),
      next.departures.map(approvedDepartureKey)
    )
  );
}

const bindingAdopts = (
  binding: Pick<ApprovalBinding, 'targets'> & {
    binding_id?: string;
    resolved_targets?: readonly SelectorResolution[];
  },
  adoption: ActFootprint['adopts'][number],
  scope: AuthorityScope
) => {
  const matches = (
    revision: RecordRevisionRef,
    targetScope: AuthorityScope,
    designation: Designation
  ) =>
    sameRevision(revision, adoption.revision) &&
    sameScope(targetScope, scope) &&
    designation === adoption.designation;
  return (
    binding.targets.some(
      (target) =>
        target.target.kind === 'revision' &&
        matches(target.target.revision, target.scope, target.designation)
    ) ||
    (binding.resolved_targets ?? []).some(
      (resolution) =>
        binding.binding_id === resolution.binding_id &&
        binding.targets.some(
          (target) =>
            target.target.kind === 'source_selector' &&
            sameSelector(target.target.selector, resolution.selector) &&
            sameScope(target.scope, resolution.scope) &&
            target.designation === resolution.designation
        ) &&
        matches(resolution.resolved, resolution.scope, resolution.designation)
    )
  );
};

/** An approval adopts exactly what it bound: this revision, in this scope, with this designation. */
export function selectionMatchesBinding(
  binding: Pick<ApprovalBinding, 'targets'>,
  selection: Pick<Selection, 'target' | 'scope' | 'designation'>
): boolean {
  return selectionFootprint(selection, []).adopts.some((adoption) =>
    bindingAdopts(binding, adoption, selection.scope)
  );
}

export const SelectorResolutionSchema = z.strictObject({
  binding_id: recordId(),
  selector: SourceSelectorSchema,
  resolved: RecordRevisionRefSchema,
  scope: AuthorityScopeSchema,
  designation: DesignationSchema,
});
export type SelectorResolution = z.infer<typeof SelectorResolutionSchema>;

export type ResolutionRefusal =
  | 'SELECTOR_NOT_BOUND'
  | 'RESOLVED_REVISION_NOT_FROM_PASSAGE'
  | 'RESOLVED_STATEMENT_NOT_VERBATIM'
  | 'SELECTOR_ALREADY_RESOLVED';

/**
 * Resolving an approved selector to a local identity may preserve its binding
 * but never broaden it. The approver saw a passage, so what receives the
 * approved standing is that passage verbatim: the resolved revision cites the
 * passage and its statement hashes to the passage's hash. Nothing here can
 * judge whether a paraphrase preserves meaning, so a paraphrase, an agent's or
 * a detector's, is a later proposed revision and never the resolution. One
 * passage never gets two identities, whichever binding or scope asks; an
 * existing requirement is reached by publishing a revision of it that restates
 * the passage, never by minting a second identity.
 */
export function checkSelectorResolution(input: {
  binding: Pick<ApprovalBinding, 'binding_id' | 'targets'>;
  resolution: SelectorResolution;
  resolved_revision: { passages: readonly SourceSelector[]; statement_sha256: string };
  existing: readonly SelectorResolution[];
}): { ok: true } | { ok: false; code: ResolutionRefusal } {
  const { binding, resolution, resolved_revision } = input;
  const bound =
    binding.binding_id === resolution.binding_id &&
    binding.targets.some(
      (target) =>
        target.target.kind === 'source_selector' &&
        sameSelector(target.target.selector, resolution.selector) &&
        sameScope(target.scope, resolution.scope) &&
        target.designation === resolution.designation
    );
  if (!bound) return { ok: false, code: 'SELECTOR_NOT_BOUND' };
  if (!resolved_revision.passages.some((passage) => sameSelector(passage, resolution.selector)))
    return { ok: false, code: 'RESOLVED_REVISION_NOT_FROM_PASSAGE' };
  if (resolved_revision.statement_sha256 !== resolution.selector.passage_sha256)
    return { ok: false, code: 'RESOLVED_STATEMENT_NOT_VERBATIM' };
  const other = input.existing.some(
    (prior) =>
      sameSelector(prior.selector, resolution.selector) &&
      prior.resolved.entity_id !== resolution.resolved.entity_id
  );
  return other ? { ok: false, code: 'SELECTOR_ALREADY_RESOLVED' } : { ok: true };
}

/**
 * A passage of a source that states, word for word, what a revision already
 * says. It is not a revision of anything: the statement, its identity and its
 * standing are untouched, so a passage restatement adopts nothing, departs
 * from nothing and governs nothing. What it records is the one thing a
 * repeated capture really does add — another retained occurrence of the same
 * words — without a second identity for any of them and without a revision
 * identical to its predecessor once per restating source.
 *
 * The name says `passage` because {@link ActFootprint}'s `restates` is a
 * different thing entirely: what an act does to findings and relationships
 * whose standing it changes.
 *
 * It carries no standing and no authorization, because a repetition raises
 * neither: a source that repeats a rule does not adopt it, and adopting is an
 * act of its own. That is also why a detector's passage restatement is a
 * candidate like everything else background processing writes without anything
 * having to say so — there is nothing here for an attribution to establish.
 */
export const PassageRestatementSchema = z
  .strictObject({
    restatement_id: recordId(),
    passage: SourceSelectorSchema,
    restates: RecordRevisionRefSchema,
    attributed_to: AttributionSchema,
    recorded_at: instant(),
  })
  .refine((restatement) => restatement.restates.kind !== 'relationship', {
    path: ['restates'],
    message: 'a relationship states nothing; a passage restatement names a revision that does',
  });
export type PassageRestatement = z.infer<typeof PassageRestatementSchema>;

export type PassageRestatementRefusal =
  | 'RESTATED_STATEMENT_NOT_VERBATIM'
  | 'SOURCE_RETAINED_ONLY_BY_REFERENCE'
  | 'STATEMENT_NOT_IN_THE_SOURCE'
  | 'PASSAGE_ALREADY_CITED_BY_THE_REVISION';

/** What the store holds of the source a passage names: its retained text, or nothing readable. */
export type RestatingSource =
  | { kind: 'retained_text'; text: string }
  | { kind: 'retained_reference' };

/**
 * Judged against the store, inside the transaction that appends it. Word for
 * word is a hash equality and never a judgment: the passage hashes to what the
 * revision states, or the two are not the same words and there is nothing to
 * record. A paraphrase is a later proposed revision, which is what
 * {@link checkSelectorResolution} already says about an approved selector.
 *
 * The words must also be in the source the passage names. Without that the
 * hash says only that the caller knew the statement, and any retained source
 * could be made to corroborate any revision. A source retained only by an
 * immutable reference holds no text here, so nothing about it can be checked
 * and it cannot restate anything.
 *
 * A passage the revision itself cites is not a second occurrence of it. Equal
 * wording is never proof of identity and a carried copy is never independent
 * corroboration, so counting a revision's own source again is exactly the
 * mistake this record exists to avoid.
 *
 * Two distinct revisions may state the same words, so one passage may restate
 * both; what it may never do is give either of them a second identity.
 */
export function checkPassageRestatement(input: {
  restatement: Pick<PassageRestatement, 'passage'>;
  restated_revision: { passages: readonly SourceSelector[]; statement: string };
  passage_source: RestatingSource;
}): { ok: true } | { ok: false; code: PassageRestatementRefusal } {
  const { passage } = input.restatement;
  const { statement } = input.restated_revision;
  if (createHash('sha256').update(statement, 'utf8').digest('hex') !== passage.passage_sha256)
    return { ok: false, code: 'RESTATED_STATEMENT_NOT_VERBATIM' };
  if (input.passage_source.kind === 'retained_reference')
    return { ok: false, code: 'SOURCE_RETAINED_ONLY_BY_REFERENCE' };
  if (!input.passage_source.text.includes(statement))
    return { ok: false, code: 'STATEMENT_NOT_IN_THE_SOURCE' };
  return input.restated_revision.passages.some((cited) => sameSelector(cited, passage))
    ? { ok: false, code: 'PASSAGE_ALREADY_CITED_BY_THE_REVISION' }
    : { ok: true };
}

const InstructionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('informed_instruction'),
    instruction_source_id: recordId(),
    acknowledged: z.array(ExpectationRevisionRefSchema).min(1),
    scope: AuthorityScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('explicit_instruction'),
    instruction_source_id: recordId(),
    scope: AuthorityScopeSchema,
  }),
]);

/**
 * What `reused_authorization` cites. The writer records one for every act it
 * publishes under an embedded instruction, carrying exactly that act's
 * footprint, so a later session can finish or repeat the same act without
 * asking again. `context` narrows it to the work it was given for; with no
 * context it covers the named footprint wherever its scope reaches.
 */
export const AuthorizationRecordSchema = z
  .strictObject({
    authorization_id: recordId(),
    instruction: InstructionSchema,
    adopts: z.array(AdoptionSchema),
    departs_from: z.array(DepartureSchema),
    restates: z.array(RecordRevisionRefSchema),
    context: ApplicabilitySelectorSchema.nullable(),
    granted_by: ActorSchema,
    recorded_at: instant(),
  })
  .superRefine((record, ctx) => {
    if (footprintIsEmpty(record))
      ctx.addIssue({ code: 'custom', message: 'an authorization authorizes something' });
    for (const message of instructionIssues(record.instruction, record.instruction.scope, record))
      ctx.addIssue({ code: 'custom', path: ['instruction'], message });
  });
export type AuthorizationRecord = z.infer<typeof AuthorizationRecordSchema>;

/**
 * Ends an authorization, an exception, a conflict answer or an assignment from
 * now on and preserves what was done under it. Whoever revokes acts on an
 * instruction in the same scope; nothing given earlier, for something else, can
 * revoke.
 */
export const RevocationSchema = z
  .strictObject({
    revocation_id: recordId(),
    revokes: z.strictObject({
      kind: z.enum(['authorization', 'exception', 'conflict_answer', 'assignment']),
      id: recordId(),
    }),
    scope: AuthorityScopeSchema,
    revoked_by: ActorSchema,
    source_id: recordId(),
    instruction: InstructionSchema,
    recorded_at: instant(),
  })
  .refine((revocation) => sameScope(revocation.instruction.scope, revocation.scope), {
    path: ['instruction'],
    message: 'an instruction authorizes only in its own scope',
  });
export type Revocation = z.infer<typeof RevocationSchema>;

export interface AuthorizationContext {
  bindings: readonly (Pick<ApprovalBinding, 'binding_id' | 'targets' | 'departures'> & {
    resolved_targets?: readonly SelectorResolution[];
  })[];
  /**
   * `valid` is false once a revocation names the record or a rule it departs
   * from no longer stands. `covers_this_work` is the record's own context
   * evaluated against the work at hand, and `applies` when it has none.
   */
  earlier: readonly (Pick<
    AuthorizationRecord,
    'authorization_id' | 'adopts' | 'departs_from' | 'restates'
  > & {
    scope: AuthorityScope;
    covers_this_work: Applicability;
    valid: boolean;
  })[];
  /**
   * The assignment an act cites, as the store reads it. `valid` is false once a
   * revocation reaching its scope names it or a rule it rests on no longer
   * stands; `covers_this_work` is its validity window judged at the act's time,
   * and `unresolved` where the act named no time, which is refused rather than
   * read as still valid.
   */
  assignments: readonly {
    assignment_id: string;
    scope: AuthorityScope;
    delegated: ActFootprint;
    responsible: Actor;
    covers_this_work: Applicability;
    valid: boolean;
  }[];
}

export type AuthorizationRefusal =
  | 'NOTHING_TO_AUTHORIZE'
  | 'SCOPE_EXCEEDS_AUTHORIZATION'
  | 'RULE_NOT_ACKNOWLEDGED'
  | 'BINDING_NOT_FOUND'
  | 'BINDING_DOES_NOT_COVER_ADOPTION'
  | 'BINDING_DOES_NOT_COVER_DEPARTURE'
  | 'BINDING_DOES_NOT_COVER_RESTATEMENT'
  | 'AUTHORIZATION_NOT_FOUND'
  | 'AUTHORIZATION_NOT_VALID'
  | 'AUTHORIZATION_DOES_NOT_COVER_THIS_WORK'
  | 'AUTHORIZATION_DOES_NOT_COVER_ADOPTION'
  | 'AUTHORIZATION_DOES_NOT_COVER_DEPARTURE'
  | 'AUTHORIZATION_DOES_NOT_COVER_RESTATEMENT'
  | 'ASSIGNMENT_NOT_FOUND'
  | 'ASSIGNMENT_NOT_VALID'
  | 'ACTOR_NOT_RESPONSIBLE'
  | 'ASSIGNMENT_DOES_NOT_COVER_ADOPTION'
  | 'ASSIGNMENT_DOES_NOT_COVER_DEPARTURE'
  | 'ASSIGNMENT_DOES_NOT_COVER_RESTATEMENT';

const sameAdoption = (
  left: ActFootprint['adopts'][number],
  right: ActFootprint['adopts'][number]
) => sameRevision(left.revision, right.revision) && left.designation === right.designation;

/**
 * Which part of an act a footprint given earlier does not cover, or null when
 * it covers the whole of it. A departure is covered only by the same departure:
 * leave to except a rule is never leave to withdraw it.
 */
function footprintGap(
  act: ActFootprint,
  given: ActFootprint,
  replacementNeedsItsAdoption: boolean
): 'adoption' | 'departure' | 'restatement' | null {
  if (!act.adopts.every((adoption) => given.adopts.some((held) => sameAdoption(held, adoption))))
    return 'adoption';
  const departures = act.departs_from.every(
    (departure) =>
      given.departs_from.some((held) => sameDeparture(held, departure)) &&
      (!replacementNeedsItsAdoption ||
        departure.replaced_by === null ||
        act.adopts.some((adoption) =>
          sameRevision(adoption.revision, departure.replaced_by as RecordRevisionRef)
        ))
  );
  if (!departures) return 'departure';
  return act.restates.every((ref) => given.restates.some((held) => sameRevision(held, ref)))
    ? null
    : 'restatement';
}

/** Whether the act is by the very identity an assignment made responsible. */
const actsAsResponsible = (acting: Attribution | null, responsible: Actor) =>
  acting !== null &&
  acting.kind === 'actor' &&
  acting.actor.identity !== null &&
  acting.actor.identity === responsible.identity;

/**
 * The store-side half of authority. Writers pass the act's footprint, from the
 * footprint function of its kind, and run this inside the transaction that
 * publishes the act. Everything the act adopts, departs from and restates must
 * be covered by the thing cited. An empty footprint is refused so nothing
 * passes vacuously. A binding, an earlier authorization or an assignment was
 * given for a particular purpose, so a departure is covered only by the same
 * departure: leave to except a rule is never leave to withdraw it, and a
 * replacement is covered only together with the adoption it was approved with.
 *
 * `acting` is the attribution of the act being published, which only an
 * assignment reads: it delegates to one responsible party, and an act that does
 * not claim that identity is not an act under it. The identity is claimed, not
 * authenticated; nothing here can verify it.
 */
export function checkAuthorization(input: {
  authorization: Authorization;
  scope: AuthorityScope;
  footprint: ActFootprint;
  acting: Attribution | null;
  context: AuthorizationContext;
}): { ok: true } | { ok: false; code: AuthorizationRefusal } {
  const { authorization, scope, footprint, context } = input;
  if (footprintIsEmpty(footprint)) return { ok: false, code: 'NOTHING_TO_AUTHORIZE' };
  if (
    authorization.kind === 'informed_instruction' ||
    authorization.kind === 'explicit_instruction'
  ) {
    if (!sameScope(authorization.scope, scope))
      return { ok: false, code: 'SCOPE_EXCEEDS_AUTHORIZATION' };
    const acknowledged =
      authorization.kind === 'informed_instruction' ? authorization.acknowledged : [];
    return acknowledgesEvery(acknowledged, footprint.departs_from)
      ? { ok: true }
      : { ok: false, code: 'RULE_NOT_ACKNOWLEDGED' };
  }
  if (authorization.kind === 'approval_binding') {
    const binding = context.bindings.find(
      (candidate) => candidate.binding_id === authorization.binding_id
    );
    if (binding === undefined) return { ok: false, code: 'BINDING_NOT_FOUND' };
    if (!footprint.adopts.every((adoption) => bindingAdopts(binding, adoption, scope)))
      return { ok: false, code: 'BINDING_DOES_NOT_COVER_ADOPTION' };
    const approved = binding.departures
      .filter((entry) => sameScope(entry.scope, scope))
      .map((entry) => entry.departure);
    const covered = footprint.departs_from.every(
      (departure) =>
        approved.some((entry) => sameDeparture(entry, departure)) &&
        (departure.replaced_by === null ||
          footprint.adopts.some((adoption) =>
            sameRevision(adoption.revision, departure.replaced_by as RecordRevisionRef)
          ))
    );
    if (!covered) return { ok: false, code: 'BINDING_DOES_NOT_COVER_DEPARTURE' };
    return footprint.restates.length === 0
      ? { ok: true }
      : { ok: false, code: 'BINDING_DOES_NOT_COVER_RESTATEMENT' };
  }
  if (authorization.kind === 'assignment') {
    const assignment = context.assignments.find(
      (candidate) => candidate.assignment_id === authorization.assignment_id
    );
    if (assignment === undefined) return { ok: false, code: 'ASSIGNMENT_NOT_FOUND' };
    // A revoked assignment, one whose basis ended, and one whose validity cannot
    // be judged at this act's time are all the same answer: nothing delegated
    // here covers this act now.
    if (!assignment.valid || assignment.covers_this_work !== 'applies')
      return { ok: false, code: 'ASSIGNMENT_NOT_VALID' };
    if (!sameScope(assignment.scope, scope))
      return { ok: false, code: 'SCOPE_EXCEEDS_AUTHORIZATION' };
    if (!actsAsResponsible(input.acting, assignment.responsible))
      return { ok: false, code: 'ACTOR_NOT_RESPONSIBLE' };
    const gap = footprintGap(footprint, assignment.delegated, true);
    if (gap === 'adoption') return { ok: false, code: 'ASSIGNMENT_DOES_NOT_COVER_ADOPTION' };
    if (gap === 'departure') return { ok: false, code: 'ASSIGNMENT_DOES_NOT_COVER_DEPARTURE' };
    return gap === null
      ? { ok: true }
      : { ok: false, code: 'ASSIGNMENT_DOES_NOT_COVER_RESTATEMENT' };
  }
  const earlier = context.earlier.find(
    (candidate) => candidate.authorization_id === authorization.authorization_id
  );
  if (earlier === undefined) return { ok: false, code: 'AUTHORIZATION_NOT_FOUND' };
  if (!earlier.valid) return { ok: false, code: 'AUTHORIZATION_NOT_VALID' };
  if (!sameScope(earlier.scope, scope)) return { ok: false, code: 'SCOPE_EXCEEDS_AUTHORIZATION' };
  if (earlier.covers_this_work !== 'applies')
    return { ok: false, code: 'AUTHORIZATION_DOES_NOT_COVER_THIS_WORK' };
  const gap = footprintGap(footprint, earlier, false);
  if (gap === 'adoption') return { ok: false, code: 'AUTHORIZATION_DOES_NOT_COVER_ADOPTION' };
  if (gap === 'departure') return { ok: false, code: 'AUTHORIZATION_DOES_NOT_COVER_DEPARTURE' };
  return gap === null
    ? { ok: true }
    : { ok: false, code: 'AUTHORIZATION_DOES_NOT_COVER_RESTATEMENT' };
}

const ExceptionEndSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('until_time'), until: instant() }),
  z.strictObject({ kind: z.literal('until_condition'), condition: proseText() }),
  z.strictObject({ kind: z.literal('until_revoked') }),
  z.strictObject({ kind: z.literal('unknown') }),
]);

/**
 * An exception always departs from its expectation, so only an authorization
 * that acknowledges that expectation can carry it. An exception that applies
 * everywhere with no known end is a retirement wearing an exception's name,
 * and an ending with no recorded behavior would leave expiry undefined.
 */
export const ExceptionSchema = z
  .strictObject({
    exception_id: recordId(),
    expectation: ExpectationRevisionRefSchema,
    context: ApplicabilitySelectorSchema,
    scope: AuthorityScopeSchema,
    rationale: proseText(),
    granted_by: ActorSchema,
    source_id: recordId(),
    authorization: AuthorizationSchema,
    ends: ExceptionEndSchema,
    end_behavior: z.enum(['expectation_applies_again', 'review_required', 'none_recorded']),
    expected_state: ExpectedStateSchema,
  })
  .superRefine((exception, ctx) => {
    for (const message of instructionIssues(
      exception.authorization,
      exception.scope,
      exceptionFootprint(exception)
    ))
      ctx.addIssue({ code: 'custom', path: ['authorization'], message });
    if (exception.context.all_of.length === 0 && exception.ends.kind === 'unknown')
      ctx.addIssue({
        code: 'custom',
        path: ['ends'],
        message: 'an exception with no context needs a known way to end',
      });
    const canExpire =
      exception.ends.kind === 'until_time' || exception.ends.kind === 'until_condition';
    if (canExpire && exception.end_behavior === 'none_recorded')
      ctx.addIssue({
        code: 'custom',
        path: ['end_behavior'],
        message: 'an exception that can expire records what happens when it does',
      });
  });
export type KnowledgeException = z.infer<typeof ExceptionSchema>;

export function exceptionFootprint(
  exception: Pick<KnowledgeException, 'exception_id' | 'expectation'>
): ActFootprint {
  return {
    adopts: [],
    departs_from: [
      {
        rule: exception.expectation,
        how: 'excepts',
        exception_id: exception.exception_id,
        replaced_by: null,
      },
    ],
    restates: [],
  };
}

/**
 * Ending applies the recorded end behavior; it proves no compliance and
 * resurrects nothing. An end that cannot be evaluated is unresolved, not over
 * and not still running.
 */
export function exceptionStanding(
  exception: Pick<KnowledgeException, 'ends'>,
  at: { time?: string; condition_met?: boolean; revoked: boolean }
): 'in_effect' | 'ended' | 'unresolved' {
  if (at.revoked) return 'ended';
  const { ends } = exception;
  if (ends.kind === 'until_revoked') return 'in_effect';
  if (ends.kind === 'unknown') return 'unresolved';
  if (ends.kind === 'until_condition') {
    if (at.condition_met === undefined) return 'unresolved';
    return at.condition_met ? 'ended' : 'in_effect';
  }
  const now = at.time === undefined ? Number.NaN : Date.parse(at.time);
  const until = Date.parse(ends.until);
  if (Number.isNaN(now) || Number.isNaN(until)) return 'unresolved';
  return now >= until ? 'ended' : 'in_effect';
}

const correctionCommon = {
  action_id: recordId(),
  targets: z.array(RecordRevisionRefSchema).min(1),
  scope: AuthorityScopeSchema,
  attributed_to: AttributionSchema,
  source_id: recordId(),
  authorization: AuthorizationSchema.nullable(),
  expected_state: ExpectedStateSchema,
};

const CorrectionActionShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...correctionCommon, kind: z.literal('challenge'), explanation: proseText() }),
  z.strictObject({
    ...correctionCommon,
    kind: z.literal('factual_correction'),
    corrected_account: proseText(),
  }),
  z.strictObject({
    ...correctionCommon,
    kind: z.literal('identity_correction'),
    mistaken_predecessor: RecordRevisionRefSchema,
    intended_interpretation: proseText(),
  }),
  z.strictObject({
    ...correctionCommon,
    kind: z.literal('use_correction'),
    mistaken_use: z.strictObject({
      artifact_id: recordId(),
      plan_event_id: recordId(),
      target: ExpectationRevisionRefSchema,
    }),
    intended_interpretation: proseText(),
  }),
  z.strictObject({
    ...correctionCommon,
    kind: z.literal('acceptance'),
    accepts_action_id: recordId(),
  }),
  z.strictObject({ ...correctionCommon, kind: z.literal('withdrawal'), reason: proseText() }),
  z.strictObject({
    ...correctionCommon,
    kind: z.literal('accepted_replacement'),
    replacement: RecordRevisionRefSchema,
    designation: DesignationSchema,
  }),
  z.strictObject({
    ...correctionCommon,
    kind: z.literal('reversal'),
    reverses_action_id: recordId(),
    resulting_selection: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('revision'),
        revision: RecordRevisionRefSchema,
        designation: DesignationSchema,
      }),
      z.strictObject({ kind: z.literal('none') }),
    ]),
  }),
]);
type CorrectionActionShape = z.infer<typeof CorrectionActionShapeSchema>;

const PROPOSING_CORRECTIONS: readonly CorrectionActionShape['kind'][] = [
  'challenge',
  'factual_correction',
  'identity_correction',
  'use_correction',
];

/**
 * A proposing correction appends an attributed account: it carries no
 * authorization, changes nothing that stands and governs nothing. Every reader
 * of a correction needs this, so it is the contract's to state, not theirs.
 */
export function isProposingCorrection(kind: CorrectionAction['kind']): boolean {
  return PROPOSING_CORRECTIONS.includes(kind);
}

/**
 * How many actions one act may follow. A reversal consumes the action it
 * follows, so a chain this long is undoing and redoing without end. Bounding it
 * keeps every reader's walk finite and the footprint recursion shallow.
 * Inconsistent imported history may still hold a longer chain, which stays
 * inspectable; no writer of this build can add to one.
 */
export const MAX_FOLLOWED_CHAIN = 64;

const followedId = (action: CorrectionActionShape) => {
  if (action.kind === 'reversal') return action.reverses_action_id;
  return action.kind === 'acceptance' ? action.accepts_action_id : null;
};

/**
 * Context-free rules only. What a reversal or an acceptance does depends on
 * the action it follows, and whether a relationship ever stood depends on the
 * store, so authority over a correction is decided by {@link checkCorrection}.
 * A replacement is the record that makes its replacement stand; no separate
 * selection follows it.
 */
export const CorrectionActionSchema = CorrectionActionShapeSchema.superRefine((action, ctx) => {
  if (!PROPOSING_CORRECTIONS.includes(action.kind) && action.attributed_to.kind === 'detector')
    ctx.addIssue({
      code: 'custom',
      path: ['attributed_to'],
      message: 'a detector proposes a correction; only an actor changes what stands',
    });
  if (PROPOSING_CORRECTIONS.includes(action.kind) && action.authorization !== null)
    ctx.addIssue({
      code: 'custom',
      path: ['authorization'],
      message: 'a proposal changes nothing that stands, so there is nothing to authorize',
    });
  const adopted =
    action.kind === 'accepted_replacement'
      ? [action.replacement]
      : action.kind === 'reversal' && action.resulting_selection.kind === 'revision'
        ? [action.resulting_selection.revision]
        : [];
  // A reversal of a withdrawal restores the very revision it names, so only a replacement is held to this.
  if (
    action.kind === 'accepted_replacement' &&
    action.targets.some((target) => sameRevision(target, action.replacement))
  )
    ctx.addIssue({
      code: 'custom',
      path: ['targets'],
      message: 'a replacement does not replace a revision with itself',
    });
  if (adopted.some((revision) => action.targets.some((target) => target.kind !== revision.kind)))
    ctx.addIssue({
      code: 'custom',
      path: ['targets'],
      message: 'a replacement or restored revision is of the same kind as what it replaces',
    });
  if (followedId(action) === action.action_id)
    ctx.addIssue({
      code: 'custom',
      path: ['action_id'],
      message: 'a reversal or acceptance follows an earlier action, never itself',
    });
});
export type CorrectionAction = z.infer<typeof CorrectionActionSchema>;

/** The action a reversal or acceptance follows, with whatever that one followed in turn. */
export interface FollowedCorrection {
  action: CorrectionAction;
  followed: FollowedCorrection | null;
}

const expectationsOf = (refs: readonly RecordRevisionRef[]) =>
  refs.filter(isExpectation) as ExpectationRevisionRef[];
const evidenceOf = (refs: readonly RecordRevisionRef[]) =>
  refs.filter((ref) => !isExpectation(ref));

function departing(
  rules: readonly ExpectationRevisionRef[],
  how: Exclude<Departure['how'], 'excepts' | 'replaces'>
): Departure[] {
  return rules.map((rule) => ({ rule, how, exception_id: null, replaced_by: null }));
}

const replacedBy = (
  rules: readonly ExpectationRevisionRef[],
  replacement: RecordRevisionRef
): Departure[] =>
  rules.map((rule) => ({ rule, how: 'replaces', exception_id: null, replaced_by: replacement }));

const uniqueDepartures = (departures: readonly Departure[]) =>
  departures.filter(
    (departure, index) =>
      departures.findIndex((other) => departureKey(other) === departureKey(departure)) === index
  );

/**
 * A proposing correction appends an attributed account and leaves everything
 * standing as it was. A withdrawal or a replacement acts on what it names. An
 * acceptance acts on what the proposal it follows named. A reversal acts on
 * everything the action it follows did: what that action made stand stops
 * standing, and every rule it stopped, replaced or corrected has its standing
 * changed again, whether or not the reversal restores anything. So neither is
 * ever judged alone, and undoing an owner's withdrawal is never free.
 */
export function correctionFootprint(
  action: CorrectionAction,
  followed: FollowedCorrection | null
): ActFootprint {
  if (PROPOSING_CORRECTIONS.includes(action.kind)) return NOTHING;
  if (action.kind === 'withdrawal')
    return {
      adopts: [],
      departs_from: departing(expectationsOf(action.targets), 'withdraws'),
      restates: evidenceOf(action.targets),
    };
  if (action.kind === 'accepted_replacement')
    return {
      adopts: [{ revision: action.replacement, designation: action.designation }],
      departs_from: replacedBy(expectationsOf(action.targets), action.replacement),
      restates: evidenceOf(action.targets),
    };
  if (followed === null) return NOTHING;
  if (action.kind === 'acceptance')
    return {
      adopts: [],
      departs_from: departing(expectationsOf(followed.action.targets), 'corrects'),
      restates: evidenceOf(followed.action.targets),
    };
  const undone = correctionFootprint(followed.action, followed.followed);
  const restored =
    action.kind === 'reversal' && action.resulting_selection.kind === 'revision'
      ? action.resulting_selection
      : null;
  const unmade = undone.adopts.map((adoption) => adoption.revision);
  return {
    adopts:
      restored === null ? [] : [{ revision: restored.revision, designation: restored.designation }],
    departs_from: uniqueDepartures([
      ...(restored === null
        ? departing(expectationsOf(unmade), 'withdraws')
        : replacedBy(expectationsOf(unmade), restored.revision)),
      ...departing(
        undone.departs_from.map((departure) => departure.rule),
        'corrects'
      ),
    ]),
    restates: [...evidenceOf(unmade), ...undone.restates],
  };
}

export type CorrectionChangeClass = 'intent_change' | 'factual_correction' | 'proposal';

const touchesARule = (footprint: ActFootprint) =>
  footprint.departs_from.length > 0 ||
  footprint.adopts.some((adoption) => isExpectation(adoption.revision));

/**
 * Derived, never declared, so a changed requirement cannot be filed as a
 * factual correction and an unaccepted challenge cannot be listed as a changed
 * requirement. It reads the footprint the store judged. Only a proposing
 * correction is a proposal; an act that takes effect on findings, or on a
 * relationship that was only ever suggested, corrects an account.
 */
export function correctionChangeClass(
  action: CorrectionAction,
  judged: ActFootprint
): CorrectionChangeClass {
  if (touchesARule(judged) || judged.restates.some((ref) => ref.kind === 'relationship'))
    return 'intent_change';
  if (
    !PROPOSING_CORRECTIONS.includes(action.kind) ||
    action.kind === 'factual_correction' ||
    action.targets.every((target) => target.kind === 'claim')
  )
    return 'factual_correction';
  return 'proposal';
}

export type CorrectionRefusal =
  | AuthorizationRefusal
  | 'FOLLOWED_ACTION_REQUIRED'
  | 'FOLLOWED_ACTION_MISMATCH'
  | 'FOLLOWED_ACTION_ALREADY_FOLLOWED'
  | 'FOLLOWED_CHAIN_TOO_LONG'
  | 'ACCEPTS_NON_PROPOSAL'
  | 'TARGETS_DIFFER_FROM_FOLLOWED'
  | 'RESTORES_WHAT_WAS_NOT_DEPARTED_FROM'
  | 'REVERSES_ANOTHERS_ACT'
  | 'RELATIONSHIP_TARGET_UNKNOWN'
  | 'AUTHORIZATION_REQUIRED'
  | 'FINDING_OUTSIDE_ITS_ARTIFACT';

/** What the store knows about a relationship a correction names. */
export interface RelationshipTarget {
  relationship_id: string;
  standing: 'suggested' | 'established';
  relation: Relationship['relation'];
  from: RecordRevisionRef;
  to: RecordRevisionRef;
  attributed_to: Attribution;
}

/**
 * Whether an act is by whoever the earlier one is attributed to. An unknown
 * actor is nobody in particular, and a name someone else asserted is not the
 * named actor acting, so neither ever matches. The writer takes the acting
 * attribution from the session that publishes, never from its caller.
 */
const actsAs = (acting: Attribution, earlier: Attribution) =>
  acting.kind === 'actor'
    ? earlier.kind === 'actor' &&
      acting.actor.identity !== null &&
      acting.actor.basis !== 'other_assertion' &&
      acting.actor.identity === earlier.actor.identity
    : earlier.kind === 'detector' && acting.detector === earlier.detector;

/** A withdrawal stops what it names; undoing an act has the opposite effect of that act. */
const stopsWhatItNames = (
  action: CorrectionAction,
  followed: FollowedCorrection | null
): boolean =>
  action.kind === 'reversal' && followed !== null
    ? !stopsWhatItNames(followed.action, followed.followed)
    : true;

/**
 * The store-side judgment of a correction, run inside the transaction that
 * appends it. The writer supplies the action it follows, the followers that
 * action still has (a follower that was itself reversed no longer counts),
 * what it knows of each relationship the correction names, the other adopted
 * revisions of the same identity in the same scope, and whether every finding
 * it restates originates in the artifact the correction is scoped to.
 *
 * A rule, or a relationship that was established, changes only with authority
 * over the whole footprint; undoing an established replacement changes the
 * standing of the revision that replaced, so it departs from it, and putting
 * that replacement back departs from the revision it replaces. A relationship
 * that replaces nothing is withdrawn by whoever established it. A suggested
 * relationship never stood, so anyone may withdraw it. A finding needs no
 * authority inside the artifact it originates in; from any other artifact it
 * cannot be reached at all, only on an instruction at project scope. An act
 * that changed nothing standing, a proposal or its retraction, is undone by
 * whoever made it, or on an instruction in scope. A reversal restores only
 * what the act it follows departed from; anything else is a replacement.
 */
export function checkCorrection(input: {
  action: CorrectionAction;
  followed: FollowedCorrection | null;
  standing_followers: readonly string[];
  relationship_targets: readonly RelationshipTarget[];
  adopted_beside: readonly ExpectationRevisionRef[];
  findings_originate_in_scope: boolean;
  context: AuthorizationContext;
}):
  | { ok: true; footprint: ActFootprint; change_class: CorrectionChangeClass }
  | { ok: false; code: CorrectionRefusal } {
  const { action, followed } = input;
  const follows = followedId(action);
  if (follows !== null) {
    if (followed === null) return { ok: false, code: 'FOLLOWED_ACTION_REQUIRED' };
    if (followed.action.action_id !== follows)
      return { ok: false, code: 'FOLLOWED_ACTION_MISMATCH' };
    if (input.standing_followers.length > 0)
      return { ok: false, code: 'FOLLOWED_ACTION_ALREADY_FOLLOWED' };
    let links = 0;
    for (let link: FollowedCorrection | null = followed; link !== null; link = link.followed)
      links += 1;
    if (links > MAX_FOLLOWED_CHAIN) return { ok: false, code: 'FOLLOWED_CHAIN_TOO_LONG' };
    if (action.kind === 'acceptance' && !PROPOSING_CORRECTIONS.includes(followed.action.kind))
      return { ok: false, code: 'ACCEPTS_NON_PROPOSAL' };
    const made =
      action.kind === 'acceptance'
        ? []
        : correctionFootprint(followed.action, followed.followed).adopts.map((a) => a.revision);
    const expected = made.length > 0 ? made : followed.action.targets;
    if (!sameMembers(action.targets.map(revisionKey), expected.map(revisionKey)))
      return { ok: false, code: 'TARGETS_DIFFER_FROM_FOLLOWED' };
    if (action.kind === 'reversal' && action.resulting_selection.kind === 'revision') {
      const restored = action.resulting_selection.revision;
      const undone = correctionFootprint(followed.action, followed.followed);
      const departed = [
        ...undone.departs_from.map((departure) => departure.rule),
        ...undone.restates,
      ];
      if (!departed.some((revision) => sameRevision(revision, restored)))
        return { ok: false, code: 'RESTORES_WHAT_WAS_NOT_DEPARTED_FROM' };
    }
  }
  const named = action.targets.filter((target) => target.kind === 'relationship');
  const known = named.map((target) =>
    input.relationship_targets.find((entry) => entry.relationship_id === target.entity_id)
  );
  if (known.some((entry) => entry === undefined))
    return { ok: false, code: 'RELATIONSHIP_TARGET_UNKNOWN' };
  const established = (known as RelationshipTarget[]).filter(
    (entry) => entry.standing === 'established'
  );
  const replacements = established.filter((entry) => entry.relation === 'supersedes');
  const whole = correctionFootprint(action, followed);
  const adoptsARule = whole.adopts.some((adoption) => isExpectation(adoption.revision));
  const footprint: ActFootprint = {
    adopts: whole.adopts,
    departs_from: uniqueDepartures([
      ...whole.departs_from,
      ...(stopsWhatItNames(action, followed)
        ? departing(expectationsOf(replacements.map((entry) => entry.from)), 'withdraws')
        : replacements.flatMap((entry) => replacedBy(expectationsOf([entry.to]), entry.from))),
      ...(adoptsARule
        ? departing(
            input.adopted_beside.filter(
              (rule) => !action.targets.some((target) => sameRevision(target, rule))
            ),
            'stands_beside'
          )
        : []),
    ]),
    restates: whole.restates.filter(
      (ref) =>
        ref.kind !== 'relationship' ||
        established.some((entry) => entry.relationship_id === ref.entity_id)
    ),
  };
  const restatesFindings = footprint.restates.some((ref) => ref.kind === 'claim');
  if (restatesFindings && !input.findings_originate_in_scope && action.scope.kind === 'artifact')
    return { ok: false, code: 'FINDING_OUTSIDE_ITS_ARTIFACT' };
  const establishedByAnother = established.filter(
    (entry) => entry.relation === 'supersedes' || !actsAs(action.attributed_to, entry.attributed_to)
  );
  const standsChanged =
    touchesARule(footprint) ||
    footprint.restates.some(
      (ref) =>
        ref.kind === 'relationship' &&
        establishedByAnother.some((entry) => entry.relationship_id === ref.entity_id)
    );
  const change_class = correctionChangeClass(action, footprint);
  if (footprintIsEmpty(footprint)) {
    const undoesAnothersAct =
      followed !== null &&
      action.kind === 'reversal' &&
      !actsAs(action.attributed_to, followed.action.attributed_to);
    if (!undoesAnothersAct)
      return action.authorization === null
        ? { ok: true, footprint, change_class }
        : { ok: false, code: 'NOTHING_TO_AUTHORIZE' };
    const instructed =
      action.authorization !== null &&
      (action.authorization.kind === 'informed_instruction' ||
        action.authorization.kind === 'explicit_instruction') &&
      sameScope(action.authorization.scope, action.scope);
    return instructed
      ? { ok: true, footprint, change_class }
      : { ok: false, code: 'REVERSES_ANOTHERS_ACT' };
  }
  if (action.authorization === null) {
    if (standsChanged) return { ok: false, code: 'AUTHORIZATION_REQUIRED' };
    if (
      restatesFindings &&
      !(action.scope.kind === 'artifact' && input.findings_originate_in_scope)
    )
      return { ok: false, code: 'FINDING_OUTSIDE_ITS_ARTIFACT' };
    return { ok: true, footprint, change_class };
  }
  const authority = checkAuthorization({
    authorization: action.authorization,
    scope: action.scope,
    footprint,
    acting: action.attributed_to,
    context: input.context,
  });
  return authority.ok ? { ok: true, footprint, change_class } : authority;
}

/**
 * Background processing may suggest a relationship and nothing more. An
 * established relationship is an authored act that moves the intent counter,
 * so it names an actor. Only an established replacement of a requirement or
 * decision changes what stands, so only it carries an authorization, and it
 * must acknowledge what it replaces. A replacement connects two revisions of
 * the same kind.
 */
export const RelationshipSchema = z
  .strictObject({
    relationship_id: recordId(),
    relation: z.enum(['supersedes', 'challenges', 'depends_on', 'motivates']),
    from: RecordRevisionRefSchema,
    to: RecordRevisionRefSchema,
    scope: AuthorityScopeSchema,
    standing: z.enum(['suggested', 'established']),
    attributed_to: AttributionSchema,
    authorization: AuthorizationSchema.nullable(),
    source_ids: z.array(recordId()).min(1),
    explanation: proseText(),
  })
  .superRefine((relationship, ctx) => {
    for (const side of ['from', 'to'] as const)
      if (relationship[side].kind === 'relationship')
        ctx.addIssue({
          code: 'custom',
          path: [side],
          message:
            'a relationship connects requirements, decisions and findings; a relationship is challenged by a correction',
        });
    if (sameRevision(relationship.from, relationship.to))
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'a relationship connects two different revisions',
      });
    if (relationship.standing === 'established' && relationship.attributed_to.kind === 'detector')
      ctx.addIssue({
        code: 'custom',
        path: ['standing'],
        message: 'a detector suggests a relationship; only an actor establishes one',
      });
    if (relationship.relation === 'supersedes' && relationship.from.kind !== relationship.to.kind)
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'a replacement connects two revisions of the same kind',
      });
    const footprint = relationshipFootprint(relationship);
    // An approved replacement is published as a correction, which adopts; a relationship adopts nothing.
    if (
      relationship.authorization !== null &&
      relationship.authorization.kind !== 'informed_instruction'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['authorization'],
        message: 'a replacement relationship is established on an informed instruction',
      });
    if (footprintIsEmpty(footprint) !== (relationship.authorization === null))
      ctx.addIssue({
        code: 'custom',
        path: ['authorization'],
        message:
          'an established replacement of a requirement or decision, and only that, rests on an authorization',
      });
    if (relationship.authorization !== null)
      for (const message of instructionIssues(
        relationship.authorization,
        relationship.scope,
        footprint
      ))
        ctx.addIssue({ code: 'custom', path: ['authorization'], message });
  });
export type Relationship = z.infer<typeof RelationshipSchema>;

export function relationshipFootprint(
  relationship: Pick<Relationship, 'relation' | 'standing' | 'from' | 'to'>
): ActFootprint {
  const replaces =
    relationship.standing === 'established' &&
    relationship.relation === 'supersedes' &&
    isExpectation(relationship.to);
  return replaces
    ? {
        ...NOTHING,
        departs_from: replacedBy([relationship.to as ExpectationRevisionRef], relationship.from),
      }
    : NOTHING;
}

type RelationshipEdge = Pick<Relationship, 'relation' | 'from' | 'to'>;

/**
 * Only replacement edges can form a replacement cycle; other relations are
 * ignored. The visited set bounds the walk, so inconsistent imported history
 * that already contains a cycle terminates instead of looping.
 */
export function introducesReplacementCycle(
  existing: readonly RelationshipEdge[],
  next: RelationshipEdge
): boolean {
  if (next.relation !== 'supersedes') return false;
  const successors = new Map<string, string[]>();
  for (const edge of existing) {
    if (edge.relation !== 'supersedes') continue;
    const from = revisionKey(edge.from);
    successors.set(from, [...(successors.get(from) ?? []), revisionKey(edge.to)]);
  }
  const target = revisionKey(next.from);
  const pending = [revisionKey(next.to)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(successors.get(current) ?? []));
  }
  return false;
}

/**
 * The retained answer to one conflict question, either way. `context` is the
 * work it was asked about; an authorized answer names the authorization
 * recorded for it.
 */
export const ConflictAnswerSchema = z
  .strictObject({
    answer_id: recordId(),
    rule: ExpectationRevisionRefSchema,
    outcome: z.enum(['authorized', 'declined']),
    context: ApplicabilitySelectorSchema,
    scope: AuthorityScopeSchema,
    answered_by: ActorSchema,
    source_id: recordId(),
    answered_at: instant(),
    authorization_id: recordId().nullable(),
  })
  .refine((answer) => (answer.outcome === 'authorized') === (answer.authorization_id !== null), {
    path: ['authorization_id'],
    message: 'an authorized answer, and only an authorized answer, names its authorization',
  });
export type ConflictAnswer = z.infer<typeof ConflictAnswerSchema>;

/**
 * How an earlier answer bears on this work. `covers_this_work` is the answer's
 * own context evaluated against the work at hand, so permission for one narrow
 * departure never answers a different change to the same rule.
 */
export interface EarlierConflictAnswer {
  answer_id: string;
  rule: ExpectationRevisionRef;
  outcome: 'authorized' | 'declined';
  answered_at: string;
  covers_this_work: Applicability;
  valid: boolean;
}

/**
 * An assignment as a conflict judgment reads it: who it made responsible, what
 * it delegates about rules, and whether it still stands for this work.
 */
export interface ApplicableAssignment {
  assignment_id: string;
  responsible: Actor;
  departs_from: readonly Departure[];
  /** False once a revocation names it or a rule it rests on no longer stands. */
  valid: boolean;
  /** Its validity window judged at this read's time. */
  covers_this_work: Applicability;
}

export interface ConflictDisposition {
  action: 'proceed' | 'reuse_authorization' | 'rest_on_assignment' | 'comply' | 'ask_once';
  unacknowledged: ExpectationRevisionRef[];
  declined: ExpectationRevisionRef[];
  answer_ids: string[];
  /** The standing assignments that already cover a conflicting rule for whoever is acting. */
  assignment_ids: string[];
}

/**
 * An instruction that acknowledges the rule it changes needs no second
 * confirmation. A conflict already answered for this same work is not asked
 * again: the latest answer stands, so an earlier authorization is reused and
 * an earlier refusal means the rule stands and the work complies. An answer
 * whose time cannot be read is no answer, and of two answers at one instant
 * the refusal stands.
 *
 * A rule a standing assignment delegates a departure from is routine
 * preauthorized work for whoever it made responsible, so it is not asked about
 * either; a refusal still wins, because a refusal is what stops the same change
 * being asked again. An assignment and an authorized answer that both cover one
 * rule are both named. Everything else is asked once, together.
 *
 * `assignments` and `acting` are optional so a caller that supplies neither
 * asks, which is the answer that costs somebody a question rather than a
 * permission nobody gave.
 */
export function conflictDisposition(input: {
  conflicting: readonly ExpectationRevisionRef[];
  acknowledged: readonly ExpectationRevisionRef[];
  earlier: readonly EarlierConflictAnswer[];
  assignments?: readonly ApplicableAssignment[];
  acting?: Attribution | null;
}): ConflictDisposition {
  const applicable = input.earlier.filter(
    (answer) => answer.valid && answer.covers_this_work === 'applies'
  );
  const standing = (input.assignments ?? []).filter(
    (assignment) =>
      assignment.valid &&
      assignment.covers_this_work === 'applies' &&
      actsAsResponsible(input.acting ?? null, assignment.responsible)
  );
  const answerIds = new Set<string>();
  const assignmentIds = new Set<string>();
  const declined: ExpectationRevisionRef[] = [];
  const unacknowledged: ExpectationRevisionRef[] = [];
  for (const rule of input.conflicting) {
    if (input.acknowledged.some((ack) => sameRevision(ack, rule))) continue;
    const latest = applicable
      .filter(
        (answer) => sameRevision(answer.rule, rule) && !Number.isNaN(Date.parse(answer.answered_at))
      )
      .sort(
        (left, right) =>
          Date.parse(right.answered_at) - Date.parse(left.answered_at) ||
          Number(right.outcome === 'declined') - Number(left.outcome === 'declined')
      )[0];
    if (latest !== undefined && latest.outcome === 'declined') {
      declined.push(rule);
      continue;
    }
    // Matched on the rule, as an acknowledgment is: which departure an act may
    // make is the writer's judgment, on the assignment's exact delegated
    // departure, and asking about the rule twice is what this answer prevents.
    const covering = standing.filter((assignment) =>
      assignment.departs_from.some((departure) => sameRevision(departure.rule, rule))
    );
    for (const assignment of covering) assignmentIds.add(assignment.assignment_id);
    if (latest !== undefined) answerIds.add(latest.answer_id);
    else if (covering.length === 0) unacknowledged.push(rule);
  }
  const answer_ids = [...answerIds].sort();
  const assignment_ids = [...assignmentIds].sort();
  let action: ConflictDisposition['action'] = 'proceed';
  if (unacknowledged.length > 0) action = 'ask_once';
  else if (declined.length > 0) action = 'comply';
  else if (assignment_ids.length > 0) action = 'rest_on_assignment';
  else if (answer_ids.length > 0) action = 'reuse_authorization';
  return { action, unacknowledged, declined, answer_ids, assignment_ids };
}

/**
 * `evaluator_context` is the prepared input an evaluator runner hands a
 * producer, named by its digest. It is here because it is the one thing an
 * evaluator run demonstrably consumed: the tree it saw is `git_commit`, and a
 * commit the run merely saw is not a commit it read.
 */
const InputIdentitySchema = z.strictObject({
  kind: z.enum([
    'git_commit',
    'git_tree',
    'worktree_snapshot',
    'build',
    'release',
    'file',
    'evaluator_context',
  ]),
  identity: label(),
});

const inputKey = (input: z.infer<typeof InputIdentitySchema>) =>
  JSON.stringify([input.kind, input.identity]);

const MethodSchema = z.strictObject({
  name: label(),
  configuration_sha256: sha256().nullable(),
});

/**
 * What a tool or person recorded about identified inputs. An agent-reported
 * command is not a runner-established execution, and only an execution that
 * actually consumed the identified retained inputs supports a snapshot-bound
 * claim: a checkpoint number, HEAD, or matching before and after hashes do not.
 */
export const ObservationSchema = z
  .strictObject({
    observation_id: recordId(),
    observer: ActorSchema,
    source_id: recordId(),
    method: MethodSchema,
    execution: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('agent_reported'), command: proseText() }),
      z.strictObject({
        kind: z.literal('runner_established'),
        runner: label(),
        consumed_inputs: z.array(InputIdentitySchema).min(1),
      }),
      z.strictObject({ kind: z.literal('human_observation') }),
    ]),
    input_basis: z.enum(['snapshot_bound', 'partial', 'unknown']),
    known_inputs: z.array(InputIdentitySchema),
    outcome: z.enum(['passed', 'failed', 'errored', 'skipped', 'observed']),
    detail: proseText().nullable(),
    retained_artifacts: z.array(label()),
    started_at: instant().nullable(),
    finished_at: instant().nullable(),
    limits: z.array(proseText()),
  })
  .refine(
    (observation) =>
      observation.input_basis !== 'snapshot_bound' ||
      (observation.execution.kind === 'runner_established' &&
        sameMembers(
          observation.execution.consumed_inputs.map(inputKey),
          observation.known_inputs.map(inputKey)
        )),
    {
      path: ['input_basis'],
      message: 'a snapshot-bound observation consumed exactly the inputs it claims to know',
    }
  );
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * Conclusions are attributed judgments about exact expectation revisions
 * against identified software. With no implementation selected an assessment
 * can say unresolved or not assessed, never supported or contradicted, and it
 * never borrows the current checkout. A judgment cites evidence that points
 * its way, and never itself. Errors, skipped checks, missing inputs and stale
 * evidence are states of the checks, not conclusions.
 */
export const AssessmentSchema = z
  .strictObject({
    assessment_id: recordId(),
    expectations: z.array(ExpectationRevisionRefSchema).min(1),
    exception_ids: z.array(recordId()),
    implementation: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('selected'),
        inputs: z.array(InputIdentitySchema).min(1),
        environment: label().nullable(),
      }),
      z.strictObject({ kind: z.literal('none_selected') }),
    ]),
    evidence: z.array(
      z.strictObject({
        source: z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('observation'), observation_id: recordId() }),
          z.strictObject({ kind: z.literal('assessment'), assessment_id: recordId() }),
        ]),
        role: z.enum(['supports', 'contradicts', 'context']),
        limitations: proseText().nullable(),
      })
    ),
    assessor: ActorSchema,
    method: MethodSchema,
    conclusions: z.array(
      z.strictObject({
        expectation: ExpectationRevisionRefSchema,
        conclusion: z.enum(['supported', 'contradicted', 'unresolved', 'not_assessed']),
        reason: proseText(),
      })
    ),
    check_states: z.array(
      z.strictObject({
        check: label(),
        state: z.enum(['errored', 'skipped', 'missing_inputs', 'stale_evidence']),
        detail: proseText().nullable(),
      })
    ),
    coverage_limits: z.array(proseText()),
    observed_write_sequence: z.number().int().nonnegative(),
    observed_intent_counter: z.number().int().nonnegative(),
  })
  .superRefine((assessment, ctx) => {
    const expected = assessment.expectations.map(revisionKey);
    const concluded = assessment.conclusions.map((entry) => revisionKey(entry.expectation));
    if (!unique(expected) || !sameMembers(expected, concluded))
      ctx.addIssue({
        code: 'custom',
        path: ['conclusions'],
        message: 'every selected expectation has exactly one conclusion, and no other does',
      });
    const concludes = (conclusion: string) =>
      assessment.conclusions.some((entry) => entry.conclusion === conclusion);
    if (
      (concludes('supported') || concludes('contradicted')) &&
      assessment.implementation.kind === 'none_selected'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['implementation'],
        message: 'no satisfaction claim is made against unidentified software',
      });
    const cites = (role: string) => assessment.evidence.some((entry) => entry.role === role);
    if (
      (concludes('supported') && !cites('supports')) ||
      (concludes('contradicted') && !cites('contradicts'))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'a supported or contradicted conclusion cites evidence that points its way',
      });
    const citesItself = assessment.evidence.some(
      (entry) =>
        entry.source.kind === 'assessment' &&
        entry.source.assessment_id === assessment.assessment_id
    );
    if (citesItself)
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'an assessment is not evidence for itself',
      });
  });
export type Assessment = z.infer<typeof AssessmentSchema>;

/**
 * What an assignment delegates, in exactly the shapes an authorization record
 * carries. This, and only this, is what an act under the assignment is judged
 * against: `allowed_changes` and `escalation_conditions` are prose for people
 * and are never parsed.
 */
const DelegatedFootprintSchema = z.strictObject({
  adopts: z.array(AdoptionSchema),
  departs_from: z.array(DepartureSchema),
  restates: z.array(RecordRevisionRefSchema),
});

/**
 * Who may decide what on someone's behalf: the objective, the obligations it
 * inherits, the footprint it delegates, what it allows and when to escalate in
 * the assigner's own words, who is responsible, the authority it rests on and
 * how long it lasts.
 *
 * An authorization reused for one act delegates nothing — it was given for that
 * act — so an assignment rests on an instruction, an approval binding or an
 * earlier assignment. Whether the assigner actually held what it delegates can
 * only be seen in the store, so {@link checkAuthorization} decides it inside the
 * transaction that publishes the assignment.
 */
export const AssignmentSchema = z
  .strictObject({
    assignment_id: recordId(),
    objective: proseText(),
    inherited: z.array(ExpectationRevisionRefSchema),
    delegated: DelegatedFootprintSchema,
    allowed_changes: z.array(proseText()),
    escalation_conditions: z.array(proseText()),
    responsible: ActorSchema,
    assigned_by: ActorSchema,
    source_id: recordId(),
    scope: AuthorityScopeSchema,
    authorization: AuthorizationSchema,
    valid_until: instant().nullable(),
  })
  .superRefine((assignment, ctx) => {
    if (assignment.authorization.kind === 'reused_authorization')
      ctx.addIssue({
        code: 'custom',
        path: ['authorization'],
        message:
          'an authorization reused for one act delegates nothing; an assignment rests on an instruction, an approval binding or an earlier assignment',
      });
    if (assignment.responsible.identity === null)
      ctx.addIssue({
        code: 'custom',
        path: ['responsible'],
        message: 'an assignment names who is responsible; nobody in particular is no one',
      });
    for (const message of instructionIssues(
      assignment.authorization,
      assignment.scope,
      assignment.delegated
    ))
      ctx.addIssue({ code: 'custom', path: ['authorization'], message });
  });
export type Assignment = z.infer<typeof AssignmentSchema>;

/**
 * An assignment's validity window as an applicability selector, so the act's
 * time is judged by the same three-valued rule everything else is: `before` is
 * exclusive, and a time nobody supplied leaves it unresolved rather than
 * assumed met. An assignment with no end covers every time.
 */
export function assignmentWindow(valid_until: string | null): ApplicabilitySelector {
  return {
    all_of:
      valid_until === null ? [] : [{ dimension: 'time', operator: 'before', instant: valid_until }],
  };
}

export const PROCESSING_ELIGIBLE_EVENT_TYPES = [
  'plan_captured',
  'plan_revised',
  'checkpoint_closed',
  'checkpoint_abandoned',
  'summary_captured',
] as const satisfies readonly EventType[];

export const ProcessingJobIdentitySchema = z.strictObject({
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('capture_event'), event_id: recordId() }),
    z.strictObject({ kind: z.literal('knowledge_source'), source_id: recordId() }),
  ]),
  processor_contract: label(),
});
export type ProcessingJobIdentity = z.infer<typeof ProcessingJobIdentitySchema>;

/**
 * `live_review_feedback` is a human reviewer's new comment, however it reached
 * this machine, including a pull. `synced_knowledge_record` is a knowledge
 * record another client already published, which is never a new source here.
 */
export type SourcePublicationPath =
  | 'live_capture_settlement'
  | 'live_knowledge_input'
  | 'live_review_feedback'
  | 'live_observation'
  | 'seed_import'
  | 'imported_retention'
  | 'legacy_conversion'
  | 'restore'
  | 'replay'
  | 'synced_knowledge_record'
  | 'direct_artifact_append';

const LIVE_SOURCE_PATHS: readonly SourcePublicationPath[] = [
  'live_knowledge_input',
  'live_review_feedback',
  'live_observation',
];

/**
 * Admission is positive: only a path that publishes a new live source admits a
 * job, and never for a source that belongs to an imported artifact. Origin
 * alone cannot decide it, because legacy conversion keeps `captured` origin
 * and seed writes share the live operation kind, while an imported artifact
 * can still take an amend, a comment or an observation through a live path.
 * Anything background processing derived, here or on another machine, is never
 * a new source. Dispatch repeats this check before any provider is constructed.
 */
export function admitsProcessingJob(input: {
  path: SourcePublicationPath;
  origin_kind: 'captured' | 'git-import' | null;
  settled_event_types: readonly EventType[];
  derived_by_processing: boolean;
}): boolean {
  if (input.derived_by_processing || input.origin_kind === 'git-import') return false;
  if (LIVE_SOURCE_PATHS.includes(input.path)) return true;
  return (
    input.path === 'live_capture_settlement' &&
    input.origin_kind === 'captured' &&
    input.settled_event_types.some((type) =>
      (PROCESSING_ELIGIBLE_EVENT_TYPES as readonly EventType[]).includes(type)
    )
  );
}
