import type { Explanation } from './provenance-explanations.js';

export function verificationSummary(items: Explanation[], planned: Explanation[] = []) {
  const statuses = new Map<
    string,
    { authority: string; evidence: string; state: unknown; reported_records: number }
  >();
  for (const item of items) {
    const status = {
      authority: item.authority,
      evidence: item.context.some((entry) =>
        entry.unresolved?.some((point) => point.reason === 'evidence_not_attached')
      )
        ? 'not_attached'
        : 'not_evaluated_by_this_query',
      state: item.context.map((entry) => ({
        placement: entry.placement,
        accounts: entry.accounts.map((account) => ({
          standing: account.standing,
          applicability: account.applicability,
          scopes: account.scopes,
        })),
      })),
    };
    const key = JSON.stringify(status);
    const group = statuses.get(key) ?? { ...status, reported_records: 0 };
    group.reported_records++;
    statuses.set(key, group);
  }
  const groups = [...statuses.values()].slice(0, 4);
  const references = [
    ...new Set(
      items
        .flatMap((item) => [
          item.reference,
          ...item.context.flatMap((entry) => (entry.reference ? [entry.reference] : [])),
        ])
        .filter(Boolean)
    ),
  ];
  return {
    status: items.length ? ('reported' as const) : ('planned' as const),
    reported_records: items.length,
    groups,
    omitted_status_records:
      items.length - groups.reduce((sum, group) => sum + group.reported_records, 0),
    references: references.slice(0, 3),
    omitted_references: Math.max(0, references.length - 3),
    ...(planned.length
      ? {
          planned: {
            status: 'planned' as const,
            records: planned.length,
            references: planned.slice(0, 2).map((item) => item.reference),
            omitted_references: Math.max(0, planned.length - 2),
          },
        }
      : {}),
  };
}
