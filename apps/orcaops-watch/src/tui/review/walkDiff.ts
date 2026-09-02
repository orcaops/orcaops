// The bridge from the floor's hunk metadata to renderable diff. The floor holds
// only positions/counts per hunk; the raw base→pinned unified diff (persisted
// beside floor.json, delivered as ReviewData.reviewDiff) holds the patch text.
// This parses each per-file patch into a DiffFile via @orcaops/diff-render and
// position-matches a floor hunk to its ordinal `hunkIndex` — the index DiffSlice
// renders. The drift-sensitive split/match primitives live in patchSplit.ts
// (diff-render-free, unit-tested); this layer just adds the parse + a cache.

import { type DiffFile, diffFileFromPatch } from '@orcaops/diff-render';

import { changeTypeFromPatch, type FileChangeType } from './filePresentation';
import {
  createMovedLineDetectionTask,
  detectMovedLines,
  type MovedLineDetectionTask,
} from './moveDetection';
import {
  type BinaryPatchInfo,
  binaryPatchInfo,
  indexPatchRanges,
  matchHunkOrdinal,
  type PatchRange,
} from './patchSplit';
import { createTreeSourceFetcher } from '../../data/treeSource';

export { splitPatchByFile } from './patchSplit';

/** Neutral floor coordinates used to resolve one retained parent hunk. */
export interface HunkRef {
  hunkKey: string;
  file: string;
  newStart: number | null;
  oldStart: number | null;
  added: number;
  removed: number;
}

/** A query index over a review's raw diff — resolve a file to render + a hunk to its index. */
export interface PatchIndex {
  /** The parsed DiffFile for a file (cached), or null when absent/unparseable/binary. */
  fileDiff(file: string): DiffFile | null;
  /** The `hunkIndex` in the file's DiffFile matching this floor hunk, or null if unresolved. */
  hunkIndex(ref: HunkRef): number | null;
  /** Binary detection over the file's raw patch, or null when the diff has no chunk for it. */
  binaryInfo(file: string): BinaryPatchInfo | null;
  /** Git status even when the patch has no renderable text hunk. */
  fileChangeType(file: string): FileChangeType | null;
  /** Whether the raw diff carried any patch text at all (false ⇒ degenerate/absent). */
  readonly hasDiff: boolean;
  /** Monotonic identity for deferred presentation enrichment. */
  readonly enrichmentRevision: number;
  /** Whether whole-review moved-line analysis has not completed yet. */
  readonly movedLinesPending: boolean;
  /**
   * Observe immutable DiffFile replacements after deferred enrichment. Merely
   * subscribing requests the work; callers should include the emitted revision
   * in render memo dependencies.
   */
  subscribeEnrichment(listener: (revision: number) => void): () => void;
}

/**
 * The one-row placeholder body FileCard renders instead of a binary diff.
 * Kept to one row so a binary placeholder never distorts the final diff pane.
 */
export function binaryNoteText(info: BinaryPatchInfo): string {
  return info.bytes !== null
    ? `binary file — ${info.bytes.toLocaleString('en-US')} bytes, content not shown`
    : 'binary file — content not shown';
}

/** Where the review's ref-pinned trees live — the fetcher coordinates. */
export interface PatchIndexSource {
  root: string;
  slug: string;
}

/** Large reviews defer whole-patch presentation analysis past the first frame. */
export const DEFERRED_MOVE_DETECTION_MIN_BYTES = 512 * 1_024;

/**
 * Whether a JS string reaches the deferred-analysis boundary in encoded UTF-8.
 *
 * UTF-8 is never shorter than the UTF-16 code-unit count and never longer than
 * three bytes per code unit. Those bounds answer ordinary small and large diffs
 * without another scan; only the narrow ambiguous band needs an exact pass,
 * which stops as soon as the threshold is reached.
 */
export function shouldDeferMovedLineDetection(rawDiff: string): boolean {
  if (rawDiff.length >= DEFERRED_MOVE_DETECTION_MIN_BYTES) return true;
  if (rawDiff.length * 3 < DEFERRED_MOVE_DETECTION_MIN_BYTES) return false;

  let utf8Bytes = 0;
  for (let index = 0; index < rawDiff.length; index += 1) {
    const codeUnit = rawDiff.charCodeAt(index);
    if (codeUnit <= 0x7f) utf8Bytes += 1;
    else if (codeUnit <= 0x7ff) utf8Bytes += 2;
    else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < rawDiff.length &&
      rawDiff.charCodeAt(index + 1) >= 0xdc00 &&
      rawDiff.charCodeAt(index + 1) <= 0xdfff
    ) {
      utf8Bytes += 4;
      index += 1;
    } else {
      // BMP characters and TextEncoder-style replacement of lone surrogates.
      utf8Bytes += 3;
    }

    if (utf8Bytes >= DEFERRED_MOVE_DETECTION_MIN_BYTES) return true;
  }
  return false;
}

/**
 * Leave ample room for the first native frame even on a contended renderer.
 * The analysis is presentation-only; file parsing, source expansion, comments,
 * ownership, and every navigation coordinate are available immediately.
 */
