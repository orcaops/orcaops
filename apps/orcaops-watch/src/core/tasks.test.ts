import { describe, expect, it } from 'vitest';

import { deriveTasks, isDefaultBranch, rollupState } from './tasks.js';
import type { AgentState, WatchProject, WatchThread } from './types.js';

function thread(id: string, branch: string, state: AgentState): WatchThread {
  return {
    artifactId: id,
    artifactStatus: 'active' as WatchThread['artifactStatus'],
    source: 'archive',
    branch,
    openComments: 0,
    isCurrentCheckout: false,
    title: `title ${id}`,
    agent: 'claude-code',
    sessions: [],
    openCheckpoints: 0,
    currentLine: null,
    steps: null,
    lastWriteMs: 1000,
    lastClosed: null,
    state,
    sparkline: [],
    planSteps: [],
    checkpoints: [],
    startedAtMs: null,
    planDecisions: [],
    nonGoals: [],
    recentEvents: [],
  };
}

function project(threads: WatchThread[]): WatchProject {
  return { projectId: 'P', displayName: 'proj', threads };
}

describe('isDefaultBranch', () => {
  it('treats main/master (any case, trimmed) as default', () => {
    expect(isDefaultBranch('main')).toBe(true);
    expect(isDefaultBranch('master')).toBe(true);
    expect(isDefaultBranch('MAIN')).toBe(true);
    expect(isDefaultBranch(' main ')).toBe(true);
  });
  it('treats feature branches as non-default', () => {
    expect(isDefaultBranch('feat/x')).toBe(false);
    expect(isDefaultBranch('watch-tui')).toBe(false);
  });
});

describe('rollupState', () => {
  it('picks the highest-urgency member state', () => {
    expect(rollupState([thread('a', 'x', 'working'), thread('b', 'x', 'idle')])).toBe('working');
    expect(rollupState([thread('a', 'x', 'stalled'), thread('b', 'x', 'working')])).toBe('stalled');
    expect(rollupState([thread('a', 'x', 'ready'), thread('b', 'x', 'idle')])).toBe('ready');
    expect(rollupState([thread('a', 'x', 'done'), thread('b', 'x', 'done')])).toBe('done');
  });
  it('is idle for no members', () => {
    expect(rollupState([])).toBe('idle');
  });
});

describe('deriveTasks', () => {
  it('clusters non-default branches into tasks and leaves default-branch threads loose', () => {
    const { tasks, loose } = deriveTasks(
      project([
        thread('a1', 'feat/x', 'working'),
        thread('a2', 'feat/x', 'idle'),
        thread('m1', 'main', 'working'),
      ])
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.branch).toBe('feat/x');
    expect(tasks[0]?.threads).toHaveLength(2);
    expect(tasks[0]?.state).toBe('working'); // rollup across members
    expect(tasks[0]?.id).toBe('task:P:feat/x');
    expect(tasks[0]?.title).toBe('feat/x');
    expect(loose.map((t) => t.artifactId)).toEqual(['m1']);
  });

  it('forms a task even for a single-thread feature branch', () => {
    const { tasks, loose } = deriveTasks(project([thread('a1', 'feat/solo', 'ready')]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.threads).toHaveLength(1);
    expect(loose).toHaveLength(0);
  });

  it('orders tasks by branch', () => {
    const { tasks } = deriveTasks(
      project([thread('a', 'feat/z', 'idle'), thread('b', 'feat/a', 'idle')])
    );
    expect(tasks.map((t) => t.branch)).toEqual(['feat/a', 'feat/z']);
  });
});
