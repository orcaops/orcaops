import { describe, expect, it } from 'vitest';

import {
  assertWindowOrdered,
  type BetweenArtifactInput,
  collectBetweenArtifacts,
  collectTouchingRollup,
  parseBetweenRange,
  parseLimit,
  parseSince,
  parseStateFilter,
  parseUntil,
  resolveListLimit,
  type TouchingHit,
} from './list.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

describe('resolveListLimit', () => {
  it('bounds only a bare listing unless the user chooses a limit', () => {
    expect(resolveListLimit({})).toBe(50);
    expect(resolveListLimit({ json: true })).toBe(50);
    expect(resolveListLimit({ since: '2026-01-01' })).toBeUndefined();
    expect(resolveListLimit({ between: 'a..b' })).toBeUndefined();
    expect(resolveListLimit({ allProjects: true })).toBeUndefined();
    expect(resolveListLimit({ imported: true })).toBeUndefined();
    expect(resolveListLimit({ limit: 7 })).toBe(7);
  });
});

describe('parseStateFilter', () => {
  it('returns undefined when no flag is given', () => {
    expect(parseStateFilter(undefined)).toBeUndefined();
  });

  it('maps summarized onto the complete coarse status with an exact post-filter state', () => {
    expect(parseStateFilter('summarized')).toEqual({ status: 'complete', state: 'summarized' });
  });

  it.each(['planned', 'active', 'blocked'] as const)(
    'maps in-flight state %s onto the active status with a post-filter',
    (value) => {
      expect(parseStateFilter(value)).toEqual({ status: 'active', state: value });
    }
  );

  it('throws OrcaopsError(INVALID_INPUT) on an unknown value', () => {
    let caught: unknown;
    try {
      parseStateFilter('done');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrcaopsError);
    const err = caught as OrcaopsError;
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(err.inputPath).toBe('state');
    expect(err.message).toContain('planned, active, blocked, summarized');
    expect(err.message).toContain('"done"');
  });

  it('rejects the retired coarse vocabulary', () => {
    expect(() => parseStateFilter('abandoned')).toThrow(OrcaopsError);
    expect(() => parseStateFilter('complete')).toThrow(OrcaopsError);
  });

  it('rejects mixed-case values', () => {
    expect(() => parseStateFilter('Active')).toThrow(OrcaopsError);
  });

  it('rejects the empty string', () => {
    expect(() => parseStateFilter('')).toThrow(OrcaopsError);
  });
});

describe('parseLimit', () => {
  it('returns undefined when no flag is given', () => {
    expect(parseLimit(undefined)).toBeUndefined();
  });

  it.each([1, 2, 25, 1000])('accepts positive integer %d', (value) => {
    expect(parseLimit(value)).toBe(value);
  });

  it.each([0, -1, -100])('rejects non-positive value %d', (value) => {
    let caught: unknown;
    try {
      parseLimit(value);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrcaopsError);
    const err = caught as OrcaopsError;
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(err.inputPath).toBe('limit');
    expect(err.message).toBe('--limit must be a positive integer.');
  });

  it('rejects non-integer values', () => {
    expect(() => parseLimit(2.5)).toThrow(OrcaopsError);
  });

  it('rejects NaN (e.g. from `--limit abc`)', () => {
    expect(() => parseLimit(Number.NaN)).toThrow(OrcaopsError);
  });
});

describe('parseSince / parseUntil (UTC window bounds)', () => {
  it('returns undefined when no flag is given', () => {
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseUntil(undefined)).toBeUndefined();
  });

  it('date-only normalizes to the UTC day edge per bound', () => {
    expect(parseSince('2026-07-01')).toBe('2026-07-01T00:00:00.000Z');
    expect(parseUntil('2026-07-01')).toBe('2026-07-01T23:59:59.999Z');
  });

  it('full ISO datetimes pass through, canonicalized to Z-form', () => {
    expect(parseSince('2026-07-01T10:30:00Z')).toBe('2026-07-01T10:30:00.000Z');
    expect(parseUntil('2026-07-01T10:30:00.500Z')).toBe('2026-07-01T10:30:00.500Z');
  });

  it('an explicit offset converts to UTC', () => {
    expect(parseSince('2026-07-01T10:30:00+02:00')).toBe('2026-07-01T08:30:00.000Z');
  });

  it('a datetime WITHOUT an offset is read as UTC, never local time', () => {
    expect(parseSince('2026-07-01T10:30:00')).toBe('2026-07-01T10:30:00.000Z');
  });

  it.each(['yesterday', '07/01/2026', '2026-13-45', '2026-02-30', ''])(
    'rejects non-ISO input %j with INVALID_INPUT carrying the flag name',
    (value) => {
      let caught: unknown;
      try {
        parseSince(value, 'active-since');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OrcaopsError);
      const err = caught as OrcaopsError;
      expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
      expect(err.inputPath).toBe('active-since');
      expect(err.message).toContain('--active-since');
    }
  );
});

