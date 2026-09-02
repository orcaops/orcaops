import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import { ThemeProvider } from '../ThemeProvider';
import { ReviewFileNavigator } from './ReviewFileNavigator';
import type { LayoutFile } from './checkpointLayout';
import { buildFileNavigatorEntries, fileNavigatorRowId } from './fileNavigator';
import { buildPatchIndex } from './walkDiff';

interface RenderNode {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scrollTop?: number;
  scrollHeight?: number;
  backgroundColor?: { a?: number };
  getChildren?: () => unknown[];
}

function findNode(node: unknown, id: string): RenderNode | null {
  const candidate = node as RenderNode;
  if (candidate?.id === id) return candidate;
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findNode(child, id);
    if (found !== null) return found;
  }
  return null;
}

function countNodes(node: unknown): number {
  const candidate = node as RenderNode;
  let total = 1;
  for (const child of candidate?.getChildren?.() ?? []) total += countNodes(child);
  return total;
}

function layoutFiles(count: number): LayoutFile[] {
  return Array.from({ length: count }, (_, index) => ({
    file: `src/section-${Math.floor(index / 10)}/file-${index}.ts`,
    slices: [],
    hunks: [],
  }));
}

async function settle(
  harness: Awaited<ReturnType<typeof createTestRenderer>>,
  minimumPasses = 3
): Promise<void> {
  let previous = '';
  for (let pass = 0; pass < 10; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
    const scroll = findNode(harness.renderer.root, 'review-file-navigator-scroll');
    const signature = [
      countNodes(harness.renderer.root),
      scroll?.scrollTop ?? -1,
      scroll?.scrollHeight ?? -1,
      harness.captureCharFrame(),
    ].join(':');
    if (pass + 1 >= minimumPasses && signature === previous) return;
    previous = signature;
  }
}

const patch = buildPatchIndex('');

