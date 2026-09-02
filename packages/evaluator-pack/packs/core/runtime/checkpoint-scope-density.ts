#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelope {
  const cp =
    ctx.current_checkpoint !== null && ctx.current_checkpoint.status === 'open'
      ? ctx.current_checkpoint
      : null;
  if (!cp) {
    return pass('PASS\n\nNo open checkpoint in scope.', {
      raw: { reason: 'no-current-open-checkpoint' },
    });
  }

  const maxFraction =
    typeof ctx.params.max_fraction_of_plan === 'number' ? ctx.params.max_fraction_of_plan : 0.6;
  const minPlanSize = typeof ctx.params.min_plan_size === 'number' ? ctx.params.min_plan_size : 4;

  if (ctx.plan.plan_steps.length < minPlanSize) {
    return pass(
      `PASS\n\nPlan has only ${ctx.plan.plan_steps.length} step(s) (< min_plan_size=${minPlanSize}); cadence guard does not apply.`,
      {
        raw: {
          plan_size: ctx.plan.plan_steps.length,
          declared: cp.declared_step_ids.length,
          min_plan_size: minPlanSize,
        },
      }
    );
  }

  const ratio = cp.declared_step_ids.length / ctx.plan.plan_steps.length;
  if (ratio < maxFraction) {
    return pass(
      `PASS\n\nDeclares ${cp.declared_step_ids.length} of ${ctx.plan.plan_steps.length} ` +
        `plan steps (${Math.round(ratio * 100)}%) — under the ${Math.round(maxFraction * 100)}% threshold.`,
      {
        raw: {
          plan_size: ctx.plan.plan_steps.length,
          declared: cp.declared_step_ids.length,
          ratio,
          max_fraction_of_plan: maxFraction,
        },
      }
    );
  }

  const pct = Math.round(ratio * 100);
  return violation(
    `VIOLATION\n\nThis open checkpoint declares ${cp.declared_step_ids.length} of ` +
      `${ctx.plan.plan_steps.length} plan steps (${pct}%). Open a smaller checkpoint covering ` +
      `one beat at a time, or retry with policy_exceptions[] naming this evaluator if the ` +
      `batching is intentional.`,
    {
      raw: {
        plan_size: ctx.plan.plan_steps.length,
        declared: cp.declared_step_ids.length,
        ratio,
        max_fraction_of_plan: maxFraction,
      },
    }
  );
}

runIfDispatched(check);
