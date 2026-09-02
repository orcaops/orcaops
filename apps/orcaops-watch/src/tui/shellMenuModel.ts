export type ShellMenuId = 'application' | 'review' | 'view' | 'help';

export interface ShellMenuItem {
  id: string;
  label: string;
  hint?: string;
  checked?: boolean;
  enabled?: boolean;
  /** Plain-language feedback used when an unavailable row is activated. */
  disabledReason?: string;
  action: () => void;
}

export interface ShellMenuGroup {
  id: ShellMenuId;
  label: string;
  items: readonly ShellMenuItem[];
}

export interface ShellMenuSpec {
  id: ShellMenuId;
  label: string;
  left: number;
  width: number;
}

/** Position the menu labels in one compact, desktop-style row. */
export function shellMenuSpecs(groups: readonly ShellMenuGroup[]): ShellMenuSpec[] {
  let left = 1;
  return groups.map((group) => {
    const spec = {
      id: group.id,
      label: group.label,
      left,
      width: group.label.length + 2,
    };
    left += spec.width;
    return spec;
  });
}

/** Move through actionable items, wrapping and skipping disabled rows. */
export function nextShellMenuItem(
  items: readonly ShellMenuItem[],
  current: number,
  delta: number
): number {
  if (items.length === 0) return 0;
  let candidate = current;
  for (let remaining = items.length; remaining > 0; remaining -= 1) {
    candidate = (candidate + delta + items.length) % items.length;
    if (items[candidate]?.enabled !== false) return candidate;
  }
  return Math.max(0, Math.min(current, items.length - 1));
}

export function shellMenuWidth(items: readonly ShellMenuItem[]): number {
  const rowWidth = (item: ShellMenuItem) => {
    // Checked and unavailable rows both render a two-cell non-color marker.
    const marker = item.checked === undefined && item.enabled !== false ? 0 : 2;
    const hint = item.hint === undefined ? 0 : item.hint.length + 2;
    return marker + item.label.length + hint + 4;
  };
  return Math.max(22, ...items.map(rowWidth));
}
