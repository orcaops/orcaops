import { describe, expect, it } from 'vitest';

import { EvaluatorPackageSchema } from './package.js';

const minimal = {
  schema: 'orcaops.evaluator_package/v1',
  id: 'core',
  name: 'Universal Process Evaluators',
  version: '0.1.0',
  description: 'Universal process-hygiene evaluators.',
};

describe('EvaluatorPackageSchema (happy path)', () => {
  it('accepts a minimal manifest and fills in defaults', () => {
    const out = EvaluatorPackageSchema.parse(minimal);
    expect(out.id).toBe('core');
    expect(out.evaluator_dir).toBe('./evaluators');
    expect(out.defaults).toEqual({});
    expect(out.metadata).toEqual({});
  });

  it('accepts a manifest with defaults.timeout_ms and defaults.env.inherit', () => {
    const out = EvaluatorPackageSchema.parse({
      ...minimal,
      defaults: {
        timeout_ms: 5000,
        env: { inherit: ['PATH', 'HOME'] },
      },
    });
    expect(out.defaults.timeout_ms).toBe(5000);
    expect(out.defaults.env?.inherit).toEqual(['PATH', 'HOME']);
  });

  it('accepts free-form metadata (loose, not strict)', () => {
    const out = EvaluatorPackageSchema.parse({
      ...minimal,
      metadata: {
        owner: 'orcaops',
        tags: ['universal', 'process'],
        homepage: 'https://github.com/orcaops/evaluator-pack',
        // free-form keys are preserved
        custom_key: 'value',
      },
    });
    expect(out.metadata.owner).toBe('orcaops');
    expect((out.metadata as Record<string, unknown>).custom_key).toBe('value');
  });
});

describe('EvaluatorPackageSchema (failure modes)', () => {
  it('rejects a wrong schema literal', () => {
    const res = EvaluatorPackageSchema.safeParse({
      ...minimal,
      schema: 'orcaops.evaluator_package/v2',
    });
    expect(res.success).toBe(false);
  });

  it('rejects an id that is not kebab-case', () => {
    const res = EvaluatorPackageSchema.safeParse({ ...minimal, id: 'Core' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].path).toEqual(['id']);
    }
  });

  it('rejects an id starting with a hyphen', () => {
    const res = EvaluatorPackageSchema.safeParse({ ...minimal, id: '-core' });
    expect(res.success).toBe(false);
  });

  it('rejects empty name / description / version', () => {
    for (const field of ['name', 'description', 'version'] as const) {
      const res = EvaluatorPackageSchema.safeParse({ ...minimal, [field]: '' });
      expect(res.success).toBe(false);
    }
  });

  it('rejects negative or zero defaults.timeout_ms', () => {
    for (const t of [-1, 0]) {
      const res = EvaluatorPackageSchema.safeParse({
        ...minimal,
        defaults: { timeout_ms: t },
      });
      expect(res.success).toBe(false);
    }
  });

  it('rejects unknown top-level keys (strict)', () => {
    const res = EvaluatorPackageSchema.safeParse({
      ...minimal,
      unknown_key: 'whatever',
    });
    expect(res.success).toBe(false);
  });
});
