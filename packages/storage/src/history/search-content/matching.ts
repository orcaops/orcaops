export const SEARCH_NORMALIZATION_VERSION = 1;
export const SEARCH_ORDER_VERSION = 1;

export type SearchMatchClass = 'intent_phrase' | 'text_phrase' | 'all_terms';
export type SearchOrigin = 'captured' | 'imported';

export class HistorySearchError extends Error {
  constructor(
    readonly code: 'INVALID_QUERY' | 'INVALID_FILTER',
    message: string
  ) {
    super(message);
    this.name = 'HistorySearchError';
  }
}

export function tokenizeSearchText(text: string): string[] {
  return (
    text
      .normalize('NFKD')
      .toLowerCase()
      .replace(/\p{M}/gu, '')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function normalizeSearchQuery(query: string): string[] {
  const tokens = tokenizeSearchText(query);
  if (tokens.length === 0)
    throw new HistorySearchError('INVALID_QUERY', 'Search requires a letter or number.');
  return tokens;
}

export interface SearchTokenFields {
  intent_fields: readonly (readonly string[])[];
  body_fields: readonly (readonly string[])[];
}

function containsPhrase(fields: readonly (readonly string[])[], query: readonly string[]): boolean {
  return fields.some((tokens) =>
    tokens.some((_, start) => query.every((token, offset) => tokens[start + offset] === token))
  );
}

export function classifySearchMatch(
  fields: SearchTokenFields,
  query: readonly string[]
): SearchMatchClass | null {
  if (query.length === 0) throw new HistorySearchError('INVALID_QUERY', 'Search requires a token.');
  if (containsPhrase(fields.intent_fields, query)) return 'intent_phrase';
  if (containsPhrase(fields.body_fields, query)) return 'text_phrase';
  const terms = new Set([...fields.intent_fields.flat(), ...fields.body_fields.flat()]);
  return query.every((term) => terms.has(term)) ? 'all_terms' : null;
}

export interface SearchOrderKey {
  match_class: SearchMatchClass;
  origin: SearchOrigin;
  evidence_time: string | null;
  project_id: string;
  artifact_id: string;
  source_id: string;
}

const matchRank: Record<SearchMatchClass, number> = {
  intent_phrase: 0,
  text_phrase: 1,
  all_terms: 2,
};
export const compareSearchIdentity = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareSearchOrder(a: SearchOrderKey, b: SearchOrderKey): number {
  return (
    matchRank[a.match_class] - matchRank[b.match_class] ||
    Number(a.origin === 'imported') - Number(b.origin === 'imported') ||
    Number(a.evidence_time === null) - Number(b.evidence_time === null) ||
    compareSearchIdentity(b.evidence_time ?? '', a.evidence_time ?? '') ||
    compareSearchIdentity(a.project_id, b.project_id) ||
    compareSearchIdentity(a.artifact_id, b.artifact_id) ||
    compareSearchIdentity(a.source_id, b.source_id)
  );
}
