import { describe, expect, it } from 'vitest';

import type { ExcludedCheckpoint } from './chain.js';
import { resolveRungs, rungForCheckpoint } from './ladder.js';

const cp = (over: Partial<Parameters<typeof rungForCheckpoint>[0]> = {}) => ({
  artifact: 'a',
  cp: 1,
  hasBoundaryTrees: false,
  hasManifest: false,
  hasFilesChanged: false,
  ...over,
});

describe('rungForCheckpoint', () => {
  it('picks the strongest rung the inputs allow', () => {
    expect(rungForCheckpoint(cp({ hasBoundaryTrees: true }))).toBe('snapshot_chain');
    expect(rungForCheckpoint(cp({ hasManifest: true }))).toBe('hash_match');
    expect(rungForCheckpoint(cp({ hasFilesChanged: true }))).toBe('file_level');
    expect(rungForCheckpoint(cp())).toBe('unattributed');
  });
});

describe('resolveRungs', () => {
  it('reports the weakest rung as active and discloses each downgrade', () => {
    const res = resolveRungs([
      cp({ artifact: 'a', cp: 1, hasBoundaryTrees: true }),
      cp({ artifact: 'a', cp: 2, hasManifest: true }),
    ]);
    expect(res.activeRung).toBe('hash_match'); // weakest of {snapshot_chain, hash_match}
    expect(res.perCheckpoint).toEqual([
      { artifact: 'a', cp: 1, rung: 'snapshot_chain' },
      { artifact: 'a', cp: 2, rung: 'hash_match' },
    ]);
    expect(res.disclosures.some((d) => d.code === 'attribution_rung_downgrade' && d.cp === 2)).toBe(
      true
    );
  });

  it('discloses a manifestless checkpoint and a truncated manifest', () => {
    const res = resolveRungs([
      cp({ cp: 3 }),
      cp({ cp: 4, hasBoundaryTrees: true, manifestTruncated: true }),
    ]);
    expect(res.activeRung).toBe('unattributed');
    expect(res.disclosures.some((d) => d.code === 'manifestless_checkpoint' && d.cp === 3)).toBe(
      true
    );
    expect(res.disclosures.some((d) => d.code === 'truncated_manifest' && d.cp === 4)).toBe(true);
  });

  it('discloses chain exclusions (abandoned / missing-trees) but not benign open', () => {
    const excluded: ExcludedCheckpoint[] = [
      { artifact: 'a', n: 5, reason: 'abandoned' },
      { artifact: 'a', n: 6, reason: 'missing_trees' },
      { artifact: 'a', n: 7, reason: 'open' },
    ];
    const res = resolveRungs([cp({ hasBoundaryTrees: true })], excluded);
    expect(
      res.disclosures.some((d) => d.code === 'abandoned_checkpoint_excluded' && d.cp === 5)
    ).toBe(true);
    expect(res.disclosures.some((d) => d.code === 'manifestless_checkpoint' && d.cp === 6)).toBe(
      true
    );
    expect(res.disclosures.some((d) => d.cp === 7)).toBe(false);
  });

  it('defaults to snapshot_chain when there are no checkpoints to weaken it', () => {
    expect(resolveRungs([]).activeRung).toBe('snapshot_chain');
  });
});
