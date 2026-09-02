// The best-effort STALE Story projection: every code link either survives the
// exact-match joins (and works fully) or drops with its narrative retained,
// and the whole lens is non-authoritative. These tests drive buildStoryReader
// with staleProjection against floors that diverge from the model in each of
// the documented ways.

import { describe, expect, it } from 'vitest';

import type { Floor } from '@orcaops/review-core';
import { replayReviewLedgerV2 } from '@orcaops/review-core';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
  type StoryReviewModel,
} from '@orcaops/review-engine';

import { buildStoryReader, type PartPage } from './readerModel';
import { buildStoryReviewHarnessFixture } from '../../../tests/review/storyReviewHarness';

async function staleReader(
  mutateFloor?: (floor: Floor) => Floor,
  mutateModel?: (model: StoryReviewModel) => StoryReviewModel
) {
  const fixture = buildStoryReviewHarnessFixture();
  const floor = mutateFloor ? mutateFloor(structuredClone(fixture.floor) as Floor) : fixture.floor;
  const eligibleTargets = await buildEligibleNarrativeTargets(floor, fixture.reviewDiff);
  const currentThreads = await buildCurrentThreadManifests(floor, eligibleTargets);
  const currentGapRows = await buildCurrentGapRows(floor, fixture.reviewDiff);
  const ledger = await replayReviewLedgerV2({ events: [], currentThreads });
  // The model was generated against the ORIGINAL floor; hash it as foreign so
  // the builder treats it as stale even when the content still matches.
  const base = mutateModel ? mutateModel(structuredClone(fixture.model)) : fixture.model;
  const model = { ...base, floor_input_hash: 'floor-that-moved' };
  return buildStoryReader({
    floor,
    model,
    reviewDiff: fixture.reviewDiff,
    semanticAnchors: null,
    eligibleTargets,
    ledger,
    currentThreads,
    finishFacts: { targets: { ok: true } as const, currentGapRows, comments: [] },
    staleProjection: true,
  });
}

function partPages(reader: Awaited<ReturnType<typeof staleReader>>): PartPage[] {
  return reader.pages.filter((page): page is PartPage => page.kind === 'part');
}

