import { describe, expect, it } from 'vitest';

import { lifecycleUsageStamp, reviewUsageStamp, usageStampKey } from './usage-stamp.js';

describe('usageStampKey', () => {
  it('is deterministic for the same parts', () => {
    expect(usageStampKey('a', 'b', 1)).toBe(usageStampKey('a', 'b', 1));
  });

  it('differs across distinct authoring intervals', () => {
    expect(usageStampKey('ext', 'push', 2)).not.toBe(usageStampKey('ext', 'push', 3));
    expect(usageStampKey('ext', 'push', 2)).not.toBe(usageStampKey('ext', 'pull', 2));
  });

  it('treats null and undefined parts identically (stable)', () => {
    expect(usageStampKey('ext', 'upload', null)).toBe(usageStampKey('ext', 'upload', undefined));
  });
});

describe('reviewUsageStamp', () => {
  it('builds a source-plan-scoped plan_review descriptor with a verb-keyed id', () => {
    const d = reviewUsageStamp('push', 'ext1', 2);
    expect(d.lifecycle_event).toBe('plan_review');
    expect(d.sourcePlanRefId).toBe('cloud:ext1');
    expect(d.baselineHint).toBe('prior_same_source_plan');
    expect(d.stableEventId).toBe(usageStampKey('ext1', 'push', 2));
    expect(typeof d.asOf).toBe('string');
    expect(d.artifactId ?? null).toBeNull();
  });
});

describe('lifecycleUsageStamp', () => {
  it('builds an artifact-scoped descriptor keyed by (artifactId, event, discriminator)', () => {
    const d = lifecycleUsageStamp({
      event: 'summary',
      artifactId: 'art1',
      baselineHint: 'prior_same_artifact',
      asOf: '2026-06-26T00:00:00.000Z',
      discriminator: 'idem-key',
    });
    expect(d.lifecycle_event).toBe('summary');
    expect(d.artifactId).toBe('art1');
    expect(d.baselineHint).toBe('prior_same_artifact');
    expect(d.asOf).toBe('2026-06-26T00:00:00.000Z');
    expect(d.checkpoint_n ?? null).toBeNull();
    expect(d.sourcePlanRefId ?? null).toBeNull();
    expect(d.stableEventId).toBe(usageStampKey('art1', 'summary', 'idem-key'));
  });

  it('threads checkpoint_n and distinguishes events / discriminators in the key', () => {
    const abandon = lifecycleUsageStamp({
      event: 'checkpoint_abandon',
      artifactId: 'art1',
      baselineHint: 'checkpoint_open',
      asOf: '2026-06-26T00:00:00.000Z',
      discriminator: 2,
      checkpoint_n: 2,
    });
    expect(abandon.checkpoint_n).toBe(2);
    expect(abandon.baselineHint).toBe('checkpoint_open');
    expect(abandon.stableEventId).toBe(usageStampKey('art1', 'checkpoint_abandon', 2));
    // A different discriminator (e.g. another checkpoint n) mints a distinct key.
    const other = lifecycleUsageStamp({
      event: 'checkpoint_abandon',
      artifactId: 'art1',
      baselineHint: 'checkpoint_open',
      asOf: '2026-06-26T00:00:00.000Z',
      discriminator: 3,
      checkpoint_n: 3,
    });
    expect(abandon.stableEventId).not.toBe(other.stableEventId);
  });

  it('mints distinct keys for two pre_pr_check stamps with different discriminators (fresh-uuid)', () => {
    const a = lifecycleUsageStamp({
      event: 'pre_pr_check',
      artifactId: 'art1',
      baselineHint: 'prior_same_artifact',
      asOf: '2026-06-26T00:00:00.000Z',
      discriminator: 'uuid-a',
    });
    const b = lifecycleUsageStamp({
      event: 'pre_pr_check',
      artifactId: 'art1',
      baselineHint: 'prior_same_artifact',
      asOf: '2026-06-26T00:00:00.000Z',
      discriminator: 'uuid-b',
    });
    expect(a.stableEventId).not.toBe(b.stableEventId);
  });
});
