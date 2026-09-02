/**
 * Production-shaped Story fixtures shared by the mounted Watch tests.
 *
 * These fixtures deliberately exercise the model shapes easiest to leave
 * non-interactive: context-only Parts, Part-local ambiguity,
 * every residue bucket, global required work, and current-run replacement
 * independently from Story content replacement.
 */
import {
  buildReviewFloorFixture,
  type CoverageItem,
  type Floor,
  floorSchema,
} from '@orcaops/review-core';
import {
  buildSemanticAnchorChangeBlockCatalog,
  type ChangedRowSegment,
  parseStoryReviewModel,
  type SemanticAnchorChangeHunk,
  type SemanticAnchorModel,
  type SemanticAnchorResolvedTarget,
  serializeStoryReviewModelForInstall,
  STORY_REVIEW_MODEL_SCHEMA_VERSION,
  storyReviewGeneration,
  type StoryReviewModel,
} from '@orcaops/review-engine';

import type { RoutineStoryOverlay } from '../../src/data/reviewSource';

export interface StoryReviewHarnessFixture {
  floor: Floor;
  reviewDiff: string;
  model: StoryReviewModel;
}

export const STORY_HARNESS_SHAPE = {
  acts: 2,
  parts: 3,
} as const;

export const PRODUCTION_STORY_HARNESS_SHAPE = {
  acts: 4,
  parts: 8,
  segments: 1_779,
  reviewableRows: 11_928,
  tallHunkRows: 6_000,
} as const;

const OWNER = {
  a1: 'artifact-story-one',
  a2: 'artifact-story-two',
  a3: 'artifact-story-three',
} as const;

const CITE_PLAN = 'cite:a1:plan_decision:0';
const CITE_P1 = 'cite:a1:cp1:decision:0';
const CITE_CATALOG_ONLY = 'cite:a1:cp1:alternative:0';
const CITE_SOURCE_CONTEXT = 'cite:a1:plan_step:0';
const CITE_UNCERTAINTY = 'cite:a1:cp2:uncertainty:0';
const CITE_P3 = 'cite:a2:cp1:decision:0';
const FLOOR_CITE_P1 = `cite:${OWNER.a1}:cp1:decision:0`;
const FLOOR_CITE_UNCERTAINTY = `cite:${OWNER.a1}:cp2:uncertainty:0`;
const FLOOR_CITE_P3 = `cite:${OWNER.a2}:cp1:decision:0`;

function ownedItem(input: {
  hunkKey: string;
  file: string;
  newStart: number;
  rows: number;
  artifact: string;
  cp: number;
}): CoverageItem {
  return {
    hunkKey: input.hunkKey,
    file: input.file,
    verdict: 'MATCHED',
    old_start: 0,
    new_start: input.newStart,
    added_lines: input.rows,
    removed_lines: 0,
    units: [
      {
        kind: 'owned_slice',
        slice: 0,
        patch_row_start: 0,
        patch_row_end: input.rows - 1,
        del_range: null,
        add_range: {
          start: input.newStart,
          end: input.newStart + input.rows - 1,
        },
        lines: input.rows,
        owner: { kind: 'checkpoint', artifact: input.artifact, cp: input.cp },
      },
    ],
  };
}

function ambiguousItem(input: {
  hunkKey: string;
  file: string;
  newStart: number;
  rows: number;
  candidates: CoverageItem['units'][number] extends infer _Unit
    ? Array<{ kind: 'checkpoint'; artifact: string; cp: number } | { kind: 'gap'; segment: string }>
    : never;
}): CoverageItem {
  return {
    hunkKey: input.hunkKey,
    file: input.file,
    verdict: 'UNEXPLAINED',
    old_start: 0,
    new_start: input.newStart,
    added_lines: input.rows,
    removed_lines: 0,
    units: [
      {
        kind: 'ambiguous_hunk',
        lines: input.rows,
        candidates: input.candidates,
      },
    ],
  };
}

