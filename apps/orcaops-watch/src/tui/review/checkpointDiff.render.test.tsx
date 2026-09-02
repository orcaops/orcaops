// The geometry contract, against the real renderer.
//
// `CheckpointDiff`'s header says its card geometry is "a CONTRACT with
// `buildCheckpointLayout`" — marginTop + top rule + header = 3 rows, a 1-row
// bottom rule, one row per label, 4 per pin. This asserts it: it mounts the real
// column and compares the height the RENDERER computed against the height the
// MEASURER predicted.
//
// That single equality is what every other guarantee rests on. Scroll-to-cursor
// lands on the right line only if they agree; `G` reaches the true bottom only if
// they agree; and the row-window spacers are exact only if they agree. When they
// disagree, nothing throws — the reader is just quietly shown the wrong line.
//
// It also exercises the one path the mounted-app tests structurally cannot: the
// app's own fixture has three hunks and the mount window overscans by two, so
// NOTHING is ever a spacer there. Twelve hunks is what makes spacers happen.

import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { useEffect, useState } from 'react';

import { DEFAULT_DARK_THEME_ID, resolveTheme } from '@orcaops/diff-render';

import { buildFocusByHunkKey, CheckpointDiff } from './CheckpointDiff';
import { buildCheckpointLayout } from './checkpointLayout';
import type { DiffAnnotation, DiffPin, SemanticDiffAnnotation } from './diffPins';
import { buildPatchIndex, type PatchIndex } from './walkDiff';
import { TALL_ADDS, TALL_HUNK, TALL_PAGE, TALL_PATCH } from '../../../tests/review/tallPageFixture';
import { CockpitThemeContext, cockpitThemeFor, ThemeProvider } from '../ThemeProvider';

const WIDTH = 120;
const CARD_WIDTH = 110;
const VIEWPORT = 30;

const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);
const cockpit = cockpitThemeFor(theme);
const patch = buildPatchIndex(TALL_PATCH);
const EMPTY_PINS: readonly DiffPin[] = [];
const EMPTY_EXPANDED_FOREIGN_HUNKS: ReadonlySet<string> = new Set();

interface Node {
  id?: string;
  scrollHeight?: number;
  getChildren?: () => unknown[];
}

function find(node: unknown, id: string): Node | null {
  const candidate = node as Node;
  if (candidate?.id === id && typeof candidate.scrollHeight === 'number') return candidate;
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = find(child, id);
    if (found !== null) return found;
  }
  return null;
}

function countNodes(node: unknown): number {
  const candidate = node as Node;
  let total = 1;
  for (const child of candidate?.getChildren?.() ?? []) total += countNodes(child);
  return total;
}

/** A pin that carries the geometry the layout prices, and a body the pin draws. */
function pin(target: DiffPin['target'], id: string): DiffPin {
  return {
    kind: 'comment',
    annotationId: `comment:${id}`,
    height: 4,
    commentId: id,
    author: 'reviewer',
    status: 'open',
    body: `pinned ${id}`,
    replyCount: 0,
    drifted: false,
    rung: 'line_hash',
    side: 'add',
    line: null,
    endLine: null,
    target,
  };
}

function semanticCard(
  target: SemanticDiffAnnotation['target'],
  id: string
): SemanticDiffAnnotation {
  const displayTarget =
    target.kind === 'line' ? target : ({ kind: 'slice', sliceKey: `${TALL_HUNK}:s0` } as const);
  return {
    kind: 'semantic',
    annotationId: `semantic:${id}`,
    height: 4,
    itemId: `citation:${id}`,
    citationId: `cite:artifact:cp1:decision:0`,
    shortText: 'Keep the captured decision beside its exact code.',
    fullText: 'Keep the captured decision beside its exact code.',
    source: 'CHECKPOINT_DECISION',
    disposition: 'ANCHORED',
    targetCount: 1,
    locationCount: 1,
    placement: {
      id,
      itemId: `citation:${id}`,
      citationId: `cite:artifact:cp1:decision:0`,
      targetIndex: 0,
      locationIndex: 0,
      target: {
        schema_version: 3,
        block: {
          block_key: 'block-semantic-render',
          hunk_key: 'hunk_0',
          old_file: 'src/big.ts',
          new_file: 'src/big.ts',
          display_file: 'src/big.ts',
          delete: null,
          add: {
            start_line: 2,
            end_line: 2,
            line_hashes: ['a'.repeat(64)],
          },
        },
        scope: 'FOCUS',
        focus: {
          delete: null,
          add: {
            start_line: 2,
            end_line: 2,
            line_hashes: ['a'.repeat(64)],
          },
        },
        focus_status: 'ACCEPTED',
        focus_diagnostic_code: null,
        warnings: [],
      },
      displayTarget,
      rowCursor: 1,
      highlightedRows: [{ side: 'add', line: 2, lineHash: 'a'.repeat(64) }],
      destination: {
        kind: 'page',
        pageIndex: 0,
        pageKey: 'probe',
        hunkKey: 'hunk_0',
        sliceKey: 'hunk_0:s0',
      },
    },
    target,
  };
}

