import {
  buildReviewFloorFixture,
  type CurrentThreadManifest,
  type EligibleNarrativeTarget,
  prepareReviewCoverageEvent,
  replayReviewLedgerV2,
  type ReviewedRow,
  type ReviewFloorFixture,
  type ReviewLedgerV2,
} from '@orcaops/review-core';
import { buildCurrentThreadManifests, rowsForEligibleTarget } from '@orcaops/review-engine';

import { buildDeterministicReader, type ReaderModel } from '../../src/tui/review/readerModel';

export const WATCH_REVIEW_FIXTURE_SCENARIOS = [
  'sole-part',
  'mixed-parts',
  'unplaced-item',
  'unassigned',
  'comments',
  'multi-location',
  'reader-parity',
  'degraded',
  'no-narrative',
  'evaluator-concern-floor-only',
  'two-checkpoints',
  'cross-artifact-shared-hunk',
  'same-hunk-slices',
  'wide-hunk',
  'complete',
  'complete-floor-only',
  'uncertainty-floor-only',
  'rail-overflow-floor-only',
  'attention-rich',
  'unassigned-floor-only',
  'unassigned-huge',
] as const;
export type WatchReviewFixtureScenario = (typeof WATCH_REVIEW_FIXTURE_SCENARIOS)[number];

export interface WatchReviewFixture {
  source: ReviewFloorFixture;
  currentGapRows: ReviewedRow[];
  eligibleTargets: EligibleNarrativeTarget[];
  currentThreads: CurrentThreadManifest[];
  ledger: ReviewLedgerV2;
}

function baseTarget(): EligibleNarrativeTarget {
  return {
    targetKey: 'target_fixture_add',
    threadKey: 'sec_fixture',
    anchor: {
      file: 'src/fixture.ts',
      hunkKey: 'hunk_fixture',
      ranges: [
        {
          side: 'add',
          startLine: 1,
          endLine: 1,
          lineHashes: ['line_hash_fixture'],
        },
      ],
    },
    checkpointRefs: [{ artifact: 'artifact-fixture', cp: 1 }],
  };
}

function addAmbiguousBand(fixture: ReviewFloorFixture): void {
  fixture.floor.coverage.items.push({
    hunkKey: 'hunk_ambiguous_fixture',
    file: 'src/ambiguous.ts',
    verdict: 'UNEXPLAINED',
    old_start: 3,
    new_start: 3,
    added_lines: 1,
    removed_lines: 1,
    units: [
      {
        kind: 'ambiguous_hunk',
        lines: 2,
        candidates: [
          { kind: 'checkpoint', artifact: 'artifact-fixture', cp: 1 },
          { kind: 'gap', segment: 'cp1.close->pinned' },
        ],
      },
    ],
  });
  fixture.floor.outline.unassigned.ambiguous.hunkKeys.push('hunk_ambiguous_fixture');
  fixture.floor.outline.unassigned.ambiguous.files.push({
    file: 'src/ambiguous.ts',
    hunk_count: 1,
    added: 1,
    removed: 1,
  });
  fixture.floor.coverage.summary.ambiguous_rows += 2;
  fixture.floor.coverage.summary.reviewable_rows += 2;
}

