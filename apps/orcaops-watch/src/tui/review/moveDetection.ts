// Parse-time moved-line detection for the Walk's diff pane — a pure function
// over the already-split review diff, run once per load in buildPatchIndex. No
// second git invocation, no sidecar, no schema change: a "move" is a deleted
// run whose content reappears verbatim as an added run anywhere in the same
// review diff (cross-file counts). Like patchSplit.ts this imports no
// @orcaops/diff-render values (type-only), so the node test runner covers it.
//
// Matching rules (mirroring git's --color-moved block heuristic in spirit):
//   - Runs are maximal: consecutive old line numbers on the deletion side,
//     consecutive new line numbers on the addition side, within one file.
//   - A whole deleted run matches a whole added run — same length, same
//     content line-by-line. Content compares with TRAILING whitespace trimmed
//     (CRLF/trailing-space churn stays a move); leading whitespace is
//     significant (re-indented code is a rewrite, not a move).
//   - One-to-one and order-consistent: runs match greedily in document order,
//     and on multiple identical candidates the FIRST wins; a run is consumed
//     by at most one counterpart.
//   - Significance guards (both required): a run tints only when it spans
//     >= MIN_MOVE_RUN_LINES lines AND carries >= MIN_MOVE_RUN_SIGNIFICANT_CHARS
//     non-whitespace chars in total — brace-pile/blank boilerplate never tints.
//
// Output indexes follow the vendored DiffLineMoveKinds convention exactly:
// additionLines[i] / deletionLines[i] parallel the file's
// metadata.additionLines / metadata.deletionLines streams, where a context
// line occupies an index on BOTH sides, a `+` line only on the addition side,
// and a `-` line only on the deletion side; counters run file-wide across
// hunks. That is the index the vendored row builders read at render time.

import type { DiffLineMoveKinds } from '@orcaops/diff-render';

/** Minimum lines in a run before it can tint as moved (git-style block bar). */
export const MIN_MOVE_RUN_LINES = 3;

/** Minimum total non-whitespace chars across a run before it can tint. */
export const MIN_MOVE_RUN_SIGNIFICANT_CHARS = 20;

/** One changed line: its per-side metadata index and its file line number. */
interface ChangeEntry {
  /** Index into the side's metadata line stream (context advances both sides). */
  index: number;
  /** 1-based old/new file line number — run boundaries key on consecutiveness. */
  lineNo: number;
  /** Line body with trailing whitespace trimmed — the match key. */
  body: string;
}

/** One file chunk's changed lines plus its lazily-built move-kind arrays. */
interface FileChanges {
  names: string[];
  additions: ChangeEntry[];
  deletions: ChangeEntry[];
  kinds: DiffLineMoveKinds | null;
}

/** A maximal same-file run of changed lines, precomputed for matching. */
interface Run {
  file: FileChanges;
  /** Shared side stream plus an exclusive slice; avoids copying a large run. */
  entries: readonly ChangeEntry[];
  start: number;
  end: number;
  /** Total non-whitespace chars across the run (the significance guard). */
  significant: number;
}

/** Exact line-sequence index. Each edge consumes one cooperatively bounded line. */
interface RunTrieNode {
  children: Map<string, RunTrieNode>;
  queue?: { runs: Run[]; cursor: number };
}

function trieNode(): RunTrieNode {
  return { children: new Map() };
}

function runLength(run: Run): number {
  return run.end - run.start;
}

function runEntry(run: Run, offset: number): ChangeEntry {
  return run.entries[run.start + offset]!;
}

/** Resumable cursor for one file chunk's metadata-line streams. */
interface ChangeCollector {
  patch: string;
  file: FileChanges;
  offset: number;
  addIndex: number;
  delIndex: number;
  oldLine: number;
  newLine: number;
  inHunk: boolean;
}

function changeCollector(patch: string, file: FileChanges): ChangeCollector {
  return {
    patch,
    file,
    offset: 0,
    addIndex: 0,
    delIndex: 0,
    oldLine: 0,
    newLine: 0,
    inHunk: false,
  };
}

/** Collect one line and return false once the chunk is exhausted. */
function collectNextChange(collector: ChangeCollector): boolean {
  if (collector.offset >= collector.patch.length) return false;
  const newline = collector.patch.indexOf('\n', collector.offset);
  const lineEnd = newline === -1 ? collector.patch.length : newline;
  const raw = collector.patch.slice(collector.offset, lineEnd);
  collector.offset = newline === -1 ? collector.patch.length : newline + 1;

  {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header !== null) {
      collector.oldLine = Number(header[1]);
      collector.newLine = Number(header[2]);
      collector.inHunk = true;
      return true;
    }
    // Pre-hunk header lines (---/+++/index/rename) never advance a counter.
    if (!collector.inHunk) return true;
    if (raw.startsWith('+')) {
      collector.file.additions.push({
        index: collector.addIndex,
        lineNo: collector.newLine,
        body: raw.slice(1).trimEnd(),
      });
      collector.addIndex += 1;
      collector.newLine += 1;
    } else if (raw.startsWith('-')) {
      collector.file.deletions.push({
        index: collector.delIndex,
        lineNo: collector.oldLine,
        body: raw.slice(1).trimEnd(),
      });
      collector.delIndex += 1;
      collector.oldLine += 1;
    } else if (raw.startsWith(' ')) {
      collector.addIndex += 1;
      collector.delIndex += 1;
      collector.oldLine += 1;
      collector.newLine += 1;
    }
    // Anything else (`\ No newline...`, stray blanks) moves nothing — the
    // vendored collector skips the same way, so indexes stay aligned.
  }
  return true;
}

