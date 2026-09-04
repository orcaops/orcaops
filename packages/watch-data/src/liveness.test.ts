import { describe, expect, it } from 'vitest';

import {
  classifyAgent,
  type ClassifyInputs,
  DEFAULT_THRESHOLDS,
  needsAttention,
} from './liveness.js';

const NOW = 1_700_000_000_000;
const T = DEFAULT_THRESHOLDS;

function inputs(over: Partial<ClassifyInputs>): ClassifyInputs {
  return {
    artifactStatus: 'active',
    openCheckpoints: 0,
    lastWriteMs: NOW,
    lastClosed: null,
    ...over,
  };
}

/** Classify an agent whose last write was `ageMs` ago (at NOW). */
function at(ageMs: number, over: Partial<ClassifyInputs> = {}): string {
  return classifyAgent(inputs({ lastWriteMs: NOW - ageMs, ...over }), NOW, T);
}

const UNCERTAIN = {
  closed_at: '2026-01-01T00:00:00.000Z',
  summary: 'did a thing',
  uncertaintyCount: 2,
};
const CLEAN = {
  closed_at: '2026-01-01T00:00:00.000Z',
  summary: 'done',
  uncertaintyCount: 0,
};

describe('classifyAgent — open checkpoint keys off last-write recency', () => {
  it('working <90s, quiet 90s–10m, stalled >10m (boundaries)', () => {
    expect(at(89_000, { openCheckpoints: 1 })).toBe('working');
    expect(at(91_000, { openCheckpoints: 1 })).toBe('quiet');
    expect(at(9 * 60_000 + 59_000, { openCheckpoints: 1 })).toBe('quiet'); // 9m59s
    expect(at(10 * 60_000 + 1_000, { openCheckpoints: 1 })).toBe('stalled'); // 10m01s
  });

  it('a null last-write with an open cp is stalled', () => {
    expect(classifyAgent(inputs({ openCheckpoints: 1, lastWriteMs: null }), NOW, T)).toBe(
      'stalled'
    );
  });
});

describe('classifyAgent — ready is age-independent', () => {
  it('an active artifact with an uncertainty close is ready at 1m AND at 2h', () => {
    expect(at(60_000, { lastClosed: UNCERTAIN })).toBe('ready');
    expect(at(2 * 3_600_000, { lastClosed: UNCERTAIN })).toBe('ready');
  });

  it('a COMPLETED artifact classifies `done` (not idle), age-independent', () => {
    expect(at(2 * 3_600_000, { artifactStatus: 'complete', lastClosed: UNCERTAIN })).toBe('done');
  });

  it('ready clears when a new checkpoint opens (writes resumed)', () => {
    expect(at(60_000, { openCheckpoints: 1, lastClosed: UNCERTAIN })).toBe('working');
  });

  it('ready clears when the artifact is summarized (status no longer active)', () => {
    expect(at(60_000, { artifactStatus: 'complete', lastClosed: UNCERTAIN })).not.toBe('ready');
  });

  it('a summary-less close (uncertaintyCount>0 but empty summary) is not ready', () => {
    expect(
      at(60_000, {
        lastClosed: { closed_at: '2026-01-01T00:00:00.000Z', summary: '   ', uncertaintyCount: 1 },
      })
    ).toBe('wrapping');
  });
});

describe('classifyAgent — terminal status wins (done)', () => {
  it('a complete artifact is done regardless of age, open cp, or uncertainty', () => {
    expect(at(60_000, { artifactStatus: 'complete' })).toBe('done');
    expect(at(10 * 24 * 3_600_000, { artifactStatus: 'complete' })).toBe('done');
    expect(at(60_000, { artifactStatus: 'complete', openCheckpoints: 1 })).toBe('done');
    expect(at(60_000, { artifactStatus: 'complete', lastClosed: UNCERTAIN })).toBe('done');
  });
});

describe('classifyAgent — wrapping vs idle for a clean close', () => {
  it('wrapping within 5m, idle after', () => {
    expect(at(4 * 60_000 + 59_000, { lastClosed: CLEAN })).toBe('wrapping'); // 4m59s
    expect(at(5 * 60_000 + 1_000, { lastClosed: CLEAN })).toBe('idle'); // 5m01s
  });

  it('a null last-write with no open cp and no uncertainty is idle', () => {
    expect(classifyAgent(inputs({ lastWriteMs: null }), NOW, T)).toBe('idle');
  });
});

describe('classifyAgent — starting: freshly planned, no checkpoint yet', () => {
  it('a just-planned artifact (no close, recent write) is starting, not wrapping', () => {
    expect(at(15_000)).toBe('starting');
  });

  it('starting requires no prior close — a recent write after a close stays wrapping', () => {
    expect(at(15_000, { lastClosed: CLEAN })).toBe('wrapping');
  });

  it('a never-checkpointed artifact goes idle once its write ages past the window', () => {
    expect(at(5 * 60_000 + 1_000)).toBe('idle'); // 5m01s, no close
  });
});

describe('needsAttention', () => {
  it('is true for stalled and ready only', () => {
    expect(needsAttention('stalled')).toBe(true);
    expect(needsAttention('ready')).toBe(true);
    for (const s of ['working', 'quiet', 'starting', 'wrapping', 'idle', 'done'] as const) {
      expect(needsAttention(s)).toBe(false);
    }
  });
});
