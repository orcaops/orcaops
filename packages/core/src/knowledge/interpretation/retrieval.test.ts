import { expect, it } from 'vitest';

import type {
  RelatedKnowledgeOmission,
  RelatedKnowledgeRetrieval,
} from '@orcaops/storage/history/database';

import { existingKnowledge, KNOWLEDGE_BOUNDARY, PROJECT } from './evaluation/knowledge.js';
import {
  manifestRelatedKnowledge,
  MAX_RELATED_IDENTITIES,
  RELATED_KNOWLEDGE_INPUT_SHARE,
  relatedKnowledgeBounds,
  retrievalAttemptRecord,
  TYPICAL_STATEMENT_BYTES,
} from './retrieval.js';

const OFFLINE = existingKnowledge({
  kind: 'requirement',
  entity_id: 'requirement-offline',
  revision_id: 'requirement-offline-r1',
  text: 'The inspection app must keep working with no network.',
});

const retrievalOf = (
  change: Partial<RelatedKnowledgeRetrieval> = {}
): RelatedKnowledgeRetrieval => ({
  boundary: KNOWLEDGE_BOUNDARY,
  scope: PROJECT,
  bounds: relatedKnowledgeBounds({ max_input_bytes: 40_000 }),
  coverage: {
    scope: PROJECT,
    mode: 'current',
    boundary: KNOWLEDGE_BOUNDARY,
    omitted: [],
    unresolved: [],
    later: [],
    branchScoped: [],
  },
  entries: [
    {
      target: { kind: 'requirement', entity_id: 'requirement-offline' },
      routes: ['task_use'],
      resolved: OFFLINE.resolved,
      statements: OFFLINE.statements,
      statementBytes: 53,
      sharesWording: true,
    },
  ],
  omissions: [],
  counts: {
    candidates: 1,
    included: 1,
    omitted: 0,
    searchTerms: 4,
    searchHits: 2,
    statementBytes: 53,
  },
  ...change,
});

it('gives related knowledge a quarter of the input budget and no more', () => {
  const bounds = relatedKnowledgeBounds({ max_input_bytes: 40_000 });
  expect(bounds.maxStatementBytes).toBe(40_000 / RELATED_KNOWLEDGE_INPUT_SHARE);
  expect(bounds.maxIdentities).toBe(
    Math.min(MAX_RELATED_IDENTITIES, Math.floor(bounds.maxStatementBytes / TYPICAL_STATEMENT_BYTES))
  );
});

it('carries one identity however small the budget, and never more than the cap', () => {
  expect(relatedKnowledgeBounds({ max_input_bytes: 100 })).toMatchObject({
    maxStatementBytes: 25,
    maxIdentities: 1,
  });
  expect(relatedKnowledgeBounds({ max_input_bytes: 0 })).toMatchObject({
    maxStatementBytes: 0,
    maxIdentities: 1,
  });
  expect(relatedKnowledgeBounds({ max_input_bytes: 10_000_000 }).maxIdentities).toBe(
    MAX_RELATED_IDENTITIES
  );
});

it('hands the manifest each answer with the wording of the revisions it names', () => {
  const related = manifestRelatedKnowledge(retrievalOf());
  expect(related.related_knowledge).toEqual([
    { resolved: OFFLINE.resolved, statements: OFFLINE.statements },
  ]);
});

it('says what was looked for, so an empty related set is never read as nothing existing', () => {
  const empty = manifestRelatedKnowledge(
    retrievalOf({
      entries: [],
      counts: {
        candidates: 0,
        included: 0,
        omitted: 0,
        searchTerms: 6,
        searchHits: 0,
        statementBytes: 0,
      },
    })
  );
  expect(empty.related_knowledge).toEqual([]);
  expect(empty.coverage_limits[0]).toEqual({
    kind: 'retrieval_limit',
    detail: expect.stringContaining(`at write sequence ${KNOWLEDGE_BOUNDARY}`),
  });
  expect(empty.coverage_limits[0]!.detail).toContain('0 of them are carried');
});

it('records a truncation, a restriction and a reach as the limit each one is', () => {
  const omissions: RelatedKnowledgeOmission[] = [
    { kind: 'identity_count', detail: 'four left out' },
    { kind: 'statement_bytes', detail: 'one left out whole' },
    { kind: 'search_hit_cap', detail: 'rows beyond the cap' },
    { kind: 'access_restricted', detail: 'customer-confidential' },
    { kind: 'sources_followed_cap', detail: 'more events than followed' },
    { kind: 'search_index_stale', detail: 'one artifact unindexed' },
    { kind: 'wording_match_bounded', detail: 'no index over statements' },
  ];
  const limits = manifestRelatedKnowledge(retrievalOf({ omissions })).coverage_limits;
  expect(limits.slice(1).map((limit) => limit.kind)).toEqual([
    'related_knowledge_truncated',
    'related_knowledge_truncated',
    'related_knowledge_truncated',
    'access_restricted_omitted',
    'retrieval_limit',
    'retrieval_limit',
    'retrieval_limit',
  ]);
  expect(limits.map((limit) => limit.detail)).toContain('customer-confidential');
});

it('retains the bounds and counts an attempt was made under', () => {
  const retrieval = retrievalOf({
    omissions: [{ kind: 'wording_match_bounded', detail: 'no index over statements' }],
  });
  expect(retrievalAttemptRecord(retrieval)).toEqual({
    knowledge_boundary: KNOWLEDGE_BOUNDARY,
    bounds: retrieval.bounds,
    counts: retrieval.counts,
    limits: ['wording_match_bounded'],
  });
});
