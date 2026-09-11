import { describe, expect, it, vi } from 'vitest';

import type {
  SearchProjectionBatch,
  SearchProjectionMatch,
} from '@orcaops/storage/history/search-content';

import { searchFieldsForEvent } from './fields.js';
import { searchSourceForProjection } from './hits.js';
import { classifySearchMatch, tokenizeSearchText } from './matching.js';
import { type HistorySearchProject, queryHistorySearch } from './query.js';
import type { SearchSource } from './sources.js';

function source(
  id: string,
  options: {
    project?: string;
    origin?: 'captured' | 'imported';
    time?: string | null;
    family?: 'intent' | 'body' | 'terms' | 'none';
  } = {}
): SearchSource {
  const family = options.family ?? 'intent';
  const fields =
    family === 'intent'
      ? searchFieldsForEvent('plan_captured', { label: 'project history' })
      : searchFieldsForEvent('checkpoint_closed', {
          summary:
            family === 'body' ? 'project history' : family === 'terms' ? 'project' : 'unrelated',
          uncertainty: family === 'terms' ? ['history'] : [],
        });
  return {
    ...fields,
    project_id: options.project ?? 'project',
    artifact_id: 'artifact',
    source_id: id,
    source_event_id: id,
    content_event_id: id,
    source_kind: family === 'intent' ? 'plan' : 'checkpoint',
    source_locator: id,
    source_ownership: 'authored_event',
    origin: options.origin ?? 'captured',
    evidence_time: options.time === undefined ? '2020-01-01T00:00:00.000Z' : options.time,
    evidence_time_basis: options.time === null ? 'unknown' : 'captured_event',
    recorded_at: '2020-01-01T00:00:00.000Z',
    imported_at: null,
    enriched_at: null,
    artifact_commit_generation: 1,
    decision_provenance: [],
    branch_membership: [],
    touched_files: [],
  };
}
function project(sources: SearchSource[]): HistorySearchProject {
  const id = sources[0]?.project_id ?? 'empty';
  return {
    projectId: id,
    artifactIds: ['artifact'],
    async query(input): Promise<SearchProjectionBatch> {
      const artifactIds = new Set(input.artifactIds ?? []);
      const sourceKinds = new Set(input.sourceKinds);
      const eligible = sources
        .map(searchSourceForProjection)
        .filter((row) => artifactIds.has(row.artifact_id) && sourceKinds.has(row.source_kind))
        .sort((a, b) => lexical(a.artifact_id, b.artifact_id) || lexical(a.source_id, b.source_id));
      const inspected = eligible.slice(0, input.scanLimit ?? eligible.length);
      const rows = inspected
        .flatMap((row): SearchProjectionMatch[] => {
          const kind = classifySearchMatch(JSON.parse(row.tokens_json), input.query);
          return kind === null
            ? []
            : [
                {
                  project_id: id,
                  artifact_id: row.artifact_id,
                  source_id: row.source_id,
                  origin_rank: row.origin_rank,
                  evidence_time: row.evidence_time,
                  match_class: kind === 'intent_phrase' ? 0 : kind === 'text_phrase' ? 1 : 2,
                  payload_json: row.payload_json,
                },
              ];
        })
        .sort(compareProjectionOrder);
      const candidateComplete = inspected.length === eligible.length;
      const captured = rows.filter((row) => row.origin_rank === 0).length;
      const imported = rows.length - captured;
      return {
        rows: rows.slice(0, input.limit),
        counts: candidateComplete ? { captured, imported } : { captured: null, imported: null },
        rankingComplete: candidateComplete,
        candidateComplete,
        sourceComplete: true,
        scanned: inspected.length,
        elapsedMs: 0,
      };
    },
  };
}

