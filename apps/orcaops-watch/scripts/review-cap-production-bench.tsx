import type { MouseEvent, ScrollBoxRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { heapStats } from 'bun:jsc';
import { performance } from 'node:perf_hooks';
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_DARK_THEME_ID,
  deferMountedDiffHighlightsForInteraction,
  type DiffFile,
  distinctCodeForegroundCount,
  findFileSectionAtOffset,
  loadHighlightedDiffHunk,
  readMountedDiffHighlightSchedulerCompletionCount,
  resolveTheme,
  sliceLineNumberDigits,
  splitCodeCellRanges,
  waitForMountedDiffHighlightsIdle,
} from '@orcaops/diff-render';
import type { ReviewUnit } from '@orcaops/review-core';

import { ThemeProvider } from '../src/tui/ThemeProvider';
import { CheckpointDiff } from '../src/tui/review/CheckpointDiff';
import { DiffSlice } from '../src/tui/review/DiffSlice';
import type { LoadedReview } from '../src/tui/review/ReviewApp';
import { reviewDiffWheelIntent } from '../src/tui/review/ReviewExperience';
import {
  buildCheckpointLayout,
  type CheckpointLayout,
  type LayoutFile,
  type LayoutPage,
} from '../src/tui/review/checkpointLayout';
import {
  captureDiffScrollAnchor,
  resolveDiffScrollAnchor,
} from '../src/tui/review/diffScrollAnchor';
import {
  computeRapidScrollOverscanRows,
  RAPID_SCROLL_OVERSCAN_IDLE_MS,
} from '../src/tui/review/hunkMounting';
import {
  maxReviewCodeHorizontalOffsetFromMetrics,
  measureReviewDiffHorizontalContent,
  type ReviewDiffHorizontalFile,
} from '../src/tui/review/reviewDiffHorizontal';
import { buildPatchIndex, type PatchIndex } from '../src/tui/review/walkDiff';
import { mountReviewApp } from '../tests/review/mountReviewApp';
import { buildReviewAppHarness } from '../tests/review/reviewAppHarness';

const TARGET_BYTES = 10 * 1_048_576;
const MIN_PATCH_FILES = 40;
const HUNKS_PER_PATCH_FILE = 110;
const CHANGED_LINES_PER_HUNK = 12;
const LINE_WIDTH = 72;

// The mounted review page mirrors the largest production-scale Part shape: 48
// files and 480 canonical parent hunks over a retained patch slightly larger
// than 10 MiB.
const PAGE_FILES = 48;
const PAGE_HUNKS_PER_FILE = 10;

const INITIAL_TERMINAL_WIDTH = 120;
const INITIAL_CARD_WIDTH = 110;
const INITIAL_VIEWPORT_HEIGHT = 30;
// Twenty observations make nearest-rank p95 a real tail statistic rather than
// simply aliasing the single maximum as it does for smaller sample sets.
const COLD_MOUNT_SAMPLES = 20;
// Entering continuous-scroll mode expands the retained halo and mounts its
// effects over the next commit. Keep those real interactions observable, but
// establish that state before sampling the explicitly steady-state wheel gate.
const WHEEL_STEADY_STATE_SETUP_EVENTS = 2;
const WHEEL_SAMPLES = 32;
const NAVIGATION_PAGE_ROUNDS = 2;
// Ten forward/back pairs make nearest-rank p95 a tail statistic rather than the
// single maximum (at eight samples, nearest-rank p95 is just the maximum).
const PRODUCT_NAVIGATION_ROUNDS = 10;
const SYNTAX_SAMPLES = 20;
const MOUNTED_NODE_LIMIT = 1_000;
const RETAINED_MEMORY_QUIESCENCE_MS = 3_000;
const RSS_TAIL_FILE_SAMPLES = 24;
const NO_PINS = [] as const;
const NO_EXPANDED_FOREIGN_HUNKS: ReadonlySet<string> = new Set();
const MIB = 1_048_576;

const performanceTargets = {
  firstUsefulFrameP50Ms: 100,
  firstUsefulFrameP95CeilingMs: 150,
  wheelP50Ms: 8,
  wheelP95Ms: 16.7,
  dragMaxMs: 32,
  navigationP50Ms: 100,
  navigationP95Ms: 150,
  resizeMaxMs: 50,
  syntaxP50Ms: 100,
  syntaxP95Ms: 200,
  heapGrowthRatio: 0.15,
  heapGrowthBytes: 16 * MIB,
  rssGrowthRatio: 0.15,
  rssGrowthBytes: 32 * MIB,
  mountedNodeLimit: MOUNTED_NODE_LIMIT,
} as const;

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]!;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function distribution(values: readonly number[]) {
  return {
    p50Ms: rounded(percentile(values, 0.5)),
    p95Ms: rounded(percentile(values, 0.95)),
    maxMs: rounded(Math.max(...values)),
    sampleCount: values.length,
    percentileMethod: 'nearest-rank' as const,
  };
}

function pad(value: string): string {
  return value.padEnd(LINE_WIDTH - 1).slice(0, LINE_WIDTH - 1);
}

function ownedUnit(start: number): ReviewUnit {
  return {
    kind: 'owned_slice',
    slice: 0,
    patch_row_start: 0,
    patch_row_end: CHANGED_LINES_PER_HUNK * 2 - 1,
    del_range: { start, end: start + CHANGED_LINES_PER_HUNK - 1 },
    add_range: { start, end: start + CHANGED_LINES_PER_HUNK - 1 },
    lines: CHANGED_LINES_PER_HUNK * 2,
    owner: { kind: 'checkpoint', artifact: 'review-cap-benchmark', cp: 1 },
  };
}

/**
 * Generate source-free review data until the retained unified patch crosses
 * 10 MiB. The page uses the first 480 real hunks from those same coordinates;
 * no benchmark destination can silently resolve to a placeholder.
 */
function buildTenMegabyteReview(): {
  patch: string;
  page: LayoutPage;
  totalHunks: number;
  patchFiles: number;
  pageHunks: number;
} {
  const chunks: string[] = [];
  const files: LayoutFile[] = [];
  let retainedBytes = 0;
  let hunkCount = 0;
  let fileIndex = 0;

  while (retainedBytes < TARGET_BYTES || fileIndex < MIN_PATCH_FILES) {
    const file = `src/cap/f${fileIndex}.ts`;
    const lines = [
      `diff --git a/${file} b/${file}`,
      'index 1111111..2222222 100644',
      `--- a/${file}`,
      `+++ b/${file}`,
    ];
    const slices: LayoutFile['slices'][number][] = [];
    const hunks: LayoutFile['hunks'][number][] = [];

    for (let ordinal = 0; ordinal < HUNKS_PER_PATCH_FILE; ordinal += 1) {
      const start = ordinal * 30 + 1;
      const hunkKey = `cap-${fileIndex}-${ordinal}`;
      lines.push(`@@ -${start},14 +${start},14 @@`);
      lines.push(` ${pad(`const before_${fileIndex}_${ordinal} = 0;`)}`);
      for (let row = 0; row < CHANGED_LINES_PER_HUNK; row += 1) {
        lines.push(`-${pad(`export const old_${fileIndex}_${ordinal}_${row} = ${row};`)}`);
      }
      for (let row = 0; row < CHANGED_LINES_PER_HUNK; row += 1) {
        lines.push(`+${pad(`export const NEW_${fileIndex}_${ordinal}_${row} = ${row + 1};`)}`);
      }
      lines.push(` ${pad(`const after_${fileIndex}_${ordinal} = 1;`)}`);

      if (fileIndex < PAGE_FILES && ordinal < PAGE_HUNKS_PER_FILE) {
        slices.push({
          sliceKey: `${hunkKey}:s0`,
          hunkKey,
          file,
          unit: ownedUnit(start + 1),
        });
        hunks.push({
          hunkKey,
          file,
          newStart: start,
          oldStart: start,
          added: CHANGED_LINES_PER_HUNK,
          removed: CHANGED_LINES_PER_HUNK,
          status: 'matched',
          ownerLabels: [],
          foreignOwnerLabels: [],
        });
      }
      hunkCount += 1;
    }

    const chunk = lines.join('\n');
    retainedBytes += Buffer.byteLength(chunk) + (chunks.length === 0 ? 0 : 1);
    chunks.push(chunk);
    if (hunks.length > 0) files.push({ file, slices, hunks });
    fileIndex += 1;
  }

  return {
    patch: `${chunks.join('\n')}\n`,
    page: { files, findings: [] },
    totalHunks: hunkCount,
    patchFiles: fileIndex,
    pageHunks: files.reduce((sum, file) => sum + file.hunks.length, 0),
  };
}

/**
 * Lift the render fixture into the real ReviewApp data contract. Two checkpoints
 * own the same 480 canonical hunks in opposite reading order, so `[` / `]`
 * performs a true maximum-page replacement without inventing another 10 MiB of
 * source. All rows still come from the raw patch used by the render-core gates.
 */
async function buildProductLoadedReview(
  review: ReturnType<typeof buildTenMegabyteReview>
): Promise<LoadedReview> {
  const base = await buildReviewAppHarness({ scenario: 'no-narrative', screen: 'floor-diff' });
  const artifact = 'review-cap-benchmark';
  const threadKey = 'review-cap-thread';
  const slices = review.page.files.flatMap((file) => file.slices);
  // Only an owned slice carries an ordinal; an ambiguous hunk has candidates
  // instead, and the coverage refs this bench builds are per-slice.
  const sliceRefs = slices.flatMap((slice) =>
    slice.unit.kind === 'owned_slice' ? [{ hunkKey: slice.hunkKey, slice: slice.unit.slice }] : []
  );
  const coverageItems: LoadedReview['data']['floor']['coverage']['items'] =
    review.page.files.flatMap((file) =>
      file.hunks.map((hunk) => ({
        hunkKey: hunk.hunkKey,
        file: file.file,
        verdict: 'MATCHED',
        old_start: hunk.oldStart,
        new_start: hunk.newStart,
        added_lines: hunk.added,
        removed_lines: hunk.removed,
        units: file.slices
          .filter((slice) => slice.hunkKey === hunk.hunkKey)
          .map((slice) => slice.unit),
      }))
    );
  const checkpointRefs = [
    { artifact, cp: 1 },
    { artifact, cp: 2 },
  ];
  const targets: LoadedReview['data']['eligibleTargets'] = coverageItems.flatMap((item, index) => {
    const unit = item.units.find((candidate) => candidate.kind === 'owned_slice');
    if (unit === undefined || unit.kind !== 'owned_slice') return [];
    const ranges = [
      ...(unit.del_range === null
        ? []
        : [
            {
              side: 'delete' as const,
              startLine: unit.del_range.start,
              endLine: unit.del_range.end,
              lineHashes: Array.from(
                { length: unit.del_range.end - unit.del_range.start + 1 },
                (_unused, row) => `cap-${index}-delete-${row}`
              ),
            },
          ]),
      ...(unit.add_range === null
        ? []
        : [
            {
              side: 'add' as const,
              startLine: unit.add_range.start,
              endLine: unit.add_range.end,
              lineHashes: Array.from(
                { length: unit.add_range.end - unit.add_range.start + 1 },
                (_unused, row) => `cap-${index}-add-${row}`
              ),
            },
          ]),
    ];
    return [
      {
        targetKey: `review-cap-target-${index}`,
        threadKey,
        anchor: { file: item.file, hunkKey: item.hunkKey, ranges },
        checkpointRefs,
      },
    ];
  });
  const currentRows = targets.flatMap((target) =>
    target.anchor.ranges.flatMap((range) =>
      range.lineHashes.map((lineHash, row) => ({
        file: target.anchor.file,
        side: range.side,
        line: range.startLine + row,
        lineHash,
        hunkKey: target.anchor.hunkKey,
      }))
    )
  );
  const currentThreads: LoadedReview['data']['currentThreads'] = [
    { threadKey, rows: currentRows, digest: 'review-cap-480-hunks' },
  ];
  const templateThread = base.loaded.data.floor.outline.threads[0]!;
  const templateCheckpoint = templateThread.checkpoints[0]!;
  const checkpoint = (cp: number, refs: typeof sliceRefs) => ({
    ...templateCheckpoint,
    checkpointKey: `review-cap-checkpoint-${cp}`,
    order: cp,
    checkpoint: { artifact, cp, label: `Benchmark checkpoint ${cp}` },
    members: [{ artifact, cp }],
    sliceRefs: refs,
    citationIds: [],
    summary: `Production-shape 480-hunk checkpoint ${cp}.`,
  });
  const matchedRows = coverageItems.reduce(
    (total, item) => total + item.units.reduce((sum, unit) => sum + unit.lines, 0),
    0
  );
  const floor: LoadedReview['data']['floor'] = {
    ...base.loaded.data.floor,
    input_hash: 'review-cap-480-hunks',
    scope: {
      ...base.loaded.data.floor.scope,
      artifact_ids: [artifact],
      threads: [
        {
          artifact,
          branch: 'performance/review-cap',
          label: 'Review cap',
          first_activity_at: null,
        },
      ],
    },
    coverage: {
      items: coverageItems,
      summary: {
        excluded: 0,
        unreviewable: 0,
        matched_rows: matchedRows,
        unexplained_rows: 0,
        ambiguous_rows: 0,
        reviewable_rows: matchedRows,
      },
    },
    integrity: checkpointRefs.map(({ artifact: ownerArtifact, cp }) => ({
      artifact: ownerArtifact,
      cp,
      verified: true,
    })),
    outline: {
      threads: [
        {
          ...templateThread,
          threadKey,
          title: 'Production-shape benchmark',
          artifact,
          checkpoints: [checkpoint(1, sliceRefs), checkpoint(2, [...sliceRefs].reverse())],
        },
      ],
      unassigned: { gap: { sliceRefs: [], files: [] }, ambiguous: { hunkKeys: [], files: [] } },
    },
    plan_coverage: [],
    citations: [],
  };

  return {
    ...base.loaded,
    data: {
      ...base.loaded.data,
      floor,
      targetsStatus: { ok: true },
      eligibleTargets: targets,
      currentThreads,
      currentGapRows: [],
      reviewDiff: review.patch,
    },
  };
}

