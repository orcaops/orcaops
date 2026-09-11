import { describe, expect, it } from 'vitest';

import { DEFAULT_THRESHOLDS } from './liveness.js';
import { attentionRows, deriveSteps, reclassify } from './presenters.js';
import type { AgentState, WatchProject, WatchSnapshot, WatchThread } from './types.js';

function agent(
  over: Partial<WatchThread> & { artifactId: string; state: AgentState }
): WatchThread {
  return {
    version: '1:retained',
    artifactStatus: 'active',
    branch: 'b',
    openComments: 0,
    isCurrentCheckout: true,
    title: 't',
    agent: 'claude-code',
    sessions: [],
    openCheckpoints: 0,
    currentLine: null,
    steps: null,
    lastWriteMs: 1_000,
    startedAtMs: null,
    lastClosed: null,
    sparkline: [],
    planSteps: [],
    planDecisions: [],
    nonGoals: [],
    checkpoints: [],
    recentEvents: [],
    omittedEvents: 0,
    activityWindowComplete: true,
    ...over,
  };
}

function project(threads: WatchThread[]): WatchProject {
  return {
    projectId: 'p',
    displayName: 'proj',
    authorityKey: 'store',
    writeSequence: 1,
    state: 'current',
    completeness: { complete: true, issues: [] },
    threads,
  };
}

function snap(projects: WatchProject[]): WatchSnapshot {
  return {
    generated_at: '2030-01-01T00:00:00.000Z',
    generatedAtMs: 100_000,
    dataRoot: '/d',
    rootKey: 'root',
    state: 'current',
    completeness: { complete: true, issues: [] },
    totals: { activeThreads: 0, openCheckpoints: 0, sessionTokens: 0, usageStatus: 'exact' },
    projects,
    ticker: [],
  };
}

describe('deriveSteps', () => {
  it('marks done (closed-claimed) and current (open-declared)', () => {
    const steps = [
      { idx: 1, text: 's1', label: 'step one', step_id: 'a' },
      { idx: 2, text: 's2', step_id: 'b' },
      { idx: 3, text: 's3', step_id: 'c' },
    ];
    expect(deriveSteps(steps, new Set(['a']), new Set(['b']))).toEqual([
      { idx: 1, text: 's1', label: 'step one', done: true, current: false },
      { idx: 2, text: 's2', label: 's2', done: false, current: true },
      { idx: 3, text: 's3', label: 's3', done: false, current: false },
    ]);
  });
});

describe('attentionRows', () => {
  it('pins stalled before ready, oldest first', () => {
    const snapshot = snap([
      project([
        agent({ artifactId: 'w', state: 'working', lastWriteMs: 9_000 }),
        agent({ artifactId: 'r', state: 'ready', lastWriteMs: 5_000 }),
        agent({ artifactId: 's', state: 'stalled', lastWriteMs: 1_000 }),
      ]),
    ]);
    expect(attentionRows(snapshot).map((row) => row.thread.artifactId)).toEqual(['s', 'r']);
  });
});

describe('reclassify', () => {
  it('recomputes state over a fresh now', () => {
    const snapshot = snap([
      project([agent({ artifactId: 'a', state: 'working', openCheckpoints: 1, lastWriteMs: 0 })]),
    ]);
    expect(reclassify(snapshot, 0, DEFAULT_THRESHOLDS).projects[0].threads[0].state).toBe(
      'working'
    );
    expect(reclassify(snapshot, 11 * 60_000, DEFAULT_THRESHOLDS).projects[0].threads[0].state).toBe(
      'stalled'
    );
  });
});
