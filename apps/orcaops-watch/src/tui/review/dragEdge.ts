export type DiffDragEdgeDirection = -1 | 1;

/** Classify a pointer inside the live diff viewport; never infer from terminal height. */
export function diffDragEdgeDirection({
  pointerY,
  viewportTop,
  viewportHeight,
  edgeRows = 2,
}: {
  pointerY: number;
  viewportTop: number;
  viewportHeight: number;
  edgeRows?: number;
}): DiffDragEdgeDirection | null {
  const height = Math.max(1, Math.floor(viewportHeight));
  const threshold = Math.max(1, Math.min(Math.floor(edgeRows), Math.ceil(height / 2)));
  if (pointerY < viewportTop || pointerY >= viewportTop + height) return null;
  if (pointerY < viewportTop + threshold) return -1;
  if (pointerY >= viewportTop + height - threshold) return 1;
  return null;
}
