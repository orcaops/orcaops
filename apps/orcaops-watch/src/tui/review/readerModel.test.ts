// The coverage contract of the two-lens reader.
//
// The thing that must not be true: reviewer progress silently disappearing when
// the structure around it changes. So these tests never assert a key or a page
// count as an end in itself — they assert what happens to a reviewer's covered
// rows.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  COMPLETION_STATE,
  type CurrentThreadManifest,
  type EligibleNarrativeTarget,
  type Floor,
  type JournalEvent,
  replayReviewLedgerV2,
  type ReviewedRow,
  reviewedRowsDigest,
} from '@orcaops/review-core';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
  buildSemanticAnchorChangeBlockCatalog,
  type SemanticAnchorChangeHunk,
  type SemanticAnchorModel,
  type SemanticAnchorResolvedTarget,
} from '@orcaops/review-engine';

import {
  buildDeterministicReader,
  buildReaderRouteIndex,
  buildStoryReader,
  pageIndexForHunk,
  pageIndexForSlice,
  preparePageCoverage,
  type ReaderFinishFacts,
  type ReaderModel,
} from './readerModel';
import {
  buildCodeOnlyStoryReviewHarnessFixture,
  buildStoryReviewHarnessFixture,
} from '../../../tests/review/storyReviewHarness';

const ARTIFACT = '019f5978-1111-7000-8000-000000000001';
const THREAD = 'sec_thread';

/**
 * A branch with nothing outstanding BESIDES its rows — so any finish blocker a
 * test sees is the one it put there. These suites are about coverage, so the
 * facts a coverage test does not care about must be inert, not absent.
 */
const CLEAN_FACTS: ReaderFinishFacts = {
  targets: { ok: true },
  currentGapRows: [],
  comments: [],
};

function semanticRange(
  hunk: SemanticAnchorChangeHunk,
  side: 'add' | 'delete',
  selection?: { start: number; end: number }
) {
  const rows = hunk.blocks[0]!.lines.filter((line) => line.side === side);
  if (rows.length === 0) return null;
  const selected =
    selection === undefined
      ? rows
      : rows.filter((line) => {
          const coordinate = side === 'add' ? line.newLine : line.oldLine;
          return (
            coordinate !== null && coordinate >= selection.start && coordinate <= selection.end
          );
        });
  if (selected.length === 0) return null;
  return {
    start_line: (side === 'add' ? selected[0]!.newLine : selected[0]!.oldLine)!,
    end_line: (side === 'add' ? selected.at(-1)!.newLine : selected.at(-1)!.oldLine)!,
    line_hashes: selected.map((line) => line.lineHash),
  };
}

function semanticTarget(
  hunk: SemanticAnchorChangeHunk,
  treatment:
    | { kind: 'whole' }
    | { kind: 'accepted'; side: 'add' | 'delete'; start: number; end: number }
    | { kind: 'rejected' }
): SemanticAnchorResolvedTarget {
  const block = hunk.blocks[0]!;
  const durableBlock = {
    block_key: block.blockKey,
    hunk_key: hunk.hunkKey,
    old_file: hunk.oldFile,
    new_file: hunk.newFile,
    display_file: hunk.displayPath,
    delete: semanticRange(hunk, 'delete'),
    add: semanticRange(hunk, 'add'),
  };
  if (treatment.kind === 'whole') {
    return {
      schema_version: 3,
      block: durableBlock,
      scope: 'WHOLE_BLOCK',
      focus: null,
      focus_status: 'NONE',
      focus_diagnostic_code: null,
      warnings: [],
    };
  }
  if (treatment.kind === 'rejected') {
    return {
      schema_version: 3,
      block: durableBlock,
      scope: 'FOCUS',
      focus: null,
      focus_status: 'REJECTED_INVALID',
      focus_diagnostic_code: 'FOCUS_RANGE_INVALID',
      warnings: [],
    };
  }
  return {
    schema_version: 3,
    block: durableBlock,
    scope: 'FOCUS',
    focus: {
      delete: treatment.side === 'delete' ? semanticRange(hunk, 'delete', treatment) : null,
      add: treatment.side === 'add' ? semanticRange(hunk, 'add', treatment) : null,
    },
    focus_status: 'ACCEPTED',
    focus_diagnostic_code: null,
    warnings: [],
  };
}

