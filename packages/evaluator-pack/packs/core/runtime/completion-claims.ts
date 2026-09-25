#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelopeV2 } from '@orcaops/evaluator-protocol';
import {
  finding,
  findingKey,
  pass,
  planStepLocation,
  runIfDispatched,
  violation,
} from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelopeV2 {
  const cp =
    ctx.current_checkpoint !== null && ctx.current_checkpoint.status === 'closed'
      ? ctx.current_checkpoint
      : null;
  if (!cp) {
    return pass(
      'PASS\n\nNo current closed checkpoint in scope (this checker only fires post-close).',
      { raw: { reason: 'no-current-checkpoint' } }
    );
  }

  if (cp.completed_step_ids.length > 0) {
    return pass(`PASS\n\nCheckpoint claims step_id(s): ${cp.completed_step_ids.join(', ')}.`, {
      raw: { claimed: cp.completed_step_ids },
    });
  }

  const haystack =
    `${cp.summary} ${cp.done_criteria.map((d) => d.evidence).join(' ')}`.toLowerCase();
  const candidates: Array<{ n: number; step_id: string; text: string; ratio: number }> = [];
  for (const [idx, step] of ctx.plan.plan_steps.entries()) {
    const tokens = tokenize(step.text);
    if (tokens.length === 0) continue;
    const matched = tokens.filter((t) => haystack.includes(t)).length;
    const ratio = matched / tokens.length;
    if (ratio >= 0.6) {
      candidates.push({ n: idx + 1, step_id: step.step_id, text: step.text, ratio });
    }
  }

  if (candidates.length === 0) {
    return pass(
      "PASS\n\nCheckpoint declares no completed steps and no plan step appears to match this checkpoint's content.",
      { raw: { claimed: [], plausibleSteps: [] } }
    );
  }

  const ranked = candidates.sort((a, b) => b.ratio - a.ratio);
  const list = ranked
    .map(
      (c) =>
        `- step ${c.n} (id ${c.step_id}): "${c.text}" (${Math.round(c.ratio * 100)}% token overlap)`
    )
    .join('\n');
  return violation(
    `VIOLATION\n\nThis checkpoint's content overlaps ${candidates.length} plan step(s) ` +
      `but \`completed_step_ids\` is empty. Did you forget to declare completion? ` +
      `Re-capture this checkpoint with the relevant step_ids, or claim ` +
      `\`acknowledge_breaking_change\` if the overlap is coincidental.\n\n` +
      `## findings\n${list}`,
    {
      raw: { claimed: [], plausibleSteps: candidates },
      // One finding per overlapping step, keyed on the step id so a rerun
      // against the same checkpoint names the same steps. The overlap ratio
      // stays in `raw`, where the spec's own output_schema validates it: it is
      // this evaluator's own measure, not a protocol-defined one. No
      // `conclusion` — the overlap says the step went unclaimed, not that the
      // step was or was not delivered.
      findings: ranked.map((c) =>
        finding({
          key: findingKey('step', c.step_id),
          title: `Checkpoint content overlaps plan step ${c.n} but does not claim it`,
          detail: `"${c.text}" (${Math.round(c.ratio * 100)}% token overlap with this checkpoint's summary and evidence)`,
          locations: [planStepLocation(c.step_id)],
        })
      ),
    }
  );
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

runIfDispatched(check);
