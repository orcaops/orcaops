import { describe, expect, it } from 'vitest';

import type { LayoutSourceAnchor } from './checkpointLayout';
import {
  captureDiffScrollAnchor,
  resolveDiffScrollAnchor,
  restoreDiffScrollAnchor,
} from './diffScrollAnchor';

function indexed(anchors: readonly LayoutSourceAnchor[]) {
  return {
    sourceAnchors: anchors,
    bySourceAnchorKey: new Map(
      anchors.flatMap((anchor) => anchor.keys.map((key) => [key, anchor] as const))
    ),
  };
}

describe('semantic diff scroll anchors', () => {
  it('keeps the source row and wrapped continuation across new geometry', () => {
    const before = indexed([
      { keys: ['file:a:header'], top: 0, height: 3 },
      { keys: ['hunk:a:add:10'], top: 3, height: 5 },
      { keys: ['hunk:a:add:11'], top: 8, height: 1 },
    ]);
    const after = indexed([
      { keys: ['file:a:header'], top: 0, height: 2 },
      { keys: ['hunk:a:add:10'], top: 2, height: 4 },
      { keys: ['hunk:a:add:11'], top: 6, height: 1 },
    ]);

    const anchor = captureDiffScrollAnchor(before, 5);
    expect(anchor).toEqual({ keys: ['hunk:a:add:10'], offset: 2 });
    expect(anchor === null ? null : restoreDiffScrollAnchor(after, anchor)).toBe(4);
  });

  it('maps either side of a split row to its stack-mode row', () => {
    const split = indexed([{ keys: ['hunk:a:delete:7', 'hunk:a:add:9'], top: 12, height: 1 }]);
    const stack = indexed([
      { keys: ['hunk:a:delete:7'], top: 12, height: 1 },
      { keys: ['hunk:a:add:9'], top: 13, height: 1 },
    ]);

    const fromSplit = captureDiffScrollAnchor(split, 12)!;
    expect(restoreDiffScrollAnchor(stack, fromSplit)).toBe(12);
    expect(restoreDiffScrollAnchor(split, { keys: ['hunk:a:add:9'], offset: 0 })).toBe(12);
  });

  it('retains the chosen side through a stack → split → stack round trip', () => {
    const split = indexed([{ keys: ['hunk:a:delete:7', 'hunk:a:add:9'], top: 12, height: 1 }]);
    const stack = indexed([
      { keys: ['hunk:a:delete:7'], top: 12, height: 1 },
      { keys: ['hunk:a:add:9'], top: 13, height: 1 },
    ]);
    const fromAddition = captureDiffScrollAnchor(stack, 13)!;
    const onSplit = resolveDiffScrollAnchor(split, fromAddition)!;
    const recaptured = captureDiffScrollAnchor(split, onSplit.scrollTop, onSplit.key)!;

    expect(recaptured.keys[0]).toBe('hunk:a:add:9');
    expect(resolveDiffScrollAnchor(stack, recaptured)).toEqual({
      scrollTop: 13,
      key: 'hunk:a:add:9',
    });
  });

  it('clamps a continuation when wrapping becomes shorter', () => {
    const before = indexed([{ keys: ['line'], top: 10, height: 8 }]);
    const after = indexed([{ keys: ['line'], top: 20, height: 2 }]);
    const anchor = captureDiffScrollAnchor(before, 17)!;

    expect(restoreDiffScrollAnchor(after, anchor)).toBe(21);
  });

  it('falls back from removed expanded context to its collapsed gap', () => {
    const expanded = indexed([
      { keys: ['gap'], top: 4, height: 1 },
      { keys: ['context:5'], fallbackKeys: ['gap'], top: 5, height: 1 },
    ]);
    const collapsed = indexed([{ keys: ['gap'], top: 9, height: 1 }]);
    const anchor = captureDiffScrollAnchor(expanded, 5)!;

    expect(anchor.keys).toEqual(['context:5', 'gap']);
    expect(restoreDiffScrollAnchor(collapsed, anchor)).toBe(9);
  });

  it('falls back from a removed source row to its hunk, then its owning file', () => {
    const before = indexed([
      { keys: ['hunk:body'], top: 4, height: 8 },
      {
        keys: ['row:removed'],
        fallbackKeys: ['hunk:body', 'file:header'],
        top: 8,
        height: 1,
      },
    ]);
    const sameHunk = indexed([{ keys: ['hunk:body'], top: 14, height: 4 }]);
    const sameFile = indexed([{ keys: ['file:header'], top: 30, height: 1 }]);
    const anchor = captureDiffScrollAnchor(before, 8)!;

    expect(restoreDiffScrollAnchor(sameHunk, anchor)).toBe(14);
    expect(restoreDiffScrollAnchor(sameFile, anchor)).toBe(30);
  });

  it('returns null when no semantic identity survives', () => {
    const anchor = { keys: ['gone'], offset: 0 };
    expect(restoreDiffScrollAnchor(indexed([]), anchor)).toBeNull();
    expect(captureDiffScrollAnchor(indexed([]), 0)).toBeNull();
  });
});
