import { useCockpitTheme } from '../ThemeProvider';
import { useHit } from '../kit';
import { fitActionRow } from '../responsiveLayout';
import { selectShellFooterCommands, type ShellCommandPresentation } from '../shellCommands';
import {
  selectWatchCommands,
  type WatchCommandPresentation,
  type WatchDetailMode,
  type WatchPane,
} from '../watchCommands';

interface FooterHint {
  id: string;
  key: string;
  label: string;
  enabled: boolean;
}

interface FooterHintDefinition extends FooterHint {
  fullLabel: string;
  shortLabel: string;
  required: boolean;
  priority: number;
}

const HINT_SEPARATOR_WIDTH = 3;
const OUTER_PADDING_WIDTH = 2;
const CONTEXT_GAP_WIDTH = 1;

export interface KeyHintsLayout {
  hints: readonly FooterHint[];
  context: string;
  /** Exact terminal-cell budget used by this presentation, including padding and one gap. */
  occupiedWidth: number;
}

function FooterHintTarget({
  hint,
  notify,
  onCommand,
}: {
  hint: FooterHint;
  notify: boolean;
  onCommand?: (id: string) => void;
}) {
  const { BRIGHT, DIMMER, FAINT, LIVE, SEL_BG } = useCockpitTheme();
  const enabled = hint.enabled && onCommand !== undefined;
  const hit = useHit({
    hitId: `watch-footer:${hint.id}`,
    enabled,
    onSelect: enabled ? () => onCommand(hint.id) : undefined,
  });
  return (
    <box
      flexDirection="row"
      backgroundColor={hit.hovered ? SEL_BG : undefined}
      onMouseOver={enabled ? hit.onMouseOver : undefined}
      onMouseOut={enabled ? hit.onMouseOut : undefined}
      onMouseDown={enabled ? hit.onMouseDown : undefined}
      onMouseUp={enabled ? hit.onMouseUp : undefined}
    >
      <text fg={hint.enabled ? BRIGHT : FAINT}>{hint.key}</text>
      <text
        fg={
          hint.enabled
            ? hint.id === 'watch.toggle-notifications' && notify
              ? LIVE
              : DIMMER
            : FAINT
        }
      >
        {` ${hint.label}`}
      </text>
    </box>
  );
}

function textWidth(value: string): number {
  // All footer copy is deliberately single-cell terminal text. Array.from keeps
  // this correct if a key label uses a non-BMP symbol in the future.
  return Array.from(value).length;
}

function hintWidth(hint: FooterHint): number {
  return textWidth(hint.key) + 1 + textWidth(hint.label);
}

function hintsWidth(hints: readonly FooterHint[]): number {
  if (hints.length === 0) return 0;
  return (
    hints.reduce((total, hint) => total + hintWidth(hint), 0) +
    (hints.length - 1) * HINT_SEPARATOR_WIDTH
  );
}

function rootBasename(root: string): string {
  const normalized = root.replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() ?? root;
}

function truncateEnd(value: string, width: number): string {
  if (textWidth(value) <= width) return value;
  if (width <= 1) return '…'.slice(0, Math.max(0, width));
  return `${Array.from(value)
    .slice(0, width - 1)
    .join('')}…`;
}

function contextLabel(
  root: string,
  projectCount: number,
  width: number,
  availableWidth: number
): string {
  const full = `${root} · ${projectCount} projects`;
  // At the minimum supported width, retaining the repo name and project count
  // is more useful than spending cells on path and unit detail.
  const compact = `${rootBasename(root)} · ${projectCount}p`;
  const preferred = width < 96 ? compact : full;
  const maxWidth = Math.max(1, Math.min(availableWidth, Math.floor(width * 0.3)));
  if (textWidth(preferred) <= maxWidth) return preferred;

  const suffix = ` · ${projectCount}p`;
  if (maxWidth <= textWidth(suffix)) return truncateEnd(compact, maxWidth);
  const basenameWidth = maxWidth - textWidth(suffix);
  return `${truncateEnd(rootBasename(root), basenameWidth)}${suffix}`;
}

function shellHint(command: ShellCommandPresentation): FooterHintDefinition {
  const required = command.required;
  return {
    id: command.id,
    key: command.keyLabel ?? 'menu',
    label: command.shortLabel.toLowerCase(),
    fullLabel: required ? command.shortLabel.toLowerCase() : command.label.toLowerCase(),
    shortLabel: command.shortLabel.toLowerCase(),
    enabled: command.enabled,
    required,
    priority: command.priority,
  };
}

