import { describe, expect, it } from 'vitest';

import { type EvaluatorContext, type ResolvedEvaluator } from '@orcaops/evaluator-protocol';

import {
  makeSkippedRun,
  shouldSkipEvaluator,
  shouldSkipForLlmAvailability,
  shouldSkipForPaths,
  shouldSkipForScopes,
} from './filter.js';

function makeEvaluator(filters: {
  paths?: string[];
  scopes?: string[];
  when_llm?: 'required' | 'absent' | 'optional';
}): ResolvedEvaluator {
  return {
    ref: 'core/test',
    package_id: 'core',
    evaluator_id: 'test',
    package_root: '/fake',
    spec_path: '/fake/spec.eval.yaml',
    phase: 'post-plan',
    severity: 'info',
    description: 'fixture',
    engine: {
      kind: 'command',
      command: ['bash', 'x.sh'],
      cwd: 'package',
      timeout_ms: 1000,
      max_output_bytes: 1024,
      env: { inherit: [], set: {} },
    },
    params: {},
    filters: {
      paths: filters.paths ?? [],
      scopes: filters.scopes ?? [],
      when_llm: filters.when_llm ?? 'optional',
    },
    resolution: {
      acknowledge: { enabled: false },
      policy_exception: { enabled: false },
    },
    fingerprint_include: [],
    enabled: true,
  };
}

function makeLlmEvaluator(filters: Parameters<typeof makeEvaluator>[0] = {}): ResolvedEvaluator {
  return {
    ...makeEvaluator(filters),
    engine: {
      kind: 'llm',
      prompt_file: 'prompts/test.md',
      additional_context_sections: [],
      output_format: 'markdown',
      timeout_ms: 1000,
    },
  };
}

