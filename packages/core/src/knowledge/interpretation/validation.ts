import { z } from 'zod';

import type {
  ExpectationRevisionRef,
  InterpretationEvidence,
  InterpretationQuality,
  KnowledgeInterpretation,
  RecordRevisionRef,
} from '@orcaops/storage';

import { sha256Hex, sourceBytes } from './bytes.js';
import {
  type InterpretationManifest,
  type InterpretationSegment,
  type ManifestRevisionEntry,
  manifestSegment,
  manifestSource,
} from './manifest.js';
import {
  InterpretationProposalEnvelopeSchema,
  PROPOSAL_LIMITS,
  type ProposedAlternative,
  ProposedAlternativeSchema,
  type ProposedCitation,
  ProposedCitationSchema,
  type ProposedCorrection,
  ProposedCorrectionSchema,
  type ProposedLink,
  ProposedLinkSchema,
  type ProposedRationale,
  ProposedRationaleSchema,
  type ProposedStatement,
  ProposedStatementSchema,
  type ProposedUncertainty,
  ProposedUncertaintySchema,
  RECORD_ALLOWED_FOR_SOURCE_FORM,
} from './proposal.js';
import { PROPOSAL_SCHEMA_VERSION } from './versions.js';

export type ProposalRule =
  | 'SCHEMA_INVALID'
  | 'PROPOSAL_VERSION_MISMATCH'
  | 'MANIFEST_MISMATCH'
  | 'ATTRIBUTION_NOT_A_DETECTOR'
  | 'UNSAFE_AUTHORITY_FIELD'
  | 'ITEM_SCHEMA_INVALID'
  | 'SOURCE_NOT_IN_MANIFEST'
  | 'PRIMARY_ORIGIN_NOT_EVIDENCED'
  | 'SEGMENT_NOT_IN_MANIFEST'
  | 'CITATION_NOT_FOUND'
  | 'CITATION_AMBIGUOUS'
  | 'CITATION_TOUCHES_REDACTION'
  | 'CITATION_MAPPING_INVALID'
  | 'RECORD_KIND_NOT_ALLOWED_FOR_SOURCE_FORM'
  | 'ALTERNATIVE_NOT_FOR_DECISION'
  | 'SOURCE_ROLE_NOT_PROPOSABLE'
  | 'REVISION_NOT_IN_MANIFEST'
  | 'LINK_TARGET_NOT_AN_ENDPOINT'
  | 'DUPLICATE_LINK_TARGET'
  | 'MULTIPLE_IDENTITY_LINKS'
  | 'EXACT_RESTATEMENT_NOT_VERBATIM'
  | 'IDENTITY_KIND_MISMATCH'
  | 'IDENTITY_TARGET_NOT_AN_EXPECTATION'
  | 'CANONICAL_REUSE_REQUIRED'
  | 'UNCERTAINTY_STATEMENT_NOT_IN_PROPOSAL'
  | 'UNCERTAINTY_NOTE_TOO_LONG';

export const WHOLE_PROPOSAL_RULES: readonly ProposalRule[] = [
  'SCHEMA_INVALID',
  'PROPOSAL_VERSION_MISMATCH',
  'MANIFEST_MISMATCH',
  'ATTRIBUTION_NOT_A_DETECTOR',
  'UNSAFE_AUTHORITY_FIELD',
];

export const CITATION_RULES: readonly ProposalRule[] = [
  'SOURCE_NOT_IN_MANIFEST',
  'PRIMARY_ORIGIN_NOT_EVIDENCED',
  'SEGMENT_NOT_IN_MANIFEST',
  'CITATION_NOT_FOUND',
  'CITATION_AMBIGUOUS',
  'CITATION_TOUCHES_REDACTION',
  'CITATION_MAPPING_INVALID',
];

export type ProposalItem =
  | { kind: 'proposal' }
  | { kind: 'statement'; index: number }
  | { kind: 'citation'; statement_index: number; citation_index: number; rationale: boolean }
  | { kind: 'link'; statement_index: number; link_index: number }
  | { kind: 'alternative'; statement_index: number; alternative_index: number }
  | { kind: 'correction'; index: number }
  | { kind: 'uncertainty'; index: number };

export interface ProposalFailure {
  rule: ProposalRule;
  item: ProposalItem;
  detail: string;
}

export interface AcceptedLink {
  relation: ProposedLink['relation'];
  entry: ManifestRevisionEntry;
  index: number;
}

export interface AcceptedAlternative {
  alternative: ProposedAlternative;
  evidence: readonly InterpretationEvidence[];
  index: number;
}

