// The app-owned one-row labels on a parent hunk. Each is priced by
// checkpointLayout at EXACTLY one row, so each is truncated here rather than left
// to wrap: an owner list is unbounded, and a wrapped label silently drifts the
// measured geometry (and with it Walk's rowWindow spacers). Pure and headless so
// the one-row guarantee is a test, not a hope.

import { truncate } from '../layout';

/** The collapsed row for a hunk this page doesn't own — advertises `z`. */
export function hiddenHunkLabel(input: {
  collapsedBefore: number;
  added: number;
  removed: number;
  owners: readonly string[];
  width: number;
}): string {
  const context = input.collapsedBefore > 0 ? `${input.collapsedBefore} unchanged + ` : '';
  const owners = input.owners.length > 0 ? ` · ${input.owners.join(', ')}` : '';
  return truncate(
    `▾ z · ${context}hunk hidden · +${input.added} −${input.removed}${owners}`,
    input.width
  );
}

/** The re-collapse affordance on an expanded hidden hunk. */
export function hideHunkLabel(width: number): string {
  return truncate('▴ hidden hunk · hide', width);
}

/** The `i`-toggled explanation of whose work the subdued cells in a hunk are. */
export function subduedContextLabel(owners: readonly string[], width: number): string {
  return truncate(`↳ subdued context · ${owners.join(', ')}`, width);
}