function makeContext(overrides: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return {
    schema: 'orcaops.evaluator_context/v1',
    run_id: 'run-1',
    evaluator_ref: 'core/test',
    phase: 'post-plan',
    artifact_id: 'art-1',
    checkpoint_n: null,
    repo: { root: '/repo', branch: 'main', base_sha: 'sha', head_sha: 'sha' },
    plan: {
      task: 't',
      label: 't',
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

describe('shouldSkipForPaths', () => {
  it('returns null when filters.paths is empty (no path gating)', () => {
    expect(shouldSkipForPaths(makeEvaluator({}), ['src/foo.py'])).toBeNull();
  });

  it('skips when filters.paths is non-empty but no files changed', () => {
    expect(shouldSkipForPaths(makeEvaluator({ paths: ['src/**/*.py'] }), [])).toMatch(
      /no files changed/
    );
  });

  it('runs when at least one changed file matches', () => {
    expect(
      shouldSkipForPaths(makeEvaluator({ paths: ['src/**/*.py'] }), ['src/foo.py'])
    ).toBeNull();
  });

  it('skips when no changed file matches any pattern', () => {
    expect(shouldSkipForPaths(makeEvaluator({ paths: ['src/**/*.py'] }), ['tests/foo.py'])).toMatch(
      /no changed file matches/
    );
  });

  it('honors POSIX normalization (windows-style paths match POSIX patterns)', () => {
    expect(
      shouldSkipForPaths(makeEvaluator({ paths: ['src/**/*.py'] }), ['src\\foo\\bar.py'])
    ).toBeNull();
  });
});

describe('shouldSkipForScopes', () => {
  it('returns null when filters.scopes is empty', () => {
    expect(shouldSkipForScopes(makeEvaluator({}), ['payments'])).toBeNull();
  });

  it('runs when any declared scope overlaps plan.touched_scope', () => {
    expect(
      shouldSkipForScopes(makeEvaluator({ scopes: ['api', 'payments'] }), ['payments', 'auth'])
    ).toBeNull();
  });

  it('skips when none of the declared scopes overlap', () => {
    expect(shouldSkipForScopes(makeEvaluator({ scopes: ['api'] }), ['payments'])).toMatch(
      /disjoint/
    );
  });
});

describe('shouldSkipForLlmAvailability', () => {
  it('optional command evaluator always runs regardless of LLM availability', () => {
    expect(shouldSkipForLlmAvailability(makeEvaluator({}), true)).toBeNull();
    expect(shouldSkipForLlmAvailability(makeEvaluator({}), false)).toBeNull();
  });

  it('skips an optional LLM evaluator when no provider will execute', () => {
    expect(shouldSkipForLlmAvailability(makeLlmEvaluator(), true)).toMatch(
      /no LLM provider executed/
    );
  });

  it('skips an absent-mode LLM evaluator when no provider will execute', () => {
    expect(shouldSkipForLlmAvailability(makeLlmEvaluator({ when_llm: 'absent' }), true)).toMatch(
      /no LLM provider executed/
    );
  });

  it('required + deterministic stub LLM → skip', () => {
    expect(shouldSkipForLlmAvailability(makeEvaluator({ when_llm: 'required' }), true)).toMatch(
      /required.*no LLM provider/
    );
  });

  it('required + real LLM → run', () => {
    expect(shouldSkipForLlmAvailability(makeEvaluator({ when_llm: 'required' }), false)).toBeNull();
  });

  it('skips an unavailable resolved provider and names its origin', () => {
    expect(
      shouldSkipForLlmAvailability(makeLlmEvaluator(), false, {
        provider: 'codex',
        available: false,
        source: 'selected by your .orcaops/evaluators.yaml override',
      })
    ).toBe(
      'resolved provider codex is not installed (selected by your .orcaops/evaluators.yaml override)'
    );
  });

  it('runs an absent command evaluator when the selected provider is unavailable', () => {
    expect(
      shouldSkipForLlmAvailability(makeEvaluator({ when_llm: 'absent' }), false, {
        provider: 'claude',
        available: false,
        source: 'from global llm.tool',
      })
    ).toBeNull();
  });

  it('does not treat a runnable but unverified provider as absent', () => {
    expect(
      shouldSkipForLlmAvailability(makeEvaluator({ when_llm: 'absent' }), false, {
        provider: 'claude',
        available: true,
        source: 'from global llm.tool',
      })
    ).toBe('filters.when_llm=absent but an LLM provider is configured');
  });

  it('skips a required command evaluator when the selected provider is unavailable', () => {
    expect(
      shouldSkipForLlmAvailability(makeEvaluator({ when_llm: 'required' }), false, {
        provider: 'claude',
        available: false,
        source: 'from global llm.tool',
      })
    ).toBe('resolved provider claude is not installed (from global llm.tool)');
  });

  it('absent + real LLM → skip', () => {
    expect(shouldSkipForLlmAvailability(makeEvaluator({ when_llm: 'absent' }), false)).toMatch(
      /absent but an LLM/
    );
  });

  it('absent command evaluator + deterministic stub LLM → run', () => {
    expect(shouldSkipForLlmAvailability(makeEvaluator({ when_llm: 'absent' }), true)).toBeNull();
  });
});

describe('shouldSkipEvaluator (composition)', () => {
  it('returns the FIRST gate that fires (paths → scopes → when_llm)', () => {
    const ev = makeEvaluator({
      paths: ['src/**/*.py'], // would skip
      scopes: ['api'], // would also skip
      when_llm: 'required', // would also skip
    });
    const skipReason = shouldSkipEvaluator(ev, makeContext({ changed_files: [] }), true);
    // First gate is paths.
    expect(skipReason).toMatch(/no files changed/);
  });

  it('passes through when all three gates allow', () => {
    const ev = makeEvaluator({
      paths: ['src/**/*.py'],
      scopes: ['api'],
      when_llm: 'optional',
    });
    expect(
      shouldSkipEvaluator(
        ev,
        makeContext({
          changed_files: ['src/foo.py'],
          plan: {
            task: 't',
            label: 't',
            branch: 'main',
            base_sha: 'sha',
            agent: null,
            agent_session_id: null,
            plan_steps: [],
            touched_scope: ['api'],
            non_goals: [],
            decisions: [],
            revision_n: 0,
            revised_at: null,
            rationale: null,
            step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
            started_at: '2026-05-12T20:00:00.000Z',
          },
        }),
        false
      )
    ).toBeNull();
  });
});

describe('makeSkippedRun', () => {
  it('produces a run_status="skipped" payload with the reason in body', () => {
    const ev = makeEvaluator({});
    const ctx = makeContext({ phase: 'checkpoint-close', checkpoint_n: 4 });
    const out = makeSkippedRun({
      evaluator: ev,
      context: ctx,
      run_id: 'run-7',
      reason: 'filters.paths disjoint',
    });
    expect(out.run_status).toBe('skipped');
    expect(out.verdict).toBeNull();
    expect(out.body).toMatch(/SKIPPED/);
    expect(out.body).toContain('filters.paths disjoint');
    expect(out.checkpoint_n).toBe(4);
    expect(out.evaluator_ref).toBe('core/test');
  });

  it('redacts and bounds a repository-controlled skip reason', () => {
    const secret = 'api_key=0000000000000000000000000000000000000000';
    const evaluator = makeEvaluator({ scopes: [secret] });
    const context = makeContext();
    const reason = shouldSkipForScopes(evaluator, context.plan.touched_scope);
    expect(reason).not.toBeNull();

    const out = makeSkippedRun({
      evaluator,
      context,
      run_id: 'run-secret-skip',
      reason: `${reason!} ${'x'.repeat(10_000)}`,
    });

    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.body).toContain('[REDACTED_SECRET]');
    expect(out.body).toContain('[truncated]');
    expect(out.body.length).toBeLessThan(5_000);
  });
});
