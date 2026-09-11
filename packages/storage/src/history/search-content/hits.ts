import { z } from 'zod';

import { SEARCH_SOURCE_KINDS } from './fields.js';
import { classifySearchMatch, type SearchMatchClass, tokenizeSearchText } from './matching.js';
import type { SearchProjectionMatch, SearchProjectionSource } from './rows.js';
import type { SearchSource } from './sources.js';
import { canonicalJson } from '../../events/canonical-json.js';

const metadataSchema = z.strictObject({
  project_id: z.string().min(1),
  artifact_id: z.string().min(1),
  source_id: z.string().min(1),
  source_event_id: z.string().nullable(),
  content_event_id: z.string().nullable(),
  source_kind: z.enum(SEARCH_SOURCE_KINDS),
  source_locator: z.string(),
  source_ownership: z.enum(['authored_event', 'derived_retained_content']),
  origin: z.enum(['captured', 'imported']),
  evidence_time: z.string().datetime().nullable(),
  evidence_time_basis: z.enum(['captured_event', 'commit', 'commit_set_latest', 'unknown']),
  evidence_time_unknown_reason: z.string().optional(),
  recorded_at: z.string().datetime().nullable(),
  imported_at: z.string().datetime().nullable(),
  enriched_at: z.string().datetime().nullable(),
  artifact_commit_generation: z.number().int().nonnegative(),
  decision_provenance: z.array(
    z.strictObject({
      field_path: z.string(),
      revision_n: z.number().int().nonnegative().nullable(),
      source_event_id: z.string().nullable(),
      evidence_commit_oid: z.string().nullable(),
    })
  ),
});
const fieldSchema = z.strictObject({ path: z.string(), text: z.string() });
const payloadSchema = z.strictObject({
  metadata: metadataSchema,
  intent: z.array(fieldSchema),
  body: z.array(fieldSchema),
});
export type SearchHit = z.infer<typeof metadataSchema> & {
  match_class: SearchMatchClass;
  snippet: string;
  snippet_field: string | null;
};

export function searchSourceForProjection(source: SearchSource): SearchProjectionSource {
  const metadata = metadataSchema.parse({
    project_id: source.project_id,
    artifact_id: source.artifact_id,
    source_id: source.source_id,
    source_event_id: source.source_event_id,
    content_event_id: source.content_event_id,
    source_kind: source.source_kind,
    source_locator: source.source_locator,
    source_ownership: source.source_ownership,
    origin: source.origin,
    evidence_time: source.evidence_time,
    evidence_time_basis: source.evidence_time_basis,
    ...(source.evidence_time_unknown_reason === undefined
      ? {}
      : { evidence_time_unknown_reason: source.evidence_time_unknown_reason }),
    recorded_at: source.recorded_at,
    imported_at: source.imported_at,
    enriched_at: source.enriched_at,
    artifact_commit_generation: source.artifact_commit_generation,
    decision_provenance: source.decision_provenance,
  });
  return {
    artifact_id: source.artifact_id,
    source_id: source.source_id,
    source_kind: source.source_kind,
    origin_rank: source.origin === 'captured' ? 0 : 1,
    evidence_time: source.evidence_time,
    tokens_json: canonicalJson({
      intent_fields: source.intent_fields,
      body_fields: source.body_fields,
    }),
    payload_json: canonicalJson({
      metadata,
      intent: source.intent.map(({ path, text }) => ({ path, text })),
      body: source.body.map(({ path, text }) => ({ path, text })),
    }),
  };
}

function excerpt(text: string, query: readonly string[]): string {
  const terms = new Set(query);
  let position = 0;
  for (const word of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    if (tokenizeSearchText(word[0]).some((token) => terms.has(token))) {
      position = word.index;
      break;
    }
  }
  const start = Math.max(0, position - 60);
  const end = Math.min(text.length, start + 260);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < text.length ? '…' : ''}`;
}

export function searchHitFromProjection(
  row: SearchProjectionMatch,
  query: readonly string[]
): SearchHit {
  const payload = payloadSchema.parse(JSON.parse(row.payload_json));
  const metadata = payload.metadata;
  if (
    metadata.project_id !== row.project_id ||
    metadata.artifact_id !== row.artifact_id ||
    metadata.source_id !== row.source_id ||
    Number(metadata.origin === 'imported') !== row.origin_rank ||
    metadata.evidence_time !== row.evidence_time
  )
    throw new Error('Search result payload differs from its indexed identity or order');
  const fields = {
    intent_fields: payload.intent.map((field) => tokenizeSearchText(field.text)),
    body_fields: payload.body.map((field) => tokenizeSearchText(field.text)),
  };
  const matchClass = classifySearchMatch(fields, query);
  const expectedClass = ['intent_phrase', 'text_phrase', 'all_terms'][row.match_class];
  if (matchClass === null || matchClass !== expectedClass)
    throw new Error('Search result payload differs from its indexed match');
  const candidates =
    matchClass === 'intent_phrase'
      ? payload.intent
      : matchClass === 'text_phrase'
        ? payload.body
        : [...payload.intent, ...payload.body];
  const first = candidates.find((field) => {
    const tokens = tokenizeSearchText(field.text);
    return matchClass === 'all_terms'
      ? tokens.some((token) => query.includes(token))
      : classifySearchMatch({ intent_fields: [], body_fields: [tokens] }, query) === 'text_phrase';
  });
  return {
    ...metadata,
    match_class: matchClass,
    snippet: first === undefined ? '' : excerpt(first.text, query),
    snippet_field: first?.path ?? null,
  };
}
