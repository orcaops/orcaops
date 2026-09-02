import { describe, expect, it } from 'vitest';

import { criterionMoveWarnings, criterionRewordWarnings, type Plan } from './plan.js';

/**
 * Pure advisory: `criterionRewordWarnings` flags per-step drop+mint co-occurrence
 * (a *possible* omitted-criterion_id-on-reword), keyed off `added` (mints only).
 * It gates nothing and is deliberately hedged; the cross-step move is a documented
 * blind spot it does NOT catch.
 */
describe('criterionRewordWarnings', () => {
  const STEP_A = 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa';
  const STEP_B = 'bbbbbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb';
  const MINT_X = 'cccccccc-cccc-7ccc-cccc-cccccccccccc';
  const CRIT_A1 = 'dddddddd-dddd-7ddd-dddd-dddddddddddd';
  const OLD = 'eeeeeeee-eeee-7eee-eeee-eeeeeeeeeeee';

  /** Minimal Plan exercising only the fields the helper reads. */
  function planWith(opts: {
    steps: Array<{
      step_id: string;
      label: string;
      criteria: Array<{ criterion_id: string; text: string }>;
    }>;
    added?: string[];
    carried?: string[];
    removed?: Array<{ criterion_id: string; prior_step_id: string; text: string }>;
  }): Plan {
    return {
      schema_version: 4,
      artifact_id: 'art',
      branch: 'b',
      base_sha: 's',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'l',
      plan_steps: opts.steps.map((s) => ({
        step_id: s.step_id,
        text: 'step text',
        label: s.label,
        acceptance_criteria: s.criteria,
      })),
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: '2026-01-01T00:00:00.000Z',
      revision_n: 1,
      revised_at: '2026-01-01T00:00:00.000Z',
      rationale: 'r',
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: {
        added: opts.added ?? [],
        carried: opts.carried ?? [],
        removed: opts.removed ?? [],
        rewritten: [],
      },
      prior_plan_event_id: null,
      source_event_id: 'plan-event-1',
    } as Plan;
  }

  it('per-step drop+mint → one warning carrying the actionable minted {criterion_id, text}', () => {
    const plan = planWith({
      steps: [
        {
          step_id: STEP_A,
          label: 'step-a',
          criteria: [{ criterion_id: MINT_X, text: 'reworded text' }],
        },
      ],
      added: [MINT_X],
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'original text' }],
    });
    expect(criterionRewordWarnings(plan)).toEqual([
      {
        step_id: STEP_A,
        label: 'step-a',
        removed_texts: ['original text'],
        minted: [{ criterion_id: MINT_X, text: 'reworded text' }],
      },
    ]);
  });

  it('coalesces multiple drops + multiple mints on one step into a SINGLE warning entry', () => {
    const MINT_X2 = 'cccccccc-cccc-7ccc-cccc-ccccccccccc2';
    const OLD2 = 'eeeeeeee-eeee-7eee-eeee-eeeeeeeeeee2';
    const plan = planWith({
      steps: [
        {
          step_id: STEP_A,
          label: 'step-a',
          criteria: [
            { criterion_id: MINT_X, text: 'reworded one' },
            { criterion_id: MINT_X2, text: 'reworded two' },
          ],
        },
      ],
      added: [MINT_X, MINT_X2],
      removed: [
        { criterion_id: OLD, prior_step_id: STEP_A, text: 'original one' },
        { criterion_id: OLD2, prior_step_id: STEP_A, text: 'original two' },
      ],
    });
    // One step → one entry, coalescing BOTH dropped texts and BOTH minted pairs
    // (removed_texts follows criterion_lineage.removed order; minted follows the
    // step's acceptance_criteria order).
    expect(criterionRewordWarnings(plan)).toEqual([
      {
        step_id: STEP_A,
        label: 'step-a',
        removed_texts: ['original one', 'original two'],
        minted: [
          { criterion_id: MINT_X, text: 'reworded one' },
          { criterion_id: MINT_X2, text: 'reworded two' },
        ],
      },
    ]);
  });

  it('cross-step move (drop on A, mint on B) → ZERO warnings (the documented blind spot)', () => {
    const plan = planWith({
      steps: [
        { step_id: STEP_A, label: 'step-a', criteria: [] }, // criterion dropped off A
        {
          step_id: STEP_B,
          label: 'step-b',
          criteria: [{ criterion_id: MINT_X, text: 'moved text' }],
        },
      ],
      added: [MINT_X], // minted on B
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'moved text' }], // removed from A
    });
    // Neither step has BOTH a removal and a mint, so the per-step signal stays silent.
    expect(criterionRewordWarnings(plan)).toEqual([]);
  });

  it('clean auto-carry → ZERO warnings (carried is not added)', () => {
    const plan = planWith({
      steps: [
        {
          step_id: STEP_A,
          label: 'step-a',
          criteria: [{ criterion_id: CRIT_A1, text: 'unchanged' }],
        },
      ],
      carried: [CRIT_A1], // carried, NOT in added
      removed: [],
    });
    expect(criterionRewordWarnings(plan)).toEqual([]);
  });

  it('pure remove (no mint) and pure add (no remove) each → ZERO warnings', () => {
    const pureRemove = planWith({
      steps: [{ step_id: STEP_A, label: 'step-a', criteria: [] }],
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'gone' }],
    });
    expect(criterionRewordWarnings(pureRemove)).toEqual([]);

    const pureAdd = planWith({
      steps: [
        {
          step_id: STEP_A,
          label: 'step-a',
          criteria: [{ criterion_id: MINT_X, text: 'brand new' }],
        },
      ],
      added: [MINT_X],
    });
    expect(criterionRewordWarnings(pureAdd)).toEqual([]);
  });
});

