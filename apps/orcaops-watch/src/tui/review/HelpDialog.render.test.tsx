import type { ScrollBoxRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { expect, test } from 'bun:test';
import { createRef } from 'react';

import { ThemeProvider } from '../ThemeProvider';
import { HelpDialog } from './HelpDialog';
import type { HelpSection } from './keymap';

interface RenderNode {
  id?: string;
  width?: number;
  height?: number;
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

test('Help rows execute one registered command per click while inert rows preserve geometry', async () => {
  const sections: HelpSection[] = [
    {
      title: 'Commands',
      rows: [
        {
          commandId: 'review.run',
          commandGesture: 'x',
          executable: true,
          keys: ['x'],
          label: 'Run registered command',
        },
        { keys: ['Mouse'], label: 'Informational row' },
        {
          commandId: 'review.disabled',
          executable: false,
          keys: ['d'],
          label: 'Disabled command',
        },
        {
          commandId: 'help',
          executable: false,
          keys: ['?'],
          label: 'Help command',
        },
      ],
    },
  ];
  const executed: string[] = [];
  let closed = 0;
  const harness = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <HelpDialog
        title="Pointer Help"
        context="One row per command"
        sections={sections}
        width={80}
        height={24}
        scrollRef={createRef<ScrollBoxRenderable | null>()}
        selectedEntryId="help-entry-0-0"
        onExecute={(entryId) => executed.push(entryId)}
        onClose={() => {
          closed += 1;
        }}
      />
    </ThemeProvider>
  );
  const settle = async () => {
    for (let pass = 0; pass < 6; pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await harness.renderOnce();
    }
  };
  const click = async (label: string) => {
    const rows = harness.captureCharFrame().split('\n');
    const y = rows.findIndex((row) => row.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = rows[y]!.indexOf(label);
    await harness.mockMouse.click(x + 1, y);
    await settle();
  };

  await settle();
  const dialog = findNode(harness.renderer.root, 'review-help-dialog');
  expect(dialog).not.toBeNull();
  for (let rowIndex = 0; rowIndex < sections[0]!.rows.length; rowIndex += 1) {
    expect(findNode(harness.renderer.root, `help-entry-0-${rowIndex}`)?.height).toBe(1);
  }

  await click('Informational row');
  await click('Disabled command');
  await click('Help command');
  expect(executed).toEqual([]);
  expect(closed).toBe(0);
  expect(findNode(harness.renderer.root, 'review-help-dialog')).toMatchObject({
    width: dialog!.width,
    height: dialog!.height,
  });

  await click('Run registered command');
  expect(executed).toEqual(['help-entry-0-0']);
  expect(closed).toBe(0);
  harness.renderer.destroy();
});
