import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ContextSection,
  type EvaluatorContext,
  type ResolvedEvaluator,
} from '@orcaops/evaluator-protocol';
import {
  deterministicClient,
  type EvaluateOptions,
  type EvaluateResult,
  type LLMClient,
  ORCAOPS_EVALUATOR_SYSTEM_PROMPT,
} from '@orcaops/llm';

import { runLlmEngine } from './llm.js';

const RUN_ID = '01HXRUN0000000000000000000';

function makeContext(overrides: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return {
    schema: 'orcaops.evaluator_context/v1',
    run_id: RUN_ID,
    evaluator_ref: 'core/scope-creep-detect',
    phase: 'checkpoint-close',
    artifact_id: '01HXART0000000000000000000',
    checkpoint_n: 2,
    repo: {
      root: '/tmp/orcaops-test-repo',
      branch: 'main',
      base_sha: 'sha-base',
      head_sha: 'sha-head',
    },
    plan: {
      task: 'add rate limiting to /api/charge',
      label: 'rate limit',
      branch: 'main',
      base_sha: 'sha-base',
      agent: null,
      agent_session_id: null,
      plan_steps: [
        { step_id: 'step-1', text: 'add middleware', label: 'middleware', acceptance_criteria: [] },
        { step_id: 'step-2', text: 'tests', label: 'tests', acceptance_criteria: [] },
      ],
      touched_scope: ['payments'],
      non_goals: [
        {
          text: 'no schema migration',
          rationale: 'out of scope for this slice',
          source_refs: ['section 2'],
        },
      ],
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
    changed_files: ['src/middleware/rate-limit.ts'],
    params: {},
    ...overrides,
  };
}

function makeLlmEvaluator(overrides: {
  prompt_file: string;
  package_root: string;
  output_format?: 'markdown' | 'json';
  output_schema?: Record<string, unknown>;
  timeout_ms?: number;
  ref?: string;
  additional_context_sections?: ContextSection[];
}): ResolvedEvaluator {
  return {
    ref: overrides.ref ?? 'core/scope-creep-detect',
    package_id: 'core',
    evaluator_id: 'scope-creep-detect',
    package_root: overrides.package_root,
    spec_path: path.join(overrides.package_root, 'evaluators', 'scope-creep-detect.eval.yaml'),
    phase: 'checkpoint-close',
    severity: 'warn',
    description: 'fixture llm evaluator',
    engine: {
      kind: 'llm',
      prompt_file: overrides.prompt_file,
      additional_context_sections: overrides.additional_context_sections ?? [],
      output_format: overrides.output_format ?? 'markdown',
      timeout_ms: overrides.timeout_ms ?? 30000,
      ...(overrides.output_schema !== undefined ? { output_schema: overrides.output_schema } : {}),
    },
    params: {},
    filters: { paths: [], scopes: [], when_llm: 'optional' },
    resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
    fingerprint_include: [],
    enabled: true,
  };
}

/**
 * Build a deterministic-stub LLMClient. The `evaluate` method is
 * an Effection Operation (generator); the no-op `yield* []` at the
 * top satisfies eslint's require-yield without changing semantics
 * since the runtime never reaches a real yield point.
 */
function makeStubClient(...responses: EvaluateResult[]): LLMClient & {
  calls: EvaluateOptions[];
} {
  const calls: EvaluateOptions[] = [];
  let cursor = 0;
  function* evaluate(opts: EvaluateOptions): Generator<unknown, EvaluateResult> {
    calls.push(opts);
    const idx = Math.min(cursor, responses.length - 1);
    cursor += 1;
    yield* [];
    return responses[idx];
  }
  return {
    isDeterministic: false,
    defaultProvider: 'claude',
    evaluate,
    calls,
  } as unknown as LLMClient & { calls: EvaluateOptions[] };
}

describe('runLlmEngine — markdown mode', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-llm-test-'));
    await mkdir(path.join(tmpRoot, 'prompts'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writePrompt(contents: string): Promise<string> {
    const filePath = path.join(tmpRoot, 'prompts', 'scope-creep.md');
    await writeFile(filePath, contents, 'utf8');
    return filePath;
  }

  it('reports LLM_UNAVAILABLE instead of parsing a synthetic verdict', async () => {
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: 'prompts/not-read.md',
        package_root: tmpRoot,
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: deterministicClient,
    });

    expect(out.run_status).toBe('error');
    expect(out.verdict).toBeNull();
    expect(out.error?.code).toBe('LLM_UNAVAILABLE');
  });

  it('composes Context + ## Task + prompt body and calls llm.evaluate', async () => {
    const prompt = await writePrompt('Decide if the changes match the plan.');
    const client = makeStubClient({
      body: 'PASS\n\nNo drift detected.',
      model: 'claude-test',
      sessionId: 'sess-1',
      durationMs: 100,
      tokens: { in: 1000, out: 50, cacheRead: 800 },
      costUsd: 0.001,
    });

    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].prompt).toContain('## Context');
    expect(client.calls[0].prompt).toContain('Plan task: add rate limiting');
    expect(client.calls[0].prompt).toContain('## Task');
    expect(client.calls[0].prompt).toContain('Decide if the changes match');
    expect(out.run_status).toBe('completed');
    expect(out.verdict).toBe('pass');
    expect(out.model).toBe('claude-test');
    expect(out.tokens).toEqual({ in: 1000, out: 50, cache_read: 800 });
    expect(out.cost_usd).toBe(0.001);
    expect(out.duration_ms).toBe(100);
    expect(out.checkpoint_n).toBe(2);
  });

  it('returns NO_VERDICT_LINE when the response lacks a standalone verdict', async () => {
    const prompt = await writePrompt('task');
    const client = makeStubClient({
      body: 'I think it looks good but I am not going to commit to a verdict.',
      model: 'claude',
      sessionId: 'sess',
      durationMs: 50,
    });
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('NO_VERDICT_LINE');
  });

  it('surfaces structured LLMClient errors as LLM_ERROR', async () => {
    const prompt = await writePrompt('task');
    const client = makeStubClient({
      body: '',
      model: 'claude',
      sessionId: 'sess',
      durationMs: 5000,
      error: { code: 'TIMEOUT', message: 'timed out after 5s' },
    });
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('LLM_ERROR');
    expect(out.error?.message).toContain('TIMEOUT');
  });

  it('redacts a secret from a structured LLM error before persistence', async () => {
    const prompt = await writePrompt('task');
    const secret = 'sk-proj-0000000000000000000000000000000000000000';
    const client = makeStubClient({
      body: '',
      model: 'claude',
      sessionId: 'sess',
      durationMs: 50,
      error: { code: 'TOOL_ERROR', message: `upstream echoed ${secret}` },
    });

    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });

    expect(out.run_status).toBe('error');
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.body).toContain('REDACTED');
  });

  it.each([
    ['completed', { body: 'PASS' }],
    ['error', { body: '', error: { code: 'TOOL_ERROR', message: 'failed' } }],
  ] as const)('scrubs an untrusted model string on a %s run', async (_status, result) => {
    const prompt = await writePrompt('task');
    const secret = 'ghp_0000000000000000000000000000000000000';
    const client = makeStubClient({
      ...result,
      model: `\u001b[31m${secret}\r spoofed`,
      sessionId: 'sess',
      durationMs: 50,
    });

    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });

    expect(out.model).toBe('[REDACTED_SECRET] spoofed');
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.model).not.toContain('\u001b');
    expect(out.model).not.toContain('\r');
  });

  it('sends a declared context section to an evaluator from any pack', async () => {
    // The defect this replaced: sections were gated on the evaluator_ref
    // containing '/step-coverage' or '/plan-conformance-', so an evaluator
    // named anything else silently received a prompt without them.
    const prompt = await writePrompt('task');
    const client = makeStubClient({
      body: 'PASS',
      model: 'claude',
      sessionId: 'sess',
      durationMs: 1,
    });

    await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: prompt,
        package_root: tmpRoot,
        ref: 'acme/delivery-audit',
        additional_context_sections: ['acceptance-criteria', 'diff-boundary'],
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });

    expect(client.calls[0].prompt).toContain('## Acceptance criteria');
    expect(client.calls[0].prompt).toContain('## Diff boundary');
    // Undeclared sections stay out, whatever the evaluator is called.
    expect(client.calls[0].prompt).not.toContain('## Delivered checkpoints');
  });

  it('omits a section the evaluator did not declare, even under a first-party ref', async () => {
    const prompt = await writePrompt('task');
    const client = makeStubClient({
      body: 'PASS',
      model: 'claude',
      sessionId: 'sess',
      durationMs: 1,
    });

    await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: prompt,
        package_root: tmpRoot,
        ref: 'core/step-coverage',
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });

    expect(client.calls[0].prompt).not.toContain('## Acceptance criteria');
    expect(client.calls[0].prompt).not.toContain('## Diff boundary');
  });

  it('records the sentinel verdict even when a bare token follows it', async () => {
    // The recorded verdict must match what the body states. Bare-line parsing
    // is fence-blind, so before the sentinel a trailing PASS — in a quoted
    // example, a footnote, anywhere — silently became the persisted verdict.
    const prompt = await writePrompt('task');
    const client = makeStubClient({
      body: [
        'Two criteria are under-delivered.',
        '',
        '```orcaops-verdict',
        'VIOLATION',
        '```',
        '',
        'For reference, a clean run would end with:',
        '',
        'PASS',
        '',
      ].join('\n'),
      model: 'claude',
      sessionId: 'sess',
      durationMs: 100,
    });
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(out.verdict).toBe('violation');
    expect(out.body).toContain('VIOLATION');
  });

  it('installs the shared evaluator system prompt for markdown mode', async () => {
    // The constant was exported and documented as a default but nothing ever
    // assigned it, so editing it had no runtime effect at all.
    const prompt = await writePrompt('task');
    const client = makeStubClient({
      body: 'PASS',
      model: 'claude',
      sessionId: 'sess',
      durationMs: 1,
    });
    await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(client.calls[0].systemPrompt).toBe(ORCAOPS_EVALUATOR_SYSTEM_PROMPT);
    expect(client.calls[0].systemPrompt).toContain('orcaops-verdict');
    // It must not forbid tool use. core/step-coverage is granted
    // command-filtered access and its prompt says to inspect the worktree; a
    // system-level prohibition outranks that and would stop the one evaluator
    // whose job is reading the delivery. Capability lives in the spawn flags
    // (--disallowed-tools / --allowed-tools), not in this prose.
    expect(client.calls[0].systemPrompt).not.toMatch(/do not invoke tools/i);
  });

  it('uses LAST verdict when the response has multiple', async () => {
    const prompt = await writePrompt('task');
    const client = makeStubClient({
      body: 'VIOLATION\n\nactually wait\n\nPASS\n',
      model: 'claude',
      sessionId: 'sess',
      durationMs: 100,
    });
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(out.verdict).toBe('pass');
  });

  it('redacts a secret from a successful markdown response before persistence', async () => {
    const prompt = await writePrompt('task');
    const secret = 'ghp_0000000000000000000000000000000000000';
    const basicCredential = 'ZGVhZC1maXh0dXJlOnNlY3JldA==';
    const client = makeStubClient({
      body:
        `PASS\n\nprovider response included ${secret}\n` +
        `found Authorization: Basic ${basicCredential} in src/api.ts`,
      model: 'claude',
      sessionId: 'sess',
      durationMs: 100,
    });

    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });

    expect(out.run_status).toBe('completed');
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain(basicCredential);
    expect(out.body).toContain('REDACTED');
  });

  it('returns LLM_ERROR when the prompt_file cannot be read', async () => {
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: '/this/path/does/not/exist',
        package_root: tmpRoot,
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: makeStubClient(),
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('LLM_ERROR');
    expect(out.error?.message).toMatch(/prompt_file/);
  });

  it('refuses a prompt symlink that resolves outside the pack before calling the LLM', async () => {
    const outside = path.join(path.dirname(tmpRoot), `${path.basename(tmpRoot)}-secret`);
    const link = path.join(tmpRoot, 'prompts', 'linked.md');
    await writeFile(outside, 'external secret', 'utf8');
    await symlink(outside, link);
    const client = makeStubClient({
      body: 'PASS',
      model: 'claude',
      sessionId: 'sess',
      durationMs: 1,
    });

    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: link, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });

    expect(client.calls).toHaveLength(0);
    expect(out.error?.code).toBe('LLM_ERROR');
    expect(out.error?.message).toContain('resolves outside');
    await rm(outside, { force: true });
  });
});