function semanticModel(
  floorInputHash: string,
  items: SemanticAnchorModel['items']
): SemanticAnchorModel {
  return {
    schema_version: 3,
    generation_id: '11111111-1111-4111-8111-111111111111',
    run_id: '22222222-2222-4222-8222-222222222222',
    floor_input_hash: floorInputHash,
    prepared_payload_sha256: 'a'.repeat(64),
    source: 'REVIEW_MODEL_SUBMISSION_COMPILED',
    items,
  };
}

/** One reviewable row per checkpoint, so "which checkpoint did I cover" is visible. */
function anchor(cp: number) {
  return {
    kind: 'CHANGED_RANGE' as const,
    file: `src/cp${cp}.ts`,
    hunkKey: `hunk_cp${cp}`,
    ranges: [{ side: 'add' as const, startLine: 1, endLine: 1, lineHashes: [`lh_cp${cp}`] }],
  };
}

function target(cp: number): EligibleNarrativeTarget {
  return {
    targetKey: `target_cp${cp}`,
    threadKey: THREAD,
    anchor: anchor(cp),
    checkpointRefs: [{ artifact: ARTIFACT, cp }],
  };
}

/** A floor with ONE thread carrying `cpCount` checkpoints. */
function floorWith(cpCount: number): Floor {
  return {
    outline: {
      threads: [
        {
          threadKey: THREAD,
          order: 1,
          title: 'Restore the reading experience',
          artifact: ARTIFACT,
          checkpoints: Array.from({ length: cpCount }, (_unused, index) => ({
            checkpointKey: `chap_cp${index + 1}`,
            order: index + 1,
            checkpoint: { artifact: ARTIFACT, cp: index + 1, label: `checkpoint ${index + 1}` },
            members: [{ artifact: ARTIFACT, cp: index + 1 }],
            sliceRefs: [{ hunkKey: `hunk_cp${index + 1}`, slice: 0 }],
            citationIds: [],
          })),
        },
      ],
      unassigned: { gap: { sliceRefs: [], files: [] }, ambiguous: { hunkKeys: [], files: [] } },
    },
    coverage: {
      items: Array.from({ length: cpCount }, (_unused, index) => ({
        hunkKey: `hunk_cp${index + 1}`,
        file: `src/cp${index + 1}.ts`,
        verdict: 'MATCHED' as const,
        old_start: 0,
        new_start: 1,
        added_lines: 1,
        removed_lines: 0,
        units: [
          {
            kind: 'owned_slice' as const,
            slice: 0,
            patch_row_start: 0,
            patch_row_end: 0,
            del_range: null,
            add_range: { start: 1, end: 1 },
            lines: 1,
            owner: { kind: 'checkpoint' as const, artifact: ARTIFACT, cp: index + 1 },
          },
        ],
      })),
    },
    // The finish gate reads these. A fixture that omits them behind the cast is a
    // fixture claiming obligations it does not have — which is how a gate reads
    // "nothing outstanding" on a branch that has plenty.
    citations: [],
  } as unknown as Floor;
}

function rowsFor(cps: readonly number[]): ReviewedRow[] {
  return cps.map((cp) => ({
    file: `src/cp${cp}.ts`,
    side: 'add' as const,
    line: 1,
    lineHash: `lh_cp${cp}`,
    hunkKey: `hunk_cp${cp}`,
  }));
}

async function manifest(cps: readonly number[]): Promise<CurrentThreadManifest> {
  const rows = rowsFor(cps);
  return { threadKey: THREAD, rows, digest: await reviewedRowsDigest(rows) };
}

let events: JournalEvent[];

async function ledgerNow(current: CurrentThreadManifest) {
  return replayReviewLedgerV2({ events, currentThreads: [current] });
}