export type StatementIdentity =
  | { kind: 'none' }
  | { kind: 'identity_unresolved' }
  | { kind: 'exact_restatement'; revision: InterpretationTargetRef }
  | { kind: 'proposed_equivalence'; revision: InterpretationTargetRef }
  | { kind: 'refines'; from: ExpectationRevisionRef }
  | { kind: 'new' };

export type InterpretationTargetRef = RecordRevisionRef & {
  kind: 'requirement' | 'decision' | 'claim';
};

export interface AcceptedStatement {
  index: number;
  statement: Omit<ProposedStatement, 'intended_scope'> & {
    intended_scope: KnowledgeInterpretation['intended_scope'];
  };
  evidence: readonly InterpretationEvidence[];
  rationale:
    | { kind: 'stated'; wording: string; evidence: readonly InterpretationEvidence[] }
    | { kind: 'unknown' };
  alternatives: readonly AcceptedAlternative[];
  links: readonly AcceptedLink[];
  identity: StatementIdentity;
  uncertainties: readonly ProposedUncertainty[];
}

export interface AcceptedCorrection {
  index: number;
  correction: ProposedCorrection;
  evidence: InterpretationEvidence;
  entry: ManifestRevisionEntry;
}

export interface ProposalCounts {
  statements: number;
  corrections: number;
  links: number;
  uncertainties: number;
  alternatives: number;
}

export interface ProposalQualityCounts {
  proposed: ProposalCounts;
  accepted: ProposalCounts;
  held_back: ProposalCounts;
  rejected: ProposalCounts;
}

export interface ValidatedProposal {
  manifest_sha256: string;
  statements: readonly AcceptedStatement[];
  corrections: readonly AcceptedCorrection[];
  uncertainties: readonly ProposedUncertainty[];
  quality: ProposalQualityCounts;
}

export type ProposalValidation =
  | { outcome: 'rejected'; failures: readonly ProposalFailure[] }
  | { outcome: 'accepted'; validated: ValidatedProposal; failures: readonly ProposalFailure[] };

export const MAX_ATTEMPT_DIAGNOSTICS = 128;

export function interpretationQuality(input: {
  validation: Extract<ProposalValidation, { outcome: 'accepted' }>;
  unit_id: string;
  locate: (failure: ProposalFailure) => { source_id: string; field_path: string };
}): InterpretationQuality {
  const { validation } = input;
  const diagnostics = validation.failures.slice(0, MAX_ATTEMPT_DIAGNOSTICS).map((failure) => {
    const location = input.locate(failure);
    const indexed = failure.item;
    const collection: InterpretationQuality['diagnostics'][number]['collection'] =
      indexed.kind === 'correction'
        ? 'corrections'
        : indexed.kind === 'uncertainty'
          ? 'uncertainties'
          : indexed.kind === 'alternative'
            ? 'alternatives'
            : indexed.kind === 'link'
              ? 'links'
              : 'statements';
    const item_index =
      indexed.kind === 'statement' ||
      indexed.kind === 'correction' ||
      indexed.kind === 'uncertainty'
        ? indexed.index
        : indexed.kind === 'citation'
          ? indexed.statement_index
          : indexed.kind === 'alternative'
            ? indexed.alternative_index
            : indexed.kind === 'link'
              ? indexed.link_index
              : 0;
    const parent_index =
      indexed.kind === 'link' || indexed.kind === 'alternative' ? indexed.statement_index : null;
    return {
      unit_id: input.unit_id,
      ...location,
      collection,
      item_index,
      parent_index,
      rule: failure.rule,
      detail: failure.detail.slice(0, 1_024),
    };
  });
  const counts = validation.validated.quality;
  const totalProposed = Object.values(counts.proposed).reduce((total, count) => total + count, 0);
  const totalRejected = Object.values(counts.rejected).reduce((total, count) => total + count, 0);
  const totalKept =
    Object.values(counts.accepted).reduce((total, count) => total + count, 0) +
    Object.values(counts.held_back).reduce((total, count) => total + count, 0);
  const outcome =
    totalProposed === 0
      ? 'empty'
      : totalRejected === totalProposed
        ? 'all_rejected'
        : totalRejected > 0 && totalKept > 0
          ? 'partial'
          : 'accepted';
  return {
    schema: 'orcaops.interpretation_quality/v1',
    outcome,
    ...counts,
    diagnostics,
    diagnostics_total: validation.failures.length,
    diagnostics_omitted: validation.failures.length - diagnostics.length,
  };
}

