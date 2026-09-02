import { ATTRIBUTION_RUNG, type Floor, FLOOR_SCHEMA_VERSION, floorSchema } from './schema.js';

export type ReviewFloorFixtureScenario = 'clean' | 'unassigned';

export interface ReviewFloorFixture {
  scenario: ReviewFloorFixtureScenario;
  floor: Floor;
}

function baseFloor(): Floor {
  return {
    schema_version: FLOOR_SCHEMA_VERSION,
    input_hash: 'floor_hash_v2',
    generated_at: '2026-07-12T00:00:00.000Z',
    scope: {
      branch: 'fixture/group-1',
      branch_slug: 'fixture%2Fgroup-1',
      base_sha: 'base',
      pinned_tree_sha: 'tree',
      head_sha: 'head',
      default_branch: 'main',
      artifact_ids: ['artifact-fixture'],
      threads: [
        {
          artifact: 'artifact-fixture',
          branch: 'fixture/group-1',
          label: 'Fixture',
          first_activity_at: '2026-07-12T00:00:00.000Z',
        },
      ],
    },
    coverage: {
      items: [
        {
          hunkKey: 'hunk_fixture',
          file: 'src/fixture.ts',
          verdict: 'MATCHED',
          old_start: 1,
          new_start: 1,
          added_lines: 1,
          removed_lines: 0,
          units: [
            {
              kind: 'owned_slice',
              slice: 0,
              patch_row_start: 0,
              patch_row_end: 0,
              del_range: null,
              add_range: { start: 1, end: 1 },
              lines: 1,
              owner: { kind: 'checkpoint', artifact: 'artifact-fixture', cp: 1 },
            },
          ],
        },
      ],
      summary: {
        excluded: 0,
        unreviewable: 0,
        matched_rows: 1,
        unexplained_rows: 0,
        ambiguous_rows: 0,
        reviewable_rows: 1,
      },
    },
    attribution: { active_rung: ATTRIBUTION_RUNG.SNAPSHOT_CHAIN },
    integrity: [{ artifact: 'artifact-fixture', cp: 1, verified: true }],
    outline: {
      threads: [
        {
          threadKey: 'sec_fixture',
          order: 1,
          title: 'Deterministic fixture section',
          artifact: 'artifact-fixture',
          checkpoints: [
            {
              checkpointKey: 'chap_fixture',
              order: 1,
              checkpoint: { artifact: 'artifact-fixture', cp: 1, label: 'Fixture checkpoint' },
              summary: 'Fixture checkpoint',
              members: [{ artifact: 'artifact-fixture', cp: 1 }],
              sliceRefs: [{ hunkKey: 'hunk_fixture', slice: 0 }],
              citationIds: ['cite:artifact-fixture:cp1:decision:0'],
            },
          ],
        },
      ],
      unassigned: {
        gap: { sliceRefs: [], files: [] },
        ambiguous: { hunkKeys: [], files: [] },
      },
    },
    plan_coverage: [],
    citations: [
      {
        id: 'cite:artifact-fixture:cp1:decision:0',
        kind: 'CHECKPOINT_DECISION',
        artifact: 'artifact-fixture',
        cp: 1,
        text: 'Keep deterministic truth stable.',
      },
    ],
    landmarks: [],
    disclosure: [],
  };
}

function addUnassignedRows(floor: Floor): void {
  floor.coverage.items.push({
    hunkKey: 'hunk_unassigned',
    file: 'src/unassigned.ts',
    verdict: 'UNEXPLAINED',
    old_start: 1,
    new_start: 1,
    added_lines: 2,
    removed_lines: 0,
    units: [
      {
        kind: 'gap_slice',
        slice: 0,
        patch_row_start: 0,
        patch_row_end: 1,
        del_range: null,
        add_range: { start: 1, end: 2 },
        lines: 2,
        owner: null,
      },
    ],
  });
  floor.outline.unassigned.gap = {
    sliceRefs: [{ hunkKey: 'hunk_unassigned', slice: 0 }],
    files: [{ file: 'src/unassigned.ts', slice_count: 1, added_rows: 2, removed_rows: 0 }],
  };
  floor.coverage.summary.unexplained_rows = 2;
  floor.coverage.summary.reviewable_rows = 3;
}

export function buildReviewFloorFixture(scenario: ReviewFloorFixtureScenario): ReviewFloorFixture {
  const floor = baseFloor();
  if (scenario === 'unassigned') addUnassignedRows(floor);
  return { scenario, floor: floorSchema.parse(floor) };
}
