import {
  rationaleChangePassage,
  type readProjectRationale,
} from '@orcaops/storage/history/database';

import type { Explanation } from './provenance-explanations.js';

type Reading = ReturnType<typeof readProjectRationale>['value'];

export function omittedExplanation(item: Explanation, reading: Pick<Reading, 'records'>) {
  const keys = new Set(item.context.map((entry) => entry.id));
  const records = reading.records.filter((record) => keys.has(record.key));
  const corrections = [
    ...new Map(
      records
        .flatMap((record) =>
          record.corrections.map((correction) => ({ ...correction, context_id: record.key }))
        )
        .map((correction) => [`${correction.context_id}:${correction.action_id}`, correction])
    ).values(),
  ];
  const relationships = [
    ...new Map(
      records
        .flatMap((record) => record.relationships)
        .filter(
          (relationship) =>
            relationship.relation === 'supersedes' || relationship.relation === 'challenges'
        )
        .map((relationship) => [
          JSON.stringify([
            relationship.relationship_id,
            relationship.standing,
            relationship.applied,
            relationship.not_applied,
          ]),
          relationship,
        ])
    ).values(),
  ];
  const references = [
    ...new Set(
      records.map((record) => record.reference).filter((reference) => reference !== item.reference)
    ),
  ];
  const conflicts = item.context.reduce(
    (count, entry) => count + (entry.conflicts?.length ?? 0),
    0
  );
  const unresolved = item.context.reduce(
    (count, entry) => count + (entry.unresolved?.length ?? 0),
    0
  );
  const limitations = item.context.reduce(
    (count, entry) => count + (entry.limitations?.length ?? 0),
    0
  );
  const outsideScope = item.context
    .flatMap((entry) => entry.limitations ?? [])
    .filter((limit) => limit.record === 'relationship' && limit.reason === 'another_scope');
  const omittedCorrections =
    Math.max(0, corrections.length - 4) +
    records.reduce((count, record) => count + record.omitted_corrections, 0);
  return {
    id: item.id,
    kind: item.kind,
    form: item.form,
    status: 'omitted_oversized' as const,
    source: item.source,
    relevance: item.relevance,
    authority: item.authority,
    temporal: item.temporal,
    reason:
      'The complete explanation exceeds the per-item allowance. It was omitted, not judged irrelevant: shortening it could hide qualifications. Inspect the account and attached context before using it.',
    reference: item.reference,
    recover_context: 'knowledge show <reference> --context --json',
    ...(item.source_account ? { source_reference: item.source_account.reference } : {}),
    ...(references.length ? { context_references: references.slice(0, 4) } : {}),
    ...(references.length > 4 ? { omitted_context_references: references.length - 4 } : {}),
    ...(corrections.length
      ? {
          corrections: corrections.slice(0, 4).map((correction) => ({
            action_id: correction.action_id,
            context_id: correction.context_id,
            kind: correction.kind,
            status: correction.status,
            source_id: correction.source_id,
            reference: correction.reference,
            unavailable: correction.unavailable,
            content: 'not_displayed' as const,
          })),
        }
      : {}),
    ...(omittedCorrections ? { omitted_corrections: omittedCorrections } : {}),
    ...(relationships.length
      ? {
          relationships: relationships.slice(0, 4).map((relationship) => ({
            id: relationship.relationship_id,
            relation: relationship.relation,
            standing: relationship.standing,
            applied: relationship.applied,
            not_applied: relationship.not_applied,
            scope: relationship.scope,
            from: relationship.from,
            to: relationship.to,
          })),
        }
      : {}),
    ...(relationships.length > 4 ? { omitted_relationships: relationships.length - 4 } : {}),
    ...(conflicts ? { conflicts } : {}),
    ...(unresolved ? { unresolved } : {}),
    ...(limitations ? { scope_or_coverage_limitations: limitations } : {}),
    ...(outsideScope.length
      ? {
          outside_scope_relationships: outsideScope.slice(0, 4).map((limit) => ({
            id: limit.record_id,
            applied: false as const,
            not_applied: 'another_scope' as const,
          })),
        }
      : {}),
    ...(outsideScope.length > 4
      ? { omitted_outside_scope_relationships: outsideScope.length - 4 }
      : {}),
    ...(item.account && rationaleChangePassage(item.account.wording)
      ? { change_passage: 'recorded_wording_only' as const }
      : {}),
  };
}

export type OmittedExplanation = ReturnType<typeof omittedExplanation>;
export type ExplanationOutput = Explanation | OmittedExplanation;

export function isCompleteExplanation<T extends { id: string }>(
  item: T
): item is Exclude<T, { status: string }> {
  return !('status' in item);
}
