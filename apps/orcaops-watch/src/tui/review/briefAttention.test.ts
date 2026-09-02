import { describe, expect, it } from 'vitest';

import { type FinishBlocker, replayReviewLedgerV2 } from '@orcaops/review-core';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
} from '@orcaops/review-engine';

import {
  type BriefAttentionRow,
  buildBriefAttention,
  nextAttentionRow,
  railItemTone,
} from './briefAttention';
import { buildFinishObligations } from './finishPresentation';
import { buildStoryReader, type ReaderModel } from './readerModel';
import {
  buildFixtureReader,
  buildWatchReviewFixture,
} from '../../../tests/review/reviewExperienceFixtures';
import { buildStoryReviewHarnessFixture } from '../../../tests/review/storyReviewHarness';

/** The glyph is derived from the tone, so the two can never disagree. */
const GLYPH_FOR_TONE: Record<string, string> = {
  critical: '‼',
  warn: '!',
  prompt: '?',
  comment: '✎',
  decision: '◆',
  uncertainty: '⚑',
  inspect: '◇',
  structural: '○',
};

async function storyHarnessReader(): Promise<ReaderModel> {
  const fixture = buildStoryReviewHarnessFixture();
  const eligibleTargets = await buildEligibleNarrativeTargets(fixture.floor, fixture.reviewDiff);
  const currentThreads = await buildCurrentThreadManifests(fixture.floor, eligibleTargets);
  const currentGapRows = await buildCurrentGapRows(fixture.floor, fixture.reviewDiff);
  const ledger = await replayReviewLedgerV2({ events: [], currentThreads });
  return buildStoryReader({
    floor: fixture.floor,
    model: fixture.model,
    reviewDiff: fixture.reviewDiff,
    eligibleTargets,
    ledger,
    currentThreads,
    finishFacts: { targets: { ok: true }, currentGapRows, comments: [] },
  });
}

