import { describe, expect, it } from 'vitest';

import { ArtifactJsonSchema } from './artifact-json.js';
import { CheckpointDecisionSchema, CheckpointSchema } from './checkpoint.js';
import { DEFAULT_EVALUATOR_MODEL, getDefaultConfig, resolveConfig } from './config.js';
import { DecisionBaseSchema, PlanDecisionSchema } from './decision.js';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
} from './diff-fingerprint.js';
import {
  EvaluatorDispositionPayloadSchema,
  EvaluatorLogSchema,
  EvaluatorRunPayloadSchema,
  MaterializedEvaluatorDispositionSchema,
  MaterializedEvaluatorRunSchema,
} from './evaluator-run.js';
import { PlanInputSchema, PlanSchema } from './plan.js';
import { SummaryInputSchema, SummarySchema } from './summary.js';

const STEP_LINEAGE_EMPTY = { added: [], dropped: [], unchanged: [], rewritten: [] };
const CRITERION_LINEAGE_EMPTY = { added: [], carried: [], removed: [], rewritten: [] };

describe('PlanInputSchema', () => {
  it('accepts a minimal valid plan (revision_n=0)', () => {
    const result = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: 'abcdef12',
      branch: 'feat/rate-limit',
      base_sha: 'deadbeef',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add rate limiting',
      label: 'rate limit /api/charge',
      plan_steps: [
        {
          step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
          text: 'implement middleware',
          label: 'mw',
          acceptance_criteria: [],
        },
        {
          step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3LY',
          text: 'add tests',
          label: 'tests',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: '2026-04-25T12:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: STEP_LINEAGE_EMPTY,
      criterion_lineage: CRITERION_LINEAGE_EMPTY,
      prior_plan_event_id: null,
    });
    expect(result.label).toBe('rate limit /api/charge');
    expect(result.touched_scope).toEqual([]);
    expect(result.non_goals).toEqual([]);
    expect(result.revision_n).toBe(0);
  });

  const minimalPlan = () => ({
    schema_version: 4,
    artifact_id: 'abc',
    branch: 'main',
    base_sha: 'd',
    agent: 'claude-code',
    agent_session_id: null,
    task: 't',
    label: 'tt',
    plan_steps: [
      { step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX', text: 's', label: 's', acceptance_criteria: [] },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-04-25T12:00:00.000Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: STEP_LINEAGE_EMPTY,
    criterion_lineage: CRITERION_LINEAGE_EMPTY,
    prior_plan_event_id: null,
  });

  it('keeps origin absent for live plans and validates git-import provenance when present', () => {
    const live = PlanInputSchema.parse(minimalPlan());
    expect('origin' in live).toBe(false);

    const imported = PlanInputSchema.parse({
      ...minimalPlan(),
      origin: {
        kind: 'git-import',
        imported_at: '2026-04-25T13:00:00.000Z',
        tool_version: '0.0.5',
        source_range: 'main~10..main',
        authors: ['dev@example.com'],
        enriched_at: null,
      },
    });
    expect(imported.origin?.kind).toBe('git-import');
    expect(imported.origin).not.toHaveProperty('cluster_key');
    expect(imported.origin).not.toHaveProperty('member_shas_hash');
    expect(imported.origin).not.toHaveProperty('job');

    const reconciled = PlanInputSchema.parse({
      ...minimalPlan(),
      origin: {
        ...imported.origin,
        cluster_key: 'a'.repeat(64),
        member_shas_hash: 'b'.repeat(64),
      },
    });
    expect(reconciled.origin).toMatchObject({
      cluster_key: 'a'.repeat(64),
      member_shas_hash: 'b'.repeat(64),
    });
  });

  it('records the generating seed job when one is supplied', () => {
    const withJob = PlanInputSchema.parse({
      ...minimalPlan(),
      origin: {
        kind: 'git-import',
        imported_at: '2026-04-25T13:00:00.000Z',
        tool_version: '0.0.5',
        source_range: 'main~10..main',
        authors: ['dev@example.com'],
        enriched_at: null,
        job: { job_id: '01900000-0000-7000-8000-000000000001', kind: 'initial' },
      },
    });
    expect(withJob.origin?.job).toEqual({
      job_id: '01900000-0000-7000-8000-000000000001',
      kind: 'initial',
    });

    expect(() =>
      PlanInputSchema.parse({
        ...minimalPlan(),
        origin: {
          kind: 'git-import',
          imported_at: '2026-04-25T13:00:00.000Z',
          tool_version: '0.0.5',
          source_range: 'main~10..main',
          authors: ['dev@example.com'],
          enriched_at: null,
          job: { job_id: 'job-1', kind: 'gap-fill' },
        },
      })
    ).toThrow();
  });

  it.each(['touched_scope', 'non_goals', 'decisions', 'criterion_lineage'] as const)(
    'rejects a plan missing %s (launch strictness)',
    (field) => {
      const { [field]: _omitted, ...plan } = minimalPlan();
      const res = PlanInputSchema.safeParse(plan);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
      }
    }
  );

  it.each(['added', 'dropped', 'unchanged', 'rewritten'] as const)(
    'rejects a step_lineage omitting %s with the field path (no silent healing)',
    (member) => {
      const { [member]: _omitted, ...partial } = STEP_LINEAGE_EMPTY;
      const res = PlanInputSchema.safeParse({ ...minimalPlan(), step_lineage: partial });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(
          res.error.issues.some((issue) => issue.path.join('.') === `step_lineage.${member}`)
        ).toBe(true);
      }
    }
  );

  it.each(['added', 'carried', 'removed', 'rewritten'] as const)(
    'rejects a criterion_lineage omitting %s with the field path (no silent healing)',
    (member) => {
      const { [member]: _omitted, ...partial } = CRITERION_LINEAGE_EMPTY;
      const res = PlanInputSchema.safeParse({ ...minimalPlan(), criterion_lineage: partial });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(
          res.error.issues.some((issue) => issue.path.join('.') === `criterion_lineage.${member}`)
        ).toBe(true);
      }
    }
  );

  it('rejects a persisted non_goal omitting source_refs with the field path (no silent healing)', () => {
    // The capture-input default materializes source_refs on every write, so a
    // stored non-goal without it can only be loss or tampering.
    const res = PlanInputSchema.safeParse({
      ...minimalPlan(),
      non_goals: [{ text: 'no auth changes', rationale: 'separate slice' }],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((issue) => issue.path.join('.') === 'non_goals.0.source_refs')
      ).toBe(true);
    }
  });

  it('rejects a plan step missing acceptance_criteria (launch strictness)', () => {
    const plan = minimalPlan();
    const { acceptance_criteria: _omitted, ...bareStep } = plan.plan_steps[0];
    const res = PlanInputSchema.safeParse({ ...plan, plan_steps: [bareStep] });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((issue) => issue.path.includes('acceptance_criteria'))).toBe(
        true
      );
    }
  });

  it('round-trips cumulative plan decisions (revision_n + alternatives_considered)', () => {
    const result = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: 'abcdef12',
      branch: 'main',
      base_sha: 'd',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'tt',
      plan_steps: [
        { step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX', text: 's', label: 's', acceptance_criteria: [] },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [
        {
          decision: 'imperative in-transaction enqueueCommand',
          reason: 'atomic with the write; no eventual-consistency window',
          revision_n: 0,
          alternatives_considered: [
            {
              option: 'event-listener trigger',
              rejected_because: 'async gap risked double-dispatch',
            },
          ],
        },
        {
          decision: 'config-loader pass before mount',
          reason: 'discovered prerequisite',
          revision_n: 1,
        },
      ],
      started_at: '2026-04-25T12:00:00.000Z',
      revision_n: 1,
      revised_at: '2026-04-25T13:00:00.000Z',
      rationale: 'r',
      step_lineage: STEP_LINEAGE_EMPTY,
      criterion_lineage: CRITERION_LINEAGE_EMPTY,
      prior_plan_event_id: 'evt-0',
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0].revision_n).toBe(0);
    expect(result.decisions[0].alternatives_considered).toEqual([
      { option: 'event-listener trigger', rejected_because: 'async gap risked double-dispatch' },
    ]);
    expect(result.decisions[1].revision_n).toBe(1);
  });

  it('round-trips a plan with non_goals', () => {
    const result = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: 'abcdef12',
      branch: 'main',
      base_sha: 'deadbeef',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add rate limiting',
      label: 'rate limit /api/charge',
      plan_steps: [
        {
          step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
          text: 'implement middleware',
          label: 'mw',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      decisions: [],
      non_goals: [
        {
          text: 'do not change auth',
          rationale: 'auth is out of scope for this slice',
          source_refs: [],
        },
        {
          text: 'no DB migration',
          rationale: 'the schema is frozen for this slice',
          source_refs: ['section 2.3'],
        },
      ],
      started_at: '2026-04-25T12:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: STEP_LINEAGE_EMPTY,
      criterion_lineage: CRITERION_LINEAGE_EMPTY,
      prior_plan_event_id: null,
    });
    expect(result.non_goals).toEqual([
      {
        text: 'do not change auth',
        rationale: 'auth is out of scope for this slice',
        source_refs: [],
      },
      {
        text: 'no DB migration',
        rationale: 'the schema is frozen for this slice',
        source_refs: ['section 2.3'],
      },
    ]);
  });

  it('accepts a revised plan (revision_n>0) with rationale + lineage', () => {
    const result = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: 'abc',
      branch: 'main',
      base_sha: 'd',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'sharpened headline',
      plan_steps: [
        { step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX', text: 'a', label: 'a', acceptance_criteria: [] },
        { step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3MZ', text: 'c', label: 'c', acceptance_criteria: [] },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: '2026-04-25T12:00:00.000Z',
      revision_n: 1,
      revised_at: '2026-04-25T13:00:00.000Z',
      rationale: 'discovered c, dropped b',
      step_lineage: {
        added: ['01HX0K8N6ZQF8M5R2V8DZ7T3MZ'],
        dropped: ['01HX0K8N6ZQF8M5R2V8DZ7T3LY'],
        unchanged: ['01HX0K8N6ZQF8M5R2V8DZ7T3KX'],
        rewritten: [],
      },
      criterion_lineage: CRITERION_LINEAGE_EMPTY,
      prior_plan_event_id: '019dd7be-1111-7000-8000-000000000001',
    });
    expect(result.revision_n).toBe(1);
    expect(result.step_lineage.added).toEqual(['01HX0K8N6ZQF8M5R2V8DZ7T3MZ']);
  });

  it('rejects empty plan_steps', () => {
    expect(() =>
      PlanInputSchema.parse({
        schema_version: 4,
        artifact_id: 'abc',
        branch: 'main',
        base_sha: 'd',
        agent: 'claude-code',
        agent_session_id: null,
        task: 't',
        label: 'lbl',
        plan_steps: [],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-04-25T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: STEP_LINEAGE_EMPTY,
        criterion_lineage: CRITERION_LINEAGE_EMPTY,
        prior_plan_event_id: null,
      })
    ).toThrow();
  });

  it.each([
    ['missing label', undefined],
    ['empty', ''],
    ['too long (71 chars)', 'a'.repeat(71)],
    ['contains newline', 'foo\nbar'],
    ['contains tab', 'foo\tbar'],
    ['leading whitespace', ' foo'],
    ['trailing whitespace', 'foo '],
    ['only whitespace', '   '],
  ])('rejects step with %s label', (_desc, label) => {
    const step: Record<string, unknown> = {
      step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
      text: 's',
      acceptance_criteria: [],
    };
    if (label !== undefined) step.label = label;
    expect(() =>
      PlanInputSchema.parse({
        schema_version: 4,
        artifact_id: 'abc',
        branch: 'main',
        base_sha: 'd',
        agent: 'claude-code',
        agent_session_id: null,
        task: 't',
        label: 'lbl',
        plan_steps: [step],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-04-25T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: STEP_LINEAGE_EMPTY,
        criterion_lineage: CRITERION_LINEAGE_EMPTY,
        prior_plan_event_id: null,
      })
    ).toThrow();
  });

  it('rejects duplicate labels within a plan', () => {
    expect(() =>
      PlanInputSchema.parse({
        schema_version: 4,
        artifact_id: 'abc',
        branch: 'main',
        base_sha: 'd',
        agent: 'claude-code',
        agent_session_id: null,
        task: 't',
        label: 'lbl',
        plan_steps: [
          {
            step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
            text: 'a',
            label: 'mw',
            acceptance_criteria: [],
          },
          {
            step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3LY',
            text: 'b',
            label: 'mw',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-04-25T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: STEP_LINEAGE_EMPTY,
        criterion_lineage: CRITERION_LINEAGE_EMPTY,
        prior_plan_event_id: null,
      })
    ).toThrow(/Duplicate label/);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long (71 chars)', 'a'.repeat(71)],
    ['contains newline', 'foo\nbar'],
    ['contains tab', 'foo\tbar'],
    ['leading whitespace', ' foo'],
    ['trailing whitespace', 'foo '],
  ])('rejects plan with %s top-level label', (_desc, label) => {
    const plan: Record<string, unknown> = {
      schema_version: 4,
      artifact_id: 'abc',
      branch: 'main',
      base_sha: 'd',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      plan_steps: [
        { step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX', text: 's', label: 's', acceptance_criteria: [] },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: '2026-04-25T12:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: STEP_LINEAGE_EMPTY,
      criterion_lineage: CRITERION_LINEAGE_EMPTY,
      prior_plan_event_id: null,
    };
    if (label !== undefined) plan.label = label;
    expect(() => PlanInputSchema.parse(plan)).toThrow();
  });

  it('accepts top-level label distinct from step labels (no cross-grain uniqueness)', () => {
    const result = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: 'abc',
      branch: 'main',
      base_sha: 'd',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'mw',
      plan_steps: [
        { step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX', text: 's', label: 'mw', acceptance_criteria: [] },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: '2026-04-25T12:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: STEP_LINEAGE_EMPTY,
      criterion_lineage: CRITERION_LINEAGE_EMPTY,
      prior_plan_event_id: null,
    });
    expect(result.label).toBe('mw');
    expect(result.plan_steps[0].label).toBe('mw');
  });

  it.each([
    ['single char', 'a'],
    ['prose with spaces', 'Redis sliding-window middleware'],
    ['mixed case', 'Mount on /api/charge'],
    ['punctuation: comma + period', 'Add tests, then refactor.'],
    ['punctuation: colon + slash', 'Path: src/foo/bar'],
    ['slug-shaped (back-compat)', 'redis-mw'],
    ['exactly 70 chars', 'a'.repeat(70)],
  ])('accepts step with %s label', (_desc, label) => {
    const result = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: 'abc',
      branch: 'main',
      base_sha: 'd',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'plan-headline',
      plan_steps: [
        { step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX', text: 's', label, acceptance_criteria: [] },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: '2026-04-25T12:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: STEP_LINEAGE_EMPTY,
      criterion_lineage: CRITERION_LINEAGE_EMPTY,
      prior_plan_event_id: null,
    });
    expect(result.plan_steps[0].label).toBe(label);
  });
});

describe('PlanSchema persisted provenance', () => {
  it('requires a non-empty source event id', () => {
    const authored = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: 'abc',
      branch: 'main',
      base_sha: 'deadbeef',
      agent: 'codex',
      agent_session_id: null,
      task: 'task',
      label: 'task',
      plan_steps: [{ step_id: 'step-1', text: 'step', label: 'step', acceptance_criteria: [] }],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: '2026-04-25T12:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: STEP_LINEAGE_EMPTY,
      criterion_lineage: CRITERION_LINEAGE_EMPTY,
      prior_plan_event_id: null,
    });
    expect(PlanSchema.safeParse(authored).success).toBe(false);
    expect(PlanSchema.safeParse({ ...authored, source_event_id: null }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...authored, source_event_id: '' }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...authored, source_event_id: 'event-1' }).success).toBe(true);
  });
});

