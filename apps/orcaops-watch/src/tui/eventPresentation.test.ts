// One typed mapping owns the label and color-family presentation of every
// event type, and all three surfaces (Live Events, the detail model, and the
// Detail pane) consume it. EventTypeSchema has no ready/wrap members and
// Retained records accept only EventType, while the ticker carries whatever
// type string it receives, so a foreign or older value reaches
// presentation intact. The neutral fallback is therefore a required guard.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EventTypeSchema } from '@orcaops/storage';
import type { TickerEvent, WatchThread } from '@orcaops/watch-data/ui';

import { buildDetail } from './detail';
import {
  EVENT_FAMILY_THEME,
  EVENT_PRESENTATION,
  eventFamily,
  eventLabel,
} from './eventPresentation';

describe('the typed event-presentation mapping', () => {
  it('covers every EventTypeSchema member (and nothing forces a fallback)', () => {
    for (const type of EventTypeSchema.options) {
      expect(EVENT_PRESENTATION[type], `missing presentation for ${type}`).toBeDefined();
    }
    expect(Object.keys(EVENT_PRESENTATION).sort()).toEqual([...EventTypeSchema.options].sort());
  });

  it('assigns the summary family to exactly the summary event pair', () => {
    const summaryTypes = Object.entries(EVENT_PRESENTATION)
      .filter(([, p]) => p.family === 'summary')
      .map(([type]) => type)
      .sort();
    expect(summaryTypes).toEqual(['pre_pr_checked', 'summary_captured']);
  });

  it('declares CYAN canonical for the summary family (LIVE/ACCENT for the others)', () => {
    expect(EVENT_FAMILY_THEME.summary).toBe('CYAN');
    expect(EVENT_FAMILY_THEME.checkpoint).toBe('LIVE');
    expect(EVENT_FAMILY_THEME.plan).toBe('ACCENT');
  });

  it('uses the past-tense event vocabulary, spelled out for evaluator runs', () => {
    expect(eventLabel('evaluator_run_recorded')).toBe('evaluator run recorded');
    expect(eventLabel('summary_captured')).toBe('summarised');
    expect(eventLabel('pre_pr_checked')).toBe('pre-pr checked');
    expect(eventLabel('checkpoint_abandoned')).toBe('checkpoint abandoned');
  });

  it('has no branch for event types outside the schema — they fall to the fallback', () => {
    // The schema contains no ready/wrap member, so a presentation branch for
    // either would be dead code.
    for (const type of EventTypeSchema.options) {
      expect(type.includes('ready')).toBe(false);
      expect(type.includes('wrap')).toBe(false);
    }
    // A torn/hand-edited log line with an unknown type degrades to the neutral
    // family and an underscores-to-spaces label — never a colored lane.
    expect(eventFamily('ready_for_review')).toBe('other');
    expect(eventLabel('ready_for_review')).toBe('ready for review');
    expect(eventFamily('session_wrap')).toBe('other');
  });
});

function tickerEvent(type: string, atMs: number): TickerEvent {
  return {
    tsMs: atMs,
    ts: new Date(atMs).toISOString(),
    type,
    project: 'orcaops',
    branch: 'feature/demo',
  };
}

function threadWithEvents(recentEvents: TickerEvent[]): WatchThread {
  return {
    artifactId: 'a1',
    artifactStatus: 'active',
    branch: 'feature/demo',
    title: 'Thread a1',
    agent: 'codex',
    sessions: [{ agent: 'codex', session_id: 'session-a1', status: 'exact', tokens: 12_345 }],
    openCheckpoints: 0,
    openComments: 0,
    isCurrentCheckout: false,
    currentLine: 'Working',
    steps: { completed: 0, total: 0 },
    lastWriteMs: recentEvents[0]?.tsMs ?? 0,
    lastClosed: null,
    state: 'working',
    sparkline: [0, 1],
    planSteps: [],
    checkpoints: [],
    startedAtMs: 0,
    planDecisions: [],
    nonGoals: [],
    knowledge: null,
    knowledgeUnavailable: null,
    recentEvents,
    version: '1:retained',
    omittedEvents: 0,
    activityWindowComplete: true,
  };
}