describe('runLlmEngine — json mode', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-llm-json-test-'));
    await mkdir(path.join(tmpRoot, 'prompts'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writePrompt(): Promise<string> {
    const filePath = path.join(tmpRoot, 'prompts', 'json-eval.md');
    await writeFile(filePath, 'Respond as JSON.', 'utf8');
    return filePath;
  }

  it('parses and scrubs a valid envelope from result.body on first attempt', async () => {
    const prompt = await writePrompt();
    const secret = 'ghp_0000000000000000000000000000000000000';
    const split = `${secret.slice(0, 20)}${String.fromCharCode(0x1b)}${secret.slice(20)}`;
    const client = makeStubClient({
      body: JSON.stringify({
        schema: 'orcaops.evaluator_result/v1',
        verdict: 'violation',
        body: 'VIOLATION\n\nfindings...',
        raw: { constructor: 'poison', count: 3, detail: secret },
        metrics: { files_scanned: 12, [split]: 13 },
      }),
      model: 'claude',
      sessionId: 'sess',
      durationMs: 150,
    });
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: prompt,
        package_root: tmpRoot,
        output_format: 'json',
        output_schema: { type: 'object', properties: { count: { type: 'number' } } },
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(out.run_status).toBe('completed');
    expect(out.verdict).toBe('violation');
    expect(out.raw).toEqual({
      constructor: 'poison',
      count: 3,
      detail: '[REDACTED_SECRET]',
    });
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.metrics).toEqual({ files_scanned: 12, '[REDACTED_SECRET]': 13 });
  });

  it('does NOT install the markdown system prompt in json mode', async () => {
    // It asks for markdown prose and a fenced sentinel, which would fight the
    // structured-output contract json mode is built on.
    const prompt = await writePrompt();
    const client = makeStubClient({
      body: JSON.stringify({
        schema: 'orcaops.evaluator_result/v1',
        verdict: 'pass',
        body: 'PASS',
      }),
      model: 'claude',
      sessionId: 's',
      durationMs: 50,
    });
    await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: prompt,
        package_root: tmpRoot,
        output_format: 'json',
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(client.calls[0].systemPrompt).toBeUndefined();
  });

  it('retries once on JSON parse failure (default json_mode_retries=1)', async () => {
    const prompt = await writePrompt();
    const client = makeStubClient(
      // first attempt: garbage
      { body: 'not json at all', model: 'claude', sessionId: 's', durationMs: 50 },
      // second attempt: valid envelope
      {
        body: JSON.stringify({
          schema: 'orcaops.evaluator_result/v1',
          verdict: 'info',
          body: 'INFO\n\nrecovered',
        }),
        model: 'claude',
        sessionId: 's',
        durationMs: 50,
      }
    );
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: prompt,
        package_root: tmpRoot,
        output_format: 'json',
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1].prompt).toMatch(/REMINDER/);
    expect(out.run_status).toBe('completed');
    expect(out.verdict).toBe('info');
  });

  it('returns JSON_PARSE after exhausting retries', async () => {
    const prompt = await writePrompt();
    const client = makeStubClient(
      { body: 'garbage', model: 'claude', sessionId: 's', durationMs: 50 },
      { body: 'still garbage', model: 'claude', sessionId: 's', durationMs: 50 }
    );
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: prompt,
        package_root: tmpRoot,
        output_format: 'json',
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(client.calls).toHaveLength(2);
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('JSON_PARSE');
  });

  it('returns ENVELOPE_INVALID after exhausting retries when the JSON is well-formed but wrong shape', async () => {
    const prompt = await writePrompt();
    const client = makeStubClient(
      {
        body: JSON.stringify({ wrong: 'shape' }),
        model: 'claude',
        sessionId: 's',
        durationMs: 50,
      },
      {
        body: JSON.stringify({ also: 'wrong' }),
        model: 'claude',
        sessionId: 's',
        durationMs: 50,
      }
    );
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: prompt,
        package_root: tmpRoot,
        output_format: 'json',
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('ENVELOPE_INVALID');
  });

  it('returns RAW_SCHEMA_INVALID when raw fails the injected validator on every attempt', async () => {
    const prompt = await writePrompt();
    const envelope = {
      schema: 'orcaops.evaluator_result/v1',
      verdict: 'violation',
      body: 'VIOLATION',
      raw: { count: 'not-a-number' },
    };
    const client = makeStubClient(
      { body: JSON.stringify(envelope), model: 'claude', sessionId: 's', durationMs: 50 },
      { body: JSON.stringify(envelope), model: 'claude', sessionId: 's', durationMs: 50 }
    );
    const out = await runLlmEngine({
      evaluator: makeLlmEvaluator({
        prompt_file: prompt,
        package_root: tmpRoot,
        output_format: 'json',
        output_schema: { type: 'object', properties: { count: { type: 'number' } } },
      }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
      validateRaw: (raw) => {
        const c = (raw as { count: unknown }).count;
        if (typeof c !== 'number') throw new Error('count must be a number');
      },
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('RAW_SCHEMA_INVALID');
  });

  it('threads model + effort + provider + max_cost_usd from the spec into EvaluateOptions', async () => {
    const prompt = await writePrompt();
    const client = makeStubClient({
      body: 'PASS',
      model: 'claude-sonnet-4-6',
      sessionId: 's',
      durationMs: 50,
    });
    const run = await runLlmEngine({
      evaluator: {
        ...makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
        engine: {
          kind: 'llm',
          prompt_file: prompt,
          additional_context_sections: [],
          output_format: 'markdown',
          timeout_ms: 12345,
          model: 'claude-sonnet-4-6',
          effort: 'high',
          provider: 'claude',
          max_cost_usd: 0.5,
        },
      },
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    const opts = client.calls[0];
    expect(opts.model).toBe('claude-sonnet-4-6');
    expect(opts.effort).toBe('high');
    expect(opts.provider).toBe('claude');
    expect(opts.maxBudgetUsd).toBe(0.5);
    expect(opts.timeoutMs).toBe(12345);
    expect(run.provider).toBe('claude');
    expect(run.model).toBe('claude-sonnet-4-6');
  });

  it('omits an unknown model instead of writing the provider name', async () => {
    const prompt = await writePrompt();
    const client = makeStubClient({ body: 'PASS', model: null, sessionId: 's', durationMs: 50 });
    const run = await runLlmEngine({
      evaluator: makeLlmEvaluator({ prompt_file: prompt, package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
      llm: client,
    });
    expect(run.provider).toBe('claude');
    expect(run.model).toBeUndefined();
  });
});

describe('runLlmEngine — engine.kind guard', () => {
  it('throws when called with a non-llm engine', async () => {
    const command: ResolvedEvaluator = {
      ref: 'core/cmd',
      package_id: 'core',
      evaluator_id: 'cmd',
      package_root: '/fake',
      spec_path: '/fake/spec.eval.yaml',
      phase: 'post-plan',
      severity: 'info',
      description: 'cmd',
      engine: {
        kind: 'command',
        command: ['bash', 'x.sh'],
        cwd: 'package',
        timeout_ms: 100,
        max_output_bytes: 1024,
        env: { inherit: [], set: {} },
      },
      params: {},
      filters: { paths: [], scopes: [], when_llm: 'optional' },
      resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
      fingerprint_include: [],
      enabled: true,
    };
    await expect(
      runLlmEngine({
        evaluator: command,
        context: makeContext(),
        run_id: RUN_ID,
        llm: makeStubClient(),
      })
    ).rejects.toThrow(/expected "llm"/);
  });
});
