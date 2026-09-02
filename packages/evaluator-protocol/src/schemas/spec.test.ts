import { describe, expect, it } from 'vitest';

import { EvaluatorSchema, MAX_EVALUATOR_OUTPUT_BYTES } from './spec.js';

/** Minimal valid command-engine spec — base for variations. */
const cmdBase = {
  schema: 'orcaops.evaluator/v1',
  id: 'plan-label-quality',
  phase: 'post-plan',
  severity: 'warn',
  description: 'Flag generic plan labels.',
  engine: {
    kind: 'command',
    command: ['bash', './checks/plan_label_quality.sh'],
    timeout_ms: 5000,
  },
} as const;

/** Minimal valid llm-engine spec. */
const llmBase = {
  schema: 'orcaops.evaluator/v1',
  id: 'scope-creep-detect',
  phase: 'checkpoint-close',
  severity: 'warn',
  description: 'Compare checkpoint changes against the plan and flag drift.',
  engine: {
    kind: 'llm',
    prompt_file: './prompts/scope-creep-detect.md',
    additional_context_sections: [],
    timeout_ms: 30000,
  },
} as const;

describe('EvaluatorSchema — command engine happy path', () => {
  it('accepts the minimal command spec and fills in defaults', () => {
    const out = EvaluatorSchema.parse(cmdBase);
    expect(out.id).toBe('plan-label-quality');
    expect(out.phase).toBe('post-plan');
    expect(out.engine.kind).toBe('command');
    if (out.engine.kind === 'command') {
      expect(out.engine.cwd).toBe('package');
      expect(out.engine.max_output_bytes).toBe(1024 * 1024);
      expect(out.engine.env).toBeUndefined(); // intentionally optional — resolver fills in
    }
    expect(out.filters.paths).toEqual([]);
    expect(out.filters.scopes).toEqual([]);
    expect(out.filters.when_llm).toBe('optional');
    expect(out.resolution.acknowledge.enabled).toBe(false);
    expect(out.resolution.policy_exception.enabled).toBe(false);
    expect(out.fingerprint.include).toEqual([]);
    expect(out.params).toEqual({});
  });

  it('accepts a fully-specified command spec including filters / resolution / fingerprint', () => {
    const out = EvaluatorSchema.parse({
      ...cmdBase,
      id: 'api-stability',
      severity: 'block',
      on_block_message: 'either rewrite or acknowledge',
      engine: {
        kind: 'command',
        command: ['python3', './checks/api_stability.py'],
        cwd: 'repo',
        timeout_ms: 5000,
        max_output_bytes: 2_097_152,
        env: { inherit: ['PATH', 'HOME'], set: { ORCAOPS_API_CHECK_VERBOSE: '1' } },
        output_schema: { type: 'object' },
      },
      params_schema: {
        type: 'object',
        properties: { include: { type: 'array' } },
        required: ['include'],
      },
      params: { include: ['src/**/*.py'] },
      filters: {
        paths: ['src/**/*.py'],
        scopes: ['api'],
        when_llm: 'optional',
      },
      resolution: {
        acknowledge: { enabled: true, label: 'breaking API change accepted' },
        policy_exception: { enabled: false },
      },
      fingerprint: { include: ['./checks/lib/**/*.py'] },
    });
    expect(out.severity).toBe('block');
    expect(out.on_block_message).toBe('either rewrite or acknowledge');
    if (out.engine.kind === 'command') {
      expect(out.engine.cwd).toBe('repo');
      expect(out.engine.env?.inherit).toEqual(['PATH', 'HOME']);
      expect(out.engine.env?.set).toEqual({ ORCAOPS_API_CHECK_VERBOSE: '1' });
      expect(out.engine.output_schema).toEqual({ type: 'object' });
    }
    expect(out.params).toEqual({ include: ['src/**/*.py'] });
    expect(out.resolution.acknowledge.label).toBe('breaking API change accepted');
  });

  it('accepts description_file in place of inline description', () => {
    const out = EvaluatorSchema.parse({
      ...cmdBase,
      description: undefined,
      description_file: './docs/plan-label-quality.md',
    });
    expect(out.description_file).toBe('./docs/plan-label-quality.md');
    expect(out.description).toBeUndefined();
  });

  it('accepts the exact command output maximum and rejects the next byte', () => {
    const accepted = EvaluatorSchema.safeParse({
      ...cmdBase,
      engine: {
        ...cmdBase.engine,
        max_output_bytes: MAX_EVALUATOR_OUTPUT_BYTES,
      },
    });
    const rejected = EvaluatorSchema.safeParse({
      ...cmdBase,
      engine: {
        ...cmdBase.engine,
        max_output_bytes: MAX_EVALUATOR_OUTPUT_BYTES + 1,
      },
    });
    expect(accepted.success).toBe(true);
    expect(rejected.success).toBe(false);
  });
});

