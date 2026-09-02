import {
  type CommandPlacement,
  type CommandPresentation,
  executableHelpInvocation,
  hasPlacement,
} from '../commandRegistry';
import { fitActionRow } from '../responsiveLayout';

/**
 * The keymap shared by dispatch, help, and footer rendering.
 *
 * It is the product's PROMISE to the reviewer: these keys, on this screen —
 * enforced by `keymapEnumeration.render.test.tsx`, which asserts that every
 * advertised key is dispatched where it is advertised:
 *
 *  · The paging and file-jump keys are NOT global. They move the diff column's
 *    scroll coordinator, so on Brief, Comments, Finish and Flat Files — which
 *    have no such column — they would do nothing. They belong to the screens
 *    that actually scroll.
 *
 *  · `V` is not advertised on Unassigned, where the overlay palette does not
 *    render, and neither is `c`, which the floor dispatcher never sends.
 */

export type StoryReviewScreen =
  | 'brief'
  | 'walk'
  | 'unassigned'
  | 'comments'
  | 'captured-context'
  | 'finish'
  | 'flat-files'
  | 'floor-diff';
export type StoryReviewFocus = 'rail' | 'diff';
export type StoryReviewLens = 'deterministic' | 'story';
export type ReviewCommandId = `review.${string}`;

export interface ReviewNavigationContext {
  /** Whether no local Back step remains and q will return to Watch. */
  atRoot: boolean;
}

export interface KeyBinding {
  id: ReviewCommandId;
  keys: string[];
  label: string;
  /** Plain-language task description used by contextual Help. */
  helpLabel?: string;
  /** Compact fixed-row spelling; Help continues to use `helpLabel`. */
  shortLabel?: string;
  /** Lower values survive fixed-row pressure first. */
  priority?: number;
  /** Required footer actions are admitted before all optional actions. */
  required?: boolean;
  footer?: boolean;
}

export interface HelpSection {
  title: string;
  rows: {
    commandId?: string;
    commandGesture?: string;
    executable?: boolean;
    keys: string[];
    label: string;
  }[];
}

/**
 * Scroll and paging — for the screens that HAVE a scroll column.
 *
 * These are not global: they act on the diff column's scroll coordinator, and a
 * screen without one is a screen where all of them are no-ops.
 */
const SCROLL_KEYS: readonly KeyBinding[] = [
  {
    id: 'review.diff.recenter',
    keys: ['C-l'],
    label: 'center cursor',
    helpLabel: 'Center the current hunk or row in the diff viewport',
    footer: true,
  },
  { id: 'review.diff.half-page-up', keys: ['u', 'C-u'], label: 'half-page up' },
  { id: 'review.diff.half-page-down', keys: ['D', 'C-d'], label: 'half-page down' },
  { id: 'review.diff.page-up', keys: ['b', 'pgup'], label: 'page up' },
  { id: 'review.diff.page-down', keys: ['space', 'f', 'pgdn'], label: 'page down' },
  { id: 'review.diff.scroll-edge', keys: ['g', 'G'], label: 'top/bottom' },
];

/** The diff column's file jumps — only where there are files to jump between. */
const FILE_KEYS: readonly KeyBinding[] = [
  { id: 'review.diff.move-file', keys: [',', '.'], label: 'prev/next file' },
];

/** Row-level view toggles, threaded into the measured geometry. */
const VIEW_KEYS: readonly KeyBinding[] = [
  { id: 'review.diff.line-numbers', keys: ['l'], label: 'line numbers' },
  { id: 'review.diff.wrap-lines', keys: ['w'], label: 'wrap lines' },
  { id: 'review.diff.hunk-headers', keys: ['M'], label: 'hunk headers' },
];

