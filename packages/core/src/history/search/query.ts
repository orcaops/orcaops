import type { SearchProjectionBatch, SearchQuery } from '@orcaops/storage/history/search-content';

import { SEARCH_SOURCE_KINDS } from './fields.js';
import { type SearchHit, searchHitFromProjection } from './hits.js';
import { compareSearchOrder, HistorySearchError, normalizeSearchQuery } from './matching.js';

export interface HistorySearchProject {
  projectId: string;
  artifactIds?: readonly string[];
  query(
    input: Omit<SearchQuery, 'artifactIds'> & { artifactIds?: readonly string[] }
  ): Promise<SearchProjectionBatch>;
}

export async function queryHistorySearch(input: {
  query: string;
  projects: readonly HistorySearchProject[];
  sourceComplete: boolean;
  limit?: number;
  offset?: number;
  sourceKinds?: readonly (typeof SEARCH_SOURCE_KINDS)[number][];
  scanLimitPerProject?: number;
}) {
  const projects = input.projects.map((project) => ({
    projectId: project.projectId,
    artifactIds: project.artifactIds === undefined ? undefined : [...project.artifactIds],
    query: project.query.bind(project),
  }));
  let sourceComplete = input.sourceComplete;
  const scanLimit = input.scanLimitPerProject;
  const query = normalizeSearchQuery(input.query);
  const limit = input.limit ?? 25;
  const offset = input.offset ?? 0;
  const prefix = offset + limit + 1;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(prefix) ||
    (scanLimit !== undefined && (!Number.isSafeInteger(scanLimit) || scanLimit < 1))
  )
    throw new HistorySearchError(
      'INVALID_FILTER',
      'Search requires a positive limit and a nonnegative offset within the supported integer range.'
    );
  if (new Set(projects.map((project) => project.projectId)).size !== projects.length)
    throw new HistorySearchError('INVALID_FILTER', 'Search requires one query per project.');
  const sourceKinds = [...new Set(input.sourceKinds ?? SEARCH_SOURCE_KINDS)].sort();
  if (sourceKinds.some((kind) => !SEARCH_SOURCE_KINDS.includes(kind)))
    throw new HistorySearchError('INVALID_FILTER', 'Search source type is unsupported.');
  const rows: SearchHit[] = [];
  let candidateComplete = true;
  let countsKnown = true;
  let projectRankingComplete = true;
  let captured = 0;
  let imported = 0;
  let scanned = 0;
  for (const project of projects) {
    const batch = await project.query({
      query,
      artifactIds: project.artifactIds,
      sourceKinds,
      limit: prefix,
      scanLimit,
    });
    if (batch.rows.length > prefix) throw new Error('Search project exceeded its requested prefix');
    const hits = batch.rows.map((row) => searchHitFromProjection(row, query));
    for (let index = 0; index < hits.length; index++) {
      const row = hits[index]!;
      if (
        row.project_id !== project.projectId ||
        (index > 0 && compareSearchOrder(hits[index - 1]!, row) >= 0)
      )
        throw new Error('Search project results must have distinct identities in final order');
    }
    for (const hit of hits) rows.push(hit);
    projectRankingComplete &&= batch.rankingComplete;
    candidateComplete &&= batch.candidateComplete;
    sourceComplete &&= batch.sourceComplete;
    countsKnown &&=
      batch.rankingComplete && batch.counts.captured !== null && batch.counts.imported !== null;
    captured += batch.counts.captured ?? 0;
    imported += batch.counts.imported ?? 0;
    scanned += batch.scanned;
  }
  rows.sort(compareSearchOrder);
  const results = rows.slice(offset, offset + limit);
  const hasMore = rows.length > offset + limit;
  const rankingComplete = sourceComplete && candidateComplete && projectRankingComplete;
  countsKnown &&= rankingComplete;
  return {
    results,
    page: {
      limit,
      offset,
      returned: results.length,
      next_offset: hasMore ? offset + limit : null,
      truncated: hasMore || !rankingComplete,
      ranking_complete: rankingComplete,
      source_complete: sourceComplete,
      candidate_complete: candidateComplete,
    },
    origin_counts: {
      returned: {
        captured: results.filter((row) => row.origin === 'captured').length,
        imported: results.filter((row) => row.origin === 'imported').length,
      },
      matching: {
        captured: countsKnown ? captured : null,
        imported: countsKnown ? imported : null,
      },
    },
    diagnostics: { scanned_candidates: scanned, project_batches: projects.length },
  };
}
