import { describe, expect, it } from 'vitest';

import { EvaluatorConfigSchema, EvaluatorRefRegex } from './config.js';

describe('EvaluatorConfigSchema (happy path)', () => {
  it('accepts an empty config and fills in defaults', () => {
    const out = EvaluatorConfigSchema.parse({ schema: 'orcaops.evaluator_config/v2' });
    expect(out.runtime.max_concurrent).toBe(4);
    expect(out.packages).toEqual([]);
    expect(out.evaluators).toEqual({});
  });

  it('accepts a full config with all three pack-source kinds and evaluator overrides', () => {
    const out = EvaluatorConfigSchema.parse({
      schema: 'orcaops.evaluator_config/v2',
      runtime: { max_concurrent: 8 },
      packages: [
        { id: 'local', source: { kind: 'path', path: './evaluators/local' } },
        {
          id: 'core',
          source: { kind: 'bundled', package: '@orcaops/evaluator-pack', pack: 'core' },
        },
        {
          id: 'acme-security',
          source: {
            kind: 'package',
            package: '@acme/orcaops-pack',
            pack: 'security',
          },
        },
      ],
      evaluators: {
        'local/my-rule': { enabled: true },
        'core/plan-label-quality': { enabled: true },
        'core/scope-creep-detect': { enabled: false },
        'core/secret-scan-plan': {
          enabled: true,
          severity: 'block',
          engine: { provider: 'claude', model: null, timeout_ms: 90_000 },
          params: { patterns: ['stripe-secret-*'] },
        },
        'acme-security/permission-check': { enabled: true },
      },
    });
    expect(out.runtime.max_concurrent).toBe(8);
    expect(out.packages).toHaveLength(3);
    expect(out.packages[0].source).toEqual({ kind: 'path', path: './evaluators/local' });
    expect(out.packages[1].source).toEqual({
      kind: 'bundled',
      package: '@orcaops/evaluator-pack',
      pack: 'core',
    });
    expect(out.packages[2].source).toEqual({
      kind: 'package',
      package: '@acme/orcaops-pack',
      pack: 'security',
    });
    expect(out.evaluators['core/secret-scan-plan']).toEqual({
      enabled: true,
      severity: 'block',
      engine: { provider: 'claude', model: null, timeout_ms: 90_000 },
      params: { patterns: ['stripe-secret-*'] },
    });
  });
});

describe('EvaluatorConfigSchema (failure modes)', () => {
  it('rejects a wrong schema literal', () => {
    const res = EvaluatorConfigSchema.safeParse({ schema: 'orcaops.evaluator_config/v1' });
    expect(res.success).toBe(false);
  });

  it('rejects duplicate package ids', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [
        { id: 'core', source: { kind: 'path', path: './evaluators/core' } },
        { id: 'core', source: { kind: 'path', path: './evaluators/other-core' } },
      ],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].path).toEqual(['packages', 1, 'id']);
      expect(res.error.issues[0].message).toMatch(/duplicate package id/);
    }
  });

  it('rejects a packages entry with a top-level `path` field instead of `source`', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [{ id: 'core', path: './evaluators/core' }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects an unknown source.kind', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [{ id: 'core', source: { kind: 'symlink', path: './x' } }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects an informational version on a package source', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [
        {
          id: 'security',
          source: {
            kind: 'package',
            package: '@acme/orcaops-pack',
            pack: 'security',
            version: '1.2.0',
          },
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('rejects checked-in trust metadata', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [
        {
          id: 'core',
          source: { kind: 'path', path: './evaluators/core' },
          trusted: {
            granted_at: '2026-01-01T00:00:00.000Z',
            source_fingerprint: 'f'.repeat(64),
            trusted_warnings: ['command_evaluators_present'],
          },
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('rejects a bundled source missing the pack field', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [{ id: 'core', source: { kind: 'bundled', package: '@orcaops/evaluator-pack' } }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects an evaluator ref that does not match the pack-id/eval-id pattern', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [{ id: 'core', source: { kind: 'path', path: './' } }],
      evaluators: { 'no-slash': { enabled: true } },
    });
    expect(res.success).toBe(false);
  });

  it('rejects an evaluator ref whose pack-id is not declared in packages[]', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [{ id: 'core', source: { kind: 'path', path: './evaluators/core' } }],
      evaluators: { 'unknown/some-rule': { enabled: true } },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const msgs = res.error.issues.map((i) => i.message);
      expect(msgs.some((m) => /references undeclared pack/.test(m))).toBe(true);
    }
  });

  it('rejects an override entry missing `enabled`', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [{ id: 'core', source: { kind: 'path', path: './' } }],
      evaluators: { 'core/rule': { severity: 'warn' } },
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown or invalid engine override fields', () => {
    const base = {
      schema: 'orcaops.evaluator_config/v2',
      packages: [{ id: 'core', source: { kind: 'path' as const, path: './' } }],
    };
    expect(
      EvaluatorConfigSchema.safeParse({
        ...base,
        evaluators: { 'core/rule': { enabled: true, engine: { effort: 'high' } } },
      }).success
    ).toBe(false);
    expect(
      EvaluatorConfigSchema.safeParse({
        ...base,
        evaluators: { 'core/rule': { enabled: true, engine: { timeout_ms: 0 } } },
      }).success
    ).toBe(false);
  });

  it('rejects a consumer override of additional_context_sections', () => {
    // The field is pack-author-owned, like tool_policy: which context leaves
    // the repository for the provider is the pack's declaration, not a knob a
    // consuming repo can widen from its config. The strict three-key
    // allowlist enforces that, and this pins the intent rather than leaving
    // it to `.strict()` by accident.
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [{ id: 'core', source: { kind: 'path' as const, path: './' } }],
      evaluators: {
        'core/rule': {
          enabled: true,
          engine: { additional_context_sections: ['source-plan'] },
        },
      },
    });
    expect(res.success).toBe(false);
  });

  it('rejects negative max_concurrent', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      runtime: { max_concurrent: 0 },
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const res = EvaluatorConfigSchema.safeParse({
      schema: 'orcaops.evaluator_config/v2',
      stray_key: true,
    });
    expect(res.success).toBe(false);
  });
});

describe('EvaluatorRefRegex', () => {
  it('matches well-formed refs', () => {
    expect(EvaluatorRefRegex.test('core/api-stability')).toBe(true);
    expect(EvaluatorRefRegex.test('local/my-rule')).toBe(true);
    expect(EvaluatorRefRegex.test('a/b')).toBe(true);
  });
  it('rejects refs without a slash or with invalid sides', () => {
    expect(EvaluatorRefRegex.test('core-api')).toBe(false);
    expect(EvaluatorRefRegex.test('Core/api')).toBe(false);
    expect(EvaluatorRefRegex.test('core/Api')).toBe(false);
    expect(EvaluatorRefRegex.test('core//api')).toBe(false);
    expect(EvaluatorRefRegex.test('-core/api')).toBe(false);
  });
});
