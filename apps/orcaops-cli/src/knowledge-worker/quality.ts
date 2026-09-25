import type {
  InterpretationManifest,
  ProposalFailure,
  ProposalValidation,
  ReconciliationPlan,
} from '@orcaops/core';
import {
  type InterpretationQuality,
  InterpretationQualitySchema,
  scrubTerminalDiagnosticAndBound,
} from '@orcaops/storage';

const ATTEMPT_DIAGNOSTIC_LIMIT = 128;
const AGGREGATE_DIAGNOSTIC_LIMIT = 256;
const COUNT_KEYS = ['statements', 'corrections', 'links', 'uncertainties', 'alternatives'] as const;
const DIAGNOSTIC_HOLD_REASONS = new Set([
  'statement_published_no_candidate',
  'intended_scope_not_nameable',
  'candidate_identity_collision',
  'refused_by_the_contract',
]);

type QualityCollection = (typeof COUNT_KEYS)[number];
type QualityCounts = InterpretationQuality['proposed'];

const emptyCounts = (): QualityCounts => ({
  statements: 0,
  corrections: 0,
  links: 0,
  uncertainties: 0,
  alternatives: 0,
});

function outcomeOf(
  quality: Pick<InterpretationQuality, 'proposed' | 'accepted' | 'held_back' | 'rejected'>
) {
  const proposed = COUNT_KEYS.reduce((total, key) => total + (quality.proposed[key] ?? 0), 0);
  const accepted = COUNT_KEYS.reduce((total, key) => total + (quality.accepted[key] ?? 0), 0);
  const heldBack = COUNT_KEYS.reduce((total, key) => total + (quality.held_back[key] ?? 0), 0);
  const rejected = COUNT_KEYS.reduce((total, key) => total + (quality.rejected[key] ?? 0), 0);
  if (proposed === 0) return 'empty' as const;
  if (rejected === proposed) return 'all_rejected' as const;
  if (rejected > 0 && accepted + heldBack > 0) return 'partial' as const;
  return 'accepted' as const;
}

function itemPosition(item: ProposalFailure['item']): {
  collection: QualityCollection;
  itemIndex: number;
  parentIndex: number | null;
} | null {
  switch (item.kind) {
    case 'statement':
      return { collection: 'statements', itemIndex: item.index, parentIndex: null };
    case 'citation':
      return { collection: 'statements', itemIndex: item.statement_index, parentIndex: null };
    case 'link':
      return { collection: 'links', itemIndex: item.link_index, parentIndex: item.statement_index };
    case 'alternative':
      return {
        collection: 'alternatives',
        itemIndex: item.alternative_index,
        parentIndex: item.statement_index,
      };
    case 'correction':
      return { collection: 'corrections', itemIndex: item.index, parentIndex: null };
    case 'uncertainty':
      return { collection: 'uncertainties', itemIndex: item.index, parentIndex: null };
    case 'proposal':
      return null;
  }
}

function rawItem(answer: unknown, item: ProposalFailure['item']): unknown {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const proposal = answer as Record<string, unknown>;
  if (
    item.kind === 'statement' ||
    item.kind === 'citation' ||
    item.kind === 'link' ||
    item.kind === 'alternative'
  )
    return Array.isArray(proposal.statements)
      ? proposal.statements[item.kind === 'statement' ? item.index : item.statement_index]
      : null;
  if (item.kind === 'correction')
    return Array.isArray(proposal.corrections) ? proposal.corrections[item.index] : null;
  if (item.kind === 'uncertainty')
    return Array.isArray(proposal.uncertainties) ? proposal.uncertainties[item.index] : null;
  return null;
}

function sourceRefOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceRef = (value as Record<string, unknown>).source_ref;
  if (typeof sourceRef === 'string') return sourceRef;
  const account = (value as Record<string, unknown>).account;
  return sourceRefOf(account);
}

function diagnosticSource(
  manifest: InterpretationManifest,
  answer: unknown,
  item: ProposalFailure['item']
) {
  const sourceRef = sourceRefOf(rawItem(answer, item));
  const source = manifest.sources.find((candidate) => candidate.ref === sourceRef);
  const segment =
    manifest.segments.find((candidate) => candidate.source_ref === source?.ref) ??
    manifest.segments.find((candidate) => candidate.purpose === 'primary') ??
    manifest.segments[0];
  if (segment === undefined) throw new TypeError('A called interpretation unit has no segment.');
  return { sourceId: segment.source_id, fieldPath: segment.occurrence.field_path };
}

