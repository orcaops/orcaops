import { describe, expect, it } from 'vitest';

import { buildReviewFloorFixture, type Floor } from '@orcaops/review-core';

import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
  rowsForEligibleTarget,
} from './reviewTargets.js';

function fixture(): { floor: Floor; diff: string } {
  const floor = structuredClone(buildReviewFloorFixture('clean').floor);
  floor.coverage.items = [
    {
      hunkKey: 'hunk_feature',
      file: 'src/feature.ts',
      verdict: 'UNEXPLAINED',
      old_start: 1,
      new_start: 1,
      added_lines: 3,
      removed_lines: 1,
      units: [
        {
          kind: 'owned_slice',
          slice: 0,
          patch_row_start: 0,
          patch_row_end: 1,
          del_range: { start: 1, end: 1 },
          add_range: { start: 1, end: 1 },
          lines: 2,
          owner: { kind: 'checkpoint', artifact: 'artifact-fixture', cp: 1 },
        },
        {
          kind: 'gap_slice',
          slice: 1,
          patch_row_start: 2,
          patch_row_end: 2,
          del_range: null,
          add_range: { start: 2, end: 2 },
          lines: 1,
          owner: null,
        },
        {
          kind: 'owned_slice',
          slice: 2,
          patch_row_start: 3,
          patch_row_end: 3,
          del_range: null,
          add_range: { start: 3, end: 3 },
          lines: 1,
          owner: { kind: 'checkpoint', artifact: 'artifact-fixture', cp: 2 },
        },
      ],
    },
  ];
  floor.outline.threads = [
    {
      threadKey: 'sec_feature',
      order: 1,
      title: 'Feature behavior',
      artifact: 'artifact-fixture',
      checkpoints: [
        {
          checkpointKey: 'chap_one',
          order: 1,
          checkpoint: { artifact: 'artifact-fixture', cp: 1, label: 'Add feature' },
          summary: 'Add feature',
          members: [{ artifact: 'artifact-fixture', cp: 1 }],
          sliceRefs: [{ hunkKey: 'hunk_feature', slice: 0 }],
          citationIds: [],
        },
        {
          checkpointKey: 'chap_two',
          order: 2,
          checkpoint: { artifact: 'artifact-fixture', cp: 2, label: 'Correct feature' },
          summary: 'Correct feature',
          members: [{ artifact: 'artifact-fixture', cp: 2 }],
          sliceRefs: [{ hunkKey: 'hunk_feature', slice: 2 }],
          citationIds: [],
        },
      ],
    },
    {
      threadKey: 'sec_empty',
      order: 2,
      title: 'No retained rows',
      artifact: 'artifact-fixture',
      checkpoints: [],
    },
  ];

  return {
    floor,
    diff: [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1,3 @@',
      '-oldFeature()',
      '+feature()',
      '+uncapturedGap()',
      '+correctedFeature()',
      '',
    ].join('\n'),
  };
}

describe('review targets', () => {
  it('mints the owned-slice target partition without durable ordinals', async () => {
    const { floor, diff } = fixture();
    const targets = await buildEligibleNarrativeTargets(floor, diff);

    expect(targets).toHaveLength(2);
    expect(targets.map((target) => target.threadKey)).toEqual(['sec_feature', 'sec_feature']);
    expect(targets[0]!.anchor.ranges.map((range) => range.side)).toEqual(['delete', 'add']);
    expect(targets[0]!.body).toEqual(['-oldFeature()', '+feature()']);
    expect(JSON.stringify(targets)).not.toContain('"slice"');
    expect(new Set(targets.map((target) => target.targetKey)).size).toBe(2);
    expect(rowsForEligibleTarget(targets[0]!)).toHaveLength(2);
  });

  it('derives gap rows from the retained patch', async () => {
    const { floor, diff } = fixture();

    const gapRows = await buildCurrentGapRows(floor, diff);

    expect(gapRows).toMatchObject([{ file: 'src/feature.ts', side: 'add', line: 2 }]);
    expect(gapRows.every((row) => row.lineHash.length > 0)).toBe(true);
  });

  it('emits every floor thread and refuses targets for unknown threads', async () => {
    const { floor, diff } = fixture();
    const targets = await buildEligibleNarrativeTargets(floor, diff);
    const manifests = await buildCurrentThreadManifests(floor, targets);

    expect(manifests.map(({ threadKey, rows }) => [threadKey, rows?.length ?? 0])).toEqual([
      ['sec_feature', 3],
      ['sec_empty', 0],
    ]);

    const orphan = { ...targets[0]!, threadKey: 'sec_not_in_this_floor' };
    await expect(buildCurrentThreadManifests(floor, [orphan])).rejects.toThrow(
      /references unknown sec_not_in_this_floor/
    );
  });
});