/** Whether a run clears both tint bars: enough lines AND enough substance. */
function passesGuards(run: Run): boolean {
  return runLength(run) >= MIN_MOVE_RUN_LINES && run.significant >= MIN_MOVE_RUN_SIGNIFICANT_CHARS;
}

/** Mark one matched entry; a whole run is deliberately never one task operation. */
function markMovedEntry(run: Run, offset: number, side: 'additionLines' | 'deletionLines'): void {
  run.file.kinds ??= { additionLines: [], deletionLines: [] };
  run.file.kinds[side][runEntry(run, offset).index] = 'moved';
}

/**
 * Detect moved lines across a whole review diff, from splitPatchByFile output.
 * Returns per-file DiffLineMoveKinds keyed by every name the chunk was split
 * under (both sides of a rename), only for files that carry at least one move —
 * an absent entry means no tint, matching DiffFile's optional field.
 */
export interface MovedLineDetectionTask {
  /** Run one cooperative slice; null means more work remains. */
  runSlice(): Map<string, DiffLineMoveKinds> | null;
}

export interface MovedLineDetectionTaskOptions {
  /** Soft wall-clock budget; checked after every small operation. */
  maxSliceMs?: number;
  /** Hard bound even when the host clock is coarse. */
  maxOperationsPerSlice?: number;
}

/**
 * Resumable whole-review move detection. Collection, partitioning, exact-key
 * construction, matching, and marking all yield at line boundaries. The final
 * result and greedy document-order semantics are identical to the synchronous
 * API below. Processing one individual line remains atomic: its string lookup
 * and Unicode-whitespace significance count cannot be interrupted safely.
 */
