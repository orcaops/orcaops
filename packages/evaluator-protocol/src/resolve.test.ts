import { describe, expect, it } from 'vitest';

import {
  assertUniqueRefs,
  EvaluatorResolveError,
  overridesByRef,
  resolveEvaluator,
  type ResolveEvaluatorInput,
} from './resolve.js';
import { EvaluatorConfigSchema } from './schemas/config.js';
import { type EvaluatorPackage, EvaluatorPackageSchema } from './schemas/package.js';
import { type Evaluator, EvaluatorSchema } from './schemas/spec.js';

const packageRoot = '/repo/.orcaops/evaluators/core';
const specPath = `${packageRoot}/evaluators/plan-label-quality.eval.yaml`;

function makeManifest(overrides: Partial<EvaluatorPackage> = {}): EvaluatorPackage {
  return EvaluatorPackageSchema.parse({
    schema: 'orcaops.evaluator_package/v1',
    id: 'core',
    name: 'Core',
    version: '0.1.0',
    description: 'Universal process-hygiene.',
    ...overrides,
  });
}

function makeCommandSpec(overrides: Partial<Evaluator> = {}): Evaluator {
  return EvaluatorSchema.parse({
    schema: 'orcaops.evaluator/v1',
    id: 'plan-label-quality',
    phase: 'post-plan',
    severity: 'warn',
    description: 'Inline desc.',
    engine: {
      kind: 'command',
      command: ['bash', './checks/plan_label_quality.sh'],
      timeout_ms: 5000,
    },
    ...overrides,
  });
}

function makeLlmSpec(overrides: Partial<Evaluator> = {}): Evaluator {
  return EvaluatorSchema.parse({
    schema: 'orcaops.evaluator/v1',
    id: 'scope-creep-detect',
    phase: 'checkpoint-close',
    severity: 'warn',
    description: 'detect drift',
    engine: {
      kind: 'llm',
      prompt_file: './prompts/scope-creep-detect.md',
      additional_context_sections: [],
      timeout_ms: 30000,
    },
    ...overrides,
  });
}

