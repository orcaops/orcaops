import { describe, expect, it } from 'vitest';

import {
  navOrder,
  navRows,
  railGroups,
  railSelectionAnchor,
  resolveRailSelection,
  statusCounts,
} from './viewModel';
import type { AgentState, WatchSnapshot, WatchThread } from '../data/types';

function thread(id: string, state: AgentState, lastWriteMs = 1000): WatchThread {
  return {
    artifactId: id,
    artifactStatus: 'active' as WatchThread['artifactStatus'],
    source: 'archive',
    branch: `branch-${id}`,
    openComments: 0,
    isCurrentCheckout: false,
    title: `task ${id}`,
    agent: 'claude-code',
    sessions: [],
    openCheckpoints: state === 'stalled' ? 1 : 0,
    currentLine: null,
    steps: null,
    lastWriteMs,
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

function snapshot(): WatchSnapshot {
  return {
    generated_at: '2026-07-05T00:00:00.000Z',
    generatedAtMs: 10_000,
    dataRoot: '/x',
    archiveEnabled: true,
    totals: { activeThreads: 2, openCheckpoints: 1, sessionTokens: 0 },
    projects: [
      {
        projectId: 'A',
        displayName: 'alpha',
        threads: [thread('a1', 'stalled', 100), thread('a2', 'working')],
      },
      {
        projectId: 'B',
        displayName: 'beta',
        threads: [thread('b1', 'ready', 200), thread('b2', 'idle')],
      },
    ],
    ticker: [],
  };
}

describe('railGroups', () => {
  it('project mode (default): pins NEEDS ATTENTION first, then per-project groups', () => {
    const groups = railGroups(snapshot());
    expect(groups[0]?.tone).toBe('attention');
    // stalled sorts before ready, and attention threads are lifted out of projects
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['a1', 'b1']);
    const projectGroups = groups.filter((g) => g.tone === 'project');
    expect(projectGroups.map((g) => g.title)).toEqual(['alpha', 'beta']);
    // attention threads are not repeated in their project groups
    expect(projectGroups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(['a2', 'b2']);
  });

  it('none mode: attention pinned, then one flat THREADS group', () => {
    const groups = railGroups(snapshot(), { groupBy: 'none' });
    expect(groups.map((g) => g.tone)).toEqual(['attention', 'flat']);
    expect(groups[1]?.title).toBe('THREADS');
    // every non-attention thread, projects in sorted order
    expect(groups[1]?.rows.map((r) => r.id)).toEqual(['a2', 'b2']);
    expect(navOrder(groups)).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('task mode: clusters same-branch non-default threads; default branch stays loose', () => {
    const t = (id: string, state: AgentState, branch: string): WatchThread => ({
      ...thread(id, state),
      branch,
    });
    const snap: WatchSnapshot = {
      ...snapshot(),
      projects: [
        {
          projectId: 'A',
          displayName: 'alpha',
          threads: [
            t('w1', 'working', 'feat/x'),
            t('w2', 'idle', 'feat/x'),
            t('m1', 'working', 'main'),
          ],
        },
      ],
    };
    const groups = railGroups(snap, { groupBy: 'task' });
    const alpha = groups.find((g) => g.title === 'alpha');
    // one task row (feat/x, 2 members) then one loose thread row (main)
    expect(alpha?.rows.map((r) => r.kind)).toEqual(['task', 'thread']);
    const taskRow = alpha?.rows[0];
    expect(taskRow?.kind).toBe('task');
    if (taskRow?.kind === 'task') {
      expect(taskRow.task.branch).toBe('feat/x');
      expect(taskRow.task.threads).toHaveLength(2);
    }
    const looseRow = alpha?.rows[1];
    expect(looseRow?.kind === 'thread' && looseRow.thread.branch).toBe('main');
  });

  it('task mode keeps attention-pinned members inside the full task rollup', () => {
    const ready = { ...thread('ready', 'ready'), branch: 'feat/x' };
    const working = { ...thread('working', 'working'), branch: 'feat/x' };
    const snap: WatchSnapshot = {
      ...snapshot(),
      projects: [
        {
          projectId: 'A',
          displayName: 'alpha',
          threads: [ready, working],
        },
      ],
    };
    const groups = railGroups(snap, { groupBy: 'task' });
    expect(groups[0]?.tone).toBe('attention');
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(['ready']);
    const task = groups.flatMap((group) => group.rows).find((row) => row.kind === 'task');
    expect(task?.kind).toBe('task');
    if (task?.kind === 'task') {
      expect(task.task.threads.map((member) => member.artifactId)).toEqual(['ready', 'working']);
      expect(task.task.state).toBe('ready');
    }
  });

  it('does not leave an empty project group when its only loose thread is pinned', () => {
    const only = { ...thread('ready-main', 'ready'), branch: 'main' };
    const snap: WatchSnapshot = {
      ...snapshot(),
      projects: [
        {
          projectId: 'A',
          displayName: 'alpha',
          threads: [only],
        },
      ],
    };
    const groups = railGroups(snap, { groupBy: 'task' });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.tone).toBe('attention');
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(['ready-main']);
  });

  it('resolves a selected artifact through task grouping and back to the same branch', () => {
    const t = (id: string, branch: string): WatchThread => ({
      ...thread(id, 'working'),
      branch,
    });
    const snap: WatchSnapshot = {
      ...snapshot(),
      projects: [
        {
          projectId: 'A',
          displayName: 'alpha',
          threads: [t('a', 'feat/a'), t('b', 'feat/a'), t('c', 'feat/c')],
        },
      ],
    };
    const projectGroups = railGroups(snap, { groupBy: 'project' });
    const anchor = railSelectionAnchor(navRows(projectGroups), 'b');
    const taskGroups = railGroups(snap, { groupBy: 'task' });
    const taskId = resolveRailSelection(taskGroups, anchor);
    expect(taskId).toBe('task:A:feat/a');

    const retained = railSelectionAnchor(navRows(taskGroups), taskId, anchor);
    expect(retained?.artifactId).toBe('b');
    expect(resolveRailSelection(projectGroups, retained)).toBe('b');
  });

  it('filters by status (working excludes idle/attention)', () => {
    const groups = railGroups(snapshot(), { filter: 'working' });
    expect(navOrder(groups)).toEqual(['a2']); // only the plain working thread
  });

  it('filters by repo', () => {
    const groups = railGroups(snapshot(), { repo: 'beta' });
    expect(groups.every((g) => g.tone === 'attention' || g.title === 'beta')).toBe(true);
    expect(navOrder(groups)).toContain('b1');
    expect(navOrder(groups)).not.toContain('a2');
  });

  it('thread rows carry their project id (the `v` review-target resolver keys off it)', () => {
    const groups = railGroups(snapshot());
    const threadRows = groups.flatMap((g) => g.rows).filter((r) => r.kind === 'thread');
    // a* threads belong to project A, b* to project B (attention rows included).
    for (const row of threadRows) {
      if (row.kind !== 'thread') continue;
      expect(row.projectId).toBe(row.id.startsWith('a') ? 'A' : 'B');
    }
  });
});

describe('statusCounts', () => {
  it('counts each bucket', () => {
    const counts = statusCounts(snapshot());
    expect(counts.all).toBe(4);
    expect(counts.attention).toBe(2);
    expect(counts.ready).toBe(1);
    expect(counts.working).toBe(1); // a2 (b1 ready is not 'working')
    expect(counts.idle).toBe(1);
  });
});