/** Mark one page reviewed, appending whatever coverage event that implies. */
async function markReviewed(reader: ReaderModel, key: string, current: CurrentThreadManifest) {
  const page = reader.pages.find((candidate) => candidate.key === key);
  expect(page, `no page ${key}`).toBeDefined();
  const prepared = await preparePageCoverage({
    page: page!,
    floorInputHash: 'floor_v1',
    ledger: await ledgerNow(current),
    currentThreads: [current],
    now: `2026-07-13T0${events.length + 1}:00:00.000Z`,
  });
  expect(prepared.status).toBe('ready');
  events.push(prepared.event!);
}

beforeEach(() => {
  events = [];
});

describe('two checkpoints in one thread', () => {
  it('scopes an open reviewer comment to its exact checkpoint owner', async () => {
    const current = await manifest([1, 2]);
    const comment = {
      comment_id: 'comment-cp1',
      ts: '2026-07-13T00:00:00.000Z',
      author: 'reviewer' as const,
      body: 'Check checkpoint one.',
      status: 'open' as const,
      anchor: {
        kind: 'DIFF_LINE' as const,
        file: 'src/fixture.ts',
        side: 'add' as const,
        line: 2,
        lineHash: 'hash_cp1',
      },
      replies: [],
      owner: { artifact: ARTIFACT, cp: 1 },
    };
    const reader = buildDeterministicReader({
      floor: floorWith(2),
      eligibleTargets: [target(1), target(2)],
      ledger: await ledgerNow(current),
      currentThreads: [current],
      finishFacts: { ...CLEAN_FACTS, comments: [comment] },
    });

    expect(reader.pages[0]).toMatchObject({
      key: 'chap_cp1',
      markReviewedEnabled: false,
      blockers: ['rows', 'comments'],
    });
    expect(reader.pages[1]).toMatchObject({
      key: 'chap_cp2',
      markReviewedEnabled: true,
      blockers: ['rows'],
    });
    expect(reader.finish.blockers).toContainEqual({ kind: 'comments', open: 1 });
  });

  it('keeps an unresolved-owner comment branch-blocking without blocking every page', async () => {
    const current = await manifest([1, 2]);
    const comment = {
      comment_id: 'comment-unresolved',
      ts: '2026-07-13T00:00:00.000Z',
      author: 'reviewer' as const,
      body: 'This still needs an answer.',
      status: 'open' as const,
      anchor: {
        kind: 'DIFF_LINE' as const,
        file: 'src/orphaned.ts',
        side: 'add' as const,
        line: 1,
        lineHash: 'hash_unresolved',
      },
      replies: [],
      owner: null,
    };
    const reader = buildDeterministicReader({
      floor: floorWith(2),
      eligibleTargets: [target(1), target(2)],
      ledger: await ledgerNow(current),
      currentThreads: [current],
      finishFacts: { ...CLEAN_FACTS, comments: [comment] },
    });

    expect(reader.pages.every((page) => page.markReviewedEnabled)).toBe(true);
    expect(reader.finish.blockers).toContainEqual({ kind: 'comments', open: 1 });
  });

  it('does not substitute page zero when direct evidence is absent', async () => {
    const floor = floorWith(2);
    const current = await manifest([1, 2]);
    const reader = buildDeterministicReader({
      floor,
      eligibleTargets: [target(1), target(2)],
      ledger: await ledgerNow(current),
      currentThreads: [current],
      finishFacts: CLEAN_FACTS,
    });
    expect(pageIndexForHunk(reader, 'missing-hunk')).toBeNull();
    expect(pageIndexForHunk(reader, floor.coverage.items[0]!.hunkKey)).toBe(0);
  });

  it('keeps shared physical hunks and slices one-to-many across checkpoint pages', async () => {
    const current = await manifest([1, 2]);
    const reader = buildDeterministicReader({
      floor: floorWith(2),
      eligibleTargets: [target(1), target(2)],
      ledger: await ledgerNow(current),
      currentThreads: [current],
      finishFacts: CLEAN_FACTS,
    });
    const pages = reader.pages.map((page) => ({
      ...page,
      sliceStops: [
        {
          ...page.sliceStops[0]!,
          hunkKey: 'hunk_shared',
          sliceKey: 'hunk_shared:s0',
        },
      ],
    }));
    const routes = buildReaderRouteIndex({
      lens: 'deterministic',
      pages,
      auxiliaryPage: reader.auxiliaryPage,
    });

    expect(routes.pageIndexesByHunkKey.get('hunk_shared')).toEqual([0, 1]);
    expect(routes.pageIndexesBySliceKey.get('hunk_shared:s0')).toEqual([0, 1]);
  });

  it('marking the first leaves the thread incomplete; marking the second completes it', async () => {
    // The property the checkpoint page exists for. Under the synthesized lens a
    // Part can span both checkpoints, so the reviewer takes them as one bite; the
    // deterministic lens makes each checkpoint its own page, so a half-reviewed
    // thread is a real, representable state.
    const floor = floorWith(2);
    const targets = [target(1), target(2)];
    const current = await manifest([1, 2]);

    const before = buildDeterministicReader({
      floor,
      eligibleTargets: targets,
      ledger: await ledgerNow(current),
      currentThreads: [current],
      finishFacts: CLEAN_FACTS,
    });
    expect(before.pages.map((page) => page.key)).toEqual(['chap_cp1', 'chap_cp2']);
    expect(before.coverage.pagesComplete).toBe(0);

    // Mark checkpoint 1.
    await markReviewed(before, 'chap_cp1', current);
    const afterFirst = buildDeterministicReader({
      floor,
      eligibleTargets: targets,
      ledger: await ledgerNow(current),
      currentThreads: [current],
      finishFacts: CLEAN_FACTS,
    });

    expect(afterFirst.pages[0]!.complete).toBe(true);
    expect(afterFirst.pages[1]!.complete).toBe(false); // cp2 is untouched
    expect(afterFirst.coverage.pagesComplete).toBe(1);
    // The THREAD is partially covered — not reviewed, and not reset to unread.
    expect(afterFirst.coverage.byThread.get(THREAD)).toEqual({
      state: COMPLETION_STATE.PARTIAL,
    });

    // Mark checkpoint 2.
    await markReviewed(afterFirst, 'chap_cp2', current);
    const afterSecond = buildDeterministicReader({
      floor,
      eligibleTargets: targets,
      ledger: await ledgerNow(current),
      currentThreads: [current],
      finishFacts: CLEAN_FACTS,
    });

    expect(afterSecond.pages.every((page) => page.complete)).toBe(true);
    expect(afterSecond.coverage.pagesComplete).toBe(2);
    expect(afterSecond.coverage.byThread.get(THREAD)).toEqual({
      state: COMPLETION_STATE.REVIEWED,
    });
  });

  it('covers only the rows the marked checkpoint owns, not the whole thread', async () => {
    // The failure this guards: a checkpoint page that hands the WHOLE thread's
    // rows to the preparer would complete the thread on the first mark and the
    // reviewer would never see cp2.
    const current = await manifest([1, 2]);
    const reader = buildDeterministicReader({
      floor: floorWith(2),
      eligibleTargets: [target(1), target(2)],
      ledger: await ledgerNow(current),
      currentThreads: [current],
      finishFacts: CLEAN_FACTS,
    });

    await markReviewed(reader, 'chap_cp1', current);
    const ledger = await ledgerNow(current);

    expect(ledger.coverage[0]!.coveredRows.map((row) => row.file)).toEqual(['src/cp1.ts']);
  });
});

