// The stale Story LENS end to end: deterministic stays the default, the
// explicit toggle renders the stale narrative read-only, every prohibited
// command is suppressed with nothing reaching the journal or the comment
// sidecar, and staleness is announced on every stale-lens screen.

import { expect, test } from 'bun:test';

import type { Floor } from '@orcaops/review-core';
import type { StoryReviewModel } from '@orcaops/review-engine';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import {
  buildReviewAppHarness,
  loadedReviewJournalHarness,
  loadedReviewWithStoryFixture,
} from '../../../tests/review/reviewAppHarness';
import {
  buildStoryReviewHarnessAnchors,
  buildStoryReviewHarnessFixture,
  storyOverlay,
  type StoryReviewHarnessFixture,
} from '../../../tests/review/storyReviewHarness';

/**
 * 110 columns, not 160: this is the split threshold, where the Brief lays out
 * overview | divider | tree and the overview pane lands near 54 cells. It is
 * the geometry the stale rows are actually read at, so it is the geometry the
 * fixture mounts at. Below it the panes stack FULL-width and the pressure is
 * gone; above it there is enough room that a truncating row looks fine.
 */
const STALE_LENS_WIDTH = 110;

async function mountStale(
  input: {
    preferredLens?: 'story' | 'deterministic';
    /**
     * Floor-only mutation, the same lever `staleStoryProjection.test.ts` pulls:
     * dropping story-owned hunks from `floor.coverage.items` is what makes the
     * exact-match joins fail, so partial and narrative-only survival come out of
     * real reader construction rather than an assigned field.
     */
    mutateFloor?: (floor: Floor, fixture: StoryReviewHarnessFixture) => Floor;
    /**
     * Install the fixture's semantic anchors. Combined with `mutateFloor`
     * removing the hunks they target, this is how the anchor generation fails to
     * project and the reader reports `anchorsUnavailable`.
     */
    anchors?: boolean;
    /**
     * Story-model variant. Needed for per-Part `partial`, which a floor mutation
     * alone cannot reach: every code-owning Part in the fixture authors exactly
     * one segment, so it either survives whole or drops whole.
     */
    mutateModel?: (model: StoryReviewModel) => StoryReviewModel;
  } = {}
) {
  const fixture = buildStoryReviewHarnessFixture();
  const floor = input.mutateFloor
    ? input.mutateFloor(structuredClone(fixture.floor) as Floor, fixture)
    : fixture.floor;
  const model = input.mutateModel
    ? input.mutateModel(structuredClone(fixture.model))
    : fixture.model;
  const base = await buildReviewAppHarness({ scenario: 'no-narrative' });
  const current = await storyOverlay(model, {
    runId: 'stale-story-run',
    installationToken: 'stale-story-install',
    // Built against the ORIGINAL fixture, so a mutated floor leaves their
    // targets pointing at change blocks the catalog no longer carries.
    ...(input.anchors === true ? { anchors: buildStoryReviewHarnessAnchors(fixture) } : {}),
  });
  // The same validated model, resolved STALE: its floor hash no longer matches
  // the loaded floor, exactly what the resolver now retains.
  const routineStory = {
    ...current,
    status: 'stale' as const,
    issue: 'STALE_STORY: installed floor moved',
    model: { ...model, floor_input_hash: 'floor-that-moved' },
  };
  const loaded = await loadedReviewWithStoryFixture({
    base: base.loaded,
    floor,
    reviewDiff: fixture.reviewDiff,
    routineStory,
  });
  const journal = await loadedReviewJournalHarness(loaded);
  const app = await mountReviewApp({
    scenario: 'no-narrative',
    width: STALE_LENS_WIDTH,
    height: 52,
    ...(input.preferredLens === undefined
      ? {}
      : { controllerState: { preferredLens: input.preferredLens } }),
    initialLoadedOverride: journal.loaded,
    journalEffects: journal.journalEffects,
  });
  return { app, journal, fixture };
}

/** Every story-owned hunk removed from the floor: no exact match can survive. */
function dropEveryStoryHunk(floor: Floor, fixture: StoryReviewHarnessFixture): Floor {
  const storyHunks = new Set(
    fixture.model.parts.flatMap((part) => [
      ...part.segments.map((segment) => segment.hunkKey),
      ...part.ambiguous.map((entry) => entry.hunkKey),
    ])
  );
  floor.coverage.items = floor.coverage.items.filter((item) => !storyHunks.has(item.hunkKey));
  return floor;
}