const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compareProjectionOrder(a: SearchProjectionMatch, b: SearchProjectionMatch): number {
  return (
    a.match_class - b.match_class ||
    a.origin_rank - b.origin_rank ||
    Number(a.evidence_time === null) - Number(b.evidence_time === null) ||
    lexical(b.evidence_time ?? '', a.evidence_time ?? '') ||
    lexical(a.artifact_id, b.artifact_id) ||
    lexical(a.source_id, b.source_id)
  );
}
function input(projects: HistorySearchProject[]) {
  return {
    query: 'project history',
    projects,
    sourceComplete: true,
  };
}
function oracle(sources: SearchSource[]) {
  const phrase = (fields: readonly (readonly string[])[]) =>
    fields.some((tokens) =>
      tokens.some((token, index) => token === 'project' && tokens[index + 1] === 'history')
    );
  const rows = sources.flatMap((row) => {
    const tokens = [...row.intent_fields, ...row.body_fields].flat();
    const rank = phrase(row.intent_fields)
      ? 0
      : phrase(row.body_fields)
        ? 1
        : tokens.includes('project') && tokens.includes('history')
          ? 2
          : null;
    return rank === null ? [] : [{ row, rank }];
  });
  return rows
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(a.row.origin === 'imported') - Number(b.row.origin === 'imported') ||
        Number(a.row.evidence_time === null) - Number(b.row.evidence_time === null) ||
        lexical(b.row.evidence_time ?? '', a.row.evidence_time ?? '') ||
        lexical(a.row.project_id, b.row.project_id) ||
        lexical(a.row.artifact_id, b.row.artifact_id) ||
        lexical(a.row.source_id, b.row.source_id)
    )
    .map(({ row }) => `${row.project_id}/${row.source_id}`);
}