function EnrichmentProbe({
  patchIndex,
  onMeasured,
}: {
  patchIndex: PatchIndex;
  onMeasured: (layout: ReturnType<typeof buildCheckpointLayout>) => void;
}) {
  const [revision, setRevision] = useState(patchIndex.enrichmentRevision);
  useEffect(() => patchIndex.subscribeEnrichment(setRevision), [patchIndex]);
  return (
    <CheckpointDiff
      page={TALL_PAGE}
      patch={patchIndex}
      patchEnrichmentRevision={revision}
      theme={theme}
      width={CARD_WIDTH}
      layout="split"
      cursorHunkKey={null}
      pins={EMPTY_PINS}
      expandedForeignHunks={EMPTY_EXPANDED_FOREIGN_HUNKS}
      scrollTop={0}
      viewportHeight={VIEWPORT}
      onMeasured={onMeasured}
    />
  );
}

async function mountColumn(options: {
  pins: readonly DiffAnnotation[];
  scrollTop: number;
  layout?: 'split' | 'stack';
  pinnedFileHeader?: boolean;
  tightViewportWindow?: boolean;
}) {
  const layout = options.layout ?? 'split';
  const harness = await createTestRenderer({ width: WIDTH, height: VIEWPORT });
  const { renderer, renderOnce } = harness;
  const root = createRoot(renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <scrollbox id="probe" scrollY={true} focused={false} flexGrow={1}>
        <CheckpointDiff
          page={TALL_PAGE}
          patch={patch}
          theme={theme}
          width={CARD_WIDTH}
          layout={layout}
          cursorHunkKey={null}
          pins={options.pins}
          scrollTop={options.scrollTop}
          viewportHeight={VIEWPORT}
          tightViewportWindow={options.tightViewportWindow}
          pinnedFileHeader={options.pinnedFileHeader}
        />
      </scrollbox>
    </ThemeProvider>
  );

  // Converge, rather than guess a pass count — see mountReviewApp.settle.
  let previous = -1;
  for (let pass = 0; pass < 10; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await renderOnce();
    const nodes = countNodes(renderer.root);
    const content = find(renderer.root, 'probe')?.scrollHeight ?? 0;
    if (nodes === previous && content > 0) break;
    previous = nodes;
  }

  const expected = buildCheckpointLayout({
    page: TALL_PAGE,
    patch,
    theme,
    layout,
    cardWidth: CARD_WIDTH,
    annotations: options.pins,
    pinnedFileHeader: options.pinnedFileHeader,
  });

  return {
    content: find(renderer.root, 'probe')?.scrollHeight ?? 0,
    expected: expected.totalHeight,
    nodes: countNodes(renderer.root),
    frame: harness.captureCharFrame(),
    destroy: () => {
      flushSync(() => root.unmount());
      renderer.destroy();
    },
  };
}