describe('ReviewFileNavigator', () => {
  test('the borderless one-row rail expands through its visible pointer affordance', async () => {
    const files = layoutFiles(2);
    const harness = await createTestRenderer({ width: 42, height: 8 });
    const root = createRoot(harness.renderer);

    function ResponsiveNavigator() {
      const [expanded, setExpanded] = useState(false);
      return (
        <ReviewFileNavigator
          files={files}
          patch={patch}
          width={42}
          height={expanded ? 5 : 1}
          expanded={expanded}
          cursorFile={files[0]!.file}
          viewportFile={files[0]!.file}
          onToggleExpanded={() => setExpanded((current) => !current)}
        />
      );
    }

    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <ResponsiveNavigator />
      </ThemeProvider>
    );
    await settle(harness);

    const compactFrame = harness.captureCharFrame();
    expect(findNode(harness.renderer.root, 'review-file-navigator')?.height).toBe(1);
    expect(compactFrame).toContain('src/section-0/fil');
    expect(compactFrame).toContain('[\\] expand');
    expect(compactFrame).not.toMatch(/[┌┐└┘│─]/u);

    await harness.mockMouse.click(2, 0);
    await settle(harness);

    expect(findNode(harness.renderer.root, 'review-file-navigator')?.height).toBe(5);
    expect(harness.captureCharFrame()).toContain('src/section-0/ · 2');
    harness.renderer.destroy();
  });

  test('5,000 files retain exact scroll geometry with a bounded real render tree', async () => {
    const files = layoutFiles(5_000);
    const entries = buildFileNavigatorEntries(files);
    const harness = await createTestRenderer({ width: 48, height: 12 });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <ReviewFileNavigator
          files={files}
          patch={patch}
          width={48}
          height={10}
          expanded
          cursorFile={files[4_999]!.file}
          viewportFile={files[2_500]!.file}
        />
      </ThemeProvider>
    );
    await settle(harness);

    const navigator = findNode(harness.renderer.root, 'review-file-navigator');
    const scroll = findNode(harness.renderer.root, 'review-file-navigator-scroll');
    const frame = harness.captureCharFrame();
    expect(scroll?.scrollHeight).toBe(entries.length);
    expect(countNodes(navigator)).toBeLessThan(120);
    expect(findNode(harness.renderer.root, fileNavigatorRowId(2_500))).not.toBeNull();
    expect(findNode(harness.renderer.root, fileNavigatorRowId(4_999))).not.toBeNull();
    expect(frame).toContain('▌ view');
    expect(frame).toContain('• cursor');
    expect(frame).toContain(',/.');
    expect(frame).not.toContain('▾');
    expect(frame).toContain('─');
    expect(frame).not.toMatch(/[┌┐└┘│]/u);

    if (scroll !== null) scroll.scrollTop = 1_100;
    await settle(harness);
    expect(harness.captureCharFrame()).toContain('src/section-100/ · 10');
    expect(countNodes(navigator)).toBeLessThan(120);
    harness.renderer.destroy();
  });

  test('windowed file rows keep hover feedback and pointer selection', async () => {
    const files = layoutFiles(3);
    const selected: string[] = [];
    const harness = await createTestRenderer({ width: 42, height: 10 });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <ReviewFileNavigator
          files={files}
          patch={patch}
          width={42}
          height={8}
          expanded
          cursorFile={files[0]!.file}
          viewportFile={files[0]!.file}
          onSelectFile={(file) => selected.push(file)}
        />
      </ThemeProvider>
    );
    await settle(harness);

    const row = findNode(harness.renderer.root, fileNavigatorRowId(1));
    expect(row).not.toBeNull();
    const before = row?.backgroundColor?.a ?? 0;
    await harness.mockMouse.moveTo((row?.x ?? 0) + 2, row?.y ?? 0);
    await settle(harness);
    expect(
      findNode(harness.renderer.root, fileNavigatorRowId(1))?.backgroundColor?.a ?? 0
    ).toBeGreaterThan(before);

    await harness.mockMouse.click((row?.x ?? 0) + 2, row?.y ?? 0);
    await settle(harness);
    expect(selected).toEqual([files[1]!.file]);
    harness.renderer.destroy();
  });

  test('filters only its virtual destinations, including rename sources and no-match state', async () => {
    const files = layoutFiles(3);
    const renamePatch = buildPatchIndex(`diff --git a/src/legacy.ts b/${files[1]!.file}
similarity index 100%
rename from src/legacy.ts
rename to ${files[1]!.file}
`);
    const harness = await createTestRenderer({ width: 80, height: 10 });
    const root = createRoot(harness.renderer);

    function FilteredNavigator({ filter }: { filter: string | null }) {
      return (
        <ReviewFileNavigator
          files={files}
          patch={renamePatch}
          width={80}
          height={8}
          expanded
          filter={filter}
          cursorFile={files[0]!.file}
          viewportFile={files[0]!.file}
        />
      );
    }

    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <FilteredNavigator filter="legacy" />
      </ThemeProvider>
    );
    await settle(harness);
    expect(harness.captureCharFrame()).toContain('FILES · 1/3  / legacy');
    expect(harness.captureCharFrame()).toContain('legacy.ts → file-1.ts');
    expect(harness.captureCharFrame()).not.toContain('file-0.ts');
    expect(harness.captureCharFrame()).not.toContain('file-2.ts');

    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <FilteredNavigator filter="no-such-file" />
      </ThemeProvider>
    );
    await settle(harness);
    expect(harness.captureCharFrame()).toContain('No navigator matches "no-such-file"');
    expect(harness.captureCharFrame()).toContain('/ clear');

    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <FilteredNavigator filter={null} />
      </ThemeProvider>
    );
    await settle(harness);
    expect(harness.captureCharFrame()).toContain('FILES · 3');
    expect(findNode(harness.renderer.root, fileNavigatorRowId(0))).not.toBeNull();
    expect(files).toHaveLength(3);
    harness.renderer.destroy();
  });

  test('native scrolling clears hover before a virtualized row can reappear', async () => {
    const files = layoutFiles(100);
    const harness = await createTestRenderer({ width: 42, height: 10 });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <ReviewFileNavigator
          files={files}
          patch={patch}
          width={42}
          height={8}
          expanded
          cursorFile={null}
          viewportFile={null}
        />
      </ThemeProvider>
    );
    await settle(harness);

    const row = findNode(harness.renderer.root, fileNavigatorRowId(1));
    const baseline = row?.backgroundColor?.a ?? 0;
    await harness.mockMouse.moveTo((row?.x ?? 0) + 2, row?.y ?? 0);
    await settle(harness);
    expect(
      findNode(harness.renderer.root, fileNavigatorRowId(1))?.backgroundColor?.a ?? 0
    ).toBeGreaterThan(baseline);

    const scroll = findNode(harness.renderer.root, 'review-file-navigator-scroll');
    if (scroll !== null) scroll.scrollTop = 60;
    await settle(harness);
    expect(findNode(harness.renderer.root, fileNavigatorRowId(1))).toBeNull();

    // Bring the original row back at a different screen coordinate. If hover were
    // still keyed to the now-virtualized file, it would reappear highlighted even
    // though the pointer remains over another row.
    if (scroll !== null) scroll.scrollTop = 1;
    await settle(harness);
    expect(findNode(harness.renderer.root, fileNavigatorRowId(1))?.backgroundColor?.a ?? 0).toBe(
      baseline
    );
    harness.renderer.destroy();
  });
});
