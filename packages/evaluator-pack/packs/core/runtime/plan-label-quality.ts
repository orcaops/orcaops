#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

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

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelope {
  const label = ctx.plan.label;
  const normalized = normalize(label);

  const findings: string[] = [];

  if (label.length < MIN_LABEL_LENGTH) {
    findings.push(
      `**too short:** "${label}" is ${label.length} char(s); use at least ${MIN_LABEL_LENGTH} ` +
        `so the headline survives truncation in lists and digests.`
    );
  }

  if (GENERIC_LABEL_PHRASES.has(normalized)) {
    findings.push(
      `**too generic:** "${label}" is a stop-phrase that gives reviewers no information ` +
        `about what this thread actually does.`
    );
  }

  const normalizedTask = normalize(ctx.plan.task);
  if (normalizedTask.length > normalized.length + 8 && normalizedTask.startsWith(normalized)) {
    findings.push(
      `**duplicates task:** "${label}" is the leading slice of the longer \`task\` rather ` +
        `than a distinct headline — the label should add signal, not repeat the first ` +
        `phrase of the task.`
    );
  }

  if (findings.length === 0) {
    return pass(`PASS\n\nLabel "${label}" looks specific enough.`, { raw: { label } });
  }

  return violation(
    `VIOLATION\n\nThe plan-level \`label\` is the headline for the whole capture thread ` +
      `(shown in lists, digests, and PR titles). Address each finding by re-running ` +
      `\`orcaops capture plan\` (initial) or \`orcaops capture plan revise\` with a ` +
      `sharper label.\n\n## findings\n\n` +
      findings.map((f) => `- ${f}`).join('\n'),
    { raw: { label, task: ctx.plan.task, findings_count: findings.length } }
  );
}

runIfDispatched(check);
