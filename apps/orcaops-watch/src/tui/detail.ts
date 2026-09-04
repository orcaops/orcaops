import type { WatchTask, WatchThread } from '@orcaops/watch-data/ui';

import { type EventFamily, eventFamily, eventLabel } from './eventPresentation';
import { displayLen, truncate } from './layout';
import { fmtLocalTime } from './time';

export type DetailTone =
  | 'section'
  | 'step-done'
  | 'step-current'
  | 'step-todo'
  | 'cp'
  | 'cp-open'
  | 'detail'
  | 'decision'
  | 'reason'
  | 'alt'
  | 'guardrail'
  | 'question'
  | 'ev-checkpoint'
  | 'ev-plan'
  | 'ev-summary'
  | 'ev-other'
  | 'blank';

/** Colour lane for an event line — the central mapping's family, as a tone. */
const FAMILY_TONE: Record<EventFamily, DetailTone> = {
  checkpoint: 'ev-checkpoint',
  plan: 'ev-plan',
  summary: 'ev-summary',
  other: 'ev-other',
};

function eventTone(type: string): DetailTone {
  return FAMILY_TONE[eventFamily(type)];
}

export type DetailAction = 'expand' | 'collapse' | 'open';

/** A stable selectable target in an artifact or task overview. */
export interface DetailRef {
  id: string;
  kind: 'step' | 'checkpoint' | 'decision' | 'thread';
  /** Checkpoint number, for `kind: 'checkpoint'` (used to push the drill-in). */
  n?: number;
  /** Thread artifactId, for `kind: 'thread'` (a task member — drills into that thread). */
  threadId?: string;
}

/** One physical row of the artifact overview. Null `ref` means not selectable. */
export interface DetailLine {
  id: string;
  text: string;
  tone: DetailTone;
  ref: string | null;
  /** Present only on the first physical row of an actionable block. */
  action?: DetailAction;
}

/** Structured task-member presentation. The component never parses a formatted line. */
export interface TaskMemberPresentation {
  id: string;
  threadId: string;
  thread: WatchThread;
}

export interface TaskDetailModel {
  members: TaskMemberPresentation[];
  refs: DetailRef[];
}

const ATTENTION_RANK: Record<WatchThread['state'], number> = {
  stalled: 0,
  ready: 1,
  wrapping: 2,
  working: 3,
  starting: 4,
  quiet: 5,
  idle: 6,
  done: 7,
};

/** Current checkout first, then actionable state, recency, and stable identity. */
export function compareTaskMembers(a: WatchThread, b: WatchThread): number {
  if (a.isCurrentCheckout !== b.isCurrentCheckout) return a.isCurrentCheckout ? -1 : 1;
  const state = ATTENTION_RANK[a.state] - ATTENTION_RANK[b.state];
  if (state !== 0) return state;
  const recency =
    (b.lastWriteMs ?? Number.NEGATIVE_INFINITY) - (a.lastWriteMs ?? Number.NEGATIVE_INFINITY);
  if (recency !== 0) return recency;
  return a.artifactId.localeCompare(b.artifactId);
}

/** Build the task overview without flattening member identity or metrics into text. */
export function buildTaskDetail(task: WatchTask): TaskDetailModel {
  const members = [...task.threads].sort(compareTaskMembers).map((thread) => ({
    id: `thread:${thread.artifactId}`,
    threadId: thread.artifactId,
    thread,
  }));
  return {
    members,
    refs: members.map((member) => ({
      id: member.id,
      kind: 'thread' as const,
      threadId: member.threadId,
    })),
  };
}

/** First physical row for a task member inside TaskDetailPane's scroll stream. */
export function taskMemberRefLine(model: TaskDetailModel, ref: string): number {
  const index = model.members.findIndex((member) => member.id === ref);
  // Rendered stride is FOUR rows per member: the 3-row card plus the 1-row
  // spacer TaskDetailPane places before every non-first card; line 0 is the
  // THREADS header. Pinned against the real render by
  // review/taskDetailGeometry.render.test.tsx.
  return index < 0 ? 0 : 1 + index * 4;
}

/**
 * Greedy code-point wrapping that also splits long unbroken tokens. Every output
 * row is guaranteed to fit `width`; continuation rows receive `cont` once.
 */