describe('resolveEvaluator — happy path', () => {
  it('builds a ResolvedEvaluator with `enabled: false` when no override is given', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec(),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'Inline desc.',
    });
    expect(out.enabled).toBe(false);
    expect(out.ref).toBe('core/plan-label-quality');
    expect(out.package_id).toBe('core');
    expect(out.evaluator_id).toBe('plan-label-quality');
    expect(out.severity).toBe('warn'); // from spec, no override
  });

  it('honors `enabled: true` from the override', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec(),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'Inline desc.',
      override: { enabled: true },
    });
    expect(out.enabled).toBe(true);
  });

  it('applies a severity override on top of the spec', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec({ severity: 'warn' }),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
      override: { enabled: true, severity: 'block' },
    });
    expect(out.severity).toBe('block');
  });

  it('applies a params override with replace semantics (not deep-merge)', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec({ params: { a: 1, b: 2 } }),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
      override: { enabled: true, params: { c: 3 } },
    });
    expect(out.params).toEqual({ c: 3 });
  });

  it('threads engine.tool_policy through to the resolved llm engine', () => {
    const out = resolveEvaluator({
      spec: makeLlmSpec({
        engine: {
          kind: 'llm',
          prompt_file: './prompts/scope-creep-detect.md',
          additional_context_sections: [],
          output_format: 'markdown',
          timeout_ms: 30000,
          tool_policy: { mode: 'command-filtered' },
        },
      }),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
      override: { enabled: true },
    });
    expect(out.engine.kind).toBe('llm');
    if (out.engine.kind === 'llm') {
      expect(out.engine.tool_policy).toEqual({ mode: 'command-filtered' });
    }
  });

  it('leaves tool_policy undefined on a resolved llm engine that omits it', () => {
    const out = resolveEvaluator({
      spec: makeLlmSpec(),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
      override: { enabled: true },
    });
    if (out.engine.kind === 'llm') {
      expect(out.engine.tool_policy).toBeUndefined();
    }
  });

  it('applies model and timeout overrides ahead of the author spec', () => {
    const out = resolveEvaluator({
      spec: makeLlmSpec({
        engine: {
          kind: 'llm',
          prompt_file: './prompts/scope-creep-detect.md',
          additional_context_sections: [],
          output_format: 'markdown',
          model: 'author-model',
          timeout_ms: 30_000,
        },
      }),
      package_manifest: makeManifest({ defaults: { timeout_ms: 5_000 } }),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
      override: { enabled: true, engine: { model: 'user-model', timeout_ms: 90_000 } },
    });
    expect(out.engine).toMatchObject({ kind: 'llm', model: 'user-model', timeout_ms: 90_000 });
    if (out.engine.kind === 'llm') {
      expect(out.engine.selection_sources).toEqual({
        provider: 'global',
        model: 'user-override',
        timeout_ms: 'user-override',
      });
    }
  });

  it('preserves explicit model null while an absent override retains the author model', () => {
    const spec = makeLlmSpec({
      engine: {
        kind: 'llm',
        prompt_file: './prompts/scope-creep-detect.md',
        additional_context_sections: [],
        output_format: 'markdown',
        model: 'author-model',
        timeout_ms: 30_000,
      },
    });
    const input = {
      spec,
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    };
    expect(resolveEvaluator({ ...input, override: { enabled: true } }).engine).toMatchObject({
      model: 'author-model',
    });
    expect(
      resolveEvaluator({ ...input, override: { enabled: true, engine: { model: null } } }).engine
    ).toMatchObject({ model: null });
  });

  it('lets a user provider override replace or clear an author pin', () => {
    const spec = makeLlmSpec({
      engine: {
        kind: 'llm',
        prompt_file: './prompts/scope-creep-detect.md',
        additional_context_sections: [],
        output_format: 'markdown',
        provider: 'claude',
        timeout_ms: 30_000,
      },
    });
    const input = {
      spec,
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    };
    const replaced = resolveEvaluator({
      ...input,
      override: { enabled: true, engine: { provider: 'codex' } },
    });
    const cleared = resolveEvaluator({
      ...input,
      override: { enabled: true, engine: { provider: null } },
    });
    expect(replaced.engine).toMatchObject({
      provider: 'codex',
      selection_sources: { provider: 'user-override' },
    });
    expect(cleared.engine).not.toHaveProperty('provider');
    if (cleared.engine.kind === 'llm') {
      expect(cleared.engine.selection_sources?.provider).toBe('user-override');
    }
  });

  it('rejects engine overrides on command evaluators', () => {
    expect(() =>
      resolveEvaluator({
        spec: makeCommandSpec(),
        package_manifest: makeManifest(),
        package_root: packageRoot,
        spec_path: specPath,
        description: 'desc',
        override: { enabled: true, engine: { timeout_ms: 90_000 } },
      })
    ).toThrow(/only valid for LLM evaluators/);
  });
});

