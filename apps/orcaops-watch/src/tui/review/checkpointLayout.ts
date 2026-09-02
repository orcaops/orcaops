// Exact measured stream for one reader page. Display is parent-hunk-grain:
// matched parents render their complete canonical rows once, foreign-only
// parents render one explicit collapse row, and slices remain navigation keys
// mapped onto their shared parent unit.
//
// The input is `LayoutPage`: the narrow structural shape geometry actually
// measures, owned by this module. A page type carrying titles, threads,
// summaries and denormalized counts would hand layout a dozen fields it must
// not be able to read.
//
// That is what lets ONE geometry serve BOTH lenses. A Checkpoint page and a Part
// page disagree about nearly everything, but they both reduce to "files, each
// holding hunks and the slices that land in them" — so both project into
// `LayoutPage` and neither can smuggle a lens-specific field into the measured
// stream.

import {
  type AppTheme,
  type DiffRow,
  expansionSide,
  type FileSectionLayout,
  measureSliceRowBounds,
  type SliceExpansion,
  sliceLineNumberDigits,
  type SliceLineRanges,
} from '@orcaops/diff-render';
import type { ReviewUnit } from '@orcaops/review-core';

import type { ExpandedGaps, SourceStatusByFile } from './gapExpansion';
import type { PatchIndex } from './walkDiff';

// A normal card starts with margin(1) + top rule(1) + path row(1).
// When the first path row is pinned above the scrollbox, the in-stream card keeps
// only its two structural rows. Keeping this explicit is what lets sticky handoff
// use the same coordinates as file virtualization instead of reverse-engineering
// JSX positions.
const CARD_HEADER_HEIGHT = 3;
const PINNED_FIRST_CARD_HEADER_HEIGHT = 2;
const CARD_END_HEIGHT = 1;
export const DEFAULT_ANNOTATION_HEIGHT = 4;
const NOTE_HEIGHT = 1;
const EMPTY_ROW_EXTRA_HEIGHTS: ReadonlyMap<string, number> = new Map();

/**
 * How a parent hunk relates to the page being read. `matched` is the page's own
 * work; everything else belongs to another page or to no page at all.
 *
 * Shared with `navigation.ts` (`FloorDisplayHunk.status`) so the two modules
 * cannot drift into different vocabularies for the same distinction.
 */
export type DisplayHunkStatus = 'matched' | 'foreign' | 'excluded' | 'unreviewable';

/** One navigable slice: a review unit, and the parent hunk it renders inside. */
export interface LayoutSlice {
  readonly sliceKey: string;
  readonly hunkKey: string;
  readonly file: string;
  readonly unit: ReviewUnit;
}

/**
 * One parent hunk on the page. The position fields are what `PatchIndex` matches
 * against to find the hunk's ordinal in the parsed diff — this is a `HunkRef`.
 */
export interface LayoutHunk {
  readonly hunkKey: string;
  readonly file: string;
  readonly newStart: number | null;
  readonly oldStart: number | null;
  readonly added: number;
  readonly removed: number;
  readonly status: DisplayHunkStatus;
  /**
   * Every owner observed in this hunk. Rendered INLINE in the collapsed row, so
   * geometry never prices it — a collapsed hunk is one row whether or not it
   * names its owners.
   */
  readonly ownerLabels: readonly string[];
  /**
   * Owners belonging only to non-primary units on this surface. Unlike
   * `ownerLabels` this IS priced: it renders as its own explanation row above an
   * expanded body.
   */
  readonly foreignOwnerLabels: readonly string[];
}

export interface LayoutFile {
  readonly file: string;
  readonly slices: readonly LayoutSlice[];
  readonly hunks: readonly LayoutHunk[];
}

/** A finding pins to the slices it cites; geometry only needs to count them. */
export interface LayoutFinding {
  readonly sliceKeys: readonly string[];
}