describe('Decision schemas (base / plan / checkpoint)', () => {
  const base = { decision: 'use X', reason: 'because Y' };

  it('DecisionBaseSchema accepts the base shape with optional alternatives_considered', () => {
    expect(DecisionBaseSchema.parse(base).decision).toBe('use X');
    const withAlts = DecisionBaseSchema.parse({
      ...base,
      alternatives_considered: [{ option: 'Z', rejected_because: 'slower' }],
    });
    expect(withAlts.alternatives_considered).toHaveLength(1);
  });

  it('PlanDecisionSchema requires revision_n; base + checkpoint do not (and strip a stray one)', () => {
    expect(() => PlanDecisionSchema.parse(base)).toThrow();
    expect(PlanDecisionSchema.parse({ ...base, revision_n: 2 }).revision_n).toBe(2);
    // Non-strict base/checkpoint objects DROP an unknown key rather than carry it.
    expect('revision_n' in DecisionBaseSchema.parse({ ...base, revision_n: 9 })).toBe(false);
    expect('revision_n' in CheckpointDecisionSchema.parse({ ...base, revision_n: 9 })).toBe(false);
  });

  it('PlanDecisionSchema rejects a negative or non-integer revision_n', () => {
    expect(() => PlanDecisionSchema.parse({ ...base, revision_n: -1 })).toThrow();
    expect(() => PlanDecisionSchema.parse({ ...base, revision_n: 1.5 })).toThrow();
  });

  it('CheckpointDecisionSchema is the shared base shape (rebased onto DecisionBaseSchema)', () => {
    const cp = CheckpointDecisionSchema.parse({
      ...base,
      alternatives_considered: [{ option: 'Z', rejected_because: 'slower' }],
    });
    expect(cp.alternatives_considered).toEqual([{ option: 'Z', rejected_because: 'slower' }]);
  });
});

