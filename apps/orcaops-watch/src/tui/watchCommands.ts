import {
  type CommandPlacement,
  type CommandPresentation,
  hasPlacement,
  type KeyGestureLike,
  normalizeCommandGesture,
} from './commandRegistry';

export type WatchPane = 'rail' | 'detail';
export type WatchDetailMode = 'overview' | 'checkpoint';

export interface WatchCommandContext {
  connected: boolean;
  pane: WatchPane;
  detailMode: WatchDetailMode;
}

export const WATCH_COMMAND_IDS = [
  'watch.move',
  'watch.open-detail',
  'watch.back-detail',
  'watch.cycle-filter',
  'watch.cycle-grouping',
  'watch.choose-repository',
  'watch.toggle-notifications',
  'watch.half-page-up',
  'watch.half-page-down',
  'watch.page-up',
  'watch.page-down',
  'watch.scroll-top',
  'watch.scroll-bottom',
] as const;

export type WatchCommandId = (typeof WATCH_COMMAND_IDS)[number];

interface WatchCommandDefinition {
  id: WatchCommandId;
  gestures: readonly string[];
  label: string | ((context: WatchCommandContext) => string);
  shortLabel: string | ((context: WatchCommandContext) => string);
  helpLabel: string | ((context: WatchCommandContext) => string);
  placements: readonly CommandPlacement[];
  priority: number;
  required?: boolean;
  visible: (context: WatchCommandContext) => boolean;
  enabled?: (context: WatchCommandContext) => boolean;
}

const connected = (context: WatchCommandContext): boolean => context.connected;
const inRail = (context: WatchCommandContext): boolean =>
  context.connected && context.pane === 'rail';
const inDetail = (context: WatchCommandContext): boolean =>
  context.connected && context.pane === 'detail';
const inDetailOverview = (context: WatchCommandContext): boolean =>
  inDetail(context) && context.detailMode === 'overview';

export const WATCH_COMMANDS: readonly WatchCommandDefinition[] = [
  {
    id: 'watch.move',
    gestures: ['j', 'k', '↑', '↓'],
    label: (context) => (context.pane === 'rail' ? 'Select Work' : 'Move in Detail'),
    shortLabel: (context) => (context.pane === 'rail' ? 'select' : 'move'),
    helpLabel: (context) =>
      context.pane === 'rail'
        ? 'Move between threads and tasks'
        : context.detailMode === 'checkpoint'
          ? 'Scroll the checkpoint evidence'
          : 'Move through selectable detail rows',
    placements: ['help', 'footer', 'palette'],
    priority: 0,
    required: true,
    visible: connected,
  },
  {
    id: 'watch.open-detail',
    gestures: ['↵', '→'],
    label: 'Open Selected Detail',
    shortLabel: 'open',
    helpLabel: (context) =>
      context.pane === 'rail' ? 'Open details for the selected row' : 'Open the selected detail',
    placements: ['help', 'footer', 'palette'],
    priority: 0,
    required: true,
    visible: (context) => inRail(context) || inDetailOverview(context),
  },
  {
    id: 'watch.back-detail',
    gestures: ['esc', '←', 'q'],
    label: 'Back One Detail Level',
    shortLabel: 'back',
    helpLabel: 'Go back one detail level',
    placements: ['help', 'footer', 'palette'],
    priority: 0,
    required: true,
    visible: inDetail,
  },
  {
    id: 'watch.cycle-filter',
    gestures: ['/'],
    label: 'Cycle Status Filter',
    shortLabel: 'filter',
    helpLabel: 'Cycle the status filter',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 1,
    visible: connected,
  },
  {
    // `w` as in Work grouping: `g`/`G` are vi-style scroll and `t` is the
    // global Choose Theme key.
    id: 'watch.cycle-grouping',
    gestures: ['w'],
    label: 'Change Work Grouping',
    shortLabel: 'group',
    helpLabel: 'Change how work is grouped',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 3,
    visible: connected,
  },
  {
    id: 'watch.choose-repository',
    gestures: ['r'],
    label: 'Choose Repository',
    shortLabel: 'repo',
    helpLabel: 'Choose a repository',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 2,
    visible: connected,
  },
  {
    id: 'watch.toggle-notifications',
    gestures: ['n'],
    label: 'Toggle Notifications',
    shortLabel: 'notify',
    helpLabel: 'Turn notifications on or off',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 5,
    visible: connected,
  },
  {
    id: 'watch.half-page-up',
    gestures: ['C-u'],
    label: 'Half Page Up',
    shortLabel: 'half up',
    helpLabel: 'Move the current pane up by half its live viewport',
    placements: ['help', 'palette'],
    priority: 6,
    visible: connected,
  },
  {
    id: 'watch.half-page-down',
    gestures: ['C-d'],
    label: 'Half Page Down',
    shortLabel: 'half down',
    helpLabel: 'Move the current pane down by half its live viewport',
    placements: ['help', 'palette'],
    priority: 6,
    visible: connected,
  },
  {
    id: 'watch.page-up',
    gestures: ['b', 'pgup'],
    label: 'Page Up',
    shortLabel: 'page up',
    helpLabel: 'Move the current pane up by one live viewport',
    placements: ['help', 'palette'],
    priority: 6,
    visible: connected,
  },
  {
    id: 'watch.page-down',
    gestures: ['f', 'space', 'pgdn'],
    label: 'Page Down',
    shortLabel: 'page down',
    helpLabel: 'Move the current pane down by one live viewport',
    placements: ['help', 'palette'],
    priority: 6,
    visible: connected,
  },
  {
    id: 'watch.scroll-top',
    gestures: ['g'],
    label: (context) =>
      context.pane === 'rail' ? 'Scroll Thread List to Top' : 'Scroll Detail to Top',
    shortLabel: 'top',
    helpLabel: (context) =>
      context.pane === 'rail'
        ? 'Scroll the thread list to the top'
        : 'Scroll the detail view to the top',
    placements: ['help', 'palette'],
    priority: 6,
    visible: connected,
  },
  {
    id: 'watch.scroll-bottom',
    gestures: ['G'],
    label: (context) =>
      context.pane === 'rail' ? 'Scroll Thread List to Bottom' : 'Scroll Detail to Bottom',
    shortLabel: 'bottom',
    helpLabel: (context) =>
      context.pane === 'rail'
        ? 'Scroll the thread list to the bottom'
        : 'Scroll the detail view to the bottom',
    placements: ['help', 'palette'],
    priority: 6,
    visible: connected,
  },
];

