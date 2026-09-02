import {
  type DiffFile,
  type LayoutMode,
  measureRenderedCodeLineWidth,
  resolveCodeViewportWidth,
  type SliceExpansion,
  sliceLineNumberDigits,
  trailingCollapsedLines,
} from '@orcaops/diff-render';

export interface ReviewDiffHorizontalGeometry {
  /** Width handed to each rendered DiffRowView after shell, scroll, and card chrome. */
  readonly codeRowWidth: number;
  readonly layout: Exclude<LayoutMode, 'auto'>;
}

export interface ReviewDiffShellGeometry {
  readonly split: boolean;
  readonly railWidth: number;
  readonly diffPaneWidth: number;
}

export interface ReviewReaderGeometry extends ReviewDiffShellGeometry {
  readonly bodyHeight: number;
  readonly railHeight: number;
  readonly diffHeight: number;
  /**
   * Synchronous upper bound for the native diff ScrollBox viewport.
   *
   * FloorDiff always reserves its reader and sticky-file rows above the
   * ScrollBox. Off-page comments may reserve more space, so this can safely
   * overestimate but can never under-mount newly exposed source rows.
   */
  readonly diffViewportUpperBound: number;
}

/** The exact hunks/context rows the current review page can render. */
export interface ReviewDiffHorizontalFile {
  readonly file: DiffFile;
  readonly renderedHunkIndices: readonly number[];
  readonly expansion?: SliceExpansion;
}

/** Width facts derived only from immutable active-page content. */
export interface ReviewDiffHorizontalContentMetrics {
  readonly widestCodeLine: number;
  readonly lineNumberDigits: number;
}

/** Shared responsive shell widths used by both the renderer and pan pricing. */
export function reviewDiffShellGeometry(width: number): ReviewDiffShellGeometry {
  const split = width >= 110;
  const railWidth = split ? Math.min(42, Math.max(32, Math.floor(width * 0.34))) : width;
  const diffPaneWidth = split ? Math.max(24, width - railWidth - 1) : width;
  return { split, railWidth, diffPaneWidth };
}

export interface ReviewBriefShellGeometry {
  readonly split: boolean;
  /** Left pane: orientation + attention. */
  readonly overviewWidth: number;
  /** Right pane: the Threads/Acts tree. */
  readonly treeWidth: number;
  readonly bodyHeight: number;
  readonly overviewHeight: number;
  readonly treeHeight: number;
}

/**
 * The Brief's own shell — deliberately NOT `reviewDiffShellGeometry`.
 *
 * The diff shell is asymmetric on purpose: a narrow rail beside a wide code
 * column, because code needs the room. The Brief has two lists, and neither
 * dominates, so it splits about evenly.
 *
 * Stacking is the other divergence. `reviewReaderGeometry` puts the rail ABOVE
 * the diff; the Brief puts the TREE on top, because the tree holds initial focus
 * and a focused pane below the fold is a pane the reviewer cannot see themselves
 * moving in.
 */
export function reviewBriefShellGeometry(
  width: number,
  height: number,
  /** Rows the tree would paint given everything it has. */
  treeRows = Number.MAX_SAFE_INTEGER,
  /** Rows reserved above the panes for the stat band and its rule. */
  bandRows = 0
): ReviewBriefShellGeometry {
  const split = width >= 110;
  const bodyHeight = Math.max(1, height - 1 - Math.max(0, bandRows));
  if (split) {
    const overviewWidth = Math.max(1, Math.floor(width / 2));
    return {
      split,
      overviewWidth,
      treeWidth: Math.max(1, width - overviewWidth - 1),
      bodyHeight,
      overviewHeight: bodyHeight,
      treeHeight: bodyHeight,
    };
  }
  // One vertical budget, shared — and the tree takes only what it can USE.
  // A fixed share looks reasonable until a two-checkpoint branch reserves half
  // the terminal for four rows and pushes the warnings band off the bottom of
  // the overview beneath it.
  const minimumOverviewHeight = Math.min(4, Math.max(1, bodyHeight));
  const share = Math.min(bodyHeight - minimumOverviewHeight, Math.ceil(bodyHeight * 0.55));
  const treeHeight = Math.min(
    bodyHeight,
    Math.max(Math.min(6, bodyHeight), Math.min(share, Math.max(1, treeRows)))
  );
  return {
    split,
    overviewWidth: width,
    treeWidth: width,
    bodyHeight,
    overviewHeight: Math.max(0, bodyHeight - treeHeight),
    treeHeight,
  };
}

