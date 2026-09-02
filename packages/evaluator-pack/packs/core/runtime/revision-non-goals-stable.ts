#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelope {
  if (ctx.plan.revision_n === 0) {
    return pass('PASS\n\nInitial plan capture has no prior revision to compare.', {
      raw: { revision_n: 0 },
    });
  }
  if (ctx.prior_plan === null) {
    return pass(
      'PASS\n\nRevision context did not provide a prior plan for comparison ' +
        '(unexpected — surface to doctor).',
      { raw: { revision_n: ctx.plan.revision_n, priorPlan: null } }
    );
  }

  // non_goals are structured NonGoal objects, so dedup MUST key
  // on `.text` — a Set of objects compares by identity and would flag every
  // non-goal as removed across revisions. `removed`/`added` stay text
  // strings for display and the `raw` payload.
  const priorSet = new Set(ctx.prior_plan.non_goals.map((ng) => ng.text));
  const currentSet = new Set(ctx.plan.non_goals.map((ng) => ng.text));
  const removed = [...priorSet].filter((text) => !currentSet.has(text));
  const added = [...currentSet].filter((text) => !priorSet.has(text));

  if (removed.length === 0) {
    return pass(
      added.length > 0
        ? `PASS\n\nRevision added ${added.length} non-goal(s); none removed.`
        : 'PASS\n\nNon-goals unchanged across revision.',
      { raw: { revision_n: ctx.plan.revision_n, added, removed: [] } }
    );
  }

  const list = removed.map((ng) => `- "${ng}"`).join('\n');
  return violation(
    `VIOLATION\n\nRevision n=${ctx.plan.revision_n} removed ${removed.length} non-goal(s):\n` +
      `${list}\n\nNon-goals are intentional out-of-scope boundaries; relaxing them silently is a ` +
      `scope-creep signal. If the removal is intentional, capture the rationale clearly so ` +
      `reviewers see what changed.`,
    { raw: { revision_n: ctx.plan.revision_n, added, removed } }
  );
}

runIfDispatched(check);