test('deterministic remains the default lens when the Story is stale', async () => {
  const { app } = await mountStale();
  const frame = app.frame();
  // The Brief carries the full stale banner and reads the captured checkpoints.
  expect(frame).toContain('STORY STALE');
  expect(frame).toContain('Reading · captured checkpoints');
  expect(frame).not.toContain('read-only');
  app.unmount();
});

test('the explicit Story preference renders the stale narrative with health and read-only marking', async () => {
  const { app, journal } = await mountStale({ preferredLens: 'story' });
  const brief = app.frame();
  // The Story lens mounted on the stale model: banner prose plus match health.
  expect(brief).toContain('Stale ·');
  expect(brief).toContain('code mapping(s) current · read-only');
  // The overview pane is ~54 cells here, so the banner wraps: assert on a
  // phrase that fits one physical line rather than on the whole sentence.
  expect(brief).toContain('The branch replaces a stacked Story');

  // Open the first Part. VISIT suppression: opening appends NOTHING.
  const rect = app.surfaceRect('review-brief-leaf-0');
  await app.mockMouse.click(rect.x + 1, rect.y);
  await app.settle();
  expect(app.state().screen).toBe('walk');
  expect(journal.journalEvents).toHaveLength(0);

  // The compact stale indicator follows the lens off the Brief.
  expect(app.frame()).toContain('STALE STORY · read-only view');

  // The footer advertises no mutating command on the stale lens.
  expect(app.frame()).not.toContain('m reviewed');

  // Every prohibited command is inert: nothing reaches the journal or sidecar.
  const before = { journal: journal.journalEvents.length, comments: app.sidecar().length };
  await app.press('m');
  await app.press('\t');
  for (const key of ['a', 'r', 'd', 'o']) await app.press(key);
  expect(journal.journalEvents.length).toBe(before.journal);
  expect(app.sidecar().length).toBe(before.comments);

  // Surviving exact mappings still navigate: the diff cursor moves code.
  await app.press('\t');
  await app.press('j');
  expect(app.state().diffHunkKey).toBeTruthy();
  app.unmount();
});

test('the stale health row wraps rather than cutting "anchors unavailable"', async () => {
  // Every story-owned hunk gone AND the anchor generation installed: no exact
  // match survives and the anchors cannot project, which is the one state where
  // the health row carries its longest form.
  const { app } = await mountStale({
    preferredLens: 'story',
    anchors: true,
    mutateFloor: dropEveryStoryHunk,
  });
  const rows = app.frame().split('\n');
  const head = rows.findIndex((row) => row.includes('Stale · 0/'));
  expect(head).toBeGreaterThan(-1);

  // The clause that says the placements are gone lands on a CONTINUATION line:
  // a single-line row at this pane cuts exactly here, and it cut this first.
  expect(rows[head]).not.toContain('anchors unavailable');
  expect(rows[head + 1]).toContain('anchors unavailable');
  // Wrapped, not ellipsized — nothing was dropped to make it fit.
  expect(rows[head]).not.toContain('…');
  expect(rows[head + 1]).not.toContain('…');
  expect(rows[head]).toContain('read-only');

  // The extra physical line was BUDGETED, not stolen: the attention window and
  // both truth bands still sit inside the initial viewport, in order.
  const attention = rows.findIndex((row) => row.includes('▸ ATTENTION'));
  const coverage = rows.findIndex((row) => row.includes('▸ COVERAGE'));
  const trail = rows.findIndex((row) => row.includes('▸ CAPTURED TRAIL'));
  expect(attention).toBeGreaterThan(head + 1);
  expect(coverage).toBeGreaterThan(attention);
  expect(trail).toBeGreaterThan(coverage);
  expect(app.frame()).toContain('n/N select · ↵ open');
  app.unmount();
});