export function wrapDetailText(body: string, width: number, prefix = '', cont = ''): string[] {
  const firstWidth = Math.max(1, width - displayLen(prefix));
  const continuationWidth = Math.max(1, width - displayLen(cont));
  const words = body.split(/\s+/).filter(Boolean);
  const rows: string[] = [];
  let current = '';
  let limit = firstWidth;

  const flush = (): void => {
    if (current.length === 0) return;
    rows.push(current);
    current = '';
    limit = continuationWidth;
  };

  for (const originalWord of words) {
    let word = originalWord;
    const joined = current ? `${current} ${word}` : word;
    if (displayLen(joined) <= limit) {
      current = joined;
      continue;
    }
    flush();
    while (displayLen(word) > limit) {
      const chars = [...word];
      rows.push(chars.slice(0, limit).join(''));
      word = chars.slice(limit).join('');
      limit = continuationWidth;
    }
    current = word;
  }
  flush();
  if (rows.length === 0) rows.push('');
  return rows.map((row, index) => `${index === 0 ? prefix : cont}${row}`);
}

function fitRow(prefix: string, label: string, suffix: string, width: number): string {
  const labelWidth = width - displayLen(prefix) - displayLen(suffix);
  if (labelWidth >= 3) return `${prefix}${truncate(label, labelWidth)}${suffix}`;
  return truncate(`${prefix}${label}${suffix}`, width);
}

function uniqueId(base: string, seen: Map<string, number>): string {
  const occurrence = seen.get(base) ?? 0;
  seen.set(base, occurrence + 1);
  return occurrence === 0 ? base : `${base}:${occurrence}`;
}

/**
 * Build a width-safe artifact overview. Expanded rows retain the selectable
 * block's stable id, so selection and disclosure survive inserted siblings.
 */
