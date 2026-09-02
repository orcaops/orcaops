import { describe, expect, it } from 'vitest';

import { buildChain, type CheckpointDescriptor, segmentOwner } from './chain.js';

const A = '019f354d';

// Boundary trees for a seven-checkpoint lineage. Each checkpoint's
// open/close tree, with cp2.close == cp3.open and cp4.close == cp5.open
// contiguous (no gap), and four uncaptured-work gaps.
const CPS: CheckpointDescriptor[] = [
  {
    artifact: A,
    n: 1,
    openTreeSha: 'af24448',
    closeTreeSha: '5889902',
    closedAt: '2026-07-01T00:01:00.000Z',
    status: 'closed',
  },
  {
    artifact: A,
    n: 2,
    openTreeSha: 'f0708b3',
    closeTreeSha: '2342739',
    closedAt: '2026-07-01T00:02:00.000Z',
    status: 'closed',
  },
  {
    artifact: A,
    n: 3,
    openTreeSha: '2342739',
    closeTreeSha: '2b9ec35',
    closedAt: '2026-07-01T00:03:00.000Z',
    status: 'closed',
  },
  {
    artifact: A,
    n: 4,
    openTreeSha: 'f93ae11',
    closeTreeSha: '17bad42',
    closedAt: '2026-07-01T00:04:00.000Z',
    status: 'closed',
  },
  {
    artifact: A,
    n: 5,
    openTreeSha: '17bad42',
    closeTreeSha: '3f66d98',
    closedAt: '2026-07-01T00:05:00.000Z',
    status: 'closed',
  },
  {
    artifact: A,
    n: 6,
    openTreeSha: '615f384',
    closeTreeSha: 'e8a4a8b',
    closedAt: '2026-07-01T00:06:00.000Z',
    status: 'closed',
  },
  {
    artifact: A,
    n: 7,
    openTreeSha: '8738178',
    closeTreeSha: '4576eac',
    closedAt: '2026-07-01T00:07:00.000Z',
    status: 'closed',
  },
];

const shuffled = [CPS[3], CPS[0], CPS[6], CPS[2], CPS[5], CPS[1], CPS[4]];

describe('buildChain — interleaved checkpoint lineage', () => {
  const chain = buildChain({ base: 'af24448', worktree: '4576eac', checkpoints: shuffled });

  it('produces 11 segments: 7 checkpoint + 4 gap (base==cp1.open, worktree==cp7.close)', () => {
    expect(chain.segments).toHaveLength(11);
    expect(chain.segments.filter((s) => s.kind === 'checkpoint')).toHaveLength(7);
    expect(chain.segments.filter((s) => s.kind === 'gap')).toHaveLength(4);
  });

  it('orders the lineage: checkpoints chronological, gaps interleaved', () => {
    const summary = chain.segments.map((s) =>
      s.kind === 'checkpoint' ? `cp${s.owner.cp}` : `gap(${s.openTree}->${s.closeTree})`
    );
    expect(summary).toEqual([
      'cp1',
      'gap(5889902->f0708b3)', // cp1.close -> cp2.open
      'cp2',
      'cp3', // contiguous with cp2 — no gap
      'gap(2b9ec35->f93ae11)', // cp3.close -> cp4.open
      'cp4',
      'cp5', // contiguous with cp4 — no gap
      'gap(3f66d98->615f384)', // cp5.close -> cp6.open
      'cp6',
      'gap(e8a4a8b->8738178)', // cp6.close -> cp7.open
      'cp7',
    ]);
  });

  it('reconstructs the lineage exactly: each segment.open == previous segment.close, tip == worktree', () => {
    let prev = chain.base;
    for (const seg of chain.segments) {
      expect(seg.openTree).toBe(prev);
      prev = seg.closeTree;
    }
    expect(prev).toBe(chain.worktree);
  });

  it('labels gap owners by their surrounding endpoints', () => {
    const firstGap = chain.segments.find((s) => s.kind === 'gap');
    expect(firstGap?.owner).toEqual({ kind: 'gap', segment: `${A}:cp1->${A}:cp2.open` });
  });

  it('resolves segment owners; base/out-of-range → null (unchanged context)', () => {
    const cp7Seg = chain.segments.at(-1)!;
    expect(segmentOwner(chain, cp7Seg.index)).toEqual({ kind: 'checkpoint', artifact: A, cp: 7 });
    expect(segmentOwner(chain, 'base')).toBeNull();
    expect(segmentOwner(chain, 999)).toBeNull();
  });
});