const definitionById = new Map(WATCH_COMMANDS.map((command) => [command.id, command]));

function contextual(
  value: string | ((context: WatchCommandContext) => string),
  context: WatchCommandContext
) {
  return typeof value === 'function' ? value(context) : value;
}

export interface WatchCommandPresentation extends CommandPresentation<WatchCommandId> {
  priority: number;
  required: boolean;
}

export function resolveWatchCommand(
  id: WatchCommandId,
  context: WatchCommandContext
): WatchCommandPresentation {
  const definition = definitionById.get(id);
  if (definition === undefined) throw new Error(`Unknown Watch command: ${id}`);
  return {
    id,
    gestures: definition.gestures,
    label: contextual(definition.label, context),
    shortLabel: contextual(definition.shortLabel, context),
    helpLabel: contextual(definition.helpLabel, context),
    placements: definition.placements,
    priority: definition.priority,
    required: definition.required ?? false,
    visible: definition.visible(context),
    enabled: (definition.enabled ?? definition.visible)(context),
  };
}

export function selectVisibleWatchCommands(
  context: WatchCommandContext
): WatchCommandPresentation[] {
  return WATCH_COMMANDS.map((command) => resolveWatchCommand(command.id, context)).filter(
    (command) => command.visible
  );
}

/** Resolve one live Watch gesture without duplicating registry visibility rules. */
export function resolveWatchCommandForKey(
  context: WatchCommandContext,
  key: KeyGestureLike
): WatchCommandPresentation | null {
  const gesture = normalizeCommandGesture(key);
  return (
    selectVisibleWatchCommands(context).find(
      (command) => command.enabled && command.gestures.includes(gesture)
    ) ?? null
  );
}

export function selectWatchCommands(
  context: WatchCommandContext,
  placement: CommandPlacement
): WatchCommandPresentation[] {
  return selectVisibleWatchCommands(context).filter((command) => hasPlacement(command, placement));
}