function acceptedByValidation(
  validation: Extract<ProposalValidation, { outcome: 'accepted' }>,
  item: ProposalFailure['item']
): boolean {
  if (item.kind === 'statement') {
    const statement = validation.validated.statements.find(
      (candidate) => candidate.index === item.index
    );
    return statement !== undefined && statement.statement.proposed_record !== 'none';
  }
  if (item.kind === 'link') {
    const link = validation.validated.statements
      .find((statement) => statement.index === item.statement_index)
      ?.links.find((candidate) => candidate.index === item.link_index);
    return link !== undefined && link.relation !== 'unrelated' && link.relation !== 'cannot_tell';
  }
  if (item.kind === 'alternative') {
    return (
      validation.validated.statements
        .find((statement) => statement.index === item.statement_index)
        ?.alternatives.some((candidate) => candidate.index === item.alternative_index) === true
    );
  }
  if (item.kind === 'correction') {
    return validation.validated.corrections.some((candidate) => candidate.index === item.index);
  }
  return false;
}

export function qualityFromValidation(input: {
  manifest: InterpretationManifest;
  answer: unknown;
  validation: Extract<ProposalValidation, { outcome: 'accepted' }>;
  reconciliation: ReconciliationPlan;
}): InterpretationQuality {
  const counts = input.reconciliation.quality;
  const validationDiagnostics = input.validation.failures.flatMap((failure) => {
    const position = itemPosition(failure.item);
    if (position === null) return [];
    const source = diagnosticSource(input.manifest, input.answer, failure.item);
    return [
      {
        unit_id: input.manifest.unit_id,
        source_id: source.sourceId,
        field_path: source.fieldPath,
        collection: position.collection,
        item_index: position.itemIndex,
        parent_index: position.parentIndex,
        rule: failure.rule,
        detail: scrubTerminalDiagnosticAndBound(failure.detail, 1_024),
      },
    ];
  });
  const reconciliationDiagnostics = new Map<string, InterpretationQuality['diagnostics'][number]>();
  for (const held of input.reconciliation.held_back) {
    if (!DIAGNOSTIC_HOLD_REASONS.has(held.reason)) continue;
    if (!acceptedByValidation(input.validation, held.item)) continue;
    const position = itemPosition(held.item);
    if (position === null) continue;
    const source = diagnosticSource(input.manifest, input.answer, held.item);
    const key = `${position.collection}:${position.parentIndex ?? ''}:${position.itemIndex}`;
    if (reconciliationDiagnostics.has(key)) continue;
    reconciliationDiagnostics.set(key, {
      unit_id: input.manifest.unit_id,
      source_id: source.sourceId,
      field_path: source.fieldPath,
      collection: position.collection,
      item_index: position.itemIndex,
      parent_index: position.parentIndex,
      rule: `RECONCILIATION_${held.reason.toUpperCase()}`,
      detail: scrubTerminalDiagnosticAndBound(held.detail, 1_024),
    });
  }
  const allDiagnostics = [...validationDiagnostics, ...reconciliationDiagnostics.values()];
  const diagnostics = allDiagnostics.slice(0, ATTEMPT_DIAGNOSTIC_LIMIT);
  const quality = {
    schema: 'orcaops.interpretation_quality/v1' as const,
    outcome: outcomeOf(counts),
    ...counts,
    diagnostics,
    diagnostics_total: allDiagnostics.length,
    diagnostics_omitted: allDiagnostics.length - diagnostics.length,
  };
  return InterpretationQualitySchema.parse(quality);
}

export function aggregateQuality(qualities: readonly InterpretationQuality[]): {
  quality: InterpretationQuality;
  unit_outcomes: Record<InterpretationQuality['outcome'], number>;
} {
  const proposed = emptyCounts();
  const accepted = emptyCounts();
  const held_back = emptyCounts();
  const rejected = emptyCounts();
  const unit_outcomes = { accepted: 0, partial: 0, all_rejected: 0, empty: 0 };
  const allDiagnostics: InterpretationQuality['diagnostics'][number][] = [];
  let diagnosticsTotal = 0;
  for (const quality of qualities) {
    unit_outcomes[quality.outcome] += 1;
    diagnosticsTotal += quality.diagnostics_total;
    for (const key of COUNT_KEYS) {
      proposed[key] = (proposed[key] ?? 0) + (quality.proposed[key] ?? 0);
      accepted[key] = (accepted[key] ?? 0) + (quality.accepted[key] ?? 0);
      held_back[key] = (held_back[key] ?? 0) + (quality.held_back[key] ?? 0);
      rejected[key] = (rejected[key] ?? 0) + (quality.rejected[key] ?? 0);
    }
    allDiagnostics.push(...quality.diagnostics);
  }
  const diagnostics = allDiagnostics.slice(0, AGGREGATE_DIAGNOSTIC_LIMIT);
  const counts = { proposed, accepted, held_back, rejected };
  return {
    quality: InterpretationQualitySchema.parse({
      schema: 'orcaops.interpretation_quality/v1',
      outcome: outcomeOf(counts),
      ...counts,
      diagnostics,
      diagnostics_total: diagnosticsTotal,
      diagnostics_omitted: diagnosticsTotal - diagnostics.length,
    }),
    unit_outcomes,
  };
}
