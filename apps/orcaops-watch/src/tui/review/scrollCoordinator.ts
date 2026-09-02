// The scroll coordinator: ONE owner of the diff column's viewport position.
//
// The renderable exposes a settable `scrollTop`, a readable `scrollHeight`, and
// NO subscription API (ScrollBox.d.ts). So React cannot observe a scroll it did
// not cause — which is why every scroll INTENT has to funnel through here, and
// why the coordinator reconciles from the ref before it computes anything. The
// ref is the truth about where the viewport IS; this module is the truth about
// where it should GO.
//
// The math is pure and lives apart from React on purpose: "page-down moves one
// viewport minus a row, and stops at the bottom" is a statement about numbers.
// Testing it through a mounted component would prove the wiring and leave the
// arithmetic — the part that is actually easy to get wrong — asserted only by
// eyeball.

/** What the viewport can see, and how much there is to see. */
export interface ScrollBounds {
  /** Visible rows. */
  readonly viewport: number;
  /** Total measured rows of the content (CheckpointLayout.totalHeight). */
  readonly content: number;
}

/** A measured band of content — a hunk unit, a slice, a card. */
export interface ScrollTarget {
  readonly top: number;
  readonly height: number;
}

/**
 * The furthest the viewport can scroll: the last row of content sits on the last
 * row of the viewport. Content shorter than the viewport cannot scroll at all —
 * without this floor, `G` on a short page scrolls the content off the top.
 */
export function maxScroll(bounds: ScrollBounds): number {
  return Math.max(0, bounds.content - bounds.viewport);
}

export function clampScroll(top: number, bounds: ScrollBounds): number {
  return Math.max(0, Math.min(Math.round(top), maxScroll(bounds)));
}

/** A relative move (`j`/`k`, page, half-page, wheel), clamped at both ends. */
export function scrollByRows(current: number, delta: number, bounds: ScrollBounds): number {
  return clampScroll(current + delta, bounds);
}

/**
 * Whether a requested destination still needs a React/native scroll commit.
 *
 * Intent fencing and interaction state are separate concerns: a no-distance
 * command can still cancel an older anchor retry, but it must not force another
 * full diff render when the current, planned, and pending destinations already
 * agree. A different pending destination is included because the newer request
 * must supersede the layout-effect write that is already queued.
 */
export function requiresScrollCommit({
  next,
  current,
  planned,
  pending,
}: {
  readonly next: number;
  readonly current: number;
  readonly planned: number;
  readonly pending: number | null;
}): boolean {
  return next !== current || planned !== next || (pending !== null && pending !== next);
}

/**
 * The MINIMAL scroll that brings `target` fully into view.
 *
 * Minimal, not centering: a cursor step to an adjacent row that is already on
 * screen must not move the viewport at all, or reading drifts under the reader's
 * eyes on every keypress. Only when the target is off-screen does the viewport
 * move, and then only far enough.
 *
 * A target TALLER than the viewport cannot be fully shown, so its top wins — the
 * reader gets the start of it rather than an arbitrary middle.
 */
export function scrollToShow(current: number, target: ScrollTarget, bounds: ScrollBounds): number {
  const top = target.top;
  const bottom = target.top + Math.max(1, target.height);

  if (top < current) return clampScroll(top, bounds); // above the fold — pull up to it
  if (bottom > current + bounds.viewport) {
    // Below the fold. Show its end — unless it is taller than the viewport, in
    // which case showing its end would hide its beginning.
    const showEnd = bottom - bounds.viewport;
    return clampScroll(Math.min(showEnd, top), bounds);
  }
  return clampScroll(current, bounds); // already visible — do not move
}

/** `C-l` — explicitly center one measured hunk or source-row target. */
export function scrollToCenter(target: ScrollTarget, bounds: ScrollBounds): number {
  return clampScroll(
    target.top + Math.floor(target.height / 2) - Math.floor(bounds.viewport / 2),
    bounds
  );
}
