import { describe, expect, it } from 'vitest';

import {
  CaptureAcknowledgeInputSchema,
  CaptureCheckpointAbandonInputSchema,
  CaptureCheckpointCloseInputSchema,
  CaptureCheckpointOpenInputSchema,
  CapturePlanInputSchema,
  CapturePlanReviseInputSchema,
  CapturePrePrCheckInputSchema,
  CaptureRunEvaluatorsInputSchema,
  CaptureSummaryInputSchema,
} from './capture-input.js';

/**
 * CLI-ergonomics contract on the capture input schemas:
 *   - `idempotency_key` is auto-minted (UUIDv7) when omitted, fresh per parse.
 *   - `artifact_id` is optional on the five mid-flight commands (autodetect),
 *     still required on plan-revise / run-evaluators.
 *   - `n` is optional on checkpoint close (omit → single open cp).
 */
describe('capture-input schema contract', () => {
  describe('nonblank prose', () => {
    it('rejects whitespace-only required and optional-present prose', () => {
      expect(() => CaptureCheckpointCloseInputSchema.parse({ summary: '   ' })).toThrow();
      expect(() =>
        CaptureCheckpointCloseInputSchema.parse({
          summary: 'done',
          verification: [{ command: 'test', exit_code: 0, note: '   ' }],
        })
      ).toThrow();
    });

    it('rejects whitespace-only list entries', () => {
      expect(() =>
        CaptureSummaryInputSchema.parse({ outcome: 'done', tests_run: ['   '] })
      ).toThrow();
      expect(() =>
        CapturePlanInputSchema.parse({
          task: 'task',
          label: 'plan label',
          plan_steps: [{ text: 'step', label: 'step label' }],
          touched_scope: ['   '],
        })
      ).toThrow();
    });
  });

  describe('idempotency_key auto-mint', () => {
    it('mints a fresh non-empty key when omitted, different on each parse', () => {
      const a = CaptureCheckpointCloseInputSchema.parse({ summary: 's' });
      const b = CaptureCheckpointCloseInputSchema.parse({ summary: 's' });
      expect(typeof a.idempotency_key).toBe('string');
      expect(a.idempotency_key.length).toBeGreaterThan(0);
      // Auto-mint is per-parse, so a naive retry does NOT collide as a replay.
      expect(a.idempotency_key).not.toBe(b.idempotency_key);
    });

    it('preserves an explicit key', () => {
      const parsed = CaptureCheckpointOpenInputSchema.parse({
        idempotency_key: 'caller-supplied',
        declared_step_ids: ['s1'],
      });
      expect(parsed.idempotency_key).toBe('caller-supplied');
    });

    it('rejects an explicit empty-string key', () => {
      expect(() =>
        CaptureSummaryInputSchema.parse({ idempotency_key: '', outcome: 'o' })
      ).toThrow();
    });
  });

  describe('artifact_id optionality', () => {
    it('is optional on the five mid-flight capture schemas', () => {
      expect(
        CaptureCheckpointOpenInputSchema.parse({ declared_step_ids: ['s1'] }).artifact_id
      ).toBeUndefined();
      expect(CaptureCheckpointCloseInputSchema.parse({ summary: 's' }).artifact_id).toBeUndefined();
      expect(
        CaptureCheckpointAbandonInputSchema.parse({ n: 1, reason: 'r' }).artifact_id
      ).toBeUndefined();
      expect(CaptureSummaryInputSchema.parse({ outcome: 'o' }).artifact_id).toBeUndefined();
      expect(CapturePrePrCheckInputSchema.parse({}).artifact_id).toBeUndefined();
    });

    it('stays required on plan-revise and run-evaluators', () => {
      expect(() =>
        CapturePlanReviseInputSchema.parse({
          label: 'l',
          plan_steps: [{ text: 't', label: 's1' }],
          rationale: 'why',
          prior_plan_event_id: null,
        })
      ).toThrow();
      expect(() => CaptureRunEvaluatorsInputSchema.parse({ fires_at: 'pre-pr' })).toThrow();
    });
  });

  describe('checkpoint close `n` optionality', () => {
    it('is optional (omit → resolve the single open cp downstream)', () => {
      expect(CaptureCheckpointCloseInputSchema.parse({ summary: 's' }).n).toBeUndefined();
      expect(CaptureCheckpointCloseInputSchema.parse({ n: 3, summary: 's' }).n).toBe(3);
    });

    it('stays required on abandon', () => {
      expect(() => CaptureCheckpointAbandonInputSchema.parse({ reason: 'r' })).toThrow();
    });
  });
});

describe('plan-time decisions input (base shape, default [])', () => {
  it('CapturePlanInputSchema defaults decisions to []', () => {
    const parsed = CapturePlanInputSchema.parse({
      task: 't',
      label: 'a label',
      plan_steps: [{ text: 'do', label: 's1' }],
    });
    expect(parsed.decisions).toEqual([]);
  });

  it('CapturePlanReviseInputSchema defaults decisions to []', () => {
    const parsed = CapturePlanReviseInputSchema.parse({
      artifact_id: 'a',
      label: 'a label',
      plan_steps: [{ text: 'do', label: 's1' }],
      rationale: 'why',
      prior_plan_event_id: null,
    });
    expect(parsed.decisions).toEqual([]);
  });

  it('accepts base-shape decisions with alternatives and rejects an agent-supplied revision_n', () => {
    const plan = (decision: Record<string, unknown>) => ({
      task: 't',
      label: 'a label',
      plan_steps: [{ text: 'do', label: 's1' }],
      decisions: [decision],
    });
    const parsed = CapturePlanInputSchema.parse(
      plan({
        decision: 'use X',
        reason: 'because Y',
        alternatives_considered: [{ option: 'Z', rejected_because: 'slower' }],
      })
    );
    expect(parsed.decisions[0].alternatives_considered).toEqual([
      { option: 'Z', rejected_because: 'slower' },
    ]);
    const stamped = CapturePlanInputSchema.safeParse(
      plan({ decision: 'use X', reason: 'because Y', revision_n: 7 })
    );
    expect(stamped.error?.issues).toMatchObject([
      { code: 'unrecognized_keys', keys: ['revision_n'], path: ['decisions', 0] },
    ]);
  });
});

