import {
  type CommandPlacement,
  type CommandPresentation,
  hasPlacement,
  type KeyGestureLike,
  normalizeCommandGesture,
} from './commandRegistry';

/**
 * Presentation-only shell commands shared by the watch and review surfaces.
 *
 * This catalog deliberately does not dispatch commands. It is the single source
 * for the labels and availability that the menu bar, help, and footer present.
 */

export const SHELL_COMMAND_IDS = [
  'open-review',
  'review-back',
  'back-to-watch',
  'story-lens',
  'captured-checkpoint-lens',
  'theme',
  'help',
  'next-pane',
  'open-menu',
  'quit',
] as const;

export type ShellCommandId = (typeof SHELL_COMMAND_IDS)[number];
export type ShellMode = 'watch' | 'review';
export type ShellMenuGroup = 'application' | 'review' | 'view' | 'help';

/**
 * Highest to lowest input ownership across the persistent shell.
 *
 * Ctrl-C remains a process-level escape hatch. Every other key is claimed by
 * the first open layer in this list, so a screen command can never leak through
 * a composer, dialog, menu, or contextual picker.
 */
export const SHELL_INPUT_PRECEDENCE = [
  'text-input',
  'help',
  'theme-selector',
  'application-menu',
  'contextual-popover',
  'screen',
] as const;

export type ShellInputLayer = (typeof SHELL_INPUT_PRECEDENCE)[number];

export interface ShellContext {
  mode: ShellMode;
  /** Whether the current watch selection can open in the review reader. */
  reviewable: boolean;
  /** Only the Watch rail root may turn q into process Quit. */
  watchAtRoot: boolean;
  /** Only the Brief with no local Back step remaining may return to Watch. */
  reviewAtRoot: boolean;
  /** Whether a validated current routine Story can be selected. */
  storyAvailable: boolean;
  /** A validated model exists (current OR stale) — enables explicit selection. */
  storyViewable: boolean;
  /** The reader lens currently mounted in Review. */
  reviewLens: 'deterministic' | 'story';
}

export interface ShellCommandDefinition {
  id: ShellCommandId;
  gestures: readonly string[];
  /** Display-only override for chrome that should not show the canonical
   *  gesture glyph (e.g. `⇥` renders as `Tab`). Never consulted for
   *  dispatch — input routing always matches `gestures`. */
  keyLabel?: string;
  label: string;
  /** Compact product label for persistent chrome such as top actions and footers. */
  shortLabel: string;
  helpLabel: string;
  placements: readonly CommandPlacement[];
  /** Lower values survive fixed-row pressure first. */
  priority: number;
  /** Required fixed-row commands are admitted before optional commands. */
  required?: boolean;
  menuGroup?: ShellMenuGroup;
  visible: (context: ShellContext) => boolean;
  enabled: (context: ShellContext) => boolean;
}

export interface ShellCommandPresentation extends CommandPresentation<ShellCommandId> {
  /** The canonical display key for persistent chrome: the definition's
   *  override, else the first gesture, else null for menu-only commands
   *  (chrome renders no key). */
  keyLabel: string | null;
  priority: number;
  required: boolean;
  menuGroup?: ShellMenuGroup;
}

export interface ShellMenuSection {
  id: ShellMenuGroup;
  label: string;
  commands: ShellCommandPresentation[];
}

const always = (): boolean => true;
const inWatch = (context: ShellContext): boolean => context.mode === 'watch';
const inWatchRoot = (context: ShellContext): boolean => inWatch(context) && context.watchAtRoot;
const inReview = (context: ShellContext): boolean => context.mode === 'review';
const inNestedReview = (context: ShellContext): boolean =>
  inReview(context) && !context.reviewAtRoot;
const inReviewRoot = (context: ShellContext): boolean => inReview(context) && context.reviewAtRoot;

/**
 * Stable product-level command definitions. Screen-local reader commands stay
 * in the review keymap; only commands belonging to the shared shell live here.
 */