/** Full-context controls shared by every canonical diff page. */
const CANONICAL_VIEW_KEYS: readonly KeyBinding[] = [
  {
    id: 'review.files.filter',
    keys: ['/'],
    label: 'filter files',
    helpLabel: 'Filter navigator destinations without hiding diff cards',
    footer: true,
  },
  { id: 'review.diff.layout', keys: ['1', '2', '0'], label: 'split/stack/auto' },
  { id: 'review.diff.file-navigator', keys: ['\\'], label: 'collapse/expand files' },
  { id: 'review.diff.pan-code', keys: ['S-←', 'S-→'], label: 'pan code' },
];

/** Ownership context exists on checkpoint pages; Unassigned owns its own units. */
const OWNER_VIEW_KEYS: readonly KeyBinding[] = [
  { id: 'review.floor.show-owners', keys: ['i'], label: 'show owners' },
];

export const STORY_REVIEW_KEYMAP: Readonly<Record<StoryReviewScreen, readonly KeyBinding[]>> = {
  brief: [
    {
      id: 'review.brief.focus-pane',
      keys: ['⇥'],
      label: 'overview/checkpoints',
      helpLabel: 'Switch focus between the orientation pane and the review tree',
      footer: true,
    },
    {
      // `←`/`→` NAME a pane rather than toggling between them, so the arrow a
      // reviewer reaches for is the one that means something. They are a
      // separate command from `⇥` because the footer chip's label names the
      // pane its keys move TO — true of `⇥`, and untrue of one arrow in any
      // pair. Walk already splits `←` out of its own pane toggle for the same
      // reason.
      id: 'review.brief.side-pane',
      keys: ['←', '→'],
      label: 'overview/tree pane',
      helpLabel: 'Focus the overview (←) or the review tree (→)',
    },
    { id: 'review.brief.move', keys: ['j', 'k', '↑', '↓'], label: 'move', footer: true },
    // `↵` alone: `→` names the tree pane, so it is not also an open. With both
    // arrows spoken for, `⇥` would be the only way back out of the pane `n`/`N`
    // moves focus to.
    { id: 'review.brief.open', keys: ['↵'], label: 'open', footer: true },
    {
      id: 'review.brief.attention',
      keys: ['n', 'N'],
      label: 'attention',
      helpLabel: 'Select the next/previous attention item; Enter opens it',
      footer: true,
    },
    {
      id: 'review.walk.disposition',
      keys: ['a', 'r', 'd', 'o'],
      label: 'disposition',
      helpLabel: 'Change the selected Attention item’s review state',
    },
  ],
  walk: [
    {
      id: 'review.walk.move',
      keys: ['j', 'k', '↑', '↓'],
      label: 'move at current grain',
      helpLabel: 'Move through the focused rail or diff level',
      footer: true,
    },
    {
      id: 'review.walk.page',
      keys: ['[', ']'],
      label: 'previous/next page',
      helpLabel: 'Open the previous or next Part',
      footer: true,
    },
    {
      id: 'review.walk.unvisited',
      keys: [';n', ';p'],
      label: 'previous/next unvisited',
      helpLabel: 'Jump between unread Parts',
      footer: true,
    },
    {
      id: 'review.walk.attention',
      keys: ['n', 'N'],
      label: 'attention',
      helpLabel: 'Jump between items needing attention',
    },
    {
      id: 'review.walk.focus-pane',
      keys: ['⇥'],
      label: 'rail/diff',
      helpLabel: 'Switch focus between context and code',
      footer: true,
    },
    {
      id: 'review.walk.left-pane',
      keys: ['←'],
      label: 'context pane',
      helpLabel: 'Move focus left to review context',
    },
    {
      id: 'review.walk.open',
      keys: ['↵', '→'],
      label: 'open item / enter rows',
      helpLabel: 'Open the selected item or enter code rows',
    },
    {
      id: 'review.walk.related-location',
      keys: ['(', ')'],
      label: 'related location',
      helpLabel: 'Move between related code locations',
      footer: true,
    },
    {
      id: 'review.diff.comment',
      keys: ['c'],
      label: 'comment',
      helpLabel: 'Comment on the selected code or item',
    },
    {
      id: 'review.walk.disposition',
      keys: ['a', 'r', 'd', 'o'],
      label: 'disposition',
      helpLabel: 'Change the selected item’s review state',
    },
    {
      id: 'review.diff.mark-reviewed',
      keys: ['m'],
      label: 'mark reviewed',
      helpLabel: 'Mark this Part reviewed',
      footer: true,
    },
    {
      id: 'review.diff.select-span',
      keys: ['v'],
      label: 'select span',
      helpLabel: 'Start or clear a code-row selection',
    },
    {
      id: 'review.diff.copy-selection',
      keys: ['Y'],
      label: 'copy selection',
      helpLabel: 'Copy the selected code rows',
    },
    {
      id: 'review.diff.move-pin',
      keys: ['{', '}'],
      label: 'prev/next pin',
      helpLabel: 'Jump between comment pins',
    },
    {
      id: 'review.diff.expand-hidden',
      keys: ['z', 'Z'],
      label: 'expand hidden / whole file',
      helpLabel: 'Show hidden context or the whole file',
    },
    {
      id: 'review.diff.open-editor',
      keys: ['e'],
      label: '$EDITOR',
      helpLabel: 'Open the selected file in $EDITOR',
    },
    ...SCROLL_KEYS,
    ...FILE_KEYS,
    ...VIEW_KEYS,
    ...CANONICAL_VIEW_KEYS,
  ],
  unassigned: [
    {
      id: 'review.unassigned.move',
      keys: ['j', 'k', '↑', '↓'],
      label: 'move slice / row',
      footer: true,
    },
    { id: 'review.unassigned.open', keys: ['↵', '→'], label: 'enter rows', footer: true },
    { id: 'review.diff.comment', keys: ['c'], label: 'comment' },
    { id: 'review.unassigned.mark-inspected', keys: ['m'], label: 'mark inspected', footer: true },
    { id: 'review.diff.select-span', keys: ['v'], label: 'select span' },
    { id: 'review.diff.copy-selection', keys: ['Y'], label: 'copy selection' },
    { id: 'review.diff.move-pin', keys: ['{', '}'], label: 'prev/next pin' },
    { id: 'review.diff.expand-hidden', keys: ['z', 'Z'], label: 'expand hidden / whole file' },
    { id: 'review.diff.open-editor', keys: ['e'], label: '$EDITOR' },
    ...SCROLL_KEYS,
    ...FILE_KEYS,
    ...VIEW_KEYS,
    ...CANONICAL_VIEW_KEYS,
  ],
  comments: [
    { id: 'review.comments.move', keys: ['j', 'k', '↑', '↓'], label: 'move', footer: true },
    { id: 'review.comments.open', keys: ['↵'], label: 'open anchor', footer: true },
    { id: 'review.comments.reply', keys: ['y'], label: 'reply' },
    { id: 'review.comments.resolve', keys: ['x'], label: 'resolve' },
  ],
  'captured-context': [
    {
      id: 'review.walk.disposition',
      keys: ['a', 'r', 'd', 'o'],
      label: 'disposition',
      helpLabel: 'Change the captured item’s review state',
    },
  ],
  finish: [
    {
      id: 'review.finish.move',
      keys: ['j', 'k', '↑', '↓'],
      label: 'move obligation',
      footer: true,
    },
    { id: 'review.finish.complete', keys: ['↵'], label: 'finish complete', footer: true },
    { id: 'review.finish.partial', keys: ['p'], label: 'finish partial', footer: true },
    { id: 'review.finish.reopen', keys: ['r'], label: 'reopen review', footer: true },
  ],
  'flat-files': [
    { id: 'review.files.move', keys: ['j', 'k', '↑', '↓'], label: 'move', footer: true },
    { id: 'review.files.open', keys: ['↵', '→'], label: 'open', footer: true },
    { id: 'review.files.filter', keys: ['/'], label: 'filter files', footer: true },
    { id: 'review.files.toggle', keys: ['F'], label: 'back', footer: true },
  ],
  'floor-diff': [
    {
      id: 'review.floor.move',
      keys: ['j', 'k', '↑', '↓'],
      label: 'move slice / row / captured item',
      helpLabel: 'Move through checkpoint context or code rows',
      footer: true,
    },
    {
      id: 'review.floor.page',
      keys: ['[', ']'],
      label: 'previous/next checkpoint',
      helpLabel: 'Open the previous or next checkpoint',
      footer: true,
    },
    {
      id: 'review.floor.focus-pane',
      keys: ['⇥'],
      label: 'captured trail/diff',
      helpLabel: 'Switch focus between checkpoint context and code',
      footer: true,
    },
    {
      id: 'review.floor.left-pane',
      keys: ['←'],
      label: 'context pane',
      helpLabel: 'Move focus left to review context',
    },
    {
      id: 'review.floor.open',
      keys: ['↵', '→'],
      label: 'enter rows',
      helpLabel: 'Enter the selected code rows',
      footer: true,
    },
    {
      id: 'review.diff.select-span',
      keys: ['v'],
      label: 'select span',
      helpLabel: 'Start or clear a code-row selection',
    },
    {
      id: 'review.diff.copy-selection',
      keys: ['Y'],
      label: 'copy selection',
      helpLabel: 'Copy the selected code rows',
    },
    {
      id: 'review.diff.comment',
      keys: ['c'],
      label: 'comment',
      helpLabel: 'Comment on the selected code',
    },
    {
      id: 'review.floor.disposition',
      keys: ['a', 'r', 'd', 'o'],
      label: 'captured-item disposition',
      helpLabel: 'Change a captured item’s review state',
    },
    {
      id: 'review.floor.acknowledge-all',
      keys: ['A'],
      label: 'ack all open uncertainties',
      helpLabel: 'Acknowledge every open uncertainty with a reason',
    },
    {
      id: 'review.floor.thread-disposition',
      keys: ['s', 'p'],
      label: 'skip / partial with reason',
      helpLabel: 'Skip or partially review this checkpoint with a reason',
    },
    {
      id: 'review.diff.mark-reviewed',
      keys: ['m'],
      label: 'mark reviewed',
      helpLabel: 'Mark this checkpoint reviewed',
      footer: true,
    },
    {
      id: 'review.diff.move-pin',
      keys: ['{', '}'],
      label: 'prev/next pin',
      helpLabel: 'Jump between comment pins',
    },
    {
      id: 'review.diff.expand-hidden',
      keys: ['z', 'Z'],
      label: 'expand hidden / whole file',
      helpLabel: 'Show hidden context or the whole file',
    },
    {
      id: 'review.diff.open-editor',
      keys: ['e'],
      label: '$EDITOR',
      helpLabel: 'Open the selected file in $EDITOR',
    },
    ...SCROLL_KEYS,
    ...FILE_KEYS,
    ...VIEW_KEYS,
    ...CANONICAL_VIEW_KEYS,
    ...OWNER_VIEW_KEYS,
  ],
};