const StatementEnvelopeSchema = z.strictObject({
  ...ProposedStatementSchema.shape,
  evidence: z.array(z.unknown()).min(1).max(PROPOSAL_LIMITS.citations_per_statement),
  rationale: z.unknown(),
  alternatives: z.array(z.unknown()).max(PROPOSAL_LIMITS.alternatives_per_statement),
  links: z.array(z.unknown()).max(PROPOSAL_LIMITS.links_per_statement),
});

const CorrectionEnvelopeSchema = z.strictObject({
  ...ProposedCorrectionSchema.shape,
  account: z.unknown(),
});

const emptyCounts = (): ProposalCounts => ({
  statements: 0,
  corrections: 0,
  links: 0,
  uncertainties: 0,
  alternatives: 0,
});

export function validateProposal(input: {
  manifest: InterpretationManifest;
  answer: unknown;
}): ProposalValidation {
  const { manifest, answer } = input;
  const reject = (rule: ProposalRule, detail: string): ProposalValidation => ({
    outcome: 'rejected',
    failures: [{ rule, item: { kind: 'proposal' }, detail }],
  });

  if (manifest.attributed_to.kind !== 'detector') {
    return reject(
      'ATTRIBUTION_NOT_A_DETECTOR',
      'Background interpretation must be attributed to a detector.'
    );
  }
  const declared =
    typeof answer === 'object' && answer !== null && 'proposal_schema_version' in answer
      ? (answer as { proposal_schema_version: unknown }).proposal_schema_version
      : undefined;
  if (declared !== PROPOSAL_SCHEMA_VERSION) {
    return reject(
      'PROPOSAL_VERSION_MISMATCH',
      `The answer declares ${JSON.stringify(declared)} where ${JSON.stringify(PROPOSAL_SCHEMA_VERSION)} was asked for.`
    );
  }
  const authorityField = unsafeAuthorityField(answer);
  if (authorityField !== null) {
    return reject(
      'UNSAFE_AUTHORITY_FIELD',
      `The response contains forbidden authority-bearing field ${authorityField}.`
    );
  }
  const parsed = InterpretationProposalEnvelopeSchema.safeParse(answer);
  if (!parsed.success) return reject('SCHEMA_INVALID', describeIssues(parsed.error));
  const proposal = parsed.data;
  if (proposal.manifest_sha256 !== manifest.manifest_sha256) {
    return reject(
      'MANIFEST_MISMATCH',
      `The answer names manifest ${proposal.manifest_sha256}, not ${manifest.manifest_sha256}.`
    );
  }

  const failures: ProposalFailure[] = [];
  const acceptedUncertainties: ProposedUncertainty[] = [];
  proposal.uncertainties.forEach((raw, index) => {
    const item: ProposalItem = { kind: 'uncertainty', index };
    const uncertainty = ProposedUncertaintySchema.safeParse(raw);
    if (!uncertainty.success) {
      const noteTooLong = uncertainty.error.issues.every(
        (issue) => issue.code === 'too_big' && issue.path.length === 1 && issue.path[0] === 'note'
      );
      failures.push({
        rule: noteTooLong ? 'UNCERTAINTY_NOTE_TOO_LONG' : 'ITEM_SCHEMA_INVALID',
        item,
        detail: noteTooLong
          ? `The uncertainty note exceeds ${PROPOSAL_LIMITS.note_chars} characters.`
          : describeIssues(uncertainty.error),
      });
      return;
    }
    if (
      uncertainty.data.statement_index !== null &&
      uncertainty.data.statement_index >= proposal.statements.length
    ) {
      failures.push({
        rule: 'UNCERTAINTY_STATEMENT_NOT_IN_PROPOSAL',
        item,
        detail: `No proposed statement has index ${uncertainty.data.statement_index}.`,
      });
      return;
    }
    acceptedUncertainties.push(uncertainty.data);
  });

  const statements: AcceptedStatement[] = [];
  const statementAccepted = new Set<number>();
  const linkAccepted = new Set<string>();
  const linkHeld = new Set<string>();

  proposal.statements.forEach((raw, index) => {
    const item: ProposalItem = { kind: 'statement', index };
    const statementEnvelope = StatementEnvelopeSchema.safeParse(raw);
    if (!statementEnvelope.success) {
      failures.push({
        rule: 'ITEM_SCHEMA_INVALID',
        item,
        detail: describeIssues(statementEnvelope.error),
      });
      return;
    }
    const rawStatement = statementEnvelope.data;
    const parsedRationale = ProposedRationaleSchema.safeParse(rawStatement.rationale);
    if (!parsedRationale.success) {
      failures.push({
        rule: 'ITEM_SCHEMA_INVALID',
        item,
        detail: describeIssues(parsedRationale.error),
      });
      return;
    }
    const citationResults = rawStatement.evidence.map((rawCitation, citationIndex) =>
      resolveRawCitation(manifest, rawCitation, {
        kind: 'citation',
        statement_index: index,
        citation_index: citationIndex,
        rationale: false,
      })
    );
    for (const result of citationResults) if ('failure' in result) failures.push(result.failure);
    if (citationResults.some((result) => 'failure' in result)) return;
    const evidence = citationResults.map((result) => {
      if ('failure' in result) throw new Error('citation failure was not returned');
      return result.evidence;
    });

    const rationale = resolveRationale(manifest, parsedRationale.data, index, failures);
    if (rationale === null) return;

    const source = manifestSource(manifest, rawStatement.source_ref);
    if (
      source === null ||
      !manifest.segments.some(
        (segment) => segment.source_ref === rawStatement.source_ref && segment.purpose === 'primary'
      )
    ) {
      failures.push({
        rule: 'SOURCE_NOT_IN_MANIFEST',
        item,
        detail: 'A statement origin must name a primary source supplied in this unit.',
      });
      return;
    }
    const statement: AcceptedStatement['statement'] = {
      source_ref: rawStatement.source_ref,
      wording: rawStatement.wording,
      source_form: rawStatement.source_form,
      proposed_record: rawStatement.proposed_record,
      intended_scope:
        rawStatement.intended_scope.kind === 'current_task'
          ? { kind: 'artifact', artifact_id: source.occurrence.artifact_id }
          : rawStatement.intended_scope,
      evidence: rawStatement.evidence as ProposedCitation[],
      rationale: parsedRationale.data,
      alternatives: [],
      links: [],
    };
    if (
      !RECORD_ALLOWED_FOR_SOURCE_FORM[statement.source_form].includes(statement.proposed_record)
    ) {
      failures.push({
        rule: 'RECORD_KIND_NOT_ALLOWED_FOR_SOURCE_FORM',
        item,
        detail: `${statement.source_form} cannot propose a ${statement.proposed_record} record.`,
      });
      return;
    }
    const originRoles = manifest.segments
      .filter(
        (segment) => segment.source_ref === statement.source_ref && segment.purpose === 'primary'
      )
      .map((segment) => segment.role);
    if (
      statement.proposed_record !== 'none' &&
      originRoles.some((role) =>
        ['rejected_alternative', 'rejection_reason', 'non_goal', 'non_goal_reason'].includes(role)
      )
    ) {
      failures.push({
        rule: 'SOURCE_ROLE_NOT_PROPOSABLE',
        item,
        detail:
          'A rejected alternative, rejection reason, or non-goal cannot become a chosen canonical record.',
      });
      return;
    }
    if (
      !statement.evidence.some(
        (citation) =>
          citation.source_ref === statement.source_ref &&
          manifestSegment(manifest, citation.source_ref, citation.segment_ref)?.purpose ===
            'primary'
      )
    ) {
      failures.push({
        rule: 'PRIMARY_ORIGIN_NOT_EVIDENCED',
        item,
        detail:
          'Statement evidence must include its own primary source; neighboring context and rationale alone do not establish that origin.',
      });
      return;
    }
    const alternatives: AcceptedAlternative[] = [];
    rawStatement.alternatives.forEach((rawAlternative, alternativeIndex) => {
      const at: ProposalItem = {
        kind: 'alternative',
        statement_index: index,
        alternative_index: alternativeIndex,
      };
      const parsedAlternative = ProposedAlternativeSchema.safeParse(rawAlternative);
      if (!parsedAlternative.success) {
        failures.push({
          rule: 'ITEM_SCHEMA_INVALID',
          item: at,
          detail: describeIssues(parsedAlternative.error),
        });
        return;
      }
      if (statement.proposed_record !== 'decision') {
        failures.push({
          rule: 'ALTERNATIVE_NOT_FOR_DECISION',
          item: at,
          detail: 'A rejected alternative may only qualify a proposed decision.',
        });
        return;
      }
      const resolved = [
        ...parsedAlternative.data.option_citations,
        ...parsedAlternative.data.rejection_citations,
      ].map((citation) => resolveCitation(manifest, citation));
      for (const result of resolved) {
        if ('failure' in result) failures.push({ ...result.failure, item: at });
      }
      if (resolved.some((result) => 'failure' in result)) return;
      alternatives.push({
        alternative: parsedAlternative.data,
        evidence: resolved.map((result) => {
          if ('failure' in result) throw new Error('alternative citation failure was not returned');
          return result.evidence;
        }),
        index: alternativeIndex,
      });
    });
    const links: AcceptedLink[] = [];
    const seenTargets = new Set<string>();
    let identityLinkRefused = false;
    rawStatement.links.forEach((rawLink, linkIndex) => {
      const at: ProposalItem = { kind: 'link', statement_index: index, link_index: linkIndex };
      const parsedLink = ProposedLinkSchema.safeParse(rawLink);
      if (!parsedLink.success) {
        if (
          typeof rawLink === 'object' &&
          rawLink !== null &&
          'relation' in rawLink &&
          ['exact_restatement', 'equivalent_to', 'refines'].includes(
            String((rawLink as { relation: unknown }).relation)
          )
        ) {
          identityLinkRefused = true;
        }
        failures.push({
          rule: 'ITEM_SCHEMA_INVALID',
          item: at,
          detail: describeIssues(parsedLink.error),
        });
        return;
      }
      const link = parsedLink.data;
      const entry = manifest.revisions.find((candidate) => candidate.ref === link.revision_ref);
      if (entry === undefined) {
        if (['exact_restatement', 'equivalent_to', 'refines'].includes(link.relation)) {
          identityLinkRefused = true;
        }
        failures.push({
          rule: 'REVISION_NOT_IN_MANIFEST',
          item: at,
          detail: `No revision ${link.revision_ref} was supplied.`,
        });
        return;
      }
      if (entry.revision.kind === 'relationship') {
        if (['exact_restatement', 'equivalent_to', 'refines'].includes(link.relation)) {
          identityLinkRefused = true;
        }
        failures.push({
          rule: 'LINK_TARGET_NOT_AN_ENDPOINT',
          item: at,
          detail: `${link.revision_ref} is a relationship rather than a record revision.`,
        });
        return;
      }
      if (seenTargets.has(link.revision_ref)) {
        failures.push({
          rule: 'DUPLICATE_LINK_TARGET',
          item: at,
          detail: `${link.revision_ref} is named more than once.`,
        });
        const existingIndex = links.findIndex(
          (candidate) => candidate.entry.ref === link.revision_ref
        );
        const existing = links[existingIndex];
        if (
          existing !== undefined &&
          ([existing.relation, link.relation] as const).some((relation) =>
            ['exact_restatement', 'equivalent_to', 'refines'].includes(relation)
          )
        ) {
          identityLinkRefused = true;
          links.splice(existingIndex, 1);
          failures.push({
            rule: 'MULTIPLE_IDENTITY_LINKS',
            item: {
              kind: 'link',
              statement_index: index,
              link_index: existing.index,
            },
            detail: 'Repeated identity links cannot choose a canonical identity.',
          });
        }
        return;
      }
      seenTargets.add(link.revision_ref);
      links.push({ relation: link.relation, entry, index: linkIndex });
    });

    const resolvedIdentity = resolveIdentity(
      statement,
      links,
      manifest,
      index,
      failures,
      identityLinkRefused
    );
    if (resolvedIdentity === null) return;
    statement.alternatives = alternatives.map(({ alternative }) => alternative);
    statement.links = resolvedIdentity.links.map((link) => ({
      revision_ref: link.entry.ref,
      relation: link.relation,
    }));
    const uncertainties = acceptedUncertainties.filter(
      (uncertainty) => uncertainty.statement_index === index
    );
    statements.push({
      index,
      statement,
      evidence,
      rationale,
      alternatives,
      links: resolvedIdentity.links,
      identity: resolvedIdentity.identity,
      uncertainties,
    });
    statementAccepted.add(index);
    for (const link of resolvedIdentity.links) {
      const key = `${index}:${link.index}`;
      if (link.relation === 'unrelated' || link.relation === 'cannot_tell') linkHeld.add(key);
      else linkAccepted.add(key);
    }
  });

  const corrections: AcceptedCorrection[] = [];
  proposal.corrections.forEach((raw, index) => {
    const item: ProposalItem = { kind: 'correction', index };
    const correctionEnvelope = CorrectionEnvelopeSchema.safeParse(raw);
    if (!correctionEnvelope.success) {
      failures.push({
        rule: 'ITEM_SCHEMA_INVALID',
        item,
        detail: describeIssues(correctionEnvelope.error),
      });
      return;
    }
    const correction = ProposedCorrectionSchema.safeParse(raw);
    if (!correction.success) {
      failures.push({
        rule: 'ITEM_SCHEMA_INVALID',
        item,
        detail: describeIssues(correction.error),
      });
      return;
    }
    const entry = manifest.revisions.find(
      (candidate) => candidate.ref === correction.data.revision_ref
    );
    if (entry === undefined || entry.revision.kind === 'relationship') {
      failures.push({
        rule: entry === undefined ? 'REVISION_NOT_IN_MANIFEST' : 'LINK_TARGET_NOT_AN_ENDPOINT',
        item,
        detail: `Correction target ${correction.data.revision_ref} is not a supplied record revision.`,
      });
      return;
    }
    const evidence = resolveCitation(manifest, correction.data.account);
    if ('failure' in evidence) {
      failures.push({ ...evidence.failure, item });
      return;
    }
    corrections.push({ index, correction: correction.data, evidence: evidence.evidence, entry });
  });

  const proposed = {
    statements: proposal.statements.length,
    corrections: proposal.corrections.length,
    links: proposal.statements.reduce<number>(
      (total, raw) =>
        total +
        (typeof raw === 'object' &&
        raw !== null &&
        Array.isArray((raw as { links?: unknown }).links)
          ? (raw as { links: unknown[] }).links.length
          : 0),
      0
    ),
    uncertainties: proposal.uncertainties.length,
    alternatives: proposal.statements.reduce<number>(
      (total, raw) =>
        total +
        (typeof raw === 'object' &&
        raw !== null &&
        Array.isArray((raw as { alternatives?: unknown }).alternatives)
          ? (raw as { alternatives: unknown[] }).alternatives.length
          : 0),
      0
    ),
  };
  const heldStatementCount = statements.filter(
    (statement) => statement.statement.proposed_record === 'none'
  ).length;
  const accepted = {
    statements: statements.length - heldStatementCount,
    corrections: corrections.length,
    links: linkAccepted.size,
    uncertainties: acceptedUncertainties.length,
    alternatives: statements.reduce((total, statement) => total + statement.alternatives.length, 0),
  };
  const held_back = {
    ...emptyCounts(),
    statements: heldStatementCount,
    links: linkHeld.size,
  };
  const rejected = {
    statements: proposed.statements - accepted.statements - held_back.statements,
    corrections: proposed.corrections - accepted.corrections,
    links: proposed.links - accepted.links - held_back.links,
    uncertainties: proposed.uncertainties - accepted.uncertainties,
    alternatives: proposed.alternatives - accepted.alternatives - held_back.alternatives,
  };

  return {
    outcome: 'accepted',
    validated: {
      manifest_sha256: manifest.manifest_sha256,
      statements,
      corrections,
      uncertainties: acceptedUncertainties,
      quality: { proposed, accepted, held_back, rejected },
    },
    failures,
  };
}