test('the stale residue page neither advertises nor accepts mark inspected', async () => {
  const { app, journal } = await mountStale({ preferredLens: 'story' });
  // Walk the Brief's tree onto the Residue leaf and open it.
  await app.pressAll(['j', 'j', 'j', '\r']);
  expect(app.state().screen).toBe('unassigned');

  // The footer must not advertise `m inspected` here: it is priority 1 and
  // required, so width pressure could not drop it, while the executor refuses it.
  expect(app.frame()).not.toContain('m inspected');

  const before = { journal: journal.journalEvents.length, comments: app.sidecar().length };
  await app.press('m');

  // Nothing was written, and — the part a write-count assertion cannot show —
  // the key never REACHED the executor: had the gesture still resolved, the
  // read-only guard would have answered with its refusal notice.
  expect(journal.journalEvents.length).toBe(before.journal);
  expect(app.sidecar().length).toBe(before.comments);
  expect(app.state().notice).not.toBe(
    'Read-only stale Story — switch to the captured-checkpoint lens to act'
  );
  expect(app.state().screen).toBe('unassigned');
  app.unmount();
});

/** Open the nth Attention row from a FRESH Brief, so the transition is that route and nothing else. */
async function openAttentionRow(
  index: number,
  mutateFloor?: (floor: Floor, fixture: StoryReviewHarnessFixture) => Floor
) {
  const mounted = await mountStale({
    preferredLens: 'story',
    ...(mutateFloor === undefined ? {} : { mutateFloor }),
  });
  for (let step = 0; step <= index; step += 1) await mounted.app.press('n');
  await mounted.app.press('\r');
  const seen = { screen: mounted.app.state().screen, notice: mounted.app.state().notice };
  mounted.app.unmount();
  return seen;
}

test('the stale attention queue routes identically whether or not the mappings survived', async () => {
  // This queue does not degrade to the reconciler's "no longer represented"
  // notice, and cannot: that string is set by the projection reconciler on a
  // reader REBUILD, while ↵ on an attention row calls activateBriefAttentionItem
  // directly and never reaches it. What the queue does is route each item to its
  // own authored placement — a flat file for the forensic finding, the
  // captured-context detail for the account question — and neither placement is a
  // function of stale survival.
  const survived = [await openAttentionRow(0), await openAttentionRow(1)];
  const dropped = [
    await openAttentionRow(0, dropEveryStoryHunk),
    await openAttentionRow(1, dropEveryStoryHunk),
  ];

  expect(dropped).toEqual(survived);
  expect(survived[0]).toEqual({ screen: 'flat-files', notice: 'Select src/story.ts' });
  expect(survived[1]).toEqual({ screen: 'captured-context', notice: null });
  for (const step of dropped) {
    // Neither notice claims the evidence went missing, so there is nothing here
    // for a stale-specific message to replace.
    expect(step.notice).not.toBe('The requested evidence is no longer represented in this reader');
  }
});

const GENERIC_UNAVAILABLE = 'Selected evidence is not represented on any review page';
const DROPPED_MAPPING = 'Code mapping unavailable · dropped by the stale Story projection';

/**
 * Walk to flat-files and activate the row at `row`, returning the notice.
 *
 * `n` pressed while OFF the Brief moves the attention selection without leaving
 * the screen, so the following ↵ goes through that screen's own activate branch
 * — which is the branch that reports why a row will not open.
 */
async function activateFlatFileRow(
  row: number,
  options: Parameters<typeof mountStale>[0]
): Promise<string | null> {
  const mounted = await mountStale({ preferredLens: 'story', ...options });
  await mounted.app.press('n');
  await mounted.app.press('\r');
  expect(mounted.app.state().screen).toBe('flat-files');
  for (let step = 0; step < row; step += 1) await mounted.app.press('j');
  await mounted.app.press('n');
  await mounted.app.press('\r');
  expect(mounted.app.state().screen).toBe('flat-files');
  const notice = mounted.app.state().notice;
  mounted.app.unmount();
  return notice;
}

test('a residue row under a stale Story is NOT blamed on the projection', async () => {
  // Cursor 0 of the flat-files list once the Part hunks leave the floor is
  // `hunk_story_contested` — residue, which reaches no Story page whether every
  // mapping survived or none did. Nothing dropped it; it was never a mapping.
  // The previous artifact asserted the dropped-mapping message on exactly this
  // walk, which certified a false statement.
  const notice = await activateFlatFileRow(0, { mutateFloor: dropEveryStoryHunk });
  expect(notice).toBe(GENERIC_UNAVAILABLE);
});