export const SHELL_COMMANDS: readonly ShellCommandDefinition[] = [
  {
    id: 'open-review',
    gestures: ['v'],
    label: 'Review This Branch',
    shortLabel: 'Review',
    helpLabel: 'Review the selected branch',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 0,
    required: true,
    menuGroup: 'review',
    visible: inWatch,
    enabled: (context) => inWatch(context) && context.reviewable,
  },
  {
    id: 'review-back',
    gestures: ['q'],
    label: 'Back One Review Level',
    shortLabel: 'Back',
    helpLabel: 'Go back one level in Review',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 0,
    required: true,
    menuGroup: 'review',
    visible: inNestedReview,
    enabled: inNestedReview,
  },
  {
    id: 'back-to-watch',
    gestures: ['q'],
    label: 'Back to Watch',
    shortLabel: 'Watch',
    helpLabel: 'Return to Watch',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 0,
    required: true,
    menuGroup: 'review',
    visible: inReviewRoot,
    enabled: inReviewRoot,
  },
  {
    id: 'story-lens',
    gestures: [],
    label: 'Review Story',
    shortLabel: 'Story',
    helpLabel: 'Switch to the current Story lens',
    placements: ['help', 'menu', 'palette'],
    priority: 2,
    menuGroup: 'review',
    visible: inReview,
    enabled: (context) =>
      inReview(context) && context.storyViewable && context.reviewLens !== 'story',
  },
  {
    id: 'captured-checkpoint-lens',
    gestures: [],
    label: 'Review Captured Checkpoints',
    shortLabel: 'Checkpoints',
    helpLabel: 'Switch to the deterministic captured-checkpoint lens',
    placements: ['help', 'menu', 'palette'],
    priority: 2,
    menuGroup: 'review',
    visible: inReview,
    enabled: (context) => inReview(context) && context.reviewLens !== 'deterministic',
  },
  {
    id: 'theme',
    gestures: ['t'],
    label: 'Choose Theme',
    shortLabel: 'Theme',
    helpLabel: 'Preview and choose a theme',
    placements: ['help', 'menu', 'palette'],
    priority: 4,
    menuGroup: 'view',
    visible: always,
    enabled: always,
  },
  {
    id: 'help',
    gestures: ['?'],
    label: 'Help',
    shortLabel: 'Help',
    helpLabel: 'Open the contextual command guide',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 0,
    required: true,
    menuGroup: 'help',
    visible: always,
    enabled: always,
  },
  {
    id: 'next-pane',
    gestures: ['⇥'],
    keyLabel: 'Tab',
    label: 'Next Pane',
    shortLabel: 'Pane',
    helpLabel: 'Move focus to the next pane',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 0,
    required: true,
    menuGroup: 'view',
    // Review owns a screen-specific Tab binding because several reader screens
    // have only one pane. Its live keymap advertises Tab only where it is true.
    visible: inWatch,
    enabled: inWatch,
  },
  {
    id: 'open-menu',
    gestures: ['F10'],
    label: 'Open application menus',
    shortLabel: 'Menus',
    helpLabel: 'Open application menus',
    placements: ['help', 'palette'],
    priority: 5,
    visible: always,
    enabled: always,
  },
  {
    id: 'quit',
    gestures: ['q'],
    label: 'Quit',
    shortLabel: 'Quit',
    helpLabel: 'Quit Orcaops Watch',
    placements: ['help', 'footer', 'menu', 'palette'],
    priority: 0,
    required: true,
    menuGroup: 'application',
    visible: inWatchRoot,
    enabled: inWatchRoot,
  },
];

export const SHELL_MENU_GROUPS: readonly Readonly<{
  id: ShellMenuGroup;
  label: string;
}>[] = [
  { id: 'application', label: 'Orcaops' },
  { id: 'review', label: 'Review' },
  { id: 'view', label: 'View' },
  { id: 'help', label: 'Help' },
];

const definitionById = new Map(SHELL_COMMANDS.map((command) => [command.id, command]));

/** Resolve one command without hiding it, useful for dispatch and disabled styling. */
export function resolveShellCommand(
  id: ShellCommandId,
  context: ShellContext
): ShellCommandPresentation {
  const definition = definitionById.get(id);
  // The public id union and catalog are intentionally exhaustive. Keeping this
  // guard makes accidental catalog drift fail loudly at runtime as well.
  if (definition === undefined) throw new Error(`Unknown shell command: ${id}`);
  return {
    id: definition.id,
    gestures: definition.gestures,
    label: definition.label,
    shortLabel: definition.shortLabel,
    helpLabel: definition.helpLabel,
    placements: definition.placements,
    keyLabel: definition.keyLabel ?? definition.gestures[0] ?? null,
    priority: definition.priority,
    required: definition.required ?? false,
    menuGroup: definition.menuGroup,
    visible: definition.visible(context),
    enabled: definition.enabled(context),
  };
}

/** Every command visible in the current shell, in stable catalog order. */
export function selectVisibleShellCommands(context: ShellContext): ShellCommandPresentation[] {
  return SHELL_COMMANDS.map((command) => resolveShellCommand(command.id, context)).filter(
    (command) => command.visible
  );
}

/** Resolve terminal input through the same contextual registry used by shell chrome. */
export function resolveShellCommandForKey(
  context: ShellContext,
  key: KeyGestureLike
): ShellCommandPresentation | null {
  const gesture = normalizeCommandGesture(key);
  return (
    selectVisibleShellCommands(context).find((command) => command.gestures.includes(gesture)) ??
    null
  );
}

/** Grouped menu model; empty groups are omitted. */
export function selectShellMenuSections(context: ShellContext): ShellMenuSection[] {
  const visible = selectVisibleShellCommands(context).filter(
    (command) => command.menuGroup !== undefined && hasPlacement(command, 'menu')
  );
  return SHELL_MENU_GROUPS.map((group) => ({
    ...group,
    commands: visible.filter((command) => command.menuGroup === group.id),
  })).filter((group) => group.commands.length > 0);
}

/** Help shows every visible shell command, including disabled discoverable actions. */
export function selectShellHelpCommands(context: ShellContext): ShellCommandPresentation[] {
  return selectVisibleShellCommands(context).filter((command) => hasPlacement(command, 'help'));
}

/** Footer commands are the compact subset selected by the same catalog. */
export function selectShellFooterCommands(context: ShellContext): ShellCommandPresentation[] {
  return selectVisibleShellCommands(context).filter((command) => hasPlacement(command, 'footer'));
}