/**
 * Keys that work on EVERY screen.
 *
 * A key belongs here only if it keeps working once the reviewer steps off the
 * diff column; anything else is a promise the product cannot keep.
 */
export const STORY_REVIEW_GLOBAL_KEYS: readonly KeyBinding[] = [
  {
    id: 'review.refresh',
    keys: ['R'],
    label: 'refresh',
    helpLabel: 'Reload the current review data',
  },
  {
    id: 'review.comments.toggle',
    keys: ['C'],
    label: 'comments',
    helpLabel: 'Open all review comments',
  },
  {
    id: 'review.files.toggle',
    keys: ['F'],
    label: 'all files',
    helpLabel: 'Open the complete changed-file list',
  },
  {
    id: 'review.back',
    keys: ['esc'],
    label: 'cancel / back',
    helpLabel: 'Cancel the current mode or go back one level',
    footer: true,
  },
  {
    id: 'review.help',
    keys: ['?'],
    label: 'help',
    helpLabel: 'Open or close this guide',
    footer: true,
  },
  {
    id: 'review.back-or-watch',
    keys: ['q'],
    label: 'back to Watch',
    helpLabel: 'Return to Watch',
    footer: true,
  },
];

interface ReviewFooterMetadata {
  shortLabel: string;
  priority: number;
  required: boolean;
}