/** Where a measured annotation lands. Geometry prices position, never content. */
export type LayoutPinTarget =
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'slice'; readonly sliceKey: string }
  /**
   * A per-row pin. It carries the ROW it hangs on, and that is load-bearing.
   *
   * Geometry prices a line pin by COUNTING these; the renderer draws it by MATCHING
   * a rendered row. Those are two different questions, and when the answers differ
   * — a pin priced against a row that never renders — nothing throws: the four rows
   * it reserved simply stay empty, every hunk below it measures four rows short,
   * and scroll-to-cursor quietly lands on the wrong line. Carrying `(side, line)`
   * on the target is what lets both sides read the SAME fact, and makes a line pin
   * with no line unrepresentable rather than merely unlikely.
   */
  | {
      readonly kind: 'line';
      readonly sliceKey: string;
      readonly side: 'add' | 'delete';
      readonly line: number;
    }
  | { readonly kind: 'header' };

export interface LayoutAnnotation {
  /** Collision-free semantic identity used to restore the same card after remeasurement. */
  readonly annotationId: string;
  /** Present on reviewer-comment annotations for activation. */
  readonly commentId?: string;
  /** Exact renderer height. */
  readonly height: number;
  readonly target: LayoutPinTarget;
}
export type LayoutPin = LayoutAnnotation;

function annotationHeight(annotation: LayoutAnnotation): number {
  return annotation.height;
}

function annotationSourceKey(annotation: LayoutAnnotation): string {
  return annotation.annotationId;
}

/**
 * A reader page as GEOMETRY sees it. Deliberately has no title, no key and no
 * trail: measuring a page must not be able to depend on which lens minted it.
 *
 * There is no flat `slices` field — it is DERIVED (`pageSlices`). Carrying
 * `files`, a parallel flat `slices` list and a `fileCount`/`sliceCount` pair
 * would make the `/` filter narrow four fields in lockstep or leave the cursor
 * pointing at a slice no longer rendered. Deriving the cursor order makes that
 * desync unrepresentable.
 */
export interface LayoutPage {
  readonly files: readonly LayoutFile[];
  readonly findings: readonly LayoutFinding[];
}

/** The page's flat cursor order: every slice, by file, in reading order. */
export function pageSlices(page: LayoutPage): readonly LayoutSlice[] {
  return page.files.flatMap((group) => group.slices);
}

/** The focus ranges of one review unit; ambiguous units focus the whole hunk. */
export function unitLineRanges(unit: ReviewUnit): SliceLineRanges | null {
  if (unit.kind === 'ambiguous_hunk') return null;
  return { delRange: unit.del_range, addRange: unit.add_range };
}

function rowMatchesUnit(row: DiffRow, unit: ReviewUnit): boolean {
  if (row.type === 'split-line') {
    if (row.isExpansionRow === true) return false;
    if (unit.kind === 'ambiguous_hunk') {
      return row.left.kind === 'deletion' || row.right.kind === 'addition';
    }
    return (
      (row.left.kind === 'deletion' &&
        unit.del_range !== null &&
        row.left.lineNumber !== undefined &&
        row.left.lineNumber >= unit.del_range.start &&
        row.left.lineNumber <= unit.del_range.end) ||
      (row.right.kind === 'addition' &&
        unit.add_range !== null &&
        row.right.lineNumber !== undefined &&
        row.right.lineNumber >= unit.add_range.start &&
        row.right.lineNumber <= unit.add_range.end)
    );
  }
  if (row.type === 'stack-line') {
    if (row.isExpansionRow === true) return false;
    if (unit.kind === 'ambiguous_hunk') {
      return row.cell.kind === 'deletion' || row.cell.kind === 'addition';
    }
    return (
      (row.cell.kind === 'deletion' &&
        unit.del_range !== null &&
        row.cell.oldLineNumber !== undefined &&
        row.cell.oldLineNumber >= unit.del_range.start &&
        row.cell.oldLineNumber <= unit.del_range.end) ||
      (row.cell.kind === 'addition' &&
        unit.add_range !== null &&
        row.cell.newLineNumber !== undefined &&
        row.cell.newLineNumber >= unit.add_range.start &&
        row.cell.newLineNumber <= unit.add_range.end)
    );
  }
  return false;
}