test('a Part-authored mapping the projection dropped says so', async () => {
  // The hunk STAYS in the floor — so flat-files still lists it — while its
  // exact-match join fails, which is what makes the projection drop it. Removing
  // the coverage item instead would take the row out of the list entirely, which
  // is why the previous artifact never reached this case.
  const notice = await activateFlatFileRow(0, {
    mutateFloor: (floor) => {
      const item = floor.coverage.items.find(
        (candidate) => candidate.hunkKey === 'hunk_story_owned_p1'
      )!;
      for (const unit of item.units) {
        if (unit.kind === 'owned_slice' && unit.owner?.kind === 'checkpoint') {
          unit.owner = { ...unit.owner, cp: unit.owner.cp + 90 };
        }
      }
      return floor;
    },
  });
  expect(notice).toBe(DROPPED_MAPPING);
  // The vocabulary is the Part rail's — singular here because it is one row —
  // so the two surfaces name one thing once instead of twice.
  expect(notice).toMatch(/^Code mapping unavailable · /);
});

test('lifecycle actions from the stale lens are refused with a lens hint', async () => {
  const { app, journal } = await mountStale({ preferredLens: 'story' });
  // Route to the finish screen directly; the finish keys are suppressed and the
  // executor refuses even a programmatic invocation.
  await app.press('F');
  await app.settle();
  await app.press('\r');
  await app.press('p');
  await app.press('r');
  expect(journal.journalEvents.filter((event) => event.type === 'review_lifecycle')).toHaveLength(
    0
  );
  app.unmount();
});
/** P1 also owns P3's segment and checkpoint, so one moved thread leaves it partial. */
function spanTwoThreads(model: StoryReviewModel): StoryReviewModel {
  const donor = model.parts.find((part) => part.id === 'P3')!;
  const segment = donor.segments[0]!;
  return {
    ...model,
    parts: model.parts.map((part) => {
      if (part.id === 'P1') {
        return {
          ...part,
          checkpointRefs: [...part.checkpointRefs, ...donor.checkpointRefs],
          segments: [...part.segments, segment],
          changedRows: part.changedRows + segment.lines,
        };
      }
      if (part.id === 'P3') return { ...part, segments: [], changedRows: 0, contextOnly: true };
      return part;
    }),
  };
}

/** The Part rail's column width on this fixture, up to but not including its rule. */
const RAIL_COLUMNS = 36;

/**
 * Open the nth leaf of the Brief's tree and return the Part RAIL as one line.
 *
 * The rail is ~35 cells, so every line asserted here wraps across two physical
 * rows, and the diff column to its right interleaves between the halves. Take
 * the rail's columns and flatten them, so the assertions read the copy the
 * reviewer reads rather than the column it happened to break in.
 */
async function openPartLeaf(
  leaf: number,
  options: Parameters<typeof mountStale>[0] = {}
): Promise<{ text: string; screen: string; unmount: () => void }> {
  const mounted = await mountStale({ preferredLens: 'story', ...options });
  for (let step = 0; step < leaf; step += 1) await mounted.app.press('j');
  await mounted.app.press('\r');
  return {
    text: mounted.app
      .frame()
      .split('\n')
      .map((row) => row.slice(0, RAIL_COLUMNS))
      .join(' ')
      .replace(/\s+/g, ' '),
    screen: mounted.app.state().screen,
    unmount: () => mounted.app.unmount(),
  };
}

const NARRATIVE_ONLY_LINE = 'Code mappings unavailable · narrative preserved';
const PARTIAL_LINE = 'Some code mappings unavailable · surviving links navigate';

test('a Part whose code mappings all dropped says so on the Part itself', async () => {
  // The Brief carries ONE aggregate count for the whole projection. It cannot say
  // which Part in front of you lost its code — all others are labeled unavailable.
  const opened = await openPartLeaf(0, { mutateFloor: dropEveryStoryHunk });
  expect(opened.screen).toBe('walk');
  expect(opened.text).toContain(NARRATIVE_ONLY_LINE);
  expect(opened.text).not.toContain(PARTIAL_LINE);
  // Narrative preserved is not a figure of speech: the Part's own account is
  // still on the page under it.
  expect(opened.text).toContain('Use the deterministic diff structure for Story-owned code.');
  opened.unmount();
});

