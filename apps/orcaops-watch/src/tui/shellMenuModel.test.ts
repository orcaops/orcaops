import { describe, expect, it, vi } from 'vitest';

import {
  nextShellMenuItem,
  type ShellMenuGroup,
  shellMenuSpecs,
  shellMenuWidth,
} from './shellMenuModel';

const groups: readonly ShellMenuGroup[] = [
  {
    id: 'application',
    label: 'Orcaops',
    items: [
      { id: 'review', label: 'Review selected', hint: 'v', action: vi.fn() },
      { id: 'disabled', label: 'Unavailable', enabled: false, action: vi.fn() },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [{ id: 'help', label: 'Controls', hint: '?', action: vi.fn() }],
  },
];

describe('shell menu model', () => {
  it('packs labels into deterministic pointer hit boxes', () => {
    expect(shellMenuSpecs(groups)).toEqual([
      { id: 'application', label: 'Orcaops', left: 1, width: 9 },
      { id: 'help', label: 'Help', left: 10, width: 6 },
    ]);
  });

  it('wraps past unavailable items in both directions', () => {
    expect(nextShellMenuItem(groups[0]!.items, 0, 1)).toBe(0);
    expect(nextShellMenuItem(groups[0]!.items, 0, -1)).toBe(0);
  });

  it('prices checkmarks and key hints into the dropdown width', () => {
    expect(
      shellMenuWidth([
        { id: 'short', label: 'Short', action: vi.fn() },
        {
          id: 'lens',
          label: 'Use captured thread',
          hint: 'menu',
          checked: true,
          action: vi.fn(),
        },
      ])
    ).toBe(31);
    expect(
      shellMenuWidth([
        {
          id: 'disabled',
          label: 'Review This Branch',
          hint: 'v',
          enabled: false,
          action: vi.fn(),
        },
      ])
    ).toBe(27);
  });
});