function rowMatchesPin(row: DiffRow, target: Extract<LayoutPinTarget, { kind: 'line' }>): boolean {
  if (row.type === 'split-line') {
    return target.side === 'add'
      ? row.right.kind === 'addition' && row.right.lineNumber === target.line
      : row.left.kind === 'deletion' && row.left.lineNumber === target.line;
  }
  if (row.type === 'stack-line') {
    return target.side === 'add'
      ? row.cell.kind === 'addition' && row.cell.newLineNumber === target.line
      : row.cell.kind === 'deletion' && row.cell.oldLineNumber === target.line;
  }
  return false;
}

/**
 * The measured display state of a parent hunk — the SINGLE decision about what
 * chrome a hunk carries. `expanded-foreign` is deliberately distinct from
 * `matched` even though both render the complete canonical body: only the
 * former gets the `▴ … hide` header. Layout prices that row from this state and
 * the renderer is handed the same state, so the two can never disagree by a
 * row (which the row-window spacer math would turn into visible corruption).
 */
export type HunkDisplay = 'matched' | 'expanded-foreign' | 'collapsed' | 'unavailable';

/** Both states that render the real hunk body rather than a one-row placeholder. */
export function rendersHunkBody(display: HunkDisplay): boolean {
  return display === 'matched' || display === 'expanded-foreign';
}

export interface HunkUnit {
  kind: 'hunk';
  hunkKey: string;
  primarySliceKeys: readonly string[];
  file: string;
  top: number;
  height: number;
  /** Rows start after the hide/owner label rows and finding/slice pins. */
  sliceTop: number;
  /** Diff-row body height before inline pins, or one row for collapsed/unavailable parents. */
  sliceHeight: number;
  /** Diff rows plus measured inline pin rows. Equal to `sliceHeight` when unpinned. */
  visualSliceHeight: number;
  /** Exact extra height rendered after each stable diff-row key. */
  rowExtraHeightsByKey: ReadonlyMap<string, number>;
  /** Whether this hunk carries any measured inline pin rows. */
  rowExtras: boolean;
  display: HunkDisplay;
}

/**
 * One semantic location in the measured diff stream.
 *
 * A rendered split row can carry both an old and a new source line, hence the
 * key list. Stack mode renders those as two rows. Keeping every equivalent key
 * on the split row lets a viewport anchored on either stack row return to the
 * same source when the presentation changes without making layout mode part of
 * the identity.
 */
export interface LayoutSourceAnchor {
  readonly keys: readonly string[];
  /** Less-specific identities to try only when the source row no longer exists. */
  readonly fallbackKeys?: readonly string[];
  readonly top: number;
  readonly height: number;
}

export type CheckpointUnit =
  | { kind: 'card-header'; file: string; top: number; height: number }
  | { kind: 'pin'; file: string; top: number; height: number }
  | { kind: 'note'; file: string; top: number; height: number }
  | HunkUnit
  | { kind: 'card-end'; file: string; top: number; height: number };

export interface CheckpointLayout {
  units: CheckpointUnit[];
  totalHeight: number;
  /** Slice cursor key -> its shared parent display target. */
  bySliceKey: ReadonlyMap<string, { top: number; height: number }>;
  /** Parent hunkKey -> its measured unit: the `z` scroll anchor and the render state. */
  byHunkKey: ReadonlyMap<string, HunkUnit>;
  /** Hunk-grain virtualization sections (fileId = durable hunkKey). */
  sections: FileSectionLayout[];
  /** File-card-grain sections (fileId = path), used to skip whole offscreen cards. */
  fileSections: FileSectionLayout[];
  /** Ordered source/chrome identities used to preserve reading position across remeasurement. */
  sourceAnchors: readonly LayoutSourceAnchor[];
  /** Every semantic identity above, indexed for O(1) restoration in the next layout. */
  bySourceAnchorKey: ReadonlyMap<string, LayoutSourceAnchor>;
}