describe('buildChain — leading + trailing gaps', () => {
  it('adds a leading gap when base != first open, and a trailing gap for worktree drift', () => {
    const chain = buildChain({
      base: 'BASE',
      worktree: 'WORK',
      checkpoints: [
        {
          artifact: A,
          n: 1,
          openTreeSha: 'O1',
          closeTreeSha: 'C1',
          closedAt: '2026-07-01T00:01:00.000Z',
          status: 'closed',
        },
      ],
    });
    const kinds = chain.segments.map((s) => s.kind);
    expect(kinds).toEqual(['gap', 'checkpoint', 'gap']); // base->O1, cp1, C1->WORK
    expect(chain.segments[0].owner).toEqual({ kind: 'gap', segment: `base->${A}:cp1.open` });
    expect(chain.segments[2].owner).toEqual({ kind: 'gap', segment: `${A}:cp1->worktree` });
  });
});

describe('buildChain — exclusions', () => {
  it('excludes abandoned / open / missing-tree checkpoints from the chain, recording why', () => {
    const chain = buildChain({
      base: 'af24448',
      worktree: '5889902',
      checkpoints: [
        {
          artifact: A,
          n: 1,
          openTreeSha: 'af24448',
          closeTreeSha: '5889902',
          closedAt: '2026-07-01T00:01:00.000Z',
          status: 'closed',
        },
        {
          artifact: A,
          n: 2,
          openTreeSha: 'x',
          closeTreeSha: 'y',
          closedAt: '2026-07-01T00:02:00.000Z',
          status: 'abandoned',
        },
        {
          artifact: A,
          n: 3,
          openTreeSha: null,
          closeTreeSha: null,
          closedAt: null,
          status: 'open',
        },
        {
          artifact: A,
          n: 4,
          openTreeSha: null,
          closeTreeSha: 'z',
          closedAt: '2026-07-01T00:04:00.000Z',
          status: 'closed',
        },
      ],
    });
    expect(chain.segments).toHaveLength(1);
    expect(chain.segments[0].kind).toBe('checkpoint');
    expect(chain.excluded).toEqual([
      { artifact: A, n: 2, reason: 'abandoned' },
      { artifact: A, n: 3, reason: 'open' },
      { artifact: A, n: 4, reason: 'missing_trees' },
    ]);
  });

  it('handles an empty chain (no usable checkpoints) as a single base->worktree gap', () => {
    const chain = buildChain({
      base: 'BASE',
      worktree: 'WORK',
      checkpoints: [
        {
          artifact: A,
          n: 1,
          openTreeSha: 'x',
          closeTreeSha: 'y',
          closedAt: null,
          status: 'abandoned',
        },
      ],
    });
    expect(chain.segments).toHaveLength(1);
    expect(chain.segments[0].kind).toBe('gap');
    expect(chain.excluded).toHaveLength(1);
  });

  it('produces no segments when base == worktree and there are no checkpoints', () => {
    const chain = buildChain({ base: 'SAME', worktree: 'SAME', checkpoints: [] });
    expect(chain.segments).toEqual([]);
  });
});

describe('buildChain — multi-artifact interleave', () => {
  it('interleaves checkpoints from different artifacts by closedAt', () => {
    const B = '019f3663';
    const chain = buildChain({
      base: 'T0',
      worktree: 'T4',
      checkpoints: [
        {
          artifact: B,
          n: 1,
          openTreeSha: 'T1',
          closeTreeSha: 'T2',
          closedAt: '2026-07-01T00:02:00.000Z',
          status: 'closed',
        },
        {
          artifact: A,
          n: 1,
          openTreeSha: 'T0',
          closeTreeSha: 'T1',
          closedAt: '2026-07-01T00:01:00.000Z',
          status: 'closed',
        },
        {
          artifact: B,
          n: 2,
          openTreeSha: 'T2',
          closeTreeSha: 'T4',
          closedAt: '2026-07-01T00:03:00.000Z',
          status: 'closed',
        },
      ],
    });
    const owners = chain.segments.map((s) =>
      s.kind === 'checkpoint' ? `${s.owner.artifact}:cp${s.owner.cp}` : 'gap'
    );
    expect(owners).toEqual([`${A}:cp1`, `${B}:cp1`, `${B}:cp2`]); // chronological across threads, fully contiguous
  });
});
