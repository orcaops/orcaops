// Snapshot-chain builder — the ordered boundary-tree lineage attribution walks.
//
// The engine stays pure: it receives normalized checkpoint descriptors (the
// sidecar maps storage's Checkpoint → these, sourcing the boundary tree shas
// from the checkpoint projection) plus the base and pinned worktree tree
// shas, and produces the ordered segment lineage. The sidecar then materializes
// that lineage (one commit per segment) and blames it; the engine consumes the
// per-line result (see `attribution.ts`).
//
// Ordering rule: checkpoints sort by `(closedAt, artifact, n)`. Between
// consecutive endpoints that are NOT tree-contiguous (`close_n != open_{n+1}`)
// an uncaptured GAP segment is interleaved; a leading gap covers base →
// first-open, and a trailing gap covers last-close → worktree (post-capture
// drift). Abandoned and still-open checkpoints, and any closed checkpoint whose
// boundary trees are missing, are excluded from the chain (their share reads as
// gap / disclosed) — never silently folded in.

/**
 * A checkpoint as the attribution engine needs it. The sidecar normalizes
 * storage's richer `Checkpoint` into this, reading `openTreeSha`/`closeTreeSha`
 * from the projection's `open_snapshot`/`close_snapshot.tree_sha`.
 */
export interface CheckpointDescriptor {
  artifact: string;
  n: number;
  /** Boundary tree shas; null when that snapshot failed at capture. */
  openTreeSha: string | null;
  closeTreeSha: string | null;
  /** ISO close timestamp — the primary chain sort key. Null sorts last. */
  closedAt: string | null;
  /** Only `closed` participates; `open`/`abandoned` are excluded from the chain. */
  status: 'closed' | 'open' | 'abandoned';
}

/** Owner of a segment: a captured checkpoint, or an uncaptured gap. */
export type SegmentOwner =
  | { kind: 'checkpoint'; artifact: string; cp: number }
  | { kind: 'gap'; segment: string };

export interface CheckpointSegment {
  index: number;
  id: string;
  kind: 'checkpoint';
  openTree: string;
  closeTree: string;
  owner: { kind: 'checkpoint'; artifact: string; cp: number };
}

export interface GapSegment {
  index: number;
  id: string;
  kind: 'gap';
  openTree: string;
  closeTree: string;
  owner: { kind: 'gap'; segment: string };
}

export type ChainSegment = CheckpointSegment | GapSegment;

export interface ExcludedCheckpoint {
  artifact: string;
  n: number;
  reason: 'abandoned' | 'open' | 'missing_trees';
}

export interface Chain {
  /** The diff base tree (merge-base or oldest artifact base). */
  base: string;
  /** The pinned live worktree tree. */
  worktree: string;
  /** Ordered lineage: base → …segments… → worktree. */
  segments: ChainSegment[];
  /** Checkpoints kept out of the chain, with why — surfaced as disclosure. */
  excluded: ExcludedCheckpoint[];
}

export interface BuildChainInput {
  base: string;
  worktree: string;
  checkpoints: readonly CheckpointDescriptor[];
}

/** Chronological sort: `(closedAt, artifact, n)`; null `closedAt` sorts last. */
function compareCheckpoints(a: CheckpointDescriptor, b: CheckpointDescriptor): number {
  if (a.closedAt !== b.closedAt) {
    if (a.closedAt === null) return 1;
    if (b.closedAt === null) return -1;
    if (a.closedAt < b.closedAt) return -1;
    if (a.closedAt > b.closedAt) return 1;
  }
  if (a.artifact !== b.artifact) return a.artifact < b.artifact ? -1 : 1;
  return a.n - b.n;
}

function cpLabel(cp: CheckpointDescriptor): string {
  return `${cp.artifact}:cp${cp.n}`;
}

/**
 * Build the ordered boundary-tree lineage. Deterministic and pure; the only
 * inputs are tree shas + checkpoint metadata.
 */
export function buildChain(input: BuildChainInput): Chain {
  const excluded: ExcludedCheckpoint[] = [];
  const usable: CheckpointDescriptor[] = [];

  for (const cp of input.checkpoints) {
    if (cp.status === 'abandoned') {
      excluded.push({ artifact: cp.artifact, n: cp.n, reason: 'abandoned' });
      continue;
    }
    if (cp.status === 'open') {
      excluded.push({ artifact: cp.artifact, n: cp.n, reason: 'open' });
      continue;
    }
    if (cp.openTreeSha === null || cp.closeTreeSha === null) {
      excluded.push({ artifact: cp.artifact, n: cp.n, reason: 'missing_trees' });
      continue;
    }
    usable.push(cp);
  }

  usable.sort(compareCheckpoints);

  const segments: ChainSegment[] = [];
  let prevTree = input.base;
  let prevEndpoint = 'base';

  const push = (seg: Omit<ChainSegment, 'index' | 'id'>): void => {
    const index = segments.length;
    segments.push({ ...seg, index, id: `seg_${index}` } as ChainSegment);
  };

  for (const cp of usable) {
    const openTree = cp.openTreeSha as string;
    const closeTree = cp.closeTreeSha as string;

    // Uncaptured work between the previous endpoint and this checkpoint's open.
    if (openTree !== prevTree) {
      push({
        kind: 'gap',
        openTree: prevTree,
        closeTree: openTree,
        owner: { kind: 'gap', segment: `${prevEndpoint}->${cpLabel(cp)}.open` },
      });
    }

    push({
      kind: 'checkpoint',
      openTree,
      closeTree,
      owner: { kind: 'checkpoint', artifact: cp.artifact, cp: cp.n },
    });

    prevTree = closeTree;
    prevEndpoint = cpLabel(cp);
  }

  // Post-capture drift: last close → the pinned worktree.
  if (input.worktree !== prevTree) {
    push({
      kind: 'gap',
      openTree: prevTree,
      closeTree: input.worktree,
      owner: { kind: 'gap', segment: `${prevEndpoint}->worktree` },
    });
  }

  return { base: input.base, worktree: input.worktree, segments, excluded };
}

/**
 * Map a blamed segment index back to its owner. `'base'` (or an out-of-range
 * index) means the line predates the chain — unchanged context, excluded from
 * review-diff attribution.
 */
export function segmentOwner(chain: Chain, segmentIndex: number | 'base'): SegmentOwner | null {
  if (segmentIndex === 'base') return null;
  const seg = chain.segments[segmentIndex];
  return seg ? seg.owner : null;
}
