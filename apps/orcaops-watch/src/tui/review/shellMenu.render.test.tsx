import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { expect, test } from 'bun:test';
import { useState } from 'react';

import { ThemeProvider } from '../ThemeProvider';
import { ShellMenuBar, ShellMenuDropdown } from '../components/ShellMenuBar';
import type { ShellMenuGroup, ShellMenuId } from '../shellMenuModel';

interface RenderNode {
  id?: string;
  backgroundColor?: { r?: number; g?: number; b?: number; a?: number };
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

function background(node: RenderNode | null): number[] {
  const color = node?.backgroundColor;
  return [color?.r ?? 0, color?.g ?? 0, color?.b ?? 0, color?.a ?? 0];
}

test('shell menus and primary actions have real pointer paths', async () => {
  const harness = await createTestRenderer({ width: 100, height: 12 });
  const root = createRoot(harness.renderer);

  function Probe() {
    const [active, setActive] = useState<ShellMenuId | null>(null);
    const [outcome, setOutcome] = useState('idle');
    const groups: readonly ShellMenuGroup[] = [
      {
        id: 'application',
        label: 'Orcaops',
        items: [
          { id: 'do-thing', label: 'Do the thing', hint: 'd', action: () => setOutcome('menu') },
        ],
      },
      {
        id: 'review',
        label: 'Review',
        items: [{ id: 'lens', label: 'Narrative View', enabled: false, action: () => {} }],
      },
      { id: 'view', label: 'View', items: [] },
      { id: 'help', label: 'Help', items: [] },
    ];
    const group = groups.find((candidate) => candidate.id === active) ?? null;
    return (
      <ThemeProvider detectedThemeMode={undefined}>
        <box width={100} height={12} flexDirection="column">
          <ShellMenuBar
            width={100}
            title={`pointer outcome · ${outcome}`}
            groups={groups}
            activeMenu={active}
            actions={[
              {
                id: 'review',
                label: 'Review  v',
                onSelect: () => setOutcome('primary'),
              },
            ]}
            onToggleMenu={(id) => setActive((current) => (current === id ? null : id))}
            onHoverMenu={(id) => {
              if (active !== null) setActive(id);
            }}
          />
          <box flexGrow={1} />
          {group === null ? null : (
            <ShellMenuDropdown
              group={group}
              groups={groups}
              selectedIndex={0}
              terminalWidth={100}
              onHoverItem={() => {}}
              onSelectItem={(index) => {
                const item = group.items[index];
                if (item?.enabled !== false) item?.action();
                setActive(null);
              }}
            />
          )}
        </box>
      </ThemeProvider>
    );
  }

  root.render(<Probe />);
  const settle = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  };
  await settle();

  let rows = harness.captureCharFrame().split('\n');
  const menuX = rows[0]!.indexOf('Orcaops') + 1;
  await harness.mockMouse.click(menuX, 0);
  await settle();
  rows = harness.captureCharFrame().split('\n');
  const itemY = rows.findIndex((row) => row.includes('Do the thing'));
  expect(itemY).toBeGreaterThan(0);

  await harness.mockMouse.click(3, itemY);
  await settle();
  expect(harness.captureCharFrame()).toContain('pointer outcome · menu');

  rows = harness.captureCharFrame().split('\n');
  const actionX = rows[0]!.indexOf('Review  v') + 1;
  await harness.mockMouse.click(actionX, 0);
  await settle();
  expect(harness.captureCharFrame()).toContain('pointer outcome · primary');

  await harness.mockMouse.moveTo(50, 5);
  await settle();
  const baseline = background(findNode(harness.renderer.root, 'shell-action-review'));

  const action = findNode(harness.renderer.root, 'shell-action-review') as RenderNode & {
    x?: number;
    y?: number;
  };
  await harness.mockMouse.moveTo((action.x ?? actionX) + 1, action.y ?? 0);
  await settle();
  expect(background(findNode(harness.renderer.root, 'shell-action-review'))).not.toEqual(baseline);
  expect(harness.captureCharFrame().split('\n')[0]).toContain('Review  v');

  await harness.mockMouse.moveTo(50, 5);
  await settle();
  expect(background(findNode(harness.renderer.root, 'shell-action-review'))).toEqual(baseline);

  harness.renderer.destroy();
});