const UNSAFE_AUTHORITY_FIELDS = new Set([
  'actor',
  'adopted',
  'applicability',
  'approval',
  'approved_by',
  'attributed_to',
  'authorization',
  'authorized_by',
  'authority',
  'authority_scope',
  'designation',
  'satisfaction',
  'selection',
  'selected_by',
  'source_standing',
  'standing',
  'withdrawal',
]);

function unsafeAuthorityField(value: unknown): string | null {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    for (const [key, nested] of Object.entries(current)) {
      if (UNSAFE_AUTHORITY_FIELDS.has(key)) return key;
      pending.push(nested);
    }
  }
  return null;
}

function resolveRationale(
  manifest: InterpretationManifest,
  rationale: ProposedRationale,
  statementIndex: number,
  failures: ProposalFailure[]
): AcceptedStatement['rationale'] | null {
  if (rationale.kind === 'unknown') return rationale;
  const resolved = rationale.citations.map((citation, citationIndex) => {
    const result = resolveCitation(manifest, citation);
    if ('failure' in result) {
      failures.push({
        ...result.failure,
        item: {
          kind: 'citation',
          statement_index: statementIndex,
          citation_index: citationIndex,
          rationale: true,
        },
      });
    }
    return result;
  });
  if (resolved.some((result) => 'failure' in result)) return null;
  return {
    kind: 'stated',
    wording: rationale.wording,
    evidence: resolved.map((result) => {
      if ('failure' in result) throw new Error('rationale citation failure was not returned');
      return result.evidence;
    }),
  };
}

