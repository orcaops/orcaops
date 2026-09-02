import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type EvaluatorContext,
  EvaluatorPackageSchema,
  EvaluatorSchema,
  type ResolvedEvaluator,
  resolveEvaluator,
} from '@orcaops/evaluator-protocol';
import type { EvaluateOptions, EvaluateResult, LLMClient } from '@orcaops/llm';

import { dispatchEvaluators } from './dispatch.js';
import {
  PROVIDER_CAPABILITY_FLOORS,
  requiredTrustCapabilities,
  type TrustCapability,
} from './trust-capability.js';

const RUN_ID = '01HXRUN0000000000000000000';

// Every dispatch test predates the consent gate and exercises engine/filter
// behavior, not trust — grant the synthetic 'core' package every capability
// so the gate passes through. Consent refusal has its own tests below.
const ALL_TRUSTED = new Map([
  [
    'core',
    {
      verdict: 'trusted',
      capabilities: [
        'command_evaluators_present',
        'llm_evaluators_present',
        'file_reading_llm_evaluator_present',
      ],
    } as const,
  ],
]);

function makeContext(overrides: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return {
    schema: 'orcaops.evaluator_context/v1',
    run_id: RUN_ID,
    evaluator_ref: 'core/test',
    phase: 'post-plan',
    artifact_id: 'art-1',
    checkpoint_n: null,
    repo: { root: '/repo', branch: 'main', base_sha: 'sha', head_sha: 'sha' },
    plan: {
      task: 'demo',
      label: 'demo',
      branch: 'main',
      base_sha: 'sha',
      agent: null,
      agent_session_id: null,
      plan_steps: [],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      started_at: '2026-05-12T20:00:00.000Z',
    },
    prior_plan: null,
    source_plan: null,
    current_checkpoint: null,
    closed_checkpoints: [],
    open_checkpoints: [],
    abandoned_checkpoints: [],
    summary: null,
    changed_files: [],
    params: {},
    ...overrides,
  };
}

function makeCommandEvaluator(opts: {
  id: string;
  scriptPath: string;
  packageRoot: string;
  filters?: { paths?: string[]; scopes?: string[]; when_llm?: 'required' | 'absent' | 'optional' };
}): ResolvedEvaluator {
  return {
    ref: `core/${opts.id}`,
    package_id: 'core',
    evaluator_id: opts.id,
    package_root: opts.packageRoot,
    spec_path: path.join(opts.packageRoot, 'evaluators', `${opts.id}.eval.yaml`),
    phase: 'post-plan',
    severity: 'info',
    description: opts.id,
    engine: {
      kind: 'command',
      command: [opts.scriptPath],
      cwd: 'package',
      timeout_ms: 5000,
      max_output_bytes: 1024 * 1024,
      env: { inherit: ['PATH'], set: {} },
    },
    params: {},
    filters: {
      paths: opts.filters?.paths ?? [],
      scopes: opts.filters?.scopes ?? [],
      when_llm: opts.filters?.when_llm ?? 'optional',
    },
    resolution: {
      acknowledge: { enabled: false },
      policy_exception: { enabled: false },
    },
    fingerprint_include: [],
    enabled: true,
  };
}

function makeStubClient(
  response: EvaluateResult,
  defaultProvider: 'claude' | 'codex' | null = 'claude',
  availability: Readonly<Record<'claude' | 'codex', boolean>> = { claude: true, codex: true }
): LLMClient & {
  evaluateCallCount: number;
} {
  let count = 0;
  function* evaluate(_opts: EvaluateOptions): Generator<unknown, EvaluateResult> {
    count += 1;
    yield* [];
    return response;
  }
  const client = {
    isDeterministic: false,
    defaultProvider,
    isProviderAvailable: (provider: 'claude' | 'codex') => availability[provider],
    evaluate,
    get evaluateCallCount() {
      return count;
    },
  } as unknown as LLMClient & { evaluateCallCount: number };
  return client;
}

