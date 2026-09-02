import { describe, expect, it } from 'vitest';

import { parseSnapshot } from './snapshot';

const VALID = JSON.stringify({
  generated_at: '2026-07-05T22:00:00.000Z',
  generatedAtMs: 1,
  dataRoot: '/x/.orcaops',
  archiveEnabled: true,
  totals: { activeThreads: 2, openCheckpoints: 1, sessionTokens: 1234 },
  projects: [{ projectId: 'p', displayName: 'p', threads: [] }],
  ticker: [],
});

describe('parseSnapshot', () => {
  it('parses a well-formed snapshot', () => {
    const snap = parseSnapshot(VALID);
    expect(snap.totals.activeThreads).toBe(2);
    expect(snap.projects).toHaveLength(1);
  });

  it('throws on non-JSON', () => {
    expect(() => parseSnapshot('not json')).toThrow();
  });

  it('throws when the shape is wrong (missing totals/projects)', () => {
    expect(() => parseSnapshot(JSON.stringify({ foo: 1 }))).toThrow(
      'unexpected watch snapshot shape'
    );
  });
});
