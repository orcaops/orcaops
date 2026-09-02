import { describe, expect, it } from 'vitest';

import { isSearchType, SEARCH_TYPES, type SearchType } from './search-types.js';

describe('SEARCH_TYPES', () => {
  it('carries every type the search command accepts', () => {
    // Spelled out rather than derived from the constant, so adding a type to
    // the command without adding it here fails instead of silently agreeing.
    // The drift this replaces was exactly the opposite: the harness modelled
    // four of these and the command grew three more.
    expect([...SEARCH_TYPES]).toEqual([
      'plan',
      'checkpoint',
      'summary',
      'evaluator',
      'digest',
      'block-resolution',
      'pin-displaced',
    ]);
  });

  it('accepts every member and rejects anything else', () => {
    for (const type of SEARCH_TYPES) expect(isSearchType(type)).toBe(true);
    for (const other of ['', 'plans', 'Checkpoint', 'summary ', 'evaluator-run']) {
      expect(isSearchType(other)).toBe(false);
    }
  });

  it('narrows to SearchType, so a caller cannot pass an unchecked string', () => {
    const raw: string = 'pin-displaced';
    if (!isSearchType(raw)) throw new Error('unreachable');
    const narrowed: SearchType = raw;
    expect(narrowed).toBe('pin-displaced');
  });
});