describe('resolveEvaluator — defaults cascade', () => {
  it('fills in engine.timeout_ms from manifest.defaults.timeout_ms when spec omits it', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec({
        engine: {
          kind: 'command',
          command: ['bash', 'check.sh'],
          cwd: 'package',
          max_output_bytes: 1024 * 1024,
        } as Evaluator['engine'],
      }),
      package_manifest: makeManifest({ defaults: { timeout_ms: 8000 } }),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    });
    if (out.engine.kind === 'command') {
      expect(out.engine.timeout_ms).toBe(8000);
    } else {
      throw new Error('expected command engine');
    }
  });

  it('spec timeout_ms wins over manifest default', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec(),
      package_manifest: makeManifest({ defaults: { timeout_ms: 1000 } }),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    });
    if (out.engine.kind === 'command') {
      expect(out.engine.timeout_ms).toBe(5000); // from spec, not 1000
    }
  });

  it('fills in env.inherit from manifest when spec does not set env', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec(),
      package_manifest: makeManifest({
        defaults: { env: { inherit: ['PATH', 'HOME', 'LANG'] } },
      }),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    });
    if (out.engine.kind === 'command') {
      expect(out.engine.env.inherit).toEqual(['PATH', 'HOME', 'LANG']);
      expect(out.engine.env.set).toEqual({});
    }
  });

  it('spec env.inherit wins over manifest env.inherit (replace, not merge)', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec({
        engine: {
          kind: 'command',
          command: ['bash', 'x.sh'],
          cwd: 'package',
          timeout_ms: 5000,
          max_output_bytes: 1024 * 1024,
          env: { inherit: ['PATH'] },
        } as Evaluator['engine'],
      }),
      package_manifest: makeManifest({
        defaults: { env: { inherit: ['PATH', 'HOME', 'LANG'] } },
      }),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    });
    if (out.engine.kind === 'command') {
      expect(out.engine.env.inherit).toEqual(['PATH']);
    }
  });

  it('throws EvaluatorResolveError when neither spec nor manifest specifies timeout_ms', () => {
    expect(() =>
      resolveEvaluator({
        spec: makeCommandSpec({
          engine: {
            kind: 'command',
            command: ['bash', 'check.sh'],
            cwd: 'package',
            max_output_bytes: 1024 * 1024,
          } as Evaluator['engine'],
        }),
        package_manifest: makeManifest(),
        package_root: packageRoot,
        spec_path: specPath,
        description: 'desc',
      })
    ).toThrow(EvaluatorResolveError);
  });

  it('EvaluatorResolveError carries spec_path + field_path for missing timeout_ms', () => {
    try {
      resolveEvaluator({
        spec: makeCommandSpec({
          engine: {
            kind: 'command',
            command: ['bash', 'check.sh'],
            cwd: 'package',
            max_output_bytes: 1024 * 1024,
          } as Evaluator['engine'],
        }),
        package_manifest: makeManifest(),
        package_root: packageRoot,
        spec_path: specPath,
        description: 'desc',
      });
      throw new Error('expected resolveEvaluator to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EvaluatorResolveError);
      const e = err as EvaluatorResolveError;
      expect(e.spec_path).toBe(specPath);
      expect(e.field_path).toBe('engine.timeout_ms');
    }
  });
});

describe('resolveEvaluator — path resolution', () => {
  it('resolves a `./` command[0] against the pack root', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec({
        engine: {
          kind: 'command',
          command: ['./checks/plan_label_quality.sh'],
          cwd: 'package',
          timeout_ms: 5000,
          max_output_bytes: 1024 * 1024,
        } as Evaluator['engine'],
      }),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    });
    if (out.engine.kind === 'command') {
      expect(out.engine.command[0]).toBe(`${packageRoot}/checks/plan_label_quality.sh`);
    }
  });

  it('leaves a bare command (no `./`) untouched for PATH resolution at exec time', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec({
        engine: {
          kind: 'command',
          command: ['python3', './checks/x.py'],
          cwd: 'package',
          timeout_ms: 5000,
          max_output_bytes: 1024 * 1024,
        } as Evaluator['engine'],
      }),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    });
    if (out.engine.kind === 'command') {
      expect(out.engine.command[0]).toBe('python3');
      expect(out.engine.command[1]).toBe('./checks/x.py'); // non-zero args are passed verbatim
    }
  });

  it('leaves an absolute command[0] untouched', () => {
    const out = resolveEvaluator({
      spec: makeCommandSpec({
        engine: {
          kind: 'command',
          command: ['/usr/local/bin/check'],
          cwd: 'package',
          timeout_ms: 5000,
          max_output_bytes: 1024 * 1024,
        } as Evaluator['engine'],
      }),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    });
    if (out.engine.kind === 'command') {
      expect(out.engine.command[0]).toBe('/usr/local/bin/check');
    }
  });

  it('resolves the llm prompt_file against the pack root', () => {
    const out = resolveEvaluator({
      spec: makeLlmSpec(),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    });
    if (out.engine.kind === 'llm') {
      expect(out.engine.prompt_file).toBe(`${packageRoot}/prompts/scope-creep-detect.md`);
    }
  });

  it('rejects an absolute prompt_file outside the pack root', () => {
    expect(() =>
      resolveEvaluator({
        spec: makeLlmSpec({
          engine: {
            kind: 'llm',
            prompt_file: '/absolute/path/prompt.md',
            additional_context_sections: [],
            output_format: 'markdown',
            timeout_ms: 30000,
          } as Evaluator['engine'],
        }),
        package_manifest: makeManifest(),
        package_root: packageRoot,
        spec_path: specPath,
        description: 'desc',
      })
    ).toThrow(/outside the pack root/);
  });

  it('accepts an absolute prompt_file inside the pack root', () => {
    const prompt = `${packageRoot}/prompts/absolute.md`;
    const out = resolveEvaluator({
      spec: makeLlmSpec({
        engine: {
          kind: 'llm',
          prompt_file: prompt,
          additional_context_sections: [],
          output_format: 'markdown',
          timeout_ms: 30000,
        } as Evaluator['engine'],
      }),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
    });

    expect(out.engine.kind).toBe('llm');
    if (out.engine.kind !== 'llm') throw new Error('expected an LLM engine');
    expect(out.engine.prompt_file).toBe(prompt);
  });
});

