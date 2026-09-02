import type { MouseEvent, ScrollBoxRenderable } from '@opentui/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useCockpitTheme } from '../ThemeProvider';
import { EmptyState, Rule, useHitCoordinator } from '../kit';
import { displayLen, truncate } from '../layout';
import { bindScrollSurfacePolicy } from '../scrollSurfacePolicy';
import { UI_GLYPH } from '../theme';
import type { LayoutFile } from './checkpointLayout';
import {
  buildFileNavigatorEntries,
  buildFileNavigatorWindow,
  fileNavigatorRowId,
} from './fileNavigator';
import { fileBadgeLetter, type FileChangeType } from './filePresentation';
import { filterNavigatorFiles } from './navigation';
import type { PatchIndex } from './walkDiff';

function badgeColor(type: FileChangeType | null, theme: ReturnType<typeof useCockpitTheme>) {
  const badge = fileBadgeLetter(type);
  if (badge === 'A') return theme.LIVE;
  if (badge === 'D') return theme.RED;
  if (badge === 'R') return theme.CYAN;
  if (badge === 'M') return theme.BLUE;
  return theme.DIMMER;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function ReviewFileNavigator({
  files,
  patch,
  width,
  height,
  expanded,
  filter = null,
  cursorFile,
  viewportFile,
  onToggleExpanded,
  onSelectFile,
}: {
  files: readonly LayoutFile[];
  patch: PatchIndex;
  width: number;
  height: number;
  expanded: boolean;
  /** Destination-only filter. The measured diff remains the full page. */
  filter?: string | null;
  cursorFile: string | null;
  viewportFile: string | null;
  onToggleExpanded?: () => void;
  onSelectFile?: (file: string) => void;
}) {
  const theme = useCockpitTheme();
  const hitCoordinator = useHitCoordinator();
  const { BRIGHT, DIM, FG, FOCUS_BG, FOCUS_MARKER, PANEL_BG, SEL_BG, ACCENT } = theme;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const lastNativeScrollTopRef = useRef(0);
  const [hoveredFile, setHoveredFile] = useState<string | null>(null);
  const visibleFiles = useMemo(
    () =>
      filterNavigatorFiles(
        files,
        filter,
        (file) => patch.fileDiff(file)?.metadata.prevName ?? null
      ),
    [files, filter, patch]
  );
  const entries = useMemo(() => buildFileNavigatorEntries(visibleFiles), [visibleFiles]);
  const effectiveExpanded = expanded && height >= 5;
  const activeFile = viewportFile ?? cursorFile;
  const innerWidth = Math.max(1, Math.floor(width) - 4);
  const fallbackViewportHeight = Math.max(1, Math.floor(height) - 3);
  const [viewport, setViewport] = useState({
    scrollTop: 0,
    viewportHeight: fallbackViewportHeight,
  });
  const fileLocations = useMemo(() => {
    const locations = new Map<string, { fileIndex: number; entryIndex: number }>();
    entries.forEach((entry, entryIndex) => {
      if (entry.kind === 'file') {
        locations.set(entry.file, { fileIndex: entry.fileIndex, entryIndex });
      }
    });
    return locations;
  }, [entries]);
  const pinnedEntryIndices = useMemo(() => {
    const pinned = new Set<number>();
    if (viewportFile !== null) {
      const location = fileLocations.get(viewportFile);
      if (location !== undefined) pinned.add(location.entryIndex);
    }
    if (cursorFile !== null) {
      const location = fileLocations.get(cursorFile);
      if (location !== undefined) pinned.add(location.entryIndex);
    }
    return [...pinned];
  }, [cursorFile, fileLocations, viewportFile]);
  const windowItems = useMemo(
    () =>
      buildFileNavigatorWindow(entries, {
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.viewportHeight,
        overscanRows: 2,
        pinnedEntryIndices,
      }),
    [entries, pinnedEntryIndices, viewport]
  );
  const syncViewport = useCallback((): void => {
    const surface = scrollRef.current;
    if (surface === null) return;
    const scrollTop = Math.max(0, Math.floor(surface.scrollTop));
    const viewportHeight = Math.max(1, Math.floor(surface.viewport.height));
    if (scrollTop !== lastNativeScrollTopRef.current) {
      lastNativeScrollTopRef.current = scrollTop;
      hitCoordinator.cancel();
      setHoveredFile(null);
    }
    setViewport((current) =>
      current.scrollTop === scrollTop && current.viewportHeight === viewportHeight
        ? current
        : { scrollTop, viewportHeight }
    );
  }, [hitCoordinator]);

  const toggleHit = {
    onMouseDown: (event: MouseEvent): void => {
      event.stopPropagation();
      hitCoordinator.arm('review-file-navigator:toggle', onToggleExpanded !== undefined);
    },
    onMouseUp: (event: MouseEvent): void => {
      event.stopPropagation();
      if (hitCoordinator.release('review-file-navigator:toggle').committed) onToggleExpanded?.();
    },
    onMouseOut: (event: MouseEvent): void => {
      event.stopPropagation();
      hitCoordinator.cancel('review-file-navigator:toggle');
    },
  };

  useEffect(() => {
    if (hoveredFile !== null && !fileLocations.has(hoveredFile)) setHoveredFile(null);
  }, [fileLocations, hoveredFile]);

  useLayoutEffect(() => {
    if (!effectiveExpanded) return;
    const surface = scrollRef.current;
    if (surface === null) return;
    return bindScrollSurfacePolicy({
      policy: 'native-mirrored-virtualized',
      surface,
      publishViewport: syncViewport,
    });
  }, [effectiveExpanded, syncViewport]);

  useLayoutEffect(() => {
    if (!effectiveExpanded || activeFile === null) return;
    const location = fileLocations.get(activeFile);
    if (location === undefined) return;
    const surface = scrollRef.current;
    if (surface === null) return;
    const viewportHeight = Math.max(1, Math.floor(surface.viewport.height));
    const viewportTop = Math.max(0, Math.floor(surface.scrollTop));
    const viewportBottom = viewportTop + viewportHeight;
    if (location.entryIndex < viewportTop) {
      surface.scrollTop = location.entryIndex;
    } else if (location.entryIndex >= viewportBottom) {
      surface.scrollTop = location.entryIndex - viewportHeight + 1;
    }
    syncViewport();
  }, [activeFile, effectiveExpanded, fileLocations, syncViewport]);

  if (height < 3) {
    const active = activeFile === null ? 'no file' : activeFile;
    const prefix = `FILES · ${filter === null ? files.length : `${visibleFiles.length}/${files.length}`} · `;
    const suffix = '  [\\] expand';
    const summary = `${prefix}${truncate(
      active,
      Math.max(1, Math.floor(width) - displayLen(prefix) - displayLen(suffix))
    )}${suffix}`;
    return (
      <box
        id="review-file-navigator"
        height={1}
        flexShrink={0}
        backgroundColor={PANEL_BG}
        onMouseDown={onToggleExpanded === undefined ? undefined : toggleHit.onMouseDown}
        onMouseUp={onToggleExpanded === undefined ? undefined : toggleHit.onMouseUp}
        onMouseOut={onToggleExpanded === undefined ? undefined : toggleHit.onMouseOut}
      >
        <text fg={ACCENT}>{truncate(summary, Math.max(1, Math.floor(width)))}</text>
      </box>
    );
  }

  if (!effectiveExpanded) {
    const active = activeFile === null ? 'no file' : activeFile;
    const prefix = `FILES · ${filter === null ? files.length : `${visibleFiles.length}/${files.length}`} · `;
    const suffix = expanded ? ' · compact' : '  [\\] expand';
    const summary = `${prefix}${truncate(
      active,
      Math.max(1, innerWidth - displayLen(prefix) - displayLen(suffix))
    )}${suffix}`;
    return (
      <box
        id="review-file-navigator"
        flexDirection="column"
        height={height}
        flexShrink={0}
        backgroundColor={PANEL_BG}
        onMouseDown={expanded || onToggleExpanded === undefined ? undefined : toggleHit.onMouseDown}
        onMouseUp={expanded || onToggleExpanded === undefined ? undefined : toggleHit.onMouseUp}
        onMouseOut={expanded || onToggleExpanded === undefined ? undefined : toggleHit.onMouseOut}
      >
        <box height={1} flexShrink={0} paddingLeft={2} paddingRight={2}>
          <text fg={ACCENT}>{truncate(summary, innerWidth)}</text>
        </box>
        <box height={1} flexShrink={0} paddingLeft={2} paddingRight={2}>
          <Rule width={innerWidth} />
        </box>
      </box>
    );
  }

  const count = filter === null ? `${files.length}` : `${visibleFiles.length}/${files.length}`;
  const filterLabel = filter === null ? '' : `  / ${filter}`;
  const fullHeader = `FILES · ${count}${filterLabel}  ${UI_GLYPH.viewport} view  ${UI_GLYPH.cursor} cursor  ,/.  [\\]`;
  const shortHeader = `FILES · ${count}${filterLabel}  [\\]`;
  const header = displayLen(fullHeader) <= innerWidth ? fullHeader : shortHeader;

  return (
    <box
      id="review-file-navigator"
      flexDirection="column"
      height={height}
      flexShrink={0}
      backgroundColor={PANEL_BG}
    >
      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        onMouseDown={onToggleExpanded === undefined ? undefined : toggleHit.onMouseDown}
        onMouseUp={onToggleExpanded === undefined ? undefined : toggleHit.onMouseUp}
        onMouseOut={onToggleExpanded === undefined ? undefined : toggleHit.onMouseOut}
      >
        <text fg={ACCENT}>{truncate(header, innerWidth)}</text>
      </box>
      <box height={1} flexShrink={0} paddingLeft={2} paddingRight={2}>
        <Rule width={innerWidth} />
      </box>
      <scrollbox
        id="review-file-navigator-scroll"
        ref={scrollRef}
        scrollY
        focused={false}
        flexGrow={1}
        paddingLeft={2}
        paddingRight={2}
      >
        {visibleFiles.length === 0 && filter !== null ? (
          <EmptyState
            id="review-file-navigator-empty"
            variant="inline"
            rows={1}
            width={innerWidth}
            message={`No navigator matches "${filter}"`}
            suffix="/ clear"
          />
        ) : (
          windowItems.map((item) => {
            if (item.kind === 'spacer') {
              return <box key={item.key} height={item.height} flexShrink={0} />;
            }
            const { entry } = item;
            if (entry.kind === 'directory') {
              return (
                <box key={entry.key} height={1} flexShrink={0}>
                  <text fg={DIM}>
                    {truncate(`${entry.directory}/ · ${entry.count}`, innerWidth)}
                  </text>
                </box>
              );
            }

            const group = visibleFiles[entry.fileIndex]!;
            const diff = patch.fileDiff(entry.file);
            const type = patch.fileChangeType(entry.file);
            const badge = fileBadgeLetter(type);
            const additions =
              diff?.stats.additions ?? group.hunks.reduce((sum, hunk) => sum + hunk.added, 0);
            const deletions =
              diff?.stats.deletions ?? group.hunks.reduce((sum, hunk) => sum + hunk.removed, 0);
            const stats = `+${additions} −${deletions}`;
            const previous = diff?.metadata.prevName;
            const label =
              previous !== null && previous !== undefined && previous !== entry.file
                ? `${basename(previous)} → ${entry.basename}`
                : entry.basename;
            const prefixWidth = 4;
            const showStats = innerWidth - prefixWidth - displayLen(stats) - 1 >= 8;
            const pathWidth = Math.max(
              1,
              innerWidth - prefixWidth - (showStats ? stats.length + 1 : 0)
            );
            const inViewport = entry.file === viewportFile;
            const isCursor = entry.file === cursorFile;
            const hovered = entry.file === hoveredFile;
            const hitId = `review-file:${entry.file}`;

            return (
              <box
                key={entry.key}
                id={fileNavigatorRowId(entry.fileIndex)}
                flexDirection="row"
                height={1}
                flexShrink={0}
                backgroundColor={inViewport ? FOCUS_BG : hovered ? SEL_BG : undefined}
                onMouseOver={(event: MouseEvent) => {
                  event.stopPropagation();
                  setHoveredFile(entry.file);
                }}
                onMouseOut={(event: MouseEvent) => {
                  event.stopPropagation();
                  hitCoordinator.cancel(hitId);
                  setHoveredFile((current) => (current === entry.file ? null : current));
                }}
                onMouseDown={(event: MouseEvent) => {
                  event.stopPropagation();
                  hitCoordinator.arm(hitId, onSelectFile !== undefined);
                }}
                onMouseUp={(event: MouseEvent) => {
                  event.stopPropagation();
                  if (hitCoordinator.release(hitId, onSelectFile !== undefined).committed) {
                    onSelectFile?.(entry.file);
                  }
                }}
              >
                <text width={1} height={1} flexShrink={0} fg={inViewport ? FOCUS_MARKER : DIM}>
                  {inViewport ? UI_GLYPH.viewport : ' '}
                </text>
                <text width={1} height={1} flexShrink={0} fg={isCursor ? BRIGHT : DIM}>
                  {isCursor ? UI_GLYPH.cursor : ' '}
                </text>
                <text width={2} height={1} flexShrink={0} fg={badgeColor(type, theme)}>
                  {badge}{' '}
                </text>
                <text fg={inViewport || isCursor ? BRIGHT : FG}>
                  {truncate(label, pathWidth).padEnd(pathWidth)}
                </text>
                {showStats ? <text fg={DIM}> {stats}</text> : null}
              </box>
            );
          })
        )}
      </scrollbox>
      <box height={1} flexShrink={0} paddingLeft={2} paddingRight={2}>
        <Rule width={innerWidth} />
      </box>
    </box>
  );
}
