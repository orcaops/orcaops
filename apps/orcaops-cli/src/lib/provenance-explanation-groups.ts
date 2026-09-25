import { stringifyTerminalSafeJson } from '@orcaops/evaluator-protocol/terminal';

import type { Explanation } from './provenance-explanations.js';

export const PROVENANCE_EXPLANATION_BYTES = 8192;

export function groupExplanations(items: Explanation[]) {
  const copies = items.map((item) => ({ ...item }));
  const sources = new Map(
    copies.filter((item) => item.form === 'recorded_capture').map((item) => [item.reference, item])
  );
  const grouped = new Set<string>();
  for (const item of copies) {
    if (item.form !== 'unapproved_interpretation' || !item.source_account || item.verification)
      continue;
    const source = sources.get(item.source_account.reference);
    if (!source || JSON.stringify(source.source) !== JSON.stringify(item.source)) continue;
    const context = new Map(source.context.map((entry) => [entry.id, entry]));
    if (
      item.context.some(
        (entry) =>
          context.has(entry.id) && JSON.stringify(context.get(entry.id)) !== JSON.stringify(entry)
      )
    )
      continue;
    for (const entry of item.context) context.set(entry.id, entry);
    const interpretation = {
      id: item.id,
      kind: item.kind,
      authority: item.authority,
      ...(JSON.stringify(item.account) === JSON.stringify(source.account)
        ? { account_from: source.id }
        : { account: item.account }),
      context_ids: item.context.map((entry) => entry.id),
      relevance: item.relevance,
      temporal: item.temporal,
      reference: item.reference,
    };
    const combined = {
      ...source,
      context: [...context.values()],
      interpretations: [...(source.interpretations ?? []), interpretation],
    };
    // An optional interpretation must not turn a readable source into an oversized omission.
    if (Buffer.byteLength(stringifyTerminalSafeJson(combined)) + 13 > PROVENANCE_EXPLANATION_BYTES)
      continue;
    source.context = combined.context;
    source.interpretations = combined.interpretations;
    grouped.add(item.id);
  }
  return copies.filter((item) => !grouped.has(item.id));
}
