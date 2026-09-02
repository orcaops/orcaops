// The Brief's stat band: the branch's vitals as scannable tiles.
//
// The dashboard names its numbers in a label-over-value band before any detail;
// the Brief does the same, so scope, coverage, progress, attention and the
// rest read at a glance instead of as a grey label-value list in the left pane.
// Values carry semantic colour — attention amber when there is any, coverage by
// ratio, an unstarted count amber — so the band triages itself.
//
// It spans the full width above both panes and sheds its least-important tiles
// rather than wrapping (see `fitBriefStatBand`); the panes' height budget is
// reduced by the band's rows in `reviewBriefShellGeometry`.

import type { ReactNode } from 'react';

import type { Floor, UncertaintyState } from '@orcaops/review-core';

import { useCockpitTheme } from '../ThemeProvider';
import type { BriefAttentionRow } from './briefAttention';
import {
  briefCoveragePercent,
  briefPlanStatus,
  briefReviewScope,
  briefUncertaintyStates,
  coverageTone,
} from './briefOrientation';
import { briefStatTileCells, fitBriefStatBand } from './briefRows';
import type { ReaderModel } from './readerModel';

interface StatTile {
  key: string;
  label: string;
  /** Plain text of the value, for width measurement only. */
  valueText: string;
  value: ReactNode;
}

export function BriefStatBand({
  floor,
  reader,
  attention,
  width,
  uncertaintyStates,
}: {
  floor: Floor;
  reader: ReaderModel;
  attention: readonly BriefAttentionRow[];
  width: number;
  uncertaintyStates?: ReadonlyMap<string, UncertaintyState>;
}) {
  const { AMBER, BRIGHT, CYAN, DIMMER, FAINT, LIVE, RED } = useCockpitTheme();
  const coverageColor = (pct: number): string => {
    const tone = coverageTone(pct);
    return tone === 'positive' ? LIVE : tone === 'attention' ? AMBER : RED;
  };

  const pct = briefCoveragePercent(floor);
  // A five-cell meter beside the number: the tile is a glance, and a ratio
  // reads faster as a bar than as digits.
  const miniFilled = pct === null ? 0 : Math.max(0, Math.min(5, Math.round((pct / 100) * 5)));
  const coverageTile: StatTile[] =
    pct === null
      ? []
      : [
          {
            key: 'coverage',
            label: 'COVERAGE',
            valueText: `${pct}% ${'▓'.repeat(5)}`,
            value: (
              <text fg={coverageColor(pct)}>
                {`${pct}% `}
                <span fg={coverageColor(pct)}>{'▓'.repeat(miniFilled)}</span>
                <span fg={FAINT}>{'░'.repeat(5 - miniFilled)}</span>
              </text>
            ),
          },
        ];
  const attn = attention.length;
  const attentionTile: StatTile = {
    key: 'attention',
    label: 'ATTENTION',
    valueText: `${attn}`,
    value: <text fg={attn > 0 ? AMBER : DIMMER}>{`${attn}`}</text>,
  };
  const complete = reader.coverage.pagesComplete;
  const total = reader.coverage.pagesTotal;
  const completeColor = complete === 0 ? AMBER : complete >= total ? LIVE : BRIGHT;

  const story = reader.story;
  const unc = briefUncertaintyStates(floor, uncertaintyStates ?? new Map());
  const uncertaintyTile: StatTile = {
    key: 'uncertainty',
    label: 'UNCERTAINTY',
    valueText: `${unc.open} open`,
    value: <text fg={unc.open > 0 ? AMBER : LIVE}>{`${unc.open} open`}</text>,
  };
  let tiles: StatTile[];
  if (story === null) {
    const scope = briefReviewScope(floor);
    const plan = briefPlanStatus(floor);
    tiles = [
      {
        key: 'scope',
        label: 'SCOPE',
        valueText: `${scope.files}f +${scope.added} −${scope.removed}`,
        value: (
          <text fg={BRIGHT}>
            {`${scope.files}f `}
            <span fg={LIVE}>{`+${scope.added}`}</span>
            <span fg={RED}>{` −${scope.removed}`}</span>
          </text>
        ),
      },
      ...coverageTile,
      {
        key: 'progress',
        label: 'PROGRESS',
        valueText: `${complete}/${total} cp`,
        value: <text fg={completeColor}>{`${complete}/${total} cp`}</text>,
      },
      attentionTile,
      ...(plan === null
        ? []
        : [
            {
              key: 'plan',
              label: 'PLAN',
              valueText: `${plan.claimed}/${plan.total}`,
              value: (
                <text fg={plan.claimed < plan.total ? AMBER : LIVE}>
                  {`${plan.claimed}/${plan.total}`}
                </text>
              ),
            },
          ]),
      uncertaintyTile,
    ];
  } else {
    // The v4 model's never-conflated ownership state is the Story's headline
    // vital: it says how much of what follows is capture-backed.
    const ownership = story.label.replace(/_/gu, ' ').toLowerCase();
    const ownershipColor =
      story.label === 'DERIVED' ? CYAN : story.label === 'DEGRADED_ATTRIBUTION' ? AMBER : RED;
    const openItems = reader.routeIndex.attentionItems.filter(
      (item) => item.state === 'OPEN' || item.state === 'OUTSTANDING'
    ).length;
    tiles = [
      {
        key: 'parts',
        label: 'PARTS',
        valueText: `${complete}/${total}`,
        value: <text fg={completeColor}>{`${complete}/${total}`}</text>,
      },
      ...coverageTile,
      {
        key: 'ownership',
        label: 'OWNERSHIP',
        valueText: ownership,
        value: <text fg={ownershipColor}>{ownership}</text>,
      },
      attentionTile,
      {
        key: 'items',
        label: 'ITEMS',
        valueText: `${openItems} open`,
        value: <text fg={openItems > 0 ? AMBER : LIVE}>{`${openItems} open`}</text>,
      },
      uncertaintyTile,
    ];
  }

  const fitted = fitBriefStatBand(tiles, Math.max(1, width - 1));
  // A rule between tiles, the way the Watch's vitals strip separates its own
  // cells. Three rows tall so it spans label, gap and value but not the band's
  // top padding.
  const cells: ReactNode[] = [];
  fitted.forEach((tile, index) => {
    if (index > 0) {
      cells.push(
        <box key={`rule:${tile.key}`} width={1} height={3} flexShrink={0} flexDirection="column">
          <text fg={FAINT}>│</text>
          <text fg={FAINT}>│</text>
          <text fg={FAINT}>│</text>
        </box>
      );
    }
    cells.push(
      <box
        key={tile.key}
        flexDirection="column"
        flexShrink={0}
        width={briefStatTileCells(tile)}
        paddingLeft={2}
        paddingRight={2}
      >
        <box height={1}>
          <text fg={DIMMER}>{tile.label}</text>
        </box>
        <box height={1} />
        <box height={1}>{tile.value}</box>
      </box>
    );
  });

  return (
    <box
      id="review-brief-statband"
      flexDirection="row"
      width={width}
      height={4}
      flexShrink={0}
      paddingLeft={1}
      paddingTop={1}
    >
      {cells}
    </box>
  );
}
