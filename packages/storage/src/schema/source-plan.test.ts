import { describe, expect, it } from 'vitest';

import { SourcePlanPinSchema, SourceRefSchema } from './source-plan.js';

describe('SourceRefSchema', () => {
  it('accepts a local ref with version unset (reserved)', () => {
    const ref = SourceRefSchema.parse({ kind: 'local', locator: './docs/plan.md' });
    expect(ref).toEqual({ kind: 'local', locator: './docs/plan.md' });
  });

  it('accepts a local ref with an explicit version', () => {
    const ref = SourceRefSchema.parse({ kind: 'local', locator: 'plan.md', version: '2' });
    expect(ref).toMatchObject({ kind: 'local', locator: 'plan.md', version: '2' });
  });

  it('round-trips a cloud ref with the origin embedded', () => {
    const cloud = {
      kind: 'cloud' as const,
      locator: '019ea000-aaaa-7000-8000-000000000001',
      version: '3',
      base_url: 'https://cloud.orcaops.dev',
      org_id: 'org_123',
    };
    const parsed = SourceRefSchema.parse(cloud);
    expect(parsed).toEqual(cloud);
    // Storage persists refs as JSON — the round-trip through JSON is stable.
    expect(SourceRefSchema.parse(JSON.parse(JSON.stringify(cloud)))).toEqual(cloud);
  });

  it('rejects a cloud ref missing base_url or org_id (origin must be embedded)', () => {
    expect(
      SourceRefSchema.safeParse({ kind: 'cloud', locator: 'x', version: '1', org_id: 'o' }).success
    ).toBe(false);
    expect(
      SourceRefSchema.safeParse({ kind: 'cloud', locator: 'x', version: '1', base_url: 'b' })
        .success
    ).toBe(false);
  });

  it('rejects a cloud ref with an empty version or locator', () => {
    expect(
      SourceRefSchema.safeParse({
        kind: 'cloud',
        locator: 'x',
        version: '',
        base_url: 'b',
        org_id: 'o',
      }).success
    ).toBe(false);
    expect(
      SourceRefSchema.safeParse({
        kind: 'cloud',
        locator: '',
        version: '1',
        base_url: 'b',
        org_id: 'o',
      }).success
    ).toBe(false);
  });

  it('rejects an unknown ref kind', () => {
    expect(SourceRefSchema.safeParse({ kind: 'http', locator: 'x' }).success).toBe(false);
  });
});

describe('SourcePlanPinSchema is kind-agnostic', () => {
  it('pins a cloud-kind source_ref unchanged', () => {
    const pin = {
      source_ref: {
        kind: 'cloud' as const,
        locator: 'ext-1',
        version: '5',
        base_url: 'https://cloud.example',
        org_id: 'org_1',
      },
      content: '# Plan\n\nbody',
      hash: 'a'.repeat(64),
      baseline: null,
    };
    expect(SourcePlanPinSchema.parse(pin)).toEqual(pin);
  });

  it('accepts a local-kind pin', () => {
    const pin = {
      source_ref: { kind: 'local' as const, locator: 'docs/plan.md' },
      content: 'plan text',
      hash: 'deadbeef',
      baseline: null,
    };
    expect(SourcePlanPinSchema.parse(pin)).toEqual(pin);
  });

  it('rejects whitespace-only content for either kind', () => {
    expect(
      SourcePlanPinSchema.safeParse({
        source_ref: { kind: 'local', locator: 'p' },
        content: '   ',
        hash: 'x',
        baseline: null,
      }).success
    ).toBe(false);
  });
});

describe('SourcePlanPinSchema baseline (authoring baseline, frozen at capture)', () => {
  const base = {
    source_ref: { kind: 'local' as const, locator: 'docs/plan.md' },
    content: 'plan text',
    hash: 'deadbeef',
  };

  it('round-trips a populated baseline through parse and JSON', () => {
    const pin = {
      ...base,
      baseline: {
        repo_url: 'https://github.com/acme/widgets',
        branch: 'main',
        head_sha: 'a'.repeat(40),
      },
    };
    const parsed = SourcePlanPinSchema.parse(pin);
    expect(parsed).toEqual(pin);
    expect(SourcePlanPinSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(pin);
  });

  it('rejects an absent or partial baseline (launch strictness)', () => {
    const missingKey = SourcePlanPinSchema.safeParse(base);
    expect(missingKey.success).toBe(false);
    if (!missingKey.success) {
      expect(missingKey.error.issues.some((issue) => issue.path[0] === 'baseline')).toBe(true);
    }
    const partial = SourcePlanPinSchema.safeParse({ ...base, baseline: { branch: 'main' } });
    expect(partial.success).toBe(false);
    if (!partial.success) {
      const paths = partial.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('baseline.repo_url');
      expect(paths).toContain('baseline.head_sha');
    }
  });

  it('normalizes whitespace-only components to null (cloud trimmed-empty parity)', () => {
    expect(
      SourcePlanPinSchema.parse({
        ...base,
        baseline: { repo_url: '  ', branch: 'main', head_sha: '' },
      }).baseline
    ).toEqual({ repo_url: null, branch: 'main', head_sha: null });
    // All-empty collapses the whole baseline, same as all-null.
    expect(
      SourcePlanPinSchema.parse({ ...base, baseline: { repo_url: '', branch: ' ', head_sha: '' } })
        .baseline
    ).toBeNull();
  });

  it('rejects a wrong-typed baseline value', () => {
    expect(SourcePlanPinSchema.safeParse({ ...base, baseline: 'main@abc' }).success).toBe(false);
  });
});