/** Final compact labels and fit priorities live beside the registry identities they present. */
const REVIEW_FOOTER_METADATA: Readonly<Partial<Record<ReviewCommandId, ReviewFooterMetadata>>> = {
  // REQUIRED: this chip names the pane the reviewer can get back to, and `n`/`N`
  // move focus on their own; dropping it under width pressure makes the Brief a
  // one-way door on a narrow terminal.
  'review.brief.focus-pane': { shortLabel: 'pane', priority: 2, required: true },
  'review.brief.move': { shortLabel: 'move', priority: 0, required: true },
  'review.brief.open': { shortLabel: 'open', priority: 0, required: true },
  'review.brief.attention': { shortLabel: 'attention', priority: 3, required: false },
  'review.walk.move': { shortLabel: 'move', priority: 0, required: true },
  'review.walk.page': { shortLabel: 'page', priority: 1, required: true },
  'review.walk.unvisited': { shortLabel: 'unvisited', priority: 4, required: false },
  'review.walk.focus-pane': { shortLabel: 'pane', priority: 2, required: false },
  'review.walk.related-location': { shortLabel: 'related', priority: 4, required: false },
  'review.diff.mark-reviewed': { shortLabel: 'reviewed', priority: 1, required: true },
  'review.diff.recenter': { shortLabel: 'center', priority: 5, required: false },
  'review.files.filter': { shortLabel: 'filter', priority: 5, required: false },
  'review.unassigned.move': { shortLabel: 'move', priority: 0, required: true },
  'review.unassigned.open': { shortLabel: 'rows', priority: 0, required: true },
  'review.unassigned.mark-inspected': { shortLabel: 'inspected', priority: 1, required: true },
  'review.comments.move': { shortLabel: 'move', priority: 0, required: true },
  'review.comments.open': { shortLabel: 'anchor', priority: 0, required: true },
  'review.finish.move': { shortLabel: 'move', priority: 0, required: true },
  'review.finish.complete': { shortLabel: 'complete', priority: 0, required: true },
  'review.finish.partial': { shortLabel: 'partial', priority: 0, required: true },
  'review.finish.reopen': { shortLabel: 'reopen', priority: 0, required: true },
  'review.files.move': { shortLabel: 'move', priority: 0, required: true },
  'review.files.open': { shortLabel: 'open', priority: 0, required: true },
  'review.files.toggle': { shortLabel: 'back', priority: 1, required: true },
  'review.floor.move': { shortLabel: 'move', priority: 0, required: true },
  'review.floor.page': { shortLabel: 'page', priority: 1, required: true },
  'review.floor.focus-pane': { shortLabel: 'pane', priority: 2, required: false },
  'review.floor.open': { shortLabel: 'rows', priority: 2, required: false },
  'review.back': { shortLabel: 'back', priority: 0, required: true },
  'review.back-or-watch': { shortLabel: 'Watch', priority: 0, required: true },
  'review.help': { shortLabel: 'help', priority: 0, required: true },
};