function resolveRawCitation(
  manifest: InterpretationManifest,
  raw: unknown,
  item: ProposalItem
): { evidence: InterpretationEvidence } | { failure: ProposalFailure } {
  const parsed = ProposedCitationSchema.safeParse(raw);
  if (!parsed.success) {
    return { failure: { rule: 'ITEM_SCHEMA_INVALID', item, detail: describeIssues(parsed.error) } };
  }
  const resolved = resolveCitation(manifest, parsed.data);
  return 'failure' in resolved ? { failure: { ...resolved.failure, item } } : resolved;
}

function resolveCitation(
  manifest: InterpretationManifest,
  citation: ProposedCitation
): { evidence: InterpretationEvidence } | { failure: Omit<ProposalFailure, 'item'> } {
  const source = manifestSource(manifest, citation.source_ref);
  if (source === null) {
    return {
      failure: {
        rule: 'SOURCE_NOT_IN_MANIFEST',
        detail: `No source ${citation.source_ref} was supplied.`,
      },
    };
  }
  const segment = manifestSegment(manifest, citation.source_ref, citation.segment_ref);
  if (segment === null) {
    return {
      failure: {
        rule: 'SEGMENT_NOT_IN_MANIFEST',
        detail: `No segment ${citation.segment_ref} was supplied for ${citation.source_ref}.`,
      },
    };
  }
  const prepared = sourceBytes(segment.text);
  const quote = sourceBytes(citation.quote);
  const first = prepared.indexOf(quote);
  if (first < 0) {
    return {
      failure: {
        rule: 'CITATION_NOT_FOUND',
        detail: 'The quote does not occur in the named segment.',
      },
    };
  }
  if (prepared.indexOf(quote, first + 1) >= 0) {
    return {
      failure: {
        rule: 'CITATION_AMBIGUOUS',
        detail: 'The quote occurs more than once in the named segment.',
      },
    };
  }
  const start = segment.prepared_range.start + first;
  const end = start + quote.length;
  const mapped = originalRanges(segment, start, end);
  if ('rule' in mapped) return { failure: mapped };
  return {
    evidence: {
      source_id: source.source_id,
      segment_id: segment.segment_id,
      mapping_version: segment.mapping_version,
      mapping_sha256: segment.mapping_sha256,
      prepared_sha256: segment.prepared_sha256,
      prepared_start_utf8: start,
      prepared_end_utf8: end,
      original_ranges: mapped,
      quote: citation.quote,
      passage_sha256: sha256Hex(citation.quote),
    },
  };
}

