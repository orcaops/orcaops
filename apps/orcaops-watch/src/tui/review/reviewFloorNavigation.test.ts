import { describe, expect, it } from 'vitest';

import { briefDestinationIndexForKey, buildBriefTree } from './briefTree';
import { activateBriefDestination, initialReviewControllerState } from './readerReviewController';
import { floorHunkForActivation } from './reviewFloorNavigation';
import {
  buildFixtureReader,
  buildWatchReviewFixture,
} from '../../../tests/review/reviewExperienceFixtures';

describe('deterministic floor navigation', () => {
  it('routes every Flat Files row to its retained diff identity', async () => {
    const fixture = await buildWatchReviewFixture('no-narrative');
    const state = initialReviewControllerState();

    // The Brief's cursor names a ReaderPage directly, so this answers only for
    // Flat Files.
    expect(floorHunkForActivation({ floor: fixture.source.floor, state })).toBeNull();
    for (const [index, hunk] of fixture.source.floor.coverage.items.entries()) {
      expect(
        floorHunkForActivation({
          floor: fixture.source.floor,
          state: { ...state, screen: 'flat-files', flatFileCursor: index },
        })
      ).toBe(hunk.hunkKey);
    }
  });

  it('keeps Brief activation inside the selected artifact when a hunk is shared', async () => {
    const fixture = await buildWatchReviewFixture('cross-artifact-shared-hunk');
    const reader = buildFixtureReader(fixture);
    const tree = buildBriefTree(reader);
    const selectedThread = fixture.source.floor.outline.threads[1]!;
    const selectedPage = reader.pages.find(
      (page) => page.kind === 'checkpoint' && page.threadKey === selectedThread.threadKey
    );
    if (selectedPage?.kind !== 'checkpoint') throw new Error('later checkpoint page missing');
    expect(selectedPage.member.artifact).toBe('artifact-later');

    const index = briefDestinationIndexForKey(tree, `checkpoint:${selectedPage.key}`);
    expect(index).not.toBeNull();
    const activated = activateBriefDestination(
      { ...initialReviewControllerState(), screen: 'brief' },
      reader,
      tree,
      index!
    );

    // A shared hunk is not allowed to send this selection back to the earlier
    // artifact: the leaf already named the page, so nothing is reconstructed.
    expect(reader.pages[activated.readerPage]?.key).toBe(selectedPage.key);
    expect(activated.screen).toBe('floor-diff');
    expect(activated.briefDestinationKey).toBe(`checkpoint:${selectedPage.key}`);
    expect(activated.briefCursor).toBe(index);
  });
});