describe('dispatchEvaluators', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-dispatch-test-'));
    await mkdir(path.join(tmpRoot, 'checks'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeScript(name: string, body: string): Promise<string> {
    const filePath = path.join(tmpRoot, 'checks', name);
    await writeFile(filePath, `#!/bin/bash\n${body}\n`, 'utf8');
    await chmod(filePath, 0o755);
    return filePath;
  }

  it('dispatches every evaluator and returns results in input order', async () => {
    const scriptA = await writeScript(
      'a.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"pass","body":"A"}
JSON`
    );
    const scriptB = await writeScript(
      'b.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"info","body":"B"}
JSON`
    );
    const evaluators = [
      makeCommandEvaluator({ id: 'a', scriptPath: scriptA, packageRoot: tmpRoot }),
      makeCommandEvaluator({ id: 'b', scriptPath: scriptB, packageRoot: tmpRoot }),
    ];
    const out = await dispatchEvaluators({
      evaluators,
      trust: ALL_TRUSTED,
      context: makeContext(),
      llm: makeStubClient({} as EvaluateResult),
    });
    expect(out.runs).toHaveLength(2);
    expect(out.runs[0].evaluator_id).toBe('a');
    expect(out.runs[0].verdict).toBe('pass');
    expect(out.runs[1].evaluator_id).toBe('b');
    expect(out.runs[1].verdict).toBe('info');
  });

  // Dispatch-level skip-reason coverage. Three tests that
  // exercise the full dispatchEvaluators → makeSkippedRun pipeline
  // for each of the filter gates. Filter unit tests at
  // filter.test.ts cover the individual predicates; these tests
  // verify the dispatch caller wires the reason into the run body.

  it('skip-reason — filters.paths zero-match against changed_files surfaces in the run body', async () => {
    const scriptA = await writeScript(
      'paths-skip.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"pass","body":"A"}
JSON`
    );
    const evaluators = [
      makeCommandEvaluator({
        id: 'paths-skip',
        scriptPath: scriptA,
        packageRoot: tmpRoot,
        filters: { paths: ['src/**/*.py'] },
      }),
    ];
    const out = await dispatchEvaluators({
      evaluators,
      trust: ALL_TRUSTED,
      context: makeContext({ changed_files: ['src/foo.ts'] }),
      llm: makeStubClient({} as EvaluateResult),
    });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].run_status).toBe('skipped');
    expect(out.runs[0].body).toMatch(/no changed file matches filters.paths/);
  });

  it('skip-reason — filters.scopes disjoint from plan.touched_scope surfaces in the run body', async () => {
    const scriptA = await writeScript(
      'scopes-skip.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"pass","body":"A"}
JSON`
    );
    const evaluators = [
      makeCommandEvaluator({
        id: 'scopes-skip',
        scriptPath: scriptA,
        packageRoot: tmpRoot,
        filters: { scopes: ['security', 'pii'] },
      }),
    ];
    const out = await dispatchEvaluators({
      evaluators,
      trust: ALL_TRUSTED,
      context: makeContext({
        plan: { ...makeContext().plan, touched_scope: ['payments'] },
      }),
      llm: makeStubClient({} as EvaluateResult),
    });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].run_status).toBe('skipped');
    expect(out.runs[0].body).toMatch(/filters\.scopes \[security, pii\]/);
  });

  it('skip-reason — filters.when_llm=required + deterministic LLM surfaces in the run body', async () => {
    const scriptA = await writeScript(
      'llm-skip.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"pass","body":"A"}
JSON`
    );
    const evaluators = [
      makeCommandEvaluator({
        id: 'llm-skip',
        scriptPath: scriptA,
        packageRoot: tmpRoot,
        filters: { when_llm: 'required' },
      }),
    ];
    // makeStubClient defaults to isDeterministic: false; for this
    // test the required filter must trip, so synthesize a
    // deterministic LLM client inline.
    const detLlm = {
      ...makeStubClient({} as EvaluateResult),
      isDeterministic: true,
    } as unknown as LLMClient;
    const out = await dispatchEvaluators({
      evaluators,
      trust: ALL_TRUSTED,
      context: makeContext(),
      llm: detLlm,
    });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].run_status).toBe('skipped');
    expect(out.runs[0].body).toMatch(
      /filters\.when_llm=required but no LLM provider is configured/
    );
  });

  it('runs a when_llm absent command evaluator when the selected provider is unavailable', async () => {
    const script = await writeScript(
      'llm-absent.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"info","body":"No LLM available"}
JSON`
    );
    const evaluator = makeCommandEvaluator({
      id: 'llm-absent',
      scriptPath: script,
      packageRoot: tmpRoot,
      filters: { when_llm: 'absent' },
    });
    const llm = makeStubClient({} as EvaluateResult, 'claude', {
      claude: false,
      codex: true,
    });

    const out = await dispatchEvaluators({
      evaluators: [evaluator],
      trust: ALL_TRUSTED,
      context: makeContext(),
      llm,
    });

    expect(out.runs[0]).toMatchObject({ run_status: 'completed', verdict: 'info' });
    expect(out.runs[0].body).toContain('No LLM available');
  });

  it('produces skipped runs (no engine dispatch) for filter-excluded evaluators', async () => {
    const scriptA = await writeScript(
      'a.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"pass","body":"A"}
JSON`
    );
    // Evaluator B declares filters.paths but no changed files; expect skip.
    const evaluators = [
      makeCommandEvaluator({ id: 'a', scriptPath: scriptA, packageRoot: tmpRoot }),
      makeCommandEvaluator({
        id: 'b',
        scriptPath: '/nonexistent',
        packageRoot: tmpRoot,
        filters: { paths: ['src/**/*.py'] },
      }),
    ];
    const out = await dispatchEvaluators({
      evaluators,
      trust: ALL_TRUSTED,
      context: makeContext({ changed_files: [] }),
      llm: makeStubClient({} as EvaluateResult),
    });
    expect(out.runs[0].run_status).toBe('completed');
    expect(out.runs[1].run_status).toBe('skipped');
    expect(out.runs[1].verdict).toBeNull();
    expect(out.runs[1].body).toMatch(/SKIPPED/);
  });

  it('runs command evaluators faster with four workers than with one', async () => {
    // Compare both modes on the same host so process-startup speed and
    // machine load cannot turn the concurrency assertion into a fixed-time
    // benchmark.
    const script = await writeScript(
      'slow.sh',
      `sleep 0.25
cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"info","body":"done"}
JSON`
    );
    const evaluators = Array.from({ length: 8 }, (_, i) =>
      makeCommandEvaluator({ id: `slow-${i}`, scriptPath: script, packageRoot: tmpRoot })
    );

    const serialStart = Date.now();
    const serial = await dispatchEvaluators({
      evaluators,
      trust: ALL_TRUSTED,
      context: makeContext(),
      llm: makeStubClient({} as EvaluateResult),
      maxConcurrent: 1,
    });
    const serialElapsed = Date.now() - serialStart;

    const concurrentStart = Date.now();
    const out = await dispatchEvaluators({
      evaluators,
      trust: ALL_TRUSTED,
      context: makeContext(),
      llm: makeStubClient({} as EvaluateResult),
      maxConcurrent: 4,
    });
    const concurrentElapsed = Date.now() - concurrentStart;

    expect(serial.runs.every((r) => r.run_status === 'completed')).toBe(true);
    expect(out.runs).toHaveLength(8);
    expect(out.runs.every((r) => r.run_status === 'completed')).toBe(true);
    expect(concurrentElapsed).toBeLessThan(serialElapsed * 0.8);
  });

  it('caps maxConcurrent to the number of evaluators (no over-spawning workers)', async () => {
    const script = await writeScript(
      'pass.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"pass","body":"ok"}
JSON`
    );
    const evaluators = [
      makeCommandEvaluator({ id: 'a', scriptPath: script, packageRoot: tmpRoot }),
    ];
    const out = await dispatchEvaluators({
      evaluators,
      trust: ALL_TRUSTED,
      context: makeContext(),
      llm: makeStubClient({} as EvaluateResult),
      maxConcurrent: 100,
    });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].run_status).toBe('completed');
  });

  it('routes llm-engine evaluators to the LLM engine without spawning a subprocess', async () => {
    const promptFile = path.join(tmpRoot, 'prompt.md');
    await writeFile(promptFile, 'Decide.', 'utf8');
    const evaluator: ResolvedEvaluator = {
      ref: 'core/llm-eval',
      package_id: 'core',
      evaluator_id: 'llm-eval',
      package_root: tmpRoot,
      spec_path: path.join(tmpRoot, 'evaluators', 'llm-eval.eval.yaml'),
      phase: 'post-plan',
      severity: 'info',
      description: 'fixture',
      engine: {
        kind: 'llm',
        prompt_file: promptFile,
        additional_context_sections: [],
        output_format: 'markdown',
        timeout_ms: 30000,
      },
      params: {},
      filters: { paths: [], scopes: [], when_llm: 'optional' },
      resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
      fingerprint_include: [],
      enabled: true,
    };
    const llm = makeStubClient({
      body: 'PASS\n\nlooks good',
      model: 'claude-test',
      sessionId: 'sess',
      durationMs: 50,
    });
    const out = await dispatchEvaluators({
      trust: ALL_TRUSTED,
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });
    expect(llm.evaluateCallCount).toBe(1);
    expect(out.runs[0].run_status).toBe('completed');
    expect(out.runs[0].verdict).toBe('pass');
  });

  it('records optional LLM evaluators as skipped when no provider executes', async () => {
    const promptFile = path.join(tmpRoot, 'prompt.md');
    await writeFile(promptFile, 'Decide.', 'utf8');
    const evaluator: ResolvedEvaluator = {
      ref: 'core/llm-eval',
      package_id: 'core',
      evaluator_id: 'llm-eval',
      package_root: tmpRoot,
      spec_path: path.join(tmpRoot, 'evaluators', 'llm-eval.eval.yaml'),
      phase: 'post-plan',
      severity: 'info',
      description: 'fixture',
      engine: {
        kind: 'llm',
        prompt_file: promptFile,
        additional_context_sections: [],
        output_format: 'markdown',
        timeout_ms: 30000,
      },
      params: {},
      filters: { paths: [], scopes: [], when_llm: 'optional' },
      resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
      fingerprint_include: [],
      enabled: true,
    };
    const llm = makeStubClient({} as EvaluateResult, null);
    Object.defineProperty(llm, 'isDeterministic', { value: true });

    const out = await dispatchEvaluators({
      trust: ALL_TRUSTED,
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });

    expect(llm.evaluateCallCount).toBe(0);
    expect(out.runs[0]).toMatchObject({ run_status: 'skipped', verdict: null });
    expect(out.runs[0].body).toMatch(/no LLM provider executed/);
  });

  it('records an unavailable user-selected provider as a visible skip without evaluating', async () => {
    const promptFile = path.join(tmpRoot, 'prompt.md');
    await writeFile(promptFile, 'Decide.', 'utf8');
    const evaluator: ResolvedEvaluator = {
      ref: 'core/llm-eval',
      package_id: 'core',
      evaluator_id: 'llm-eval',
      package_root: tmpRoot,
      spec_path: path.join(tmpRoot, 'evaluators', 'llm-eval.eval.yaml'),
      phase: 'post-plan',
      severity: 'info',
      description: 'fixture',
      engine: {
        kind: 'llm',
        prompt_file: promptFile,
        additional_context_sections: [],
        output_format: 'markdown',
        provider: 'codex',
        timeout_ms: 30000,
        selection_sources: {
          provider: 'user-override',
          model: 'global',
          timeout_ms: 'pack-default',
        },
      },
      params: {},
      filters: { paths: [], scopes: [], when_llm: 'required' },
      resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
      fingerprint_include: [],
      enabled: true,
    };
    const llm = makeStubClient({} as EvaluateResult, 'claude', { claude: true, codex: false });
    const out = await dispatchEvaluators({
      trust: ALL_TRUSTED,
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });
    expect(llm.evaluateCallCount).toBe(0);
    expect(out.runs[0]).toMatchObject({
      run_status: 'skipped',
      provider: 'codex',
      verdict: null,
    });
    expect(out.runs[0].body).toContain(
      'resolved provider codex is not installed (selected by your .orcaops/evaluators.yaml override)'
    );
  });

  it('attributes an unavailable global provider to a user null-clear override', async () => {
    const promptFile = path.join(tmpRoot, 'prompt.md');
    await writeFile(promptFile, 'Decide.', 'utf8');
    const evaluator = resolveEvaluator({
      spec: EvaluatorSchema.parse({
        schema: 'orcaops.evaluator/v1',
        id: 'llm-eval',
        phase: 'post-plan',
        severity: 'info',
        description: 'fixture',
        engine: {
          kind: 'llm',
          prompt_file: './prompt.md',
          additional_context_sections: [],
          provider: 'codex',
          timeout_ms: 30_000,
        },
      }),
      package_manifest: EvaluatorPackageSchema.parse({
        schema: 'orcaops.evaluator_package/v1',
        id: 'core',
        name: 'Core',
        version: '0.1.0',
        description: 'fixture',
      }),
      package_root: tmpRoot,
      spec_path: path.join(tmpRoot, 'llm-eval.eval.yaml'),
      description: 'fixture',
      override: { enabled: true, engine: { provider: null } },
    });
    const llm = makeStubClient({} as EvaluateResult, 'claude', {
      claude: false,
      codex: true,
    });

    const out = await dispatchEvaluators({
      trust: ALL_TRUSTED,
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });

    expect(llm.evaluateCallCount).toBe(0);
    expect(out.runs[0].body).toContain(
      'resolved provider claude is not installed (provider pin cleared by your .orcaops/evaluators.yaml override; selected from global llm.tool)'
    );
  });

  it.each([
    ['claude', 'codex'],
    ['codex', 'claude'],
  ] as const)(
    'runs an available %s user override instead of an unavailable %s pack pin',
    async (availableProvider, unavailablePin) => {
      const promptFile = path.join(tmpRoot, 'prompt.md');
      await writeFile(promptFile, 'Decide.', 'utf8');
      const evaluator = resolveEvaluator({
        spec: EvaluatorSchema.parse({
          schema: 'orcaops.evaluator/v1',
          id: 'llm-eval',
          phase: 'post-plan',
          severity: 'info',
          description: 'fixture',
          engine: {
            kind: 'llm',
            prompt_file: './prompt.md',
            additional_context_sections: [],
            provider: unavailablePin,
            timeout_ms: 30_000,
          },
        }),
        package_manifest: EvaluatorPackageSchema.parse({
          schema: 'orcaops.evaluator_package/v1',
          id: 'core',
          name: 'Core',
          version: '0.1.0',
          description: 'fixture',
        }),
        package_root: tmpRoot,
        spec_path: path.join(tmpRoot, 'llm-eval.eval.yaml'),
        description: 'fixture',
        override: { enabled: true, engine: { provider: availableProvider } },
      });
      const availability = {
        claude: availableProvider === 'claude',
        codex: availableProvider === 'codex',
      };
      const llm = makeStubClient(
        { body: 'PASS', model: 'test-model', sessionId: 's', durationMs: 1 },
        unavailablePin,
        availability
      );
      const out = await dispatchEvaluators({
        trust: ALL_TRUSTED,
        evaluators: [evaluator],
        context: makeContext(),
        llm,
      });
      expect(llm.evaluateCallCount).toBe(1);
      expect(out.runs[0]).toMatchObject({
        run_status: 'completed',
        provider: availableProvider,
      });
    }
  );

  it('uses the injected runIdFactory for run_id assignment', async () => {
    const script = await writeScript(
      'pass.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"pass","body":"ok"}
JSON`
    );
    let n = 0;
    const factory = (): string => `injected-${++n}`;
    const out = await dispatchEvaluators({
      trust: ALL_TRUSTED,
      evaluators: [
        makeCommandEvaluator({ id: 'a', scriptPath: script, packageRoot: tmpRoot }),
        makeCommandEvaluator({ id: 'b', scriptPath: script, packageRoot: tmpRoot }),
      ],
      context: makeContext(),
      llm: makeStubClient({} as EvaluateResult),
      runIdFactory: factory,
      maxConcurrent: 1, // determinism for run_id assignment
    });
    expect(out.runs[0].run_id).toBe('injected-1');
    expect(out.runs[1].run_id).toBe('injected-2');
  });

  it('returns an empty array when evaluators[] is empty', async () => {
    const out = await dispatchEvaluators({
      trust: ALL_TRUSTED,
      evaluators: [],
      context: makeContext(),
      llm: makeStubClient({} as EvaluateResult),
    });
    expect(out.runs).toEqual([]);
  });

  it('threads per-evaluator params into the subprocess context (not the base context)', async () => {
    // Each script copies its received context.json to a side file
    // keyed by ORCAOPS_EVALUATOR_REF. After dispatch we read both
    // files and assert each evaluator's subprocess saw its own
    // resolved `params`, not the base context's.
    const sideDir = path.join(tmpRoot, 'side');
    await mkdir(sideDir, { recursive: true });
    const echoScript = await writeScript(
      'echo.sh',
      `cp "$ORCAOPS_CONTEXT_PATH" "${sideDir}/$(echo "$ORCAOPS_EVALUATOR_REF" | tr / _).json"
cat <<JSON
{"schema":"orcaops.evaluator_result/v1","verdict":"info","body":"ok"}
JSON`
    );
    const evA = makeCommandEvaluator({ id: 'a', scriptPath: echoScript, packageRoot: tmpRoot });
    const evB = makeCommandEvaluator({ id: 'b', scriptPath: echoScript, packageRoot: tmpRoot });
    evA.params = { tag: 'alpha' };
    evB.params = { tag: 'beta' };
    const out = await dispatchEvaluators({
      trust: ALL_TRUSTED,
      evaluators: [evA, evB],
      context: makeContext({ params: { tag: 'base' } }),
      llm: makeStubClient({} as EvaluateResult),
    });
    expect(out.runs).toHaveLength(2);
    expect(out.runs.every((r) => r.run_status === 'completed')).toBe(true);
    const { readFile } = await import('node:fs/promises');
    const ctxA = JSON.parse(await readFile(path.join(sideDir, 'core_a.json'), 'utf8')) as {
      params: Record<string, unknown>;
      evaluator_ref: string;
    };
    const ctxB = JSON.parse(await readFile(path.join(sideDir, 'core_b.json'), 'utf8')) as {
      params: Record<string, unknown>;
      evaluator_ref: string;
    };
    expect(ctxA.params).toEqual({ tag: 'alpha' });
    expect(ctxA.evaluator_ref).toBe('core/a');
    expect(ctxB.params).toEqual({ tag: 'beta' });
    expect(ctxB.evaluator_ref).toBe('core/b');
  });

  it('propagates an AbortSignal to in-flight command-engine subprocesses', async () => {
    const script = await writeScript('wait.sh', `sleep 2`);
    const evaluators = [
      makeCommandEvaluator({ id: 'slow', scriptPath: script, packageRoot: tmpRoot }),
    ];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const out = await dispatchEvaluators({
      evaluators,
      trust: ALL_TRUSTED,
      context: makeContext(),
      llm: makeStubClient({} as EvaluateResult),
      signal: controller.signal,
    });
    expect(out.runs[0].run_status).toBe('error');
    expect(out.runs[0].error?.code).toBe('CANCELED');
  });
});

describe('requiredTrustCapabilities', () => {
  const base = {
    ref: 'p/x',
    package_id: 'p',
    evaluator_id: 'x',
    package_root: '/tmp/p',
    spec_path: '/tmp/p/x.eval.yaml',
    phase: 'post-plan' as const,
    severity: 'warn' as const,
    description: 'd',
    params: {},
    filters: { paths: [], scopes: [], when_llm: 'optional' as const },
    resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
    fingerprint_include: [],
    enabled: true,
  };

  it('defines provider capability floors independently of provider-name checks', () => {
    expect(PROVIDER_CAPABILITY_FLOORS).toEqual({
      claude: [],
      codex: ['file_reading_llm_evaluator_present'],
    });
  });

  it('applies every capability declared by the effective provider floor', () => {
    const floors = PROVIDER_CAPABILITY_FLOORS as Record<
      'claude' | 'codex',
      readonly TrustCapability[]
    >;
    const originalCodexFloor = floors.codex;
    floors.codex = [...originalCodexFloor, 'command_evaluators_present'];
    try {
      expect(
        requiredTrustCapabilities(
          {
            kind: 'llm',
            provider: 'codex',
          },
          'claude'
        )
      ).toEqual([
        'llm_evaluators_present',
        'file_reading_llm_evaluator_present',
        'command_evaluators_present',
      ]);
    } finally {
      floors.codex = originalCodexFloor;
    }
  });

  it('command engines require the command capability', () => {
    const ev = {
      ...base,
      engine: {
        kind: 'command',
        command: ['node', 'x.js'],
        cwd: 'package',
        timeout_ms: 1000,
        max_output_bytes: 1000,
        env: { inherit: [], set: {} },
      },
    } as unknown as ResolvedEvaluator;
    expect(requiredTrustCapabilities(ev.engine)).toEqual(['command_evaluators_present']);
  });

  it('a codex-provider LLM evaluator is file-reading even WITHOUT tool_policy', () => {
    // codex exposes file-reading tools, so provider selection alone reaches a
    // file-reading engine.
    const ev = {
      ...base,
      engine: {
        kind: 'llm',
        prompt_file: '/tmp/p/p.md',
        additional_context_sections: [],
        output_format: 'markdown',
        provider: 'codex',
        timeout_ms: 1000,
      },
    } as unknown as ResolvedEvaluator;
    expect(requiredTrustCapabilities(ev.engine)).toEqual([
      'llm_evaluators_present',
      'file_reading_llm_evaluator_present',
    ]);
  });

  it('a plain LLM evaluator always requires authenticated LLM consent', () => {
    const engine = {
      kind: 'llm',
      prompt_file: '/tmp/p/p.md',
      additional_context_sections: [],
      output_format: 'markdown',
      timeout_ms: 1000,
    } as const;
    expect(requiredTrustCapabilities(engine, 'claude')).toEqual(['llm_evaluators_present']);
    expect(requiredTrustCapabilities(engine, null)).toEqual(['llm_evaluators_present']);
    expect(requiredTrustCapabilities(engine, 'codex')).toEqual([
      'llm_evaluators_present',
      'file_reading_llm_evaluator_present',
    ]);
  });

  it('command-filtered tool_policy gates regardless of provider', () => {
    const ev = {
      ...base,
      engine: {
        kind: 'llm',
        prompt_file: '/tmp/p/p.md',
        additional_context_sections: [],
        output_format: 'markdown',
        timeout_ms: 1000,
        tool_policy: { mode: 'command-filtered' },
      },
    } as unknown as ResolvedEvaluator;
    expect(requiredTrustCapabilities(ev.engine)).toEqual([
      'llm_evaluators_present',
      'file_reading_llm_evaluator_present',
    ]);
  });
});

describe('consent gate under a codex default provider', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-dispatch-codex-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeImplicitLlmEvaluator(): Promise<ResolvedEvaluator> {
    const promptFile = path.join(tmpRoot, 'prompt.md');
    await writeFile(promptFile, 'Decide.', 'utf8');
    return {
      ref: 'core/implicit-llm',
      package_id: 'core',
      evaluator_id: 'implicit-llm',
      package_root: tmpRoot,
      spec_path: path.join(tmpRoot, 'evaluators', 'implicit-llm.eval.yaml'),
      phase: 'post-plan',
      severity: 'info',
      description: 'declares neither provider nor tool_policy',
      engine: {
        kind: 'llm',
        prompt_file: promptFile,
        additional_context_sections: [],
        output_format: 'markdown',
        timeout_ms: 30000,
      },
      params: {},
      filters: { paths: [], scopes: [], when_llm: 'optional' },
      resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
      fingerprint_include: [],
      enabled: true,
    };
  }

  it('a grant carrying the file-reading capability lets the implicit evaluator execute', async () => {
    const evaluator = await makeImplicitLlmEvaluator();
    const llm = makeStubClient(
      { body: 'PASS\n\nok', model: 'codex-test', sessionId: 'sess', durationMs: 5 },
      'codex'
    );
    const out = await dispatchEvaluators({
      trust: new Map([
        [
          'core',
          {
            verdict: 'trusted',
            capabilities: ['llm_evaluators_present', 'file_reading_llm_evaluator_present'],
          } as const,
        ],
      ]),
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });
    expect(llm.evaluateCallCount).toBe(1);
    expect(out.runs[0].run_status).toBe('completed');
  });

  it('a grant WITHOUT the file-reading capability is refused before the engine', async () => {
    const evaluator = await makeImplicitLlmEvaluator();
    const llm = makeStubClient(
      { body: 'PASS\n\nok', model: 'codex-test', sessionId: 'sess', durationMs: 5 },
      'codex'
    );
    const out = await dispatchEvaluators({
      trust: new Map([
        ['core', { verdict: 'trusted', capabilities: ['command_evaluators_present'] } as const],
      ]),
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });
    expect(llm.evaluateCallCount).toBe(0);
    expect(out.runs[0].run_status).toBe('error');
    expect(out.runs[0].error?.code).toBe('CONSENT_DENIED');
    expect(out.runs[0].error?.message).toContain('file_reading_llm_evaluator_present');
  });

  it('refuses a capability-short provider override before checking availability', async () => {
    const evaluator = await makeImplicitLlmEvaluator();
    if (evaluator.engine.kind !== 'llm') throw new Error('expected LLM evaluator');
    evaluator.engine.selection_sources = {
      provider: 'user-override',
      model: 'global',
      timeout_ms: 'pack-default',
    };
    const llm = makeStubClient(
      { body: 'PASS\n\nok', model: 'codex-test', sessionId: 'sess', durationMs: 5 },
      'codex',
      { claude: true, codex: false }
    );
    const out = await dispatchEvaluators({
      trust: new Map([
        ['core', { verdict: 'trusted', capabilities: ['llm_evaluators_present'] } as const],
      ]),
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });
    expect(llm.evaluateCallCount).toBe(0);
    expect(out.runs[0].error?.code).toBe('CONSENT_DENIED');
    expect(out.runs[0].error?.message).toContain('.orcaops/evaluators.yaml provider override');
    expect(out.runs[0].body).not.toContain('not installed');
  });

  it('a legacy file-reading-only grant is refused without the LLM capability', async () => {
    const evaluator = await makeImplicitLlmEvaluator();
    const llm = makeStubClient(
      { body: 'PASS\n\nok', model: 'codex-test', sessionId: 'sess', durationMs: 5 },
      'codex'
    );
    const out = await dispatchEvaluators({
      trust: new Map([
        [
          'core',
          {
            verdict: 'trusted',
            capabilities: ['file_reading_llm_evaluator_present'],
          } as const,
        ],
      ]),
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });

    expect(llm.evaluateCallCount).toBe(0);
    expect(out.runs[0].error?.message).toContain('llm_evaluators_present');
  });
});

describe('consent gate under a Claude provider', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-dispatch-claude-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function makePlainClaudeEvaluator(): Promise<ResolvedEvaluator> {
    const promptFile = path.join(tmpRoot, 'prompt.md');
    await writeFile(promptFile, 'Decide.', 'utf8');
    return {
      ref: 'core/plain-claude',
      package_id: 'core',
      evaluator_id: 'plain-claude',
      package_root: tmpRoot,
      spec_path: path.join(tmpRoot, 'plain-claude.eval.yaml'),
      phase: 'post-plan',
      severity: 'info',
      description: 'uses the authenticated Claude provider',
      engine: {
        kind: 'llm',
        prompt_file: promptFile,
        additional_context_sections: [],
        output_format: 'markdown',
        provider: 'claude',
        timeout_ms: 30000,
      },
      params: {},
      filters: { paths: [], scopes: [], when_llm: 'optional' },
      resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
      fingerprint_include: [],
      enabled: true,
    };
  }

  it('refuses an ungranted plain Claude evaluator before calling the provider', async () => {
    const evaluator = await makePlainClaudeEvaluator();
    const llm = makeStubClient(
      { body: 'PASS\n\nok', model: 'claude-test', sessionId: 'sess', durationMs: 5 },
      'claude'
    );
    const out = await dispatchEvaluators({
      trust: new Map(),
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });

    expect(llm.evaluateCallCount).toBe(0);
    expect(out.runs[0].error?.code).toBe('CONSENT_DENIED');
    expect(out.runs[0].error?.message).toContain('no trust decision');
  });

  it('executes only when the grant carries the LLM capability', async () => {
    const evaluator = await makePlainClaudeEvaluator();
    const llm = makeStubClient(
      { body: 'PASS\n\nok', model: 'claude-test', sessionId: 'sess', durationMs: 5 },
      'claude'
    );
    const out = await dispatchEvaluators({
      trust: new Map([
        ['core', { verdict: 'trusted', capabilities: ['llm_evaluators_present'] } as const],
      ]),
      evaluators: [evaluator],
      context: makeContext(),
      llm,
    });

    expect(llm.evaluateCallCount).toBe(1);
    expect(out.runs[0].run_status).toBe('completed');
  });
});