function addFullCapturedTrail(fixture: ReviewFloorFixture): void {
  const floor = fixture.floor;
  const checkpoint = floor.outline.threads[0]!.checkpoints[0]!;
  // The production floor carries the checkpoint-close summary directly on the
  // checkpoint. Keep this fixture phrase distinct from the artifact SUMMARY
  // citation so a rail test cannot pass by rendering the wrong source.
  (checkpoint as typeof checkpoint & { summary: string }).summary =
    'Checkpoint 1 reworked the configuration loader path.';
  const decision = floor.citations.find((citation) => citation.kind === 'CHECKPOINT_DECISION');
  if (decision !== undefined) {
    decision.text =
      'Keep deterministic truth stable.\n↳ Reviewer progress must survive regeneration.';
  }
  floor.citations.push(
    {
      id: 'cite:artifact-fixture:cp1:alternative:0',
      kind: 'CHECKPOINT_ALTERNATIVE',
      artifact: 'artifact-fixture',
      cp: 1,
      parent: 'cite:artifact-fixture:cp1:decision:0',
      text: 'Link the record to the first owned hunk\n↳ ownership is not semantic placement',
    },
    {
      id: 'cite:artifact-fixture:cp1:uncertainty:0',
      kind: 'CHECKPOINT_UNCERTAINTY',
      artifact: 'artifact-fixture',
      cp: 1,
      text: 'The terminal density still needs a real-width drive.',
    },
    {
      id: 'cite:artifact-fixture:summary:0',
      kind: 'SUMMARY',
      artifact: 'artifact-fixture',
      text: 'Delivered the deterministic capture and review foundation.',
    },
    {
      id: 'cite:artifact-fixture:evaluator_run:0',
      kind: 'EVALUATOR_RUN',
      artifact: 'artifact-fixture',
      text: 'reader-contract — pass: PASS',
      evaluator: {
        evaluator_ref: 'reader-contract',
        severity: 'warn',
        run_status: 'completed',
        verdict: 'pass',
        disposition: null,
        summary: 'PASS',
      },
    }
  );
  checkpoint.citationIds.push(
    'cite:artifact-fixture:cp1:alternative:0',
    'cite:artifact-fixture:cp1:uncertainty:0'
  );
  floor.plan_coverage.push({
    artifact: 'artifact-fixture',
    step_id: 'step_reader_fixture',
    label: 'Preserve captured review truth',
    text: 'Preserve captured review truth without fabricated placement.',
    order: 1,
    claimed_by: [{ artifact: 'artifact-fixture', cp: 1 }],
    declared_by: [{ artifact: 'artifact-fixture', cp: 1 }],
    unclaimed: false,
  });
}

function addActionableEvaluatorConcern(fixture: ReviewFloorFixture): void {
  const citation = fixture.floor.citations.find(
    (candidate) => candidate.kind === 'EVALUATOR_RUN' && candidate.artifact === 'artifact-fixture'
  );
  if (citation === undefined) throw new Error('full captured trail evaluator citation missing');
  citation.text = 'reader-contract — violation: Slice ownership needs verification.';
  citation.evaluator = {
    evaluator_ref: 'reader-contract',
    severity: 'warn',
    run_status: 'completed',
    verdict: 'violation',
    disposition: null,
    summary: 'Slice ownership needs verification.',
  };
}

function addSecondCapturedUncertainty(fixture: ReviewFloorFixture): void {
  const checkpoint = fixture.floor.outline.threads[0]!.checkpoints[0]!;
  const citation = {
    id: 'cite:artifact-fixture:cp1:uncertainty:1',
    kind: 'CHECKPOINT_UNCERTAINTY' as const,
    artifact: 'artifact-fixture',
    cp: 1,
    text: 'The refresh boundary still needs a real reload.',
  };
  fixture.floor.citations.push(citation);
  checkpoint.citationIds.push(citation.id);
}

function addCapturedUncertaintyBand(fixture: ReviewFloorFixture, count: number): void {
  const checkpoint = fixture.floor.outline.threads[0]!.checkpoints[0]!;
  for (let index = 1; index < count; index += 1) {
    const id = `cite:artifact-fixture:cp1:uncertainty:${index}`;
    fixture.floor.citations.push({
      id,
      kind: 'CHECKPOINT_UNCERTAINTY',
      artifact: 'artifact-fixture',
      cp: 1,
      text: `Rail overflow concern ${index} needs review.`,
    });
    checkpoint.citationIds.push(id);
  }
}