export interface CheckpointLayoutOptions {
  page: LayoutPage;
  patch: PatchIndex;
  theme: AppTheme;
  layout: 'split' | 'stack';
  cardWidth: number;
  /** General measured annotations (reviewer comments and semantic context cards). */
  annotations?: readonly LayoutAnnotation[];
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  expandedGaps?: ExpandedGaps;
  sourceStatusByFile?: SourceStatusByFile;
  expandedForeignHunks?: ReadonlySet<string>;
  showOwnerLabels?: boolean;
  /** The fixed header owns file zero's path row; do not price it in-stream twice. */
  pinnedFileHeader?: boolean;
}

/** Layout-independent identities for one canonical diff row. */
function sourceAnchorKeys(hunkKey: string, row: DiffRow): readonly string[] {
  const prefix = `hunk:${hunkKey}:`;
  if (row.type === 'collapsed') {
    return [
      `${prefix}gap:${row.position}:${row.oldRange[0]}-${row.oldRange[1]}:${row.newRange[0]}-${row.newRange[1]}`,
    ];
  }
  if (row.type === 'hunk-header') return [`${prefix}header`];
  if (row.type === 'split-line') {
    if (
      row.left.kind === 'context' &&
      row.right.kind === 'context' &&
      row.left.lineNumber !== undefined &&
      row.right.lineNumber !== undefined
    ) {
      return [`${prefix}context:${row.left.lineNumber}:${row.right.lineNumber}`];
    }
    const keys: string[] = [];
    if (row.left.kind === 'deletion' && row.left.lineNumber !== undefined) {
      keys.push(`${prefix}delete:${row.left.lineNumber}`);
    }
    if (row.right.kind === 'addition' && row.right.lineNumber !== undefined) {
      keys.push(`${prefix}add:${row.right.lineNumber}`);
    }
    return keys.length > 0 ? keys : [`${prefix}row:${row.key}`];
  }
  if (
    row.cell.kind === 'context' &&
    row.cell.oldLineNumber !== undefined &&
    row.cell.newLineNumber !== undefined
  ) {
    return [`${prefix}context:${row.cell.oldLineNumber}:${row.cell.newLineNumber}`];
  }
  if (row.cell.kind === 'deletion' && row.cell.oldLineNumber !== undefined) {
    return [`${prefix}delete:${row.cell.oldLineNumber}`];
  }
  if (row.cell.kind === 'addition' && row.cell.newLineNumber !== undefined) {
    return [`${prefix}add:${row.cell.newLineNumber}`];
  }
  return [`${prefix}row:${row.key}`];
}

