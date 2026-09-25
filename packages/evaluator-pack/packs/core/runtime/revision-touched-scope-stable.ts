#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelopeV2 } from '@orcaops/evaluator-protocol';
import { finding, findingKey, pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelopeV2 {
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

  const priorSet = new Set(ctx.prior_plan.touched_scope);
  const currentSet = new Set(ctx.plan.touched_scope);
  const added = [...currentSet].filter((s) => !priorSet.has(s));
  const removed = [...priorSet].filter((s) => !currentSet.has(s));

  if (added.length === 0) {
    return pass(
      removed.length > 0
        ? `PASS\n\nRevision narrowed touched_scope by ${removed.length} tag(s); no additions.`
        : 'PASS\n\ntouched_scope unchanged across revision.',
      { raw: { revision_n: ctx.plan.revision_n, added: [], removed } }
    );
  }

  const list = added.map((s) => `\`${s}\``).join(', ');
  return violation(
    `VIOLATION\n\nRevision n=${ctx.plan.revision_n} added ${added.length} touched_scope ` +
      `tag(s): ${list}. Sensitive-scope additions trigger evaluator gates the prior plan didn't ` +
      `see; reviewers should re-look at the new scopes.`,
    {
      raw: { revision_n: ctx.plan.revision_n, added, removed },
      // One finding per added tag, keyed on the tag: the same tag added again
      // in a later revision of this artifact is the same statement. A tag that
      // cannot spell a key (a space, an accent) simply has none.
      findings: added.map((scope) =>
        finding({
          key: findingKey('scope', scope),
          title: `Revision n=${ctx.plan.revision_n} added the touched_scope tag "${scope}"`,
          detail:
            'The prior plan did not declare it, so any evaluator gated on that scope is new to this revision.',
        })
      ),
    }
  );
}

runIfDispatched(check);