describe('EvaluatorSchema — llm engine happy path', () => {
  it('accepts the minimal llm spec', () => {
    const out = EvaluatorSchema.parse(llmBase);
    expect(out.engine.kind).toBe('llm');
    if (out.engine.kind === 'llm') {
      expect(out.engine.output_format).toBe('markdown');
    }
  });

  it('accepts a json-output llm spec with an output_schema', () => {
    const out = EvaluatorSchema.parse({
      ...llmBase,
      engine: {
        ...llmBase.engine,
        output_format: 'json',
        output_schema: { type: 'object', properties: { findings: { type: 'array' } } },
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
        max_cost_usd: 0.25,
      },
    });
    if (out.engine.kind === 'llm') {
      expect(out.engine.output_format).toBe('json');
      expect(out.engine.output_schema).toBeDefined();
      expect(out.engine.provider).toBe('claude');
      expect(out.engine.model).toBe('claude-sonnet-4-6');
      expect(out.engine.max_cost_usd).toBe(0.25);
    }
  });

  it('omits tool_policy by default (deny-all posture)', () => {
    const out = EvaluatorSchema.parse(llmBase);
    if (out.engine.kind === 'llm') {
      expect(out.engine.tool_policy).toBeUndefined();
    }
  });

  it('default_enabled defaults to true and accepts an explicit false', () => {
    expect(EvaluatorSchema.parse(llmBase).default_enabled).toBe(true);
    expect(EvaluatorSchema.parse({ ...llmBase, default_enabled: false }).default_enabled).toBe(
      false
    );
  });

  it('accepts tool_policy: command-filtered for a file-reading evaluator', () => {
    const out = EvaluatorSchema.parse({
      ...llmBase,
      engine: { ...llmBase.engine, tool_policy: { mode: 'command-filtered' } },
    });
    if (out.engine.kind === 'llm') {
      expect(out.engine.tool_policy).toEqual({ mode: 'command-filtered' });
    }
  });

  it('rejects an unknown tool_policy mode', () => {
    const res = EvaluatorSchema.safeParse({
      ...llmBase,
      engine: { ...llmBase.engine, tool_policy: { mode: 'read-write' } },
    });
    expect(res.success).toBe(false);
  });

  it('rejects the retired tool_policy: read-only mode', () => {
    const res = EvaluatorSchema.safeParse({
      ...llmBase,
      engine: { ...llmBase.engine, tool_policy: { mode: 'read-only' } },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a stray key inside tool_policy (.strict)', () => {
    const res = EvaluatorSchema.safeParse({
      ...llmBase,
      engine: { ...llmBase.engine, tool_policy: { mode: 'command-filtered', extra: true } },
    });
    expect(res.success).toBe(false);
  });
});

describe('EvaluatorSchema — cross-field invariants', () => {
  it('rejects severity=block without on_block_message', () => {
    const res = EvaluatorSchema.safeParse({ ...cmdBase, severity: 'block' });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'on_block_message');
      expect(issue?.message).toMatch(/required when severity is `block`/);
    }
  });

  it('rejects on_block_message on a non-block severity', () => {
    const res = EvaluatorSchema.safeParse({
      ...cmdBase,
      severity: 'warn',
      on_block_message: 'unexpected',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'on_block_message');
      expect(issue?.message).toMatch(/only allowed when severity is `block`/);
    }
  });

  it('rejects phase=checkpoint-open with engine.kind=llm', () => {
    const res = EvaluatorSchema.safeParse({
      ...llmBase,
      phase: 'checkpoint-open',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'engine.kind');
      expect(issue?.message).toMatch(/requires `engine.kind: command`/);
    }
  });

  it('rejects spec with neither description nor description_file', () => {
    const res = EvaluatorSchema.safeParse({
      ...cmdBase,
      description: undefined,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'description');
      expect(issue?.message).toMatch(/exactly one of `description` or `description_file`/);
    }
  });

  it('rejects spec with both description and description_file', () => {
    const res = EvaluatorSchema.safeParse({
      ...cmdBase,
      description_file: './docs/plan-label.md',
    });
    expect(res.success).toBe(false);
  });

  it('rejects llm engine with output_format=json missing output_schema', () => {
    const res = EvaluatorSchema.safeParse({
      ...llmBase,
      engine: {
        ...llmBase.engine,
        output_format: 'json',
      },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'engine.output_schema');
      expect(issue).toBeDefined();
    }
  });

  it('rejects an empty command array', () => {
    const res = EvaluatorSchema.safeParse({
      ...cmdBase,
      engine: { ...cmdBase.engine, command: [] },
    });
    expect(res.success).toBe(false);
  });

  it('requires additional_context_sections on an llm engine, with no default', () => {
    const { additional_context_sections: _omitted, ...engineWithoutSections } = llmBase.engine;
    const res = EvaluatorSchema.safeParse({ ...llmBase, engine: engineWithoutSections });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find(
        (i) => i.path.join('.') === 'engine.additional_context_sections'
      );
      expect(issue).toBeDefined();
    }
  });

  it('rejects an unknown context section', () => {
    const res = EvaluatorSchema.safeParse({
      ...llmBase,
      engine: { ...llmBase.engine, additional_context_sections: ['the-whole-repo'] },
    });
    expect(res.success).toBe(false);
  });

  it('accepts the four known context sections', () => {
    const res = EvaluatorSchema.safeParse({
      ...llmBase,
      engine: {
        ...llmBase.engine,
        additional_context_sections: [
          'acceptance-criteria',
          'delivered-checkpoints',
          'diff-boundary',
          'source-plan',
        ],
      },
    });
    expect(res.success).toBe(true);
  });

  it('rejects an invalid id (not kebab-case)', () => {
    const res = EvaluatorSchema.safeParse({ ...cmdBase, id: 'PlanLabelQuality' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].path).toEqual(['id']);
    }
  });

  it('rejects a malformed glob in filters.paths', () => {
    const res = EvaluatorSchema.safeParse({
      ...cmdBase,
      filters: { paths: [''] },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a malformed glob in fingerprint.include', () => {
    const res = EvaluatorSchema.safeParse({
      ...cmdBase,
      fingerprint: { include: [''] },
    });
    expect(res.success).toBe(false);
  });

  it('rejects an unknown engine kind via discriminatedUnion', () => {
    const res = EvaluatorSchema.safeParse({
      ...cmdBase,
      engine: {
        kind: 'http',
        url: 'https://example.com',
        timeout_ms: 1000,
      },
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const res = EvaluatorSchema.safeParse({ ...cmdBase, extra: 'nope' });
    expect(res.success).toBe(false);
  });

  it('rejects unknown engine-level keys (strict)', () => {
    const res = EvaluatorSchema.safeParse({
      ...cmdBase,
      engine: { ...cmdBase.engine, unknown_field: true },
    });
    expect(res.success).toBe(false);
  });

  it('rejects negative or zero timeout_ms', () => {
    for (const t of [-1, 0]) {
      const res = EvaluatorSchema.safeParse({
        ...cmdBase,
        engine: { ...cmdBase.engine, timeout_ms: t },
      });
      expect(res.success).toBe(false);
    }
  });

  it('rejects an invalid filters.when_llm enum value', () => {
    const res = EvaluatorSchema.safeParse({
      ...cmdBase,
      filters: { when_llm: 'sometimes' as 'optional' },
    });
    expect(res.success).toBe(false);
  });
});
