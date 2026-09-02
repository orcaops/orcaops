import { describe, expect, it } from 'vitest';

import {
  type CurrentDiffIndex,
  isTrivialAnchorBody,
  openCommentCount,
  ownOpenCommentCountForCheckpoint,
  REANCHOR_RUNG,
  reanchorComment,
  replayComments,
} from './comments.js';
import { COMMENT_STATUS } from './enums.js';
import { type CommentAnchor, type CommentEvent, commentEventSchema } from './schema.js';

type DiffLineAnchor = Extract<CommentAnchor, { kind: 'DIFF_LINE' }>;
type DiffRangeAnchor = Extract<CommentAnchor, { kind: 'DIFF_RANGE' }>;

const anchor = (over: Partial<DiffLineAnchor> = {}): DiffLineAnchor => ({
  kind: 'DIFF_LINE',
  file: 'src/a.ts',
  side: 'add',
  line: 10,
  lineHash: 'h_target',
  hunkKey: 'hunk_1',
  threadKey: 'sec_1',
  ...over,
});

const add = (id: string, ts: string, over: Partial<CommentEvent> = {}): CommentEvent =>
  ({
    type: 'add',
    comment_id: id,
    ts,
    author: 'reviewer',
    body: `body of ${id}`,
    anchor: anchor(),
    ...over,
  }) as CommentEvent;

describe('replayComments', () => {
  it('folds add → reply → status into one record, replies in ts order', () => {
    const events: CommentEvent[] = [
      add('c1', '2026-07-09T00:00:00Z'),
      {
        type: 'reply',
        comment_id: 'c1',
        ts: '2026-07-09T00:02:00Z',
        author: 'agent',
        body: 'fixed in cp5',
        checkpoint_ref: { artifact: 'a1', cp: 5 },
      },
      {
        type: 'status',
        comment_id: 'c1',
        ts: '2026-07-09T00:03:00Z',
        author: 'agent',
        status: COMMENT_STATUS.RESOLVED,
      },
    ];
    const records = replayComments(events);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      comment_id: 'c1',
      status: 'resolved',
      replies: [
        { author: 'agent', body: 'fixed in cp5', checkpoint_ref: { artifact: 'a1', cp: 5 } },
      ],
    });
  });

  it('orders numerically on ts and skips a reply/status with no add (torn add)', () => {
    const events: CommentEvent[] = [
      // Arrives later in the file but earlier in time — numeric sort restores order.
      {
        type: 'status',
        comment_id: 'c1',
        ts: '2026-07-09T00:00:05.500Z',
        author: 'reviewer',
        status: COMMENT_STATUS.RESOLVED,
      },
      add('c1', '2026-07-09T00:00:05Z'),
      {
        type: 'reply',
        comment_id: 'ghost',
        ts: '2026-07-09T00:00:06Z',
        author: 'agent',
        body: 'x',
      },
    ];
    const records = replayComments(events);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('resolved');
  });

  it('counts open comments overall', () => {
    const records = replayComments([
      add('c1', '2026-07-09T00:00:00Z'),
      add('c2', '2026-07-09T00:00:01Z', {
        author: 'agent',
      } as Partial<CommentEvent>),
      add('c3', '2026-07-09T00:00:02Z', {
        anchor: anchor({ threadKey: 'sec_2' }),
      } as Partial<CommentEvent>),
      {
        type: 'status',
        comment_id: 'c3',
        ts: '2026-07-09T00:00:03Z',
        author: 'reviewer',
        status: COMMENT_STATUS.RESOLVED,
      },
    ]);
    expect(openCommentCount(records)).toBe(2); // c1 + c2
  });

  it('gates only the exact resolved checkpoint owner, never the whole thread', () => {
    const [first, second, unresolved] = replayComments([
      add('c1', '2026-07-09T00:00:00Z'),
      add('c2', '2026-07-09T00:00:01Z'),
      add('c3', '2026-07-09T00:00:02Z'),
    ]);
    const records = [
      { ...first!, owner: { artifact: 'artifact-a', cp: 1 } },
      { ...second!, owner: { artifact: 'artifact-a', cp: 2 } },
      { ...unresolved!, owner: null },
    ];

    expect(ownOpenCommentCountForCheckpoint(records, { artifact: 'artifact-a', cp: 1 })).toBe(1);
    expect(ownOpenCommentCountForCheckpoint(records, { artifact: 'artifact-a', cp: 2 })).toBe(1);
    expect(ownOpenCommentCountForCheckpoint(records, { artifact: 'artifact-a', cp: 3 })).toBe(0);
  });

  it('does not infer final anchor kinds from unsupported flat anchors', () => {
    const oldLine = add('legacy-line', '2026-07-09T00:00:00Z', {
      anchor: {
        file: 'src/a.ts',
        side: 'add',
        line: 10,
        lineHash: 'h_target',
        hunkKey: 'hunk_1',
      },
    } as Partial<CommentEvent>);
    const oldRange = add('legacy-range', '2026-07-09T00:00:01Z', {
      anchor: {
        file: 'src/a.ts',
        side: 'add',
        line: 10,
        endLine: 11,
        lineHash: 'h_target',
        lineHashes: ['h_target', 'h_other'],
        hunkKey: 'hunk_1',
      },
    } as Partial<CommentEvent>);
    expect(commentEventSchema.safeParse(oldLine).success).toBe(false);
    expect(commentEventSchema.safeParse(oldRange).success).toBe(false);
  });
});