describe('resolveEvaluator — params validation hook', () => {
  it('invokes validate_params when present, passing the resolved params and schema', () => {
    const calls: Array<{ params: unknown; schema: unknown }> = [];
    const input: ResolveEvaluatorInput = {
      spec: makeCommandSpec({
        params_schema: { type: 'object' },
        params: { foo: 1 },
      }),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
      override: { enabled: true, params: { foo: 2 } },
      validate_params: (params, schema) => {
        calls.push({ params, schema });
      },
    };
    resolveEvaluator(input);
    // Override was applied BEFORE validation, so the validator sees the
    // override value (replace semantics).
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ foo: 2 });
    expect(calls[0].schema).toEqual({ type: 'object' });
  });

  it('wraps a validate_params throw in EvaluatorResolveError with field_path "params"', () => {
    try {
      resolveEvaluator({
        spec: makeCommandSpec({
          params_schema: { type: 'object' },
        }),
        package_manifest: makeManifest(),
        package_root: packageRoot,
        spec_path: specPath,
        description: 'desc',
        validate_params: () => {
          throw new Error('schema violation: missing required field');
        },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EvaluatorResolveError);
      const e = err as EvaluatorResolveError;
      expect(e.field_path).toBe('params');
      expect(e.message).toMatch(/schema violation/);
    }
  });

  it('skips validation when params_schema is unset, even with a validate_params callback', () => {
    const calls: number[] = [];
    resolveEvaluator({
      spec: makeCommandSpec(),
      package_manifest: makeManifest(),
      package_root: packageRoot,
      spec_path: specPath,
      description: 'desc',
      validate_params: () => {
        calls.push(1);
      },
    });
    expect(calls).toEqual([]);
  });
});

describe('assertUniqueRefs', () => {
  it('passes on a unique list', () => {
    expect(() => assertUniqueRefs(['core/a', 'core/b', 'js/c'])).not.toThrow();
  });
  it('throws EvaluatorResolveError on duplicates', () => {
    try {
      assertUniqueRefs(['core/a', 'core/b', 'core/a']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EvaluatorResolveError);
      const e = err as EvaluatorResolveError;
      expect(e.field_path).toBe('evaluators[2].ref');
      expect(e.message).toMatch(/duplicate evaluator ref "core\/a"/);
    }
  });
});

describe('overridesByRef', () => {
  it('builds a ref → override map from a parsed config', () => {
    const config = EvaluatorConfigSchema.parse({
      schema: 'orcaops.evaluator_config/v2',
      packages: [{ id: 'core', source: { kind: 'path', path: './' } }],
      evaluators: {
        'core/a': { enabled: true },
        'core/b': { enabled: false, severity: 'warn' },
      },
    });
    const map = overridesByRef(config);
    expect(map.get('core/a')).toEqual({ enabled: true });
    expect(map.get('core/b')).toEqual({ enabled: false, severity: 'warn' });
    expect(map.get('core/unknown')).toBeUndefined();
  });
});