function originalRanges(
  segment: InterpretationSegment,
  start: number,
  end: number
): InterpretationEvidence['original_ranges'] | Omit<ProposalFailure, 'item'> {
  const ranges: InterpretationEvidence['original_ranges'] = [];
  let copiedBytes = 0;
  for (const run of segment.mapping) {
    const overlapStart = Math.max(start, run.prepared.start);
    const overlapEnd = Math.min(end, run.prepared.end);
    if (overlapStart >= overlapEnd) continue;
    if (run.kind === 'redacted') {
      return {
        rule: 'CITATION_TOUCHES_REDACTION',
        detail: 'The quote intersects substituted redaction text rather than authored bytes.',
      };
    }
    if (run.kind !== 'copied') continue;
    const preparedLength = run.prepared.end - run.prepared.start;
    const originalLength = run.original.end - run.original.start;
    if (preparedLength !== originalLength) {
      return {
        rule: 'CITATION_MAPPING_INVALID',
        detail: 'A copied mapping run does not preserve byte length.',
      };
    }
    const range = {
      start: run.original.start + overlapStart - run.prepared.start,
      end: run.original.start + overlapEnd - run.prepared.start,
    };
    const previous = ranges[ranges.length - 1];
    if (previous !== undefined && previous.end === range.start) previous.end = range.end;
    else ranges.push(range);
    copiedBytes += overlapEnd - overlapStart;
  }
  if (copiedBytes !== end - start || ranges.length === 0) {
    return {
      rule: 'CITATION_MAPPING_INVALID',
      detail: 'The quote is not completely covered by unchanged prepared-to-original mapping runs.',
    };
  }
  return ranges;
}