describe('assertWindowOrdered', () => {
  it('accepts an ordered pair, an equal pair, and open-ended bounds', () => {
    expect(() =>
      assertWindowOrdered('2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', 'since', 'until')
    ).not.toThrow();
    expect(() =>
      assertWindowOrdered('2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'since', 'until')
    ).not.toThrow();
    expect(() =>
      assertWindowOrdered('2026-07-01T00:00:00.000Z', undefined, 'since', 'until')
    ).not.toThrow();
    expect(() => assertWindowOrdered(undefined, undefined, 'since', 'until')).not.toThrow();
  });

  it('rejects an inverted pair with INVALID_INPUT naming both flags', () => {
    let caught: unknown;
    try {
      assertWindowOrdered(
        '2026-07-02T00:00:00.000Z',
        '2026-07-01T23:59:59.999Z',
        'active-since',
        'active-until'
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrcaopsError);
    const err = caught as OrcaopsError;
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(err.message).toContain('--active-since');
    expect(err.message).toContain('--active-until');
  });
});

describe('collectTouchingRollup', () => {
  const META = new Map([
    [
      'art-a',
      {
        label: 'artifact a',
        task: 'task a',
        branch: 'main',
        state: 'active' as const,
      },
    ],
    [
      'art-b',
      {
        label: 'artifact b',
        task: 'task b',
        branch: 'main',
        state: 'summarized' as const,
      },
    ],
  ]);

  const hit = (
    artifact_id: string,
    n: number,
    closed_at: string,
    summary = `cp ${n}`
  ): TouchingHit => ({ artifact_id, n, closed_at, summary, completed_step_ids: [] });

  it('groups hits per artifact with first/last_touched_at and newest-first checkpoints', () => {
    const rollups = collectTouchingRollup({
      hits: [
        hit('art-a', 2, '2026-07-02T10:00:00.000Z'),
        hit('art-a', 1, '2026-07-01T10:00:00.000Z'),
        hit('art-b', 1, '2026-07-03T10:00:00.000Z'),
      ],
      artifactMeta: META,
    });
    // art-b touched most recently → first.
    expect(rollups.map((r) => r.id)).toEqual(['art-b', 'art-a']);
    const a = rollups[1];
    expect(a.first_touched_at).toBe('2026-07-01T10:00:00.000Z');
    expect(a.last_touched_at).toBe('2026-07-02T10:00:00.000Z');
    expect(a.checkpoints.map((c) => c.n)).toEqual([2, 1]);
    expect(a.label).toBe('artifact a');
    expect(a.state).toBe('active');
  });

  it('drops hits whose artifact is outside the scoped meta map (branch/status filter)', () => {
    const rollups = collectTouchingRollup({
      hits: [
        hit('art-a', 1, '2026-07-01T10:00:00.000Z'),
        hit('art-unscoped', 1, '2026-07-05T10:00:00.000Z'),
      ],
      artifactMeta: META,
    });
    expect(rollups.map((r) => r.id)).toEqual(['art-a']);
  });

  it('same-timestamp checkpoints order by n desc; empty hits yield empty rollup', () => {
    const rollups = collectTouchingRollup({
      hits: [
        hit('art-a', 1, '2026-07-01T10:00:00.000Z'),
        hit('art-a', 2, '2026-07-01T10:00:00.000Z'),
      ],
      artifactMeta: META,
    });
    expect(rollups[0].checkpoints.map((c) => c.n)).toEqual([2, 1]);
    expect(collectTouchingRollup({ hits: [], artifactMeta: META })).toEqual([]);
  });
});

describe('parseBetweenRange', () => {
  it('splits a two-dot range with trimming', () => {
    expect(parseBetweenRange('v1.0.0..main')).toEqual({ from: 'v1.0.0', to: 'main' });
    expect(parseBetweenRange(' abc123 .. def456 ')).toEqual({ from: 'abc123', to: 'def456' });
  });

  it.each(['main...feature', 'main', '..main', 'main..', '..', 'a..b..c', ''])(
    'rejects %j with INVALID_INPUT on path "between"',
    (raw) => {
      let caught: unknown;
      try {
        parseBetweenRange(raw);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OrcaopsError);
      const err = caught as OrcaopsError;
      expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
      expect(err.inputPath).toBe('between');
    }
  );
});

describe('collectBetweenArtifacts', () => {
  const art = (
    id: string,
    shas: BetweenArtifactInput['shas'],
    overrides: Partial<BetweenArtifactInput> = {}
  ): BetweenArtifactInput => ({
    id,
    label: `label-${id}`,
    task: `task-${id}`,
    branch: 'main',
    state: 'summarized',
    started_at: '2026-07-01T00:00:00.000Z',
    completed_at: null,
    shas,
    lineageBranches: ['main'],
    ...overrides,
  });

  it('matches via any source: checkpoint sha, summary sha, or pre-pr sha', () => {
    const revListShas = new Set(['sha-in-range']);
    const viaCp = collectBetweenArtifacts({
      artifacts: [art('a', [{ source: 'checkpoint', n: 1, head_sha: 'sha-in-range' }])],
      revListShas,
      ref2LocalBranch: null,
    });
    expect(viaCp.matched.map((m) => m.id)).toEqual(['a']);
    expect(viaCp.matched[0].matched_shas).toEqual([
      { source: 'checkpoint', n: 1, head_sha: 'sha-in-range' },
    ]);

    // The commit-at-close off-by-one case: the only in-range sha is the
    // summary's — the cp head_sha is the range base (excluded by rev-list).
    const viaSummary = collectBetweenArtifacts({
      artifacts: [
        art('b', [
          { source: 'checkpoint', n: 1, head_sha: 'range-base-sha' },
          { source: 'summary', head_sha: 'sha-in-range' },
        ]),
      ],
      revListShas,
      ref2LocalBranch: null,
    });
    expect(viaSummary.matched.map((m) => m.id)).toEqual(['b']);
    expect(viaSummary.matched[0].matched_shas).toEqual([
      { source: 'summary', head_sha: 'sha-in-range' },
    ]);

    const viaPrePr = collectBetweenArtifacts({
      artifacts: [art('c', [{ source: 'pre_pr', head_sha: 'sha-in-range' }])],
      revListShas,
      ref2LocalBranch: null,
    });
    expect(viaPrePr.matched.map((m) => m.id)).toEqual(['c']);
  });

  it('surfaces lineage-matching zero-sha artifacts as candidates ONLY for a branch ref2', () => {
    const artifacts = [art('rebased', [{ source: 'checkpoint', n: 1, head_sha: 'gone-sha' }])];
    const withBranch = collectBetweenArtifacts({
      artifacts,
      revListShas: new Set(['other']),
      ref2LocalBranch: 'main',
    });
    expect(withBranch.matched).toEqual([]);
    expect(withBranch.unmatched_candidates).toEqual([
      {
        id: 'rebased',
        label: 'label-rebased',
        branch: 'main',
        reason: 'no_head_sha_in_range',
        origin: null,
      },
    ]);

    // Tag/sha ref2 → no candidates bucket.
    const withTag = collectBetweenArtifacts({
      artifacts,
      revListShas: new Set(['other']),
      ref2LocalBranch: null,
    });
    expect(withTag.unmatched_candidates).toEqual([]);

    // Lineage-foreign artifacts never become candidates.
    const foreign = collectBetweenArtifacts({
      artifacts: [
        art('elsewhere', [{ source: 'checkpoint', n: 1, head_sha: 'gone-sha' }], {
          lineageBranches: ['feat/other'],
        }),
      ],
      revListShas: new Set(['other']),
      ref2LocalBranch: 'main',
    });
    expect(foreign.unmatched_candidates).toEqual([]);
  });

  it('a matched artifact is never also a candidate; matched order is started_at desc', () => {
    const out = collectBetweenArtifacts({
      artifacts: [
        art('older', [{ source: 'checkpoint', n: 1, head_sha: 'in-range' }], {
          started_at: '2026-06-01T00:00:00.000Z',
        }),
        art('newer', [{ source: 'summary', head_sha: 'in-range' }], {
          started_at: '2026-07-01T00:00:00.000Z',
        }),
      ],
      revListShas: new Set(['in-range']),
      ref2LocalBranch: 'main',
    });
    expect(out.matched.map((m) => m.id)).toEqual(['newer', 'older']);
    expect(out.unmatched_candidates).toEqual([]);
  });
});