describe('CheckpointDiff geometry', () => {
  test('indexes focus metadata with one slice pass across a many-hunk file', () => {
    const count = 500;
    const templateFile = TALL_PAGE.files[0]!;
    const templateHunk = templateFile.hunks[0]!;
    const templateSlice = templateFile.slices[0]!;
    const hunks = Array.from({ length: count }, (_, index) => ({
      ...templateHunk,
      hunkKey: `focus_hunk_${index}`,
    }));
    const slices = Array.from({ length: count }, (_, index) => ({
      ...templateSlice,
      sliceKey: `focus_hunk_${index}:s0`,
      hunkKey: `focus_hunk_${index}`,
    }));
    let sliceReads = 0;
    const trackedSlices = new Proxy(slices, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) sliceReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const focus = buildFocusByHunkKey([{ file: templateFile.file, hunks, slices: trackedSlices }]);

    expect(focus.size).toBe(count);
    expect(focus.get('focus_hunk_499')?.ranges).toHaveLength(1);
    // One indexed read per slice; a per-hunk scan would perform 250,000.
    expect(sliceReads).toBe(count);
  });

  test('keeps each file slice pass isolated before merging global hunk identities', () => {
    const templateFile = TALL_PAGE.files[0]!;
    const templateHunk = templateFile.hunks[0]!;
    const templateSlice = templateFile.slices[0]!;
    const focus = buildFocusByHunkKey([
      {
        file: 'src/first.ts',
        hunks: [{ ...templateHunk, file: 'src/first.ts', hunkKey: 'first-hunk' }],
        slices: [
          {
            ...templateSlice,
            file: 'src/first.ts',
            hunkKey: 'first-hunk',
            sliceKey: 'first-hunk:s0',
          },
        ],
      },
      {
        file: 'src/second.ts',
        hunks: [{ ...templateHunk, file: 'src/second.ts', hunkKey: 'second-hunk' }],
        // Invalid cross-file key: a slice must not attach to a hunk from another file.
        slices: [
          {
            ...templateSlice,
            file: 'src/second.ts',
            hunkKey: 'first-hunk',
            sliceKey: 'first-hunk:foreign',
          },
        ],
      },
    ]);

    expect(focus.get('first-hunk')?.ranges).toHaveLength(1);
    expect(focus.get('second-hunk')?.ranges).toHaveLength(0);
  });

  test('the rendered column is EXACTLY as tall as the layout measured it', async () => {
    const column = await mountColumn({ pins: [], scrollTop: 0 });

    // The whole contract in one line. Most of this column is spacers — a 5,000-row
    // hunk plus eleven others, of which only a handful are near the viewport — so
    // this equality is also the proof that every spacer reserved precisely the
    // height its hunk would have taken.
    expect(column.content).toBe(column.expected);
    expect(column.content).toBeGreaterThan(TALL_ADDS);
    const fileChrome = column.frame.split('\n').slice(0, 3).join('\n');
    expect(fileChrome).toContain('─'.repeat(20));
    expect(fileChrome).not.toMatch(/[┌┐└┘│]/u);
    column.destroy();
  });

  test('the fixed first file header is omitted from both render and measurement', async () => {
    const ordinary = await mountColumn({ pins: [], scrollTop: 0 });
    const sticky = await mountColumn({ pins: [], scrollTop: 0, pinnedFileHeader: true });

    expect(sticky.content).toBe(sticky.expected);
    expect(sticky.content).toBe(ordinary.content - 1);
    ordinary.destroy();
    sticky.destroy();
  });

  test('spacers hold the height open — the column does not collapse to what mounted', async () => {
    const column = await mountColumn({ pins: [], scrollTop: 0 });

    // Bounded: nowhere near 5,000 renderables are alive...
    expect(column.nodes).toBeLessThan(TALL_ADDS / 5);
    // ...and yet the document is still its full height. Those two facts together
    // are what "virtualized" means; either one alone is satisfiable by a bug.
    expect(column.content).toBeGreaterThan(TALL_ADDS);
    column.destroy();
  });

  test('pins are priced where they are drawn — the height still agrees', async () => {
    // Every pin kind at once: on the file card, above a hunk body, and per-row
    // inside one. Each is priced by a different branch of the measurer, and each
    // is drawn by a different branch of the renderer. If any pair disagrees by a
    // single row, this equality breaks.
    const column = await mountColumn({
      pins: [
        pin({ kind: 'file', file: 'src/big.ts' }, 'on-file'),
        pin({ kind: 'slice', sliceKey: `${TALL_HUNK}:s0` }, 'above-hunk'),
        pin({ kind: 'line', sliceKey: 'hunk_0:s0', side: 'add', line: 2 }, 'on-row'),
      ],
      scrollTop: 0,
    });

    expect(column.content).toBe(column.expected);
    column.destroy();
  });

  test('a semantic card and reviewer comment coexist on one virtualized row', async () => {
    const target = {
      kind: 'line',
      sliceKey: 'hunk_0:s0',
      side: 'add',
      line: 2,
    } as const;
    const column = await mountColumn({
      pins: [pin(target, 'reviewer'), semanticCard(target, 'captured-decision')],
      scrollTop: 0,
    });

    expect(column.content).toBe(column.expected);
    expect(column.nodes).toBeLessThan(TALL_ADDS / 5);
    expect(column.frame).toContain('pinned reviewer');
    expect(column.frame).toContain('Keep the captured decision beside its exact code.');
    expect(column.frame.match(/Keep the captured decision beside its exact code\./g)).toHaveLength(
      1
    );
    column.destroy();
  });

  test('the height is stable across scroll — the window slides, the document does not', async () => {
    const top = await mountColumn({ pins: [], scrollTop: 0 });
    const deep = await mountColumn({ pins: [], scrollTop: 3000 });

    // Same document, different window into it. A mount plan that changed the
    // content height as the reader scrolled would make the scrollbar jump under
    // their hand and the bottom of the file recede as they approached it.
    expect(deep.content).toBe(top.content);
    expect(deep.nodes).toBeLessThan(TALL_ADDS / 5);
    top.destroy();
    deep.destroy();
  });

  test('a deep destination stays measured and bounded in split and stack layouts', async () => {
    for (const layout of ['split', 'stack'] as const) {
      const column = await mountColumn({ pins: [], scrollTop: 3000, layout });

      expect(column.content).toBe(column.expected);
      expect(column.content).toBeGreaterThan(TALL_ADDS);
      expect(column.nodes).toBeLessThan(TALL_ADDS / 5);
      column.destroy();
    }
  });

  test('a native destination trims row hosts without changing document geometry', async () => {
    const ordinary = await mountColumn({ pins: [], scrollTop: 3000 });
    const tight = await mountColumn({
      pins: [],
      scrollTop: 3000,
      tightViewportWindow: true,
    });

    expect(tight.content).toBe(ordinary.content);
    expect(tight.expected).toBe(ordinary.expected);
    expect(tight.nodes).toBeLessThan(ordinary.nodes);
    ordinary.destroy();
    tight.destroy();
  });

  test('deferred no-move enrichment preserves parsed identity without invalidating layout', async () => {
    const scheduled: (() => void)[] = [];
    const deferredPatch = buildPatchIndex(TALL_PATCH, undefined, {
      movedLineDetection: 'deferred',
      scheduleDeferred: (work) => {
        scheduled.push(work);
      },
    });
    const before = deferredPatch.fileDiff('src/big.ts');
    const layouts: ReturnType<typeof buildCheckpointLayout>[] = [];
    const onMeasured = (layout: ReturnType<typeof buildCheckpointLayout>) => layouts.push(layout);
    const { renderer, renderOnce } = await createTestRenderer({ width: WIDTH, height: VIEWPORT });
    const root = createRoot(renderer);
    root.render(
      <CockpitThemeContext.Provider value={cockpit}>
        <EnrichmentProbe patchIndex={deferredPatch} onMeasured={onMeasured} />
      </CockpitThemeContext.Provider>
    );
    for (let pass = 0; pass < 5 && (layouts.length === 0 || scheduled.length === 0); pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await renderOnce();
    }
    const initialLayout = layouts.at(-1);
    const initialPublicationCount = layouts.length;
    while (scheduled.length > 0) scheduled.shift()!();
    for (let pass = 0; pass < 5 && layouts.length === initialPublicationCount; pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await renderOnce();
    }

    expect(deferredPatch.fileDiff('src/big.ts')).toBe(before);
    expect(layouts.at(-1)).toBe(initialLayout);
    flushSync(() => root.unmount());
    renderer.destroy();
  });
});