export function buildDetail(
  thread: WatchThread,
  expanded: ReadonlySet<string>,
  width: number
): { lines: DetailLine[]; refs: DetailRef[] } {
  const safeWidth = Math.max(8, width);
  const lines: DetailLine[] = [];
  const refs: DetailRef[] = [];
  const seenIds = new Map<string, number>();
  const seenLineIds = new Map<string, number>();
  const push = (
    text: string,
    tone: DetailTone,
    ref: string | null = null,
    action?: DetailAction
  ): void => {
    lines.push({
      id: uniqueId(`line:${ref ?? tone}:${text}`, seenLineIds),
      text: truncate(text, safeWidth),
      tone,
      ref,
      ...(action === undefined ? {} : { action }),
    });
  };
  const pushWrapped = (
    body: string,
    tone: DetailTone,
    ref: string | null,
    prefix: string,
    cont: string
  ): void => {
    for (const row of wrapDetailText(body, safeWidth, prefix, cont)) push(row, tone, ref);
  };

  // Which closed cp first claimed each step idx (for the "completed in cp N" note).
  const cpByStep = new Map<number, number>();
  for (const cp of thread.checkpoints) {
    if (cp.status === 'closed') {
      for (const step of cp.steps) if (!cpByStep.has(step.idx)) cpByStep.set(step.idx, cp.n);
    }
  }

  // Open review comments lead the pane, with the paste-ready prompt for an agent.
  if (thread.openComments > 0) {
    const n = thread.openComments;
    push(`REVIEW COMMENTS · ${n} open`, 'section');
    const prompt = `address the ${n} open review comment${n === 1 ? '' : 's'} on ${thread.branch}`;
    pushWrapped(`Paste to your agent: “${prompt}”`, 'detail', null, '  ✎ ', '    ');
    push('', 'blank');
  }

  if (thread.planSteps.length > 0) {
    const done = thread.planSteps.filter((step) => step.done).length;
    push(`PLAN · ${done}/${thread.planSteps.length} complete`, 'section');
    for (const step of thread.planSteps) {
      const id = uniqueId(`step:${step.label}:${step.text}`, seenIds);
      const action: DetailAction = expanded.has(id) ? 'collapse' : 'expand';
      refs.push({ id, kind: 'step' });
      const glyph = step.done ? '✓' : step.current ? '▸' : '○';
      const tone: DetailTone = step.done
        ? 'step-done'
        : step.current
          ? 'step-current'
          : 'step-todo';
      push(fitRow(`  ${glyph} ${step.idx + 1}. `, step.label, '', safeWidth), tone, id, action);
      if (expanded.has(id)) {
        pushWrapped(step.text, 'detail', id, '      ', '      ');
        const cpN = cpByStep.get(step.idx);
        if (cpN !== undefined) push(`      ↳ completed in checkpoint ${cpN}`, 'detail', id);
      }
    }
  }

  if (thread.checkpoints.length > 0) {
    if (lines.length > 0) push('', 'blank');
    const open = thread.checkpoints.filter((cp) => cp.status === 'open').length;
    push(
      `CHECKPOINTS · ${thread.checkpoints.length}${open > 0 ? ` · ${open} open` : ''}`,
      'section'
    );
    for (const cp of [...thread.checkpoints].sort((a, b) => a.n - b.n)) {
      const id = `checkpoint:${cp.n}`;
      refs.push({ id, kind: 'checkpoint', n: cp.n });
      const diff =
        cp.linesAdded !== null && cp.linesRemoved !== null
          ? ` · +${cp.linesAdded}/-${cp.linesRemoved}`
          : '';
      const badges = `${cp.decisions.length > 0 ? ` · ${cp.decisions.length}D` : ''}${
        cp.uncertainties.length > 0 ? ` · ${cp.uncertainties.length}?` : ''
      }`;
      const suffix = ` · ${cp.status}${diff}${badges}`;
      const label = cp.summary ?? cp.steps[0]?.label ?? '(awaiting summary)';
      const tone: DetailTone = cp.status === 'open' ? 'cp-open' : 'cp';
      push(
        fitRow(`  ${cp.status === 'open' ? '◉' : '●'} cp ${cp.n} · `, label, suffix, safeWidth),
        tone,
        id,
        'open'
      );
    }
  }

  const questions = thread.checkpoints.flatMap((cp) =>
    cp.uncertainties.map((uncertainty) => ({ cp: cp.n, uncertainty }))
  );
  if (questions.length > 0) {
    if (lines.length > 0) push('', 'blank');
    push(`RECORDED UNCERTAINTIES · ${questions.length}`, 'section');
    for (const question of questions) {
      pushWrapped(
        question.uncertainty,
        'question',
        null,
        `  ? cp ${question.cp} · `,
        '           '
      );
    }
  }

  const decisions = [
    ...thread.planDecisions.map((decision) => ({ decision, origin: 'plan' })),
    ...thread.checkpoints.flatMap((cp) =>
      cp.decisions.map((decision) => ({ decision, origin: `cp ${cp.n}` }))
    ),
  ];
  if (decisions.length > 0) {
    if (lines.length > 0) push('', 'blank');
    push(`DECISIONS · ${decisions.length}`, 'section');
    for (const { decision, origin } of decisions) {
      const id = uniqueId(`decision:${origin}:${decision.decision}`, seenIds);
      const action: DetailAction = expanded.has(id) ? 'collapse' : 'expand';
      refs.push({ id, kind: 'decision' });
      push(fitRow('  → ', decision.decision, ` · ${origin}`, safeWidth), 'decision', id, action);
      if (expanded.has(id)) {
        pushWrapped(decision.reason, 'reason', id, '     — ', '       ');
        for (const alternative of decision.alternatives ?? []) {
          pushWrapped(
            `${alternative.option} — ${alternative.reason}`,
            'alt',
            id,
            '     × ',
            '       '
          );
        }
      }
    }
  }

  if (thread.nonGoals.length > 0) {
    if (lines.length > 0) push('', 'blank');
    push(
      `GUARDRAILS · ${thread.nonGoals.length} non-goal${thread.nonGoals.length === 1 ? '' : 's'}`,
      'section'
    );
    for (const nonGoal of thread.nonGoals) {
      pushWrapped(nonGoal, 'guardrail', null, '  – ', '    ');
    }
  }

  if (thread.recentEvents.length > 0) {
    if (lines.length > 0) push('', 'blank');
    const sessions = new Set(
      thread.sessions.map((session) => `${session.agent}:${session.session_id}`)
    ).size;
    push(sessions > 1 ? `RECENT ACTIVITY · ${sessions} sessions` : 'RECENT ACTIVITY', 'section');
    for (const event of thread.recentEvents) {
      const prefix = `  ${fmtLocalTime(event.tsMs)}  `;
      push(fitRow(prefix, eventLabel(event.type), '', safeWidth), eventTone(event.type));
    }
  }

  if (lines.length === 0) push('No plan, checkpoints, decisions, or activity yet.', 'detail');
  return { lines, refs };
}

/** The physical row where a ref's first line sits (for scroll-follow). */
export function detailRefLine(lines: readonly DetailLine[], ref: string): number {
  const index = lines.findIndex((line) => line.ref === ref);
  return index < 0 ? 0 : index;
}