export interface ReviewCommandDefinition {
  id: ReviewCommandId;
  label: string;
  shortLabel: string;
  helpLabel: string;
  variants: readonly KeyBinding[];
  placements: readonly ('help' | 'footer' | 'palette')[];
}

const ALL_REVIEW_BINDINGS = [
  ...Object.values(STORY_REVIEW_KEYMAP).flat(),
  ...STORY_REVIEW_GLOBAL_KEYS,
];

/** Unique stable identities; screen/lens variants retain contextual labels and gestures. */
export const REVIEW_COMMANDS: readonly ReviewCommandDefinition[] = [
  ...new Set(ALL_REVIEW_BINDINGS.map((binding) => binding.id)),
].map((id) => {
  const variants = ALL_REVIEW_BINDINGS.filter((binding) => binding.id === id);
  const first = variants[0]!;
  return {
    id,
    label: first.helpLabel ?? first.label,
    shortLabel: first.shortLabel ?? REVIEW_FOOTER_METADATA[id]?.shortLabel ?? first.label,
    helpLabel: first.helpLabel ?? first.label,
    variants,
    placements: [
      'help' as const,
      ...(variants.some((variant) => variant.footer === true) ? (['footer'] as const) : []),
      'palette' as const,
    ],
  };
});

export const REVIEW_COMMAND_IDS: readonly ReviewCommandId[] = REVIEW_COMMANDS.map(
  (command) => command.id
);