describe('unknown keys in capture input', () => {
  const step = { text: 'do', label: 's1', acceptance_criteria: [{ text: 'done' }] };
  const plan = { task: 't', label: 'a label', plan_steps: [step] };
  const revise = {
    artifact_id: 'a',
    label: 'a label',
    plan_steps: [{ ...step, step_id: 's' }],
    rationale: 'why',
    prior_plan_event_id: null,
  };
  const messages = (result: { error?: { issues: { message: string }[] } }) =>
    (result.error?.issues ?? []).map((issue) => issue.message);

  it('refuses a close whose completion claim sits under a misspelled key', () => {
    const result = CaptureCheckpointCloseInputSchema.safeParse({
      summary: 'done',
      completed_steps: ['s'],
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toEqual([
      'Unknown key "completed_steps" (did you mean "completed_step_ids"?)',
    ]);
  });

  it('refuses a plan whose non-goals sit under a misspelled key', () => {
    const result = CapturePlanInputSchema.safeParse({
      ...plan,
      non_goal: [{ text: 'x', rationale: 'y' }],
    });
    expect(messages(result)).toEqual(['Unknown key "non_goal" (did you mean "non_goals"?)']);
  });

  it('names every unknown key in one issue and omits a suggestion when nothing is close', () => {
    const result = CaptureCheckpointCloseInputSchema.safeParse({
      summary: 'done',
      decision: [],
      zzzzzzzzzzzzzzzz: 1,
    });
    expect(messages(result)).toEqual([
      'Unknown keys "decision" (did you mean "decisions"?), "zzzzzzzzzzzzzzzz"',
    ]);
  });

  it.each([
    ['plan step', CapturePlanInputSchema, { ...plan, plan_steps: [{ ...step, lable: 'x' }] }],
    [
      'plan criterion',
      CapturePlanInputSchema,
      {
        ...plan,
        plan_steps: [{ ...step, acceptance_criteria: [{ text: 'd', criterion_id: 'c' }] }],
      },
    ],
    [
      'plan non-goal',
      CapturePlanInputSchema,
      { ...plan, non_goals: [{ text: 'x', rationale: 'y', source_ref: [] }] },
    ],
    [
      'decision alternative',
      CapturePlanInputSchema,
      {
        ...plan,
        decisions: [
          {
            decision: 'd',
            reason: 'r',
            alternatives_considered: [{ option: 'o', rejected_because: 'r', why: 'w' }],
          },
        ],
      },
    ],
    ['revise top level', CapturePlanReviseInputSchema, { ...revise, rationle: 'x' }],
    [
      'revise step',
      CapturePlanReviseInputSchema,
      { ...revise, plan_steps: [{ ...step, stepid: 's' }] },
    ],
    [
      'revise criterion',
      CapturePlanReviseInputSchema,
      { ...revise, plan_steps: [{ ...step, acceptance_criteria: [{ text: 'd', id: 'c' }] }] },
    ],
    [
      'revise non-goal',
      CapturePlanReviseInputSchema,
      { ...revise, non_goals: [{ text: 'x', rationale: 'y', why: 'z' }] },
    ],
    [
      'revise decision',
      CapturePlanReviseInputSchema,
      { ...revise, decisions: [{ decision: 'd', reason: 'r', reasons: 'x' }] },
    ],
    [
      'checkpoint open',
      CaptureCheckpointOpenInputSchema,
      { declared_step_ids: ['s'], declared_steps: ['s'] },
    ],
    [
      'checkpoint open policy exception',
      CaptureCheckpointOpenInputSchema,
      { declared_step_ids: ['s'], policy_exceptions: [{ evaluator: 'e', reason: 'r', why: 'w' }] },
    ],
    [
      'checkpoint close decision',
      CaptureCheckpointCloseInputSchema,
      { summary: 's', decisions: [{ decision: 'd', reason: 'r', revision_n: 1 }] },
    ],
    ['checkpoint abandon', CaptureCheckpointAbandonInputSchema, { n: 1, reason: 'r', reasn: 'r' }],
    ['summary', CaptureSummaryInputSchema, { outcome: 'o', test_run: [] }],
    [
      'summary accepted warning',
      CaptureSummaryInputSchema,
      {
        outcome: 'o',
        accepted_warnings: [
          { review_id: 'v', run_id: 'r', evaluator_ref: 'e', reason: 'x', note: 'n' },
        ],
      },
    ],
    [
      'run-evaluators',
      CaptureRunEvaluatorsInputSchema,
      { artifact_id: 'a', fires_at: 'pre-pr', checkpoint: 1 },
    ],
    ['pre-pr-check', CapturePrePrCheckInputSchema, { artifactid: 'a' }],
    [
      'acknowledge',
      CaptureAcknowledgeInputSchema,
      { artifact_id: 'a', evaluator: 'e', reason: 'r', run_id: 'x' },
    ],
  ])('refuses an unknown key on the %s', (_, schema, input) => {
    const result = schema.safeParse(input);
    expect(result.error?.issues).toMatchObject([{ code: 'unrecognized_keys' }]);
  });
});
