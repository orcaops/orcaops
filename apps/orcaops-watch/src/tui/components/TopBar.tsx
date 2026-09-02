import { fmtTokens } from '../../core/format';
import { attentionRows } from '../../core/presenters';
import type { WatchSnapshot } from '../../data/types';
import { useCockpitTheme } from '../ThemeProvider';
import { displayLen, truncate } from '../layout';
import { pickLogo } from '../logo';
import { fitActionRow } from '../responsiveLayout';
import { statusCounts, type StatusFilter, totalTasks, totalThreads } from '../viewModel';
import { FilterBar } from './FilterBar';

/** A two-row stat tile: uppercase label over its value. */
function Tile({
  label,
  value,
  width,
  accent,
}: {
  label: string;
  value: string;
  width: number;
  accent?: string;
}) {
  const { BRIGHT, DIMMER } = useCockpitTheme();
  return (
    <box width={width} flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={1}>
      <box height={1}>
        <text fg={DIMMER}>{truncate(label, Math.max(1, width - 3))}</text>
      </box>
      <box height={1}>
        <text fg={accent ?? BRIGHT}>{truncate(value, Math.max(1, width - 3))}</text>
      </box>
    </box>
  );
}

export interface TopBarLayoutItem {
  id: 'threads' | 'tasks' | 'checkpoints' | 'attention' | 'tokens' | 'clock';
  label: string;
  value: string;
  width: number;
}

export interface TopBarLayout {
  items: readonly TopBarLayoutItem[];
  droppedIds: readonly string[];
  requiredDroppedIds: readonly string[];
  occupiedWidth: number;
}

/** Width policy for the two fixed TopBar rows; values remain paired with labels. */
export function selectTopBarLayout(
  snapshot: WatchSnapshot,
  clock: string,
  width: number
): TopBarLayout {
  const values = {
    threads: String(totalThreads(snapshot)),
    tasks: String(totalTasks(snapshot)),
    checkpoints: String(snapshot.totals.openCheckpoints),
    attention: String(attentionRows(snapshot).length),
    tokens: fmtTokens(snapshot.totals.sessionTokens),
    clock: '',
  } as const;
  const definitions = [
    { id: 'threads', fullLabel: 'THREADS', shortLabel: 'THR', priority: 0, required: true },
    { id: 'tasks', fullLabel: 'TASKS', shortLabel: 'TASK', priority: 2 },
    { id: 'checkpoints', fullLabel: 'OPEN CP', shortLabel: 'CP', priority: 3 },
    { id: 'attention', fullLabel: 'ATTENTION', shortLabel: 'ATTN', priority: 0, required: true },
    { id: 'tokens', fullLabel: 'SESSION TOKENS', shortLabel: 'TOK', priority: 4 },
    {
      id: 'clock',
      fullLabel: `● LIVE ${clock}`,
      shortLabel: `● ${clock.slice(0, 5)}`,
      priority: -1,
      required: true,
    },
  ] as const;
  const row = fitActionRow(
    definitions.map((definition) => {
      const value = values[definition.id];
      const tileWidth = (label: string): number =>
        definition.id === 'clock'
          ? displayLen(label)
          : Math.max(displayLen(label), displayLen(value)) + 3;
      return {
        ...definition,
        fullWidth: tileWidth(definition.fullLabel),
        shortWidth: tileWidth(definition.shortLabel),
      };
    }),
    width
  );
  return {
    items: row.items.map((item) => ({
      id: item.id as TopBarLayoutItem['id'],
      label: item.label,
      value: values[item.id as keyof typeof values],
      width: item.width,
    })),
    droppedIds: row.droppedIds,
    requiredDroppedIds: row.requiredDroppedIds,
    occupiedWidth: row.occupiedWidth,
  };
}

/**
 * The top bar. Two columns — the orcaops braille logo dedicated to
 * the left (sized to `railWidth` so it sits directly above the session rail, and
 * shrinking full → narrow lockup → bare icon as space tightens), and all
 * interactive chrome on the right above the detail pane. The stat tiles and the
 * LIVE clock share the top row (both top-aligned); the filter + repo control sit
 * at the bottom edge. The data-root / project count lives in the footer.
 */
export function TopBar({
  snapshot,
  clock,
  width,
  rows = 6,
  railWidth,
  filter,
  repo,
  repoOpen,
  onFilter,
  onRepo,
}: {
  snapshot: WatchSnapshot;
  clock: string;
  width: number;
  rows?: number;
  railWidth: number;
  filter: StatusFilter;
  repo: string | null;
  repoOpen: boolean;
  onFilter: (filter: StatusFilter) => void;
  onRepo: () => void;
}) {
  const { AMBER, BRIGHT, DIMMER, FG, LIVE } = useCockpitTheme();
  const attention = attentionRows(snapshot).length;
  const logo = pickLogo(railWidth);
  const compactHeight = rows < 6;
  const chromeWidth = Math.max(1, width - (compactHeight ? 0 : railWidth) - 2);
  const layout = selectTopBarLayout(snapshot, clock, chromeWidth);
  // On the tallest (6-row) logo, drop the chrome one row so the tiles/clock sit
  // against the wordmark instead of above it. Shorter variants stay top-aligned.
  const offsetTop = !compactHeight && logo.length >= 6;
  return (
    <box height={rows} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
      {/* Left: the logo, dedicated above the rail (responsive variant). */}
      {compactHeight ? null : (
        <box width={railWidth} flexShrink={0} flexDirection="column">
          {logo.map((line, i) => (
            <box key={i} height={1}>
              <text fg={FG}>{line}</text>
            </box>
          ))}
        </box>
      )}
      {/* Right: interactive chrome over the detail pane. */}
      <box flexGrow={1} flexDirection="column">
        {offsetTop ? <box height={1} /> : null}
        {/* Stat tiles + LIVE clock. */}
        {rows < 3 ? null : (
          <box flexDirection="row" height={2}>
            {layout.items.map((item) =>
              item.id === 'clock' ? (
                <box key={item.id} flexGrow={1} flexDirection="row" justifyContent="flex-end">
                  <text fg={LIVE}>{item.label.slice(0, 1)}</text>
                  <text fg={item.label.includes('LIVE') ? DIMMER : BRIGHT}>
                    {item.label.slice(1)}
                  </text>
                </box>
              ) : (
                <Tile
                  key={item.id}
                  label={item.label}
                  value={item.value}
                  width={item.width}
                  accent={item.id === 'attention' && attention > 0 ? AMBER : undefined}
                />
              )
            )}
          </box>
        )}
        <box flexGrow={1} />
        <FilterBar
          width={chromeWidth}
          counts={statusCounts(snapshot)}
          filter={filter}
          repo={repo}
          open={repoOpen}
          onFilter={onFilter}
          onRepo={onRepo}
        />
      </box>
    </box>
  );
}