describe('CheckpointSchema (discriminated union)', () => {
  const STEP_A = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
  const STEP_B = '01HX0K8N6ZQF8M5R2V8DZ7T3LY';

  it('accepts a minimal closed checkpoint', () => {
    const cp = CheckpointSchema.parse({
      schema_version: 4,
      status: 'closed',
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A],
      agent: 'other',
      closed_by_agent: 'other',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 'wired middleware',
      files_changed: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: 'deadbeef',
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      close_snapshot: buildDefaultSkippedSnapshotBoundary(),
      diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
      source_event_ids: { opened: 'open-event', closed: 'close-event' },
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    });
    if (cp.status !== 'closed') throw new Error('expected closed');
    expect(cp.diff_fingerprint_summary.status).toBe('skipped');
    expect(cp.close_snapshot.snapshot_error_reason).toBeNull();
    expect(cp.agent).toBe('other');
    expect(cp.closed_by_agent).toBe('other');
    expect(cp).not.toHaveProperty('open_head_sha');
    expect(CheckpointSchema.safeParse({ ...cp, source_event_id: '' }).success).toBe(false);
    expect(
      CheckpointSchema.safeParse({
        ...cp,
        source_event_ids: { ...cp.source_event_ids, opened: '' },
      }).success
    ).toBe(false);
    expect(
      CheckpointSchema.safeParse({
        ...cp,
        source_event_ids: { ...cp.source_event_ids, closed: '' },
      }).success
    ).toBe(false);
  });

  it('accepts an optional open-time head on a closed checkpoint', () => {
    const cp = CheckpointSchema.parse({
      schema_version: 4,
      status: 'closed',
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A],
      agent: 'other',
      closed_by_agent: 'other',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      open_head_sha: 'open-head',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 'wired middleware',
      files_changed: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: 'close-head',
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      close_snapshot: buildDefaultSkippedSnapshotBoundary(),
      diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
      source_event_ids: { opened: 'open-event', closed: 'close-event' },
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    });
    expect(cp).toMatchObject({ open_head_sha: 'open-head', head_sha: 'close-head' });
  });

  it('round-trips invoking-agent attribution on closed checkpoints (cross-agent handoff)', () => {
    const cp = CheckpointSchema.parse({
      schema_version: 4,
      status: 'closed',
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A],
      agent: 'claude-code',
      closed_by_agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 'wired middleware',
      files_changed: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: 'deadbeef',
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      close_snapshot: buildDefaultSkippedSnapshotBoundary(),
      diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
      source_event_ids: { opened: 'open-event', closed: 'close-event' },
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    });
    if (cp.status !== 'closed') throw new Error('expected closed');
    expect(cp.agent).toBe('claude-code');
    expect(cp.closed_by_agent).toBe('codex');
  });

  it('rejects attribution values outside the capture enum', () => {
    const bad = CheckpointSchema.safeParse({
      schema_version: 4,
      status: 'open',
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A],
      agent: 'gpt-shell',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      head_sha: 'deadbeef',
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    });
    expect(bad.success).toBe(false);
  });

  it('requires attribution on every persisted checkpoint variant', () => {
    const common = {
      schema_version: 4 as const,
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A],
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      head_sha: 'deadbeef',
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    };
    expect(CheckpointSchema.safeParse({ ...common, status: 'open' }).success).toBe(false);
    expect(
      CheckpointSchema.safeParse({
        ...common,
        status: 'closed',
        agent: 'other',
        closed_at: '2026-04-25T12:30:00.000Z',
        summary: 's',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        completed_step_ids: [],
        close_snapshot: buildDefaultSkippedSnapshotBoundary(),
        diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
        source_event_ids: { opened: 'open-event', closed: 'close-event' },
      }).success
    ).toBe(false);
    expect(
      CheckpointSchema.safeParse({
        ...common,
        status: 'abandoned',
        agent: 'other',
        abandoned_at: '2026-04-25T12:30:00.000Z',
        reason: 'cancelled',
        abandon_snapshot: buildDefaultSkippedSnapshotBoundary(),
        source_event_ids: { opened: 'open-event', abandoned: 'abandon-event' },
      }).success
    ).toBe(false);
  });

  it('round-trips a closed-checkpoint decision with alternatives_considered', () => {
    const cp = CheckpointSchema.parse({
      schema_version: 4,
      status: 'closed',
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A],
      agent: 'other',
      closed_by_agent: 'other',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 'wired middleware',
      files_changed: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: 'deadbeef',
      decisions: [
        {
          decision: 'token bucket',
          reason: 'smoother bursts',
          alternatives_considered: [
            { option: 'fixed window', rejected_because: 'burst-at-boundary' },
          ],
        },
      ],
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      close_snapshot: buildDefaultSkippedSnapshotBoundary(),
      diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
      source_event_ids: { opened: 'open-event', closed: 'close-event' },
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    });
    if (cp.status !== 'closed') throw new Error('expected closed');
    expect(cp.decisions[0].alternatives_considered).toEqual([
      { option: 'fixed window', rejected_because: 'burst-at-boundary' },
    ]);
  });

  it('treats alternatives_considered as optional and rejects an empty option', () => {
    const common = {
      schema_version: 4 as const,
      status: 'closed' as const,
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A],
      agent: 'other',
      closed_by_agent: 'other',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 's',
      files_changed: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: 'd',
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      close_snapshot: buildDefaultSkippedSnapshotBoundary(),
      diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
      source_event_ids: { opened: 'open-event', closed: 'close-event' },
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    };
    const ok = CheckpointSchema.safeParse({
      ...common,
      decisions: [{ decision: 'd', reason: 'r' }],
    });
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.status === 'closed') {
      expect(ok.data.decisions[0].alternatives_considered).toBeUndefined();
    }
    const bad = CheckpointSchema.safeParse({
      ...common,
      decisions: [
        {
          decision: 'd',
          reason: 'r',
          alternatives_considered: [{ option: '', rejected_because: 'x' }],
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('accepts a minimal open checkpoint', () => {
    const cp = CheckpointSchema.parse({
      schema_version: 4,
      status: 'open',
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A, STEP_B],
      agent: 'other',
      policy_exceptions: [],
      plan_revision_id: '019dd7be-1111-7000-8000-000000000001',
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      head_sha: 'deadbeef',
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    });
    expect(cp.status).toBe('open');
    expect(cp.plan_revision_id).toBe('019dd7be-1111-7000-8000-000000000001');
    expect(cp.open_snapshot.snapshot_error_reason).toBeNull();
  });

  it('accepts a minimal abandoned checkpoint', () => {
    const cp = CheckpointSchema.parse({
      schema_version: 4,
      status: 'abandoned',
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A],
      agent: 'other',
      abandoned_by_agent: 'other',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      abandoned_at: '2026-04-25T12:30:00.000Z',
      reason: 'subagent-c timed out before starting work',
      head_sha: 'deadbeef',
      open_snapshot: buildDefaultSkippedSnapshotBoundary(),
      abandon_snapshot: buildDefaultSkippedSnapshotBoundary(),
      source_event_ids: { opened: 'open-event', abandoned: 'abandon-event' },
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    });
    expect(cp.status).toBe('abandoned');
    if (cp.status !== 'abandoned') throw new Error('expected abandoned');
    expect(cp.abandon_snapshot.snapshot_error_reason).toBeNull();
  });

  it('rejects n=0 (must be 1-indexed)', () => {
    expect(() =>
      CheckpointSchema.parse({
        schema_version: 4,
        status: 'open',
        artifact_id: 'abc',
        n: 0,
        declared_step_ids: [STEP_A],
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
        opened_at: '2026-04-25T12:29:00.000Z',
        head_sha: 'd',
        open_snapshot: buildDefaultSkippedSnapshotBoundary(),
        source_event_id: '019dd7be-3333-7000-8000-000000000003',
      })
    ).toThrow();
  });

  it('rejects empty declared_step_ids on open', () => {
    expect(() =>
      CheckpointSchema.parse({
        schema_version: 4,
        status: 'open',
        artifact_id: 'abc',
        n: 1,
        declared_step_ids: [],
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
        opened_at: '2026-04-25T12:29:00.000Z',
        head_sha: 'd',
        open_snapshot: buildDefaultSkippedSnapshotBoundary(),
        source_event_id: '019dd7be-3333-7000-8000-000000000003',
      })
    ).toThrow();
  });

  it('rejects an abandoned checkpoint without a reason', () => {
    expect(() =>
      CheckpointSchema.parse({
        schema_version: 4,
        status: 'abandoned',
        artifact_id: 'abc',
        n: 1,
        declared_step_ids: [STEP_A],
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
        opened_at: '2026-04-25T12:29:00.000Z',
        abandoned_at: '2026-04-25T12:30:00.000Z',
        head_sha: 'd',
        open_snapshot: buildDefaultSkippedSnapshotBoundary(),
        abandon_snapshot: buildDefaultSkippedSnapshotBoundary(),
        source_event_ids: { opened: 'open-event', abandoned: 'abandon-event' },
        source_event_id: '019dd7be-3333-7000-8000-000000000003',
      })
    ).toThrow();
  });

  it('rejects a v3-shaped checkpoint (strict clean break, no rebuilder forward-defaults)', () => {
    // v4 is a strict clean break from v3. Old
    // v3 events (no open_snapshot / close_snapshot / abandon_snapshot /
    // diff_fingerprint_summary fields) must NOT parse against v4.
    // Defaults live ONLY in the write path; the schema fields are
    // required-non-optional.
    const result = CheckpointSchema.safeParse({
      // v3-shaped: literal 3, no v4-required fields.
      schema_version: 3,
      status: 'closed',
      artifact_id: 'abcdef12',
      n: 1,
      declared_step_ids: [STEP_A],
      plan_revision_id: null,
      open_plan_revision_event_id: '019dd7be-2222-7000-8000-000000000002',
      opened_at: '2026-04-25T12:29:00.000Z',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 'wired middleware',
      head_sha: 'deadbeef',
    });
    expect(result.success).toBe(false);
    if (result.success) return; // narrow for TS

    // Loose check: the Zod error issues should surface a path or
    // message hint at `schema_version` (literal mismatch — 3 vs 4)
    // AND at one or more of the new required v4 fields. We don't
    // pin to exact Zod issue codes/messages here because those can
    // shift between Zod minor versions; the load-bearing assertion
    // above (success === false) is the actual contract.
    const issueText = JSON.stringify(result.error.issues);
    expect(issueText).toMatch(/schema_version/);
    expect(issueText).toMatch(/open_snapshot|close_snapshot|diff_fingerprint_summary/);
  });
});