interface TreeNode {
  getChildren?: () => unknown[];
}

function countNodes(node: unknown): number {
  const candidate = node as TreeNode;
  let total = 1;
  for (const child of candidate?.getChildren?.() ?? []) total += countNodes(child);
  return total;
}

function frameContainsUsefulDiff(frame: string): boolean {
  return /(?:old|NEW|before|after)_\d+_\d+/.test(frame);
}

function frameContainsFile(frame: string, file: string): boolean {
  if (frame.includes(file)) return true;
  const match = /\/f(\d+)\.ts$/.exec(file);
  return match !== null && frame.includes(`_${match[1]}_`);
}

function frameContainsHunk(frame: string, hunkKey: string): boolean {
  const match = /^cap-(\d+)-(\d+)$/.exec(hunkKey);
  return match !== null && frame.includes(`_${match[1]}_${match[2]}`);
}

function expectedFirstVisibleHunk(
  layout: CheckpointLayout,
  scrollTop: number,
  viewportHeight: number
): string | null {
  const viewportBottom = scrollTop + Math.max(1, viewportHeight);
  // Hunk sections intentionally leave file chrome and card-end gaps. The public
  // point-lookup helper falls back to the final section when an offset lands in
  // one of those gaps, which is correct for its file-header ownership callers
  // but is not an exact rendered-destination oracle. Select the first hunk that
  // actually intersects this viewport instead.
  return (
    layout.sections.find(
      (section) => section.sectionBottom > scrollTop && section.sectionTop < viewportBottom
    )?.fileId ?? null
  );
}

function firstVisibleBenchmarkMarker(frame: string): string | null {
  return /(?:old|NEW|before|after)_\d+_\d+(?:_\d+)?/.exec(frame)?.[0] ?? null;
}

interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BenchmarkViewportCoverage {
  rows: number;
  markerRows: number;
  longestMarkerFreeRun: number;
  trailingMarkerFreeRows: number;
}

/**
 * Inspect the complete native diff viewport, not just its first source marker.
 *
 * The benchmark fixture intentionally emits a source marker on every changed
 * logical row. Chrome and wrapped continuations create short marker-free runs,
 * while a stale virtual window after terminal-height growth creates one long
 * empty tail. Cropping to the real scroll surface keeps shell/footer text from
 * hiding that failure.
 */
function benchmarkViewportCoverage(frame: string, rect: FrameRect): BenchmarkViewportCoverage {
  const allRows = frame.split('\n');
  const top = Math.max(0, Math.floor(rect.y));
  const left = Math.max(0, Math.floor(rect.x));
  const height = Math.max(0, Math.floor(rect.height));
  const width = Math.max(0, Math.floor(rect.width));
  const rows = allRows.slice(top, top + height).map((row) => row.slice(left, left + width));
  let markerRows = 0;
  let markerFreeRun = 0;
  let longestMarkerFreeRun = 0;
  for (const row of rows) {
    if (/(?:old|NEW|before|after)_\d+_\d+(?:_\d+)?/.test(row)) {
      markerRows += 1;
      markerFreeRun = 0;
      continue;
    }
    markerFreeRun += 1;
    longestMarkerFreeRun = Math.max(longestMarkerFreeRun, markerFreeRun);
  }
  return {
    rows: rows.length,
    markerRows,
    longestMarkerFreeRun,
    trailingMarkerFreeRows: markerFreeRun,
  };
}

interface MemorySnapshot {
  jscHeapSize: number;
  jscExtraMemorySize: number;
  jscObjectCount: number;
  processHeapUsed: number;
  rss: number;
}

function readMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  const jsc = heapStats();
  return {
    jscHeapSize: jsc.heapSize,
    jscExtraMemorySize: jsc.extraMemorySize,
    jscObjectCount: jsc.objectCount,
    // Bun 1.3's Node-compat value can remain stale across forced collections.
    // Keep it as observability only; the retained-JS gate uses JSC's live heap.
    processHeapUsed: usage.heapUsed,
    rss: usage.rss,
  };
}

async function forceFullGc(): Promise<void> {
  Bun.gc(true);
  await Bun.sleep(0);
  Bun.gc(true);
}

async function collectMemory(): Promise<MemorySnapshot> {
  await forceFullGc();
  return readMemorySnapshot();
}

async function collectQuiescentMemory(): Promise<MemorySnapshot> {
  await waitForMountedDiffHighlightsIdle();
  // Release unreachable JS/native wrappers before giving the allocator its
  // fixed reclamation window; then collect/read once more at the far edge.
  await forceFullGc();
  await Bun.sleep(RETAINED_MEMORY_QUIESCENCE_MS);
  await waitForMountedDiffHighlightsIdle();
  return collectMemory();
}

function memoryObservation(baseline: number, observed: number) {
  const deltaBytes = observed - baseline;
  return {
    baselineBytes: baseline,
    observedBytes: observed,
    deltaBytes,
    deltaMiB: rounded(deltaBytes / MIB),
    deltaRatio: rounded(deltaBytes / Math.max(1, baseline)),
  };
}

function memoryGrowth(baseline: number, retained: number, ratioLimit: number, byteLimit: number) {
  const bytes = Math.max(0, retained - baseline);
  const ratio = bytes / Math.max(1, baseline);
  // The durable quality bar requires BOTH the relative and absolute threshold
  // to be exceeded before retained memory fails.
  return {
    baselineBytes: baseline,
    retainedBytes: retained,
    growthBytes: bytes,
    growthMiB: rounded(bytes / MIB),
    growthRatio: rounded(ratio),
    relativeLimit: ratioLimit,
    absoluteLimitBytes: byteLimit,
    pass: !(ratio > ratioLimit && bytes > byteLimit),
  };
}

function memorySnapshotValues(snapshot: MemorySnapshot) {
  return {
    rssBytes: snapshot.rss,
    jscHeapBytes: snapshot.jscHeapSize,
    jscExtraMemoryBytes: snapshot.jscExtraMemorySize,
    jscAssociatedMemoryBytes: snapshot.jscHeapSize + snapshot.jscExtraMemorySize,
    jscObjectCount: snapshot.jscObjectCount,
    processHeapUsedBytes: snapshot.processHeapUsed,
  };
}

function linearRssSlopeBytesPerHunk(samples: readonly RssFileBoundarySample[]): number | null {
  if (samples.length < 2) return null;
  const meanHunks =
    samples.reduce((sum, sample) => sum + sample.hunksCompleted, 0) / samples.length;
  const meanRss = samples.reduce((sum, sample) => sum + sample.rssBytes, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const x = sample.hunksCompleted - meanHunks;
    numerator += x * (sample.rssBytes - meanRss);
    denominator += x * x;
  }
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  const slope = numerator / denominator;
  return Number.isFinite(slope) ? slope : null;
}

function analyzePostWarmupRssTail(
  samples: readonly RssFileBoundarySample[],
  expectedFiles: number,
  expectedHunksPerFile: number,
  projectedHunks: number,
  absoluteLimitBytes: number
) {
  const warmupFiles = expectedFiles - RSS_TAIL_FILE_SAMPLES;
  const samplesValid =
    expectedFiles > RSS_TAIL_FILE_SAMPLES &&
    samples.length === expectedFiles &&
    samples.every(
      (sample, index) =>
        sample.fileBoundary === index + 1 &&
        sample.hunksCompleted === (index + 1) * expectedHunksPerFile &&
        Number.isFinite(sample.rssBytes) &&
        sample.rssBytes >= 0
    );
  const tailSamples = samples.slice(warmupFiles);
  const warmupEnd = samples[warmupFiles - 1];
  const firstTail = tailSamples[0];
  const tailEnd = tailSamples.at(-1);
  const slope = samplesValid ? linearRssSlopeBytesPerHunk(tailSamples) : null;
  const netSignedBytes =
    firstTail === undefined || tailEnd === undefined ? null : tailEnd.rssBytes - firstTail.rssBytes;
  const netGrowthBytes = netSignedBytes === null ? null : Math.max(0, netSignedBytes);
  const projectedSignedBytes = slope === null ? null : slope * projectedHunks;
  const projectedPositiveGrowthBytes =
    projectedSignedBytes === null ? null : Math.max(0, projectedSignedBytes);
  const valid =
    samplesValid &&
    tailSamples.length === RSS_TAIL_FILE_SAMPLES &&
    warmupEnd !== undefined &&
    firstTail !== undefined &&
    tailEnd !== undefined &&
    slope !== null &&
    netGrowthBytes !== null &&
    projectedPositiveGrowthBytes !== null &&
    Number.isFinite(netGrowthBytes) &&
    Number.isFinite(projectedPositiveGrowthBytes);

  return {
    semanticLabel: 'post-warmup-native-retention-tail',
    samplesValid,
    sampleCount: samples.length,
    expectedSampleCount: expectedFiles,
    warmupFiles,
    gatedFiles: tailSamples.length,
    gatedFileRange: `${warmupFiles + 1}-${expectedFiles}`,
    warmupEndFileBoundary: warmupEnd?.fileBoundary ?? null,
    warmupEndRssBytes: warmupEnd?.rssBytes ?? null,
    netBaselineKind: 'first-gated-tail-sample',
    firstTailFileBoundary: firstTail?.fileBoundary ?? null,
    firstTailRssBytes: firstTail?.rssBytes ?? null,
    tailEndFileBoundary: tailEnd?.fileBoundary ?? null,
    tailEndRssBytes: tailEnd?.rssBytes ?? null,
    netSignedBytes,
    netGrowthBytes,
    netGrowthMiB: netGrowthBytes === null ? null : rounded(netGrowthBytes / MIB),
    linearSlopeBytesPerHunk: slope === null ? null : rounded(slope),
    projectedHunks,
    projectedSignedBytes: projectedSignedBytes === null ? null : rounded(projectedSignedBytes),
    projectedPositiveGrowthBytes:
      projectedPositiveGrowthBytes === null ? null : rounded(projectedPositiveGrowthBytes),
    projectedPositiveGrowthMiB:
      projectedPositiveGrowthBytes === null ? null : rounded(projectedPositiveGrowthBytes / MIB),
    absoluteLimitBytes,
    netPass: valid && netGrowthBytes <= absoluteLimitBytes,
    projectedSlopePass: valid && projectedPositiveGrowthBytes <= absoluteLimitBytes,
    pass:
      valid &&
      netGrowthBytes <= absoluteLimitBytes &&
      projectedPositiveGrowthBytes <= absoluteLimitBytes,
    samples,
  };
}

interface BenchmarkView {
  page: LayoutPage;
  scrollTop: number;
  cursorHunkKey: string | null;
  terminalWidth: number;
  cardWidth: number;
  viewportHeight: number;
  layout: 'split' | 'stack';
  layoutGeneration: number;
  overscanRows: number;
  tightViewportWindow: boolean;
}

const fixtureStarted = performance.now();
const fixture = buildTenMegabyteReview();
const fixtureMs = performance.now() - fixtureStarted;
const diffBytes = Buffer.byteLength(fixture.patch);
const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);
const productLoaded = await buildProductLoadedReview(fixture);

let started = performance.now();
const patch = buildPatchIndex(fixture.patch);
const indexMs = performance.now() - started;

