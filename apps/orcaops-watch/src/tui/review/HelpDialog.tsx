import type { MouseEvent, ScrollBoxRenderable } from '@opentui/core';
import type { RefObject } from 'react';

import { useCockpitTheme } from '../ThemeProvider';
import { useHit } from '../kit';
import { truncate } from '../layout';
import { ModalFrame } from './ModalFrame';
import type { HelpSection } from './keymap';

// Adapted from Hunk's HelpDialog at 2458366 (MIT; see packages/diff-render/LICENSE).
// Orcaops projects the active screen's command catalog instead of a static key list.

export interface HelpDialogProps {
  title: string;
  context: string;
  sections: HelpSection[];
  width: number;
  height: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  selectedEntryId?: string | null;
  onExecute?: (entryId: string) => void;
  onClose: () => void;
}

export interface ExecutableHelpEntry {
  entryId: string;
  commandId: string;
  gesture?: string;
  line: number;
}

function helpEntryId(sectionIndex: number, rowIndex: number): string {
  return `help-entry-${sectionIndex}-${rowIndex}`;
}

function HelpRow({
  row,
  entryId,
  keyWidth,
  labelWidth,
  selected,
  onExecute,
}: {
  row: HelpSection['rows'][number];
  entryId: string;
  keyWidth: number;
  labelWidth: number;
  selected: boolean;
  onExecute?: (entryId: string) => void;
}) {
  const { BRIGHT, DIM, FOCUS_BG, SEL_BG } = useCockpitTheme();
  const executable =
    row.executable === true && row.commandId !== undefined && onExecute !== undefined;
  const hit = useHit({
    hitId: entryId,
    enabled: executable,
    onSelect: executable ? () => onExecute(entryId) : undefined,
  });
  const keys = row.keys.join(' / ');
  return (
    <box
      id={entryId}
      flexDirection="row"
      height={1}
      width="100%"
      backgroundColor={selected ? FOCUS_BG : hit.hovered ? SEL_BG : undefined}
      onMouseOver={executable ? hit.onMouseOver : undefined}
      onMouseOut={executable ? hit.onMouseOut : undefined}
      onMouseDown={executable ? hit.onMouseDown : undefined}
      onMouseUp={executable ? hit.onMouseUp : undefined}
    >
      <text fg={BRIGHT}>{truncate(keys, keyWidth).padEnd(keyWidth)}</text>
      <text fg={selected || hit.hovered ? BRIGHT : DIM}> {truncate(row.label, labelWidth)}</text>
    </box>
  );
}

/** Stable flattened execution model shared by Watch and Review keyboard owners. */
export function executableHelpEntries(sections: readonly HelpSection[]): ExecutableHelpEntry[] {
  const entries: ExecutableHelpEntry[] = [];
  let sectionStart = 0;
  sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) sectionStart += 1;
    const rowStart = sectionStart + 1;
    section.rows.forEach((row, rowIndex) => {
      if (row.executable !== true || row.commandId === undefined) return;
      entries.push({
        entryId: helpEntryId(sectionIndex, rowIndex),
        commandId: row.commandId,
        line: rowStart + rowIndex,
        ...(row.commandGesture === undefined ? {} : { gesture: row.commandGesture }),
      });
    });
    sectionStart = rowStart + section.rows.length;
  });
  return entries;
}

/** Context-first controls Help projected from the live shell and screen catalogs. */
export function HelpDialog({
  title,
  context,
  sections,
  width,
  height,
  scrollRef,
  selectedEntryId = null,
  onExecute,
  onClose,
}: HelpDialogProps) {
  const { DIM, ACCENT } = useCockpitTheme();
  const desiredWidth = Math.min(82, Math.max(38, width - 8));
  const contentRows = sections.reduce(
    (total, section, index) => total + 1 + section.rows.length + (index === 0 ? 0 : 1),
    0
  );
  const desiredHeight = Math.min(34, Math.max(10, contentRows + 8));

  const scrollHelp = (event: MouseEvent): void => {
    const direction = event.scroll?.direction;
    if (direction === 'up') scrollRef.current?.scrollBy(-2, 'step');
    else if (direction === 'down') scrollRef.current?.scrollBy(2, 'step');
  };

  return (
    <ModalFrame
      id="review-help-dialog"
      backdropId="review-help-backdrop"
      title={title}
      width={width}
      height={height}
      desiredWidth={desiredWidth}
      desiredHeight={desiredHeight}
      onClose={onClose}
      onMouseScroll={scrollHelp}
    >
      {(geometry) => {
        let chromeBudget = Math.max(0, geometry.bodyRows - 1);
        const contextRows = Math.min(1, chromeBudget);
        chromeBudget -= contextRows;
        const footerRows = Math.min(1, chromeBudget);
        chromeBudget -= footerRows;
        const contextGapRows = Math.min(1, chromeBudget);
        chromeBudget -= contextGapRows;
        const footerGapRows = Math.min(1, chromeBudget);
        const bodyHeight = Math.max(
          0,
          geometry.bodyRows - contextRows - footerRows - contextGapRows - footerGapRows
        );
        const keyWidth = Math.min(18, Math.max(10, Math.floor(geometry.innerWidth * 0.28)));
        const labelWidth = Math.max(1, geometry.innerWidth - keyWidth - 1);
        return (
          <>
            {contextRows === 0 ? null : (
              <text fg={DIM}>{truncate(context, geometry.innerWidth)}</text>
            )}
            {contextGapRows === 0 ? null : <box height={1} flexShrink={0} />}
            {bodyHeight === 0 ? null : (
              <scrollbox ref={scrollRef} scrollY focused={false} height={bodyHeight} width="100%">
                {sections.map((section, sectionIndex) => (
                  <box key={section.title} flexDirection="column" width="100%">
                    {sectionIndex === 0 ? null : <box height={1} flexShrink={0} />}
                    <text fg={ACCENT}>{truncate(section.title, geometry.innerWidth)}</text>
                    {section.rows.map((row, rowIndex) => {
                      const keys = row.keys.join(' / ');
                      const entryId = helpEntryId(sectionIndex, rowIndex);
                      const selected = row.executable === true && entryId === selectedEntryId;
                      return (
                        <HelpRow
                          key={row.commandId ?? `${section.title}:${keys}:${row.label}:${rowIndex}`}
                          row={row}
                          entryId={entryId}
                          keyWidth={keyWidth}
                          labelWidth={labelWidth}
                          selected={selected}
                          onExecute={onExecute}
                        />
                      );
                    })}
                  </box>
                ))}
              </scrollbox>
            )}
            {footerGapRows === 0 ? null : <box height={1} flexShrink={0} />}
            {footerRows === 0 ? null : (
              <text fg={DIM}>
                {truncate(
                  'j/k select · Enter run · wheel scroll · ?/Esc/q close',
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
