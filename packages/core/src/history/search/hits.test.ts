import { describe, expect, it } from 'vitest';

import type { SearchProjectionMatch } from '@orcaops/storage/history/search-content';

import { searchFieldsForEvent } from './fields.js';
import { searchHitFromProjection, searchSourceForProjection } from './hits.js';
import type { SearchSource } from './sources.js';

function fixture(): SearchSource {
  return {
    ...searchFieldsForEvent('checkpoint_closed', {
      summary: 'unrelated '.repeat(1000) + 'CAFÉ_cache native exclusion',
      uncertainty: ['retained context'],
    }),
    project_id: 'project',
    artifact_id: 'artifact',
    source_id: 'source',
    source_event_id: 'source',
    content_event_id: 'source',
    source_kind: 'checkpoint',
    source_locator: 'checkpoint_closed:1',
    source_ownership: 'authored_event',
    origin: 'captured',
    evidence_time: '2026-01-01T00:00:00.000Z',
    evidence_time_basis: 'captured_event',
    recorded_at: '2026-01-01T00:00:00.000Z',
    imported_at: null,
    enriched_at: null,
    artifact_commit_generation: 2,
    decision_provenance: [],
    branch_membership: ['feature'],
    touched_files: ['src/file.ts'],
  };
}

function indexed(source: SearchSource): SearchProjectionMatch {
  const row = searchSourceForProjection(source);
  return {
    project_id: source.project_id,
    artifact_id: row.artifact_id,
    source_id: row.source_id,
    origin_rank: row.origin_rank,
    evidence_time: row.evidence_time,
    match_class: 1,
    payload_json: row.payload_json,
  };
}

describe('bounded search hit presentation', () => {
  it('stores tokens once and returns a bounded excerpt around actual matching text', () => {
    const source = fixture();
    const row = searchSourceForProjection(source);
    const payload = JSON.parse(row.payload_json);
    expect(payload).not.toHaveProperty('tokens_json');
    expect(payload.body[0]).not.toHaveProperty('tokens');
    expect(payload.metadata).not.toHaveProperty('touched_files');
    expect(payload.metadata).not.toHaveProperty('branch_membership');
    const hit = searchHitFromProjection(indexed(source), ['cafe', 'cache']);
    expect(hit).toMatchObject({
      source_id: 'source',
      match_class: 'text_phrase',
      snippet_field: 'summary',
      artifact_commit_generation: 2,
    });
    expect(hit.snippet).toContain('CAFÉ_cache');
    expect(hit.snippet.length).toBeLessThanOrEqual(262);
    expect(hit).not.toHaveProperty('body');
    expect(hit).not.toHaveProperty('intent_fields');
    expect(JSON.stringify(hit).length).toBeLessThan(1000);
  });

  it('keeps all-terms classification truthful when the excerpt covers one contributing field', () => {
    const source = fixture();
    const row = { ...indexed(source), match_class: 2 };
    const hit = searchHitFromProjection(row, ['exclusion', 'retained']);
    expect(hit.match_class).toBe('all_terms');
    expect(hit.snippet_field).toBe('summary');
    expect(hit.snippet).toContain('exclusion');
    expect(hit.snippet).not.toContain('retained');
  });

  it('rejects mismatched indexed identity, chronology, and classification before returning a hit', () => {
    const row = indexed(fixture());
    for (const changed of [
      { source_id: 'foreign' },
      { project_id: 'foreign' },
      { origin_rank: 1 },
      { evidence_time: null },
      { match_class: 0 },
    ]) {
      expect(() => searchHitFromProjection({ ...row, ...changed }, ['cafe', 'cache'])).toThrow(
        /differs/
      );
    }
  });
});
