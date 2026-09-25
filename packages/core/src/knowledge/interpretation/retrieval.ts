import type {
  RelatedKnowledgeBounds,
  RelatedKnowledgeOmission,
  RelatedKnowledgeRetrieval,
} from '@orcaops/storage/history/database';

import type { CoverageLimit, CoverageLimitKind, RelatedKnowledge } from './manifest.js';

/**
 * What bounded retrieval is allowed to put in a manifest, and how its answer becomes one.
 *
 * Pure: the store's answer is an argument, like every other read this module takes, so the same
 * retrieval always produces the same related knowledge and the same coverage limits. Storage owns
 * the reading and knows nothing of a manifest; this is where the two meet.
 */

/**
 * **The bounds rule.** Related knowledge may take at most a quarter of the configured input budget,
 * so the source itself always keeps three quarters of it: a manifest whose related set crowded out
 * the passage would send a model everything except the thing it was asked to read. The identity
 * cap follows from that budget rather than being named on its own — one identity's statements run
 * to a few hundred bytes, so the budget divided by {@link TYPICAL_STATEMENT_BYTES} is how many can
 * fit — and is clamped so a tiny budget still carries one identity and a large one does not turn
 * the attempt into a survey of the project.
 *
 * The search bounds are fixed rather than derived: they bound what is *looked at* in the store,
 * which the input budget says nothing about.
 */
export const RELATED_KNOWLEDGE_INPUT_SHARE = 4;
export const TYPICAL_STATEMENT_BYTES = 512;
export const MAX_RELATED_IDENTITIES = 24;
export const RELATED_KNOWLEDGE_SEARCH_TERMS = 12;
export const RELATED_KNOWLEDGE_SEARCH_HITS = 50;
export const RELATED_KNOWLEDGE_SOURCES_FOLLOWED = 64;

export function relatedKnowledgeBounds(limits: {
  max_input_bytes: number;
}): RelatedKnowledgeBounds {
  const maxStatementBytes = Math.max(
    0,
    Math.floor(limits.max_input_bytes / RELATED_KNOWLEDGE_INPUT_SHARE)
  );
  return {
    maxStatementBytes,
    maxIdentities: Math.min(
      MAX_RELATED_IDENTITIES,
      Math.max(1, Math.floor(maxStatementBytes / TYPICAL_STATEMENT_BYTES))
    ),
    maxSearchTerms: RELATED_KNOWLEDGE_SEARCH_TERMS,
    maxSearchHits: RELATED_KNOWLEDGE_SEARCH_HITS,
    maxSourcesFollowed: RELATED_KNOWLEDGE_SOURCES_FOLLOWED,
  };
}

/**
 * What one carried identity costs around its statement when the request renders it: its ref, kind,
 * standing, designation and source standing on one line, the indent of the next and the JSON quotes
 * around the wording. Generous on purpose — this is a reservation, not a measurement.
 */
export const RELATED_ENTRY_FRAMING_BYTES = 128;

/**
 * The most the related knowledge a manifest may carry can cost the request, from the configured
 * input budget alone: the share the bounds rule allows its statements, and the framing the render
 * puts around each identity that share can pay for.
 *
 * **A chunk division is measured against this and never against what retrieval returned.** A
 * source's later chunks carry the records its earlier chunks published, so a division measured
 * against the actual related set shrinks as the job publishes: the chunk count changes, the plan id
 * with it, and `planJobAttempts` starts the source over with fewer attempts left than it needs —
 * a terminal failure with half the source already in the store. Reserving the ceiling makes the
 * division a function of the source and the configured limits and of nothing else, so the plan id
 * never moves however much a later attempt carries.
 *
 * The framing is reserved for as many identities as the bound ever allows rather than for as many
 * as this budget affords, because `maxIdentities` steps: reserving its step would make the room
 * left for the source fall back as the cap rose, and `too_large` has to stay monotonic in the cap.
 */
export function relatedKnowledgeCeilingBytes(limits: { max_input_bytes: number }): number {
  return (
    relatedKnowledgeBounds(limits).maxStatementBytes +
    MAX_RELATED_IDENTITIES * RELATED_ENTRY_FRAMING_BYTES
  );
}

/**
 * A truncation is what was cut to fit, a restriction is what this attempt was not allowed to read,
 * and everything else is a statement about how far retrieval reached. All three are coverage
 * limits; none of them is silence.
 */
const LIMIT_KIND: Readonly<Record<RelatedKnowledgeOmission['kind'], CoverageLimitKind>> = {
  identity_count: 'related_knowledge_truncated',
  statement_bytes: 'related_knowledge_truncated',
  search_hit_cap: 'related_knowledge_truncated',
  access_restricted: 'access_restricted_omitted',
  sources_followed_cap: 'retrieval_limit',
  search_index_stale: 'retrieval_limit',
  wording_match_bounded: 'retrieval_limit',
  later_than_boundary: 'retrieval_limit',
};

export interface ManifestRelatedKnowledge {
  related_knowledge: readonly RelatedKnowledge[];
  coverage_limits: readonly CoverageLimit[];
}

/**
 * The retrieval, as `ManifestInput` takes it. The leading limit says what was looked for, so an
 * empty related set reads as "retrieval found nothing at this boundary" and never as "nothing was
 * looked for" — which is the only thing an empty array could otherwise mean.
 */
export function manifestRelatedKnowledge(
  retrieval: RelatedKnowledgeRetrieval
): ManifestRelatedKnowledge {
  const { counts, bounds } = retrieval;
  return {
    related_knowledge: retrieval.entries.map((entry) => ({
      resolved: entry.resolved,
      statements: entry.statements,
    })),
    coverage_limits: [
      {
        kind: 'retrieval_limit',
        detail:
          `Bounded retrieval read related knowledge at write sequence ${retrieval.boundary}: ` +
          `${counts.candidates} identit(y/ies) were found by exact reference, by the search over ` +
          `structured captures and by wording match, and ${counts.included} of them are carried, ` +
          `at most ${bounds.maxIdentities} and ${bounds.maxStatementBytes} bytes of statements.`,
      },
      ...retrieval.omissions.map((omission) => ({
        kind: LIMIT_KIND[omission.kind],
        detail: omission.detail,
      })),
    ],
  };
}

/** What a retained attempt says about the retrieval it was built on. */
export interface RetrievalAttemptRecord {
  knowledge_boundary: number;
  bounds: RelatedKnowledgeBounds;
  counts: RelatedKnowledgeRetrieval['counts'];
  limits: readonly RelatedKnowledgeOmission['kind'][];
}

/**
 * The bounds and counts an attempt records beside its configuration, so a retained attempt says
 * what was looked for and not only what was found.
 */
export function retrievalAttemptRecord(
  retrieval: RelatedKnowledgeRetrieval
): RetrievalAttemptRecord {
  return {
    knowledge_boundary: retrieval.boundary,
    bounds: retrieval.bounds,
    counts: retrieval.counts,
    limits: retrieval.omissions.map((omission) => omission.kind),
  };
}
