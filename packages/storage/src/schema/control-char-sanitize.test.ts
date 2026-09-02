import { describe, expect, it } from 'vitest';

import {
  CaptureCheckpointCloseInputSchema,
  CapturePlanInputSchema,
  CaptureSummaryInputSchema,
} from './capture-input.js';
import { containsForbiddenControlChars } from '../text/control-chars.js';

const NUL = String.fromCharCode(0x00);

/** Recursively true iff any string anywhere in `value` has a forbidden control char. */
function anyDirty(value: unknown): boolean {
  if (typeof value === 'string') return containsForbiddenControlChars(value);
  if (Array.isArray(value)) return value.some(anyDirty);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(anyDirty);
  }
  return false;
}

/** Append a NUL to every string leaf (objects + arrays), returning a new value. */
function dirtyEveryString(value: unknown): unknown {
  if (typeof value === 'string') return value + NUL;
  if (Array.isArray(value)) return value.map(dirtyEveryString);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = dirtyEveryString(v);
    }
    return out;
  }
  return value;
}

describe('capture-input prose sanitization', () => {
  // A fully-populated plan with prose in every author-facing field + nested
  // structure (steps, criteria, non_goals, decisions, alternatives). It carries
  // NO identifier fields (idempotency_key auto-mints; branch/agent_session_id
  // omitted) so dirtying *every* string still parses — the point of the
  // completeness check below.
  const validPlan = {
    task: 'add rate limiting to /api/charge',
    label: 'rate limit /api/charge',
    touched_scope: ['payments', 'infra'],
    plan_steps: [
      {
        text: 'implement the middleware',
        label: 'middleware',
        acceptance_criteria: [{ text: 'limit-exceeded path returns 429' }],
      },
    ],
    non_goals: [
      { text: 'do not touch auth', rationale: 'separate slice', source_refs: ['section 2.3'] },
    ],
    decisions: [
      {
        decision: 'sliding window over fixed window',
        reason: 'fixed windows allow a boundary burst',
        alternatives_considered: [
          { option: 'fixed-window counter', rejected_because: 'boundary burst' },
        ],
      },
    ],
  };

  it('parses the clean baseline', () => {
    expect(() => CapturePlanInputSchema.parse(validPlan)).not.toThrow();
  });

  it('COMPLETENESS: dirtying every prose string yields a fully NUL-free parse', () => {
    // If any author-facing string field were left unwrapped (a bare z.string()),
    // its NUL would survive into the parsed output and fail this assertion.
    const dirty = dirtyEveryString(validPlan);
    expect(anyDirty(dirty)).toBe(true); // sanity: the input really is dirty
    const parsed = CapturePlanInputSchema.parse(dirty);
    expect(anyDirty(parsed)).toBe(false);
    // structure + values preserved minus the stripped byte
    expect(parsed.task).toBe('add rate limiting to /api/charge');
    expect(parsed.plan_steps[0].acceptance_criteria[0].text).toBe(
      'limit-exceeded path returns 429'
    );
    expect(parsed.non_goals[0].rationale).toBe('separate slice');
    expect(parsed.decisions[0].alternatives_considered?.[0].option).toBe('fixed-window counter');
  });

  it('a required prose field that is ALL forbidden chars → clean validation error (no poison-pill)', () => {
    expect(() => CapturePlanInputSchema.parse({ ...validPlan, task: `${NUL}${NUL}` })).toThrow();
  });

  it('rejects a control char in an identifier field (idempotency_key, not stripped)', () => {
    expect(() =>
      CapturePlanInputSchema.parse({ ...validPlan, idempotency_key: `key${NUL}` })
    ).toThrow();
    expect(() => CapturePlanInputSchema.parse({ ...validPlan, branch: `main${NUL}` })).toThrow();
  });
});

describe('checkpoint-close + summary prose sanitization', () => {
  it('strips NUL from summary, uncertainty, files_changed', () => {
    const parsed = CaptureCheckpointCloseInputSchema.parse({
      summary: `did the thing${NUL}`,
      files_changed: [`src/a.ts${NUL}`],
      uncertainty: [`unsure about TTL${NUL}`],
      completed_step_ids: ['019f00b8-1111-7000-8000-000000000001'],
    });
    expect(anyDirty(parsed)).toBe(false);
    expect(parsed.summary).toBe('did the thing');
    expect(parsed.uncertainty[0]).toBe('unsure about TTL');
  });

  it('rejects a control char in completed_step_ids (identifier)', () => {
    expect(() =>
      CaptureCheckpointCloseInputSchema.parse({
        summary: 'ok',
        completed_step_ids: [`019f00b8${NUL}`],
      })
    ).toThrow();
  });

  it('strips NUL from summary outcome + array items', () => {
    const parsed = CaptureSummaryInputSchema.parse({
      outcome: `shipped${NUL}`,
      tests_run: [`pnpm test${NUL}`],
      open_items: [`follow up${NUL}`],
    });
    expect(anyDirty(parsed)).toBe(false);
    expect(parsed.outcome).toBe('shipped');
  });
});
