import { describe, expect, it } from 'vitest';

import type { WatchCheckpoint, WatchTask, WatchThread } from '@orcaops/watch-data/ui';

import {
  buildDetail,
  buildTaskDetail,
  compareTaskMembers,
  detailRefLine,
  taskMemberRefLine,
  wrapDetailText,
} from './detail';
import { displayLen } from './layout';

function checkpoint(overrides: Partial<WatchCheckpoint> = {}): WatchCheckpoint {
  return {
    n: 2,
    status: 'closed',
    summary: 'Implemented the stable artifact detail hierarchy',
    uncertainties: ['Whether the terminal reports a viewport during its first layout pass'],
    decisions: [
      {
        decision: 'Use stable presentation identifiers',
        reason: 'Polling can insert or reorder captured records.',
        alternatives: [{ option: 'Array indexes', reason: 'They silently retarget selection.' }],
      },
    ],
    steps: [{ idx: 0, label: 'Redesign the artifact detail' }],
    linesAdded: 128,
    linesRemoved: 21,
    filesChanged: 4,
    ...overrides,
  };
}

function thread(id: string, overrides: Partial<WatchThread> = {}): WatchThread {
  return {
    artifactId: id,
    artifactStatus: 'active',
    source: 'hot',
    branch: 'feature/demo-detail',
    title: 'Refine the demo artifact detail presentation end to end',
    agent: 'codex',
    sessions: [{ agent: 'codex', session_id: `session-${id}`, tokens: 12_345 }],
    openCheckpoints: 0,
    openComments: 2,
    isCurrentCheckout: false,
    currentLine: 'Refine the task to thread journey',
    steps: { completed: 1, total: 3 },
    lastWriteMs: 1000,
    lastClosed: null,
    state: 'working',
    sparkline: [0, 1, 3],
    planSteps: [
      {
        idx: 0,
        text: 'Redesign the artifact detail without changing captured semantics',
        label: 'Redesign artifact detail',
        done: true,
        current: false,
      },
      {
        idx: 1,
        text: 'Make task member navigation retain its exact place',
        label: 'Retain task navigation',
        done: false,
        current: true,
      },
    ],
    checkpoints: [checkpoint()],
    startedAtMs: 0,
    planDecisions: [
      {
        decision: 'Keep the Watch data model intact',
        reason: 'This is a presentation and interaction pass.',
        alternatives: [{ option: 'Replace the snapshot', reason: 'It would be destructive.' }],
      },
    ],
    nonGoals: ['Do not replace capture, storage, or artifact lifecycle behavior'],
    recentEvents: [
      {
        tsMs: 1000,
        ts: '1970-01-01T00:00:01.000Z',
        type: 'checkpoint_closed',
        project: 'orcaops',
        branch: 'feature/demo-detail',
      },
    ],
    ...overrides,
  };
}

describe('artifact detail presentation', () => {
  it('surfaces guardrails, questions, provenance, and rejected alternatives', () => {
    const artifact = thread('artifact-a');
    const collapsed = buildDetail(artifact, new Set(), 96);
    const decision = collapsed.refs.find(
      (ref) => ref.kind === 'decision' && ref.id.includes('Keep the Watch data model intact')
    );
    expect(decision).toBeDefined();

    const expanded = buildDetail(artifact, new Set([decision!.id]), 96);
    const copy = expanded.lines.map((line) => line.text).join('\n');
    expect(copy).toContain('RECORDED UNCERTAINTIES · 1');
    expect(copy).toContain('? cp 2');
    expect(copy).toContain('GUARDRAILS · 1 non-goal');
    expect(copy).toContain('Do not replace capture');
    expect(copy).toContain('· plan');
    expect(copy).toContain('Replace the snapshot');
  });

  it('keeps selection ids stable when a sibling step is inserted', () => {
    const artifact = thread('artifact-a');
    const before = buildDetail(artifact, new Set(), 80);
    const checkpointId = before.refs.find((ref) => ref.kind === 'checkpoint')?.id;
    const decisionId = before.refs.find(
      (ref) => ref.kind === 'decision' && ref.id.includes('Keep the Watch data model intact')
    )?.id;

    const after = buildDetail(
      {
        ...artifact,
        planSteps: [
          {
            idx: 99,
            text: 'A newly inserted sibling',
            label: 'Inserted sibling',
            done: false,
            current: false,
          },
          ...artifact.planSteps,
        ],
      },
      new Set(),
      80
    );
    expect(after.refs.some((ref) => ref.id === checkpointId)).toBe(true);
    expect(after.refs.some((ref) => ref.id === decisionId)).toBe(true);
    expect(detailRefLine(after.lines, checkpointId!)).toBeGreaterThan(0);
  });

  for (const width of [24, 36, 80]) {
    it(`never emits a physical overview row wider than ${width} cells`, () => {
      const artifact = thread('artifact-a', {
        checkpoints: [
          checkpoint({
            n: 123_456,
            summary: 'x'.repeat(200),
            linesAdded: 9_999_999,
            linesRemoved: 8_888_888,
          }),
        ],
      });
      const detail = buildDetail(artifact, new Set(), width);
      expect(detail.lines.every((line) => displayLen(line.text) <= width)).toBe(true);
    });
  }

  it('wraps an unbroken token once without duplication or loss', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz';
    const rows = wrapDetailText(token, 7);
    expect(rows.every((row) => displayLen(row) <= 7)).toBe(true);
    expect(rows.join('')).toBe(token);
  });

  it('counts recent-activity sessions by agent and session id', () => {
    const detail = buildDetail(
      thread('artifact-a', {
        sessions: [
          { agent: 'codex', session_id: 'shared-id', tokens: 1_000 },
          { agent: 'claude-code', session_id: 'shared-id', tokens: 2_000 },
        ],
      }),
      new Set(),
      80
    );
    expect(detail.lines.map((line) => line.text)).toContain('RECENT ACTIVITY · 2 sessions');
  });
});

describe('task member presentation', () => {
  it('sorts current checkout, actionable state, recency, then stable identity', () => {
    const members = [
      thread('idle', { state: 'idle', lastWriteMs: 500 }),
      thread('ready', { state: 'ready', lastWriteMs: 100 }),
      thread('here', { state: 'working', isCurrentCheckout: true, lastWriteMs: 1 }),
      thread('stalled', { state: 'stalled', lastWriteMs: 50 }),
    ];
    expect([...members].sort(compareTaskMembers).map((member) => member.artifactId)).toEqual([
      'here',
      'stalled',
      'ready',
      'idle',
    ]);
  });

  it('uses the rendered four-row stride (3-row card + spacer) and stable artifact ids', () => {
    const task: WatchTask = {
      id: 'task:orcaops:feature/demo-detail',
      title: 'feature/demo-detail',
      projectId: 'orcaops',
      project: 'orcaops',
      branch: 'feature/demo-detail',
      state: 'working',
      threads: [thread('one'), thread('two', { lastWriteMs: 2000 })],
    };
    const detail = buildTaskDetail(task);
    expect(detail.refs.map((ref) => ref.id)).toEqual(['thread:two', 'thread:one']);
    expect(taskMemberRefLine(detail, 'thread:two')).toBe(1);
    expect(taskMemberRefLine(detail, 'thread:one')).toBe(5);
  });
});
