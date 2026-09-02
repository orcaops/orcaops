import { describe, expect, it } from 'vitest';

import { SEARCH_TYPES } from '@orcaops/evaluator-protocol/search-types';

import type { SearchEntry, SearchSourceRef } from './sqlite.js';

/**
 * The index `source` is what `search --type` filters on, so it and the flag
 * must name the same set. Enforcement is the TYPE on `SearchEntry.source`:
 * every writer, in this package and in `@orcaops/core`, is checked by the
 * compiler. These cover the parts a type cannot state on its own.
 */
describe('search source refs', () => {
  it('accepts a bare type and a type with an instance suffix', () => {
    const bare: SearchSourceRef = 'digest';
    const suffixed: SearchSourceRef = 'checkpoint:3';
    const uuidSuffixed: SearchSourceRef = 'evaluator:019fc013-a305-7ff1-8125-057d164d975d';
    expect([bare, suffixed, uuidSuffixed]).toHaveLength(3);
  });

  it('rejects a source whose prefix is not a search type', () => {
    // @ts-expect-error 'bogus' is not a SearchType, so no writer can emit it.
    const bogus: SearchSourceRef = 'bogus:0';
    // @ts-expect-error the same holds without a suffix.
    const bareBogus: SearchSourceRef = 'bogus';
    expect([bogus, bareBogus]).toHaveLength(2);
  });

  it('every search type is usable as a source, bare and suffixed', () => {
    // Ties the two sets together at runtime as well: a type added to the
    // shared contract is immediately a legal source, and one removed stops
    // being one.
    const refs: SearchSourceRef[] = SEARCH_TYPES.flatMap((t) => [t, `${t}:1` as const]);
    expect(refs).toHaveLength(SEARCH_TYPES.length * 2);
    for (const ref of refs) {
      expect(SEARCH_TYPES).toContain(ref.split(':')[0]);
    }
  });

  it('constrains the field on the entry, not just the standalone alias', () => {
    const entry: Pick<SearchEntry, 'source'> = { source: 'pin-displaced:abc' };
    expect(entry.source).toBe('pin-displaced:abc');
  });
});