const initialHunk = fixture.page.files[0]?.hunks[0]?.hunkKey ?? null;
const initialView: BenchmarkView = {
  page: fixture.page,
  scrollTop: 0,
  cursorHunkKey: initialHunk,
  terminalWidth: INITIAL_TERMINAL_WIDTH,
  cardWidth: INITIAL_CARD_WIDTH,
  viewportHeight: INITIAL_VIEWPORT_HEIGHT,
  layout: 'split',
  layoutGeneration: 0,
  overscanRows: 0,
  tightViewportWindow: false,
};

interface ReviewSurfaceProps {
  view: BenchmarkView;
  benchmarkPatch: PatchIndex;
  onScrollSurface: (surface: ScrollBoxRenderable | null) => void;
  onMeasured: (layout: CheckpointLayout) => void;
  onMouseScroll?: (event: MouseEvent) => void;
}

/** The production diff subtree, with only its surrounding application shell removed. */
function ReviewSurface({
  view,
  benchmarkPatch,
  onScrollSurface,
  onMeasured,
  onMouseScroll,
}: ReviewSurfaceProps) {
  const [, setPublishedLayout] = useState<CheckpointLayout | null>(null);
  const publishMeasured = useCallback(
    (layout: CheckpointLayout): void => {
      setPublishedLayout((current) => (current === layout ? current : layout));
      onMeasured(layout);
    },
    [onMeasured]
  );
  // ReviewApp owns this page-level scan above the diff subtree. Keep it in the
  // cap with the same memo boundaries so width/layout/page transitions include
  // the production horizontal-pricing work, while vertical wheel-only renders
  // correctly reuse the prior result.
  const activeDiffContent = useMemo<ReviewDiffHorizontalFile[]>(
    () =>
      view.page.files.flatMap((group) => {
        const file = benchmarkPatch.fileDiff(group.file);
        if (file === null) return [];
        const renderedHunkIndices = group.hunks.flatMap((hunk) => {
          const hunkIndex = benchmarkPatch.hunkIndex(hunk);
          return hunkIndex === null || hunk.status !== 'matched' ? [] : [hunkIndex];
        });
        return renderedHunkIndices.length === 0 ? [] : [{ file, renderedHunkIndices }];
      }),
    [benchmarkPatch, view.page]
  );
  const horizontalContentMetrics = useMemo(
    () => measureReviewDiffHorizontalContent(activeDiffContent),
    [activeDiffContent]
  );
  const horizontalMaxOffset = useMemo(
    () =>
      maxReviewCodeHorizontalOffsetFromMetrics({
        metrics: horizontalContentMetrics,
        width: view.terminalWidth,
        layout: view.layout,
        showLineNumbers: true,
      }),
    [horizontalContentMetrics, view.layout, view.terminalWidth]
  );
  void horizontalMaxOffset;

  return (
    <ThemeProvider detectedThemeMode={undefined}>
      <scrollbox
        id="benchmark-review-scroll"
        ref={onScrollSurface}
        scrollY={true}
        focused={false}
        flexGrow={1}
      >
        <box flexDirection="column" onMouseScroll={onMouseScroll}>
          <CheckpointDiff
            page={view.page}
            patch={benchmarkPatch}
            theme={theme}
            width={view.cardWidth}
            layout={view.layout}
            cursorHunkKey={view.cursorHunkKey}
            pins={NO_PINS}
            expandedForeignHunks={NO_EXPANDED_FOREIGN_HUNKS}
            scrollTop={view.scrollTop}
            viewportHeight={view.viewportHeight}
            tightViewportWindow={view.tightViewportWindow}
            overscanRows={view.overscanRows}
            preserveSourceViewport={true}
            onMeasured={publishMeasured}
          />
        </box>
      </scrollbox>
    </ThemeProvider>
  );
}

interface RssFileBoundarySample {
  fileBoundary: number;
  hunksCompleted: number;
  rssBytes: number;
}

interface FullTraversalMemoryMeasurement {
  coldBaseline: MemorySnapshot;
  immediatePostTraversal: MemorySnapshot;
  retained: MemorySnapshot;
  traversalHunks: number;
  destinationsSettledAfterMountedQueueIdle: number;
  mountedSchedulerCompletionsDuringTraversal: number;
  rssFileBoundaries: RssFileBoundarySample[];
  maxMountedNodes: number;
}

/**
 * Measure one complete production traversal in a fresh immutable patch
 * generation. Every destination is committed and waits for the mounted syntax
 * queue to become idle; a monotonic scheduler counter separately proves that
 * mounted scheduler work actually completed during the traversal. Forced-GC RSS
 * samples at each file boundary expose whether growth continues after the
 * conservative cold-to-retained resident-working-set guard.
 */
async function measureFullTraversalMemory(): Promise<FullTraversalMemoryMeasurement> {
  const memoryPatch = buildPatchIndex(fixture.patch);
  const memoryHarness = await createTestRenderer({
    width: INITIAL_TERMINAL_WIDTH,
    height: INITIAL_VIEWPORT_HEIGHT,
  });
  const memoryRoot = createRoot(memoryHarness.renderer);
  let updateMemoryView: React.Dispatch<React.SetStateAction<BenchmarkView>> | null = null;
  let memoryLayout: CheckpointLayout | null = null;
  // Assigned from a render callback; see `mountedSurface` for why the read
  // has to go through a function to keep its declared type.
  const mountedMemoryLayout = (): CheckpointLayout | null => memoryLayout;
  let maxNodes = 0;

  function MemorySurface() {
    const [view, setView] = useState(initialView);
    updateMemoryView = setView;
    return (
      <ReviewSurface
        view={view}
        benchmarkPatch={memoryPatch}
        onScrollSurface={() => undefined}
        onMeasured={(layout) => {
          memoryLayout = layout;
        }}
      />
    );
  }

  try {
    flushSync(() => memoryRoot.render(<MemorySurface />));
    await memoryHarness.renderOnce();
    await waitForMountedDiffHighlightsIdle();
    flushSync();
    await memoryHarness.renderOnce();
    maxNodes = Math.max(maxNodes, countNodes(memoryHarness.renderer.root));
    // The fixed idle makes the JSC and RSS pre/post snapshots equivalent. RSS
    // remains a conservative resident-working-set guard rather than a claim
    // about live native allocation, because allocators may retain high-water pages.
    const coldBaseline = await collectQuiescentMemory();
    const rssFileBoundaries: RssFileBoundarySample[] = [];
    let traversalHunks = 0;
    let destinationsSettledAfterMountedQueueIdle = 0;
    const schedulerCompletionsBeforeTraversal = readMountedDiffHighlightSchedulerCompletionCount();
    let immediatePostTraversal: MemorySnapshot | null = null;

    for (let fileIndex = 0; fileIndex < fixture.page.files.length; fileIndex += 1) {
      const file = fixture.page.files[fileIndex]!;
      for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
        const hunk = file.hunks[hunkIndex]!;
        const layout = mountedMemoryLayout();
        const destination = layout?.byHunkKey.get(hunk.hunkKey)?.top;
        if (destination === undefined) {
          throw new Error(`memory traversal could not resolve ${hunk.hunkKey}`);
        }
        if (updateMemoryView === null) throw new Error('memory surface did not mount');
        flushSync(() =>
          updateMemoryView?.((view) => ({
            ...view,
            scrollTop: destination,
            cursorHunkKey: hunk.hunkKey,
          }))
        );
        await memoryHarness.renderOnce();
        await waitForMountedDiffHighlightsIdle();
        flushSync();
        await memoryHarness.renderOnce();
        traversalHunks += 1;
        destinationsSettledAfterMountedQueueIdle += 1;
        maxNodes = Math.max(maxNodes, countNodes(memoryHarness.renderer.root));

        const isFinalDestination =
          fileIndex === fixture.page.files.length - 1 && hunkIndex === file.hunks.length - 1;
        if (isFinalDestination) {
          // Read before the final boundary GC so this stays a true immediate
          // working-set observation, never a retained-memory verdict.
          immediatePostTraversal = readMemorySnapshot();
        }
      }

      // Boundary samples intentionally skip the 3 s allocator wait. Two-pass
      // forced GC makes live native/JS growth comparable without turning 48
      // leak-slope observations into a multi-minute quiescence sequence.
      const snapshot = await collectMemory();
      rssFileBoundaries.push({
        fileBoundary: fileIndex + 1,
        hunksCompleted: traversalHunks,
        rssBytes: snapshot.rss,
      });
    }

    if (immediatePostTraversal === null) {
      throw new Error('memory traversal produced no immediate working-set snapshot');
    }
    const retained = await collectQuiescentMemory();
    const mountedSchedulerCompletionsDuringTraversal =
      readMountedDiffHighlightSchedulerCompletionCount() - schedulerCompletionsBeforeTraversal;
    return {
      coldBaseline,
      immediatePostTraversal,
      retained,
      traversalHunks,
      destinationsSettledAfterMountedQueueIdle,
      mountedSchedulerCompletionsDuringTraversal,
      rssFileBoundaries,
      maxMountedNodes: maxNodes,
    };
  } finally {
    flushSync(() => memoryRoot.unmount());
    await memoryHarness.renderOnce();
    memoryHarness.renderer.destroy();
    await waitForMountedDiffHighlightsIdle();
  }
}

interface ColdMountMeasurement {
  samples: number[];
  usefulFrames: boolean[];
  blankFramesBeforeUseful: number[];
  layoutPublications: number[];
  maxMountedNodes: number;
}

function rotatePage(page: LayoutPage, offset: number): LayoutPage {
  return {
    ...page,
    files: [...page.files.slice(offset), ...page.files.slice(0, offset)],
  };
}

/**
 * Measure independent first paints. Every sample owns a renderer, React root,
 * PatchIndex, and first-visible file, so neither WeakMap geometry nor shared
 * highlight entries turn later observations into warm remounts.
 */
async function measureColdFirstUsefulFrames(): Promise<ColdMountMeasurement> {
  const samples: number[] = [];
  const usefulFrames: boolean[] = [];
  const blankFramesBeforeUseful: number[] = [];
  const layoutPublications: number[] = [];
  let maxMountedNodes = 0;

  for (let sample = 0; sample < COLD_MOUNT_SAMPLES; sample += 1) {
    // Traversal runs before this phase to keep its RSS baseline uncontaminated.
    // Start on files 8..27: fresh PatchIndex objects make geometry cold, while
    // the bounded shared syntax LRU has evicted these earlier traversal entries.
    const pageOffset = 8 + sample;
    const samplePage = rotatePage(fixture.page, pageOffset);
    const sampleHunk = samplePage.files[0]?.hunks[0]?.hunkKey ?? null;
    const sampleView: BenchmarkView = {
      ...initialView,
      page: samplePage,
      cursorHunkKey: sampleHunk,
    };
    const harness = await createTestRenderer({
      width: INITIAL_TERMINAL_WIDTH,
      height: INITIAL_VIEWPORT_HEIGHT,
    });
    const root = createRoot(harness.renderer);
    let measuredCount = 0;
    let blankFrames = 0;
    let useful = false;
    let usefulFrameMs = 0;
    // Each observation represents an independent cold mount. Reclaim the prior
    // sample's now-unreachable 10 MiB PatchIndex/layout graph before starting
    // this stopwatch so an arbitrary later sample does not inherit another
    // process's GC pause. The index build below remains fully inside timing.
    await forceFullGc();
    const startedAt = performance.now();
    let lastSettledAt = startedAt;

    try {
      // ReviewApp synchronously performs the same raw-diff index build before it
      // can render this production diff subtree. Keep that work inside the
      // stopwatch even though the surrounding application shell is excluded.
      const samplePatch = buildPatchIndex(fixture.patch);
      flushSync(() =>
        root.render(
          <ReviewSurface
            view={sampleView}
            benchmarkPatch={samplePatch}
            onScrollSurface={() => undefined}
            onMeasured={() => {
              measuredCount += 1;
            }}
          />
        )
      );

      // A useful frame should be the first commit. Keep a bounded fallback so
      // the report records time-to-useful rather than pretending a blank first
      // commit succeeded; every blank committed frame is still a gate failure.
      for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
        await harness.renderOnce();
        const settledAt = performance.now();
        lastSettledAt = settledAt;
        const frame = harness.captureCharFrame();
        if (frameContainsUsefulDiff(frame)) {
          useful = true;
          usefulFrameMs = settledAt - startedAt;
          break;
        }
        blankFrames += 1;
        await Bun.sleep(0);
        flushSync();
      }

      maxMountedNodes = Math.max(maxMountedNodes, countNodes(harness.renderer.root));
      if (!useful) usefulFrameMs = lastSettledAt - startedAt;
    } finally {
      flushSync(() => root.unmount());
      await harness.renderOnce();
      harness.renderer.destroy();
    }

    samples.push(usefulFrameMs);
    usefulFrames.push(useful);
    blankFramesBeforeUseful.push(blankFrames);
    layoutPublications.push(measuredCount);

    // Hooks begin syntax work after the first paint. Drain or cancel that exact
    // mounted demand before timing another root, so samples cannot inherit CPU
    // contention from a destroyed tree. Every sample still starts on a distinct
    // immutable file generation and therefore remains cold.
    await waitForMountedDiffHighlightsIdle();
  }

  return {
    samples,
    usefulFrames,
    blankFramesBeforeUseful,
    layoutPublications,
    maxMountedNodes,
  };
}