export interface ReviewCommandPresentation extends CommandPresentation<ReviewCommandId> {
  priority: number;
  required: boolean;
}

/** Resolve a stable ID in one live screen context; screen copy wins over global copy. */
export function resolveReviewCommand(
  id: ReviewCommandId,
  screen: StoryReviewScreen,
  navigation: ReviewNavigationContext = { atRoot: screen === 'brief' },
  lens: StoryReviewLens = 'story'
): ReviewCommandPresentation {
  const binding =
    STORY_REVIEW_KEYMAP[screen].find((candidate) => candidate.id === id) ??
    STORY_REVIEW_GLOBAL_KEYS.find((candidate) => candidate.id === id);
  const definition = REVIEW_COMMANDS.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`Unknown Review command: ${id}`);
  // The attention queue works on BOTH lenses: the deterministic Brief reads
  // it off the finish obligations. Only the item disposition stays Story-only.
  const storyOnlyBrief = screen === 'brief' && id === 'review.walk.disposition';
  const visible = binding !== undefined && !(lens === 'deterministic' && storyOnlyBrief);
  const contextualBack = id === 'review.back-or-watch' || id === 'review.back';
  const label = contextualBack
    ? navigation.atRoot
      ? 'Back to Watch'
      : id === 'review.back'
        ? 'Cancel Current Mode or Back'
        : 'Back One Review Level'
    : (binding?.helpLabel ?? binding?.label ?? definition.label);
  const shortLabel = contextualBack
    ? navigation.atRoot
      ? 'Watch'
      : 'back'
    : (binding?.shortLabel ??
      REVIEW_FOOTER_METADATA[id]?.shortLabel ??
      binding?.label ??
      definition.shortLabel);
  return {
    id,
    gestures: binding?.keys ?? definition.variants[0]?.keys ?? [],
    label,
    shortLabel,
    helpLabel: label,
    placements: ['help', ...(binding?.footer === true ? (['footer'] as const) : []), 'palette'],
    visible,
    enabled: visible,
    priority: binding?.priority ?? REVIEW_FOOTER_METADATA[id]?.priority ?? 6,
    required: binding?.required ?? REVIEW_FOOTER_METADATA[id]?.required ?? false,
  };
}

/**
 * Commands with no meaning on a READ-ONLY stale Story projection. Suppressed
 * from presentation AND gesture resolution together, so the footer never
 * advertises a guaranteed failure: mark-reviewed/inspected, item dispositions,
 * and the lifecycle actions (which require the deterministic lens).
 */
export const STALE_STORY_SUPPRESSED_COMMANDS: ReadonlySet<ReviewCommandId> = new Set([
  'review.diff.mark-reviewed',
  // The residue page's `m`. It belongs here for the same reason mark-reviewed
  // does — the executor refuses `mark-inspected` on a stale projection, so a
  // footer that advertises it is advertising a guaranteed failure.
  'review.unassigned.mark-inspected',
  'review.walk.disposition',
  'review.finish.complete',
  'review.finish.partial',
  'review.finish.reopen',
]);

