import { describe, expect, it } from 'vitest';

import type { SearchResultRow } from '@orcaops/storage';

import { filterResultsByScope, sanitizeFtsQuery, selectSearchProjectionHits } from './search.js';

describe('sanitizeFtsQuery', () => {
  it('wraps single tokens in double quotes', () => {
    expect(sanitizeFtsQuery('redis')).toBe('"redis"');
  });

  it('wraps each whitespace-delimited token (AND semantics by default)', () => {
    expect(sanitizeFtsQuery('redis middleware')).toBe('"redis" "middleware"');
  });

  it('keeps hyphens / colons / slashes intact inside the quoted phrase', () => {
    // These chars would normally be FTS5 operators (- = NOT, : = column).
    expect(sanitizeFtsQuery('rate-limit')).toBe('"rate-limit"');
    expect(sanitizeFtsQuery('foo:bar')).toBe('"foo:bar"');
    expect(sanitizeFtsQuery('src/api.ts')).toBe('"src/api.ts"');
  });

  it('escapes embedded double quotes per FTS5 rules ("" inside phrase)', () => {
    expect(sanitizeFtsQuery('say "hi"')).toBe('"say" """hi"""');
  });

  it('collapses runs of whitespace and ignores empty tokens', () => {
    expect(sanitizeFtsQuery('  redis   middleware  ')).toBe('"redis" "middleware"');
  });

  it('returns empty string for whitespace-only input (CLI rejects before we get here)', () => {
    expect(sanitizeFtsQuery('   ')).toBe('');
  });
});

describe('filterResultsByScope', () => {
  const row = (artifact_id: string, source = 'checkpoint:1'): SearchResultRow => ({
    artifact_id,
    source,
    branch: 'main',
    ts: '2026-07-01T00:00:00.000Z',
    snippet: '…',
    rank: -1,
  });

  it('keeps rows whose artifact touched a matching path (files_changed or touched_scope)', () => {
    const paths = new Map<string, readonly string[]>([
      ['a', ['src/auth/login.ts']],
      ['b', ['docs/readme.md']],
      ['c', ['payments']], // a literal touched_scope tag
    ]);
    const rows = [row('a'), row('b'), row('c')];
    expect(filterResultsByScope(rows, paths, 'src/**').map((r) => r.artifact_id)).toEqual(['a']);
    expect(filterResultsByScope(rows, paths, 'payments').map((r) => r.artifact_id)).toEqual(['c']);
  });

  it('a declared scope entry that is itself a glob matches only as literal text', () => {
    const paths = new Map<string, readonly string[]>([['a', ['src/**']]]);
    // The --scope pattern must match the literal text "src/**" as a path;
    // glob-vs-glob intersection is not attempted.
    expect(filterResultsByScope([row('a')], paths, 'src/deep/file.ts')).toEqual([]);
    expect(filterResultsByScope([row('a')], paths, 'src/**').map((r) => r.artifact_id)).toEqual([
      'a',
    ]);
  });

  it('artifacts with an empty (or missing) scope-path set drop', () => {
    const paths = new Map<string, readonly string[]>([['a', []]]);
    expect(filterResultsByScope([row('a'), row('unknown')], paths, '**')).toEqual([]);
  });
});

describe('selectSearchProjectionHits', () => {
  const row = (artifact_id: string): SearchResultRow => ({
    artifact_id,
    source: 'plan',
    branch: 'main',
    ts: '2026-07-01T00:00:00.000Z',
    snippet: '…',
    rank: -1,
  });

  it('drops stale-projection-only hits and preserves raw-query truncation disclosure', () => {
    const selected = new Map<string, 'hot' | 'archive'>([
      ['archive-selected', 'archive'],
      ['hot-selected', 'hot'],
    ]);
    const result = selectSearchProjectionHits(
      [row('archive-selected'), row('missing-selection')],
      selected,
      'hot',
      2
    );
    expect(result.rows).toEqual([]);
    expect(result.prefilterTruncated).toBe(true);
  });

  it('keeps every hit from the selected projection', () => {
    const selected = new Map<string, 'hot' | 'archive'>([['a', 'archive']]);
    const hits = [row('a'), { ...row('a'), source: 'checkpoint:1' }];
    expect(selectSearchProjectionHits(hits, selected, 'archive').rows).toEqual(hits);
  });
});
