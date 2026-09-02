import { z } from 'zod';

import {
  CheckpointDecisionSchema,
  DoneCriterionSchema,
  PolicyExceptionSchema,
  VerificationEntrySchema,
} from './checkpoint.js';
import { PlanInputSchema } from './plan.js';
import { SummaryInputSchema } from './summary.js';

/**
 * Shape of an `orcaops eval test --fixture` file: a synthetic artifact
 * thread (plan, optional checkpoints, optional summary) that the CLI
 * materializes into a disposable store so a single evaluator can be run
 * against it without driving an agent session.
 *
 * It lives here because every field is a storage input schema — defining it
 * in the CLI meant importing six of them back out to reassemble a shape this
 * package already owns.
 */

/**
 * Fields every fixture checkpoint carries, open or closed.
 *
 * `declared_step_ids` must name steps in the plan, and concurrent opens must
 * declare disjoint scopes; the store enforces both, so a fixture that
 * violates them fails at write time exactly as a real capture would.
 * `plan_revision_id: null` opts out of the staleness check.
 */
const fixtureCheckpointBase = {
  artifact_id: z.string().min(1),
  n: z.number().int().positive(),
  declared_step_ids: z.array(z.string().min(1)).min(1),
  agent_session_id: z.string().min(1).optional(),
  policy_exceptions: z.array(PolicyExceptionSchema).default([]),
  plan_revision_id: z.string().min(1).nullable().default(null),
  head_sha: z.string().min(1),
};

/**
 * A checkpoint left open. Required to exercise a `checkpoint-open` evaluator
 * at all: with only closed checkpoints available, such an evaluator has no
 * `current_checkpoint` to read and can reach nothing but its
 * no-open-checkpoint pass — a green that proves nothing.
 */
export const FixtureOpenCheckpointSchema = z.strictObject({
  status: z.literal('open'),
  ...fixtureCheckpointBase,
});

export const FixtureClosedCheckpointSchema = z.strictObject({
  status: z.literal('closed'),
  ...fixtureCheckpointBase,
  summary: z.string().min(1),
  files_changed: z.array(z.string()).default([]),
  decisions: z.array(CheckpointDecisionSchema).default([]),
  uncertainty: z.array(z.string()).default([]),
  done_criteria: z.array(DoneCriterionSchema).default([]),
  verification: z.array(VerificationEntrySchema).optional(),
  completed_step_ids: z.array(z.string().min(1)).default([]),
});

export const FixtureCheckpointSchema = z.discriminatedUnion('status', [
  FixtureOpenCheckpointSchema,
  FixtureClosedCheckpointSchema,
]);
export type FixtureCheckpoint = z.infer<typeof FixtureCheckpointSchema>;

export const FixtureFileSchema = z
  .strictObject({
    plan: PlanInputSchema,
    checkpoints: z.array(FixtureCheckpointSchema).optional(),
    summary: SummaryInputSchema.optional(),
    fires_at: z.enum(['post-plan', 'checkpoint-open', 'checkpoint-close', 'pre-pr']).optional(),
    checkpoint_n: z.number().int().positive().optional(),
  })
  .superRefine((fixture, ctx) => {
    const checkpoints = fixture.checkpoints ?? [];

    // `checkpoint_n` names a fixture checkpoint by its `n`, so duplicates make
    // the reference ambiguous and the later one would silently win.
    const seen = new Map<number, number>();
    for (const [i, cp] of checkpoints.entries()) {
      const prior = seen.get(cp.n);
      if (prior !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkpoints', i, 'n'],
          message: `duplicate checkpoint n ${cp.n} (first declared at checkpoints[${prior}])`,
        });
      } else {
        seen.set(cp.n, i);
      }
    }

    // An unresolvable checkpoint_n used to fall through to a raw storage id,
    // which either selected nothing — leaving current_checkpoint null and an
    // evaluator grading an empty world — or, worse, selected a different
    // checkpoint that happened to carry that storage number.
    if (fixture.checkpoint_n !== undefined && !seen.has(fixture.checkpoint_n)) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkpoint_n'],
        message:
          `checkpoint_n ${fixture.checkpoint_n} names no checkpoint in this fixture ` +
          `(declared: ${checkpoints.length > 0 ? [...seen.keys()].sort((a, b) => a - b).join(', ') : 'none'})`,
      });
    }

    // Only the explicit case is checkable here: an omitted `fires_at` defaults
    // to the evaluator's own phase, which the schema cannot see. `eval test`
    // enforces the defaulted case once it has resolved the evaluator.
    if (
      (fixture.fires_at === 'checkpoint-open' || fixture.fires_at === 'checkpoint-close') &&
      fixture.checkpoint_n === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkpoint_n'],
        message:
          `fires_at: ${fixture.fires_at} needs a checkpoint_n naming which checkpoint the ` +
          'run is about; without one the evaluator sees no current_checkpoint and its verdict ' +
          'says nothing',
      });
    }

    // The store refuses a summary while any checkpoint is still open. Caught
    // here so the author gets a fixture-shaped message instead of an
    // OpenCheckpointsPendingError from three layers down.
    if (fixture.summary === undefined) return;
    const open = checkpoints.filter((cp) => cp.status === 'open');
    if (open.length === 0) return;
    ctx.addIssue({
      code: 'custom',
      path: ['summary'],
      message:
        `cannot pair a summary with ${open.length} open checkpoint(s) ` +
        `(n: ${open.map((cp) => cp.n).join(', ')}) — a summary finalizes the artifact, ` +
        'so close them in the fixture or drop the summary',
    });
  });
export type FixtureFile = z.infer<typeof FixtureFileSchema>;