export function selectVisibleReviewCommands(
  screen: StoryReviewScreen,
  navigation: ReviewNavigationContext = { atRoot: screen === 'brief' },
  lens: StoryReviewLens = 'story',
  staleStory = false
): ReviewCommandPresentation[] {
  const ids = [
    ...STORY_REVIEW_KEYMAP[screen].map((binding) => binding.id),
    ...STORY_REVIEW_GLOBAL_KEYS.map((binding) => binding.id),
  ];
  return [...new Set(ids)]
    .filter((id) => !staleStory || !STALE_STORY_SUPPRESSED_COMMANDS.has(id))
    .map((id) => resolveReviewCommand(id, screen, navigation, lens))
    .filter((command) => command.visible);
}

export function selectReviewCommands(
  screen: StoryReviewScreen,
  placement: CommandPlacement,
  navigation: ReviewNavigationContext = { atRoot: screen === 'brief' },
  lens: StoryReviewLens = 'story',
  staleStory = false
): ReviewCommandPresentation[] {
  return selectVisibleReviewCommands(screen, navigation, lens, staleStory).filter((command) =>
    hasPlacement(command, placement)
  );
}

export interface ReviewFooterLayout {
  parts: readonly string[];
  droppedIds: readonly string[];
  requiredDroppedIds: readonly string[];
  occupiedWidth: number;
}

/** Fit the live screen's registry projection into one footer row. */
export function selectStoryReviewFooterLayout(
  screen: StoryReviewScreen,
  focus: StoryReviewFocus = 'rail',
  width = Number.MAX_SAFE_INTEGER,
  navigation: ReviewNavigationContext = { atRoot: screen === 'brief' },
  lens: StoryReviewLens = 'story',
  /** What the Brief's tree pane is called under the live lens. */
  briefTreeLabel = 'checkpoints',
  /** Read-only stale Story lens: mutating commands leave the footer entirely. */
  staleStory = false
): ReviewFooterLayout {
  const commands = selectReviewCommands(screen, 'footer', navigation, lens, staleStory);
  const row = fitActionRow(
    commands.map((command) => {
      const binding =
        STORY_REVIEW_KEYMAP[screen].find((candidate) => candidate.id === command.id) ??
        STORY_REVIEW_GLOBAL_KEYS.find((candidate) => candidate.id === command.id);
      // The label names the pane Tab will move TO, so it is per-screen: the
      // Brief's panes are an overview and a tree, not a rail and a diff.
      const paneLabel =
        command.id === 'review.brief.focus-pane'
          ? focus === 'rail'
            ? briefTreeLabel
            : 'overview'
          : command.id === 'review.walk.focus-pane' || command.id === 'review.floor.focus-pane'
            ? focus === 'rail'
              ? 'diff'
              : 'rail'
            : null;
      return {
        id: command.id,
        fullLabel:
          paneLabel ??
          (command.id === 'review.back-or-watch' || command.id === 'review.back'
            ? navigation.atRoot
              ? 'back to Watch'
              : command.id === 'review.back'
                ? 'cancel/back'
                : 'back'
            : (binding?.label ?? command.label)),
        shortLabel: paneLabel ?? command.shortLabel,
        fixedWidth: [...command.gestures.join('/')].length + 1,
        priority: command.priority,
        required: command.required,
      };
    }),
    width,
    3
  );
  return {
    parts: row.items.map((item) => {
      const command = commands.find((candidate) => candidate.id === item.id)!;
      return `${command.gestures.join('/')} ${item.label}`;
    }),
    droppedIds: row.droppedIds,
    requiredDroppedIds: row.requiredDroppedIds,
    occupiedWidth: row.occupiedWidth,
  };
}