function addReaderHunks(fixture: ReviewFloorFixture, targets: EligibleNarrativeTarget[]): void {
  const checkpoint = fixture.floor.outline.threads[0]!.checkpoints[0]!;
  const additions = [
    {
      targetKey: 'target_fixture_second',
      hunkKey: 'hunk_fixture_second',
      file: 'src/fixture.ts',
      line: 11,
      lineHash: 'line_hash_fixture_second',
      oldStart: 10,
      newStart: 11,
    },
    {
      targetKey: 'target_fixture_third',
      hunkKey: 'hunk_fixture_third',
      file: 'src/second.ts',
      line: 1,
      lineHash: 'line_hash_fixture_third',
      oldStart: 1,
      newStart: 1,
    },
  ];
  for (const addition of additions) {
    fixture.floor.coverage.items.push({
      hunkKey: addition.hunkKey,
      file: addition.file,
      verdict: 'MATCHED',
      old_start: addition.oldStart,
      new_start: addition.newStart,
      added_lines: 1,
      removed_lines: 0,
      units: [
        {
          kind: 'owned_slice',
          slice: 0,
          patch_row_start: 0,
          patch_row_end: 0,
          del_range: null,
          add_range: { start: addition.line, end: addition.line },
          lines: 1,
          owner: { kind: 'checkpoint', artifact: 'artifact-fixture', cp: 1 },
        },
      ],
    });
    checkpoint.sliceRefs.push({ hunkKey: addition.hunkKey, slice: 0 });
    targets.push({
      targetKey: addition.targetKey,
      threadKey: 'sec_fixture',
      anchor: {
        file: addition.file,
        hunkKey: addition.hunkKey,
        ranges: [
          {
            side: 'add',
            startLine: addition.line,
            endLine: addition.line,
            lineHashes: [addition.lineHash],
          },
        ],
      },
      checkpointRefs: [{ artifact: 'artifact-fixture', cp: 1 }],
    });
  }
  fixture.floor.coverage.summary.matched_rows += additions.length;
  fixture.floor.coverage.summary.reviewable_rows += additions.length;
}

/**
 * A SECOND checkpoint, owning `src/second.ts`.
 *
 * With one page, a pager that does not page, a cursor that walks out of its page
 * and a rail that shows another checkpoint's reasoning are all indistinguishable
 * from correct. cp1 keeps both hunks of `src/fixture.ts`; cp2 takes the one in
 * `src/second.ts`.
 */
function splitSecondCheckpoint(
  fixture: ReviewFloorFixture,
  targets: EligibleNarrativeTarget[]
): void {
  const thread = fixture.floor.outline.threads[0]!;
  const cp1 = thread.checkpoints[0]!;
  const moved = 'hunk_fixture_third';
  // The SHARED hunk: cp2 also touched `hunk_fixture_second`, which cp1 owns a slice
  // of. Two checkpoints editing the same function is the ordinary case, and it is
  // the only case where "which checkpoint's record is this?" has a wrong answer —
  // so it is the only case that can catch a rail derived from the cursor's hunk
  // instead of from the page.
  const shared = 'hunk_fixture_second';

  cp1.sliceRefs = cp1.sliceRefs.filter((ref) => ref.hunkKey !== moved);

  fixture.floor.citations.push({
    id: 'cite:artifact-fixture:cp2:decision:0',
    kind: 'CHECKPOINT_DECISION',
    artifact: 'artifact-fixture',
    cp: 2,
    text: 'cp2 kept the second file separate.',
  });

  thread.checkpoints.push({
    checkpointKey: 'cp_fixture_second',
    order: 2,
    checkpoint: {
      artifact: 'artifact-fixture',
      cp: 2,
      label: 'Second checkpoint',
    },
    summary: 'Second checkpoint',
    members: [{ artifact: 'artifact-fixture', cp: 2 }],
    sliceRefs: [
      { hunkKey: shared, slice: 1 },
      { hunkKey: moved, slice: 0 },
    ],
    citationIds: ['cite:artifact-fixture:cp2:decision:0'],
  });

  // cp2's own slice of the shared hunk — a second owned unit on the same parent.
  const sharedItem = fixture.floor.coverage.items.find((candidate) => candidate.hunkKey === shared);
  if (sharedItem !== undefined) {
    sharedItem.units.push({
      kind: 'owned_slice',
      slice: 1,
      patch_row_start: 1,
      patch_row_end: 1,
      del_range: null,
      add_range: { start: 12, end: 12 },
      lines: 1,
      owner: { kind: 'checkpoint', artifact: 'artifact-fixture', cp: 2 },
    });
    sharedItem.added_lines += 1;
  }

  // The floor's own record of ownership has to move with it, or `pageProjection`
  // and `capturedTrail` would still call the rows cp1's.
  const item = fixture.floor.coverage.items.find((candidate) => candidate.hunkKey === moved);
  if (item !== undefined) {
    item.units = item.units.map((unit) =>
      unit.kind === 'owned_slice'
        ? { ...unit, owner: { kind: 'checkpoint', artifact: 'artifact-fixture', cp: 2 } }
        : unit
    );
  }
  const target = targets.find((candidate) => candidate.anchor.hunkKey === moved);
  if (target !== undefined) {
    target.checkpointRefs = [{ artifact: 'artifact-fixture', cp: 2 }];
  }
}

