#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelope {
  const rawArgs = ctx.params;
  const maxDiff =
    typeof rawArgs.max_diff_fraction === 'number' &&
    rawArgs.max_diff_fraction > 0 &&
    rawArgs.max_diff_fraction <= 1
      ? rawArgs.max_diff_fraction
      : 0.5;
  const minSize =
    typeof rawArgs.min_prior_plan_size === 'number' && rawArgs.min_prior_plan_size > 0
      ? rawArgs.min_prior_plan_size
      : 4;

  if (ctx.plan.revision_n === 0) {
    return pass('PASS\n\nInitial plan capture has no diff to bound.', { raw: { revision_n: 0 } });
  }

  const lineage = ctx.plan.step_lineage ?? { added: [], dropped: [], unchanged: [], rewritten: [] };
  const added = lineage.added.length;
  const dropped = lineage.dropped.length;
  const unchanged = lineage.unchanged.length;
  const rewritten = lineage.rewritten.length;
  const priorSize = unchanged + rewritten + dropped;

  if (priorSize < minSize) {
    return pass(
      `PASS\n\nPrior plan had only ${priorSize} step(s) (< min_prior_plan_size=${minSize}); ` +
        `cadence guard does not apply.`,
      {
        raw: {
          revision_n: ctx.plan.revision_n,
          prior_plan_size: priorSize,
          added,
          dropped,
          min_prior_plan_size: minSize,
        },
      }
    );
  }

  const diff = added + dropped;
  const ratio = priorSize === 0 ? 0 : diff / priorSize;
  if (ratio < maxDiff) {
    return pass(
      `PASS\n\nRevision diff is ${diff}/${priorSize} (${Math.round(ratio * 100)}%) — under the ` +
        `${Math.round(maxDiff * 100)}% threshold.`,
      {
        raw: {
          revision_n: ctx.plan.revision_n,
          added,
          dropped,
          unchanged,
          rewritten,
          prior_plan_size: priorSize,
          ratio,
          max_diff_fraction: maxDiff,
        },
      }
    );
  }

  return violation(
    `VIOLATION\n\nRevision n=${ctx.plan.revision_n} adds ${added} and drops ${dropped} steps ` +
      `against a prior plan of ${priorSize} (${Math.round(ratio * 100)}% of the plan). Consider ` +
      `starting a fresh artifact instead — large structural changes are easier to review against ` +
      `a clean plan than a chain of revisions.`,
    {
      raw: {
        revision_n: ctx.plan.revision_n,
        added,
        dropped,
        unchanged,
        rewritten,
        prior_plan_size: priorSize,
        ratio,
        max_diff_fraction: maxDiff,
      },
    }
  );
}

runIfDispatched(check);