export function createMovedLineDetectionTask(
  patches: ReadonlyMap<string, string>,
  options: MovedLineDetectionTaskOptions = {}
): MovedLineDetectionTask {
  const patchEntries = [...patches];
  const maxSliceMs = Math.max(0.25, options.maxSliceMs ?? 4);
  const maxOperations = Math.max(1, options.maxOperationsPerSlice ?? 512);
  const chunks = new Map<string, { file: FileChanges; collector: ChangeCollector }>();
  let registeredChunks: { file: FileChanges; collector: ChangeCollector }[] = [];
  let files: FileChanges[] = [];
  const delRuns: Run[] = [];
  const addRuns: Run[] = [];
  const addRunTrie = trieNode();
  const result = new Map<string, DiffLineMoveKinds>();
  let phase: 'register' | 'collect' | 'partition' | 'queue' | 'match' | 'mark' | 'result' | 'done' =
    'register';
  let cursor = 0;

  let partitionSide: 'deletions' | 'additions' = 'deletions';
  let partitionEntryCursor = 0;
  let partitionRunStart = 0;
  let partitionSignificant = 0;

  let keyEntryCursor = 0;
  let keyNode = addRunTrie;

  let matchEntryCursor = 0;
  let matchNode: RunTrieNode | null = addRunTrie;
  let matchedDeletion: Run | null = null;
  let matchedAddition: Run | null = null;
  let markSide: 'deletionLines' | 'additionLines' = 'deletionLines';
  let markEntryCursor = 0;

  let resultNameCursor = 0;

  const resetPartitionSide = (): void => {
    partitionEntryCursor = 0;
    partitionRunStart = 0;
    partitionSignificant = 0;
  };

  const resetMatchRun = (): void => {
    matchEntryCursor = 0;
    matchNode = addRunTrie;
  };

  const advance = (): void => {
    if (phase === 'register') {
      const entry = patchEntries[cursor];
      if (entry === undefined) {
        registeredChunks = [...chunks.values()];
        files = registeredChunks.map((chunk) => chunk.file);
        phase = 'collect';
        cursor = 0;
        return;
      }
      const [name, patch] = entry;
      let chunk = chunks.get(patch);
      if (chunk === undefined) {
        const file: FileChanges = { names: [], additions: [], deletions: [], kinds: null };
        chunk = { file, collector: changeCollector(patch, file) };
        chunks.set(patch, chunk);
      }
      chunk.file.names.push(name);
      cursor += 1;
      return;
    }

    if (phase === 'collect') {
      const chunk = registeredChunks[cursor];
      if (chunk === undefined) {
        phase = 'partition';
        cursor = 0;
        return;
      }
      if (!collectNextChange(chunk.collector)) cursor += 1;
      return;
    }

    if (phase === 'partition') {
      const file = files[cursor];
      if (file === undefined) {
        phase = 'queue';
        cursor = 0;
        return;
      }

      const entries = file[partitionSide];
      const out = partitionSide === 'deletions' ? delRuns : addRuns;
      const entry = entries[partitionEntryCursor];
      if (entry === undefined) {
        if (partitionRunStart < entries.length) {
          out.push({
            file,
            entries,
            start: partitionRunStart,
            end: entries.length,
            significant: partitionSignificant,
          });
          partitionRunStart = entries.length;
          return;
        }

        if (partitionSide === 'deletions') {
          partitionSide = 'additions';
          resetPartitionSide();
        } else {
          partitionSide = 'deletions';
          resetPartitionSide();
          cursor += 1;
        }
        return;
      }

      if (
        partitionEntryCursor > partitionRunStart &&
        entry.lineNo !== entries[partitionEntryCursor - 1]!.lineNo + 1
      ) {
        out.push({
          file,
          entries,
          start: partitionRunStart,
          end: partitionEntryCursor,
          significant: partitionSignificant,
        });
        partitionRunStart = partitionEntryCursor;
        partitionSignificant = 0;
        return;
      }

      // This scan is bounded by one source line. Keep the exact prior `/\s/u`
      // semantics, including UTF-16 length for non-BMP non-whitespace text.
      partitionSignificant += entry.body.replace(/\s/gu, '').length;
      partitionEntryCursor += 1;
      return;
    }

    if (phase === 'queue') {
      const run = addRuns[cursor];
      if (run === undefined) {
        phase = 'match';
        cursor = 0;
        return;
      }

      if (keyEntryCursor < runLength(run)) {
        const body = runEntry(run, keyEntryCursor).body;
        let child = keyNode.children.get(body);
        if (child === undefined) {
          child = trieNode();
          keyNode.children.set(body, child);
        }
        keyNode = child;
        keyEntryCursor += 1;
        return;
      }

      keyNode.queue ??= { runs: [], cursor: 0 };
      keyNode.queue.runs.push(run);
      cursor += 1;
      keyEntryCursor = 0;
      keyNode = addRunTrie;
      return;
    }

    if (phase === 'match') {
      const delRun = delRuns[cursor];
      if (delRun === undefined) {
        phase = 'result';
        cursor = 0;
        return;
      }

      if (!passesGuards(delRun) || matchNode === null) {
        cursor += 1;
        resetMatchRun();
        return;
      }

      if (matchEntryCursor < runLength(delRun)) {
        matchNode = matchNode.children.get(runEntry(delRun, matchEntryCursor).body) ?? null;
        matchEntryCursor += 1;
        return;
      }

      const queue = matchNode.queue;
      const addition = queue?.runs[queue.cursor];
      if (queue !== undefined && addition !== undefined) {
        queue.cursor += 1;
        matchedDeletion = delRun;
        matchedAddition = addition;
        markSide = 'deletionLines';
        markEntryCursor = 0;
        phase = 'mark';
        return;
      }

      cursor += 1;
      resetMatchRun();
      return;
    }

    if (phase === 'mark') {
      const run = markSide === 'deletionLines' ? matchedDeletion : matchedAddition;
      if (run === null) throw new Error('move detector entered mark phase without a match');
      if (markEntryCursor < runLength(run)) {
        markMovedEntry(run, markEntryCursor, markSide);
        markEntryCursor += 1;
        return;
      }

      if (markSide === 'deletionLines') {
        markSide = 'additionLines';
        markEntryCursor = 0;
        return;
      }

      matchedDeletion = null;
      matchedAddition = null;
      phase = 'match';
      cursor += 1;
      resetMatchRun();
      return;
    }

    if (phase === 'result') {
      const file = files[cursor];
      if (file === undefined) {
        phase = 'done';
        return;
      }

      if (file.kinds === null || resultNameCursor >= file.names.length) {
        cursor += 1;
        resultNameCursor = 0;
        return;
      }

      result.set(file.names[resultNameCursor]!, file.kinds);
      resultNameCursor += 1;
    }
  };

  return {
    runSlice() {
      const started = performance.now();
      let operations = 0;
      while (phase !== 'done') {
        advance();
        operations += 1;
        if (operations >= maxOperations) return null;
        if (performance.now() - started >= maxSliceMs) return null;
      }
      return result;
    },
  };
}

export function detectMovedLines(
  patches: ReadonlyMap<string, string>
): Map<string, DiffLineMoveKinds> {
  const task = createMovedLineDetectionTask(patches, {
    maxSliceMs: Number.POSITIVE_INFINITY,
    maxOperationsPerSlice: Number.MAX_SAFE_INTEGER,
  });
  let result: Map<string, DiffLineMoveKinds> | null = null;
  while (result === null) result = task.runSlice();
  return result;
}