function watchFooterKey(command: WatchCommandPresentation): string {
  if (command.id === 'watch.move') return '↑↓';
  if (command.id === 'watch.open-detail') return '↵';
  if (command.id === 'watch.back-detail') return 'q';
  return command.gestures.join('/');
}

function watchHint(command: WatchCommandPresentation, notify: boolean): FooterHintDefinition {
  const stateSuffix = command.id === 'watch.toggle-notifications' && notify ? ' on' : '';
  const fullLabel = command.required ? command.shortLabel : command.label.toLowerCase();
  return {
    id: command.id,
    key: watchFooterKey(command),
    label: `${command.shortLabel}${stateSuffix}`,
    fullLabel: `${fullLabel}${stateSuffix}`,
    shortLabel: `${command.shortLabel}${stateSuffix}`,
    enabled: command.enabled,
    required: command.required,
    priority: command.priority,
  };
}

/** Width-aware footer presentation. Exported so the three width contracts stay deterministic. */
export function selectKeyHintsLayout({
  width,
  notify,
  root,
  projectCount,
  reviewable,
  pane = 'rail',
  detailMode = 'overview',
}: {
  width: number;
  notify: boolean;
  root: string;
  projectCount: number;
  reviewable: boolean;
  pane?: WatchPane;
  detailMode?: WatchDetailMode;
}): KeyHintsLayout {
  const definitions: FooterHintDefinition[] = [
    ...selectWatchCommands({ connected: true, pane, detailMode }, 'footer').map((command) =>
      watchHint(command, notify)
    ),
    ...selectShellFooterCommands({
      mode: 'watch',
      reviewable,
      watchAtRoot: pane === 'rail',
      reviewAtRoot: true,
      storyAvailable: false,
      storyViewable: false,
      reviewLens: 'deterministic',
    }).map(shellHint),
  ];
  const requiredHints = definitions
    .filter((definition) => definition.required)
    .map((definition) => ({ ...definition, label: definition.shortLabel }));
  const availableContextWidth =
    width - OUTER_PADDING_WIDTH - CONTEXT_GAP_WIDTH - hintsWidth(requiredHints);
  const context = contextLabel(root, projectCount, width, availableContextWidth);
  const row = fitActionRow(
    definitions.map((definition) => ({
      id: definition.id,
      fullLabel: definition.fullLabel,
      shortLabel: definition.shortLabel,
      fixedWidth: textWidth(definition.key) + 1,
      priority: definition.priority,
      required: definition.required,
    })),
    Math.max(0, width - OUTER_PADDING_WIDTH - CONTEXT_GAP_WIDTH - textWidth(context)),
    HINT_SEPARATOR_WIDTH
  );
  const hints = row.items.map((item) => {
    const definition = definitions.find((candidate) => candidate.id === item.id)!;
    return {
      id: definition.id,
      key: definition.key,
      label: item.label,
      enabled: definition.enabled,
    };
  });
  return {
    hints,
    context,
    occupiedWidth: OUTER_PADDING_WIDTH + row.occupiedWidth + CONTEXT_GAP_WIDTH + textWidth(context),
  };
}

/** The bottom key-hint bar (dot-separated) + data-root/projects on the right. */
export function KeyHints({
  width,
  notify,
  root,
  projectCount,
  reviewable,
  pane,
  detailMode,
  onCommand,
}: {
  width: number;
  notify: boolean;
  root: string;
  projectCount: number;
  reviewable: boolean;
  pane: WatchPane;
  detailMode: WatchDetailMode;
  onCommand?: (id: string) => void;
}) {
  const { DIMMER, FAINT } = useCockpitTheme();
  const layout = selectKeyHintsLayout({
    width,
    notify,
    root,
    projectCount,
    reviewable,
    pane,
    detailMode,
  });
  return (
    <box width={width} flexDirection="row" paddingLeft={1} paddingRight={1}>
      {layout.hints.map(({ id, key, label, enabled }, i) => (
        <box key={id} flexDirection="row">
          {i > 0 ? <text fg={FAINT}>{' · '}</text> : null}
          <FooterHintTarget
            hint={{ id, key, label, enabled }}
            notify={notify}
            onCommand={onCommand}
          />
        </box>
      ))}
      <box flexGrow={1} />
      <text fg={DIMMER}>{layout.context}</text>
    </box>
  );
}
