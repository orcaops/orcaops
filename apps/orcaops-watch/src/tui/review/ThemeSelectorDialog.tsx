import type { MouseEvent } from '@opentui/core';
import { useRef } from 'react';

import type { AppTheme } from '@orcaops/diff-render';

import { truncate } from '../layout';
import { stickyWindowStart, type ThemeAppearanceFilter } from '../themeSelection';
import { ModalFrame, type ModalPalette } from './ModalFrame';

// Adapted from Hunk's ThemeSelectorDialog at 2458366 (MIT; see
// packages/diff-render/LICENSE). Orcaops keeps preview state in the shared shell
// and routes keyboard, wheel, hover, and pointer commit through the same callbacks.

export interface ThemeSelectorItem {
  id: string;
  label: string;
  appearance: AppTheme['appearance'];
  active: boolean;
}

export interface ThemeSelectorDialogProps {
  /** The FILTERED rows. Every index in the callbacks is an index into this array. */
  items: ThemeSelectorItem[];
  selectedIndex: number;
  filter: ThemeAppearanceFilter;
  /** Label of the committed theme, shown when the filter hides its row. */
  activeLabel: string | null;
  width: number;
  height: number;
  theme: AppTheme;
  onClose: () => void;
  onPreview: (index: number) => void;
  onSelect: (index: number) => void;
  onMove: (delta: number) => void;
}

/** Shared keyboard/pointer theme preview and selection surface. */
export function ThemeSelectorDialog({
  items,
  selectedIndex,
  filter,
  activeLabel,
  width,
  height,
  theme,
  onClose,
  onPreview,
  onSelect,
  onMove,
}: ThemeSelectorDialogProps) {
  // Sticky list window (see `stickyWindowStart`): survives re-renders so hover
  // preview never shifts rows under a stationary pointer.
  const windowStartRef = useRef(0);
  const desiredWidth = Math.min(82, Math.max(38, width - 8));
  const desiredHeight = Math.min(28, Math.max(12, height - 4));
  const palette: ModalPalette = {
    background: theme.panel,
    border: theme.muted,
    title: theme.text,
    text: theme.text,
    muted: theme.muted,
    accent: theme.accent,
    hover: theme.accentMuted,
  };

  const scrollThemes = (event: MouseEvent): void => {
    const direction = event.scroll?.direction;
    if (direction === 'up') onMove(-1);
    else if (direction === 'down') onMove(1);
  };

  return (
    <ModalFrame
      id="theme-selector-dialog"
      backdropId="theme-selector-backdrop"
      title={`Theme preview · ${items[selectedIndex]?.label ?? 'current'}`}
      width={width}
      height={height}
      desiredWidth={desiredWidth}
      desiredHeight={desiredHeight}
      palette={palette}
      onClose={onClose}
      onMouseScroll={scrollThemes}
    >
      {(geometry) => {
        let chromeBudget = Math.max(0, geometry.bodyRows - 1);
        const footerRows = Math.min(1, chromeBudget);
        chromeBudget -= footerRows;
        const descriptionRows = Math.min(1, chromeBudget);
        chromeBudget -= descriptionRows;
        const previewRows = Math.min(1, chromeBudget);
        chromeBudget -= previewRows;
        const listTopGapRows = Math.min(1, chromeBudget);
        chromeBudget -= listTopGapRows;
        const listBottomGapRows = Math.min(1, chromeBudget);
        const listRows = Math.max(
          0,
          geometry.bodyRows -
            footerRows -
            descriptionRows -
            previewRows -
            listTopGapRows -
            listBottomGapRows
        );
        const showMore = listRows >= 2 && items.length > listRows;
        const visibleRows = Math.max(0, Math.min(items.length, listRows - (showMore ? 1 : 0)));
        const start = stickyWindowStart(
          windowStartRef.current,
          selectedIndex,
          items.length,
          visibleRows
        );
        windowStartRef.current = start;
        const window = items.slice(start, start + visibleRows);
        const markerWidth = 3;
        const appearanceWidth = 6;
        const labelWidth = Math.max(1, geometry.innerWidth - markerWidth - appearanceWidth);
        return (
          <>
            {descriptionRows === 0 ? null : (
              <text fg={theme.muted}>
                {truncate(
                  filter === 'all'
                    ? 'Choose a row to preview it; select it to apply.'
                    : `Showing ${filter} themes${
                        activeLabel !== null && !items.some((item) => item.active)
                          ? ` · active: ${activeLabel} (hidden by filter)`
                          : ''
                      }`,
                  geometry.innerWidth
                )}
              </text>
            )}
            {previewRows === 0 ? null : (
              <box flexDirection="row" height={1} backgroundColor={theme.background}>
                <text>
                  <span fg={theme.addedSignColor}>+</span>
                  <span fg={theme.text}> added </span>
                  <span fg={theme.removedSignColor}>−</span>
                  <span fg={theme.text}> removed </span>
                  <span fg={theme.accent}>~</span>
                  <span fg={theme.text}> changed </span>
                  <span fg={theme.muted}>context</span>
                </text>
              </box>
            )}
            {listTopGapRows === 0 ? null : <box height={1} flexShrink={0} />}
            {window.map((item, offset) => {
              const index = start + offset;
              const selected = index === selectedIndex;
              const marker = selected ? '›' : item.active ? '✓' : ' ';
              const foreground = selected || item.active ? theme.text : theme.muted;
              return (
                <box
                  key={item.id}
                  id={`theme-selector-item-${index}`}
                  flexDirection="row"
                  height={1}
                  backgroundColor={selected ? theme.accentMuted : theme.panel}
                  onMouseOver={() => onPreview(index)}
                  onMouseDown={(event: MouseEvent) => {
                    event.stopPropagation();
                    onSelect(index);
                  }}
                >
                  <text fg={foreground}>{`${marker} `.padEnd(markerWidth)}</text>
                  <text fg={foreground}>{truncate(item.label, labelWidth).padEnd(labelWidth)}</text>
                  <text fg={theme.muted}>{item.appearance}</text>
                </box>
              );
            })}
            {showMore ? (
              <text fg={theme.muted}>
                {truncate(`… ${items.length - start - visibleRows} more`, geometry.innerWidth)}
              </text>
            ) : null}
            {listBottomGapRows === 0 ? null : <box height={1} flexShrink={0} />}
            {footerRows === 0 ? null : (
              <text fg={theme.muted}>
                {truncate(
                  `↑/↓/Tab or wheel preview · Enter applies · d filter: ${filter}`,
                  geometry.innerWidth
                )}
              </text>
            )}
          </>
        );
      }}
    </ModalFrame>
  );
}