const mainHarness = await createTestRenderer({
  width: INITIAL_TERMINAL_WIDTH,
  height: INITIAL_VIEWPORT_HEIGHT,
});
const mainRoot = createRoot(mainHarness.renderer);
let updateView: React.Dispatch<React.SetStateAction<BenchmarkView>> | null = null;
let currentView = initialView;
let scrollSurface: ScrollBoxRenderable | null = null;
let latestMeasured: CheckpointLayout | null = null;

/**
 * Read the bindings the render callbacks fill in.
 *
 * TypeScript narrows a `let` to the `null` it was initialized with and cannot
 * see assignments made inside those callbacks, so reading the binding directly
 * collapses every downstream property access to `never`. Inside a function
 * body the DECLARED type applies again, which is all these do — no runtime
 * behaviour, and the null checks at each call site are unchanged.
 */
const mountedSurface = (): ScrollBoxRenderable | null => scrollSurface;
const mountedLayout = (): CheckpointLayout | null => latestMeasured;
const mountedViewport = (): InteractionPublication | null => nativeViewportPublication;
const layoutPublications = new Map<number, number>();
const layoutPublicationAt = new Map<number, number>();

interface InteractionPublication {
  sequence: number;
  eventStartedAt: number;
  stateCommittedAt?: number;
  scrollTop: number;
}

let wheelPublication: InteractionPublication | null = null;
let nativeViewportPublication: InteractionPublication | null = null;
let geometryMutationInProgress = false;
const nativeViewportWaiters = new Set<() => void>();

function publishNativeViewport(publication: InteractionPublication): void {
  nativeViewportPublication = publication;
  for (const resolve of nativeViewportWaiters) resolve();
  nativeViewportWaiters.clear();
}

async function waitForNativeViewport(afterSequence: number): Promise<InteractionPublication> {
  const current = nativeViewportPublication;
  if (current !== null && current.sequence > afterSequence) return current;

  await Promise.race([
    new Promise<void>((resolve) => nativeViewportWaiters.add(resolve)),
    Bun.sleep(250).then(() => {
      throw new Error('native scrollbar change did not reach the React viewport mirror');
    }),
  ]);
  const published = nativeViewportPublication;
  if (published === null || published.sequence <= afterSequence) {
    throw new Error('native scrollbar mirror published no new destination');
  }
  return published;
}

function recordMeasuredLayout(generation: number, layout: CheckpointLayout): void {
  latestMeasured = layout;
  layoutPublications.set(generation, (layoutPublications.get(generation) ?? 0) + 1);
  layoutPublicationAt.set(generation, performance.now());
}

function BenchmarkSurface() {
  const [view, setView] = useState(initialView);
  const generationRef = useRef(view.layoutGeneration);
  const surfaceRef = useRef<ScrollBoxRenderable | null>(null);
  const programmaticSurfaceWriteRef = useRef(false);
  const nativeViewportReadQueuedRef = useRef(false);
  const nativeViewportEventStartedAtRef = useRef(0);
  const overscanIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  generationRef.current = view.layoutGeneration;
  updateView = setView;

  const bindScrollSurface = useCallback((surface: ScrollBoxRenderable | null) => {
    surfaceRef.current = surface;
    scrollSurface = surface;
  }, []);
  const handleMeasured = useCallback((layout: CheckpointLayout) => {
    recordMeasuredLayout(generationRef.current, layout);
  }, []);

  const applyInteractiveScroll = useCallback(
    (
      nextScrollTop: number,
      adaptiveOverscan = true,
      continuous = false,
      tightViewportWindow = false
    ): void => {
      deferMountedDiffHighlightsForInteraction();
      const previous = currentView;
      const viewportHeight = Math.max(
        1,
        surfaceRef.current?.viewport.height ?? previous.viewportHeight
      );
      const overscanRows = adaptiveOverscan
        ? computeRapidScrollOverscanRows({
            deltaRows: nextScrollTop - previous.scrollTop,
            viewportHeight,
            continuous,
          })
        : 0;
      const next = {
        ...previous,
        scrollTop: nextScrollTop,
        tightViewportWindow,
        overscanRows: Math.max(previous.overscanRows, overscanRows),
      };
      currentView = next;
      setView(next);

      if (overscanRows <= 0) return;
      if (overscanIdleTimerRef.current !== null) clearTimeout(overscanIdleTimerRef.current);
      overscanIdleTimerRef.current = setTimeout(() => {
        overscanIdleTimerRef.current = null;
        if (currentView.overscanRows === 0) return;
        const settled = { ...currentView, overscanRows: 0 };
        currentView = settled;
        setView(settled);
      }, RAPID_SCROLL_OVERSCAN_IDLE_MS);
    },
    []
  );

  const handleMouseScroll = useCallback(
    (event: MouseEvent): void => {
      const scroll = event.scroll;
      if (scroll === undefined) return;
      const intent = reviewDiffWheelIntent({
        direction: scroll.direction,
        delta: scroll.delta,
        shift: event.modifiers.shift,
      });
      if (intent === null || intent.axis !== 'vertical') return;
      event.stopPropagation();

      const eventStartedAt = performance.now();
      const surface = surfaceRef.current;
      const viewport = Math.max(1, surface?.viewport.height ?? currentView.viewportHeight);
      const content = Math.max(0, surface?.scrollHeight ?? 0);
      const maxScrollTop = Math.max(0, content - viewport);
      const nextScrollTop = Math.min(
        maxScrollTop,
        Math.max(0, currentView.scrollTop + intent.delta)
      );
      applyInteractiveScroll(nextScrollTop, true, true);
      wheelPublication = {
        sequence: (wheelPublication?.sequence ?? 0) + 1,
        eventStartedAt,
        scrollTop: nextScrollTop,
      };
    },
    [applyInteractiveScroll]
  );

  // Match ReviewApp's ordering: React commits the mount window around the
  // destination first, then the native viewport moves in a layout effect.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null || surface.scrollTop === view.scrollTop) return;
    programmaticSurfaceWriteRef.current = true;
    surface.scrollTop = view.scrollTop;
    programmaticSurfaceWriteRef.current = false;
  }, [view.scrollTop, view.layoutGeneration]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const scrollbar = surface.verticalScrollBar;
    let cancelled = false;
    const mirrorNativeScrollbarChange = (): void => {
      if (programmaticSurfaceWriteRef.current || geometryMutationInProgress) return;
      if (nativeViewportReadQueuedRef.current) return;
      nativeViewportReadQueuedRef.current = true;
      nativeViewportEventStartedAtRef.current = performance.now();
      queueMicrotask(() => {
        nativeViewportReadQueuedRef.current = false;
        if (cancelled) return;
        const viewport = Math.max(1, surface.viewport.height);
        const observed = Math.min(
          Math.max(0, surface.scrollHeight - viewport),
          Math.max(0, surface.scrollTop)
        );
        // ReviewApp makes the same distinction: a real scrollbar move owns the
        // native surface already, so mirror it synchronously before the next
        // timer-driven terminal frame. App-owned writes are filtered above.
        flushSync(() => applyInteractiveScroll(observed, false, false, true));
        publishNativeViewport({
          sequence: (nativeViewportPublication?.sequence ?? 0) + 1,
          eventStartedAt: nativeViewportEventStartedAtRef.current,
          stateCommittedAt: performance.now(),
          scrollTop: observed,
        });
      });
    };
    scrollbar.on('change', mirrorNativeScrollbarChange);
    return () => {
      cancelled = true;
      scrollbar.off('change', mirrorNativeScrollbarChange);
    };
  }, [applyInteractiveScroll]);

  useLayoutEffect(
    () => () => {
      if (overscanIdleTimerRef.current !== null) clearTimeout(overscanIdleTimerRef.current);
    },
    []
  );

  return (
    <ReviewSurface
      view={view}
      benchmarkPatch={patch}
      onScrollSurface={bindScrollSurface}
      onMeasured={handleMeasured}
      onMouseScroll={handleMouseScroll}
    />
  );
}

async function commitView(
  next: BenchmarkView,
  options: { inspect?: boolean; viewportActivity?: boolean } = {}
): Promise<{
  startedAt: number;
  elapsedMs: number;
  settledAt: number;
  frame: string;
  mountedNodes: number;
  appliedScrollTop: number;
}> {
  if (updateView === null) throw new Error('benchmark surface did not mount');
  const commitStarted = performance.now();
  if (options.viewportActivity) deferMountedDiffHighlightsForInteraction();
  currentView = next;
  flushSync(() => updateView?.(next));
  await mainHarness.renderOnce();
  const settledAt = performance.now();
  const inspect = options.inspect ?? true;
  return {
    startedAt: commitStarted,
    elapsedMs: settledAt - commitStarted,
    settledAt,
    frame: inspect ? mainHarness.captureCharFrame() : '',
    mountedNodes: inspect ? countNodes(mainHarness.renderer.root) : 0,
    appliedScrollTop: mountedSurface()?.scrollTop ?? 0,
  };
}

async function settleMainRenderer(passes = 6): Promise<void> {
  let previousNodes = -1;
  let previousFrame: string | null = null;
  for (let pass = 0; pass < passes; pass += 1) {
    await Bun.sleep(0);
    flushSync();
    await mainHarness.renderOnce();
    const nodes = countNodes(mainHarness.renderer.root);
    const frame = mainHarness.captureCharFrame();
    if (nodes === previousNodes && frame === previousFrame) return;
    previousNodes = nodes;
    previousFrame = frame;
  }
}

let maxCoreMountedNodes = 0;
let maxCoreMountedNodesPhase = 'unobserved';
let maxProductMountedNodes = 0;
let maxProductMountedNodesPhase = 'unobserved';

interface ProductNodeObservation {
  phase: string;
  mountedNodes: number;
  viewportRows: number;
  contentRows: number;
  scrollTop: number;
  geometryState: 'viewport-measured' | 'bootstrap-or-unmeasured';
}

const productNodeObservations: ProductNodeObservation[] = [];

function recordCoreMountedNodes(mountedNodes: number, phase: string): void {
  if (mountedNodes <= maxCoreMountedNodes) return;
  maxCoreMountedNodes = mountedNodes;
  maxCoreMountedNodesPhase = phase;
}

function recordProductMountedNodes(
  app: Awaited<ReturnType<typeof mountReviewApp>>,
  phase: string
): void {
  const mountedNodes = app.diffNodeCount();
  const bounds = app.scrollBounds();
  const observation: ProductNodeObservation = {
    phase,
    mountedNodes,
    viewportRows: bounds.viewport,
    contentRows: bounds.content,
    scrollTop: bounds.top,
    geometryState:
      bounds.viewport > 0 && bounds.content > 0 ? 'viewport-measured' : 'bootstrap-or-unmeasured',
  };
  productNodeObservations.push(observation);
  if (mountedNodes <= maxProductMountedNodes) return;
  maxProductMountedNodes = mountedNodes;
  maxProductMountedNodesPhase = phase;
}