describe('isTrivialAnchorBody', () => {
  it('flags closers, blanks, and punctuation-only lines; keeps real code', () => {
    expect(isTrivialAnchorBody('}')).toBe(true);
    expect(isTrivialAnchorBody('  });')).toBe(true);
    expect(isTrivialAnchorBody('')).toBe(true);
    expect(isTrivialAnchorBody('  ')).toBe(true);
    expect(isTrivialAnchorBody('</>')).toBe(true);
    expect(isTrivialAnchorBody('const x = 1;')).toBe(false);
    expect(isTrivialAnchorBody('return early')).toBe(false);
  });
});

describe('reanchorComment — the ladder', () => {
  const index = (over: Partial<CurrentDiffIndex> = {}): CurrentDiffIndex => ({
    lines: [
      { file: 'src/a.ts', side: 'add', line: 14, lineHash: 'h_target', hunkKey: 'hunk_1' },
      { file: 'src/a.ts', side: 'add', line: 40, lineHash: 'h_other', hunkKey: 'hunk_2' },
    ],
    hunkKeys: new Set(['hunk_1', 'hunk_2']),
    files: new Set(['src/a.ts']),
    threadKeys: new Set(['sec_1']),
    ...over,
  });

  it('line rung: a unique content match follows the moved line — not drift', () => {
    const pos = reanchorComment(anchor({ line: 10 }), index());
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.LINE, line: 14, drifted: false });
  });

  it('line rung: an ambiguous (trivial) hash is trusted only inside its own hunk', () => {
    const idx = index({
      lines: [
        { file: 'src/a.ts', side: 'add', line: 12, lineHash: 'h_target', hunkKey: 'hunk_1' },
        { file: 'src/a.ts', side: 'add', line: 90, lineHash: 'h_target', hunkKey: 'hunk_2' },
      ],
    });
    const pos = reanchorComment(anchor({ line: 10 }), idx);
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.LINE, line: 12, hunkKey: 'hunk_1' });
  });

  it('hunk rung, native: ambiguous hash with no in-hunk match anchors at the hunk, not drifted', () => {
    const idx = index({
      lines: [
        { file: 'src/a.ts', side: 'add', line: 12, lineHash: 'h_target', hunkKey: 'hunk_2' },
        { file: 'src/a.ts', side: 'add', line: 90, lineHash: 'h_target', hunkKey: null },
      ],
    });
    const pos = reanchorComment(anchor(), idx);
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.HUNK, hunkKey: 'hunk_1', drifted: false });
  });

  it('hunk rung, drifted: the hashed content is gone but the hunk survives', () => {
    const idx = index({ lines: [] });
    const pos = reanchorComment(anchor(), idx);
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.HUNK, hunkKey: 'hunk_1', drifted: true });
  });

  it('file rung: hash and hunk both gone, file still in the diff', () => {
    const idx = index({ lines: [], hunkKeys: new Set(['hunk_9']) });
    const pos = reanchorComment(anchor(), idx);
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.FILE, file: 'src/a.ts', drifted: true });
  });

  it('section rung: file gone too — renders in the section header area', () => {
    const idx = index({ lines: [], hunkKeys: new Set(), files: new Set() });
    const pos = reanchorComment(anchor(), idx);
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.SECTION, threadKey: 'sec_1', drifted: true });
  });

  it('unanchored: nothing resolves, but the comment is never dropped', () => {
    const idx = index({
      lines: [],
      hunkKeys: new Set(),
      files: new Set(),
      threadKeys: new Set(),
    });
    const pos = reanchorComment(anchor(), idx);
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.UNANCHORED, drifted: true });
  });

  it('single-line anchors carry endLine: null on every rung', () => {
    expect(reanchorComment(anchor({ line: 10 }), index()).endLine).toBeNull();
    expect(reanchorComment(anchor(), index({ lines: [] })).endLine).toBeNull();
  });
});

