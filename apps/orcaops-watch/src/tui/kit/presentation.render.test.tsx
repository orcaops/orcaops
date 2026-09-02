import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import { ThemeProvider } from '../ThemeProvider';
import { MeterBar, Panel, Row, Section, StatPill } from './presentation';

interface RenderNode {
  id?: string;
  x?: number;
  y?: number;
  height?: number;
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

async function settle(harness: Awaited<ReturnType<typeof createTestRenderer>>): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await harness.renderOnce();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await harness.renderOnce();
}

describe('presentation kit', () => {
  test('keeps row geometry explicit and hover paint independent from activation', async () => {
    const harness = await createTestRenderer({ width: 58, height: 10 });
    const root = createRoot(harness.renderer);

    function Probe() {
      const [hovered, setHovered] = useState(false);
      const [activations, setActivations] = useState(0);
      return (
        <ThemeProvider detectedThemeMode={undefined}>
          <Panel id="kit-panel" variant="bare" width={58} height={6}>
            <Section id="kit-cap" variant="cap" title="KIT" right="stable" focused />
            <Row
              id="kit-hover-row"
              height={1}
              hovered={hovered}
              onHoverStart={() => setHovered(true)}
              onHoverEnd={() => setHovered(false)}
              onActivate={() => setActivations((count) => count + 1)}
            >
              <text>{`hover paints · activated ${activations}`}</text>
            </Row>
            <Row id="kit-blurred-row" height={2} selected focused={false} tone="stalled">
              <box height={2} flexDirection="column">
                <text>selected data tone</text>
                <text>exactly two rows</text>
              </box>
            </Row>
            <MeterBar completed={2} total={5} width={12} state="working" />
            <StatPill
              id="kit-pill"
              label="Open"
              value={3}
              tone="attention"
              onActivate={() => setActivations((count) => count + 1)}
            />
          </Panel>
        </ThemeProvider>
      );
    }

    root.render(<Probe />);
    await settle(harness);

    expect(findNode(harness.renderer.root, 'kit-panel')?.height).toBe(6);
    expect(findNode(harness.renderer.root, 'kit-hover-row')?.height).toBe(1);
    expect(findNode(harness.renderer.root, 'kit-blurred-row')?.height).toBe(2);
    const initialFrame = harness.captureCharFrame();
    expect(initialFrame).toContain('▸ KIT');
    expect(initialFrame).toContain('▌selected data tone');
    expect(initialFrame).toContain('2/5');

    const row = findNode(harness.renderer.root, 'kit-hover-row');
    const beforeHoverAlpha = row?.backgroundColor?.a ?? 0;
    await harness.mockMouse.moveTo((row?.x ?? 0) + 3, row?.y ?? 0);
    await settle(harness);
    expect(
      findNode(harness.renderer.root, 'kit-hover-row')?.backgroundColor?.a ?? 0
    ).toBeGreaterThan(beforeHoverAlpha);
    expect(harness.captureCharFrame()).toContain('hover paints · activated 0');

    await harness.mockMouse.pressDown((row?.x ?? 0) + 3, row?.y ?? 0);
    await settle(harness);
    expect(harness.captureCharFrame()).toContain('hover paints · activated 0');

    const pillBeforeRelease = findNode(harness.renderer.root, 'kit-pill');
    await harness.mockMouse.release((pillBeforeRelease?.x ?? 0) + 1, pillBeforeRelease?.y ?? 0);
    await settle(harness);
    expect(harness.captureCharFrame()).toContain('hover paints · activated 0');

    await harness.mockMouse.click((row?.x ?? 0) + 3, row?.y ?? 0);
    await settle(harness);
    expect(harness.captureCharFrame()).toContain('hover paints · activated 1');

    const pill = findNode(harness.renderer.root, 'kit-pill');
    await harness.mockMouse.click((pill?.x ?? 0) + 1, pill?.y ?? 0);
    await settle(harness);
    expect(harness.captureCharFrame()).toContain('hover paints · activated 2');

    harness.renderer.destroy();
  });
});