describe('buildBriefAttention · story', () => {
  it('projects every attention rail item in ranked order with its durable key', async () => {
    const reader = await storyHarnessReader();
    const rows = buildBriefAttention({ reader, obligations: [] });
    const items = reader.routeIndex.attentionItems;

    expect(items.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(items.length);
    // Order is the reader's ranked order, not a re-sort.
    expect(rows.map((row) => row.key)).toEqual(items.map((item) => `item:${item.id}`));
    expect(rows.map((row) => row.label)).toEqual(items.map((item) => item.shortText));
    expect(rows.map((row) => row.destination)).toEqual(
      items.map((item) => ({ kind: 'story-item', itemId: item.id }))
    );
  });

  it('names the item source and whether it is required on every detail line', async () => {
    const reader = await storyHarnessReader();
    const rows = buildBriefAttention({ reader, obligations: [] });
    const items = reader.routeIndex.attentionItems;

    expect(rows.map((row) => row.detail)).toEqual(
      items.map((item) => `${item.source} · ${item.required ? 'required' : 'advisory'}`)
    );
  });

  it('carries a tone parallel to every glyph, derived from what the item is', async () => {
    const reader = await storyHarnessReader();
    const rows = buildBriefAttention({ reader, obligations: [] });
    const items = reader.routeIndex.attentionItems;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(GLYPH_FOR_TONE[row.tone]).toBe(row.glyph);
    rows.forEach((row, index) => {
      expect(row.tone).toBe(railItemTone(items[index]!));
    });
    // The v4 vocabulary triages by kind: a required finding is a stop sign, a
    // question a prompt, an uncertainty a flag.
    for (const [index, item] of items.entries()) {
      if (item.kind === 'question') expect(rows[index]!.tone).toBe('prompt');
      if (item.kind === 'uncertainty') expect(rows[index]!.tone).toBe('uncertainty');
      if (item.kind === 'finding') {
        expect(rows[index]!.tone).toBe(item.required ? 'critical' : 'warn');
      }
    }
  });
});

describe('buildBriefAttention · deterministic', () => {
  it('reads the queue off the finish obligations, one row per obligation', async () => {
    const fixture = await buildWatchReviewFixture('uncertainty-floor-only');
    const reader = buildFixtureReader(fixture);
    const obligations = buildFinishObligations({ floor: fixture.source.floor, reader });
    const rows = buildBriefAttention({ reader, obligations });

    expect(obligations.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(obligations.length);
    expect(rows.map((row) => row.key)).toEqual(
      obligations.map((obligation) => `obligation:${obligation.key}`)
    );
    expect(rows.map((row) => row.label)).toEqual(obligations.map((obligation) => obligation.label));
    expect(rows.map((row) => row.detail)).toEqual(
      obligations.map((obligation) => obligation.detail)
    );
    expect(rows.map((row) => row.destination)).toEqual(
      obligations.map((obligation) => ({ kind: 'obligation', obligation }))
    );
  });

  it('marks every blocker kind with a distinct-by-category glyph', async () => {
    const fixture = await buildWatchReviewFixture('uncertainty-floor-only');
    const base = buildFixtureReader(fixture);
    const thread = fixture.source.floor.outline.threads[0]!;
    const citationId = thread.checkpoints[0]!.citationIds.find((id) =>
      id.includes(':uncertainty:')
    )!;
    const blockers: FinishBlocker[] = [
      { kind: 'targets', reason: 'internal target failure' },
      { kind: 'checking', threadKey: thread.threadKey },
      { kind: 'rows', threadKey: thread.threadKey, newRows: 3 },
      { kind: 'gap_rows', newRows: 2 },
      { kind: 'ambiguous_hunks', hunkKeys: ['hunk_private'] },
      { kind: 'comments', open: 1 },
      { kind: 'uncertainties', citationIds: [citationId] },
      { kind: 'story_items', open: 2 },
    ];
    const obligations = buildFinishObligations({
      floor: fixture.source.floor,
      reader: { ...base, finish: { allowed: false, blockers } },
    });
    const rows = buildBriefAttention({ reader: base, obligations });

    expect(rows.map((row) => row.glyph)).toEqual(['‼', '‼', '!', '◇', '◇', '✎', '⚑', '◆']);
    // The tone runs parallel to the glyph, so the renderer can hue each row.
    expect(rows.map((row) => row.tone)).toEqual([
      'critical',
      'critical',
      'warn',
      'inspect',
      'inspect',
      'comment',
      'uncertainty',
      'decision',
    ]);
    // The queue is human text plus a glyph; durable IDs never reach it.
    const visible = rows.map((row) => `${row.label} ${row.detail ?? ''}`).join('\n');
    expect(visible).not.toContain(thread.threadKey);
    expect(visible).not.toContain(citationId);
  });

  it('returns an empty queue when nothing blocks finishing', async () => {
    const fixture = await buildWatchReviewFixture('complete-floor-only');
    const reader = buildFixtureReader(fixture);
    const obligations = buildFinishObligations({ floor: fixture.source.floor, reader });

    expect(reader.finish.allowed).toBe(true);
    expect(buildBriefAttention({ reader, obligations })).toEqual([]);
  });
});

describe('nextAttentionRow', () => {
  const rows = [
    { key: 'a', label: 'A', glyph: '!', destination: { kind: 'story-item' } },
    { key: 'b', label: 'B', glyph: '!', destination: { kind: 'story-item' } },
    { key: 'c', label: 'C', glyph: '!', destination: { kind: 'story-item' } },
  ] as unknown as BriefAttentionRow[];

  it('opens the first row when traversal has not started', () => {
    expect(nextAttentionRow(rows, null, 1)).toEqual({ row: rows[0], index: 0 });
  });

  it('opens the last row when reversing before traversal has started', () => {
    expect(nextAttentionRow(rows, null, -1)).toEqual({ row: rows[2], index: 2 });
  });

  it('advances and wraps from a known key', () => {
    expect(nextAttentionRow(rows, 'a', 1)!.index).toBe(1);
    expect(nextAttentionRow(rows, 'c', 1)!.index).toBe(0);
    expect(nextAttentionRow(rows, 'a', -1)!.index).toBe(2);
  });

  it('treats a vanished key as an unstarted traversal rather than an offset', () => {
    expect(nextAttentionRow(rows, 'gone', 1)!.index).toBe(0);
    expect(nextAttentionRow(rows, 'gone', -1)!.index).toBe(2);
  });

  it('routes a singleton queue to its sole row in both directions', () => {
    const single = [rows[0]!];
    expect(nextAttentionRow(single, null, 1)!.index).toBe(0);
    expect(nextAttentionRow(single, 'a', 1)!.index).toBe(0);
    expect(nextAttentionRow(single, 'a', -1)!.index).toBe(0);
  });

  it('has nothing to open on an empty queue', () => {
    expect(nextAttentionRow([], null, 1)).toBeNull();
    expect(nextAttentionRow([], 'a', -1)).toBeNull();
  });
});