describe('reanchorComment — range anchors (monotonic per-hunk resolution)', () => {
  const line = (n: number, hash: string, hunkKey: string | null = 'hunk_1') => ({
    file: 'src/a.ts',
    side: 'add' as const,
    line: n,
    lineHash: hash,
    hunkKey,
  });
  const range = (over: Partial<DiffRangeAnchor> = {}): DiffRangeAnchor => ({
    kind: 'DIFF_RANGE',
    file: 'src/a.ts',
    side: 'add',
    line: 10,
    endLine: 12,
    lineHash: 'h_1',
    lineHashes: ['h_1', 'h_2', 'h_3'],
    hunkKey: 'hunk_1',
    threadKey: 'sec_1',
    ...over,
  });
  const index = (
    lines: CurrentDiffIndex['lines'],
    over: Partial<CurrentDiffIndex> = {}
  ): CurrentDiffIndex => ({
    lines,
    hunkKeys: new Set(['hunk_1', 'hunk_2']),
    files: new Set(['src/a.ts']),
    threadKeys: new Set(['sec_1']),
    ...over,
  });

  it('fully survives: rung LINE, no drift, line/endLine clamp the resolved span', () => {
    const pos = reanchorComment(
      range(),
      index([line(20, 'h_1'), line(21, 'h_2'), line(22, 'h_3')])
    );
    expect(pos).toMatchObject({
      rung: REANCHOR_RUNG.LINE,
      line: 20,
      endLine: 22,
      hunkKey: 'hunk_1',
      drifted: false,
    });
  });

  it('partially survives: min/max of the resolved lines, drifted true', () => {
    const pos = reanchorComment(range(), index([line(20, 'h_1'), line(25, 'h_3')]));
    expect(pos).toMatchObject({
      rung: REANCHOR_RUNG.LINE,
      line: 20,
      endLine: 25,
      drifted: true,
    });
  });

  it('a single surviving line resolves with endLine: null (not a degenerate range)', () => {
    const pos = reanchorComment(range(), index([line(31, 'h_2')]));
    expect(pos).toMatchObject({
      rung: REANCHOR_RUNG.LINE,
      line: 31,
      endLine: null,
      drifted: true,
    });
  });

  it('zero resolutions fall to the hunk rung via anchor.hunkKey, drifted', () => {
    const pos = reanchorComment(range(), index([line(20, 'h_other')]));
    expect(pos).toMatchObject({
      rung: REANCHOR_RUNG.HUNK,
      hunkKey: 'hunk_1',
      line: null,
      endLine: null,
      drifted: true,
    });
  });

  it('zero resolutions and no live hunk fall to the file rung', () => {
    const pos = reanchorComment(range(), index([], { hunkKeys: new Set() }));
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.FILE, file: 'src/a.ts', drifted: true });
  });

  it('duplicate hashes resolve monotonically (positionally), not set-wise', () => {
    // `}` + blank + `}` — h_close appears twice; each occurrence binds its own
    // line at a strictly increasing position instead of double-counting one.
    const pos = reanchorComment(
      range({ lineHash: 'h_close', lineHashes: ['h_close', 'h_blank', 'h_close'] }),
      index([line(5, 'h_close'), line(6, 'h_blank'), line(7, 'h_close')])
    );
    expect(pos).toMatchObject({
      rung: REANCHOR_RUNG.LINE,
      line: 5,
      endLine: 7,
      drifted: false,
    });
  });

  it('never splits: two hunks each matching some hashes → one winner, clamped', () => {
    const pos = reanchorComment(
      range(),
      index([line(20, 'h_1', 'hunk_1'), line(21, 'h_2', 'hunk_1'), line(90, 'h_3', 'hunk_2')])
    );
    // hunk_1 resolves 2 of 3 (the most) — the range clamps inside it alone.
    expect(pos).toMatchObject({
      rung: REANCHOR_RUNG.LINE,
      line: 20,
      endLine: 21,
      hunkKey: 'hunk_1',
      drifted: true,
    });
  });

  it('resolution-count tie breaks to the hunk that resolved lineHashes[0]', () => {
    const pos = reanchorComment(
      range(),
      index([
        line(20, 'h_2', 'hunk_1'),
        line(21, 'h_3', 'hunk_1'),
        line(90, 'h_1', 'hunk_2'),
        line(91, 'h_2', 'hunk_2'),
      ])
    );
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.LINE, line: 90, hunkKey: 'hunk_2' });
  });

  it('full tie (count + first hash) breaks to the lowest resolved start line', () => {
    const pos = reanchorComment(
      range({ lineHashes: ['h_1', 'h_2'], endLine: 11 }),
      index([
        line(90, 'h_1', 'hunk_2'),
        line(91, 'h_2', 'hunk_2'),
        line(20, 'h_1', 'hunk_1'),
        line(21, 'h_2', 'hunk_1'),
      ])
    );
    expect(pos).toMatchObject({ rung: REANCHOR_RUNG.LINE, line: 20, hunkKey: 'hunk_1' });
  });
});

describe('reanchorComment — unchanged context', () => {
  const baseIndex: CurrentDiffIndex = {
    lines: [],
    hunkKeys: new Set(),
    files: new Set(),
    threadKeys: new Set(['sec_1']),
    contextLines: [
      {
        file: 'src/context.ts',
        headBlobOid: 'blob_1',
        line: 14,
        lineHash: 'context_hash',
      },
    ],
  };

  it('routes unchanged context against the pinned blob without changed-line styling', () => {
    expect(
      reanchorComment(
        {
          kind: 'UNCHANGED_CONTEXT_LINE',
          file: 'src/context.ts',
          headBlobOid: 'blob_1',
          line: 10,
          lineHash: 'context_hash',
          threadKey: 'sec_1',
        },
        baseIndex
      )
    ).toMatchObject({
      rung: REANCHOR_RUNG.UNCHANGED_CONTEXT,
      file: 'src/context.ts',
      side: null,
      line: 14,
      drifted: false,
    });
  });
});