try {
  // The long-lived harness is intentionally separate from the cold-mount
  // distribution. It supplies interaction and retained-memory samples without
  // letting those later phases rewrite the first-useful-frame claim.
  flushSync(() => mainRoot.render(<BenchmarkSurface />));
  await mainHarness.renderOnce();
  const initialFrame = mainHarness.captureCharFrame();
  if (!frameContainsUsefulDiff(initialFrame)) {
    throw new Error('long-lived interaction surface did not render a useful initial frame');
  }
  recordCoreMountedNodes(countNodes(mainHarness.renderer.root), 'initial-converged');
  if (latestMeasured === null) throw new Error('initial review layout was not published');

  // First-useful-frame above intentionally races no syntax completion. The
  // steady interaction gates below isolate wheel/navigation/drag/resize work:
  // drain the initial mounted hooks so a zero-delay Shiki job cannot randomly
  // run between an input event and the test renderer's next explicit frame.
  // Syntax latency remains independently gated later through a mounted DiffSlice.
  const initialSyntaxFileName = fixture.page.files[0]?.file;
  const initialSyntaxFile =
    initialSyntaxFileName === undefined ? null : patch.fileDiff(initialSyntaxFileName);
  if (initialSyntaxFile === null) throw new Error('initial syntax sentinel file is unavailable');
  await Bun.sleep(0);
  await loadHighlightedDiffHunk(initialSyntaxFile, PAGE_HUNKS_PER_FILE - 1, theme);
  await waitForMountedDiffHighlightsIdle();
  await settleMainRenderer();

  const traversalMemory = await measureFullTraversalMemory();
  recordCoreMountedNodes(traversalMemory.maxMountedNodes, 'fresh-full-traversal');
  const memoryBaseline = traversalMemory.coldBaseline;
  const memoryImmediatePostTraversal = traversalMemory.immediatePostTraversal;
  const memoryRetained = traversalMemory.retained;

  // Preserve cold index/layout observability without priming the first useful
  // frame. A fresh PatchIndex gives the isolated layout its own WeakMap keys, so
  // it does not inherit the mounted renderer's row cache.
  const observabilityPatch = buildPatchIndex(fixture.patch);
  started = performance.now();
  const isolatedLayout = buildCheckpointLayout({
    page: fixture.page,
    patch: observabilityPatch,
    theme,
    layout: 'split',
    cardWidth: INITIAL_CARD_WIDTH,
    annotations: NO_PINS,
  });
  const layoutMs = performance.now() - started;
  const observabilityStackPatch = buildPatchIndex(fixture.patch);
  started = performance.now();
  const isolatedStackLayout = buildCheckpointLayout({
    page: fixture.page,
    patch: observabilityStackPatch,
    theme,
    layout: 'stack',
    cardWidth: 74,
    annotations: NO_PINS,
  });
  const stackLayoutMs = performance.now() - started;

  const wheelSamples: number[] = [];
  const wheelFramesValid: boolean[] = [];
  const wheelSetupSamples: number[] = [];
  const wheelSetupFramesValid: boolean[] = [];
  const wheelDestinationDiagnostics: Array<{
    direction: 'up' | 'down';
    scenario: 'continuous' | 'file-boundary';
    setupScrollTop: number | null;
    publishedScrollTop: number;
    appliedScrollTop: number;
    expectedHunk: string | null;
    firstVisibleMarker: string | null;
    valid: boolean;
  }> = [];
  const wheelSurface = mountedSurface();
  if (wheelSurface === null) throw new Error('wheel surface is unavailable');
  const wheelX = wheelSurface.x + Math.min(8, Math.max(1, wheelSurface.width - 2));
  const wheelY = wheelSurface.y + Math.min(8, Math.max(1, wheelSurface.height - 2));
  // Wheel is an independent continuous scenario. Collect completed fixture and
  // observability work before entry, never between its setup or 32 samples.
  await forceFullGc();
  const exerciseWheel = async (direction: 'up' | 'down') => {
    const beforeSequence = wheelPublication?.sequence ?? 0;
    await mainHarness.mockMouse.scroll(wheelX, wheelY, direction, { delayMs: 0 });
    const published = wheelPublication;
    if (published === null || published.sequence <= beforeSequence) {
      throw new Error('mounted wheel event did not reach the app-owned scroll coordinator');
    }
    // The test renderer has no continuous frame scheduler. Promote the already
    // queued product state to the current frame without yielding to unrelated
    // zero-delay background jobs; React reconciliation remains inside latency.
    if (updateView === null) throw new Error('wheel update surface is unavailable');
    flushSync(() => updateView?.(currentView));
    await mainHarness.renderOnce();
    const settledAt = performance.now();
    const frame = mainHarness.captureCharFrame();
    const mountedNodes = countNodes(mainHarness.renderer.root);
    const appliedScrollTop = mountedSurface()?.scrollTop ?? 0;
    const expectedHunk = expectedFirstVisibleHunk(
      mountedLayout()!,
      published.scrollTop,
      currentView.viewportHeight
    );
    return {
      appliedScrollTop,
      expectedHunk,
      firstVisibleMarker: firstVisibleBenchmarkMarker(frame),
      latencyMs: settledAt - published.eventStartedAt,
      mountedNodes,
      publishedScrollTop: published.scrollTop,
      valid:
        appliedScrollTop === published.scrollTop &&
        expectedHunk !== null &&
        frameContainsHunk(frame, expectedHunk),
    };
  };

  // These are not discarded warmups: they are real, timed, destination-checked
  // interactions reported as rapid-scroll entry diagnostics. The premium wheel
  // percentile below starts only after the continuous halo and its mounted
  // effects have converged, matching the gate's steady-interaction contract.
  for (let setup = 0; setup < WHEEL_STEADY_STATE_SETUP_EVENTS; setup += 1) {
    const result = await exerciseWheel('down');
    wheelSetupSamples.push(result.latencyMs);
    wheelSetupFramesValid.push(result.valid);
    recordCoreMountedNodes(result.mountedNodes, `wheel-steady-state-setup-${setup + 1}`);
  }

  const boundarySections = mountedLayout()!.fileSections.filter(
    (_section, index) => index > 0 && index % 4 === 0
  );
  const wheelScenarios: Array<{
    direction: 'up' | 'down';
    setupScrollTop?: number;
  }> = [
    ...Array.from({ length: 12 }, () => ({ direction: 'down' as const })),
    ...boundarySections.slice(0, 10).map((section) => ({
      direction: 'down' as const,
      setupScrollTop: Math.max(0, section.sectionTop - 1),
    })),
    ...boundarySections.slice(-10).map((section) => ({
      direction: 'up' as const,
      setupScrollTop: section.sectionTop + 1,
    })),
  ];
  if (wheelScenarios.length !== WHEEL_SAMPLES) {
    throw new Error(`wheel scenario count ${wheelScenarios.length} != ${WHEEL_SAMPLES}`);
  }
  if (
    wheelScenarios.some(
      (scenario) =>
        scenario.setupScrollTop !== undefined && !Number.isFinite(scenario.setupScrollTop)
    )
  ) {
    throw new Error('wheel boundary scenario resolved a non-finite scroll destination');
  }
  for (const scenario of wheelScenarios) {
    if (scenario.setupScrollTop !== undefined) {
      const expected = expectedFirstVisibleHunk(
        latestMeasured,
        scenario.setupScrollTop,
        currentView.viewportHeight
      );
      const setup = await commitView(
        {
          ...currentView,
          scrollTop: scenario.setupScrollTop,
          cursorHunkKey: expected,
        },
        { inspect: false, viewportActivity: true }
      );
      recordCoreMountedNodes(setup.mountedNodes, 'wheel-boundary-setup');
    }
    const result = await exerciseWheel(scenario.direction);
    wheelSamples.push(result.latencyMs);
    wheelFramesValid.push(result.valid);
    wheelDestinationDiagnostics.push({
      direction: scenario.direction,
      scenario: scenario.setupScrollTop === undefined ? 'continuous' : 'file-boundary',
      setupScrollTop: scenario.setupScrollTop ?? null,
      publishedScrollTop: result.publishedScrollTop,
      appliedScrollTop: result.appliedScrollTop,
      expectedHunk: result.expectedHunk,
      firstVisibleMarker: result.firstVisibleMarker,
      valid: result.valid,
    });
    recordCoreMountedNodes(result.mountedNodes, `wheel-${scenario.direction}`);
  }
  const wheel = distribution(wheelSamples);

  // Alternate true page changes with in-page file destinations. This covers
  // Part/checkpoint projection replacement and file navigation without timing
  // async syntax completion as part of the first usable destination frame.
  const navigationPages = Array.from({ length: PAGE_FILES / 6 }, (_unused, index) => ({
    files: fixture.page.files.slice(index * 6, index * 6 + 6),
    findings: [],
  })) satisfies LayoutPage[];
  const pageNavigationSamples: number[] = [];
  const fileNavigationSamples: number[] = [];
  const navigationFramesValid: boolean[] = [];

  for (let round = 0; round < NAVIGATION_PAGE_ROUNDS; round += 1) {
    for (const page of navigationPages) {
      const firstFile = page.files[0];
      const first = firstFile?.hunks[0];
      const pageView = {
        ...currentView,
        page,
        scrollTop: 0,
        cursorHunkKey: first?.hunkKey ?? null,
        layoutGeneration: currentView.layoutGeneration + 1,
      };
      const pageCommit = await commitView(pageView, { viewportActivity: true });
      pageNavigationSamples.push(pageCommit.elapsedMs);
      navigationFramesValid.push(
        firstFile !== undefined &&
          pageCommit.appliedScrollTop === 0 &&
          frameContainsFile(pageCommit.frame, firstFile.file)
      );
      recordCoreMountedNodes(pageCommit.mountedNodes, 'render-core-page-navigation');

      const lastFile = page.files[page.files.length - 1];
      const last = lastFile?.hunks[0];
      const destination =
        last === undefined
          ? 0
          : Math.max(0, (latestMeasured?.byHunkKey.get(last.hunkKey)?.top ?? 0) - 1);
      const fileView = {
        ...currentView,
        scrollTop: destination,
        cursorHunkKey: last?.hunkKey ?? null,
      };
      const fileCommit = await commitView(fileView, { viewportActivity: true });
      fileNavigationSamples.push(fileCommit.elapsedMs);
      navigationFramesValid.push(
        lastFile !== undefined &&
          fileCommit.appliedScrollTop === destination &&
          frameContainsFile(fileCommit.frame, lastFile.file)
      );
      recordCoreMountedNodes(fileCommit.mountedNodes, 'render-core-file-navigation');
    }
  }
  const navigationSamples = [...pageNavigationSamples, ...fileNavigationSamples];
  const navigation = distribution(navigationSamples);

  // Product gate: drive the real ReviewApp controller between two complete
  // 480-hunk checkpoint pages. The second page reverses file order, making a
  // stale destination frame observable instead of letting identical text pass.
  const firstProductHunk = fixture.page.files[0]?.hunks[0]?.hunkKey ?? null;
  const firstProductSlice = fixture.page.files[0]?.slices[0]?.sliceKey ?? null;
  const productNavigationSamples: number[] = [];
  const productNavigationFramesValid: boolean[] = [];
  const productNavigationApp = await mountReviewApp({
    scenario: 'no-narrative',
    screen: 'floor-diff',
    width: INITIAL_TERMINAL_WIDTH,
    height: INITIAL_VIEWPORT_HEIGHT,
    initialLoadedOverride: productLoaded,
    controllerState: {
      screen: 'floor-diff',
      readerPage: 0,
      focus: 'diff',
      diffHunkKey: firstProductHunk,
      diffSliceKey: firstProductSlice,
    },
  });
  recordProductMountedNodes(productNavigationApp, 'navigation-initial-converged');
  try {
    for (let round = 0; round < PRODUCT_NAVIGATION_ROUNDS; round += 1) {
      // Each pair represents a reviewer moving to a checkpoint and comparing it
      // with the prior page after reading. Reclaim the previous pair outside the
      // stopwatch; both actions inside the pair remain uninterrupted.
      await forceFullGc();
      for (const destination of [1, 0] as const) {
        const navigationStarted = performance.now();
        await productNavigationApp.press(destination === 1 ? ']' : '[');
        const settledAt = performance.now();
        const expectedFile = destination === 1 ? 'src/cap/f47.ts' : 'src/cap/f0.ts';
        productNavigationSamples.push(settledAt - navigationStarted);
        productNavigationFramesValid.push(
          productNavigationApp.state().readerPage === destination &&
            productNavigationApp.scrollTop() === 0 &&
            frameContainsFile(productNavigationApp.frame(), expectedFile)
        );
        recordProductMountedNodes(
          productNavigationApp,
          `navigation-round-${round + 1}-page-${destination}-converged`
        );
      }
    }
  } finally {
    productNavigationApp.unmount();
  }
  const productNavigation = distribution(productNavigationSamples);

  // Return to the complete 480-hunk page before native-scroll and resize gates.
  let restored = await commitView(
    {
      ...currentView,
      page: fixture.page,
      scrollTop: 0,
      cursorHunkKey: initialHunk,
      layoutGeneration: currentView.layoutGeneration + 1,
    },
    { viewportActivity: true }
  );
  recordCoreMountedNodes(restored.mountedNodes, 'render-core-full-page-restored');
  if (latestMeasured === null) throw new Error('full review layout did not restore');

  // Exercise the real ScrollBar Slider: the native surface moves first, emits
  // `change`, and only then does the coalesced viewport mirror ask React to
  // remount around that observed destination. This is intentionally the inverse
  // of app-owned navigation, and the path where blank spacers surface — so these
  // samples check for them.
  const dragRatios = [0.92, 0.08, 0.8, 0.18, 0.68, 0.32, 0.56, 0.44];
  const dragSamples: number[] = [];
  const dragMirrorSamples: number[] = [];
  const dragFrameSamples: number[] = [];
  const dragFramesValid: boolean[] = [];
  const dragBlankFrames: boolean[] = [];
  const dragStaleFrames: boolean[] = [];
  const dragSurface = mountedSurface();
  if (dragSurface === null) throw new Error('native drag surface is unavailable');
  const dragSlider = dragSurface.verticalScrollBar.slider;
  const dragX = dragSlider.x + Math.max(0, dragSlider.width - 1);
  const dragStartY = dragSlider.y;
  // This is one continuous gesture, independent of the page/file-navigation
  // allocations above. Reclaim that completed phase before mouse-down; never GC
  // between drag samples, where a pause is part of the gesture and must remain
  // visible to the max-latency gate.
  await forceFullGc();
  await mainHarness.mockMouse.pressDown(dragX, dragStartY, undefined, { delayMs: 0 });
  let dragEndY = dragStartY;

  for (const ratio of dragRatios) {
    const beforeSequence = mountedViewport()?.sequence ?? 0;
    dragEndY = dragSlider.y + Math.round(Math.max(0, dragSlider.height - 1) * ratio);
    await mainHarness.mockMouse.moveTo(dragX, dragEndY, { delayMs: 0 });
    const published = await waitForNativeViewport(beforeSequence);
    await mainHarness.renderOnce();
    const settledAt = performance.now();
    const stateCommittedAt = published.stateCommittedAt ?? published.eventStartedAt;
    const frame = mainHarness.captureCharFrame();
    const mountedNodes = countNodes(mainHarness.renderer.root);
    const appliedScrollTop = mountedSurface()?.scrollTop ?? 0;
    const visibleSection = findFileSectionAtOffset(
      mountedLayout()?.fileSections ?? [],
      appliedScrollTop
    );
    const blank = !frameContainsUsefulDiff(frame);
    const stale = visibleSection === null || !frameContainsFile(frame, visibleSection.fileId);
    dragSamples.push(settledAt - published.eventStartedAt);
    dragMirrorSamples.push(stateCommittedAt - published.eventStartedAt);
    dragFrameSamples.push(settledAt - stateCommittedAt);
    dragBlankFrames.push(blank);
    dragStaleFrames.push(stale);
    dragFramesValid.push(appliedScrollTop === published.scrollTop && !blank && !stale);
    recordCoreMountedNodes(mountedNodes, 'native-scrollbar-drag');
  }
  await mainHarness.mockMouse.release(dragX, dragEndY, undefined, { delayMs: 0 });
  const drag = distribution(dragSamples);

  // Let the same bounded rapid-scroll halo production uses contract before the
  // independent resize samples. This idle wait is benchmark setup, not latency.
  await Bun.sleep(RAPID_SCROLL_OVERSCAN_IDLE_MS + 20);
  flushSync();
  await mainHarness.renderOnce();

  // Resize from a meaningful source row, then alternate split/stack and height.
  // Timing ends only after the semantic anchor has been resolved in the new
  // geometry and the native viewport has committed that restored destination.
  const anchorSection = mountedLayout()!.fileSections[20];
  if (anchorSection === undefined) throw new Error('resize anchor section was not measured');
  restored = await commitView(
    {
      ...currentView,
      scrollTop: anchorSection.bodyTop + 4,
      cursorHunkKey: fixture.page.files[20]?.hunks[0]?.hunkKey ?? null,
      tightViewportWindow: false,
    },
    { viewportActivity: true }
  );
  recordCoreMountedNodes(restored.mountedNodes, 'render-core-resize-source');

  const resizeVariants = [
    { terminalWidth: 84, cardWidth: 74, viewportHeight: 24, layout: 'stack' as const },
    // A stable terminal width/layout height increase makes the full-product gate
    // prove newly exposed rows paint in the first frame, independent of shell
    // wrapping. The isolated render-core diagnostic changes its card by one
    // column so that phase still exercises and times an actual layout generation.
    { terminalWidth: 84, cardWidth: 75, viewportHeight: 36, layout: 'stack' as const },
    {
      terminalWidth: INITIAL_TERMINAL_WIDTH,
      cardWidth: INITIAL_CARD_WIDTH,
      viewportHeight: INITIAL_VIEWPORT_HEIGHT,
      layout: 'split' as const,
    },
    { terminalWidth: 104, cardWidth: 94, viewportHeight: 36, layout: 'split' as const },
    { terminalWidth: 78, cardWidth: 68, viewportHeight: 20, layout: 'stack' as const },
    { terminalWidth: 100, cardWidth: 90, viewportHeight: 28, layout: 'split' as const },
    {
      terminalWidth: INITIAL_TERMINAL_WIDTH,
      cardWidth: INITIAL_CARD_WIDTH,
      viewportHeight: INITIAL_VIEWPORT_HEIGHT,
      layout: 'split' as const,
    },
  ];
  const resizeSamples: number[] = [];
  const resizeFramesValid: boolean[] = [];
  const resizeBreakdown: Array<{
    from: string;
    to: string;
    rendererResizeMs: number;
    geometryCommitMs: number;
    geometryToLayoutPublicationMs: number;
    geometryAfterLayoutPublicationMs: number;
    anchorResolveMs: number;
    anchorCommitMs: number;
    totalMs: number;
  }> = [];

  for (const variant of resizeVariants) {
    if (latestMeasured === null) throw new Error('resize source layout is unavailable');
    const anchor = captureDiffScrollAnchor(latestMeasured, currentView.scrollTop);
    if (anchor === null) throw new Error('resize source anchor is unavailable');
    const resizeStarted = performance.now();
    const from = `${currentView.terminalWidth}x${currentView.viewportHeight}/${currentView.layout}`;
    const to = `${variant.terminalWidth}x${variant.viewportHeight}/${variant.layout}`;
    const geometryGeneration = currentView.layoutGeneration + 1;
    geometryMutationInProgress = true;
    try {
      const rendererResizeStarted = performance.now();
      mainHarness.resize(variant.terminalWidth, variant.viewportHeight);
      const rendererResizeSettled = performance.now();
      const geometryCommit = await commitView(
        {
          ...currentView,
          ...variant,
          layoutGeneration: geometryGeneration,
        },
        { inspect: false, viewportActivity: true }
      );
      let committed = geometryCommit;
      if (latestMeasured === null) throw new Error('resized layout was not published');
      const publishedAt = layoutPublicationAt.get(geometryGeneration);
      if (publishedAt === undefined) throw new Error('resized layout publication was not timed');
      const anchorResolveStarted = performance.now();
      const resolved = resolveDiffScrollAnchor(latestMeasured, anchor);
      const anchorResolveSettled = performance.now();
      if (resolved === null) throw new Error('resize source anchor did not resolve');
      let anchorCommitMs = 0;
      if (resolved.scrollTop !== currentView.scrollTop) {
        committed = await commitView(
          { ...currentView, scrollTop: resolved.scrollTop },
          { inspect: false, viewportActivity: true }
        );
        anchorCommitMs = committed.elapsedMs;
      }
      const elapsed = committed.settledAt - resizeStarted;
      const appliedScrollTop = mountedSurface()?.scrollTop ?? 0;
      const frame = mainHarness.captureCharFrame();
      const mountedNodes = countNodes(mainHarness.renderer.root);
      const recaptured = captureDiffScrollAnchor(latestMeasured, appliedScrollTop, resolved.key);
      resizeSamples.push(elapsed);
      resizeBreakdown.push({
        from,
        to,
        rendererResizeMs: rounded(rendererResizeSettled - rendererResizeStarted),
        geometryCommitMs: rounded(geometryCommit.elapsedMs),
        geometryToLayoutPublicationMs: rounded(publishedAt - geometryCommit.startedAt),
        geometryAfterLayoutPublicationMs: rounded(geometryCommit.settledAt - publishedAt),
        anchorResolveMs: rounded(anchorResolveSettled - anchorResolveStarted),
        anchorCommitMs: rounded(anchorCommitMs),
        totalMs: rounded(elapsed),
      });
      resizeFramesValid.push(
        appliedScrollTop === resolved.scrollTop &&
          recaptured?.keys[0] === resolved.key &&
          frameContainsUsefulDiff(frame)
      );
      recordCoreMountedNodes(mountedNodes, `render-core-resize-${to}`);
    } finally {
      geometryMutationInProgress = false;
    }
  }
  const resize = distribution(resizeSamples);

  // Product gate: terminal dimensions flow through ReviewApp, its viewport
  // listeners, semantic-anchor coordinator, destination-first CheckpointDiff,
  // and the bounded retry fence. Latency ends at the first correct committed
  // frame; a delayed assertion separately proves the retries do not move it.
  const resizeFile = fixture.page.files[20];
  const resizeHunk = resizeFile?.hunks[0];
  const resizeSlice = resizeFile?.slices[0];
  if (resizeFile === undefined || resizeHunk === undefined || resizeSlice === undefined) {
    throw new Error('product resize destination is unavailable');
  }
  const productResizeApp = await mountReviewApp({
    scenario: 'no-narrative',
    screen: 'floor-diff',
    width: INITIAL_TERMINAL_WIDTH,
    height: INITIAL_VIEWPORT_HEIGHT,
    initialLoadedOverride: productLoaded,
    controllerState: {
      screen: 'floor-diff',
      readerPage: 0,
      focus: 'diff',
      diffHunkKey: resizeHunk.hunkKey,
      diffSliceKey: resizeSlice.sliceKey,
    },
  });
  const productResizeSamples: number[] = [];
  const productResizeFramesValid: boolean[] = [];
  const productResizeCoverage: Array<{
    size: string;
    heightGrowthAtStableWidth: boolean;
    before: BenchmarkViewportCoverage;
    immediate: BenchmarkViewportCoverage;
    settled: BenchmarkViewportCoverage;
    valid: boolean;
  }> = [];
  const MAX_EXPECTED_MARKER_FREE_ROWS = 5;
  recordProductMountedNodes(productResizeApp, 'resize-initial-converged');
  try {
    // Initial controller selection is semantic state, not a promise that the
    // native viewport already moved. Drive the real next-file command once so
    // the resize source is observably deep in both React and OpenTUI.
    await productResizeApp.press('.');
    recordProductMountedNodes(productResizeApp, 'resize-deep-source-converged');
    const initialResizeMarker = firstVisibleBenchmarkMarker(productResizeApp.frame());
    if (
      productResizeApp.scrollTop() <= 0 ||
      initialResizeMarker === null ||
      !initialResizeMarker.includes('_21_')
    ) {
      throw new Error('product resize harness did not settle on its deep file-21 source row');
    }
    // Start the resize sequence after its deep source has converged. The seven
    // variants remain one uninterrupted sequence; only mount/setup garbage is
    // outside their max-latency gate.
    await forceFullGc();
    for (const variant of resizeVariants) {
      const beforeFrame = productResizeApp.frame();
      const marker = firstVisibleBenchmarkMarker(beforeFrame);
      if (marker === null) throw new Error('product resize source marker is unavailable');
      const beforeRect = productResizeApp.surfaceRect('review-diff-scroll');
      const beforeCoverage = benchmarkViewportCoverage(beforeFrame, beforeRect);
      const previousWidth = beforeRect.width;
      const previousHeight = beforeRect.height;
      const resizeStarted = performance.now();
      await productResizeApp.resizeOneFrame(variant.terminalWidth, variant.viewportHeight);
      const firstCorrectFrameAt = performance.now();
      const immediateFrame = productResizeApp.frame();
      const immediateMarker = firstVisibleBenchmarkMarker(immediateFrame);
      const immediateRect = productResizeApp.surfaceRect('review-diff-scroll');
      const immediateCoverage = benchmarkViewportCoverage(immediateFrame, immediateRect);
      productResizeSamples.push(firstCorrectFrameAt - resizeStarted);
      recordProductMountedNodes(
        productResizeApp,
        `resize-${variant.terminalWidth}x${variant.viewportHeight}-first-frame`
      );

      // The coordinator owns bounded 0/16/48 ms retries for late Yoga metrics.
      // Keep those outside first-correct-frame latency, but make their final state
      // part of the correctness gate so a delayed snap-back cannot pass.
      await productResizeApp.settle();
      await Bun.sleep(55);
      await productResizeApp.settle();
      const finalFrame = productResizeApp.frame();
      const finalMarker = firstVisibleBenchmarkMarker(finalFrame);
      const finalCoverage = benchmarkViewportCoverage(
        finalFrame,
        productResizeApp.surfaceRect('review-diff-scroll')
      );
      recordProductMountedNodes(
        productResizeApp,
        `resize-${variant.terminalWidth}x${variant.viewportHeight}-retry-settled`
      );
      const heightGrowthAtStableWidth =
        immediateRect.width === previousWidth && immediateRect.height > previousHeight;
      const valid =
        immediateMarker === marker &&
        finalMarker === marker &&
        immediateCoverage.markerRows > 0 &&
        immediateCoverage.longestMarkerFreeRun <= MAX_EXPECTED_MARKER_FREE_ROWS &&
        immediateCoverage.trailingMarkerFreeRows <= MAX_EXPECTED_MARKER_FREE_ROWS &&
        finalCoverage.longestMarkerFreeRun <= MAX_EXPECTED_MARKER_FREE_ROWS &&
        finalCoverage.trailingMarkerFreeRows <= MAX_EXPECTED_MARKER_FREE_ROWS &&
        (!heightGrowthAtStableWidth || immediateCoverage.markerRows > beforeCoverage.markerRows);
      productResizeFramesValid.push(valid);
      productResizeCoverage.push({
        size: `${variant.terminalWidth}x${variant.viewportHeight}`,
        heightGrowthAtStableWidth,
        before: beforeCoverage,
        immediate: immediateCoverage,
        settled: finalCoverage,
        valid,
      });
    }
  } finally {
    productResizeApp.unmount();
  }
  const productResize = distribution(productResizeSamples);

  // Warm Shiki on a sentinel outside the measured hunks, then time the actual
  // DiffSlice hook path: interaction quiet window, mounted dwell, serialized
  // loader, hook state publication, row rebuild, and the styled OpenTUI commit.
  const syntaxFileName = `src/cap/f${PAGE_FILES}.ts`;
  const syntaxFile = patch.fileDiff(syntaxFileName);
  if (syntaxFile === null) throw new Error('syntax benchmark file is unavailable');
  // Bound non-null before the surface below closes over it: the component is a
  // hoisted function declaration, so the guard's narrowing does not reach it.
  const syntaxDiff: DiffFile = syntaxFile;
  await loadHighlightedDiffHunk(syntaxFile, HUNKS_PER_PATCH_FILE - 1, theme);
  await waitForMountedDiffHighlightsIdle();
  await settleMainRenderer();

  const syntaxHarness = await createTestRenderer({ width: INITIAL_CARD_WIDTH, height: 32 });
  const syntaxRoot = createRoot(syntaxHarness.renderer);
  type SyntaxSelection = { hunkIndex: number } | null;
  let updateSyntaxSelection: React.Dispatch<React.SetStateAction<SyntaxSelection>> | null = null;
  function SyntaxSurface() {
    const [selection, setSelection] = useState<SyntaxSelection>(null);
    updateSyntaxSelection = setSelection;
    return (
      <box flexDirection="column" width={INITIAL_CARD_WIDTH}>
        {selection === null ? null : (
          <DiffSlice
            file={syntaxDiff}
            hunkIndex={selection.hunkIndex}
            width={INITIAL_CARD_WIDTH}
            layout="split"
            showLineNumbers={true}
            showHunkHeaders={false}
            wrapLines={false}
            codeHorizontalOffset={0}
            theme={theme}
          />
        )}
      </box>
    );
  }
  flushSync(() => syntaxRoot.render(<SyntaxSurface />));
  await syntaxHarness.renderOnce();
  await forceFullGc();

  // Code-cell column ranges for this split surface, from the renderer's own geometry,
  // so a colored gutter / +- sign / separator cell is never mistaken for highlighted code.
  const syntaxCodeCellRanges = splitCodeCellRanges(
    INITIAL_CARD_WIDTH,
    sliceLineNumberDigits(syntaxFile)
  );
  const syntaxSamples: number[] = [];
  // Valid iff syntax highlighting added token colors to the code between the pre-settle
  // (deferred, word-diff-only) frame and the settled frame — `settled > plain` distinct
  // code foregrounds. This is syntax-specific (word-diff alone colors code, so an absolute
  // threshold would false-pass) and its own negative control (a broken/absent highlighter
  // adds no colors, so the counts match and the sample reads invalid). Hunks 0-19 are
  // uncached, so the pre-settle capture is reliably pre-syntax.
  const syntaxFramesValid: boolean[] = [];
  for (let sample = 0; sample < SYNTAX_SAMPLES; sample += 1) {
    if (updateSyntaxSelection === null) throw new Error('syntax surface did not mount');
    started = performance.now();
    deferMountedDiffHighlightsForInteraction();
    flushSync(() => updateSyntaxSelection?.({ hunkIndex: sample }));
    await syntaxHarness.renderOnce();
    const plainCodeColors = distinctCodeForegroundCount(
      syntaxHarness.captureSpans().lines,
      syntaxCodeCellRanges
    );
    await waitForMountedDiffHighlightsIdle();
    await Bun.sleep(0);
    flushSync();
    await syntaxHarness.renderOnce();
    syntaxSamples.push(performance.now() - started);
    const settledCodeColors = distinctCodeForegroundCount(
      syntaxHarness.captureSpans().lines,
      syntaxCodeCellRanges
    );
    syntaxFramesValid.push(
      settledCodeColors > plainCodeColors &&
        frameContainsUsefulDiff(syntaxHarness.captureCharFrame())
    );
  }
  const syntax = distribution(syntaxSamples);
  flushSync(() => syntaxRoot.unmount());
  await syntaxHarness.renderOnce();
  syntaxHarness.renderer.destroy();

  const heap = memoryGrowth(
    memoryBaseline.jscHeapSize,
    memoryRetained.jscHeapSize,
    performanceTargets.heapGrowthRatio,
    performanceTargets.heapGrowthBytes
  );
  const jscAssociatedMemory = memoryGrowth(
    memoryBaseline.jscHeapSize + memoryBaseline.jscExtraMemorySize,
    memoryRetained.jscHeapSize + memoryRetained.jscExtraMemorySize,
    performanceTargets.heapGrowthRatio,
    performanceTargets.heapGrowthBytes
  );
  const coldToRetainedRss = memoryGrowth(
    memoryBaseline.rss,
    memoryRetained.rss,
    performanceTargets.rssGrowthRatio,
    performanceTargets.rssGrowthBytes
  );
  const postWarmupRssTail = analyzePostWarmupRssTail(
    traversalMemory.rssFileBoundaries,
    fixture.page.files.length,
    PAGE_HUNKS_PER_FILE,
    fixture.pageHunks,
    performanceTargets.rssGrowthBytes
  );

  // Run independent cold mounts only after the retained-memory interval. Test
  // renderer destruction does not require the native allocator to return pages
  // to the OS, so running this phase first would contaminate both the JSC
  // retention interval and the forced-GC RSS file-boundary series.
  const coldMount = await measureColdFirstUsefulFrames();
  const firstUsefulFrame = distribution(coldMount.samples);
  recordCoreMountedNodes(coldMount.maxMountedNodes, 'cold-first-useful-frame');
  const maxMountedNodes = Math.max(maxCoreMountedNodes, maxProductMountedNodes);

  const layoutPublicationCounts = [...layoutPublications.values()];
  // Robustness invariants — structural/behavioral correctness, per-frame render
  // validity, and memory/node bounds. These must hold on ANY machine, so they
  // hard-fail CI (they drive the exit code below).
  const robustnessChecks = {
    reachedTenMiB: diffBytes >= TARGET_BYTES,
    representativePageHas480Hunks: fixture.pageHunks === PAGE_FILES * PAGE_HUNKS_PER_FILE,
    productNavigationPagesHave480Hunks:
      productLoaded.data.floor.outline.threads[0]?.checkpoints.every(
        (checkpoint) => checkpoint.sliceRefs.length === fixture.pageHunks
      ),
    everyPageHunkResolved: isolatedLayout.byHunkKey.size === fixture.pageHunks,
    oneLayoutPublicationPerGeometryGeneration:
      layoutPublicationCounts.length === currentView.layoutGeneration + 1 &&
      layoutPublicationCounts.every((count) => count === 1),
    firstUsefulFrameRendersValidly:
      coldMount.usefulFrames.every(Boolean) &&
      coldMount.blankFramesBeforeUseful.every((count) => count === 0) &&
      coldMount.layoutPublications.every((count) => count === 1),
    wheelRendersValidly: wheelSetupFramesValid.every(Boolean) && wheelFramesValid.every(Boolean),
    navigationRendersValidly: productNavigationFramesValid.every(Boolean),
    nativeDragRendersValidly:
      dragFramesValid.every(Boolean) &&
      dragBlankFrames.every((blank) => !blank) &&
      dragStaleFrames.every((stale) => !stale),
    resizeAnchorRendersValidly: productResizeFramesValid.every(Boolean),
    fullMemoryTraversalDestinationsSettled:
      traversalMemory.traversalHunks === fixture.pageHunks &&
      traversalMemory.destinationsSettledAfterMountedQueueIdle === fixture.pageHunks,
    mountedSyntaxSchedulerWorkObservedDuringTraversal:
      traversalMemory.mountedSchedulerCompletionsDuringTraversal > 0,
    retainedJscMemoryWithinPremiumTarget: jscAssociatedMemory.pass,
    retainedRssWithinPremiumTarget: coldToRetainedRss.pass,
    postWarmupRssTailNetWithinPremiumTarget:
      postWarmupRssTail.samplesValid && postWarmupRssTail.netPass,
    postWarmupRssTailSlopeWithinPremiumTarget:
      postWarmupRssTail.samplesValid && postWarmupRssTail.projectedSlopePass,
    mountedNodesBounded: maxMountedNodes <= performanceTargets.mountedNodeLimit,
    // Syntax highlighting added token colors to the code of every sampled hunk —
    // measured as `settledCodeColors > plainCodeColors` per sample (split-geometry aware,
    // syntax-specific, and its own negative control), not a racy full-frame span diff. A
    // machine-independent correctness invariant, so it hard-gates rather than sitting with
    // the host-variance-sensitive latency thresholds.
    syntaxContentValidity: syntaxFramesValid.every(Boolean),
  };

  // Absolute wall-clock latency thresholds plus the timing-racy syntax
  // content-validity check. Host-variance-sensitive: a zero-headroom max/p95 gate
  // on a shared CI runner flakes on unrelated PRs. Always measured and reported,
  // but only gate CI under strict mode (PERF_STRICT=1 or --strict), e.g. a quiet
  // nightly job.
  const latencyChecks = {
    firstUsefulFrameWithinLatencyTarget:
      firstUsefulFrame.p50Ms <= performanceTargets.firstUsefulFrameP50Ms &&
      firstUsefulFrame.p95Ms <= performanceTargets.firstUsefulFrameP95CeilingMs,
    wheelWithinLatencyTarget:
      wheel.p50Ms <= performanceTargets.wheelP50Ms && wheel.p95Ms <= performanceTargets.wheelP95Ms,
    navigationWithinLatencyTarget:
      productNavigation.p50Ms <= performanceTargets.navigationP50Ms &&
      productNavigation.p95Ms <= performanceTargets.navigationP95Ms,
    nativeDragWithinLatencyTarget: drag.maxMs <= performanceTargets.dragMaxMs,
    resizeAnchorWithinLatencyTarget: productResize.maxMs <= performanceTargets.resizeMaxMs,
    syntaxSettleWithinLatencyTarget:
      syntax.p50Ms <= performanceTargets.syntaxP50Ms &&
      syntax.p95Ms <= performanceTargets.syntaxP95Ms,
  };

  const strictLatency = process.env.PERF_STRICT === '1' || process.argv.includes('--strict');
  const robustnessPass = Object.values(robustnessChecks).every(Boolean);
  const latencyPass = Object.values(latencyChecks).every(Boolean);
  const overallPass = robustnessPass && (!strictLatency || latencyPass);

  // Flattened view keeps the single `report.checks` map consumers read.
  const checks = { ...robustnessChecks, ...latencyChecks };

  const report = {
    schema_version: 8,
    benchmark: 'WATCH_PREMIUM_10_MIB_480_HUNK_EXPERIENCE',
    environment: {
      runtime: `Bun ${Bun.version}`,
      platform: process.platform,
      arch: process.arch,
      gc: `equivalent ${RETAINED_MEMORY_QUIESCENCE_MS} ms idle windows bracketed by two-pass Bun.gc(true) gate JSC-associated and cold-to-retained RSS growth; forced-GC RSS file-boundary samples additionally gate the post-warmup tail`,
    },
    input: {
      targetBytes: TARGET_BYTES,
      diffBytes,
      patchFiles: fixture.patchFiles,
      totalPatchHunks: fixture.totalHunks,
      pageFiles: fixture.page.files.length,
      pageHunks: fixture.pageHunks,
      initialLayout: 'split',
      initialViewport: { width: INITIAL_TERMINAL_WIDTH, height: INITIAL_VIEWPORT_HEIGHT },
    },
    scope: {
      coldAndSteadyInteractionSurface:
        'production CheckpointDiff subtree in a real OpenTUI ScrollBox; surrounding ReviewApp shell and review-model projection excluded',
      wheelAndDragCoverage:
        'render-core only: production diff subtree and native OpenTUI surface with a benchmark-owned coordinator mirroring production ordering; the ReviewApp listener/coordinator lifecycle is not exercised',
      reviewAppActivePageHorizontalPricingIncluded: true,
      fullReviewAppNavigationAndResizeIncluded: true,
      reviewDataIoIncluded: false,
      steadyInteractionSyntaxPolicy:
        'mounted syntax gate includes interaction quiet, dwell, serialized loading, hook publication, and styled destination commit',
      residualCoverage: {
        fullReviewAppWheelAndDragCoordinator:
          'excluded; full ReviewApp coverage in this cap is limited to checkpoint navigation and resize',
        deferredMoveEnrichmentMemoryLifecycle:
          'excluded; traversal mounts ReviewSurface directly and does not subscribe to PatchIndex deferred move enrichment',
      },
      note: 'Review data is already loaded; raw PatchIndex construction is included in first-useful-frame timing.',
    },
    targets: {
      ...performanceTargets,
      rssTailWarmupFiles: fixture.page.files.length - RSS_TAIL_FILE_SAMPLES,
      rssTailGatedFiles: RSS_TAIL_FILE_SAMPLES,
      rssTailProjectedHunks: fixture.pageHunks,
      rssTailAbsoluteLimitBytes: performanceTargets.rssGrowthBytes,
      latencyPolicy:
        'absolute median/p95/max latency and syntax content-validity are ADVISORY by default (measured and reported, non-gating) because zero-headroom wall-clock gates on shared CI runners flake on unrelated PRs; set PERF_STRICT=1 or pass --strict to hard-gate them (e.g. a quiet nightly job). Robustness invariants — render validity, memory/node bounds, structural coverage — always gate.',
      memoryPolicy:
        'JSC-associated and RSS cold-to-retained growth each fail only when both their relative and absolute limits are exceeded; post-warmup RSS tail net and positive linear slope projected over 480 hunks additionally use the 32 MiB absolute limit',
    },
    observability: {
      gatedAsPremiumLatency: strictLatency,
      fixtureMs: rounded(fixtureMs),
      indexMs: rounded(indexMs),
      // Both frozen keys report the split-layout cold measurement because the
      // unqualified key means "cold layout of the initial layout mode." That
      // mode is split, so readers of either key must see identical values
      // until the initial layout mode changes.
      isolatedColdLayoutMs: rounded(layoutMs),
      isolatedColdSplitLayoutMs: rounded(layoutMs),
      isolatedColdStackLayoutMs: rounded(stackLayoutMs),
      totalLayoutRows: isolatedLayout.totalHeight,
      totalStackLayoutRows: isolatedStackLayout.totalHeight,
      resolvedHunks: isolatedLayout.byHunkKey.size,
      layoutGenerationCount: layoutPublications.size,
      layoutPublicationCounts,
    },
    premium: {
      firstUsefulFrame: {
        ...firstUsefulFrame,
        samplesMs: coldMount.samples.map(rounded),
        operation:
          'raw 10 MiB diff -> PatchIndex construction -> fresh React root -> first committed useful OpenTUI frame',
        surface:
          'production CheckpointDiff subtree and page-level horizontal pricing; ReviewApp shell/model projection excluded',
        rendererCreationIncluded: false,
        indexBuildIncluded: true,
        distinctFirstVisibleFiles: COLD_MOUNT_SAMPLES,
        usefulFrames: coldMount.usefulFrames.filter(Boolean).length,
        blankFramesBeforeUseful: coldMount.blankFramesBeforeUseful.reduce(
          (sum, count) => sum + count,
          0
        ),
        layoutPublications: coldMount.layoutPublications,
      },
      wheel: {
        ...wheel,
        samplesMs: wheelSamples.map(rounded),
        operation:
          'mounted terminal mouse-wheel event through production intent classification, benchmark-owned render-core viewport coordination, React commit, and OpenTUI destination frame',
        coverageClassification: 'render-core',
        endToEndReviewAppCoordinatorIncluded: false,
        timingStarts: 'inside the mounted mouse event handler',
        timingExcludes: 'mock ANSI dispatch before handler, frame capture, and node counting',
        continuousRapidScrollHalo: true,
        rapidScrollEntry: {
          ...distribution(wheelSetupSamples),
          samplesMs: wheelSetupSamples.map(rounded),
          operation:
            'two reported setup interactions that activate the continuous-scroll halo and commit its newly mounted effects before the steady-state percentile',
          gatedLatency: false,
          validDestinationFrames: wheelSetupFramesValid.filter(Boolean).length,
        },
        scenarioMix:
          'continuous reading plus forward/reverse moves at exact file boundaries across the full page',
        destinationOracle:
          'published native scrollTop plus measured viewport height -> first actually intersecting hunk -> exact generated hunk marker in committed frame',
        validDestinationFrames: wheelFramesValid.filter(Boolean).length,
        destinationDiagnostics: wheelDestinationDiagnostics,
      },
      navigation: {
        ...productNavigation,
        samplesMs: productNavigationSamples.map(rounded),
        operation:
          'mounted ReviewApp keyboard navigation between two complete 480-hunk checkpoint pages through controller, projection, rail, diff, and anchor coordinator',
        validDestinationFrames: productNavigationFramesValid.filter(Boolean).length,
        renderCoreDiagnostics: {
          ...navigation,
          samplesMs: navigationSamples.map(rounded),
          scope:
            'direct CheckpointDiff loaded-page replacement; not used as the premium navigation latency gate',
          pageReplacement: {
            ...distribution(pageNavigationSamples),
            samplesMs: pageNavigationSamples.map(rounded),
          },
          fileDestination: {
            ...distribution(fileNavigationSamples),
            samplesMs: fileNavigationSamples.map(rounded),
          },
          validDestinationFrames: navigationFramesValid.filter(Boolean).length,
        },
      },
      nativeDrag: {
        ...drag,
        samplesMs: dragSamples.map(rounded),
        stateMirrorSamplesMs: dragMirrorSamples.map(rounded),
        followingFrameSamplesMs: dragFrameSamples.map(rounded),
        operation:
          'actual OpenTUI scrollbar-slider drag: native scrollTop change first, benchmark-owned render-core microtask mirror with synchronous React commit, destination frame',
        coverageClassification: 'render-core',
        endToEndReviewAppCoordinatorIncluded: false,
        viewportMirror: 'microtask plus flushSync; app-owned scrollbar emissions are ignored',
        adaptiveRapidScrollHalo: false,
        timingStarts: 'inside the native scrollbar change observer',
        timingExcludes: 'mock ANSI dispatch before observer, frame capture, and node counting',
        blankFrames: dragBlankFrames.filter(Boolean).length,
        staleFrames: dragStaleFrames.filter(Boolean).length,
      },
      resizeAnchorRestoration: {
        ...productResize,
        samplesMs: productResizeSamples.map(rounded),
        operation:
          'mounted ReviewApp terminal resize through viewport listeners, semantic source-anchor coordinator, destination-first render, and first correct destination frame',
        endToEndReviewAppCoordinatorIncluded: true,
        delayedRetrySnapBackChecked: true,
        completeViewportPaintChecked: true,
        maximumExpectedMarkerFreeRows: MAX_EXPECTED_MARKER_FREE_ROWS,
        viewportCoverage: productResizeCoverage,
        preservedAnchors: productResizeFramesValid.filter(Boolean).length,
        renderCoreDiagnostics: {
          ...resize,
          samplesMs: resizeSamples.map(rounded),
          scope:
            'direct CheckpointDiff geometry/anchor breakdown; not used as the premium resize latency gate',
          breakdown: resizeBreakdown,
          preservedAnchors: resizeFramesValid.filter(Boolean).length,
        },
      },
      selectedHunkSyntaxSettle: {
        ...syntax,
        operation:
          'mounted DiffSlice selection through interaction quiet, dwell, cooperative hunk loader, hook publication, row-model rebuild, and styled OpenTUI commit',
        mountedHookPathIncluded: true,
        styleCommitObserved: true,
        validHighlightedFrames: syntaxFramesValid.filter(Boolean).length,
      },
      retainedMemoryAfterFullTraversal: {
        semanticLabel: 'single-production-traversal-retention-and-native-tail-gate',
        traversalPasses: {
          expected: 1,
          completed:
            traversalMemory.traversalHunks === fixture.pageHunks &&
            traversalMemory.destinationsSettledAfterMountedQueueIdle === fixture.pageHunks
              ? 1
              : 0,
        },
        traversalHunks: traversalMemory.traversalHunks,
        destinationsSettledAfterMountedQueueIdle:
          traversalMemory.destinationsSettledAfterMountedQueueIdle,
        mountedSyntaxScheduler: {
          completedRequestsDuringTraversal:
            traversalMemory.mountedSchedulerCompletionsDuringTraversal,
          workObserved: traversalMemory.mountedSchedulerCompletionsDuringTraversal > 0,
          evidence:
            'monotonic terminal-request count; cache hits and explicit prefetch are excluded, and this does not claim one unique syntax request or styled commit per destination',
        },
        quiescenceMs: RETAINED_MEMORY_QUIESCENCE_MS,
        baselineKind:
          'fresh immutable PatchIndex generation after its initial mounted syntax working set and fixed allocator/JSC quiescence, before traversal',
        retainedSnapshotKind:
          'post-traversal snapshot after the same fixed allocator/JSC quiescence and forced GC as baseline',
        everyDestinationSettledAfterMountedQueueIdle:
          traversalMemory.destinationsSettledAfterMountedQueueIdle === fixture.pageHunks,
        deferredMoveEnrichmentLifecycleIncluded: false,
        deferredMoveEnrichmentResidual:
          'direct ReviewSurface traversal does not subscribe to PatchIndex deferred move enrichment; its allocation and retention lifecycle is outside this gate',
        snapshots: {
          coldBaseline: {
            semanticLabel: 'pre-traversal-fixed-quiescence-jsc-and-rss-gate-baseline',
            ...memorySnapshotValues(memoryBaseline),
          },
          immediatePostTraversal: {
            semanticLabel: 'immediate-post-final-mounted-commit-working-set',
            gatedAsRetention: false,
            collection:
              'point-in-time snapshot before the final file-boundary forced GC or fixed allocator quiescence',
            ...memorySnapshotValues(memoryImmediatePostTraversal),
          },
          retainedAfterQuiescence: {
            semanticLabel: 'fixed-quiescence-post-traversal-retained-snapshot',
            ...memorySnapshotValues(memoryRetained),
          },
        },
        immediatePostTraversalWorkingSet: {
          gatedAsRetention: false,
          snapshotKind:
            'point-in-time snapshot immediately after the final mounted syntax/render commit, before forced GC and the fixed allocator quiescence window',
          rss: memoryObservation(memoryBaseline.rss, memoryImmediatePostTraversal.rss),
        },
        jscAssociatedMemory,
        jscLiveHeap: heap,
        jscExtraMemory: {
          baselineBytes: memoryBaseline.jscExtraMemorySize,
          retainedBytes: memoryRetained.jscExtraMemorySize,
          growthBytes: Math.max(
            0,
            memoryRetained.jscExtraMemorySize - memoryBaseline.jscExtraMemorySize
          ),
        },
        jscObjectCount: {
          baseline: memoryBaseline.jscObjectCount,
          retained: memoryRetained.jscObjectCount,
          growth: memoryRetained.jscObjectCount - memoryBaseline.jscObjectCount,
        },
        processHeapUsedObservabilityOnly: {
          baselineBytes: memoryBaseline.processHeapUsed,
          retainedBytes: memoryRetained.processHeapUsed,
          note: 'Bun 1.3 Node-compat heapUsed can remain stale across Bun.gc(true), so it is not gated.',
        },
        rss: {
          semanticLabel: 'cold-to-retained-rss-gate-with-post-warmup-tail',
          gateBasis:
            'equivalent fixed-quiescence pre/post traversal snapshots enforce the frozen +15% and +32 MiB combined threshold; files 25-48 additionally gate tail net and projected slope',
          coldToRetained: coldToRetainedRss,
          postWarmupTail: postWarmupRssTail,
          allocatorCaveat:
            'RSS is a conservative resident-working-set guard: Darwin allocators may retain freed high-water pages, so it is not labeled live allocation.',
        },
      },
      virtualization: {
        maxMountedNodes,
        maxCoreMountedNodes,
        maxCoreMountedNodesPhase,
        maxProductMountedNodes,
        maxProductMountedNodesPhase,
        productNodeObservations,
        limit: performanceTargets.mountedNodeLimit,
        gateScope:
          'combined maximum: ReviewSurface root for render-core phases and review-diff-scroll subtree for full ReviewApp phases',
      },
    },
    checks,
    robustnessChecks,
    latencyChecks,
    strictLatency,
    robustnessPass,
    latencyPass,
    pass: overallPass,
  };

  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.pass) process.exitCode = 1;
} finally {
  flushSync(() => mainRoot.unmount());
  await mainHarness.renderOnce();
  mainHarness.renderer.destroy();
}
