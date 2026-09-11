import { describe, expect, it } from 'vitest';

import { DIGEST_SIBLING_LIMIT, selectDigestSiblingRows } from './database-digest.js';

describe('selectDigestSiblingRows', () => {
  it('keeps live siblings visible and caps a large imported corpus', () => {
    const live = [{ id: 'live-a' }, { id: 'live-b', origin: 'captured' as const }];
    const imported = Array.from({ length: 30 }, (_, index) => ({
      id: `imported-${index}`,
      origin: 'git-import' as const,
    }));

    const selected = selectDigestSiblingRows([...imported, ...live]);
    expect(selected).toHaveLength(DIGEST_SIBLING_LIMIT);
    expect(selected.slice(0, 2).map((row) => row.id)).toEqual(['live-a', 'live-b']);
    expect(selected.filter((row) => row.origin === 'git-import')).toHaveLength(
      DIGEST_SIBLING_LIMIT - live.length
    );
  });
});