/** Shared responsive width and height pricing used by ReaderWalk and ReviewApp. */
export function reviewReaderGeometry(width: number, height: number): ReviewReaderGeometry {
  const shell = reviewDiffShellGeometry(width);
  const bodyHeight = Math.max(1, height - 1);
  let railHeight = bodyHeight;
  let diffHeight = bodyHeight;
  if (!shell.split) {
    // A stacked shell has one finite vertical budget. Independent eight-row
    // minimums made short terminals claim more Yoga space than their parent
    // could paint (for example 8 + 8 rows inside an 11-row body). The native
    // diff ScrollBox then reported the fictional height and cursor-follow left
    // the selected row behind the clipped terminal viewport.
    // The contextual rail contains a three-row file navigator plus a bordered
    // scroll viewport. Preserve the rail's eight-row usable minimum whenever
    // the shared budget can still leave five rows for the diff; on truly tiny
    // terminals, the diff minimum wins and the rail receives the remainder.
    const minimumDiffHeight = Math.min(5, Math.max(1, bodyHeight));
    const minimumRailHeight = Math.min(8, Math.max(0, bodyHeight - minimumDiffHeight));
    const desiredRailHeight = Math.floor(bodyHeight * 0.45);
    railHeight = Math.min(
      Math.max(0, bodyHeight - minimumDiffHeight),
      Math.max(minimumRailHeight, desiredRailHeight)
    );
    diffHeight = bodyHeight - railHeight;
  }
  return {
    ...shell,
    bodyHeight,
    railHeight,
    diffHeight,
    diffViewportUpperBound: Math.max(1, diffHeight - 2),
  };
}

/** Resolve responsive diff layout from the actual diff-pane width. */
export function resolveReviewDiffLayout(
  diffPaneWidth: number,
  layout: LayoutMode
): Exclude<LayoutMode, 'auto'> {
  return layout === 'auto' ? (diffPaneWidth >= 88 ? 'split' : 'stack') : layout;
}

/**
 * Resolve the exact horizontal geometry shared by ReaderWalk, FloorDiff, and
 * CheckpointDiff without mounting those components.
 *
 * Horizontal panning is app-owned state, so its upper bound has to be known one
 * level above the renderer. Keeping the chrome arithmetic here prevents a
 * second, subtly different notion of the visible code viewport.
 */
export function reviewDiffHorizontalGeometry(
  width: number,
  layout: LayoutMode
): ReviewDiffHorizontalGeometry {
  const { diffPaneWidth } = reviewDiffShellGeometry(width);
  const checkpointWidth = Math.max(24, diffPaneWidth - 2);
  const codeRowWidth = Math.max(24, checkpointWidth - 4);
  const resolvedLayout = resolveReviewDiffLayout(diffPaneWidth, layout);

  return { codeRowWidth, layout: resolvedLayout };
}

/**
 * Furthest useful code reveal for the active reader page.
 *
 * All rows share one offset, matching Hunk. The widest line and widest
 * line-number gutter therefore define one stable page bound; short pages clamp
 * to zero instead of allowing repeated input to pan every code cell off-screen.
 */
