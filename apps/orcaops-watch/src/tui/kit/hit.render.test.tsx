import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { expect, test } from 'bun:test';
import { useState } from 'react';

import { ThemeProvider } from '../ThemeProvider';
import { useHit } from './hit';

interface RenderNode {
  id?: string;
  x?: number;
  y?: number;
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

function VirtualHit({ onSelect }: { onSelect: () => void }) {
  const hit = useHit({ hitId: 'hit-virtual', onSelect });
  return (
    <box
      id="hit-virtual"
      backgroundColor={hit.hovered ? '#334455' : undefined}
      onMouseOver={hit.onMouseOver}
      onMouseOut={hit.onMouseOut}
      onMouseDown={hit.onMouseDown}
      onMouseUp={hit.onMouseUp}
    >
      <text>virtual target</text>
    </box>
  );
}

test('Hit composes nested nodes and clears virtualized hover/arm state on unmount', async () => {
  const harness = await createTestRenderer({ width: 50, height: 8 });
  const root = createRoot(harness.renderer);
  let setVirtualVisible: ((visible: boolean) => void) | null = null;

  function Probe() {
    const [events, setEvents] = useState<string[]>([]);
    const [virtualVisible, setVisible] = useState(true);
    setVirtualVisible = setVisible;
    const parent = useHit({
      hitId: 'hit-parent',
      onSelect: () => setEvents((current) => [...current, 'parent']),
    });
    const child = useHit({
      hitId: 'hit-child',
      onSelect: () => setEvents((current) => [...current, 'child']),
    });
    const disabled = useHit({
      hitId: 'hit-disabled',
      enabled: false,
      onSelect: () => setEvents((current) => [...current, 'disabled']),
    });
    return (
      <box flexDirection="column">
        <box
          id="hit-parent"
          onMouseOver={parent.onMouseOver}
          onMouseOut={parent.onMouseOut}
          onMouseDown={parent.onMouseDown}
          onMouseUp={parent.onMouseUp}
        >
          <box
            id="hit-child"
            onMouseOver={child.onMouseOver}
            onMouseOut={child.onMouseOut}
            onMouseDown={child.onMouseDown}
            onMouseUp={child.onMouseUp}
          >
            <text>nested child</text>
          </box>
        </box>
        <box
          id="hit-disabled"
          onMouseOver={disabled.onMouseOver}
          onMouseOut={disabled.onMouseOut}
          onMouseDown={disabled.onMouseDown}
          onMouseUp={disabled.onMouseUp}
        >
          <text>disabled</text>
        </box>
        {virtualVisible ? (
          <VirtualHit onSelect={() => setEvents((current) => [...current, 'virtual'])} />
        ) : null}
        <text>{`events:${events.join(',')}`}</text>
      </box>
    );
  }

  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <Probe />
    </ThemeProvider>
  );
  const settle = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  };
  await settle();

  const child = findNode(harness.renderer.root, 'hit-child')!;
  await harness.mockMouse.click((child.x ?? 0) + 1, child.y ?? 0);
  await settle();
  expect(harness.captureCharFrame()).toContain('events:child');

  const disabled = findNode(harness.renderer.root, 'hit-disabled')!;
  await harness.mockMouse.click((disabled.x ?? 0) + 1, disabled.y ?? 0);
  await settle();
  expect(harness.captureCharFrame()).toContain('events:child');
  expect(harness.captureCharFrame()).not.toContain('disabled,');

  const virtual = findNode(harness.renderer.root, 'hit-virtual')!;
  await harness.mockMouse.moveTo((virtual.x ?? 0) + 1, virtual.y ?? 0);
  await settle();
  expect(findNode(harness.renderer.root, 'hit-virtual')?.backgroundColor?.a ?? 0).toBeGreaterThan(
    0
  );
  await harness.mockMouse.pressDown((virtual.x ?? 0) + 1, virtual.y ?? 0);
  flushSync(() => setVirtualVisible?.(false));
  await settle();
  flushSync(() => setVirtualVisible?.(true));
  await settle();
  const remounted = findNode(harness.renderer.root, 'hit-virtual')!;
  expect(remounted.backgroundColor?.a ?? 0).toBe(0);
  await harness.mockMouse.release((remounted.x ?? 0) + 1, remounted.y ?? 0);
  await settle();
  expect(harness.captureCharFrame()).toContain('events:child');
  expect(harness.captureCharFrame()).not.toContain('events:child,virtual');

  harness.renderer.destroy();
});