describe('the detail model consumes the mapping', () => {
  it('labels evaluator runs in full and tones the summary family ev-summary', () => {
    const thread = threadWithEvents([
      tickerEvent('summary_captured', 1_722_000_003_000),
      tickerEvent('pre_pr_checked', 1_722_000_002_000),
      tickerEvent('evaluator_run_recorded', 1_722_000_001_000),
    ]);
    const { lines } = buildDetail(thread, new Set(), 120);

    const rowFor = (label: string) => {
      const row = lines.find((line) => line.text.includes(label));
      expect(row, `no detail row for "${label}"`).toBeDefined();
      return row!;
    };
    expect(rowFor('evaluator run recorded').tone).toBe('ev-other');
    expect(rowFor('summarised').tone).toBe('ev-summary');
    expect(rowFor('pre-pr checked').tone).toBe('ev-summary');
  });

  it('produces no ev-ready tone for any schema event type', () => {
    const thread = threadWithEvents(
      EventTypeSchema.options.map((type, at) => tickerEvent(type, 1_722_000_000_000 + at * 1_000))
    );
    const { lines } = buildDetail(thread, new Set(), 120);
    for (const line of lines) {
      expect(line.tone as string).not.toBe('ev-ready');
    }
  });
});

describe('an out-of-schema ticker type reaches the detail model', () => {
  it('degrades it to the neutral tone and a spelled-out label, never a colored lane', () => {
    const thread = threadWithEvents([tickerEvent('ready_for_review', 1_722_000_005_000)]);
    const { lines } = buildDetail(thread, new Set(), 120);
    const row = lines.find((line) => line.text.includes('ready for review'));
    expect(row).toBeDefined();
    expect(row!.tone).toBe('ev-other');
  });
});

describe('consumer wiring (source-level): all three surfaces use the mapping', () => {
  // LiveEvents and DetailPane have no mounted render test, so their wiring is
  // pinned at the source level, using the same contract as the benchmarks.
  const tui = path.resolve(__dirname);
  const liveEvents = readFileSync(path.join(tui, 'components', 'LiveEvents.tsx'), 'utf8');
  const detailPane = readFileSync(path.join(tui, 'components', 'DetailPane.tsx'), 'utf8');
  const detailModel = readFileSync(path.join(tui, 'detail.ts'), 'utf8');

  it('LiveEvents derives color and label from the mapping, with no local branches', () => {
    expect(liveEvents).toContain('EVENT_FAMILY_THEME[family]');
    expect(liveEvents).toContain('eventLabel(event.type)');
    expect(liveEvents).not.toContain('theme.BLUE');
    expect(liveEvents).not.toContain("includes('summar')");
    expect(liveEvents).not.toContain("includes('ready')");
    expect(liveEvents).not.toContain("includes('wrap')");
    expect(liveEvents).not.toContain('HUMAN');
  });

  it('the detail model derives tone from the family record, with no local branches', () => {
    expect(detailModel).toContain('FAMILY_TONE[eventFamily(type)]');
    expect(detailModel).toContain('eventLabel(event.type)');
    expect(detailModel).not.toContain("'ev-ready'");
    expect(detailModel).not.toContain("includes('summar')");
    expect(detailModel).not.toContain("includes('ready')");
    expect(detailModel).not.toContain("includes('wrap')");
  });

  it('DetailPane resolves the three event tones through the canonical tokens', () => {
    expect(detailPane).toContain('EVENT_FAMILY_THEME.checkpoint');
    expect(detailPane).toContain('EVENT_FAMILY_THEME.plan');
    expect(detailPane).toContain('EVENT_FAMILY_THEME.summary');
    expect(detailPane).not.toContain("case 'ev-ready'");
  });
});