export function measureReviewDiffHorizontalContent(
  content: readonly ReviewDiffHorizontalFile[]
): ReviewDiffHorizontalContentMetrics {
  let widestCodeLine = 0;
  let lineNumberDigits = 1;
  for (const entry of content) {
    lineNumberDigits = Math.max(lineNumberDigits, sliceLineNumberDigits(entry.file));
    const metadata = entry.file.metadata;
    const normalizedSource =
      entry.expansion?.sourceStatus?.kind === 'loaded'
        ? entry.expansion.sourceStatus.text.replaceAll('\r\n', '\n').replace(/\n$/, '')
        : '';
    const sourceLines = normalizedSource.length === 0 ? [] : normalizedSource.split('\n');
    const includeSourceRange = (startLine: number, count: number): void => {
      // expandCollapsedRows renders the entire requested range or only its
      // one-row error status. Partial source must therefore contribute no code
      // width; otherwise an invisible long prefix can enable blank panning.
      const startIndex = startLine - 1;
      if (count <= 0 || startIndex < 0 || startIndex + count > sourceLines.length) return;
      for (let offset = 0; offset < count; offset += 1) {
        widestCodeLine = Math.max(
          widestCodeLine,
          measureRenderedCodeLineWidth(sourceLines[startIndex + offset])
        );
      }
    };
    for (const hunkIndex of entry.renderedHunkIndices) {
      const hunk = metadata.hunks[hunkIndex];
      if (hunk === undefined) continue;
      for (let offset = 0; offset < hunk.deletionCount; offset += 1) {
        widestCodeLine = Math.max(
          widestCodeLine,
          measureRenderedCodeLineWidth(metadata.deletionLines[hunk.deletionLineIndex + offset])
        );
      }
      for (let offset = 0; offset < hunk.additionCount; offset += 1) {
        widestCodeLine = Math.max(
          widestCodeLine,
          measureRenderedCodeLineWidth(metadata.additionLines[hunk.additionLineIndex + offset])
        );
      }

      const expansion = entry.expansion;
      if (expansion === undefined || sourceLines.length === 0) continue;
      if (expansion.expandedKeys.has(`before:${hunkIndex}`) && hunk.collapsedBefore > 0) {
        const start =
          (expansion.side === 'old' ? hunk.deletionStart : hunk.additionStart) -
          hunk.collapsedBefore;
        includeSourceRange(start, hunk.collapsedBefore);
      }
      if (
        hunkIndex === metadata.hunks.length - 1 &&
        expansion.expandedKeys.has(`trailing:${hunkIndex}`)
      ) {
        const trailing = trailingCollapsedLines(metadata);
        const start =
          expansion.side === 'old'
            ? hunk.deletionStart + hunk.deletionCount
            : hunk.additionStart + hunk.additionCount;
        includeSourceRange(start, trailing);
      }
    }
  }
  return { widestCodeLine, lineNumberDigits };
}

/** Price viewport chrome in O(1) from content metrics cached by the caller. */
export function maxReviewCodeHorizontalOffsetFromMetrics({
  metrics,
  width,
  layout,
  showLineNumbers,
}: {
  readonly metrics: ReviewDiffHorizontalContentMetrics;
  readonly width: number;
  readonly layout: LayoutMode;
  readonly showLineNumbers: boolean;
}): number {
  const geometry = reviewDiffHorizontalGeometry(width, layout);
  const viewportWidth = resolveCodeViewportWidth(
    geometry.layout,
    geometry.codeRowWidth,
    metrics.lineNumberDigits,
    showLineNumbers
  );

  return Math.max(0, metrics.widestCodeLine - viewportWidth);
}

/** Convenience wrapper for one-off callers and tests. */
export function maxReviewCodeHorizontalOffset({
  content,
  width,
  layout,
  showLineNumbers,
}: {
  readonly content: readonly ReviewDiffHorizontalFile[];
  readonly width: number;
  readonly layout: LayoutMode;
  readonly showLineNumbers: boolean;
}): number {
  return maxReviewCodeHorizontalOffsetFromMetrics({
    metrics: measureReviewDiffHorizontalContent(content),
    width,
    layout,
    showLineNumbers,
  });
}
