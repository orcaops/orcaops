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
    steps: [{ idx: 1, label: 'Redesign the artifact detail' }],
    linesAdded: 128,
    linesRemoved: 21,
    filesChanged: 4,
    ...overrides,
  };
}

const SCOPE = { kind: 'project', project_id: 'project-1' } as const;
const BASIS = { scope: SCOPE, mode: 'current', knowledge_boundary: 42 } as const;

/** One adopted rule that governs, selected by the plan in view. */
function knowledgeBlock(): NonNullable<WatchThread['knowledge']> {
  return {
    basis: BASIS,
    entries: [
      {
        key: 'requirement:requirement-offline',
        target: { kind: 'requirement', entity_id: 'requirement-offline' },
        placement: 'applicable',
        reason: 'Adopted in the project, and its applicability holds here.',
        governing_revision_ids: ['requirement-offline-r2'],
        statement: 'Local capture works with no Cloud connection.',
        revisions: [
          {
            revision_id: 'requirement-offline-r2',
            standing: 'adopted',
            applicability: 'applies',
            statement: 'Local capture works with no Cloud connection.',
            is_tip: true,
          },
        ],
        selected_with_plan: [
          {
            artifact_id: 'artifact-a',
            plan_event_id: 'plan-event-1',
            revision_id: 'requirement-offline-r2',
            role: 'implement',
            step_id: null,
            criterion_id: null,
            discovered_at: null,
          },
        ],
        connected_later: [],
      },
    ],
    applicable: ['requirement:requirement-offline'],
    background: [],
    applicable_not_selected: {
      basis: BASIS,
      artifact_id: 'artifact-a',
      plan_event_id: 'plan-event-1',
      entries: [
        {
          key: 'requirement:requirement-offline',
          target: { kind: 'requirement', entity_id: 'requirement-offline' },
          revision_ids: ['requirement-offline-r2'],
          selected_revision_ids: [],
          statement: 'Local capture works with no Cloud connection.',
          reason: 'This plan records no use of it.',
        },
      ],
      limits: [],
      statement: '1 of 1 applicable entr(y/ies) are not selected by plan event plan-event-1.',
    },
    later_annotations: [],
    coverage: {
      processing: null,
      statement: 'The processing state was not read here, so this answer claims no completeness.',
    },
    limits: [],
  };
}

function thread(id: string, overrides: Partial<WatchThread> = {}): WatchThread {
  return {
    artifactId: id,
    artifactStatus: 'active',
    branch: 'feature/demo-detail',
    title: 'Refine the demo artifact detail presentation end to end',
    agent: 'codex',
    sessions: [{ agent: 'codex', session_id: `session-${id}`, status: 'exact', tokens: 12_345 }],
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
        idx: 1,
        text: 'Redesign the artifact detail without changing captured semantics',
        label: 'Redesign artifact detail',
        done: true,
        current: false,
      },
      {
        idx: 2,
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
    knowledge: null,
    knowledgeUnavailable: null,
    recentEvents: [
      {
        tsMs: 1000,
        ts: '1970-01-01T00:00:01.000Z',
        type: 'checkpoint_closed',
        project: 'orcaops',
        branch: 'feature/demo-detail',
      },
    ],
    version: '1:retained',
    omittedEvents: 0,
    activityWindowComplete: true,
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

  it('numbers plan steps from the captured step index', () => {
    const copy = buildDetail(thread('artifact-a'), new Set(), 96)
      .lines.map((line) => line.text)
      .join('\n');
    expect(copy).toContain('✓ 1. Redesign artifact detail');
    expect(copy).toContain('▸ 2. Retain task navigation');
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

  it('shows what stands beside the guardrails, with the boundary it was read at', () => {
    const copy = buildDetail(thread('artifact-a', { knowledge: knowledgeBlock() }), new Set(), 96)
      .lines.map((line) => line.text)
      .join('\n');
    expect(copy).toContain('KNOWLEDGE · 1 applicable · at write sequence 42');
    expect(copy).toContain('Local capture works with no Cloud');
    expect(copy).toContain('rev requirement-offline-r2');
    expect(copy).toContain('1 selected with the plan');
    expect(copy).toContain('1 of 1 applicable');
  });

  /**
   * The coverage line is what keeps an empty answer from reading as "no rules bear on this work".
   * A pane that dropped it would say nothing at all about processing that has interpreted nothing.
   */
  it('prints the coverage claim even when the answer carries no entry', () => {
    const empty = knowledgeBlock();
    const copy = buildDetail(
      thread('artifact-a', {
        knowledge: {
          ...empty,
          entries: [],
          applicable: [],
          applicable_not_selected: { ...empty.applicable_not_selected, entries: [] },
        },
      }),
      new Set(),
      96
    )
      .lines.map((line) => line.text)
      .join('\n');
    expect(copy).toContain('KNOWLEDGE · 0 applicable');
    expect(copy).toContain('claims no completeness');
    expect(copy).not.toContain('no requirements');
  });

  it('prints what the block left out, so a cut rule is never silent', () => {
    const block = knowledgeBlock();
    const copy = buildDetail(
      thread('artifact-a', {
        knowledge: {
          ...block,
          limits: [
            {
              kind: 'identity_count',
              detail: '3 identit(y/ies) were left out: requirement:requirement-import.',
            },
          ],
        },
      }),
      new Set(),
      96
    )
      .lines.map((line) => line.text)
      .join('\n');

    expect(copy).toContain('3 identit(y/ies) were left out');
    expect(copy).toContain('requirement:requirement-import');
  });

  /**
   * A project holding no continuing record renders the section with a coverage line. A read that
   * failed must not render as that: a locked or older-schema store would read as "nothing bears
   * on this work".
   */
  it('says the knowledge read failed rather than dropping the section', () => {
    const copy = buildDetail(
      thread('artifact-a', { knowledge: null, knowledgeUnavailable: 'UPGRADE_REQUIRED' }),
      new Set(),
      96
    )
      .lines.map((line) => line.text)
      .join('\n');

    expect(copy).toContain('KNOWLEDGE');
    expect(copy).toContain('knowledge unavailable: UPGRADE_REQUIRED');
  });

  it('leaves the section out for a thread whose knowledge was never read', () => {
    const copy = buildDetail(
      thread('artifact-a', { knowledge: null, knowledgeUnavailable: null }),
      new Set(),
      96
    )
      .lines.map((line) => line.text)
      .join('\n');

    expect(copy).not.toContain('KNOWLEDGE');
  });

  it('counts recent-activity sessions by agent and session id', () => {
    const detail = buildDetail(
      thread('artifact-a', {
        sessions: [
          { agent: 'codex', session_id: 'shared-id', status: 'exact', tokens: 1_000 },
          { agent: 'claude-code', session_id: 'shared-id', status: 'exact', tokens: 2_000 },
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