/**
 * Two deterministic Brief rows whose checkpoints share one parent hunk.
 *
 * The selected Brief row already carries an exact thread/page identity. Routing
 * through its first hunk loses that identity because `checkpointKeyForHunk`
 * deliberately resolves shared hunks to the earliest owner in floor order.
 */
function splitSharedHunkAcrossArtifacts(
  fixture: ReviewFloorFixture,
  targets: EligibleNarrativeTarget[]
): void {
  splitSecondCheckpoint(fixture, targets);
  const firstThread = fixture.floor.outline.threads[0]!;
  const laterCheckpoint = firstThread.checkpoints.pop()!;
  laterCheckpoint.checkpointKey = 'cp_later_artifact';
  laterCheckpoint.checkpoint = {
    artifact: 'artifact-later',
    cp: 1,
    label: 'Later artifact checkpoint',
  };
  laterCheckpoint.members = [{ artifact: 'artifact-later', cp: 1 }];

  for (const item of fixture.floor.coverage.items) {
    item.units = item.units.map((unit) =>
      unit.kind === 'owned_slice' &&
      unit.owner.artifact === 'artifact-fixture' &&
      unit.owner.cp === 2
        ? { ...unit, owner: { kind: 'checkpoint' as const, artifact: 'artifact-later', cp: 1 } }
        : unit
    );
  }
  for (const target of targets) {
    if (target.checkpointRefs.some((ref) => ref.artifact === 'artifact-fixture' && ref.cp === 2)) {
      target.threadKey = 'sec_later';
      target.checkpointRefs = [{ artifact: 'artifact-later', cp: 1 }];
    }
  }

  fixture.floor.outline.threads.push({
    threadKey: 'sec_later',
    order: 2,
    title: 'Later artifact work',
    artifact: 'artifact-later',
    checkpoints: [laterCheckpoint],
  });
}

/** One deterministic page with two independently navigable slices in one hunk. */
function addSameCheckpointSlice(
  fixture: ReviewFloorFixture,
  targets: EligibleNarrativeTarget[]
): void {
  const hunkKey = 'hunk_fixture_second';
  const checkpoint = fixture.floor.outline.threads[0]!.checkpoints[0]!;
  const item = fixture.floor.coverage.items.find((candidate) => candidate.hunkKey === hunkKey)!;
  item.units.push({
    kind: 'owned_slice',
    slice: 1,
    patch_row_start: 1,
    patch_row_end: 1,
    del_range: null,
    add_range: { start: 12, end: 12 },
    lines: 1,
    owner: { kind: 'checkpoint', artifact: 'artifact-fixture', cp: 1 },
  });
  item.added_lines += 1;
  checkpoint.sliceRefs.push({ hunkKey, slice: 1 });
  fixture.floor.coverage.summary.matched_rows += 1;
  fixture.floor.coverage.summary.reviewable_rows += 1;

  const targetKey = 'target_fixture_second_tail';
  targets.push({
    targetKey,
    threadKey: 'sec_fixture',
    anchor: {
      file: 'src/fixture.ts',
      hunkKey,
      ranges: [
        {
          side: 'add',
          startLine: 12,
          endLine: 12,
          lineHashes: ['line_hash_fixture_second_tail'],
        },
      ],
    },
    checkpointRefs: [{ artifact: 'artifact-fixture', cp: 1 }],
  });
}

