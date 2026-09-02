import type { ReactNode } from 'react';

import type { AgentState } from '../../data/types';
import { useCockpitTheme } from '../ThemeProvider';
import { progressBar } from '../layout';
import { SPACE, UI_GLYPH } from '../theme';
import { useHit } from './hit';

export type PresentationTone =
  | 'neutral'
  | 'muted'
  | 'accent'
  | 'attention'
  | 'positive'
  | 'info'
  | 'danger';

function useToneColor(tone: PresentationTone): string {
  const theme = useCockpitTheme();
  switch (tone) {
    case 'muted':
      return theme.DIMMER;
    case 'accent':
      return theme.ACCENT;
    case 'attention':
      return theme.AMBER;
    case 'positive':
      return theme.LIVE;
    case 'info':
      return theme.BLUE;
    case 'danger':
      return theme.RED;
    case 'neutral':
      return theme.BRIGHT;
  }
}

export function Section({
  id,
  title,
  right,
  variant = 'bullet',
  tone = 'accent',
  focused = false,
}: {
  id: string;
  title: ReactNode;
  right?: ReactNode;
  variant?: 'bullet' | 'cap' | 'band';
  tone?: PresentationTone;
  focused?: boolean;
}) {
  const { BRIGHT, DIMMER, FOCUS_BG, FOCUS_MARKER } = useCockpitTheme();
  const toneColor = useToneColor(tone);
  const cap = variant === 'cap';
  const marker = cap ? (focused ? UI_GLYPH.paneFocused : UI_GLYPH.inactive) : UI_GLYPH.section;
  return (
    <box
      id={id}
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingLeft={cap ? SPACE.xs : 0}
      paddingRight={cap ? SPACE.xs : 0}
      backgroundColor={variant === 'band' ? FOCUS_BG : undefined}
    >
      <text fg={cap && focused ? FOCUS_MARKER : cap ? DIMMER : toneColor}>{`${marker} `}</text>
      <text fg={cap ? (focused ? BRIGHT : DIMMER) : toneColor}>{title}</text>
      {right === undefined ? null : (
        <>
          <box flexGrow={1} />
          <text fg={DIMMER}>{right}</text>
        </>
      )}
    </box>
  );
}

export function Panel({
  id,
  children,
  variant = 'framed',
  focused = false,
  width,
  height,
  flexGrow,
  flexShrink,
  flexDirection = 'column',
}: {
  id: string;
  children: ReactNode;
  variant?: 'framed' | 'band' | 'bare';
  focused?: boolean;
  width?: number;
  height?: number;
  flexGrow?: number;
  flexShrink?: number;
  flexDirection?: 'row' | 'column';
}) {
  const { FOCUS_BG, FOCUS_MARKER, FRAME, PANEL_BG } = useCockpitTheme();
  return (
    <box
      id={id}
      width={width}
      height={height}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      flexDirection={flexDirection}
      border={variant === 'framed'}
      borderColor={focused ? FOCUS_MARKER : FRAME}
      backgroundColor={variant === 'band' && focused ? FOCUS_BG : PANEL_BG}
    >
      {children}
    </box>
  );
}

export type RowTone = 'default' | 'stalled' | 'ready';

