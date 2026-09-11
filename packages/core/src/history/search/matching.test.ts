import { describe, expect, it } from 'vitest';

import {
  classifySearchMatch,
  compareSearchOrder,
  normalizeSearchQuery,
  type SearchOrderKey,
  tokenizeSearchText,
} from './matching.js';

const fields = (intent: string[], body: string[]) => ({
  intent_fields: intent.map(tokenizeSearchText),
  body_fields: body.map(tokenizeSearchText),
});

describe('canonical search matching', () => {
  it('normalizes Unicode without stemming, substring expansion, or full linguistic case folding', () => {
    expect(tokenizeSearchText('CAFÉ_cache store-lock C++ ＬＯＣＫ Straße')).toEqual([
      'cafe',
      'cache',
      'store',
      'lock',
      'c',
      'lock',
      'straße',
    ]);
    expect(tokenizeSearchText('東京_手順 naïve')).toEqual(['東京', '手順', 'naive']);
    expect(
      classifySearchMatch(fields([], ['running strasse']), normalizeSearchQuery('run'))
    ).toBeNull();
    expect(classifySearchMatch(fields([], ['straße']), normalizeSearchQuery('strasse'))).toBeNull();
    expect(() => normalizeSearchQuery(' *:_ ')).toThrowError(
      expect.objectContaining({ code: 'INVALID_QUERY' })
    );
    expect(normalizeSearchQuery('one OR "two"*')).toEqual(['one', 'or', 'two']);
  });

  it('selects one strongest class and preserves repeated phrase tokens', () => {
    const query = normalizeSearchQuery('lock lock');
    expect(classifySearchMatch(fields(['lock lock'], ['lock lock']), query)).toBe('intent_phrase');
    expect(classifySearchMatch(fields(['lock'], ['lock lock']), query)).toBe('text_phrase');
    expect(classifySearchMatch(fields(['lock'], []), query)).toBe('all_terms');
    expect(classifySearchMatch(fields(['cache'], ['lock']), normalizeSearchQuery('lock'))).toBe(
      'text_phrase'
    );
    expect(classifySearchMatch(fields(['lock'], ['lock']), normalizeSearchQuery('lock'))).toBe(
      'intent_phrase'
    );
  });

  it('never joins fields or list entries to invent a phrase', () => {
    const query = normalizeSearchQuery('durable history');
    expect(classifySearchMatch(fields(['durable', 'history'], []), query)).toBe('all_terms');
    expect(classifySearchMatch(fields([], ['durable', 'history']), query)).toBe('all_terms');
    expect(classifySearchMatch(fields(['durable'], ['history']), query)).toBe('all_terms');
    expect(classifySearchMatch(fields([], ['durable unavailable history']), query)).toBe(
      'all_terms'
    );
    expect(classifySearchMatch(fields([], ['durable-history']), query)).toBe('text_phrase');
  });

  it('orders fidelity within match class, then known evidence time and stable identities', () => {
    const key = (source_id: string, changes: Partial<SearchOrderKey> = {}): SearchOrderKey => ({
      source_id,
      project_id: 'project-a',
      artifact_id: 'artifact-a',
      match_class: 'text_phrase',
      origin: 'captured',
      evidence_time: '2020-01-01T00:00:00.000Z',
      ...changes,
    });
    const rows = [
      key('unknown', { evidence_time: null }),
      key('imported', { origin: 'imported', evidence_time: '2026-01-01T00:00:00.000Z' }),
      key('old'),
      key('stronger', { match_class: 'intent_phrase', origin: 'imported' }),
      key('later-project', { project_id: 'project-b' }),
      key('later-artifact', { artifact_id: 'artifact-b' }),
      key('a'),
      key('new', { evidence_time: '2025-01-01T00:00:00.000Z' }),
    ];
    expect(rows.sort(compareSearchOrder).map((row) => row.source_id)).toEqual([
      'stronger',
      'new',
      'a',
      'old',
      'later-artifact',
      'later-project',
      'unknown',
      'imported',
    ]);
  });
});