describe('canonical cross-project search pages', () => {
  it('matches an exhaustive oracle across all pages and unequal project distributions', async () => {
    const sources = Array.from({ length: 137 }, (_, n) =>
      source(String(n).padStart(3, '0'), {
        project: n % 5 === 0 ? 'a' : n % 3 === 0 ? 'z' : 'm',
        origin: n % 3 === 0 ? 'imported' : 'captured',
        time: n % 7 === 0 ? null : `202${n % 5}-01-01T00:00:00.00${n % 3}Z`,
        family: (['intent', 'body', 'terms', 'none'] as const)[n % 4],
      })
    );
    const projects = ['z', 'a', 'm'].map((id) =>
      project(sources.filter((row) => row.project_id === id))
    );
    const actual: string[] = [];
    let offset = 0;
    for (let n = 0; n < 40; n++) {
      const page = await queryHistorySearch({ ...input(projects), limit: 7, offset });
      actual.push(...page.results.map((row) => `${row.project_id}/${row.source_id}`));
      expect(page.page.ranking_complete).toBe(true);
      expect(page.origin_counts.matching.captured! + page.origin_counts.matching.imported!).toBe(
        oracle(sources).length
      );
      if (page.page.next_offset === null) break;
      offset = page.page.next_offset;
    }
    expect(actual).toEqual(oracle(sources));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('returns all nine older captured matches before twenty-five recent imports within their class', async () => {
    const sources = [
      ...Array.from({ length: 25 }, (_, n) =>
        source(`import-${n}`, {
          project: 'imports',
          origin: 'imported',
          time: '2026-01-01T00:00:00.000Z',
        })
      ),
      ...Array.from({ length: 9 }, (_, n) => source(`capture-${n}`, { project: 'captured' })),
    ];
    const projects = ['imports', 'captured'].map((id) =>
      project(sources.filter((row) => row.project_id === id))
    );
    const first = await queryHistorySearch(input(projects));
    expect(first.origin_counts).toEqual({
      returned: { captured: 9, imported: 16 },
      matching: { captured: 9, imported: 25 },
    });
    expect(first.results.map((row) => `${row.project_id}/${row.source_id}`)).toEqual(
      oracle(sources).slice(0, 25)
    );
    const next = await queryHistorySearch({ ...input(projects), offset: first.page.next_offset! });
    expect(next.origin_counts.returned).toEqual({ captured: 0, imported: 9 });
    expect(next.origin_counts.matching.captured).toBe(9);
    expect(next.page.next_offset).toBeNull();
  });

  it('queries each project once for the requested prefix without binding subsequent pages', async () => {
    const a = project([source('a'), source('b'), source('c')]);
    const query = vi.fn(a.query);
    a.query = query;
    const first = await queryHistorySearch({ ...input([a]), limit: 1, offset: 1 });
    expect(first.results.map((row) => row.source_id)).toEqual(['b']);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toMatchObject({ limit: 3 });
    expect(query.mock.calls[0]![0]).not.toHaveProperty('after');
    const changed = project([source('b'), source('c')]);
    const next = await queryHistorySearch({
      ...input([changed]),
      query: 'PRÓJECT_history',
      offset: first.page.next_offset!,
    });
    expect(next.results).toEqual([]);
    expect(next.page.next_offset).toBeNull();
  });

  it('preserves original project selection across asynchronous batches and project identity ties', async () => {
    const a = project([source('same', { project: 'a' }), source('tail', { project: 'a' })]);
    const z = project([source('same', { project: 'z' }), source('tail', { project: 'z' })]);
    const selected = input([a, z]);
    const original = a.query;
    a.query = async (query) => {
      const result = await original(query);
      z.artifactIds = [];
      selected.projects.length = 0;
      return result;
    };
    const first = await queryHistorySearch({ ...selected, limit: 2 });
    expect(first.results.map((row) => `${row.project_id}/${row.source_id}`)).toEqual([
      'a/same',
      'a/tail',
    ]);
    expect(first.page.next_offset).not.toBeNull();
    expect(first.origin_counts.matching.captured).toBe(4);
    z.artifactIds = ['artifact'];
    const next = await queryHistorySearch({
      ...input([z, a]),
      limit: 2,
      offset: first.page.next_offset!,
    });
    expect(next.results.map((row) => `${row.project_id}/${row.source_id}`)).toEqual([
      'z/same',
      'z/tail',
    ]);
    expect(next.page.next_offset).toBeNull();
  });

  it('makes matching totals unknown when a cap or unavailable source hides possible captured matches', async () => {
    const p = project([source('a-import', { origin: 'imported' }), source('z-captured')]);
    const capped = await queryHistorySearch({ ...input([p]), scanLimitPerProject: 1 });
    expect(capped).toMatchObject({
      page: {
        ranking_complete: false,
        source_complete: true,
        candidate_complete: false,
        truncated: true,
      },
      origin_counts: {
        returned: { captured: 0, imported: 1 },
        matching: { captured: null, imported: null },
      },
    });
    const unavailable = await queryHistorySearch({ ...input([p]), sourceComplete: false });
    expect(unavailable.page).toMatchObject({
      ranking_complete: false,
      source_complete: false,
      candidate_complete: true,
    });
    expect(unavailable.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(JSON.stringify(capped)).not.toMatch(/seed|captured_absent/);
  });

  it('refuses duplicate, reversed, oversized and foreign project results', async () => {
    const p = project([source('a'), source('b')]);
    const original = p.query;
    for (const transform of [
      (rows: Awaited<ReturnType<typeof original>>['rows']) => [rows[0]!, rows[0]!],
      (rows: Awaited<ReturnType<typeof original>>['rows']) => [...rows].reverse(),
      (rows: Awaited<ReturnType<typeof original>>['rows']) => [...rows, rows[0]!],
    ]) {
      p.query = async (query) => {
        const batch = await original(query);
        return { ...batch, rows: transform(batch.rows) };
      };
      await expect(queryHistorySearch({ ...input([p]), limit: 1 })).rejects.toThrow(
        /Search project/
      );
    }
    p.query = original;
    p.projectId = 'different';
    await expect(queryHistorySearch(input([p]))).rejects.toThrow(/Search project/);
  });

  it('validates limits, source types and duplicate project identities before any query', async () => {
    const p = project([source('a')]);
    for (const change of [
      { limit: 0 },
      { limit: NaN },
      { offset: -1 },
      { offset: 1.5 },
      { offset: Number.MAX_SAFE_INTEGER },
      { limit: Number.MAX_SAFE_INTEGER },
      { scanLimitPerProject: 0 },
      { projects: [p, p] },
    ])
      await expect(queryHistorySearch({ ...input([p]), ...change })).rejects.toMatchObject({
        code: 'INVALID_FILTER',
      });
    await expect(queryHistorySearch({ ...input([p]), query: '---' })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    });
    expect(tokenizeSearchText('PRÓJECT_history')).toEqual(['project', 'history']);
  });
});