describe('a checkpoint that owns no rows', () => {
  it('is markable and complete, so its thread can still finish', async () => {
    // A checkpoint whose work was all in files the floor excludes owns zero rows.
    // If such a page were unmarkable, the thread containing it could never reach
    // complete — the reviewer would be stuck with no way forward and no reason
    // given. It has no items either, so nothing else can gate it.
    const current = await manifest([1]);
    const reader = buildDeterministicReader({
      floor: floorWith(2),
      eligibleTargets: [target(1)], // cp2 has no target ⇒ no rows
      ledger: await ledgerNow(current),
      currentThreads: [current],
      finishFacts: CLEAN_FACTS,
    });

    const empty = reader.pages.find((page) => page.key === 'chap_cp2')!;
    expect(empty.rowCount).toBe(0);
    expect(empty.hasNoRows).toBe(true);
    expect(empty.markReviewedEnabled).toBe(true);
    expect(empty.complete).toBe(true);
    expect(empty.blockers).toEqual([]);

    // And marking it writes no coverage event — there is nothing to cover.
    const prepared = await preparePageCoverage({
      page: empty,
      floorInputHash: 'floor_v1',
      ledger: await ledgerNow(current),
      currentThreads: [current],
    });
    expect(prepared.status).toBe('no_rows');
    expect(prepared.event).toBeNull();
  });

  it('emits no coverage event even when a non-row obligation keeps the page incomplete', async () => {
    const floor = floorWith(2);
    const uncertaintyId = `cite:${ARTIFACT}:cp2:uncertainty:0`;
    floor.citations.push({
      id: uncertaintyId,
      kind: 'CHECKPOINT_UNCERTAINTY',
      artifact: ARTIFACT,
      cp: 2,
      text: 'Confirm the excluded-file behavior.',
    });
    floor.outline.threads[0]!.checkpoints[1]!.citationIds.push(uncertaintyId);
    const current = await manifest([1]);
    const ledger = await ledgerNow(current);
    const reader = buildDeterministicReader({
      floor,
      eligibleTargets: [target(1)],
      ledger,
      currentThreads: [current],
      finishFacts: CLEAN_FACTS,
    });
    const empty = reader.pages.find((page) => page.key === 'chap_cp2')!;

    expect(empty).toMatchObject({
      hasNoRows: true,
      complete: false,
      markReviewedEnabled: false,
      blockers: ['uncertainties'],
    });
    await expect(
      preparePageCoverage({
        page: empty,
        floorInputHash: 'floor_v1',
        ledger,
        currentThreads: [current],
      })
    ).resolves.toEqual({ status: 'no_rows', event: null });
  });
});

