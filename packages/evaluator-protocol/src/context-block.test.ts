import { describe, expect, it } from 'vitest';

import { buildContextBlock } from './context-block.js';
import type { ContextSection } from './schemas/common.js';
import type { EvaluatorContext } from './schemas/context.js';

const RUN_ID = '01HXRUN0000000000000000000';

const ALL_SECTIONS: ContextSection[] = [
  'acceptance-criteria',
  'delivered-checkpoints',
  'diff-boundary',
  'source-plan',
];

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

describe('buildContextBlock — baseline', () => {
  it('renders plan task + branch + phase + touched_scope', () => {
    const block = buildContextBlock(makeContext(), []);
    expect(block).toContain('Plan task: add rate limiting to /api/charge');
    expect(block).toContain('Branch: main');
    // Phase is always rendered so a shared prompt can be phase-aware.
    expect(block).toContain('Phase: checkpoint-close');
    expect(block).toContain('Touched scope: payments');
  });

  it('omits empty sections (no "Changed files: (none)" lines)', () => {
    const block = buildContextBlock(
      makeContext({
        plan: {
          task: 'minimal',
          label: 'm',
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
        changed_files: [],
        closed_checkpoints: [],
        open_checkpoints: [],
        summary: null,
      }),
      []
    );
    expect(block).not.toContain('Non-goals');
    expect(block).not.toContain('Plan steps:');
    expect(block).not.toContain('Changed files');
    expect(block).not.toContain('Closed checkpoints');
    expect(block).not.toContain('Open checkpoints');
    expect(block).not.toContain('Summary outcome');
  });

  it('renders structured non_goals (text + rationale + source_refs) and plan_steps', () => {
    const block = buildContextBlock(makeContext(), []);
    expect(block).toContain('Non-goals (intentionally out of scope):');
    expect(block).toContain('- no schema migration');
    // The conformance judge needs rationale + source_refs to tell
    // a declared exclusion from a silent gap. A bare `${ng}` would have
    // rendered `[object Object]`.
    expect(block).toContain('rationale: out of scope for this slice');
    expect(block).toContain('source_refs: section 2');
    expect(block).not.toContain('[object Object]');
    expect(block).toContain('Plan steps:');
    expect(block).toContain('1. add middleware (step_id step-1)');
  });

  it('renders the baseline even when NO additional sections are declared', () => {
    // `[]` means "the baseline is enough", NOT "send nothing" — an author
    // reading `[]` as an egress switch would be wrong, and this pins it.
    const block = buildContextBlock(makeContext(), []);
    expect(block).toContain('## Context');
    expect(block).toContain('Plan task:');
    expect(block).toContain('Non-goals');
    expect(block).toContain('Plan steps:');
    expect(block).toContain('Changed files (since plan.base_sha):');
  });

  it('is deterministic (same inputs → same string)', () => {
    const ctx = makeContext();
    expect(buildContextBlock(ctx, ALL_SECTIONS)).toBe(buildContextBlock(ctx, ALL_SECTIONS));
  });

  it('renders sections in a fixed order regardless of declaration order', () => {
    const ctx = stepCoverageContext();
    const forward = buildContextBlock(ctx, ['acceptance-criteria', 'diff-boundary']);
    const reversed = buildContextBlock(ctx, ['diff-boundary', 'acceptance-criteria']);
    expect(forward).toBe(reversed);
  });
});

function stepCoverageContext(overrides: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return makeContext({
    plan: {
      task: 'deliver the slice',
      label: 'slice',
      branch: 'main',
      base_sha: 'abc123',
      agent: null,
      agent_session_id: null,
      plan_steps: [
        {
          step_id: 'step-1',
          text: 'Add the test suite',
          label: 'tests',
          acceptance_criteria: [{ criterion_id: 'crit-1', text: 'suite has >= 42 tests' }],
        },
        { step_id: 'step-2', text: 'Wire it up', label: 'wire', acceptance_criteria: [] },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      started_at: '2026-05-31T12:00:00.000Z',
    },
    closed_checkpoints: [
      {
        status: 'closed',
        n: 1,
        declared_step_ids: ['step-1'],
        completed_step_ids: ['step-1'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        summary: 'added tests',
        files_changed: ['suite.test.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [{ criterion_id: 'crit-1', evidence: '42 tests in suite.test.ts' }],
        verification: [],
        head_sha: 'def456',
        opened_at: '2026-05-31T12:01:00.000Z',
        closed_at: '2026-05-31T12:02:00.000Z',
      },
    ],
    changed_files: ['suite.test.ts'],
    repo: {
      root: '/tmp/orcaops-test-repo',
      branch: 'main',
      base_sha: 'abc123',
      head_sha: 'def456',
    },
    ...overrides,
  });
}

describe('buildContextBlock — additional sections', () => {
  it('renders the rubric under acceptance-criteria', () => {
    const block = buildContextBlock(stepCoverageContext(), ['acceptance-criteria']);
    expect(block).toContain('## Acceptance criteria (the rubric to verify per step)');
    expect(block).toContain('[crit-1] suite has >= 42 tests');
    expect(block).toContain('NOT graded'); // step-2 has no criteria
  });

  it('renders claimed evidence under delivered-checkpoints', () => {
    const block = buildContextBlock(stepCoverageContext(), ['delivered-checkpoints']);
    expect(block).toContain('## Delivered checkpoints (claimed evidence — hints, NOT proof)');
    expect(block).toContain('evidence: 42 tests in suite.test.ts');
  });

  it('renders SHAs and inspection guidance under diff-boundary', () => {
    const block = buildContextBlock(stepCoverageContext(), ['diff-boundary']);
    expect(block).toContain("## Diff boundary (THIS artifact's delta)");
    expect(block).toContain('base_sha: abc123');
    expect(block).toContain('head_sha: def456');
    expect(block).toContain('git ls-files --others');
  });

  it('renders the pinned source plan under source-plan', () => {
    const source_plan = {
      source_ref: { kind: 'local', locator: 'docs/plan.md' },
      content: 'PINNED-SOURCE-PLAN-CONTENT',
      hash: 'a'.repeat(64),
    };
    const block = buildContextBlock(makeContext({ source_plan }), ['source-plan']);
    expect(block).toContain('Source plan (pinned, immutable):');
    expect(block).toContain('ref: docs/plan.md');
    expect(block).toContain('PINNED-SOURCE-PLAN-CONTENT');
  });

  it('omits the source plan when declared but no pin exists', () => {
    expect(buildContextBlock(makeContext(), ['source-plan'])).not.toContain('Source plan (pinned');
  });

  it('each section is independent — declaring one does not pull in its siblings', () => {
    const block = buildContextBlock(stepCoverageContext(), ['acceptance-criteria']);
    expect(block).toContain('## Acceptance criteria');
    expect(block).not.toContain('## Delivered checkpoints');
    expect(block).not.toContain('## Diff boundary');
  });

  it('omits every additional section when none is declared', () => {
    const source_plan = {
      source_ref: { kind: 'local', locator: 'docs/plan.md' },
      content: 'PINNED-SOURCE-PLAN-CONTENT',
      hash: 'a'.repeat(64),
    };
    const block = buildContextBlock(stepCoverageContext({ source_plan }), []);
    expect(block).not.toContain('## Acceptance criteria');
    expect(block).not.toContain('## Delivered checkpoints');
    expect(block).not.toContain('## Diff boundary');
    expect(block).not.toContain('PINNED-SOURCE-PLAN-CONTENT');
  });

  it('serves a third-party ref that names none of the first-party evaluators', () => {
    // The regression this field exists for: sections used to be gated on
    // `evaluator_ref.includes('/step-coverage')` and `'/plan-conformance-'`,
    // so an evaluator from any other pack silently received a prompt missing
    // the data it asked for and judged confidently against nothing.
    const source_plan = {
      source_ref: { kind: 'local', locator: 'docs/plan.md' },
      content: 'PINNED-SOURCE-PLAN-CONTENT',
      hash: 'a'.repeat(64),
    };
    const block = buildContextBlock(
      stepCoverageContext({ evaluator_ref: 'acme/delivery-audit', source_plan }),
      ALL_SECTIONS
    );
    expect(block).toContain('[crit-1] suite has >= 42 tests');
    expect(block).toContain('## Delivered checkpoints');
    expect(block).toContain('base_sha: abc123');
    expect(block).toContain('PINNED-SOURCE-PLAN-CONTENT');
  });

  it('ignores the evaluator ref entirely when choosing sections', () => {
    // The mirror of the above: a first-party name earns nothing on its own.
    const source_plan = {
      source_ref: { kind: 'local', locator: 'docs/plan.md' },
      content: 'PINNED-SOURCE-PLAN-CONTENT',
      hash: 'a'.repeat(64),
    };
    const ctx = stepCoverageContext({ evaluator_ref: 'core/step-coverage', source_plan });
    expect(buildContextBlock(ctx, [])).toBe(
      buildContextBlock({ ...ctx, evaluator_ref: 'acme/anything' }, [])
    );
  });
});