function resolveIdentity(
  statement: AcceptedStatement['statement'],
  links: readonly AcceptedLink[],
  manifest: InterpretationManifest,
  statementIndex: number,
  failures: ProposalFailure[],
  identityRefused = false
): { identity: StatementIdentity; links: readonly AcceptedLink[] } | null {
  const identityLinks = links.filter((link) =>
    ['exact_restatement', 'equivalent_to', 'refines'].includes(link.relation)
  );
  if (identityLinks.length > 1) {
    for (const link of identityLinks) {
      failures.push({
        rule: 'MULTIPLE_IDENTITY_LINKS',
        item: { kind: 'link', statement_index: statementIndex, link_index: link.index },
        detail: 'Multiple identity links cannot choose a canonical identity.',
      });
    }
    return resolveIdentity(
      statement,
      links.filter((link) => !identityLinks.includes(link)),
      manifest,
      statementIndex,
      failures,
      true
    );
  }
  if (statement.proposed_record === 'none') {
    if (identityLinks.length > 0) {
      const identity = identityLinks[0];
      failures.push({
        rule: 'IDENTITY_KIND_MISMATCH',
        item: { kind: 'link', statement_index: statementIndex, link_index: identity.index },
        detail: 'A statement proposing no canonical record cannot take a canonical identity.',
      });
      return resolveIdentity(
        statement,
        links.filter((link) => link !== identity),
        manifest,
        statementIndex,
        failures,
        true
      );
    }
    return { identity: { kind: 'none' }, links };
  }
  const identity = identityLinks[0];
  if (identity !== undefined) {
    const target = identity.entry.revision;
    if (
      identity.relation === 'refines' &&
      target.kind !== 'requirement' &&
      target.kind !== 'decision'
    ) {
      failures.push({
        rule: 'IDENTITY_TARGET_NOT_AN_EXPECTATION',
        item: { kind: 'link', statement_index: statementIndex, link_index: identity.index },
        detail: 'Only a requirement or decision can be a refinement parent.',
      });
      return resolveIdentity(
        statement,
        links.filter((link) => link !== identity),
        manifest,
        statementIndex,
        failures,
        true
      );
    }
    if (target.kind === 'relationship' || target.kind !== statement.proposed_record) {
      failures.push({
        rule: 'IDENTITY_KIND_MISMATCH',
        item: { kind: 'link', statement_index: statementIndex, link_index: identity.index },
        detail: `A ${statement.proposed_record} cannot take identity from a ${target.kind}.`,
      });
      return resolveIdentity(
        statement,
        links.filter((link) => link !== identity),
        manifest,
        statementIndex,
        failures,
        true
      );
    }
    if (identity.relation === 'exact_restatement') {
      if (
        identity.entry.statement !== statement.wording ||
        !statement.evidence.some((citation) => citation.quote === statement.wording)
      ) {
        failures.push({
          rule: 'EXACT_RESTATEMENT_NOT_VERBATIM',
          item: { kind: 'link', statement_index: statementIndex, link_index: identity.index },
          detail: `${identity.entry.ref}, the interpretation wording, and one exact evidence quote must match word for word.`,
        });
        return resolveIdentity(
          statement,
          links.filter((link) => link !== identity),
          manifest,
          statementIndex,
          failures,
          true
        );
      }
      if (!scopeMatchesTarget(statement, identity.entry, manifest)) {
        failures.push({
          rule: 'EXACT_RESTATEMENT_NOT_VERBATIM',
          item: { kind: 'link', statement_index: statementIndex, link_index: identity.index },
          detail: `${identity.entry.ref} has incompatible retained scope, so matching words do not establish an exact restatement.`,
        });
        return resolveIdentity(
          statement,
          links.filter((link) => link !== identity),
          manifest,
          statementIndex,
          failures,
          true
        );
      }
      return {
        identity: { kind: 'exact_restatement', revision: target as InterpretationTargetRef },
        links,
      };
    }
    if (identity.relation === 'equivalent_to') {
      return {
        identity: { kind: 'proposed_equivalence', revision: target as InterpretationTargetRef },
        links,
      };
    }
    return { identity: { kind: 'refines', from: target as ExpectationRevisionRef }, links };
  }

  const verbatim = manifest.revisions.find(
    (entry) =>
      entry.revision.kind === statement.proposed_record &&
      entry.statement === statement.wording &&
      scopeMatchesTarget(statement, entry, manifest)
  );
  if (verbatim !== undefined) {
    if (identityRefused) return { identity: { kind: 'identity_unresolved' }, links };
    failures.push({
      rule: 'CANONICAL_REUSE_REQUIRED',
      item: { kind: 'statement', index: statementIndex },
      detail: `The wording is exactly ${verbatim.ref}; name it as an exact restatement rather than minting another identity.`,
    });
    return null;
  }
  return { identity: { kind: 'new' }, links };
}

function scopeMatchesTarget(
  statement: AcceptedStatement['statement'],
  entry: ManifestRevisionEntry,
  manifest: InterpretationManifest
): boolean {
  const scope =
    entry.intended_scope ??
    (entry.intended_scope_status === 'legacy_absent' ? entry.adopted_scope : null);
  if (
    scope === null ||
    scope.kind === 'unknown' ||
    statement.intended_scope.kind === 'unknown' ||
    scope.kind !== statement.intended_scope.kind
  )
    return false;
  if (scope.kind === 'project') {
    return 'project_id' in scope ? scope.project_id === manifest.project_id : true;
  }
  return (
    statement.intended_scope.kind === 'artifact' &&
    scope.artifact_id === statement.intended_scope.artifact_id
  );
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