describe('SummaryInputSchema', () => {
  it('accepts a minimal summary', () => {
    const s = SummaryInputSchema.parse({
      schema_version: 1,
      artifact_id: 'abcdef12',
      outcome: 'shipped rate limiter',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'deadbeef',
      ts: '2026-04-25T13:00:00.000Z',
    });
    expect(s.tests_written).toEqual([]);
    expect(s.open_items).toEqual([]);
    // Attribution is optional with NO default — parsing must not grow an
    // agent key the writer omitted (artifact-hash stability).
    expect(s.agent).toBeUndefined();
    expect('agent' in JSON.parse(JSON.stringify(s))).toBe(false);
  });

  it('accepts and rejects invoking-agent attribution values by the capture enum', () => {
    const base = {
      schema_version: 1,
      artifact_id: 'abcdef12',
      outcome: 'shipped rate limiter',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'deadbeef',
      ts: '2026-04-25T13:00:00.000Z',
    };
    expect(SummaryInputSchema.parse({ ...base, agent: 'codex' }).agent).toBe('codex');
    expect(SummaryInputSchema.safeParse({ ...base, agent: 'not-an-agent' }).success).toBe(false);
  });

  it('keeps warning acceptance optional and rejects duplicate runs', () => {
    const base = minimalSummary();
    expect(SummaryInputSchema.parse(base).accepted_warnings).toBeUndefined();
    const accepted = {
      review_id: 'review-1',
      run_id: 'run-1',
      evaluator_ref: 'core/review',
      reason: 'Reviewed against the agreed fallback.',
    };
    expect(
      SummaryInputSchema.parse({ ...base, accepted_warnings: [accepted] }).accepted_warnings
    ).toEqual([accepted]);
    expect(
      SummaryInputSchema.safeParse({ ...base, accepted_warnings: [accepted, accepted] }).success
    ).toBe(false);
  });

  const minimalSummary = () => ({
    schema_version: 1,
    artifact_id: 'abcdef12',
    outcome: 'shipped rate limiter',
    tests_written: [],
    tests_run: [],
    open_items: [],
    deferred_decisions: [],
    head_sha: 'deadbeef',
    ts: '2026-04-25T13:00:00.000Z',
  });

  it.each(['tests_written', 'tests_run', 'open_items', 'deferred_decisions'] as const)(
    'rejects a summary missing %s instead of defaulting it empty',
    (field) => {
      const { [field]: _omitted, ...summary } = minimalSummary();
      const res = SummaryInputSchema.safeParse(summary);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
      }
    }
  );
});