function gapItem(input: {
  hunkKey: string;
  file: string;
  newStart: number;
  rows: number;
  owner?: { kind: 'gap'; segment: string } | null;
}): CoverageItem {
  return {
    hunkKey: input.hunkKey,
    file: input.file,
    verdict: 'UNEXPLAINED',
    old_start: 0,
    new_start: input.newStart,
    added_lines: input.rows,
    removed_lines: 0,
    units: [
      {
        kind: 'gap_slice',
        slice: 0,
        patch_row_start: 0,
        patch_row_end: input.rows - 1,
        del_range: null,
        add_range: {
          start: input.newStart,
          end: input.newStart + input.rows - 1,
        },
        lines: input.rows,
        owner:
          input.owner === undefined ? { kind: 'gap', segment: 'story-harness-gap' } : input.owner,
      },
    ],
  };
}

function patchFor(
  items: readonly CoverageItem[],
  rowText: (item: CoverageItem, offset: number) => string
): string {
  const lines: string[] = [];
  const byFile = new Map<string, CoverageItem[]>();
  for (const item of items) {
    const fileItems = byFile.get(item.file) ?? [];
    fileItems.push(item);
    byFile.set(item.file, fileItems);
  }
  for (const [file, fileItems] of byFile) {
    lines.push(`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`);
    for (const item of fileItems) {
      lines.push(`@@ -0,0 +${item.new_start},${item.added_lines} @@`);
      for (let offset = 0; offset < item.added_lines; offset += 1) {
        lines.push(`+${rowText(item, offset)}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function validatedFixture(
  floor: Floor,
  reviewDiff: string,
  model: StoryReviewModel
): StoryReviewHarnessFixture {
  const parsedFloor = floorSchema.parse(floor);
  const parsedModel = parseStoryReviewModel(model);
  serializeStoryReviewModelForInstall({ model: parsedModel, diffText: reviewDiff });
  return { floor: parsedFloor, reviewDiff, model: parsedModel };
}

function baseFloor(inputHash: string): Floor {
  const floor = structuredClone(buildReviewFloorFixture('clean').floor);
  floor.input_hash = inputHash;
  floor.scope.branch = 'probe';
  floor.scope.branch_slug = 'probe';
  floor.scope.artifact_ids = Object.values(OWNER);
  floor.scope.threads = Object.values(OWNER).map((artifact, index) => ({
    artifact,
    branch: 'probe',
    label: `Story thread ${index + 1}`,
    first_activity_at: floor.generated_at,
  }));
  floor.integrity = [];
  floor.plan_coverage = [];
  floor.landmarks = [];
  floor.disclosure = [];
  return floor;
}

/**
 * Compact fixture that contains every routing and obligation shape used by the
 * shared Story reader checkpoints.
 */
export function buildStoryReviewHarnessFixture(
  options: {
    /**
     * Rows for the Part-1 owned hunk (default 2). A value larger than the
     * viewport makes the Story Walk's selected hunk overflow, giving every
     * paging key an observable effect; one over-wide row is emitted so `w`
     * (wrap) has something to wrap.
     */
    tallP1Rows?: number;
  } = {}
): StoryReviewHarnessFixture {
  const p1Rows = options.tallP1Rows ?? 2;
  const floor = baseFloor('story-harness-floor-v4');
  const items: CoverageItem[] = [
    ownedItem({
      hunkKey: 'hunk_story_owned_p1',
      file: 'src/story.ts',
      newStart: 1,
      rows: p1Rows,
      artifact: OWNER.a1,
      cp: 1,
    }),
    ownedItem({
      hunkKey: 'hunk_story_owned_p3',
      file: 'src/second.ts',
      newStart: 1,
      rows: 2,
      artifact: OWNER.a2,
      cp: 1,
    }),
    ambiguousItem({
      hunkKey: 'hunk_story_same_part',
      file: 'src/same-part.ts',
      newStart: 1,
      rows: 2,
      candidates: [
        { kind: 'checkpoint', artifact: OWNER.a1, cp: 1 },
        { kind: 'checkpoint', artifact: OWNER.a1, cp: 2 },
      ],
    }),
    ambiguousItem({
      hunkKey: 'hunk_story_contested',
      file: 'src/contested.ts',
      newStart: 1,
      rows: 3,
      candidates: [
        { kind: 'checkpoint', artifact: OWNER.a1, cp: 1 },
        { kind: 'checkpoint', artifact: OWNER.a2, cp: 1 },
      ],
    }),
    gapItem({
      hunkKey: 'hunk_story_gap',
      file: 'src/gap.ts',
      newStart: 1,
      rows: 2,
    }),
    gapItem({
      hunkKey: 'hunk_story_unowned',
      file: 'src/unowned.ts',
      newStart: 1,
      rows: 1,
      owner: null,
    }),
    ambiguousItem({
      hunkKey: 'hunk_story_ambiguous_no_part',
      file: 'src/ambiguous-residue.ts',
      newStart: 1,
      rows: 2,
      candidates: [
        { kind: 'checkpoint', artifact: OWNER.a3, cp: 1 },
        { kind: 'gap', segment: 'story-harness-gap' },
      ],
    }),
  ];
  floor.coverage.items = items;
  floor.coverage.summary = {
    excluded: 0,
    unreviewable: 0,
    matched_rows: 2 + p1Rows,
    unexplained_rows: 3,
    ambiguous_rows: 7,
    reviewable_rows: 12 + p1Rows,
  };
  floor.integrity = [
    { artifact: OWNER.a1, cp: 1, verified: true },
    { artifact: OWNER.a1, cp: 2, verified: true },
    { artifact: OWNER.a2, cp: 1, verified: true },
    { artifact: OWNER.a3, cp: 1, verified: true },
  ];
  floor.outline.threads = [
    {
      threadKey: 'thread-story-one',
      order: 1,
      title: 'Story thread one',
      artifact: OWNER.a1,
      checkpoints: [
        {
          checkpointKey: 'checkpoint-story-one',
          order: 1,
          checkpoint: { artifact: OWNER.a1, cp: 1, label: 'Implement Story path' },
          summary: 'Implement Story path',
          members: [{ artifact: OWNER.a1, cp: 1 }],
          sliceRefs: [{ hunkKey: 'hunk_story_owned_p1', slice: 0 }],
          citationIds: [FLOOR_CITE_P1],
        },
        {
          checkpointKey: 'checkpoint-story-context',
          order: 2,
          checkpoint: { artifact: OWNER.a1, cp: 2, label: 'Record context-only decision' },
          summary: 'Record context-only decision',
          members: [{ artifact: OWNER.a1, cp: 2 }],
          sliceRefs: [],
          citationIds: [FLOOR_CITE_UNCERTAINTY],
        },
      ],
    },
    {
      threadKey: 'thread-story-two',
      order: 2,
      title: 'Story thread two',
      artifact: OWNER.a2,
      checkpoints: [
        {
          checkpointKey: 'checkpoint-story-two',
          order: 1,
          checkpoint: { artifact: OWNER.a2, cp: 1, label: 'Verify Story path' },
          summary: 'Verify Story path',
          members: [{ artifact: OWNER.a2, cp: 1 }],
          sliceRefs: [{ hunkKey: 'hunk_story_owned_p3', slice: 0 }],
          citationIds: [FLOOR_CITE_P3],
        },
      ],
    },
    {
      threadKey: 'thread-story-three',
      order: 3,
      title: 'Story residue thread',
      artifact: OWNER.a3,
      checkpoints: [
        {
          checkpointKey: 'checkpoint-story-residue',
          order: 1,
          checkpoint: { artifact: OWNER.a3, cp: 1, label: 'Leave residue visible' },
          summary: 'Leave residue visible',
          members: [{ artifact: OWNER.a3, cp: 1 }],
          sliceRefs: [],
          citationIds: [],
        },
      ],
    },
  ];
  floor.outline.unassigned = {
    gap: {
      sliceRefs: [
        { hunkKey: 'hunk_story_gap', slice: 0 },
        { hunkKey: 'hunk_story_unowned', slice: 0 },
      ],
      files: [
        { file: 'src/gap.ts', slice_count: 1, added_rows: 2, removed_rows: 0 },
        { file: 'src/unowned.ts', slice_count: 1, added_rows: 1, removed_rows: 0 },
      ],
    },
    ambiguous: {
      hunkKeys: ['hunk_story_same_part', 'hunk_story_contested', 'hunk_story_ambiguous_no_part'],
      files: [
        { file: 'src/same-part.ts', hunk_count: 1, added: 2, removed: 0 },
        { file: 'src/contested.ts', hunk_count: 1, added: 3, removed: 0 },
        { file: 'src/ambiguous-residue.ts', hunk_count: 1, added: 2, removed: 0 },
      ],
    },
  };
  floor.citations = [
    {
      id: FLOOR_CITE_P1,
      kind: 'CHECKPOINT_DECISION',
      artifact: OWNER.a1,
      cp: 1,
      text: 'Implement the shared Story path.',
    },
    {
      id: FLOOR_CITE_UNCERTAINTY,
      kind: 'CHECKPOINT_UNCERTAINTY',
      artifact: OWNER.a1,
      cp: 2,
      text: 'The context-only contract remains open.',
    },
    {
      id: FLOOR_CITE_P3,
      kind: 'CHECKPOINT_DECISION',
      artifact: OWNER.a2,
      cp: 1,
      text: 'Verify the shared Story path.',
    },
  ];

  const p1Segment: ChangedRowSegment = {
    file: 'src/story.ts',
    hunkKey: 'hunk_story_owned_p1',
    slice: 0,
    owner: { artifact: 'a1', cp: 1 },
    del_range: null,
    add_range: { start: 1, end: p1Rows },
    lines: p1Rows,
  };
  const p3Segment: ChangedRowSegment = {
    file: 'src/second.ts',
    hunkKey: 'hunk_story_owned_p3',
    slice: 0,
    owner: { artifact: 'a2', cp: 1 },
    del_range: null,
    add_range: { start: 1, end: 2 },
    lines: 2,
  };

  const model: StoryReviewModel = {
    schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
    branch: 'probe',
    floor_input_hash: floor.input_hash,
    label: 'DERIVED',
    banner: 'Capture-backed Story ownership',
    overview: {
      text: 'The branch replaces a stacked Story document with a routed review experience.',
      citations: [CITE_PLAN],
    },
    acts: [
      {
        id: 'A1',
        title: 'Build the shared reader',
        interpretation: 'The first Act establishes the shared review path.',
        partIds: ['P1', 'P2'],
      },
      {
        id: 'A2',
        title: 'Verify the review path',
        interpretation: 'The second Act keeps verification and residue explicit.',
        partIds: ['P3'],
      },
    ],
    parts: [
      {
        id: 'P1',
        title: 'Route the Story through shared primitives',
        act: 'A1',
        checkpointRefs: ['a1:cp1'],
        interpretation: 'Use the deterministic diff structure for Story-owned code.',
        citations: [CITE_P1, CITE_SOURCE_CONTEXT],
        segments: [p1Segment],
        ambiguous: [
          {
            file: 'src/same-part.ts',
            hunkKey: 'hunk_story_same_part',
            lines: 2,
            candidates: [
              { kind: 'checkpoint', artifact: 'a1', cp: 1 },
              { kind: 'checkpoint', artifact: 'a1', cp: 2 },
            ],
          },
        ],
        changedRows: p1Rows,
        ambiguousRows: 2,
        contextOnly: false,
      },
      {
        id: 'P2',
        title: 'Preserve captured context',
        act: 'A1',
        checkpointRefs: ['a1:cp2'],
        interpretation: 'A context-only Part remains reviewable without fabricated rows.',
        citations: [CITE_UNCERTAINTY],
        segments: [],
        ambiguous: [],
        changedRows: 0,
        ambiguousRows: 0,
        contextOnly: true,
      },
      {
        id: 'P3',
        title: 'Prove bounded review behavior',
        act: 'A2',
        checkpointRefs: ['a2:cp1'],
        interpretation: 'Exercise the second code-owning Part and global obligations.',
        citations: [CITE_P3],
        segments: [p3Segment],
        ambiguous: [],
        changedRows: 2,
        ambiguousRows: 0,
        contextOnly: false,
      },
    ],
    residue: {
      contested: [
        {
          file: 'src/contested.ts',
          hunkKey: 'hunk_story_contested',
          lines: 3,
          candidates: [
            { kind: 'checkpoint', artifact: 'a1', cp: 1 },
            { kind: 'checkpoint', artifact: 'a2', cp: 1 },
          ],
          partIds: ['P1', 'P3'],
        },
      ],
      unattributed: [
        {
          file: 'src/gap.ts',
          hunkKey: 'hunk_story_gap',
          slice: 0,
          kind: 'gap',
          owner: { kind: 'gap', segment: 'story-harness-gap' },
          lines: 2,
        },
        {
          file: 'src/unowned.ts',
          hunkKey: 'hunk_story_unowned',
          slice: 0,
          kind: 'unowned',
          owner: null,
          lines: 1,
        },
        {
          file: 'src/ambiguous-residue.ts',
          hunkKey: 'hunk_story_ambiguous_no_part',
          kind: 'ambiguous_no_part',
          owner: null,
          lines: 2,
          candidates: [
            { kind: 'checkpoint', artifact: 'a3', cp: 1 },
            { kind: 'gap', segment: 'story-harness-gap' },
          ],
        },
      ],
      reviewableRows: 5,
      files: ['src/ambiguous-residue.ts', 'src/gap.ts', 'src/unowned.ts'],
    },
    metrics: {
      reviewableRows: 12 + p1Rows,
      attributedRows: 2 + p1Rows,
      attributedPct: ((2 + p1Rows) / (12 + p1Rows)) * 100,
      ambiguousRows: 2,
      contestedRows: 3,
      unattributedRows: 5,
      contributingThreads: 2,
      contributingCheckpoints: 2,
    },
    ledger: [
      {
        id: 'ldg:story-part',
        kind: 'VERIFICATION_GAP',
        status: 'OPEN',
        message: 'The Part-local contract needs reviewer attention.',
        flagOnly: false,
        attachment: { kind: 'part', partId: 'P1' },
        disposition: 'OUTSTANDING',
      },
      {
        id: 'ldg:story-residue',
        kind: 'COVERAGE_GAP',
        status: 'OPEN',
        message: 'Residue remains explicitly disclosed.',
        flagOnly: true,
        attachment: { kind: 'residue', residue: 'unattributed' },
        disposition: 'OUTSTANDING',
      },
    ],
    uncertainties: [
      {
        citationId: CITE_UNCERTAINTY,
        artifact: 'a1',
        cp: 2,
        text: 'The context-only contract remains open.',
        partId: 'P2',
        state: 'UNADJUDICATED',
      },
    ],
    findings: [
      {
        id: 'finding:required-global',
        lane: 'forensic',
        text: 'The old fork mounts every Part at once.',
        file: 'src/story.ts',
        relatedFiles: [],
        severity: 'CRITICAL',
        confidence: 'HIGH',
        citationsByLane: { account: [CITE_P1], forensic: [] },
        required: true,
      },
    ],
    questions: [
      {
        id: 'question:required-global',
        lane: 'account',
        text: 'Does the shared reader preserve the review lifecycle?',
        file: null,
        citationsByLane: { account: [CITE_PLAN], forensic: [] },
        required: true,
      },
    ],
    citations: {
      [CITE_PLAN]: {
        id: CITE_PLAN,
        kind: 'PLAN_DECISION',
        artifact: 'a1',
        cp: null,
        text: 'Use one shared shell for both review lenses.',
      },
      [CITE_P1]: {
        id: CITE_P1,
        kind: 'CHECKPOINT_DECISION',
        artifact: 'a1',
        cp: 1,
        text: 'Route Story code through deterministic diff primitives.',
      },
      [CITE_CATALOG_ONLY]: {
        id: CITE_CATALOG_ONLY,
        kind: 'CHECKPOINT_ALTERNATIVE',
        artifact: 'a1',
        cp: 1,
        text: 'Keep a separate stacked Story renderer.',
        parent: CITE_P1,
      },
      [CITE_SOURCE_CONTEXT]: {
        id: CITE_SOURCE_CONTEXT,
        kind: 'PLAN_STEP',
        artifact: 'a1',
        cp: null,
        text: 'Retain ordinary source context without inventing a code anchor.',
      },
      [CITE_UNCERTAINTY]: {
        id: CITE_UNCERTAINTY,
        kind: 'CHECKPOINT_UNCERTAINTY',
        artifact: 'a1',
        cp: 2,
        text: 'The context-only contract remains open.',
      },
      [CITE_P3]: {
        id: CITE_P3,
        kind: 'CHECKPOINT_DECISION',
        artifact: 'a2',
        cp: 1,
        text: 'Verify bounded Story review behavior.',
      },
    },
    artifactAliases: { ...OWNER },
  };

  return validatedFixture(
    floor,
    patchFor(items, (item, offset) =>
      item.hunkKey === 'hunk_story_owned_p1' && offset === 3
        ? `${item.hunkKey} row ${offset + 1} ${'x'.repeat(400)}`
        : `${item.hunkKey} row ${offset + 1}`
    ),
    model
  );
}

export function buildCodeOnlyStoryReviewHarnessFixture(): StoryReviewHarnessFixture {
  const fixture = buildStoryReviewHarnessFixture();
  const model: StoryReviewModel = {
    ...fixture.model,
    label: 'CODE_ONLY',
    banner: 'Forensic code review without an authored account Story',
    overview: null,
    acts: [],
    parts: [],
    uncertainties: fixture.model.uncertainties.map((uncertainty) => ({
      ...uncertainty,
      partId: null,
    })),
    ledger: fixture.model.ledger.map((entry) => ({
      ...entry,
      attachment:
        entry.attachment.kind === 'part'
          ? ({ kind: 'residue', residue: 'floor' } as const)
          : entry.attachment,
    })),
  };
  return validatedFixture(fixture.floor, fixture.reviewDiff, model);
}

function anchorRange(
  hunk: SemanticAnchorChangeHunk,
  side: 'add' | 'delete',
  selection?: { start: number; end: number }
) {
  const rows = hunk.blocks[0]!.lines.filter((line) => {
    if (line.side !== side) return false;
    const coordinate = side === 'add' ? line.newLine : line.oldLine;
    return (
      coordinate !== null &&
      (selection === undefined || (coordinate >= selection.start && coordinate <= selection.end))
    );
  });
  return rows.length === 0
    ? null
    : {
        start_line: (side === 'add' ? rows[0]!.newLine : rows[0]!.oldLine)!,
        end_line: (side === 'add' ? rows.at(-1)!.newLine : rows.at(-1)!.oldLine)!,
        line_hashes: rows.map((line) => line.lineHash),
      };
}

function anchorTarget(
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
    delete: anchorRange(hunk, 'delete'),
    add: anchorRange(hunk, 'add'),
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
      delete: treatment.side === 'delete' ? anchorRange(hunk, 'delete', treatment) : null,
      add: treatment.side === 'add' ? anchorRange(hunk, 'add', treatment) : null,
    },
    focus_status: 'ACCEPTED',
    focus_diagnostic_code: null,
    warnings: [],
  };
}

/** All anchor treatments on the compact production-shaped Story fixture. */
export function buildStoryReviewHarnessAnchors(
  fixture: StoryReviewHarnessFixture
): SemanticAnchorModel {
  const catalog = buildSemanticAnchorChangeBlockCatalog(fixture.reviewDiff, fixture.floor.coverage);
  const p1Hunk = catalog.hunks.find((candidate) => candidate.hunkKey === 'hunk_story_owned_p1')!;
  const p3Hunk = catalog.hunks.find((candidate) => candidate.hunkKey === 'hunk_story_owned_p3')!;
  return {
    schema_version: 3,
    generation_id: '11111111-1111-4111-8111-111111111111',
    run_id: '22222222-2222-4222-8222-222222222222',
    floor_input_hash: fixture.floor.input_hash,
    prepared_payload_sha256: 'a'.repeat(64),
    source: 'REVIEW_MODEL_SUBMISSION_COMPILED',
    items: [
      {
        citation_id: CITE_PLAN,
        citation_kind: 'PLAN_DECISION',
        disposition: 'ANCHORED',
        origin: 'REVIEW_MODEL_PROPOSED',
        targets: [anchorTarget(p1Hunk, { kind: 'whole' }), anchorTarget(p3Hunk, { kind: 'whole' })],
      },
      {
        citation_id: CITE_P1,
        citation_kind: 'CHECKPOINT_DECISION',
        disposition: 'ANCHORED',
        origin: 'REVIEW_MODEL_PROPOSED',
        targets: [
          anchorTarget(p1Hunk, {
            kind: 'accepted',
            side: 'add',
            start: 2,
            end: 2,
          }),
        ],
      },
      {
        citation_id: CITE_CATALOG_ONLY,
        citation_kind: 'CHECKPOINT_ALTERNATIVE',
        disposition: 'NO_ANCHOR_PROPOSED',
        origin: 'ENGINE_RECORDED_OMISSION',
        targets: [],
      },
      {
        citation_id: CITE_UNCERTAINTY,
        citation_kind: 'CHECKPOINT_UNCERTAINTY',
        disposition: 'ANCHORED',
        origin: 'REVIEW_MODEL_PROPOSED',
        targets: [anchorTarget(p1Hunk, { kind: 'rejected' })],
      },
      {
        citation_id: CITE_P3,
        citation_kind: 'CHECKPOINT_DECISION',
        disposition: 'ANCHORED',
        origin: 'REVIEW_MODEL_PROPOSED',
        targets: [anchorTarget(p3Hunk, { kind: 'whole' })],
      },
    ],
  };
}

/**
 * The calibrated scaling fixture. It preserves the real artifact's topology
 * and totals without copying any user review data.
 */
export function buildProductionStoryReviewHarnessFixture(): StoryReviewHarnessFixture {
  const shape = PRODUCTION_STORY_HARNESS_SHAPE;
  const floor = baseFloor('story-production-floor-v4');
  const aliases = Object.fromEntries(
    Array.from({ length: shape.parts }, (_, index) => [
      `a${index + 1}`,
      `artifact-story-scale-${index + 1}`,
    ])
  );
  const rowCounts = Array.from({ length: shape.segments }, () => 1);
  rowCounts[0] = shape.tallHunkRows;
  let rowsToDistribute = shape.reviewableRows - shape.tallHunkRows - (shape.segments - 1);
  for (let cursor = 1; rowsToDistribute > 0; cursor += 1, rowsToDistribute -= 1) {
    rowCounts[1 + ((cursor - 1) % (shape.segments - 1))]! += 1;
  }

  const segmentCounts = Array.from({ length: shape.parts }, () =>
    Math.floor(shape.segments / shape.parts)
  );
  for (let index = 0; index < shape.segments % shape.parts; index += 1) {
    segmentCounts[index]! += 1;
  }

  const items: CoverageItem[] = [];
  const parts: StoryReviewModel['parts'] = [];
  const threads: Floor['outline']['threads'] = [];
  let ordinal = 0;
  for (let partIndex = 0; partIndex < shape.parts; partIndex += 1) {
    const alias = `a${partIndex + 1}`;
    const artifact = aliases[alias]!;
    const file = `src/scale-part-${partIndex + 1}.ts`;
    const segments: ChangedRowSegment[] = [];
    const sliceRefs: Array<{ hunkKey: string; slice: number }> = [];
    let newStart = 1;
    for (let local = 0; local < segmentCounts[partIndex]!; local += 1) {
      const rows = rowCounts[ordinal]!;
      const hunkKey = `hunk_story_scale_${String(ordinal + 1).padStart(4, '0')}`;
      items.push(
        ownedItem({
          hunkKey,
          file,
          newStart,
          rows,
          artifact,
          cp: 1,
        })
      );
      segments.push({
        file,
        hunkKey,
        slice: 0,
        owner: { artifact: alias, cp: 1 },
        del_range: null,
        add_range: { start: newStart, end: newStart + rows - 1 },
        lines: rows,
      });
      sliceRefs.push({ hunkKey, slice: 0 });
      newStart += rows + 2;
      ordinal += 1;
    }
    const partId = `P${partIndex + 1}`;
    parts.push({
      id: partId,
      title: `Review scale Part ${partIndex + 1}`,
      act: `A${Math.floor(partIndex / 2) + 1}`,
      checkpointRefs: [`${alias}:cp1`],
      interpretation: `Part ${partIndex + 1} owns one bounded section of the scaling fixture.`,
      citations: [],
      segments,
      ambiguous: [],
      changedRows: segments.reduce((sum, segment) => sum + segment.lines, 0),
      ambiguousRows: 0,
      contextOnly: false,
    });
    threads.push({
      threadKey: `thread-story-scale-${partIndex + 1}`,
      order: partIndex + 1,
      title: `Scale thread ${partIndex + 1}`,
      artifact,
      checkpoints: [
        {
          checkpointKey: `checkpoint-story-scale-${partIndex + 1}`,
          order: 1,
          checkpoint: { artifact, cp: 1, label: `Scale checkpoint ${partIndex + 1}` },
          summary: `Scale checkpoint ${partIndex + 1}`,
          members: [{ artifact, cp: 1 }],
          sliceRefs,
          citationIds: [],
        },
      ],
    });
  }

  floor.scope.artifact_ids = Object.values(aliases);
  floor.scope.threads = Object.values(aliases).map((artifact, index) => ({
    artifact,
    branch: 'probe',
    label: `Scale thread ${index + 1}`,
    first_activity_at: floor.generated_at,
  }));
  floor.coverage.items = items;
  floor.coverage.summary = {
    excluded: 0,
    unreviewable: 0,
    matched_rows: shape.reviewableRows,
    unexplained_rows: 0,
    ambiguous_rows: 0,
    reviewable_rows: shape.reviewableRows,
  };
  floor.integrity = Object.values(aliases).map((artifact) => ({
    artifact,
    cp: 1,
    verified: true,
  }));
  floor.outline.threads = threads;
  floor.outline.unassigned = {
    gap: { sliceRefs: [], files: [] },
    ambiguous: { hunkKeys: [], files: [] },
  };
  floor.citations = [];

  const overviewCitation = 'cite:a1:plan_decision:0';
  const model: StoryReviewModel = {
    schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
    branch: 'probe',
    floor_input_hash: floor.input_hash,
    label: 'DERIVED',
    banner: 'Production-scale Story fixture',
    overview: {
      text: 'Eight causal Parts exercise a production-sized Story without copying user review data.',
      citations: [overviewCitation],
    },
    acts: Array.from({ length: shape.acts }, (_, index) => ({
      id: `A${index + 1}`,
      title: `Scale Act ${index + 1}`,
      interpretation: `Act ${index + 1} groups two causal Parts.`,
      partIds: [`P${index * 2 + 1}`, `P${index * 2 + 2}`],
    })),
    parts,
    residue: { contested: [], unattributed: [], reviewableRows: 0, files: [] },
    metrics: {
      reviewableRows: shape.reviewableRows,
      attributedRows: shape.reviewableRows,
      attributedPct: 100,
      ambiguousRows: 0,
      contestedRows: 0,
      unattributedRows: 0,
      contributingThreads: shape.parts,
      contributingCheckpoints: shape.parts,
    },
    ledger: [],
    uncertainties: [],
    findings: [],
    questions: [],
    citations: {
      [overviewCitation]: {
        id: overviewCitation,
        kind: 'PLAN_DECISION',
        artifact: 'a1',
        cp: null,
        text: 'Measure the real Story topology under a synthetic production load.',
      },
    },
    artifactAliases: aliases,
  };

  return validatedFixture(
    floor,
    patchFor(items, (item, offset) => `${item.hunkKey} production row ${offset + 1}`),
    model
  );
}

export async function storyOverlay(
  model: StoryReviewModel,
  input: {
    runId: string;
    installationToken?: string;
    anchors?: SemanticAnchorModel;
  }
): Promise<RoutineStoryOverlay> {
  return {
    model,
    status: 'ok',
    issue: null,
    runId: input.runId,
    generation: await storyReviewGeneration(model),
    installationToken: input.installationToken ?? input.runId,
    anchors:
      input.anchors === undefined
        ? { model: null, status: 'absent', issue: null, generation: null }
        : {
            model: input.anchors,
            status: 'ok',
            issue: null,
            generation: input.anchors.generation_id,
          },
  };
}
