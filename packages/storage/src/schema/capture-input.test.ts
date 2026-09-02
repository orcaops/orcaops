import { describe, expect, it } from 'vitest';

import {
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

  it('accepts base-shape decisions and strips a stray agent-supplied revision_n', () => {
    const parsed = CapturePlanInputSchema.parse({
      task: 't',
      label: 'a label',
      plan_steps: [{ text: 'do', label: 's1' }],
      decisions: [
        {
          decision: 'use X',
          reason: 'because Y',
          revision_n: 7,
          alternatives_considered: [{ option: 'Z', rejected_because: 'slower' }],
        },
      ],
    });
    expect(parsed.decisions).toHaveLength(1);
    // The agent supplies the base shape; the write path owns revision_n.
    expect('revision_n' in parsed.decisions[0]).toBe(false);
    expect(parsed.decisions[0].alternatives_considered).toEqual([
      { option: 'Z', rejected_because: 'slower' },
    ]);
  });
});