describe('SummarySchema persisted provenance', () => {
  it('requires a non-empty source event id', () => {
    const authored = SummaryInputSchema.parse({
      schema_version: 1,
      artifact_id: 'abcdef12',
      outcome: 'shipped',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'deadbeef',
      ts: '2026-04-25T13:00:00.000Z',
    });
    expect(SummarySchema.safeParse(authored).success).toBe(false);
    expect(SummarySchema.safeParse({ ...authored, source_event_id: null }).success).toBe(false);
    expect(SummarySchema.safeParse({ ...authored, source_event_id: '' }).success).toBe(false);
    expect(SummarySchema.safeParse({ ...authored, source_event_id: 'event-1' }).success).toBe(true);
  });
});

describe('ArtifactJsonSchema', () => {
  const minimalArtifactJson = () => ({
    schema_version: 1,
    id: '01J9XR8M7K2QFGKW8',
    state: 'planned',
    branch_lineage: [
      {
        branch: 'feat/auth',
        head_sha: 'abc1234',
        ts: '2026-04-26T12:00:00.000Z',
        event: 'created',
      },
    ],
    created_by_session_id: null,
    created_at: '2026-04-26T12:00:00.000Z',
    updated_at: '2026-04-26T12:00:00.000Z',
    checkpoint_count: 0,
    plan_revision_count: 0,
    plan_last_revised_at: null,
    source_event_id: '019dd7be-3333-7000-8000-000000000003',
    source_plan: null,
    pre_pr_checked_head_sha: null,
    pre_pr_checked_source_event_id: '019dd7be-3333-7000-8000-000000000003',
    baseline_seed_tree_sha: null,
    superseded_artifact_id: null,
  });

  it('accepts the minimal projection every writer emits', () => {
    const parsed = ArtifactJsonSchema.parse(minimalArtifactJson());
    expect(parsed.state).toBe('planned');
    expect('origin' in parsed).toBe(false);
  });

  it('rejects an empty pre-pr source event id when the marker is present', () => {
    expect(
      ArtifactJsonSchema.safeParse({
        ...minimalArtifactJson(),
        pre_pr_checked_source_event_id: '',
      }).success
    ).toBe(false);
  });

  it('rejects an empty projection source event id', () => {
    expect(
      ArtifactJsonSchema.safeParse({
        ...minimalArtifactJson(),
        source_event_id: '',
      }).success
    ).toBe(false);
  });

  it.each([
    'source_plan',
    'pre_pr_checked_head_sha',
    'pre_pr_checked_source_event_id',
    'baseline_seed_tree_sha',
    'superseded_artifact_id',
  ] as const)('rejects a projection missing %s instead of defaulting it null', (field) => {
    const { [field]: _omitted, ...artifact } = minimalArtifactJson();
    const res = ArtifactJsonSchema.safeParse(artifact);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Protocol-aligned schemas. Validates the
// storage-side re-exports + the materialized shapes (= payload +
// materialized disposition + order_key components) + the projection
// envelope. Cross-field invariants on the payload schemas themselves
// are covered exhaustively by the protocol package's own tests; these
// assertions are scoped to the storage-layer additions.
// ─────────────────────────────────────────────────────────────────────

const baseRunPayload = {
  schema: 'orcaops.evaluator_run/v1' as const,
  run_id: '01HXRUN0000000000000000000',
  artifact_id: '01HXART0000000000000000000',
  evaluator_ref: 'core/api-stability',
  package_id: 'core',
  evaluator_id: 'api-stability',
  phase: 'checkpoint-close' as const,
  severity: 'block' as const,
  body: 'VIOLATION\n\nfoo',
  ts: '2026-05-12T20:00:00.000Z',
};

describe('Protocol re-exports through @orcaops/storage', () => {
  it('re-exports EvaluatorRunPayloadSchema with the protocol shape', () => {
    const out = EvaluatorRunPayloadSchema.parse({
      ...baseRunPayload,
      run_status: 'completed',
      verdict: 'violation',
    });
    expect(out.evaluator_ref).toBe('core/api-stability');
    expect(out.verdict).toBe('violation');
  });

  it('re-exports EvaluatorDispositionPayloadSchema with the protocol shape', () => {
    const out = EvaluatorDispositionPayloadSchema.parse({
      schema: 'orcaops.evaluator_disposition/v1',
      disposition_id: '01HXDIS0000000000000000000',
      artifact_id: '01HXART0000000000000000000',
      run_id: '01HXRUN0000000000000000000',
      evaluator_ref: 'core/api-stability',
      disposition: 'acknowledged',
      reason: 'breaking change deliberate',
      agent_session_id: null,
      ts: '2026-05-12T20:05:00.000Z',
    });
    expect(out.disposition).toBe('acknowledged');
  });
});

describe('MaterializedEvaluatorRunSchema', () => {
  const baseMaterialized = {
    ...baseRunPayload,
    run_status: 'completed' as const,
    verdict: 'violation' as const,
    source_event_index: 7,
    local_kind_rank: 0 as const,
    local_index: 0,
  };

  it('accepts a blocking-eligible run with `unresolved` disposition', () => {
    const out = MaterializedEvaluatorRunSchema.parse({
      ...baseMaterialized,
      disposition: 'unresolved',
    });
    expect(out.disposition).toBe('unresolved');
    expect(out.source_event_index).toBe(7);
    expect(out.local_kind_rank).toBe(0);
  });

  it('accepts a blocking-eligible run resolved by an acknowledgement', () => {
    const out = MaterializedEvaluatorRunSchema.parse({
      ...baseMaterialized,
      disposition: 'acknowledged',
    });
    expect(out.disposition).toBe('acknowledged');
  });

  it('accepts a passing block-severity run with `null` disposition (not blocking-eligible)', () => {
    const out = MaterializedEvaluatorRunSchema.parse({
      ...baseMaterialized,
      verdict: 'pass',
      body: 'PASS',
      disposition: null,
    });
    expect(out.disposition).toBeNull();
  });

  it('accepts an errored run with `null` disposition', () => {
    const out = MaterializedEvaluatorRunSchema.parse({
      ...baseMaterialized,
      run_status: 'error',
      verdict: null,
      body: 'ERROR',
      error: { code: 'TIMEOUT', message: 'engine.timeout_ms exceeded' },
      disposition: null,
    });
    expect(out.run_status).toBe('error');
    expect(out.disposition).toBeNull();
  });

  it('rejects a blocking-eligible run with `null` disposition', () => {
    const res = MaterializedEvaluatorRunSchema.safeParse({
      ...baseMaterialized,
      disposition: null,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'disposition');
      expect(issue?.message).toMatch(/blocking-eligible runs must carry a non-null/);
    }
  });

  it('rejects a non-blocking-eligible run with a non-null disposition', () => {
    const res = MaterializedEvaluatorRunSchema.safeParse({
      ...baseMaterialized,
      verdict: 'pass',
      body: 'PASS',
      disposition: 'acknowledged',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'disposition');
      expect(issue?.message).toMatch(/non-blocking-eligible runs must carry `disposition: null`/);
    }
  });

  it('rejects local_kind_rank values other than 0', () => {
    const res = MaterializedEvaluatorRunSchema.safeParse({
      ...baseMaterialized,
      disposition: 'unresolved',
      local_kind_rank: 1,
    });
    expect(res.success).toBe(false);
  });
});

describe('MaterializedEvaluatorDispositionSchema', () => {
  const baseMaterialized = {
    schema: 'orcaops.evaluator_disposition/v1' as const,
    disposition_id: '01HXDIS0000000000000000000',
    artifact_id: '01HXART0000000000000000000',
    run_id: '01HXRUN0000000000000000000',
    evaluator_ref: 'core/api-stability',
    disposition: 'acknowledged' as const,
    reason: 'breaking change deliberate',
    agent_session_id: null as string | null,
    ts: '2026-05-12T20:05:00.000Z',
    source_event_index: 8,
    local_kind_rank: 1 as const,
    local_index: 0,
  };

  it('accepts a materialized disposition with order-key components', () => {
    const out = MaterializedEvaluatorDispositionSchema.parse(baseMaterialized);
    expect(out.disposition).toBe('acknowledged');
    expect(out.source_event_index).toBe(8);
    expect(out.local_kind_rank).toBe(1);
  });

  it('rejects local_kind_rank values other than 1', () => {
    const res = MaterializedEvaluatorDispositionSchema.safeParse({
      ...baseMaterialized,
      local_kind_rank: 0,
    });
    expect(res.success).toBe(false);
  });

  it('rejects the materialized-only `unresolved` value on the written disposition row', () => {
    const res = MaterializedEvaluatorDispositionSchema.safeParse({
      ...baseMaterialized,
      disposition: 'unresolved',
    });
    expect(res.success).toBe(false);
  });
});

describe('EvaluatorLogSchema', () => {
  it('rejects a log omitting source_event_id with the field path (no silent healing)', () => {
    const res = EvaluatorLogSchema.safeParse({
      schema_version: 1,
      artifact_id: '01HXART0000000000000000000',
      runs: [],
      dispositions: [],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join('.') === 'source_event_id')).toBe(true);
    }
  });

  it('rejects an empty source_event_id', () => {
    expect(
      EvaluatorLogSchema.safeParse({
        schema_version: 1,
        artifact_id: '01HXART0000000000000000000',
        runs: [],
        dispositions: [],
        source_event_id: '',
      }).success
    ).toBe(false);
  });

  it.each(['runs', 'dispositions'] as const)(
    'rejects a log omitting %s with the field path (no silent healing)',
    (key) => {
      const full = {
        schema_version: 1,
        artifact_id: '01HXART0000000000000000000',
        runs: [],
        dispositions: [],
        source_event_id: '019dd7be-3333-7000-8000-000000000003',
      };
      const { [key]: _omitted, ...partial } = full;
      const res = EvaluatorLogSchema.safeParse(partial);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.path.join('.') === key)).toBe(true);
      }
    }
  );

  it('accepts an explicitly empty log', () => {
    const out = EvaluatorLogSchema.parse({
      schema_version: 1,
      artifact_id: '01HXART0000000000000000000',
      runs: [],
      dispositions: [],
      source_event_id: '019dd7be-3333-7000-8000-000000000003',
    });
    expect(out.runs).toEqual([]);
    expect(out.dispositions).toEqual([]);
  });

  it('accepts a log with one materialized run and one disposition', () => {
    const out = EvaluatorLogSchema.parse({
      schema_version: 1,
      artifact_id: '01HXART0000000000000000000',
      runs: [
        {
          ...baseRunPayload,
          run_status: 'completed',
          verdict: 'violation',
          disposition: 'acknowledged',
          source_event_index: 4,
          local_kind_rank: 0,
          local_index: 0,
        },
      ],
      dispositions: [
        {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: '01HXDIS0000000000000000000',
          artifact_id: '01HXART0000000000000000000',
          run_id: baseRunPayload.run_id,
          evaluator_ref: baseRunPayload.evaluator_ref,
          disposition: 'acknowledged',
          reason: 'ack',
          agent_session_id: null,
          ts: '2026-05-12T20:05:00.000Z',
          source_event_index: 5,
          local_kind_rank: 1,
          local_index: 0,
        },
      ],
      source_event_id: '01HXEVT0000000000000000000',
    });
    expect(out.runs).toHaveLength(1);
    expect(out.dispositions).toHaveLength(1);
  });

  it('rejects unknown keys (strict)', () => {
    const res = EvaluatorLogSchema.safeParse({
      schema_version: 1,
      artifact_id: '01HXART0000000000000000000',
      runs: [],
      dispositions: [],
      extra: 1,
    });
    expect(res.success).toBe(false);
  });

  it('rejects schema_version other than 1', () => {
    const res = EvaluatorLogSchema.safeParse({
      schema_version: 2,
      artifact_id: '01HXART0000000000000000000',
    });
    expect(res.success).toBe(false);
  });
});

