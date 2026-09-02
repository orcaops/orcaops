import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import { ThemeProvider } from '../ThemeProvider';
import { EmptyState, ErrorState, Notice, WarningBanner } from './states';

interface RenderNode {
  id?: string;
  x?: number;
  y?: number;
  height?: number;
  width?: number;
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

describe('edge-state kit', () => {
  test('distinguishes neutral, failure, warning, and transient notice surfaces', async () => {
    const harness = await createTestRenderer({ width: 72, height: 14 });
    const root = createRoot(harness.renderer);

    function Probe() {
      const [cleared, setCleared] = useState(false);
      return (
        <ThemeProvider detectedThemeMode={undefined}>
          <box width={72} height={14} flexDirection="column">
            <EmptyState
              id="empty-state"
              variant="screen"
              title="Nothing in this view"
              message="The active filter excludes every destination."
              action={{
                id: 'clear-filter',
                label: cleared ? 'Cleared' : 'Clear filter',
                onSelect: () => setCleared(true),
              }}
            />
            <ErrorState
              id="error-inline"
              variant="inline"
              rows={1}
              width={34}
              message="floor and patch disagree"
            />
            <WarningBanner
              id="warning-inline"
              variant="inline"
              rows={1}
              width={34}
              message="coverage unavailable"
            />
            <Notice
              id="notice-inline"
              variant="inline"
              rows={1}
              width={34}
              message="Theme preview active"
              suffix="Enter applies"
            />
          </box>
        </ThemeProvider>
      );
    }

    root.render(<Probe />);
    await settle(harness);

    expect(findNode(harness.renderer.root, 'error-inline')).toMatchObject({ height: 1, width: 34 });
    expect(findNode(harness.renderer.root, 'warning-inline')).toMatchObject({
      height: 1,
      width: 34,
    });
    expect(findNode(harness.renderer.root, 'notice-inline')).toMatchObject({
      height: 1,
      width: 34,
    });
    expect(harness.captureCharFrame()).toContain('Nothing in this view');
    expect(harness.captureCharFrame()).toContain('floor and patch disagree');
    expect(harness.captureCharFrame()).toContain('coverage unavailable');

    const action = findNode(harness.renderer.root, 'clear-filter');
    await harness.mockMouse.click((action?.x ?? 0) + 1, action?.y ?? 0);
    await settle(harness);
    expect(harness.captureCharFrame()).toContain('[Cleared]');

    harness.renderer.destroy();
  });
});
