#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelopeV2 } from '@orcaops/evaluator-protocol';
import { finding, pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

const MIN_LABEL_LENGTH = 6;

const GENERIC_LABEL_PHRASES = new Set([
  'fix',
  'fix bug',
  'fix bugs',
  'bug fix',
  'bug fixes',
  'add',
  'add feature',
  'update',
  'updates',
  'change',
  'changes',
  'tweak',
  'tweaks',
  'work',
  'wip',
  'todo',
  'misc',
  'cleanup',
  'clean up',
  'refactor',
  'init',
  'setup',
  'patch',
  'small fix',
  'minor fix',
  'fixes',
]);

function normalize(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** One defect this evaluator can name again on a later run, so `rule` is its key. */
interface LabelDefect {
  rule: 'too-short' | 'too-generic' | 'duplicates-task';
  statement: string;
  reason: string;
}

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelopeV2 {
  const label = ctx.plan.label;
  const normalized = normalize(label);

  const defects: LabelDefect[] = [];

  if (label.length < MIN_LABEL_LENGTH) {
    defects.push({
      rule: 'too-short',
      statement: `Label "${label}" is ${label.length} char(s), under the ${MIN_LABEL_LENGTH}-char minimum`,
      reason: `Use at least ${MIN_LABEL_LENGTH} so the headline survives truncation in lists and digests.`,
    });
  }

  if (GENERIC_LABEL_PHRASES.has(normalized)) {
    defects.push({
      rule: 'too-generic',
      statement: `Label "${label}" is a generic stop-phrase`,
      reason: 'It gives reviewers no information about what this thread actually does.',
    });
  }

  const normalizedTask = normalize(ctx.plan.task);
  if (normalizedTask.length > normalized.length + 8 && normalizedTask.startsWith(normalized)) {
    defects.push({
      rule: 'duplicates-task',
      statement: `Label "${label}" is the leading slice of the longer \`task\``,
      reason:
        'The label should add signal, not repeat the first phrase of the task, so this is not a distinct headline.',
    });
  }

  if (defects.length === 0) {
    return pass(`PASS\n\nLabel "${label}" looks specific enough.`, { raw: { label } });
  }

  return violation(
    `VIOLATION\n\nThe plan-level \`label\` is the headline for the whole capture thread ` +
      `(shown in lists, digests, and PR titles). Address each finding by re-running ` +
      `\`orcaops capture plan\` (initial) or \`orcaops capture plan revise\` with a ` +
      `sharper label.\n\n## findings\n\n` +
      defects
        .map((d) => `- **${d.rule.replace(/-/g, ' ')}:** ${d.statement}. ${d.reason}`)
        .join('\n'),
    {
      raw: { label, task: ctx.plan.task, findings_count: defects.length },
      // One finding per rule that fired, keyed on the rule: a later run on the
      // same artifact reporting `label/too-generic` is the same statement
      // about the same label. There is no location — the label is a plan
      // field, and no location kind points at one.
      findings: defects.map((d) =>
        finding({ key: `label/${d.rule}`, title: d.statement, detail: d.reason })
      ),
    }
  );
}

runIfDispatched(check);