/**
 * Widen `hunk_fixture` to own TWO added rows instead of one.
 *
 * Every hunk in every fixture owns exactly ONE changed row, so the row cursor cannot
 * move inside a hunk, a `v` span always collapses to a point, and a `DIFF_RANGE` is
 * literally unrepresentable, so no assertion in them can tell a working `v` from a
 * dead one.
 *
 * Runs BEFORE the eligible targets are derived, so the targets carry both line hashes
 * and the floor stays internally consistent. Pair it with `multiRowHarnessDiff()`,
 * which is the patch that actually has the second row in it.
 */
function widenFixtureHunk(fixture: ReviewFloorFixture): void {
  const item = fixture.floor.coverage.items.find(
    (candidate) => candidate.hunkKey === 'hunk_fixture'
  );
  if (item === undefined) return;
  item.added_lines = 2;
  item.units = item.units.map((unit) =>
    unit.kind === 'owned_slice'
      ? { ...unit, add_range: { start: 1, end: 2 }, lines: 2, patch_row_end: 1 }
      : unit
  );
  fixture.floor.coverage.summary.matched_rows += 1;
  fixture.floor.coverage.summary.reviewable_rows += 1;
}

export async function buildWatchReviewFixture(
  scenario: WatchReviewFixtureScenario
): Promise<WatchReviewFixture> {
  const unassignedScenario =
    scenario === 'unassigned' ||
    scenario === 'unassigned-floor-only' ||
    scenario === 'unassigned-huge';
  const source = buildReviewFloorFixture(unassignedScenario ? 'unassigned' : 'clean');
  const currentGapRows: ReviewedRow[] = [];
  if (unassignedScenario) {
    // THE PERF FIXTURE: 4,057 unexplained rows and 454 gap slices — the scale at
    // which an unwindowed column mounts a <text> node per row. At two rows the cost
    // is imperceptible, so a small fixture cannot see it at all.
    const gapRowCount = scenario === 'unassigned-huge' ? 4_057 : 2;
    if (scenario === 'unassigned-huge') {
      const gapHunk = source.floor.coverage.items.find(
        (item) => item.hunkKey === 'hunk_unassigned'
      )!;
      const gapUnit = gapHunk.units[0]!;
      gapHunk.added_lines = gapRowCount;
      if (gapUnit.kind === 'gap_slice') {
        gapUnit.add_range = { start: 1, end: gapRowCount };
        gapUnit.lines = gapRowCount;
        gapUnit.patch_row_end = gapRowCount - 1;
      }
      source.floor.outline.unassigned.gap.files[0]!.added_rows = gapRowCount;
      source.floor.coverage.summary.unexplained_rows = gapRowCount;
      source.floor.coverage.summary.reviewable_rows += gapRowCount - 2;
    }
    for (let line = 1; line <= gapRowCount; line += 1) {
      currentGapRows.push({
        file: 'src/unassigned.ts',
        side: 'add',
        line,
        lineHash: `gap_hash_${line}`,
        hunkKey: 'hunk_unassigned',
      });
    }
    addAmbiguousBand(source);
  }
  if (scenario === 'wide-hunk') widenFixtureHunk(source);
  if (
    scenario === 'mixed-parts' ||
    scenario === 'reader-parity' ||
    scenario === 'no-narrative' ||
    scenario === 'evaluator-concern-floor-only' ||
    scenario === 'two-checkpoints' ||
    scenario === 'cross-artifact-shared-hunk' ||
    scenario === 'same-hunk-slices' ||
    scenario === 'uncertainty-floor-only' ||
    scenario === 'rail-overflow-floor-only'
  ) {
    addFullCapturedTrail(source);
  }
  if (scenario === 'evaluator-concern-floor-only') addActionableEvaluatorConcern(source);
  if (scenario === 'uncertainty-floor-only') addSecondCapturedUncertainty(source);
  if (scenario === 'rail-overflow-floor-only') addCapturedUncertaintyBand(source, 12);
  const targets = [baseTarget()];
  if (
    scenario === 'mixed-parts' ||
    scenario === 'reader-parity' ||
    scenario === 'no-narrative' ||
    scenario === 'evaluator-concern-floor-only' ||
    scenario === 'two-checkpoints' ||
    scenario === 'cross-artifact-shared-hunk' ||
    scenario === 'same-hunk-slices' ||
    scenario === 'uncertainty-floor-only' ||
    scenario === 'rail-overflow-floor-only'
  ) {
    addReaderHunks(source, targets);
  }
  if (scenario === 'two-checkpoints') splitSecondCheckpoint(source, targets);
  if (scenario === 'cross-artifact-shared-hunk') {
    splitSharedHunkAcrossArtifacts(source, targets);
  }
  if (scenario === 'same-hunk-slices') addSameCheckpointSlice(source, targets);
  const currentThreads = await buildCurrentThreadManifests(source.floor, targets);
  let ledger = await replayReviewLedgerV2({ events: [], currentThreads });
  // These scenarios exercise open-review behavior, so they must not synthesize
  // completed coverage before the reviewer acts.
  if (
    scenario === 'no-narrative' ||
    scenario === 'evaluator-concern-floor-only' ||
    scenario === 'two-checkpoints' ||
    scenario === 'cross-artifact-shared-hunk' ||
    scenario === 'same-hunk-slices' ||
    scenario === 'wide-hunk' ||
    scenario === 'unassigned-floor-only' ||
    scenario === 'unassigned-huge' ||
    scenario === 'rail-overflow-floor-only'
  ) {
    return {
      source,
      currentGapRows,
      eligibleTargets: targets,
      currentThreads,
      ledger,
    };
  }
  if (
    scenario === 'complete' ||
    scenario === 'complete-floor-only' ||
    scenario === 'uncertainty-floor-only'
  ) {
    const rowsByThread = new Map<string, ReviewedRow[]>();
    for (const target of targets) {
      const rows = rowsByThread.get(target.threadKey) ?? [];
      rows.push(...rowsForEligibleTarget(target));
      rowsByThread.set(target.threadKey, rows);
    }
    const prepared = await prepareReviewCoverageEvent({
      floorInputHash: source.floor.input_hash,
      ledgerGeneration: ledger.ledgerGeneration,
      priorCoverage: ledger.coverage,
      currentThreads,
      partRowsByThread: rowsByThread,
      now: '2026-07-12T08:00:00.000Z',
    });
    if (prepared.status !== 'ready') throw new Error('complete fixture coverage did not prepare');
    ledger = await replayReviewLedgerV2({ events: [prepared.event], currentThreads });
  }
  return {
    source,
    currentGapRows,
    eligibleTargets: targets,
    currentThreads,
    ledger,
  };
}

/**
 * The reader a fixture produces, built by the SAME code the app builds it with.
 *
 * Tests that hand-roll a `ReaderModel` are testing their own hand-rolling: a
 * fixture that encodes the assumption under test makes every test agree with the
 * bug. One builder, used everywhere, has no such room.
 */
export function buildFixtureReader(fixture: WatchReviewFixture): ReaderModel {
  const finishFacts = {
    targets: { ok: true } as const,
    currentGapRows: fixture.currentGapRows,
    comments: [],
  };
  return buildDeterministicReader({
    floor: fixture.source.floor,
    eligibleTargets: fixture.eligibleTargets,
    ledger: fixture.ledger,
    currentThreads: fixture.currentThreads,
    finishFacts,
  });
}
