import type { ScrollBoxRenderable } from '@opentui/core';
import type { RefObject } from 'react';

/** A ref to a <scrollbox> renderable (exposes a settable `scrollTop`). */
export type ScrollRef = RefObject<ScrollBoxRenderable | null>;

/** Scroll a scrollbox by `delta` lines, clamped at the top. */
export function scrollBy(ref: ScrollRef, delta: number): void {
  const box = ref.current;
  if (box === null) return;
  box.scrollTop = Math.max(0, (box.scrollTop ?? 0) + delta);
}

/** Scroll a scrollbox to an absolute line, clamped at the top. */
export function scrollTo(ref: ScrollRef, top: number): void {
  const box = ref.current;
  if (box === null) return;
  box.scrollTop = Math.max(0, top);
}

/** Full or half page in live native viewport rows; no unsupported OpenTUI unit. */
export function viewportPageRows(viewportRows: number, half = false): number {
  const viewport = Math.max(1, Math.floor(viewportRows));
  return half ? Math.max(1, Math.floor(viewport / 2)) : Math.max(1, viewport - 1);
}

/** Page an ordinary native surface using its current, not mount-time, viewport. */
export function scrollByViewport(ref: ScrollRef, direction: -1 | 1, half = false): void {
  const box = ref.current;
  if (box === null) return;
  scrollBy(ref, direction * viewportPageRows(box.viewport?.height ?? 1, half));
}