const SCREEN_TITLE: Readonly<Record<StoryReviewScreen, string>> = {
  brief: 'Review overview',
  walk: 'Composed Story walkthrough',
  unassigned: 'Unexplained changes',
  comments: 'Review comments',
  'captured-context': 'Captured context',
  finish: 'Finish review',
  'flat-files': 'All changed files',
  'floor-diff': 'Captured checkpoint diff',
};

const SCREEN_ROUTE_LABEL: Readonly<Record<StoryReviewScreen, string>> = {
  brief: 'Overview',
  walk: 'Story',
  unassigned: 'Unexplained',
  comments: 'Comments',
  'captured-context': 'Context',
  finish: 'Finish',
  'flat-files': 'Files',
  'floor-diff': 'Checkpoint diff',
};

export function storyReviewRouteLabel(screen: StoryReviewScreen): string {
  return SCREEN_ROUTE_LABEL[screen];
}

/**
 * Help, for the lens the reviewer is ACTUALLY ON.
 *
 * Only the screens of the ACTIVE lens are listed. Listing both unconditionally
 * shows a reviewer with no Story composed — the default state of every branch —
 * a Walk section full of keys that cannot work, and no Diff section for the
 * screen in front of them. Help that describes a product you are not using is
 * worse than no help: it is the first place a confused reviewer looks.
 */
export function storyReviewHelpContext(
  screen: StoryReviewScreen,
  lens: StoryReviewLens,
  focus: StoryReviewFocus
): string {
  const basis = lens === 'deterministic' ? 'Captured checkpoints' : 'Composed Story';
  const focusLabel = screen === 'walk' || screen === 'floor-diff' ? ` · ${focus} focused` : '';
  return `${basis} · ${SCREEN_TITLE[screen]}${focusLabel}`;
}

export function storyReviewHelpSections(
  screen: StoryReviewScreen,
  lens: StoryReviewLens = 'story',
  navigation: ReviewNavigationContext = { atRoot: screen === 'brief' },
  staleStory = false
): HelpSection[] {
  const rows = (bindings: readonly KeyBinding[]) =>
    bindings.flatMap((binding) => {
      if (staleStory && STALE_STORY_SUPPRESSED_COMMANDS.has(binding.id)) return [];
      const command = resolveReviewCommand(binding.id, screen, navigation, lens);
      if (!command.visible) return [];
      const invocation = executableHelpInvocation(command);
      return {
        commandId: binding.id,
        commandGesture: invocation?.gesture,
        executable: invocation !== null && binding.id !== 'review.help',
        keys: [...command.gestures],
        label: command.helpLabel,
      };
    });
  const pointerRows: HelpSection['rows'] =
    screen === 'walk' || screen === 'floor-diff' || screen === 'unassigned'
      ? [
          { keys: ['Click'], label: 'Select visible files, items, and code rows' },
          { keys: ['Wheel'], label: 'Scroll the focused list or diff' },
          { keys: ['Shift+wheel'], label: 'Pan code left or right' },
        ]
      : [{ keys: ['Click'], label: 'Select visible rows and actions' }];
  const bindings = STORY_REVIEW_KEYMAP[screen];
  const screenCommandIds = new Set(bindings.map((binding) => binding.id));
  const globalBindings = STORY_REVIEW_GLOBAL_KEYS.filter(
    (binding) => !screenCommandIds.has(binding.id)
  );
  const primaryBindings = bindings.filter(
    (binding) => binding.footer === true || binding.keys.includes('c')
  );
  const advancedBindings = bindings.filter((binding) => !primaryBindings.includes(binding));
  return [
    { title: `Here · ${SCREEN_TITLE[screen]}`, rows: rows(primaryBindings) },
    ...(advancedBindings.length === 0
      ? []
      : [{ title: 'More on this screen', rows: rows(advancedBindings) }]),
    { title: 'Mouse', rows: pointerRows },
    { title: 'Anywhere in Review', rows: rows(globalBindings) },
  ];
}