/**
 * A cross-step identical-text move is outside the per-step reword advisory, so
 * it has a narrow non-blocking advisory with three mandatory guards.
 */
describe('criterionMoveWarnings', () => {
  const STEP_A = 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa';
  const STEP_B = 'bbbbbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb';
  const STEP_C = 'ffffffff-ffff-7fff-ffff-ffffffffffff';
  const MINT_X = 'cccccccc-cccc-7ccc-cccc-cccccccccccc';
  const MINT_Y = '99999999-9999-7999-9999-999999999999';
  const OLD = 'eeeeeeee-eeee-7eee-eeee-eeeeeeeeeeee';
  const CARRIED_ID = '88888888-8888-7888-8888-888888888888';

  function movePlan(opts: {
    steps: Array<{
      step_id: string;
      criteria: Array<{ criterion_id: string; text: string }>;
    }>;
    added?: string[];
    carried?: string[];
    removed?: Array<{ criterion_id: string; prior_step_id: string; text: string }>;
  }): Plan {
    return {
      schema_version: 4,
      artifact_id: 'art',
      branch: 'b',
      base_sha: 's',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'l',
      plan_steps: opts.steps.map((s) => ({
        step_id: s.step_id,
        text: 'step text',
        label: `label-${s.step_id.slice(0, 4)}`,
        acceptance_criteria: s.criteria,
      })),
      touched_scope: [],
      non_goals: [],
      decisions: [],
      revision_n: 1,
      started_at: '2026-07-30T00:00:00.000Z',
      revised_at: '2026-07-30T00:00:01.000Z',
      step_lineage: { carried: [], added: [], dropped: [], reordered: false },
      criterion_lineage: {
        added: opts.added ?? [],
        carried: opts.carried ?? [],
        removed: opts.removed ?? [],
        rewritten: [],
      },
    } as unknown as Plan;
  }

  it('fires on a clean 1:1 cross-step move with the full discriminated payload', () => {
    const plan = movePlan({
      steps: [
        { step_id: STEP_A, criteria: [] },
        { step_id: STEP_B, criteria: [{ criterion_id: MINT_X, text: 'Move me' }] },
      ],
      added: [MINT_X],
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'Move me' }],
    });
    const warnings = criterionMoveWarnings(plan);
    expect(warnings).toHaveLength(1);
    const w = warnings[0]!;
    expect(w.kind).toBe('cross-step-criterion-move');
    expect(w.source_step_id).toBe(STEP_A);
    expect(w.destination_step_id).toBe(STEP_B);
    expect(w.text).toBe('Move me');
    expect(w.minted_criterion_id).toBe(MINT_X);
    // The message explains the API rule and never advises reusing the old id.
    expect(w.message).toMatch(/cross-step/i);
    expect(w.message).toMatch(/forbidden|cannot|must not/i);
    expect(w.message).not.toContain(OLD);
    expect(w.message).not.toMatch(/re-?supply|re-?use the (old|prior)/i);
  });

  it('pairs on TRIMMED text', () => {
    const plan = movePlan({
      steps: [
        { step_id: STEP_A, criteria: [] },
        { step_id: STEP_B, criteria: [{ criterion_id: MINT_X, text: '  Move me ' }] },
      ],
      added: [MINT_X],
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'Move me  ' }],
    });
    expect(criterionMoveWarnings(plan)).toHaveLength(1);
  });

  it('suppresses when the text appears twice among removed (ambiguous pairing)', () => {
    const plan = movePlan({
      steps: [
        { step_id: STEP_A, criteria: [] },
        { step_id: STEP_C, criteria: [] },
        { step_id: STEP_B, criteria: [{ criterion_id: MINT_X, text: 'Move me' }] },
      ],
      added: [MINT_X],
      removed: [
        { criterion_id: OLD, prior_step_id: STEP_A, text: 'Move me' },
        { criterion_id: CARRIED_ID, prior_step_id: STEP_C, text: 'Move me' },
      ],
    });
    expect(criterionMoveWarnings(plan)).toHaveLength(0);
  });

  it('suppresses when the text appears twice among mints (ambiguous pairing)', () => {
    const plan = movePlan({
      steps: [
        { step_id: STEP_A, criteria: [] },
        { step_id: STEP_B, criteria: [{ criterion_id: MINT_X, text: 'Move me' }] },
        { step_id: STEP_C, criteria: [{ criterion_id: MINT_Y, text: 'Move me' }] },
      ],
      added: [MINT_X, MINT_Y],
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'Move me' }],
    });
    expect(criterionMoveWarnings(plan)).toHaveLength(0);
  });

  it('suppresses when the source step did not survive the revision', () => {
    const plan = movePlan({
      steps: [{ step_id: STEP_B, criteria: [{ criterion_id: MINT_X, text: 'Move me' }] }],
      added: [MINT_X],
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'Move me' }],
    });
    expect(criterionMoveWarnings(plan)).toHaveLength(0);
  });

  it('suppresses boilerplate: the text also lives as a CARRIED criterion on another step', () => {
    const plan = movePlan({
      steps: [
        { step_id: STEP_A, criteria: [] },
        { step_id: STEP_B, criteria: [{ criterion_id: MINT_X, text: 'Move me' }] },
        { step_id: STEP_C, criteria: [{ criterion_id: CARRIED_ID, text: 'Move me' }] },
      ],
      added: [MINT_X],
      carried: [CARRIED_ID],
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'Move me' }],
    });
    expect(criterionMoveWarnings(plan)).toHaveLength(0);
  });

  it('suppresses boilerplate carried by an EXPLICITLY re-supplied id (not in lineage.carried)', () => {
    // store.ts never adds explicitly-supplied unchanged criterion_ids to
    // criterion_lineage.carried, so guard 3 must count texts across the
    // whole revised plan, not lineage arrays.
    const plan = movePlan({
      steps: [
        { step_id: STEP_A, criteria: [] },
        { step_id: STEP_B, criteria: [{ criterion_id: MINT_X, text: 'Move me' }] },
        { step_id: STEP_C, criteria: [{ criterion_id: CARRIED_ID, text: 'Move me' }] },
      ],
      added: [MINT_X],
      carried: [], // the explicit-id carry path: NOT in the lineage array
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'Move me' }],
    });
    expect(criterionMoveWarnings(plan)).toHaveLength(0);
  });

  it('does NOT fire on a same-step drop+mint (reword territory)', () => {
    const plan = movePlan({
      steps: [{ step_id: STEP_A, criteria: [{ criterion_id: MINT_X, text: 'Move me' }] }],
      added: [MINT_X],
      removed: [{ criterion_id: OLD, prior_step_id: STEP_A, text: 'Move me' }],
    });
    expect(criterionMoveWarnings(plan)).toHaveLength(0);
  });
});