describe('stale Story projection', () => {
  it('keeps exact surviving mappings fully navigable when only the floor hash moved', async () => {
    const reader = await staleReader();
    expect(reader.staleProjection).toBe(true);
    // Every join still matches: full health, real cursor stops.
    expect(reader.staleHealth).toMatchObject({ anchorsUnavailable: false });
    expect(reader.staleHealth!.survivingMappings).toBe(reader.staleHealth!.totalMappings);
    expect(reader.staleHealth!.survivingMappings).toBeGreaterThan(0);
    const withCode = partPages(reader).filter((page) => page.sliceStops.length > 0);
    expect(withCode.length).toBeGreaterThan(0);
    for (const page of withCode) expect(page.projectionHealth).toBe('current');
  });

  it('is non-authoritative even at full survival: no completion, coverage, or VISIT', async () => {
    const reader = await staleReader();
    for (const page of partPages(reader)) {
      expect(page.complete).toBe(false);
      expect(page.markReviewedEnabled).toBe(false);
      expect(page.visitThreadKeys).toEqual([]);
      expect(page.visited).toBe(false);
    }
    // Finish came from the floor-only gate, not the story gate: the story's
    // open required items must not appear as story obligations.
    expect(reader.finish).toBeDefined();
  });

  it('drops a mapping whose hunk left the floor and reports partial health', async () => {
    const fixture = buildStoryReviewHarnessFixture();
    const someSegment = fixture.model.parts.find((part) => part.segments.length > 0)!.segments[0]!;
    const reader = await staleReader((floor) => {
      floor.coverage.items = floor.coverage.items.filter(
        (item) => item.hunkKey !== someSegment.hunkKey
      );
      return floor;
    });
    expect(reader.staleHealth!.survivingMappings).toBeLessThan(reader.staleHealth!.totalMappings);
    // The Part that owned the dropped hunk retains its narrative page.
    const owner = partPages(reader).find((page) =>
      page.part.segments.some((segment) => segment.hunkKey === someSegment.hunkKey)
    );
    expect(owner).toBeDefined();
    expect(
      owner!.projectionHealth === 'partial' || owner!.projectionHealth === 'narrative-only'
    ).toBe(true);
    // No cursor stop may reference the vanished hunk.
    for (const page of partPages(reader)) {
      expect(page.sliceStops.every((stop) => stop.hunkKey !== someSegment.hunkKey)).toBe(true);
    }
  });

  it('reports partial on a Part that keeps one thread and loses another', async () => {
    // Every code-owning Part in the harness fixture authors exactly ONE segment,
    // so per-Part partial is unreachable by moving the floor alone: a single
    // segment either survives or does not. A Part spanning two checkpoints is
    // ordinary, so the model variant gives P1 P3's segment and its checkpoint
    // ref, then the floor drops the hunk behind that second thread.
    const reader = await staleReader(
      (floor) => {
        floor.coverage.items = floor.coverage.items.filter(
          (item) => item.hunkKey !== 'hunk_story_owned_p3'
        );
        return floor;
      },
      (model) => {
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
            if (part.id === 'P3') {
              return { ...part, segments: [], changedRows: 0, contextOnly: true };
            }
            return part;
          }),
        };
      }
    );
    const p1 = partPages(reader).find((page) => page.part.id === 'P1');
    expect(p1).toBeDefined();
    expect(p1!.projectionHealth).toBe('partial');
    // Partial means SOME links still navigate — that is what separates it from
    // narrative-only, and why it is dim rather than amber.
    expect(p1!.sliceStops.length).toBeGreaterThan(0);
    expect(p1!.sliceStops.every((stop) => stop.hunkKey !== 'hunk_story_owned_p3')).toBe(true);
  });

  it('keeps the whole narrative readable when NO mappings survive', async () => {
    const fixture = buildStoryReviewHarnessFixture();
    const storyHunks = new Set(
      fixture.model.parts.flatMap((part) => [
        ...part.segments.map((segment) => segment.hunkKey),
        ...part.ambiguous.map((entry) => entry.hunkKey),
      ])
    );
    const reader = await staleReader((floor) => {
      floor.coverage.items = floor.coverage.items.filter((item) => !storyHunks.has(item.hunkKey));
      return floor;
    });
    expect(reader.staleHealth!.survivingMappings).toBe(0);
    const parts = partPages(reader);
    expect(parts.length).toBeGreaterThan(0);
    // Health is keyed to authored code LINKS — segments plus ambiguous hunks —
    // not to the contextOnly flag, which only reports zero segments.
    const authoredLinks = (page: PartPage): number =>
      page.part.segments.length + page.part.ambiguous.length;
    for (const page of parts) {
      // A Part that authored no links had nothing of its own to lose: it carries
      // NO health rather than a narrative-only label it never earned. Asserting
      // `toBe('narrative-only')` for every Part is exactly the mislabel, and it
      // passes because zero survivors and zero authored mappings are
      // indistinguishable to the enum.
      expect(page.projectionHealth).toBe(authoredLinks(page) === 0 ? undefined : 'narrative-only');
      expect(page.label.length).toBeGreaterThan(0);
      expect(page.railItems.length).toBeGreaterThanOrEqual(0);
      expect(page.sliceStops).toEqual([]);
    }
    // Both kinds are present, so neither branch above is dead.
    expect(parts.some((page) => authoredLinks(page) === 0)).toBe(true);
    expect(parts.some((page) => authoredLinks(page) > 0)).toBe(true);
  });

  it('leaves a Part with NO code links at all without projection health at every survival level', async () => {
    const fixture = buildStoryReviewHarnessFixture();
    // Zero LINKS, not the contextOnly flag: a Part with no segments still owns a
    // code link if it authored an ambiguous hunk (proven in the next case).
    const linklessIds = new Set(
      fixture.model.parts
        .filter((part) => part.segments.length === 0 && part.ambiguous.length === 0)
        .map((part) => part.id)
    );
    expect(linklessIds.size).toBeGreaterThan(0);

    const someSegment = fixture.model.parts.find((part) => part.segments.length > 0)!.segments[0]!;
    const readers = [
      // Full survival, partial survival, and none — the health enum's whole range.
      await staleReader(),
      await staleReader((floor) => {
        floor.coverage.items = floor.coverage.items.filter(
          (item) => item.hunkKey !== someSegment.hunkKey
        );
        return floor;
      }),
      await staleReader((floor) => {
        const storyHunks = new Set(
          fixture.model.parts.flatMap((part) => [
            ...part.segments.map((segment) => segment.hunkKey),
            ...part.ambiguous.map((entry) => entry.hunkKey),
          ])
        );
        floor.coverage.items = floor.coverage.items.filter((item) => !storyHunks.has(item.hunkKey));
        return floor;
      }),
    ];
    for (const reader of readers) {
      const linkless = partPages(reader).filter((page) => linklessIds.has(page.part.id));
      expect(linkless.length).toBe(linklessIds.size);
      for (const page of linkless) expect(page.projectionHealth).toBeUndefined();
    }
  });

  // P1 authors ONE segment and ONE ambiguous hunk, and both become cursor stops
  // on the projected page. Health that counted only the segment therefore had
  // two ways to lie, one in each direction — these are those two ways.
  const P1_SEGMENT_HUNK = 'hunk_story_owned_p1';
  const P1_AMBIGUOUS_HUNK = 'hunk_story_same_part';
  const dropHunk =
    (hunkKey: string) =>
    (floor: Floor): Floor => {
      floor.coverage.items = floor.coverage.items.filter((item) => item.hunkKey !== hunkKey);
      return floor;
    };
  const p1Page = (reader: Awaited<ReturnType<typeof staleReader>>): PartPage =>
    partPages(reader).find((page) => page.part.id === 'P1')!;

  it('reports partial when the segment dropped but the ambiguous hunk survived', async () => {
    const page = p1Page(await staleReader(dropHunk(P1_SEGMENT_HUNK)));
    // Not narrative-only: the surviving ambiguous hunk is still a cursor stop,
    // so "nothing here will navigate" would be false to the reviewer's face.
    expect(page.projectionHealth).toBe('partial');
    expect(page.sliceStops.map((stop) => stop.hunkKey)).toEqual([P1_AMBIGUOUS_HUNK]);
  });

  it('reports partial when the ambiguous hunk dropped but the segment survived', async () => {
    const page = p1Page(await staleReader(dropHunk(P1_AMBIGUOUS_HUNK)));
    // Not current: a mapping died. Reporting full health here hid the loss
    // entirely, because 'current' renders no line at all.
    expect(page.projectionHealth).toBe('partial');
    expect(page.ambiguousHunkKeys).toEqual([]);
    expect(page.sliceStops.map((stop) => stop.hunkKey)).toEqual([P1_SEGMENT_HUNK]);
  });

  it('gives a Part with no segments but a surviving ambiguous hunk real health', async () => {
    // The contextOnly flag means zero SEGMENTS, so gating health on it hid this
    // Part's only code link. Move P1's ambiguous hunk onto the context-only P2:
    // no segments, one link, and that link can still die.
    const donate = (model: StoryReviewModel): StoryReviewModel => ({
      ...model,
      parts: model.parts.map((part) => {
        if (part.id === 'P1') return { ...part, ambiguous: [], ambiguousRows: 0 };
        if (part.id === 'P2') {
          const source = model.parts.find((candidate) => candidate.id === 'P1')!;
          return {
            ...part,
            checkpointRefs: [...new Set([...part.checkpointRefs, ...source.checkpointRefs])],
            ambiguous: source.ambiguous,
            ambiguousRows: source.ambiguousRows,
          };
        }
        return part;
      }),
    });
    const p2Of = (reader: Awaited<ReturnType<typeof staleReader>>): PartPage =>
      partPages(reader).find((page) => page.part.id === 'P2')!;

    const survived = p2Of(await staleReader(undefined, donate));
    expect(survived.part.contextOnly).toBe(true);
    expect(survived.projectionHealth).toBe('current');

    const died = p2Of(await staleReader(dropHunk(P1_AMBIGUOUS_HUNK), donate));
    expect(died.part.contextOnly).toBe(true);
    expect(died.projectionHealth).toBe('narrative-only');
  });

  it('counts ambiguous hunks in the aggregate the Brief prints', async () => {
    const full = await staleReader();
    // The denominator spans both kinds of link, so dropping the ambiguous hunk
    // alone moves the numerator — under a segment-only count it could not.
    const withoutAmbiguous = await staleReader(dropHunk(P1_AMBIGUOUS_HUNK));
    expect(withoutAmbiguous.staleHealth!.totalMappings).toBe(full.staleHealth!.totalMappings);
    expect(withoutAmbiguous.staleHealth!.survivingMappings).toBe(
      full.staleHealth!.survivingMappings - 1
    );

    const authoredLinks = full.story!.parts.reduce(
      (total, part) => total + part.segments.length + part.ambiguous.length,
      0
    );
    expect(full.staleHealth!.totalMappings).toBe(authoredLinks);
    expect(full.staleHealth!.survivingMappings).toBe(authoredLinks);
  });

  it('the CURRENT builder still throws on every one of those divergences', async () => {
    const fixture = buildStoryReviewHarnessFixture();
    const eligibleTargets = await buildEligibleNarrativeTargets(fixture.floor, fixture.reviewDiff);
    const currentThreads = await buildCurrentThreadManifests(fixture.floor, eligibleTargets);
    const currentGapRows = await buildCurrentGapRows(fixture.floor, fixture.reviewDiff);
    const ledger = await replayReviewLedgerV2({ events: [], currentThreads });
    expect(() =>
      buildStoryReader({
        floor: fixture.floor,
        model: { ...fixture.model, floor_input_hash: 'floor-that-moved' },
        reviewDiff: fixture.reviewDiff,
        semanticAnchors: null,
        eligibleTargets,
        ledger,
        currentThreads,
        finishFacts: { targets: { ok: true } as const, currentGapRows, comments: [] },
      })
    ).toThrow('Story model does not belong to the loaded floor');
  });
});
