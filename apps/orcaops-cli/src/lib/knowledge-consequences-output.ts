import type {
  AffectedConsequence,
  ConsequenceAnswer,
  ConsequenceChange,
  ConsequenceItem,
  ConsequenceLimit,
  ConsequenceStep,
} from '@orcaops/core';

import type { KnowledgeConsequencesReport } from '../commands/knowledge/consequences.js';

/**
 * A consequence answer as a person reads it: one group per affected item, each with the reason it
 * was reached, who owns it where the record names somebody, and the full path from the change
 * indented under it with every link marked explicit or inferred. The limits and the coverage come
 * last, so an empty answer is never read as "nothing is affected".
 */
const describeItem = (item: ConsequenceItem): string => {
  switch (item.kind) {
    case 'identity':
      return (
        `${item.target.kind} ${item.target.entity_id}` +
        (item.revision_id === null ? '' : ` revision ${item.revision_id}`)
      );
    case 'plan_event':
      return `plan event ${item.plan_event_id} of artifact ${item.artifact_id}`;
    case 'artifact':
      return `artifact ${item.artifact_id}`;
    case 'assessment':
      return `assessment ${item.assessment_id}`;
    case 'code_path':
      return `code ${item.path}`;
  }
};

const describeChange = (change: ConsequenceChange): string => {
  if (change.kind === 'implementation')
    return `the code ${change.paths.map((path) => `\`${path}\``).join(', ')}`;
  const where =
    `${change.identity.kind} ${change.identity.entity_id}` +
    (change.revision_id === null ? ' (no revision named)' : ` revision ${change.revision_id}`);
  return change.kind === 'assumption'
    ? `${where}, whose recorded assumption "${change.named}" changed`
    : `${where} (${change.moved})`;
};

const describeStep = (step: ConsequenceStep, position: number): string[] => [
  `        ${position}. → ${describeItem(step.to)} [${step.relation}, ${step.basis}` +
    `${step.standing === null ? '' : `, ${step.standing}`}]`,
  `           ${step.reason}`,
];

function describeAffected(entry: AffectedConsequence, position: number): string[] {
  const lines = [
    `  ${position}. ${entry.key} — ${entry.basis}, ${entry.depth} link(s) from the change`,
    `     ${describeItem(entry.item)}`,
    `     Why: ${entry.reason}`,
  ];
  if (entry.owner !== null)
    lines.push(`     Owner: ${entry.owner.name} (${entry.owner.basis}) — ${entry.owner.from}`);
  if (!entry.read_at_boundary)
    lines.push('     This read holds no record of it at the boundary, so nothing says what it is.');
  entry.paths.forEach((path, index) => {
    lines.push(
      `     Path ${index + 1} (${path.every((step) => step.basis === 'explicit') ? 'explicit throughout' : 'has inferred link(s)'}):`
    );
    path.forEach((step, at) => lines.push(...describeStep(step, at + 1)));
  });
  if (entry.paths_omitted > 0)
    lines.push(`     ${entry.paths_omitted} further path(s) to it were not kept.`);
  return lines;
}

function describeAnswer(answer: ConsequenceAnswer, position: number): string[] {
  const lines = [`Change ${position}: ${describeChange(answer.change)}`];
  lines.push(
    answer.affected.length === 0
      ? '  Affected (0): this history records nothing else reached from the change.'
      : `  Affected (${answer.affected.length})`
  );
  for (const [index, entry] of answer.affected.entries())
    lines.push(...describeAffected(entry, index + 1));
  lines.push(...describeLimits(answer.limits, '  '));
  lines.push(`  Coverage: ${answer.coverage.statement}`);
  return lines;
}

function describeLimits(limits: readonly ConsequenceLimit[], indent: string): string[] {
  if (limits.length === 0) return [`${indent}Limits: none this read could name.`];
  return [
    `${indent}Limits (${limits.length})`,
    ...limits.map((limit) => `${indent}  - ${limit.kind}: ${limit.detail}`),
  ];
}

export function formatKnowledgeConsequences(report: KnowledgeConsequencesReport): string {
  const { basis } = report;
  const scope =
    basis.scope.kind === 'project'
      ? `project ${basis.scope.project_id}`
      : `artifact ${basis.scope.artifact_id}`;
  const lines = [
    `Consequences read at write sequence ${basis.knowledge_boundary} (${basis.mode}), ${scope}.`,
    `Bounds: at most ${basis.bounds.maxDepth} link(s) from the change, ` +
      `${basis.bounds.maxItems} item(s), ${basis.bounds.maxPathsPerItem} path(s) per item.`,
    '',
  ];
  if (report.answers.length === 0)
    lines.push('No change was traversed: nothing this read found moved.');
  for (const [index, answer] of report.answers.entries()) {
    lines.push(...describeAnswer(answer, index + 1), '');
  }
  lines.push(...describeLimits(report.limits, ''));
  const processing = report.coverage.processing;
  lines.push(
    processing === null
      ? 'Processing coverage: the processing state was not read, so this answer claims no completeness.'
      : `Processing coverage: ${processing.claim.replaceAll('_', ' ')}. ${processing.statement}`
  );
  return `${lines.join('\n')}\n`;
}
