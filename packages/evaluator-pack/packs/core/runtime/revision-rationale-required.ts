#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelope {
  const minLength =
    typeof ctx.params.min_length === 'number' && ctx.params.min_length > 0
      ? ctx.params.min_length
      : 16;

  if (ctx.plan.revision_n === 0) {
    return pass(
      'PASS\n\nInitial plan capture has no rationale; this evaluator only fires on revisions.',
      { raw: { revision_n: 0 } }
    );
  }

  const rationale = ctx.plan.rationale ?? '';
  const trimmed = rationale.trim();
  if (trimmed.length === 0) {
    return violation(
      `VIOLATION\n\nPlan revision_n=${ctx.plan.revision_n} has no rationale. Every revision ` +
        `must state why the plan changed (audit record reviewers read).`,
      { raw: { revision_n: ctx.plan.revision_n, rationale_length: 0 } }
    );
  }
  if (trimmed.length < minLength) {
    return violation(
      `VIOLATION\n\nPlan revision_n=${ctx.plan.revision_n} rationale is ${trimmed.length} chars ` +
        `(< min_length=${minLength}). Expand the rationale: explain what scope shifted and why.`,
      {
        raw: {
          revision_n: ctx.plan.revision_n,
          rationale_length: trimmed.length,
          min_length: minLength,
        },
      }
    );
  }

  return pass(`PASS\n\nRationale present (${trimmed.length} chars).`, {
    raw: { revision_n: ctx.plan.revision_n, rationale_length: trimmed.length },
  });
}

runIfDispatched(check);
