import { describe, expect, it } from 'vitest';

import { computeUnresolvedBlocks } from './snapshot.js';

describe('computeUnresolvedBlocks', () => {
  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    evaluator_ref: 'pack/x',
    run_id: 'r1',
    phase: 'checkpoint-close',
    severity: 'block',
    run_status: 'completed',
    verdict: 'violation',
    disposition: 'unresolved',
    ...over,
  });

  it('surfaces a lone unresolved block violation', () => {
    expect(computeUnresolvedBlocks([row()])).toEqual([
      {
        kind: 'violation',
        evaluator_ref: 'pack/x',
        run_id: 'r1',
        phase: 'checkpoint-close',
        acknowledge_enabled: false,
      },
    ]);
  });

  it('a later PASS on the same ref clears the block (regression guard)', () => {
    const blocks = computeUnresolvedBlocks([
      row({ run_id: 'r1', verdict: 'violation' }),
      row({ run_id: 'r2', verdict: 'pass' }), // a later passing run-evaluators
    ]);
    expect(blocks).toEqual([]);
  });

  it('a newer violation supersedes the older run_id', () => {
    const blocks = computeUnresolvedBlocks([row({ run_id: 'r1' }), row({ run_id: 'r2' })]);
    expect(blocks.map((b) => b.run_id)).toEqual(['r2']);
  });

  it('a dismissed latest run clears the block', () => {
    expect(computeUnresolvedBlocks([row({ disposition: 'dismissed' })])).toEqual([]);
  });

  it('an error supersedes an earlier violation and requires a rerun', () => {
    const blocks = computeUnresolvedBlocks([
      row({ run_id: 'r1' }),
      row({ run_id: 'r2', run_status: 'error', verdict: null }),
    ]);
    expect(blocks).toMatchObject([{ kind: 'error', run_id: 'r2', acknowledge_enabled: false }]);
  });

  it('a skipped run leaves the current violation unchanged', () => {
    const blocks = computeUnresolvedBlocks([
      row({ run_id: 'r1' }),
      row({ run_id: 'r2', run_status: 'skipped', verdict: null }),
    ]);
    expect(blocks.map((b) => b.run_id)).toEqual(['r1']);
  });

  it('independent refs: one open, one cleared by a later pass', () => {
    const blocks = computeUnresolvedBlocks([
      row({ evaluator_ref: 'pack/a', run_id: 'a1' }),
      row({ evaluator_ref: 'pack/b', run_id: 'b1' }),
      row({ evaluator_ref: 'pack/b', run_id: 'b2', verdict: 'pass' }),
    ]);
    expect(blocks.map((b) => b.evaluator_ref)).toEqual(['pack/a']);
  });

  it('excludes checkpoint-open (pre-append soft) blocks', () => {
    expect(computeUnresolvedBlocks([row({ phase: 'checkpoint-open' })])).toEqual([]);
  });

  it('acknowledge_enabled comes from the lookup; defaults false without one', () => {
    expect(computeUnresolvedBlocks([row()])[0].acknowledge_enabled).toBe(false);
    const withLookup = computeUnresolvedBlocks([row()], (ref) => ref === 'pack/x');
    expect(withLookup[0].acknowledge_enabled).toBe(true);
  });
});