test('a Part that kept some mappings says only some are unavailable', async () => {
  const opened = await openPartLeaf(0, {
    mutateModel: spanTwoThreads,
    mutateFloor: (floor) => {
      floor.coverage.items = floor.coverage.items.filter(
        (item) => item.hunkKey !== 'hunk_story_owned_p3'
      );
      return floor;
    },
  });
  expect(opened.screen).toBe('walk');
  expect(opened.text).toContain(PARTIAL_LINE);
  expect(opened.text).not.toContain(NARRATIVE_ONLY_LINE);
  opened.unmount();
});

// P1 authors one segment AND one ambiguous hunk, and the projection turns both
// into cursor stops. Health that counted only the segment could therefore be
// wrong in either direction, and each direction rendered its own lie.
const P1_SEGMENT_HUNK = 'hunk_story_owned_p1';
const P1_AMBIGUOUS_HUNK = 'hunk_story_same_part';
const dropHunk = (hunkKey: string) => (floor: Floor) => {
  floor.coverage.items = floor.coverage.items.filter((item) => item.hunkKey !== hunkKey);
  return floor;
};

test('a Part that lost its segment but kept an ambiguous hunk says only SOME are unavailable', async () => {
  // The ambiguous hunk is still a cursor stop, so the amber "nothing here will
  // navigate" line would be false on a page the reviewer can still walk.
  const opened = await openPartLeaf(0, { mutateFloor: dropHunk(P1_SEGMENT_HUNK) });
  expect(opened.screen).toBe('walk');
  expect(opened.text).toContain(PARTIAL_LINE);
  expect(opened.text).not.toContain(NARRATIVE_ONLY_LINE);
  opened.unmount();
});

test('a Part that lost its ambiguous hunk but kept its segment still says so', async () => {
  // A mapping died. 'current' renders NOTHING, so counting segments alone made
  // this loss invisible rather than merely mislabeled.
  const opened = await openPartLeaf(0, { mutateFloor: dropHunk(P1_AMBIGUOUS_HUNK) });
  expect(opened.screen).toBe('walk');
  expect(opened.text).toContain(PARTIAL_LINE);
  expect(opened.text).not.toContain(NARRATIVE_ONLY_LINE);
  opened.unmount();
});

test("the Brief's aggregate counts ambiguous hunks the same way the Part does", async () => {
  // Read the printed row rather than the model: this is the one number the
  // reviewer sees for the whole projection, and it must not disagree with the
  // per-Part line on what a code mapping is.
  const readCount = async (mutateFloor?: (floor: Floor) => Floor): Promise<[number, number]> => {
    const { app } = await mountStale({
      preferredLens: 'story',
      ...(mutateFloor === undefined ? {} : { mutateFloor }),
    });
    const row = app
      .frame()
      .split('\n')
      .find((line) => line.includes('Stale · '))!;
    const match = /Stale · (\d+)\/(\d+) code mapping\(s\) current/.exec(row)!;
    app.unmount();
    return [Number(match[1]), Number(match[2])];
  };

  const [survivingAll, totalAll] = await readCount();
  expect(survivingAll).toBe(totalAll);

  // Dropping ONLY the ambiguous hunk moves the numerator. Under a segment-only
  // count this row was identical to the line above it.
  const [surviving, total] = await readCount(dropHunk(P1_AMBIGUOUS_HUNK));
  expect(total).toBe(totalAll);
  expect(surviving).toBe(survivingAll - 1);
});

test('a fully surviving Part and a context-only Part carry no degradation line', async () => {
  // Nothing moved but the floor hash: every mapping still joins, so the page
  // says nothing about health. Silence is the correct rendering of 'current'.
  const survived = await openPartLeaf(0);
  expect(survived.screen).toBe('walk');
  expect(survived.text).not.toContain('unavailable');
  survived.unmount();

  // P2 authored no segments at all. It must NOT be labeled as having lost its
  // mappings — it never had any — so it keeps its own context-only line and no
  // health line, at full survival and at none.
  for (const mutateFloor of [undefined, dropEveryStoryHunk]) {
    const contextOnly = await openPartLeaf(1, {
      ...(mutateFloor === undefined ? {} : { mutateFloor }),
    });
    expect(contextOnly.screen).toBe('walk');
    expect(contextOnly.text).toContain('Context-only · no changed rows are owned by this Part');
    expect(contextOnly.text).not.toContain(NARRATIVE_ONLY_LINE);
    expect(contextOnly.text).not.toContain(PARTIAL_LINE);
    contextOnly.unmount();
  }
});
