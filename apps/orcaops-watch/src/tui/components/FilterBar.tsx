import { type PresentationTone, StatPill } from '../kit';
import { displayLen, truncate } from '../layout';
import { fitActionRow } from '../responsiveLayout';
import { GLYPH, UI_GLYPH } from '../theme';
import type { StatusFilter } from '../viewModel';

const CHIPS: readonly [StatusFilter, string, string, string, PresentationTone][] = [
  ['all', 'All', 'All', '', 'muted'],
  ['attention', 'Attention', 'Attn', UI_GLYPH.attention, 'attention'],
  ['working', 'Working', 'Work', GLYPH.working, 'positive'],
  ['ready', 'Ready', 'Ready', GLYPH.ready, 'info'],
  ['idle', 'Idle', 'Idle', GLYPH.idle, 'muted'],
];

export interface FilterBarLayoutItem {
  id: string;
  label: string;
  width: number;
  key?: StatusFilter;
  glyph: string;
  tone: PresentationTone;
  value?: number;
}

export interface FilterBarLayout {
  items: readonly FilterBarLayoutItem[];
  droppedIds: readonly string[];
  requiredDroppedIds: readonly string[];
  occupiedWidth: number;
}

/** Keep the active count and repository disclosure; add other filters by priority. */
export function selectFilterBarLayout({
  width,
  counts,
  filter,
  repo,
  open,
}: {
  width: number;
  counts: Record<StatusFilter, number>;
  filter: StatusFilter;
  repo: string | null;
  open: boolean;
}): FilterBarLayout {
  const definitions = [
    {
      id: 'watch-filter-label',
      fullLabel: 'filter',
      shortLabel: '/',
      fixedWidth: 2,
      priority: 5,
    },
    ...CHIPS.map(([key, fullLabel, shortLabel, glyph]) => ({
      id: `watch-filter-${key}`,
      fullLabel,
      shortLabel,
      fixedWidth:
        2 + (glyph.length === 0 ? 0 : displayLen(glyph) + 1) + displayLen(String(counts[key])) + 1,
      priority: key === filter ? 0 : key === 'attention' ? 1 : key === 'working' ? 2 : 3,
      required: key === filter,
    })),
    {
      id: 'watch-repo-filter',
      fullLabel: truncate(repo ?? 'all repos', Math.max(8, Math.floor(width * 0.35))),
      fixedWidth:
        2 + displayLen(open ? UI_GLYPH.disclosureExpanded : UI_GLYPH.disclosureCollapsed) + 1,
      priority: -1,
      required: true,
    },
  ];
  const row = fitActionRow(definitions, width, 1);
  return {
    items: row.items.map((item) => {
      if (item.id === 'watch-filter-label') {
        return { id: item.id, label: item.label, width: item.width, glyph: '', tone: 'muted' };
      }
      if (item.id === 'watch-repo-filter') {
        return {
          id: item.id,
          label: item.label,
          width: item.width,
          glyph: open ? UI_GLYPH.disclosureExpanded : UI_GLYPH.disclosureCollapsed,
          tone: 'accent',
        };
      }
      const chip = CHIPS.find(([key]) => `watch-filter-${key}` === item.id)!;
      return {
        id: item.id,
        label: item.label,
        width: item.width,
        key: chip[0],
        glyph: chip[3],
        tone: chip[4],
        value: counts[chip[0]],
      };
    }),
    droppedIds: row.droppedIds,
    requiredDroppedIds: row.requiredDroppedIds,
    occupiedWidth: row.occupiedWidth,
  };
}

/** Click-through status filters (glyph pills) + repo control. */
export function FilterBar({
  width,
  counts,
  filter,
  repo,
  open,
  onFilter,
  onRepo,
}: {
  width: number;
  counts: Record<StatusFilter, number>;
  filter: StatusFilter;
  repo: string | null;
  open: boolean;
  onFilter: (filter: StatusFilter) => void;
  onRepo: () => void;
}) {
  const layout = selectFilterBarLayout({ width, counts, filter, repo, open });
  const left = layout.items.filter((item) => item.id !== 'watch-repo-filter');
  const repoItem = layout.items.find((item) => item.id === 'watch-repo-filter');
  return (
    <box width={width} flexDirection="row" height={1}>
      {left.map((item, index) => {
        const active = item.key === filter;
        return (
          <box key={item.id} flexDirection="row">
            {index === 0 ? null : <text> </text>}
            <StatPill
              id={item.id}
              label={item.label}
              value={item.value}
              glyph={item.glyph}
              tone={item.tone}
              selected={active}
              onActivate={item.key === undefined ? undefined : () => onFilter(item.key!)}
            />
          </box>
        );
      })}
      <box flexGrow={1} />
      {repoItem === undefined ? null : (
        <>
          {left.length === 0 ? null : <text> </text>}
          <StatPill
            id="watch-repo-filter"
            label={repoItem.label}
            glyph={repoItem.glyph}
            tone="accent"
            selected={open}
            onActivate={onRepo}
          />
        </>
      )}
    </box>
  );
}
