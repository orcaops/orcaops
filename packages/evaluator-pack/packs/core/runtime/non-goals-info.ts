#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched } from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelope {
  const nonGoals = ctx.plan.non_goals;

  if (nonGoals.length === 0) {
    return pass(
      'INFO\n\nNo non-goals captured for this plan. ' +
        '(No LLM configured, so `non-goals-violated` cannot run; with non-goals captured, ' +
        'this evaluator would surface them here for human review.)',
      { raw: { count: 0 } }
    );
  }

  // non_goals are structured NonGoal objects — render `.text`
  // (a bare `${ng}` would emit `[object Object]`).
  const list = nonGoals.map((ng) => `- ${ng.text}`).join('\n');
  return pass(
    `INFO\n\nNo LLM configured — drift against captured non-goals cannot be ` +
      `evaluated automatically. Verify by hand against this checkpoint:\n\n` +
      `## non-goals\n${list}`,
    { raw: { count: nonGoals.length, non_goals: nonGoals } }
  );
}

runIfDispatched(check);
