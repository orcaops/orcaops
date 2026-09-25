import { z } from 'zod';

import { containsForbiddenControlChars } from '@orcaops/storage';

import { PROPOSAL_SCHEMA_VERSION } from './versions.js';

export const PROPOSAL_LIMITS = {
  statements: 64,
  citations_per_statement: 8,
  links_per_statement: 8,
  alternatives_per_statement: 8,
  corrections: 32,
  uncertainties: 32,
  text_chars: 4096,
  note_chars: 1024,
} as const;

const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !containsForbiddenControlChars(text), {
      message: 'must not contain control characters',
    });

const revisionRef = () =>
  z.string().regex(/^k[0-9]+r[0-9]+$/u, 'must be a revision ref from the manifest, such as "k1r2"');

const sourceRef = () =>
  z.string().regex(/^s[0-9]+$/u, 'must be a source ref from the manifest, such as "s1"');

export const ProposedCitationSchema = z.strictObject({
  source_ref: sourceRef(),
  segment_ref: z
    .string()
    .regex(/^g[1-9][0-9]*$/u, 'must be a segment ref from the manifest, such as "g1"'),
  quote: plainText(PROPOSAL_LIMITS.text_chars),
});
export type ProposedCitation = z.infer<typeof ProposedCitationSchema>;
export type Citation = ProposedCitation;

export const SourceFormSchema = z.enum([
  'stated_obligation',
  'stated_decision',
  'task_local_criterion',
  'test_or_check',
  'observation',
  'question',
]);
export type SourceForm = z.infer<typeof SourceFormSchema>;

export const ProposedRecordSchema = z.enum(['requirement', 'decision', 'claim', 'none']);
export type ProposedRecordKind = z.infer<typeof ProposedRecordSchema>;

export const RECORD_ALLOWED_FOR_SOURCE_FORM: Readonly<
  Record<SourceForm, readonly ProposedRecordKind[]>
> = {
  stated_obligation: ['requirement', 'none'],
  stated_decision: ['decision', 'none'],
  task_local_criterion: ['none'],
  test_or_check: ['claim', 'none'],
  observation: ['claim', 'none'],
  question: ['none'],
};

// Literal kinds keep branches disjoint while ordinary unions emit provider-supported anyOf.
export const IntendedScopeSchema = z.union([
  z.strictObject({ kind: z.literal('project') }),
  z.strictObject({ kind: z.literal('current_task') }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export type ProposedIntendedScope = z.infer<typeof IntendedScopeSchema>;

export const LinkRelationSchema = z.enum([
  'exact_restatement',
  'equivalent_to',
  'refines',
  'departs_from',
  'supports',
  'contradicts',
  'unrelated',
  'cannot_tell',
]);
export type LinkRelation = z.infer<typeof LinkRelationSchema>;

export const ProposedLinkSchema = z.strictObject({
  revision_ref: revisionRef(),
  relation: LinkRelationSchema,
});
export type ProposedLink = z.infer<typeof ProposedLinkSchema>;

export const ProposedRationaleSchema = z.union([
  z.strictObject({
    kind: z.literal('stated'),
    wording: plainText(PROPOSAL_LIMITS.text_chars),
    citations: z.array(ProposedCitationSchema).min(1).max(PROPOSAL_LIMITS.citations_per_statement),
  }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export type ProposedRationale = z.infer<typeof ProposedRationaleSchema>;

export const ProposedAlternativeSchema = z.strictObject({
  option: plainText(PROPOSAL_LIMITS.text_chars),
  option_citations: z
    .array(ProposedCitationSchema)
    .min(1)
    .max(PROPOSAL_LIMITS.citations_per_statement),
  rejected_because: plainText(PROPOSAL_LIMITS.text_chars),
  rejection_citations: z
    .array(ProposedCitationSchema)
    .min(1)
    .max(PROPOSAL_LIMITS.citations_per_statement),
});
export type ProposedAlternative = z.infer<typeof ProposedAlternativeSchema>;

export const ProposedStatementSchema = z.strictObject({
  source_ref: sourceRef(),
  wording: plainText(PROPOSAL_LIMITS.text_chars),
  source_form: SourceFormSchema,
  proposed_record: ProposedRecordSchema,
  intended_scope: IntendedScopeSchema,
  evidence: z.array(ProposedCitationSchema).min(1).max(PROPOSAL_LIMITS.citations_per_statement),
  rationale: ProposedRationaleSchema,
  alternatives: z.array(ProposedAlternativeSchema).max(PROPOSAL_LIMITS.alternatives_per_statement),
  links: z.array(ProposedLinkSchema).max(PROPOSAL_LIMITS.links_per_statement),
});
export type ProposedStatement = z.infer<typeof ProposedStatementSchema>;

// Keep the item parser permissive enough to diagnose invalid pairs without losing valid siblings.
const ConstrainedStatementSchema = z.union(
  SourceFormSchema.options.map((sourceForm) =>
    ProposedStatementSchema.extend({
      source_form: z.literal(sourceForm),
      proposed_record: z.enum(RECORD_ALLOWED_FOR_SOURCE_FORM[sourceForm]),
    })
  )
);

export const ProposedCorrectionSchema = z.strictObject({
  kind: z.enum(['challenge', 'factual_correction']),
  revision_ref: revisionRef(),
  account: ProposedCitationSchema,
});
export type ProposedCorrection = z.infer<typeof ProposedCorrectionSchema>;

export const ProposedUncertaintySchema = z.strictObject({
  about: z.enum(['meaning', 'scope', 'equivalence']),
  statement_index: z.number().int().nonnegative().nullable(),
  note: plainText(PROPOSAL_LIMITS.note_chars),
});
export type ProposedUncertainty = z.infer<typeof ProposedUncertaintySchema>;

export const InterpretationProposalSchema = z.strictObject({
  proposal_schema_version: z.literal(PROPOSAL_SCHEMA_VERSION),
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  statements: z.array(ConstrainedStatementSchema).max(PROPOSAL_LIMITS.statements),
  corrections: z.array(ProposedCorrectionSchema).max(PROPOSAL_LIMITS.corrections),
  uncertainties: z.array(ProposedUncertaintySchema).max(PROPOSAL_LIMITS.uncertainties),
});
export type InterpretationProposal = z.infer<typeof InterpretationProposalSchema>;

/**
 * Parsing the envelope separately lets validation reject a malformed array item
 * without discarding its independent siblings. Array limits remain envelope
 * rules because truncating an oversized response would misreport its quality.
 */
export const InterpretationProposalEnvelopeSchema = z.strictObject({
  proposal_schema_version: z.literal(PROPOSAL_SCHEMA_VERSION),
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  statements: z.array(z.unknown()).max(PROPOSAL_LIMITS.statements),
  corrections: z.array(z.unknown()).max(PROPOSAL_LIMITS.corrections),
  uncertainties: z.array(z.unknown()).max(PROPOSAL_LIMITS.uncertainties),
});

let cachedJsonSchema: Record<string, unknown> | null = null;

export function interpretationProposalJsonSchema(manifestSha256?: string): Record<string, unknown> {
  // The claude CLI rejects a draft-2020-12 `$schema` outright (2.1.281).
  cachedJsonSchema ??= z.toJSONSchema(InterpretationProposalSchema, {
    target: 'draft-7',
    io: 'input',
    reused: 'ref',
  }) as Record<string, unknown>;
  const schema = structuredClone(cachedJsonSchema);
  if (manifestSha256 !== undefined) {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    properties.manifest_sha256 = { ...properties.manifest_sha256, const: manifestSha256 };
  }
  return schema;
}