describe('Config defaults + resolveConfig', () => {
  it('getDefaultConfig() returns a fully-populated config', () => {
    const c = getDefaultConfig();
    expect(c.install.agents).toEqual(['claude-code']);
    expect(c.llm.tool).toBe('auto');
    expect(c.llm.effort).toBe('medium');
    expect(c.artifacts.path).toBe('.orcaops/artifacts');
    expect(c.cache.path).toBe('.orcaops/cache/orcaops.db');
    expect(c.evaluators.max_concurrent).toBe(4);
    expect(c.digest.include_reasoning).toBe(false);
    // Marker import retained — keeps the constant alive for downstream consumers.
    expect(DEFAULT_EVALUATOR_MODEL).toMatch(/sonnet/);
  });

  it('resolveConfig({}) yields defaults', () => {
    const c = resolveConfig({});
    expect(c.install.agents).toEqual(['claude-code']);
  });

  it('resolveConfig deep-merges nested overrides', () => {
    const c = resolveConfig({
      llm: { tool: 'claude', model: 'claude-haiku-4-5' },
      digest: { include_reasoning: true },
    });
    expect(c.llm.tool).toBe('claude');
    expect(c.llm.model).toBe('claude-haiku-4-5');
    expect(c.llm.effort).toBe('medium'); // default preserved
    expect(c.digest.include_reasoning).toBe(true);
    expect(c.digest.include_evaluators).toBe(true);
  });
});