export function buildCheckpointLayout({
  page,
  patch,
  theme,
  layout,
  cardWidth,
  annotations = [],
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  expandedGaps,
  sourceStatusByFile,
  expandedForeignHunks = new Set(),
  showOwnerLabels = false,
  pinnedFileHeader = false,
}: CheckpointLayoutOptions): CheckpointLayout {
  const measuredAnnotations = annotations;
  const units: CheckpointUnit[] = [];
  const bySliceKey = new Map<string, { top: number; height: number }>();
  const byHunkKey = new Map<string, HunkUnit>();
  const sections: FileSectionLayout[] = [];
  const fileSections: FileSectionLayout[] = [];
  const sourceAnchors: LayoutSourceAnchor[] = [];
  let top = 0;

  const push = (unit: CheckpointUnit): void => {
    units.push(unit);
    top += unit.height;
  };

  for (const [fileIndex, group] of page.files.entries()) {
    const fileTop = top;
    const diff = patch.fileDiff(group.file);
    const renamePure = diff?.metadata.type === 'rename-pure';
    const headerHeight =
      pinnedFileHeader && fileIndex === 0 ? PINNED_FIRST_CARD_HEADER_HEIGHT : CARD_HEADER_HEIGHT;
    push({ kind: 'card-header', file: group.file, top, height: headerHeight });
    sourceAnchors.push({
      keys: [`file:${group.file}:header`],
      top: fileTop,
      height: headerHeight,
    });

    for (const c of measuredAnnotations) {
      if (c.target.kind === 'file' && c.target.file === group.file) {
        const pinTop = top;
        const pinHeight = annotationHeight(c);
        push({ kind: 'pin', file: group.file, top, height: pinHeight });
        const pinKey = annotationSourceKey(c);
        sourceAnchors.push({
          keys: [pinKey],
          fallbackKeys: [`file:${group.file}:header`],
          top: pinTop,
          height: pinHeight,
        });
      }
    }

    if (renamePure || diff === null) {
      const note = { kind: 'note' as const, file: group.file, top, height: NOTE_HEIGHT };
      push(note);
      sourceAnchors.push({
        keys: [`file:${group.file}:note`],
        fallbackKeys: [`file:${group.file}:header`],
        top: note.top,
        height: note.height,
      });
      for (const s of group.slices)
        bySliceKey.set(s.sliceKey, { top: note.top, height: note.height });
      const fileEndTop = top;
      push({ kind: 'card-end', file: group.file, top, height: CARD_END_HEIGHT });
      sourceAnchors.push({
        keys: [`file:${group.file}:end`],
        fallbackKeys: [`file:${group.file}:header`],
        top: fileEndTop,
        height: CARD_END_HEIGHT,
      });
      fileSections.push({
        fileId: group.file,
        sectionIndex: fileSections.length,
        sectionTop: fileTop,
        // `headerTop` is the actual path row, not the card's preceding margin.
        // File zero has no in-stream path row in pinned mode, so its fixed header
        // owns the section from the start.
        headerTop: pinnedFileHeader && fileIndex === 0 ? fileTop : fileTop + CARD_HEADER_HEIGHT - 1,
        bodyTop: fileTop + headerHeight,
        bodyHeight: top - fileTop - headerHeight - CARD_END_HEIGHT,
        sectionBottom: top,
      });
      continue;
    }

    const digits = sliceLineNumberDigits(diff);
    const fileGaps = expandedGaps?.get(group.file);
    const expansion: SliceExpansion | undefined =
      fileGaps !== undefined && fileGaps.size > 0
        ? {
            expandedKeys: fileGaps,
            sourceStatus: sourceStatusByFile?.get(group.file),
            side: expansionSide(diff),
          }
        : undefined;

    for (const hunk of group.hunks) {
      const primary = group.slices.filter((s) => s.hunkKey === hunk.hunkKey);
      const primaryKeys = new Set(primary.map((s) => s.sliceKey));
      const idx = patch.hunkIndex(hunk);
      const display: HunkDisplay =
        idx === null
          ? 'unavailable'
          : hunk.status === 'matched'
            ? 'matched'
            : expandedForeignHunks.has(hunk.hunkKey)
              ? 'expanded-foreign'
              : 'collapsed';
      const findingPins = page.findings.filter((finding) =>
        finding.sliceKeys.some((key) => primaryKeys.has(key))
      );
      const slicePins: LayoutPin[] = [];
      const ownedLinePins: {
        readonly pin: LayoutPin;
        readonly target: Extract<LayoutPinTarget, { kind: 'line' }>;
      }[] = [];
      for (const c of measuredAnnotations) {
        if (c.target.kind === 'slice' && primaryKeys.has(c.target.sliceKey)) slicePins.push(c);
        else if (c.target.kind === 'line' && primaryKeys.has(c.target.sliceKey)) {
          ownedLinePins.push({ pin: c, target: c.target });
        }
      }
      // A SUM, not a ternary: the `▴ … hide` header and the owner explanation are
      // independent one-row labels that can coexist on the same expanded hunk.
      // Both are priced from `display` alone, and the renderer draws them off the
      // same state — deriving "is this expanded foreign?" twice is how layout and
      // render drift a row apart.
      const hideHeaderHeight = display === 'expanded-foreign' ? 1 : 0;
      const ownerLabelHeight =
        showOwnerLabels && rendersHunkBody(display) && hunk.foreignOwnerLabels.length > 0 ? 1 : 0;
      const sliceTop =
        hideHeaderHeight +
        ownerLabelHeight +
        DEFAULT_ANNOTATION_HEIGHT * findingPins.length +
        slicePins.reduce((height, pin) => height + annotationHeight(pin), 0);
      const geometry = rendersHunkBody(display)
        ? measureSliceRowBounds({
            file: diff,
            hunkIndex: idx!,
            layout,
            width: cardWidth - 4,
            lineNumberDigits: digits,
            theme,
            highlighted: null,
            showLineNumbers,
            showHunkHeaders,
            wrapLines,
            ...(expansion !== undefined ? { expansion } : {}),
          })
        : null;
      const bodyHeight = geometry?.totalHeight ?? NOTE_HEIGHT;
      // Geometry owns the exact structure-only rows it measured. Reusing that
      // bounded plan avoids rebuilding every offscreen cell a second time just
      // to derive anchors and line-pin positions.
      const rows = geometry?.rows ?? [];
      const linePinsByRow =
        ownedLinePins.length === 0
          ? null
          : new Map<
              number,
              {
                readonly pin: LayoutPin;
                readonly target: Extract<LayoutPinTarget, { kind: 'line' }>;
              }[]
            >();
      if (linePinsByRow !== null) {
        for (const { pin, target } of ownedLinePins) {
          const rowIndex = rows.findIndex((row) => rowMatchesPin(row, target));
          if (rowIndex < 0) continue;
          const at = linePinsByRow.get(rowIndex);
          const placed = { pin, target };
          if (at === undefined) linePinsByRow.set(rowIndex, [placed]);
          else at.push(placed);
        }
      }
      const pinHeightAtRow = linePinsByRow === null ? null : new Uint32Array(rows.length);
      for (const [rowIndex, rowPins] of linePinsByRow ?? []) {
        pinHeightAtRow![rowIndex] = rowPins.reduce(
          (height, placed) => height + annotationHeight(placed.pin),
          0
        );
      }
      const pinHeightBeforeRow = linePinsByRow === null ? null : new Uint32Array(rows.length);
      let seenPinHeight = 0;
      if (pinHeightAtRow !== null && pinHeightBeforeRow !== null) {
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          pinHeightBeforeRow[rowIndex] = seenPinHeight;
          seenPinHeight += pinHeightAtRow[rowIndex] ?? 0;
        }
      }
      // Only price pins that the renderer can attach to a real row. A stale line
      // target stays visible through the header-pin degradation path; reserving
      // four invisible rows here would corrupt every scroll target below it.
      const extras = seenPinHeight;
      let rowExtraHeightsByKey = EMPTY_ROW_EXTRA_HEIGHTS;
      if (seenPinHeight > 0 && pinHeightAtRow !== null) {
        const extrasByKey = new Map<string, number>();
        for (const [rowIndex, row] of rows.entries()) {
          const pinHeight = pinHeightAtRow[rowIndex] ?? 0;
          if (pinHeight > 0) extrasByKey.set(row.key, pinHeight);
        }
        rowExtraHeightsByKey = extrasByKey;
      }
      const visualSliceHeight = bodyHeight + extras;
      const unit: HunkUnit = {
        kind: 'hunk',
        hunkKey: hunk.hunkKey,
        primarySliceKeys: primary.map((s) => s.sliceKey),
        file: group.file,
        top,
        height: sliceTop + visualSliceHeight,
        sliceTop,
        sliceHeight: bodyHeight,
        visualSliceHeight,
        rowExtraHeightsByKey,
        rowExtras: extras > 0,
        display,
      };
      push(unit);
      byHunkKey.set(hunk.hunkKey, unit);
      const hunkStartKey = `hunk:${hunk.hunkKey}:start`;
      const hunkBodyKey = `hunk:${hunk.hunkKey}:body`;
      const fileHeaderKey = `file:${group.file}:header`;
      sourceAnchors.push({
        keys: [hunkStartKey],
        fallbackKeys: [fileHeaderKey],
        top: unit.top,
        height: unit.height,
      });
      if (!rendersHunkBody(display) || unit.sliceTop > 0) {
        sourceAnchors.push({
          keys: [`hunk:${hunk.hunkKey}:chrome`],
          fallbackKeys: [fileHeaderKey],
          top: unit.top,
          height: rendersHunkBody(display) ? unit.sliceTop : unit.height,
        });
      }

      // Every piece of pre-body chrome gets its own identity. In particular, a
      // four-row slice/finding pin must not be represented as an offset into the
      // whole hunk chrome: adding an owner label or another pin above it would
      // otherwise move the viewport into unrelated content after a relayout.
      let chromeTop = unit.top;
      if (hideHeaderHeight > 0) {
        sourceAnchors.push({
          keys: [`hunk:${hunk.hunkKey}:hide-header`],
          fallbackKeys: [hunkStartKey, fileHeaderKey],
          top: chromeTop,
          height: hideHeaderHeight,
        });
        chromeTop += hideHeaderHeight;
      }
      if (ownerLabelHeight > 0) {
        sourceAnchors.push({
          keys: [`hunk:${hunk.hunkKey}:owner-label`],
          fallbackKeys: [hunkStartKey, fileHeaderKey],
          top: chromeTop,
          height: ownerLabelHeight,
        });
        chromeTop += ownerLabelHeight;
      }
      for (const [findingOrdinal] of findingPins.entries()) {
        sourceAnchors.push({
          keys: [`hunk:${hunk.hunkKey}:finding-pin:${findingOrdinal}`],
          fallbackKeys: [hunkBodyKey, hunkStartKey, fileHeaderKey],
          top: chromeTop,
          height: DEFAULT_ANNOTATION_HEIGHT,
        });
        chromeTop += DEFAULT_ANNOTATION_HEIGHT;
      }
      for (const pin of slicePins) {
        const target = pin.target;
        if (target.kind !== 'slice') continue;
        const pinKey = annotationSourceKey(pin);
        sourceAnchors.push({
          keys: [pinKey],
          fallbackKeys: [hunkBodyKey, hunkStartKey, fileHeaderKey],
          top: chromeTop,
          height: annotationHeight(pin),
        });
        chromeTop += annotationHeight(pin);
      }

      if (rendersHunkBody(display)) {
        sourceAnchors.push({
          keys: [hunkBodyKey],
          fallbackKeys: [fileHeaderKey],
          top: unit.top + unit.sliceTop,
          height: unit.visualSliceHeight,
        });
      }
      // The row plan is shared per immutable file across geometry and every
      // mounted DiffSlice. That makes source anchors for expanded foreign hunks
      // cheap too: subdued code gets the same stable resize/wrap identity as the
      // page-owned rows around it.
      if (geometry !== null) {
        let expandedGapFallback: string | null = null;
        const baseRowFallbackKeys = [hunkBodyKey, hunkStartKey, fileHeaderKey];
        for (const [rowIndex, row] of rows.entries()) {
          const bound = geometry.bounds[rowIndex];
          if (bound === undefined) continue;
          const pinsBefore = pinHeightBeforeRow?.[rowIndex] ?? 0;
          const keys = sourceAnchorKeys(hunk.hunkKey, row);
          const isExpansionRow =
            (row.type === 'split-line' || row.type === 'stack-line') && row.isExpansionRow === true;
          if (row.type === 'collapsed') expandedGapFallback = keys[0] ?? null;
          else if (!isExpansionRow) expandedGapFallback = null;
          const rowTop = unit.top + unit.sliceTop + bound.top + pinsBefore;
          const rowFallbackKeys =
            isExpansionRow && expandedGapFallback !== null
              ? [expandedGapFallback, ...baseRowFallbackKeys]
              : baseRowFallbackKeys;
          if (bound.height > 0) {
            sourceAnchors.push({
              keys,
              fallbackKeys: rowFallbackKeys,
              top: rowTop,
              height: bound.height,
            });
          }

          // Inline comments render AFTER the source row. Giving each one an
          // exact semantic block preserves both the chosen comment and the row
          // within its four-line card when wrapping/split/stack changes the
          // source row's own height. The target source line is the first fallback
          // if an anonymous comment disappears or moves without a durable id.
          let inlinePinTop = rowTop + bound.height;
          for (const placed of linePinsByRow?.get(rowIndex) ?? []) {
            const targetSourceKey = `hunk:${hunk.hunkKey}:${placed.target.side}:${placed.target.line}`;
            const pinKey = annotationSourceKey(placed.pin);
            const pinHeight = annotationHeight(placed.pin);
            sourceAnchors.push({
              keys: [pinKey],
              fallbackKeys: [targetSourceKey, hunkBodyKey, hunkStartKey, fileHeaderKey],
              top: inlinePinTop,
              height: pinHeight,
            });
            inlinePinTop += pinHeight;
          }
        }
      }
      if (geometry !== null && primary.length > 0) {
        for (const s of primary) {
          const firstRow = rows.findIndex((row) => rowMatchesUnit(row, s.unit));
          const firstBound = firstRow < 0 ? undefined : geometry.bounds[firstRow];
          const pinsBefore = firstRow < 0 ? 0 : (pinHeightBeforeRow?.[firstRow] ?? 0);
          const pinsOnTarget = firstRow < 0 ? 0 : (pinHeightAtRow?.[firstRow] ?? 0);
          bySliceKey.set(
            s.sliceKey,
            firstBound !== undefined
              ? {
                  top: unit.top + unit.sliceTop + firstBound.top + pinsBefore,
                  height: Math.max(1, firstBound.height + pinsOnTarget),
                }
              : { top: unit.top, height: unit.height }
          );
        }
      } else {
        for (const s of primary) bySliceKey.set(s.sliceKey, { top: unit.top, height: unit.height });
      }
      sections.push({
        fileId: hunk.hunkKey,
        sectionIndex: sections.length,
        sectionTop: unit.top,
        headerTop: unit.top,
        bodyTop: unit.top + unit.sliceTop,
        bodyHeight: unit.visualSliceHeight,
        sectionBottom: unit.top + unit.height,
      });
    }

    const fileEndTop = top;
    push({ kind: 'card-end', file: group.file, top, height: CARD_END_HEIGHT });
    sourceAnchors.push({
      keys: [`file:${group.file}:end`],
      fallbackKeys: [`file:${group.file}:header`],
      top: fileEndTop,
      height: CARD_END_HEIGHT,
    });
    fileSections.push({
      fileId: group.file,
      sectionIndex: fileSections.length,
      sectionTop: fileTop,
      headerTop: pinnedFileHeader && fileIndex === 0 ? fileTop : fileTop + CARD_HEADER_HEIGHT - 1,
      bodyTop: fileTop + headerHeight,
      bodyHeight: top - fileTop - headerHeight - CARD_END_HEIGHT,
      sectionBottom: top,
    });
  }

  const bySourceAnchorKey = new Map<string, LayoutSourceAnchor>();
  for (const anchor of sourceAnchors) {
    for (const key of anchor.keys) bySourceAnchorKey.set(key, anchor);
  }

  return {
    units,
    totalHeight: top,
    bySliceKey,
    byHunkKey,
    sections,
    fileSections,
    sourceAnchors,
    bySourceAnchorKey,
  };
}
