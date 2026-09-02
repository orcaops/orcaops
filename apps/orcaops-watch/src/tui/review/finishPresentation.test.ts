import { describe, expect, it } from 'vitest';

import type { FinishBlocker } from '@orcaops/review-core';

import { buildFinishObligations, type FinishObligation } from './finishPresentation';
import {
  buildFixtureReader,
  buildWatchReviewFixture,
} from '../../../tests/review/reviewExperienceFixtures';

/** The all-blockers shape the durability cases permute. */
async function allBlockerCase(): Promise<{
  project: (blockers: FinishBlocker[]) => FinishObligation[];
  blockers: FinishBlocker[];
  threadKey: string;
  otherThreadKey: string;
  citationId: string;
}> {
  const fixture = await buildWatchReviewFixture('uncertainty-floor-only');
  const base = buildFixtureReader(fixture);
  const threadKey = fixture.source.floor.outline.threads[0]!.threadKey;
  const citationId = fixture.source.floor.outline.threads[0]!.checkpoints[0]!.citationIds.find(
    (id) => id.includes(':uncertainty:')
  )!;
  return {
    project: (blockers) =>
      buildFinishObligations({
        floor: fixture.source.floor,
        reader: { ...base, finish: { allowed: false, blockers } },
      }),
    blockers: [
      { kind: 'targets', reason: 'internal target failure' },
      { kind: 'checking', threadKey },
      { kind: 'rows', threadKey, newRows: 3 },
      { kind: 'gap_rows', newRows: 2 },
      { kind: 'ambiguous_hunks', hunkKeys: ['hunk_private'] },
      { kind: 'comments', open: 1 },
      { kind: 'uncertainties', citationIds: [citationId] },
      { kind: 'story_items', open: 2 },
    ],
    threadKey,
    otherThreadKey: `${threadKey}-second`,
    citationId,
  };
}

describe('buildFinishObligations · durable keys', () => {
  it('keys every obligation by its domain identity, uniquely', async () => {
    const { project, blockers, threadKey, citationId } = await allBlockerCase();
    const obligations = project(blockers);
    const keyByKind = new Map(obligations.map((o) => [o.kind, o.key]));

    expect(new Set(obligations.map((o) => o.key)).size).toBe(obligations.length);
    // Thread- and citation-scoped blockers name the durable thing they are
    // about; the rest are singletons per review and name their category.
    expect(keyByKind.get('rows')).toBe(`rows:${threadKey}`);
    expect(keyByKind.get('checking')).toBe(`checking:${threadKey}`);
    expect(keyByKind.get('uncertainties')).toBe(`uncertainty:${citationId}`);
    expect(keyByKind.get('targets')).toBe('targets');
    expect(keyByKind.get('gap_rows')).toBe('gap');
    expect(keyByKind.get('ambiguous_hunks')).toBe('ambiguous');
    expect(keyByKind.get('comments')).toBe('comments');
    expect(keyByKind.get('story_items')).toBe('story');
  });

  it('holds a key stable when an earlier blocker clears', async () => {
    const { project, blockers } = await allBlockerCase();
    const before = project(blockers);
    const after = project(blockers.slice(1));

    const identify = (obligation: FinishObligation) => `${obligation.kind}\0${obligation.label}`;
    const beforeByIdentity = new Map(before.map((o) => [identify(o), o.key]));
    expect(after.length).toBe(before.length - 1);
    for (const obligation of after) {
      expect(obligation.key).toBe(beforeByIdentity.get(identify(obligation)));
    }
  });

  it('does not let an unrelated obligation inherit a removed obligation’s key', async () => {
    const { project, blockers } = await allBlockerCase();
    const removed = project(blockers).find((obligation) => obligation.kind === 'rows')!;
    const after = project(blockers.filter((blocker) => blocker.kind !== 'rows'));

    expect(after.map((obligation) => obligation.key)).not.toContain(removed.key);
  });

  it('keeps keys stable under reordering', async () => {
    const { project, blockers } = await allBlockerCase();
    const forward = project(blockers);
    const reversed = project([...blockers].reverse());

    const byLabel = (list: FinishObligation[]) =>
      new Map(list.map((obligation) => [obligation.label, obligation.key]));
    expect([...byLabel(reversed).entries()].sort()).toEqual([...byLabel(forward).entries()].sort());
  });

  it('distinguishes same-kind obligations that are about different things', async () => {
    const { project, threadKey, otherThreadKey, citationId } = await allBlockerCase();
    const obligations = project([
      { kind: 'rows', threadKey, newRows: 3 },
      { kind: 'rows', threadKey: otherThreadKey, newRows: 1 },
      { kind: 'uncertainties', citationIds: [citationId, `${citationId}-second`] },
    ]);
    const keys = obligations.map((obligation) => obligation.key);

    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
  });
});

describe('buildFinishObligations', () => {
  it('projects every durable blocker into human text and a route without leaking IDs', async () => {
    const fixture = await buildWatchReviewFixture('uncertainty-floor-only');
    const base = buildFixtureReader(fixture);
    const threadKey = fixture.source.floor.outline.threads[0]!.threadKey;
    const citationId = fixture.source.floor.outline.threads[0]!.checkpoints[0]!.citationIds.find(
      (id) => id.includes(':uncertainty:')
    )!;
    const blockers: FinishBlocker[] = [
      { kind: 'targets', reason: 'internal target failure' },
      { kind: 'checking', threadKey },
      { kind: 'rows', threadKey, newRows: 3 },
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
    const visible = obligations.map(({ label, detail }) => `${label} ${detail}`).join('\n');

    expect(visible).not.toContain(threadKey);
    expect(visible).not.toContain(citationId);
    expect(visible).not.toContain('hunk_private');
    expect(visible).toContain(fixture.source.floor.outline.threads[0]!.title);
    expect(obligations.every((obligation) => obligation.route.kind.length > 0)).toBe(true);
    expect(obligations.map((obligation) => obligation.route.kind)).toContain('recovery');
    expect(obligations.map((obligation) => obligation.route.kind)).toContain('reader-page');
    expect(obligations.map((obligation) => obligation.route.kind)).toContain('unassigned');
    expect(obligations.map((obligation) => obligation.route.kind)).toContain('comments');
  });
});
