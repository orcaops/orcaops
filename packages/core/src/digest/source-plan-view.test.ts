import { describe, expect, it } from 'vitest';

import type { SourcePlanPin } from '@orcaops/storage';

import { sourcePlanView, type SourcePlanView } from './source-plan-view.js';

const LOCAL_PIN: SourcePlanPin = {
  source_ref: { kind: 'local', locator: 'docs/slice-plan.md' },
  content: '# Slice plan\n\nfull body text the view must never carry',
  hash: 'a'.repeat(64),
  baseline: null,
};

const CLOUD_PIN: SourcePlanPin = {
  source_ref: {
    kind: 'cloud',
    locator: 'c3303a5e-0000-7000-8000-000000000000',
    version: '2',
    base_url: 'https://cloud.orcaops.dev',
    org_id: 'org_123',
  },
  content: '# Approved plan\n\nfull approved body the view must never carry',
  hash: 'b'.repeat(64),
  baseline: null,
};

describe('sourcePlanView', () => {
  it('returns null for a null pin', () => {
    expect(sourcePlanView(null)).toBeNull();
  });

  it('projects a local pin to a content-free view', () => {
    const view = sourcePlanView(LOCAL_PIN);
    expect(view).toEqual({
      pinned: true,
      source_ref: { kind: 'local', locator: 'docs/slice-plan.md' },
      hash: 'a'.repeat(64),
    });
    // The body must never ride along — the whole point of the projection.
    expect('content' in (view as object)).toBe(false);
  });

  it('projects a cloud pin with the full source_ref (kind/version/origin)', () => {
    const view = sourcePlanView(CLOUD_PIN);
    // Full source_ref is what disambiguates "cloud @ v2" from a local path —
    // the bare locator the digest carries can't.
    expect(view?.source_ref).toEqual({
      kind: 'cloud',
      locator: 'c3303a5e-0000-7000-8000-000000000000',
      version: '2',
      base_url: 'https://cloud.orcaops.dev',
      org_id: 'org_123',
    });
    expect(view?.hash).toBe('b'.repeat(64));
    expect('content' in (view as object)).toBe(false);
  });

  it('content?:never makes a spread that re-leaks content a compile error', () => {
    // The real assertion is the `@ts-expect-error`: spreading a full pin
    // drags `content: string` along, which `content?: never` rejects. If the
    // guard is ever dropped the expected error disappears and this line fails
    // typecheck — a permanent leak guard, mirroring DigestSourcePlan's.
    // @ts-expect-error - the spread re-introduces `content`, rejected by `content?: never`
    const _noLeak: SourcePlanView = { ...CLOUD_PIN, pinned: true };
    expect(_noLeak.pinned).toBe(true);
  });
});