describe('routine Story reader', () => {
  async function storyReader(codeOnly = false, semanticAnchors: SemanticAnchorModel | null = null) {
    const fixture = codeOnly
      ? buildCodeOnlyStoryReviewHarnessFixture()
      : buildStoryReviewHarnessFixture();
    const eligibleTargets = await buildEligibleNarrativeTargets(fixture.floor, fixture.reviewDiff);
    const currentThreads = await buildCurrentThreadManifests(fixture.floor, eligibleTargets);
    const currentGapRows = await buildCurrentGapRows(fixture.floor, fixture.reviewDiff);
    const ledger = await replayReviewLedgerV2({ events, currentThreads });
    return {
      fixture,
      eligibleTargets,
      currentThreads,
      ledger,
      reader: buildStoryReader({
        floor: fixture.floor,
        model: fixture.model,
        reviewDiff: fixture.reviewDiff,
        semanticAnchors,
        eligibleTargets,
        ledger,
        currentThreads,
        finishFacts: { targets: { ok: true }, currentGapRows, comments: [] },
      }),
    };
  }

  it('projects v4 Parts in causal order with exact row and ambiguity routes', async () => {
    const { reader, eligibleTargets } = await storyReader();
    expect(reader.lens).toBe('story');
    expect(reader.pages.map((page) => page.key)).toEqual(['P1', 'P2', 'P3']);

    const first = reader.pages[0]!;
    expect(first.kind).toBe('part');
    expect(first.rowCount).toBe(2);
    expect(first.sliceStops.map((stop) => stop.hunkKey)).toEqual([
      'hunk_story_owned_p1',
      'hunk_story_same_part',
    ]);
    expect([...first.ownedRows.values()].flat().map((row) => row.lineHash)).toEqual(
      eligibleTargets
        .find((target) => target.anchor.hunkKey === 'hunk_story_owned_p1')!
        .anchor.ranges.flatMap((range) => range.lineHashes)
    );
    expect(pageIndexForHunk(reader, 'hunk_story_same_part')).toBe(0);
    expect(pageIndexForSlice(reader, 'hunk_story_same_part')).toBe(0);
  });

  it('keeps a context-only Part routable without fabricating coverage', async () => {
    const { reader, ledger, currentThreads } = await storyReader();
    const page = reader.pages[1]!;
    expect(page).toMatchObject({
      key: 'P2',
      kind: 'part',
      hasNoRows: true,
      rowCount: 0,
      markReviewedEnabled: false,
      complete: false,
      blockers: ['uncertainties'],
    });
    expect(reader.routeIndex.pageIndexByKey.get('P2')).toBe(1);
    await expect(
      preparePageCoverage({
        page,
        floorInputHash: 'story-harness-floor-v4',
        ledger,
        currentThreads,
      })
    ).resolves.toEqual({ status: 'no_rows', event: null });
  });

  it('does not infer context-only completion from a shared thread visit', async () => {
    events.push({
      type: 'section',
      ts: '2026-07-23T12:00:00.000Z',
      threadKey: 'thread-story-one',
      action: 'VISIT',
    });
    const { fixture, eligibleTargets, currentThreads, ledger } = await storyReader();
    const model = structuredClone(fixture.model);
    const source = model.parts.find((part) => part.id === 'P2')!;
    model.parts.splice(model.parts.indexOf(source) + 1, 0, {
      ...source,
      id: 'P2B',
      title: 'Obligation-free captured context',
      interpretation: 'This sibling shares a thread but owns no open item.',
      citations: [],
    });
    const act = model.acts.find((candidate) => candidate.id === 'A1')!;
    act.partIds.splice(act.partIds.indexOf('P2') + 1, 0, 'P2B');

    const reader = buildStoryReader({
      floor: fixture.floor,
      model,
      reviewDiff: fixture.reviewDiff,
      eligibleTargets,
      ledger,
      currentThreads,
      finishFacts: {
        targets: { ok: true },
        currentGapRows: await buildCurrentGapRows(fixture.floor, fixture.reviewDiff),
        comments: [],
      },
    });
    expect(reader.pages.find((page) => page.key === 'P2')).toMatchObject({
      complete: false,
      visited: false,
      markReviewedEnabled: false,
      blockers: ['uncertainties'],
    });
    expect(reader.pages.find((page) => page.key === 'P2B')).toMatchObject({
      complete: true,
      visited: false,
      markReviewedEnabled: false,
      blockers: [],
    });
  });

  it('joins required global item dispositions by exact id', async () => {
    const before = await storyReader();
    expect(before.reader.finish.blockers).toContainEqual({ kind: 'story_items', open: 2 });

    events.push(
      {
        type: 'finding',
        ts: '2026-07-23T12:00:00.000Z',
        findingKey: 'finding:required-global',
        action: 'RESOLVE',
      },
      {
        type: 'prompt',
        ts: '2026-07-23T12:01:00.000Z',
        promptKey: 'question:required-global',
        action: 'ACKNOWLEDGE',
      }
    );
    const after = await storyReader();
    expect(after.reader.finish.blockers.some((blocker) => blocker.kind === 'story_items')).toBe(
      false
    );
    expect(after.reader.routeIndex.attentionItems.map((item) => [item.id, item.state])).toEqual([
      ['finding:finding:required-global', 'RESOLVED'],
      ['question:question:required-global', 'ACKNOWLEDGED'],
    ]);
  });

  it('keeps residue outside the Part pager while retaining inspection identities', async () => {
    const { reader } = await storyReader();
    expect(reader.pages.some((page) => page.key === 'story-residue')).toBe(false);
    expect(reader.auxiliaryPage).toMatchObject({
      kind: 'story-residue',
      ambiguousHunkKeys: ['hunk_story_contested', 'hunk_story_ambiguous_no_part'],
      complete: false,
    });
    expect(reader.auxiliaryPage.inspectionRows).toHaveLength(3);
  });

  it('projects every semantic focus treatment onto only its named rows', async () => {
    const fixture = buildStoryReviewHarnessFixture();
    const catalog = buildSemanticAnchorChangeBlockCatalog(
      fixture.reviewDiff,
      fixture.floor.coverage
    );
    const p1Hunk = catalog.hunks.find((candidate) => candidate.hunkKey === 'hunk_story_owned_p1')!;
    const p3Hunk = catalog.hunks.find((candidate) => candidate.hunkKey === 'hunk_story_owned_p3')!;
    const planId = fixture.model.overview!.citations[0]!;
    const p1Id = fixture.model.parts.find((part) => part.id === 'P1')!.citations[0]!;
    const uncertaintyId = fixture.model.parts.find((part) => part.id === 'P2')!.citations[0]!;
    const p3Id = fixture.model.parts.find((part) => part.id === 'P3')!.citations[0]!;
    const catalogOnly = Object.values(fixture.model.citations).find(
      (citation) => citation.text === 'Keep a separate stacked Story renderer.'
    )!;
    const anchors = semanticModel(fixture.floor.input_hash, [
      {
        citation_id: planId,
        citation_kind: 'PLAN_DECISION',
        disposition: 'ANCHORED',
        origin: 'REVIEW_MODEL_PROPOSED',
        targets: [
          semanticTarget(p1Hunk, { kind: 'whole' }),
          semanticTarget(p3Hunk, { kind: 'whole' }),
        ],
      },
      {
        citation_id: p1Id,
        citation_kind: 'CHECKPOINT_DECISION',
        disposition: 'ANCHORED',
        origin: 'REVIEW_MODEL_PROPOSED',
        targets: [
          semanticTarget(p1Hunk, {
            kind: 'accepted',
            side: 'add',
            start: 2,
            end: 2,
          }),
        ],
      },
      {
        citation_id: catalogOnly.id,
        citation_kind: 'CHECKPOINT_ALTERNATIVE',
        disposition: 'NO_ANCHOR_PROPOSED',
        origin: 'ENGINE_RECORDED_OMISSION',
        targets: [],
      },
      {
        citation_id: uncertaintyId,
        citation_kind: 'CHECKPOINT_UNCERTAINTY',
        disposition: 'ANCHORED',
        origin: 'REVIEW_MODEL_PROPOSED',
        targets: [semanticTarget(p1Hunk, { kind: 'rejected' })],
      },
      {
        citation_id: p3Id,
        citation_kind: 'CHECKPOINT_DECISION',
        disposition: 'ANCHORED',
        origin: 'REVIEW_MODEL_PROPOSED',
        targets: [semanticTarget(p3Hunk, { kind: 'whole' })],
      },
    ]);

    const { reader } = await storyReader(false, anchors);
    const itemFor = (text: string) =>
      [...reader.routeIndex.itemById.values()].find((item) => item.text === text)!;
    const placementsFor = (text: string) =>
      reader.routeIndex.semanticPlacementsByItemId.get(itemFor(text).id) ?? [];

    const accepted = placementsFor('Route Story code through deterministic diff primitives.');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      displayTarget: { kind: 'line', side: 'add', line: 2 },
      rowCursor: 1,
      highlightedRows: [{ side: 'add', line: 2 }],
      destination: { kind: 'page', pageKey: 'P1', hunkKey: 'hunk_story_owned_p1' },
    });

    const rejected = placementsFor('The context-only contract remains open.');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      target: {
        scope: 'FOCUS',
        focus_status: 'REJECTED_INVALID',
        focus_diagnostic_code: 'FOCUS_RANGE_INVALID',
      },
      displayTarget: { kind: 'line', side: 'add', line: 1 },
      highlightedRows: [
        { side: 'add', line: 1 },
        { side: 'add', line: 2 },
      ],
      destination: { kind: 'page', pageKey: 'P1' },
    });
    const uncertaintyItem = itemFor('The context-only contract remains open.');
    expect(
      reader.pages
        .filter((page) => page.kind === 'part')
        .filter((page) => page.railItems.some((item) => item.id === uncertaintyItem.id))
        .map((page) => page.key)
    ).toEqual(['P1', 'P2']);
    expect(uncertaintyItem.kind).toBe('uncertainty');

    const whole = placementsFor('Verify bounded Story review behavior.');
    expect(whole).toHaveLength(1);
    expect(whole[0]).toMatchObject({
      target: { scope: 'WHOLE_BLOCK', focus_status: 'NONE' },
      highlightedRows: [
        { side: 'add', line: 1 },
        { side: 'add', line: 2 },
      ],
      destination: { kind: 'page', pageKey: 'P3' },
    });

    const multiItem = itemFor('Use one shared shell for both review lenses.');
    const multi = placementsFor(multiItem.text);
    expect(multi.map((placement) => [placement.targetIndex, placement.locationIndex])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(multiItem).toMatchObject({
      targetCount: 2,
      locationCount: 2,
      placementState: 'anchored',
    });
    expect(reader.routeIndex.destinationsByItemId.get(multiItem.id)).toHaveLength(2);
  });

  it('keeps unanchored, omitted, and ordinary source context readable without code links', async () => {
    const fixture = buildStoryReviewHarnessFixture();
    const eligible = Object.values(fixture.model.citations).filter((citation) =>
      [
        'PLAN_DECISION',
        'CHECKPOINT_DECISION',
        'CHECKPOINT_ALTERNATIVE',
        'CHECKPOINT_UNCERTAINTY',
      ].includes(citation.kind)
    );
    const anchors = semanticModel(
      fixture.floor.input_hash,
      eligible.map((citation, index): SemanticAnchorModel['items'][number] =>
        index % 2 === 0
          ? {
              citation_id: citation.id,
              citation_kind: citation.kind as
                | 'PLAN_DECISION'
                | 'CHECKPOINT_DECISION'
                | 'CHECKPOINT_ALTERNATIVE'
                | 'CHECKPOINT_UNCERTAINTY',
              disposition: 'ASSESSED_UNANCHORED',
              origin: 'REVIEW_MODEL_REPORTED',
              targets: [],
            }
          : {
              citation_id: citation.id,
              citation_kind: citation.kind as
                | 'PLAN_DECISION'
                | 'CHECKPOINT_DECISION'
                | 'CHECKPOINT_ALTERNATIVE'
                | 'CHECKPOINT_UNCERTAINTY',
              disposition: 'NO_ANCHOR_PROPOSED',
              origin: 'ENGINE_RECORDED_OMISSION',
              targets: [],
            }
      )
    );

    const { reader } = await storyReader(false, anchors);
    expect(reader.routeIndex.semanticPlacementById.size).toBe(0);
    for (const citation of eligible) {
      const item = [...reader.routeIndex.itemById.values()].find(
        (candidate) => candidate.text === citation.text
      );
      expect(item, citation.text).toBeDefined();
      expect(item).toMatchObject({ placementState: 'unplaced', locationCount: 0 });
      expect(reader.routeIndex.destinationsByItemId.get(item!.id)).toEqual([
        { kind: 'item-detail', itemId: item!.id },
      ]);
    }

    const ordinary = [...reader.routeIndex.itemById.values()].find(
      (item) => item.text === 'Retain ordinary source context without inventing a code anchor.'
    )!;
    expect(ordinary.disposition).toBeUndefined();
    expect(ordinary.placementState).toBe('part-context');
    expect(reader.routeIndex.destinationsByItemId.get(ordinary.id)).toEqual([
      { kind: 'item-detail', itemId: ordinary.id },
    ]);
  });

  it('does not expose catalog-only citations when no anchor generation selected them', async () => {
    const { reader } = await storyReader();
    expect(
      [...reader.routeIndex.itemById.values()].some(
        (item) => item.text === 'Keep a separate stacked Story renderer.'
      )
    ).toBe(false);
    expect(reader.routeIndex.semanticPlacementById.size).toBe(0);
  });

  it('keeps CODE_ONLY routable without inventing authored Parts', async () => {
    const { reader } = await storyReader(true);
    expect(reader.pages.some((page) => page.kind === 'part')).toBe(false);
    expect(reader.pages.filter((page) => page.kind === 'checkpoint')).toHaveLength(4);
    expect(reader.routeIndex.briefRows.map((row) => row.kind)).toContain('attention');
    expect(reader.routeIndex.briefRows.map((row) => row.kind)).toContain('auxiliary');
    expect(reader.routeIndex.briefRows.at(-1)?.kind).toBe('finish');
  });
});
