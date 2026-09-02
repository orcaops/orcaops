import type { CheckpointLayout } from './checkpointLayout';

/** A source identity plus the wrapped terminal row within it. */
export interface DiffScrollAnchor {
  readonly keys: readonly string[];
  readonly offset: number;
}

export interface ResolvedDiffScrollAnchor {
  readonly scrollTop: number;
  /** The exact semantic key chosen, retained through a split/stack round trip. */
  readonly key: string;
}

type AnchoredLayout = Pick<CheckpointLayout, 'sourceAnchors' | 'bySourceAnchorKey'>;

/**
 * Capture the semantic row at the top of the viewport.
 *
 * Raw scrollTop is presentation geometry: changing width, wrap, split/stack,
 * expansion, or comment pins invalidates it. These identities are source
 * geometry, so the next layout can put the same line back at the same viewport
 * edge. Anchors are ordered by construction; the last one at/before scrollTop
 * is the most specific row at that position.
 */
export function captureDiffScrollAnchor(
  layout: Pick<AnchoredLayout, 'sourceAnchors'>,
  scrollTop: number,
  preferredKey?: string | null
): DiffScrollAnchor | null {
  const anchors = layout.sourceAnchors;
  if (anchors.length === 0) return null;

  const at = Math.max(0, scrollTop);
  let lo = 0;
  let hi = anchors.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = anchors[mid]!;
    if (candidate.top <= at) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const anchor = anchors[Math.max(0, found)]!;
  const exactKeys =
    preferredKey !== null && preferredKey !== undefined && anchor.keys.includes(preferredKey)
      ? [preferredKey, ...anchor.keys.filter((key) => key !== preferredKey)]
      : anchor.keys;
  return {
    keys: [...exactKeys, ...(anchor.fallbackKeys ?? [])],
    offset: Math.max(0, at - anchor.top),
  };
}

/** Resolve a captured source identity into the newly measured terminal geometry. */
export function resolveDiffScrollAnchor(
  layout: Pick<AnchoredLayout, 'bySourceAnchorKey'>,
  anchor: DiffScrollAnchor
): ResolvedDiffScrollAnchor | null {
  for (const key of anchor.keys) {
    const target = layout.bySourceAnchorKey.get(key);
    if (target === undefined) continue;
    // Preserve the wrapped continuation row when it still exists. If a wider
    // viewport shortened the source line, clamp to its final visible row.
    return {
      scrollTop: target.top + Math.min(anchor.offset, Math.max(0, target.height - 1)),
      key,
    };
  }
  return null;
}

/** Convenience for callers that do not need to retain split/stack side preference. */
export function restoreDiffScrollAnchor(
  layout: Pick<AnchoredLayout, 'bySourceAnchorKey'>,
  anchor: DiffScrollAnchor
): number | null {
  return resolveDiffScrollAnchor(layout, anchor)?.scrollTop ?? null;
}