export function Row({
  id,
  children,
  height = 1,
  selected = false,
  focused = false,
  hovered = false,
  tone = 'default',
  marker,
  markerColor,
  markerBackground,
  onHoverStart,
  onHoverEnd,
  onActivate,
  onDoubleActivate,
}: {
  id: string;
  children: ReactNode;
  height?: number;
  selected?: boolean;
  focused?: boolean;
  hovered?: boolean;
  tone?: RowTone;
  marker?: ReactNode;
  markerColor?: string;
  markerBackground?: string;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  onActivate?: () => void;
  onDoubleActivate?: () => void;
}) {
  const { DIMMER, FOCUS_BG, FOCUS_MARKER, READY_BG, SEL_BG, STALLED_BG } = useCockpitTheme();
  const interactive =
    onActivate !== undefined || onDoubleActivate !== undefined || onHoverStart !== undefined;
  const hit = useHit({
    hitId: id,
    enabled: interactive,
    onSelect: onActivate,
    onDoubleActivate,
    onHoverStart,
    onHoverEnd,
  });
  const selectedBackground =
    tone === 'stalled' ? STALLED_BG : tone === 'ready' ? READY_BG : FOCUS_BG;
  const selectionMarker = focused ? UI_GLYPH.paneFocused : UI_GLYPH.paneBlurred;
  return (
    <box
      id={id}
      flexDirection="row"
      height={height}
      flexShrink={0}
      backgroundColor={selected ? selectedBackground : hovered || hit.hovered ? SEL_BG : undefined}
      onMouseOver={interactive ? hit.onMouseOver : undefined}
      onMouseOut={interactive ? hit.onMouseOut : undefined}
      onMouseDown={interactive ? hit.onMouseDown : undefined}
      onMouseUp={interactive ? hit.onMouseUp : undefined}
    >
      <box width={1} height={height} flexShrink={0} backgroundColor={markerBackground}>
        <text fg={markerColor ?? (selected && focused ? FOCUS_MARKER : DIMMER)}>
          {selected ? selectionMarker : (marker ?? ' ')}
        </text>
      </box>
      {children}
    </box>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: PresentationTone;
}) {
  const color = useToneColor(tone);
  return <text fg={color}>{children}</text>;
}

export function StatPill({
  id,
  label,
  value,
  glyph,
  tone = 'neutral',
  selected = false,
  hovered = false,
  onActivate,
  onDoubleActivate,
}: {
  id: string;
  label: string;
  value?: string | number;
  glyph?: string;
  tone?: PresentationTone;
  selected?: boolean;
  hovered?: boolean;
  onActivate?: () => void;
  onDoubleActivate?: () => void;
}) {
  const { ACCENT, BRIGHT, DIM, DIMMER, FOCUS_BG, SEL_BG } = useCockpitTheme();
  const toneColor = useToneColor(tone);
  const interactive = onActivate !== undefined || onDoubleActivate !== undefined;
  const hit = useHit({
    hitId: id,
    enabled: interactive,
    onSelect: onActivate,
    onDoubleActivate,
  });
  return (
    <box
      id={id}
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingLeft={SPACE.xs}
      paddingRight={SPACE.xs}
      backgroundColor={selected ? FOCUS_BG : hovered || hit.hovered ? SEL_BG : undefined}
      onMouseOver={interactive ? hit.onMouseOver : undefined}
      onMouseOut={interactive ? hit.onMouseOut : undefined}
      onMouseDown={interactive ? hit.onMouseDown : undefined}
      onMouseUp={interactive ? hit.onMouseUp : undefined}
    >
      {glyph === undefined || glyph.length === 0 ? null : <text fg={toneColor}>{`${glyph} `}</text>}
      <text fg={selected ? BRIGHT : DIM}>{label}</text>
      {value === undefined ? null : <text fg={selected ? ACCENT : DIMMER}>{` ${value}`}</text>}
    </box>
  );
}

export function MeterBar({
  completed,
  total,
  width,
  state,
}: {
  completed: number;
  total: number;
  width: number;
  state?: AgentState;
}) {
  const { COLOR, DIM, FAINT, LIVE } = useCockpitTheme();
  const bar = progressBar(completed, total, width);
  const color = state === undefined ? LIVE : COLOR[state];
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={completed > 0 ? color : FAINT}>{bar.done}</text>
      <text fg={FAINT}>{bar.todo}</text>
      <text fg={DIM}>{` ${bar.label}`}</text>
    </box>
  );
}

export function Rule({ width, color }: { width: number; color?: string }) {
  const { FRAME } = useCockpitTheme();
  const safeWidth = Math.max(0, width);
  return (
    <text width={safeWidth} height={1} flexShrink={0} fg={color ?? FRAME}>
      {'─'.repeat(safeWidth)}
    </text>
  );
}
