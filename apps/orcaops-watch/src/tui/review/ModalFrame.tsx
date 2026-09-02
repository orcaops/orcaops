import type { MouseEvent } from '@opentui/core';
import { type ReactNode, useEffect } from 'react';

import { useCockpitTheme } from '../ThemeProvider';
import { useHit, useHitCoordinator } from '../kit';
import { displayLen, truncate } from '../layout';
import { fitActionRow, type ModalGeometry, resolveModalGeometry } from '../responsiveLayout';
import { SPACE } from '../theme';

// Adapted from Hunk's ModalFrame at 2458366 (MIT; see packages/diff-render/LICENSE).
// Orcaops adds responsive terminal bounds, retained-reader backdrops, and shared
// keyboard/pointer actions for Watch and Review.

export interface ModalPalette {
  background: string;
  border: string;
  title: string;
  text: string;
  muted: string;
  accent: string;
  hover: string;
}

export interface ModalAction {
  id: string;
  keyLabel: string;
  label: string;
  shortLabel?: string;
  priority?: number;
  required?: boolean;
  onSelect: () => void;
}

export interface ModalFrameProps {
  id: string;
  backdropId?: string;
  title: string;
  width: number;
  height: number;
  desiredWidth: number;
  desiredHeight: number;
  children: ReactNode | ((geometry: ModalGeometry) => ReactNode);
  onClose?: () => void;
  onMouseScroll?: (event: MouseEvent) => void;
  actions?: readonly ModalAction[];
  palette?: ModalPalette;
  /** Text composers use an opaque plane while retaining the reader beneath it. */
  opaqueBackdrop?: boolean;
}

function ModalHit({
  id,
  onSelect,
  padding = false,
  background,
  hover,
  children,
}: {
  id: string;
  onSelect: () => void;
  padding?: boolean;
  background: string;
  hover: string;
  children: (hovered: boolean) => ReactNode;
}) {
  const hit = useHit({ hitId: id, onSelect });
  return (
    <box
      id={id}
      height={1}
      paddingLeft={padding ? 1 : undefined}
      paddingRight={padding ? 1 : undefined}
      backgroundColor={hit.hovered ? hover : background}
      onMouseOver={hit.onMouseOver}
      onMouseOut={hit.onMouseOut}
      onMouseDown={hit.onMouseDown}
      onMouseUp={hit.onMouseUp}
    >
      {children(hit.hovered)}
    </box>
  );
}

/** Shared, responsive dialog chrome for Help, text input, and theme selection. */
export function ModalFrame({
  id,
  backdropId = `${id}-backdrop`,
  title,
  width,
  height,
  desiredWidth,
  desiredHeight,
  children,
  onClose,
  onMouseScroll,
  actions = [],
  palette: paletteOverride,
  opaqueBackdrop = false,
}: ModalFrameProps) {
  const cockpit = useCockpitTheme();
  const hitCoordinator = useHitCoordinator();
  const palette =
    paletteOverride ??
    ({
      background: cockpit.PANEL_BG,
      border: cockpit.FRAME,
      title: cockpit.BRIGHT,
      text: cockpit.FG,
      muted: cockpit.DIMMER,
      accent: cockpit.ACCENT,
      hover: cockpit.FOCUS_BG,
    } satisfies ModalPalette);
  useEffect(() => hitCoordinator.cancel(), [hitCoordinator, id]);

  const geometry = resolveModalGeometry({
    width,
    height,
    desiredWidth,
    desiredHeight,
    hasActions: actions.length > 0,
  });
  const { frameWidth, frameHeight, left, top, innerWidth } = geometry;
  const closeLabel = onClose === undefined ? '' : '[Esc]';
  const titleWidth = Math.max(1, innerWidth - (closeLabel === '' ? 0 : closeLabel.length + 1));
  const content = typeof children === 'function' ? children(geometry) : children;
  const actionLayout = fitActionRow(
    actions.map((action, index) => ({
      id: action.id,
      fullLabel: action.label,
      shortLabel: action.shortLabel,
      fixedWidth: displayLen(action.keyLabel) + 3,
      priority: action.priority ?? index,
      required: action.required ?? true,
    })),
    geometry.actionWidth,
    3
  );

  return (
    <>
      <box
        id={backdropId}
        position="absolute"
        top={0}
        left={0}
        width={width}
        height={height}
        zIndex={55}
        backgroundColor={opaqueBackdrop ? palette.background : undefined}
        onMouseScroll={(event: MouseEvent) => {
          event.stopPropagation();
          onMouseScroll?.(event);
        }}
        // DOWN avoids the opening menu click's mouse-up closing the new dialog.
        onMouseDown={
          onClose === undefined
            ? undefined
            : (event: MouseEvent) => {
                event.stopPropagation();
                hitCoordinator.cancel();
                onClose();
              }
        }
      />
      <box
        id={id}
        position="absolute"
        top={top}
        left={left}
        zIndex={60}
        width={frameWidth}
        height={frameHeight}
        flexDirection="column"
        border
        borderColor={palette.border}
        backgroundColor={palette.background}
        paddingLeft={SPACE.xs}
        paddingRight={SPACE.xs}
        onMouseScroll={(event: MouseEvent) => {
          event.stopPropagation();
          onMouseScroll?.(event);
        }}
        onMouseDown={(event: MouseEvent) => {
          event.stopPropagation();
          hitCoordinator.cancel();
        }}
        onMouseUp={(event: MouseEvent) => event.stopPropagation()}
      >
        {geometry.titleRows === 0 ? null : (
          <box height={1} width="100%" flexShrink={0} flexDirection="row">
            <text fg={palette.title}>{truncate(title, titleWidth).padEnd(titleWidth)}</text>
            {closeLabel === '' ? null : (
              <ModalHit
                id={`${id}-close`}
                onSelect={() => onClose?.()}
                background={palette.background}
                hover={palette.hover}
              >
                {(hovered) => <text fg={hovered ? palette.title : palette.text}>{closeLabel}</text>}
              </ModalHit>
            )}
          </box>
        )}
        {geometry.titleGapRows === 0 ? null : <box height={1} flexShrink={0} />}
        <box height={geometry.bodyRows} flexShrink={0} width="100%" flexDirection="column">
          {content}
        </box>
        {geometry.actionRows === 0 ? null : (
          <>
            {geometry.actionGapRows === 0 ? null : <box height={1} flexShrink={0} />}
            <box height={1} width={geometry.actionWidth} flexShrink={0} flexDirection="row">
              {actionLayout.items.map((item, index) => {
                const action = actions.find((candidate) => candidate.id === item.id)!;
                return (
                  <box key={action.id} height={1} flexDirection="row">
                    {index === 0 ? null : <text fg={palette.muted}> · </text>}
                    <ModalHit
                      id={`${id}-action-${action.id}`}
                      onSelect={action.onSelect}
                      padding
                      background={palette.background}
                      hover={palette.hover}
                    >
                      {(hovered) => (
                        <text>
                          <span fg={palette.accent}>{action.keyLabel}</span>
                          <span fg={hovered ? palette.title : palette.text}> {item.label}</span>
                        </text>
                      )}
                    </ModalHit>
                  </box>
                );
              })}
            </box>
          </>
        )}
      </box>
    </>
  );
}