export const DEFERRED_MOVE_DETECTION_DELAY_MS = 250;

export interface PatchIndexBuildOptions {
  /** `auto` keeps small diffs synchronous and defers only large reviews. */
  movedLineDetection?: 'auto' | 'sync' | 'deferred';
  /** Deterministic seam for scheduler tests. Production uses a bounded timer. */
  scheduleDeferred?: (work: () => void, delayMs: number) => void | (() => void);
}

/**
 * Build a query index over a review's raw diff. Parsing a file's patch and
 * matching a hunk are both cached, so re-querying as the pane cursor moves is
 * cheap. A file missing from the diff (truncation, degenerate scope) resolves to
 * null rather than throwing — the pane shows an unavailable-hunk placeholder.
 *
 * With `source` set, every parsed DiffFile gets a tree-source fetcher over the
 * ref-pinned review trees — gap expansion's lazy full-text capability. Omitted
 * (tests without a repo, degenerate loads), files simply carry no fetcher and
 * expansion reports itself unavailable.
 */
export function buildPatchIndex(
  rawDiff: string,
  source?: PatchIndexSource,
  options: PatchIndexBuildOptions = {}
): PatchIndex {
  // Keep one immutable source string plus tiny ranges on the cold path:
  // materializing a line array and copying every chunk costs the whole diff
  // before the first visible file parses.
  const patchRanges = indexPatchRanges(rawDiff);
  const patchTextCache = new Map<PatchRange, string>();
  const patchText = (range: PatchRange): string => {
    const cached = patchTextCache.get(range);
    if (cached !== undefined) return cached;
    const patch = rawDiff.slice(range.start, range.end);
    patchTextCache.set(range, patch);
    return patch;
  };
  const materializePatches = (): Map<string, string> => {
    const patches = new Map<string, string>();
    for (const [file, range] of patchRanges) patches.set(file, patchText(range));
    return patches;
  };

  const detectionMode = options.movedLineDetection ?? 'auto';
  let movedLinesPending =
    detectionMode === 'deferred' ||
    (detectionMode === 'auto' && shouldDeferMovedLineDetection(rawDiff));
  let moveKinds = movedLinesPending ? new Map() : detectMovedLines(materializePatches());
  let enrichmentRevision = 0;
  let enrichmentScheduled = false;
  let enrichmentScheduleEpoch = 0;
  let cancelScheduledEnrichment: (() => void) | null = null;
  let detectionTask: MovedLineDetectionTask | null = null;
  const deferredPatchEntries = [...patchRanges];
  let deferredPatchCursor = 0;
  let deferredPatches: Map<string, string> | null = null;
  const enrichmentListeners = new Set<(revision: number) => void>();
  const diffCache = new Map<string, DiffFile | null>();
  const hunkOrdinalCache = new Map<string, number | null>();

  const scheduleDeferred =
    options.scheduleDeferred ??
    ((work: () => void, delayMs: number) => {
      if (delayMs === 0) {
        const immediate = setImmediate(work);
        return () => clearImmediate(immediate);
      }
      const timer = setTimeout(work, delayMs);
      return () => clearTimeout(timer);
    });

  function commitMovedLineEnrichment(nextMoveKinds: typeof moveKinds): void {
    moveKinds = nextMoveKinds;
    movedLinesPending = false;
    detectionTask = null;
    deferredPatches = null;
    patchTextCache.clear();

    // Never mutate a DiffFile already used as a WeakMap/cache key. Only files
    // whose move metadata actually changed need a fresh geometry identity;
    // no-move files retain all parsed-content and syntax-cache identities.
    let renderedDataChanged = false;
    for (const [file, parsed] of diffCache) {
      if (parsed === null) continue;
      const moves = moveKinds.get(file);
      if (parsed.lineMoveKinds === moves) continue;
      diffCache.set(file, { ...parsed, lineMoveKinds: moves });
      renderedDataChanged = true;
    }

    // Completion without a visible move is not a presentation generation. Do
    // not invalidate layout/cards (or their syntax snapshots) when every parsed
    // file is byte-for-byte the same object the reviewer is already reading.
    if (renderedDataChanged) {
      enrichmentRevision += 1;
      for (const listener of enrichmentListeners) listener(enrichmentRevision);
    }
  }

  function failMovedLineEnrichment(): void {
    // Presentation enrichment must never take down the review. The detector is
    // pure and covered, but an unexpected runtime failure degrades to ordinary
    // add/remove tints and still releases every scheduled/task closure.
    movedLinesPending = false;
    detectionTask = null;
    deferredPatches = null;
    patchTextCache.clear();
    enrichmentRevision += 1;
    for (const listener of enrichmentListeners) listener(enrichmentRevision);
  }

  function scheduleMovedLineEnrichment(delayMs: number): void {
    if (!movedLinesPending || enrichmentScheduled) return;
    enrichmentScheduled = true;
    const scheduleEpoch = ++enrichmentScheduleEpoch;
    const cancel = scheduleDeferred(() => {
      if (scheduleEpoch !== enrichmentScheduleEpoch) return;
      enrichmentScheduled = false;
      cancelScheduledEnrichment = null;
      if (enrichmentListeners.size === 0 || !movedLinesPending) return;

      try {
        if (detectionTask === null) {
          deferredPatches ??= new Map();
          const materializeStarted = performance.now();
          let materialized = 0;
          while (
            deferredPatchCursor < deferredPatchEntries.length &&
            materialized < 4 &&
            performance.now() - materializeStarted < 2
          ) {
            const [file, range] = deferredPatchEntries[deferredPatchCursor]!;
            deferredPatches.set(file, patchText(range));
            deferredPatchCursor += 1;
            materialized += 1;
          }
          if (deferredPatchCursor < deferredPatchEntries.length) {
            scheduleMovedLineEnrichment(0);
            return;
          }
          detectionTask = createMovedLineDetectionTask(deferredPatches, {
            maxSliceMs: 3,
            maxOperationsPerSlice: 512,
          });
          // Give task construction its own bounded turn; collection begins on
          // the next event-loop slice.
          scheduleMovedLineEnrichment(0);
          return;
        }
        const result = detectionTask.runSlice();
        if (result === null) scheduleMovedLineEnrichment(0);
        else commitMovedLineEnrichment(result);
      } catch {
        failMovedLineEnrichment();
      }
    }, delayMs);
    if (scheduleEpoch === enrichmentScheduleEpoch && enrichmentScheduled) {
      cancelScheduledEnrichment = cancel ?? null;
    }
  }

  function fileDiff(file: string): DiffFile | null {
    if (diffCache.has(file)) return diffCache.get(file) ?? null;
    const range = patchRanges.get(file);
    let diff: DiffFile | null = null;
    if (range !== undefined) {
      try {
        const patch = patchText(range);
        diff = diffFileFromPatch(patch, { sourceId: `walk:${file}` });
        const moves = moveKinds.get(file);
        if (moves !== undefined) diff.lineMoveKinds = moves;
        if (source !== undefined) {
          diff.sourceFetcher = createTreeSourceFetcher({
            root: source.root,
            slug: source.slug,
            path: diff.path,
            ...(diff.metadata.prevName != null ? { prevPath: diff.metadata.prevName } : {}),
          });
        }
      } catch {
        diff = null; // unparseable (e.g. binary-only) — degrade to a placeholder
      }
    }
    diffCache.set(file, diff);
    return diff;
  }

  function hunkIndex(ref: HunkRef): number | null {
    const cacheKey = `${ref.file}\0${ref.hunkKey}\0${ref.newStart ?? ''}\0${ref.oldStart ?? ''}`;
    if (hunkOrdinalCache.has(cacheKey)) return hunkOrdinalCache.get(cacheKey) ?? null;
    const diff = fileDiff(ref.file);
    if (diff === null) {
      hunkOrdinalCache.set(cacheKey, null);
      return null;
    }
    const ordinal = matchHunkOrdinal(diff.metadata.hunks, {
      newStart: ref.newStart,
      oldStart: ref.oldStart,
    });
    const resolved = ordinal === -1 ? null : ordinal;
    hunkOrdinalCache.set(cacheKey, resolved);
    return resolved;
  }

  function binaryInfo(file: string): BinaryPatchInfo | null {
    const range = patchRanges.get(file);
    return range !== undefined ? binaryPatchInfo(patchText(range)) : null;
  }

  function fileChangeType(file: string): FileChangeType | null {
    const range = patchRanges.get(file);
    if (range === undefined) return null;
    const patch = patchText(range);
    const parsed = fileDiff(file)?.metadata.type;
    if (
      parsed === 'new' ||
      parsed === 'deleted' ||
      parsed === 'change' ||
      parsed === 'rename-pure' ||
      parsed === 'rename-changed'
    ) {
      // Pierre currently reports a /dev/null add as `change` unless the optional
      // `new file mode` header is present. The raw old/new paths are definitive.
      const raw = changeTypeFromPatch(patch);
      return raw === 'new' || raw === 'deleted' ? raw : parsed;
    }
    return changeTypeFromPatch(patch);
  }

  return {
    fileDiff,
    hunkIndex,
    binaryInfo,
    fileChangeType,
    hasDiff: patchRanges.size > 0,
    get enrichmentRevision() {
      return enrichmentRevision;
    },
    get movedLinesPending() {
      return movedLinesPending;
    },
    subscribeEnrichment(listener) {
      enrichmentListeners.add(listener);
      scheduleMovedLineEnrichment(DEFERRED_MOVE_DETECTION_DELAY_MS);
      return () => {
        enrichmentListeners.delete(listener);
        if (enrichmentListeners.size > 0 || !enrichmentScheduled) return;
        enrichmentScheduleEpoch += 1;
        enrichmentScheduled = false;
        cancelScheduledEnrichment?.();
        cancelScheduledEnrichment = null;
      };
    },
  };
}
