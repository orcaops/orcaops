import { describe, expect, it } from 'vitest';

import {
  detectWindowOverlap,
  scanCheckpointIntervals,
  type WindowScanEvent,
} from './window-overlap.js';

// Synthetic event builders mirroring hwm-baseline.test.ts — only the
// fields the scan actually reads, plus the overlap-specific extras
// (open_snapshot trees, files_changed claims).
const opened = (n: number, tree: string | null = `O${n}`): WindowScanEvent => ({
  record: { type: 'checkpoint_opened' },
  payload: { n, open_snapshot: { tree_sha: tree } },
});
const closed = (n: number, tree: string | null, filesChanged: string[] = []): WindowScanEvent => ({
  record: { type: 'checkpoint_closed' },
  payload: { n, close_snapshot: { tree_sha: tree }, files_changed: filesChanged },
});
const abandoned = (n: number, tree: string | null): WindowScanEvent => ({
  record: { type: 'checkpoint_abandoned' },
  payload: { n, abandon_snapshot: { tree_sha: tree } },
});

describe('scanCheckpointIntervals', () => {
  it('folds open/close into one interval with claims and both boundary trees', () => {
    const byN = scanCheckpointIntervals([opened(1, 'O1'), closed(1, 'C1', ['a.ts'])]);
    expect(byN.get(1)).toEqual({
      n: 1,
      openIdx: 0,
      endIdx: 1,
      status: 'closed',
      terminalTreeSha: 'C1',
      openTreeSha: 'O1',
      filesChanged: ['a.ts'],
    });
  });

  it('keeps the EARLIEST open and ignores a close with no prior open', () => {
    const byN = scanCheckpointIntervals([
      opened(1, 'O1a'),
      opened(1, 'O1b'),
      closed(2, 'C2', ['ghost.ts']),
    ]);
    expect(byN.get(1)?.openIdx).toBe(0);
    expect(byN.get(1)?.openTreeSha).toBe('O1a');
    expect(byN.has(2)).toBe(false);
  });

  it('records abandon as finalized with the abandon tree and no claims', () => {
    const byN = scanCheckpointIntervals([opened(1), abandoned(1, 'TA1')]);
    expect(byN.get(1)?.status).toBe('abandoned');
    expect(byN.get(1)?.terminalTreeSha).toBe('TA1');
    expect(byN.get(1)?.filesChanged).toEqual([]);
  });
});

describe('detectWindowOverlap', () => {
  it('returns null for a serial chain (no interval intersection)', () => {
    // cp1 opened+closed strictly before cp2 opened — the everyday path.
    const events = [opened(1), closed(1, 'C1', ['a.ts']), opened(2)];
    expect(detectWindowOverlap(events, 2, 2)).toBeNull();
  });

  it('returns null when closing the only checkpoint', () => {
    expect(detectWindowOverlap([opened(1)], 1, 0)).toBeNull();
  });

  it('detects a live overlap (sibling still open) with open-ended interval', () => {
    const events = [opened(1, 'O1'), opened(2, 'O2')];
    const ctx = detectWindowOverlap(events, 1, 0);
    expect(ctx).not.toBeNull();
    expect(ctx?.siblings).toEqual([{ n: 2, status: 'open', filesChanged: [] }]);
    // Boundaries: cp1.open, cp2.open — ordered by event index; cp1's own
    // close is supplied later by the close callback.
    expect(ctx?.boundaries).toEqual([
      { eventIdx: 0, n: 1, phase: 'open', treeSha: 'O1' },
      { eventIdx: 1, n: 2, phase: 'open', treeSha: 'O2' },
    ]);
    expect(ctx?.currentCloseIdx).toBe(2);
  });

  it('detects historical overlap: sibling closed first, with its claim and close boundary', () => {
    // A(1) opens, B(2) opens, B closes claiming b.ts, now A closes.
    const events = [opened(1, 'O1'), opened(2, 'O2'), closed(2, 'C2', ['b.ts'])];
    const ctx = detectWindowOverlap(events, 1, 0);
    expect(ctx?.siblings).toEqual([{ n: 2, status: 'closed', filesChanged: ['b.ts'] }]);
    expect(ctx?.boundaries).toEqual([
      { eventIdx: 0, n: 1, phase: 'open', treeSha: 'O1' },
      { eventIdx: 1, n: 2, phase: 'open', treeSha: 'O2' },
      { eventIdx: 2, n: 2, phase: 'close', treeSha: 'C2' },
    ]);
  });

  it('includes an abandoned overlapping sibling with its abandon boundary', () => {
    const events = [opened(1, 'O1'), opened(2, 'O2'), abandoned(2, 'TA2')];
    const ctx = detectWindowOverlap(events, 1, 0);
    expect(ctx?.siblings).toEqual([{ n: 2, status: 'abandoned', filesChanged: [] }]);
    expect(ctx?.boundaries[2]).toEqual({ eventIdx: 2, n: 2, phase: 'abandon', treeSha: 'TA2' });
  });

  it('excludes a serial predecessor from a multi-cp log, keeps only intersectors', () => {
    // cp1 serial-closed; cp2 and cp3 overlap; closing cp3 sees only cp2.
    const events = [
      opened(1, 'O1'),
      closed(1, 'C1', ['a.ts']),
      opened(2, 'O2'),
      opened(3, 'O3'),
      closed(2, 'C2', ['b.ts']),
    ];
    const ctx = detectWindowOverlap(events, 3, 3);
    expect(ctx?.siblings.map((s) => s.n)).toEqual([2]);
    expect(ctx?.boundaries.map((b) => `${b.n}.${b.phase}`)).toEqual([
      '2.open',
      '3.open',
      '2.close',
    ]);
  });

  it('propagates null boundary trees (skipped snapshots) for degradation handling', () => {
    const events = [opened(1, null), opened(2, 'O2'), closed(2, null, ['b.ts'])];
    const ctx = detectWindowOverlap(events, 1, 0);
    expect(ctx?.boundaries.map((b) => b.treeSha)).toEqual([null, 'O2', null]);
  });
});
