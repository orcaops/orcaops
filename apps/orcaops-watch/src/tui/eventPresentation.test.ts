// One typed mapping owns the label and color-family presentation of every
// event type, and all three surfaces (Live Events, the detail model, and the
// Detail pane) consume it. EventTypeSchema has no ready/wrap members and
// appendEvent accepts only EventType, while the permissive ticker reader can
// pass through arbitrary string types from torn or foreign lines. The
// mapping's neutral fallback is therefore a required presentation guard.

import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EventTypeSchema } from '@orcaops/storage';
import { EventTailReader } from '@orcaops/watch-data';
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
    source: 'hot',
    branch: 'feature/demo',
    title: 'Thread a1',
    agent: 'codex',
    sessions: [{ agent: 'codex', session_id: 'session-a1', tokens: 12_345 }],
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
    recentEvents,
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

describe('the ticker feed is permissive — the mapping fallback is the guard', () => {
  it('the tail reader passes through a schema-invalid type, and presentation degrades it', async () => {
    // The write path is compile-typed (appendEvent takes EventType) and the
    // validated read path (readEventLog) enforces the strict record schema,
    // but THIS reader deliberately accepts any parsed string so corruption
    // stays observable in the ticker instead of vanishing. The presentation
    // layer must therefore neutralize unknown types, never color them.
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-tail-'));
    const eventsPath = path.join(dir, 'events.jsonl');
    await writeFile(
      eventsPath,
      `${JSON.stringify({ ts: '2026-07-30T12:00:00.000Z', type: 'ready_for_review' })}
`,
      'utf8'
    );
    const events = await new EventTailReader().read(eventsPath);
    expect(events.map((e) => e.type)).toEqual(['ready_for_review']);
    expect(eventFamily(events[0]!.type)).toBe('other');
    expect(eventLabel(events[0]!.type)).toBe('ready for review');
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
