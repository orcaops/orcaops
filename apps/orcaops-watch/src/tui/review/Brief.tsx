// One Brief, two panes, both lenses.
//
// The right pane is the same tree either way; the left pane differs only in what
// facts the lens can actually answer.
//
// Layout is about 50/50 above 110 columns and stacked below, with the TREE on
// top when stacked because the tree holds initial focus.

import type { Floor, ReviewLifecycleLedger, UncertaintyState } from '@orcaops/review-core';

import type { RoutineStoryAnchors } from '../../data/reviewSource';
import type { StalenessRow } from '../../data/staleness';
import { useCockpitTheme } from '../ThemeProvider';
import { Rule } from '../kit';
import { BriefOverview } from './BriefOverview';
import { BriefStatBand } from './BriefStatBand';
import { BriefTreePane } from './BriefTreePane';
import type { BriefAttentionRow } from './briefAttention';
import type { BriefTree as BriefTreeModel } from './briefTree';
import type { StoryReviewFocus } from './keymap';
import type { ReaderModel } from './readerModel';
import { BRIEF_TREE_FOCUS } from './readerReviewController';
import { reviewBriefShellGeometry } from './reviewDiffHorizontal';

/**
 * Rows reserved above the panes for the stat band and its rule.
 *
 * Four for the band — a blank row off the menu bar, the labels, a blank row,
 * then the values — plus one for the rule beneath it. The band is a header, and
 * a header jammed against its neighbours reads as noise rather than structure.
 */
const BRIEF_STAT_BAND_ROWS = 5;

/**
 * The seam between the panes.
 *
 * It costs nothing: `reviewBriefShellGeometry` already withholds one column
 * from the tree (`width - overviewWidth - 1`), so the rule lands in a reserved
 * column that would otherwise paint as dead space at the right edge.
 */
function PaneDivider({ height }: { height: number }) {
  const { FRAME } = useCockpitTheme();
  const rows = Math.max(0, Math.floor(height));
  return (
    <box
      id="review-brief-pane-divider"
      width={1}
      height={rows}
      flexShrink={0}
      flexDirection="column"
    >
      {Array.from({ length: rows }, (_, index) => (
        <text key={`divider-${index}`} fg={FRAME}>
          │
        </text>
      ))}
    </box>
  );
}

export function Brief({
  floor,
  reader,
  tree,
  attention,
  briefCursor,
  attentionCursor,
  attentionRowKey,
  focus,
  width,
  height,
  lifecycle,
  staleness,
  openComments = 0,
  uncertaintyStates,
  anchorStatus,
  onActivateDestination,
  onActivateAttention,
}: {
  floor: Floor;
  reader: ReaderModel;
  tree: BriefTreeModel;
  attention: readonly BriefAttentionRow[];
  briefCursor: number;
  attentionCursor: number;
  attentionRowKey: string | null;
  focus: StoryReviewFocus;
  width: number;
  height: number;
  lifecycle?: ReviewLifecycleLedger;
  staleness?: StalenessRow | null;
  openComments?: number;
  uncertaintyStates?: ReadonlyMap<string, UncertaintyState>;
  /** Semantic-anchor generation health, surfaced on the Story lens only. */
  anchorStatus?: RoutineStoryAnchors['status'];
  onActivateDestination?: (destination: number) => void;
  onActivateAttention?: (index: number) => void;
}) {
  // Header, its scroll affordance, every heading and every destination.
  const treeRows = tree.groups.length + tree.destinations.length + 3;
  const shell = reviewBriefShellGeometry(width, height, treeRows, BRIEF_STAT_BAND_ROWS);
  const treeFocused = focus === BRIEF_TREE_FOCUS;
  const overview = (
    <BriefOverview
      floor={floor}
      reader={reader}
      attention={attention}
      attentionCursor={attentionCursor}
      attentionRowKey={attentionRowKey}
      focused={!treeFocused}
      width={shell.overviewWidth}
      height={shell.overviewHeight}
      staleness={staleness}
      openComments={openComments}
      uncertaintyStates={uncertaintyStates}
      anchorStatus={anchorStatus}
      onActivateAttention={onActivateAttention}
    />
  );
  const treePane = (
    <BriefTreePane
      tree={tree}
      reader={reader}
      cursor={briefCursor}
      focused={treeFocused}
      width={shell.treeWidth}
      height={shell.treeHeight}
      lifecycle={lifecycle}
      title={null}
      onActivate={onActivateDestination}
    />
  );

  return (
    <box id="review-brief" flexDirection="column" width={width} height={height}>
      <BriefStatBand
        floor={floor}
        reader={reader}
        attention={attention}
        width={width}
        uncertaintyStates={uncertaintyStates}
      />
      <Rule width={width} />
      <box
        id="review-brief-body"
        flexDirection={shell.split ? 'row' : 'column'}
        width={width}
        height={shell.bodyHeight}
      >
        {shell.split ? (
          <>
            {overview}
            <PaneDivider height={shell.bodyHeight} />
            {treePane}
          </>
        ) : (
          <>
            {treePane}
            {overview}
          </>
        )}
      </box>
    </box>
  );
}
