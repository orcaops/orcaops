import type { ProjectKnowledgeInterpretation } from '@orcaops/storage/history/database';

export function interpretationLines(held: ProjectKnowledgeInterpretation, indent = ''): string[] {
  const record = held.interpretation;
  const scope =
    record.intended_scope.kind === 'artifact'
      ? `artifact ${record.intended_scope.artifact_id}`
      : record.intended_scope.kind;
  const target = record.canonical_outcome.target;
  const lines = [
    `${indent}- ${record.interpretation_id}: detector interpretation — unapproved`,
    `${indent}  Interpreted wording: ${JSON.stringify(record.wording)}`,
    `${indent}  Intended scope: ${scope}; source form: ${record.source_form}. This grants no authority.`,
    `${indent}  Origin: ${record.source_origin.source_id}` +
      (record.source_origin.task === null
        ? ''
        : `, task ${record.source_origin.task.artifact_id}, plan ${record.source_origin.task.plan_event_id}`),
  ];
  if (target !== null)
    lines.push(
      `${indent}  ${record.canonical_outcome.kind}: ${target.kind}:${target.entity_id}@${target.revision_id}` +
        (held.equivalenceStatus === null
          ? ''
          : ` (${held.equivalenceStatus}; not an approved merge)`)
    );
  if (held.rejection !== null)
    lines.push(
      `${indent}  Match rejected: ${held.rejection.reason === null ? 'no reason supplied' : JSON.stringify(held.rejection.reason)}`
    );
  if (
    record.proposed_record === 'decision' ||
    record.source_form === 'stated_decision' ||
    record.rationale.kind === 'stated'
  )
    lines.push(
      `${indent}  Rationale: ${record.rationale.kind === 'unknown' ? 'reason unknown' : JSON.stringify(record.rationale.wording)}`
    );
  for (const evidence of record.evidence)
    lines.push(
      `${indent}  Quoted evidence: ${JSON.stringify(evidence.quote)} — ${evidence.source_id}, segment ${evidence.segment_id}, prepared bytes ${evidence.prepared_start_utf8}:${evidence.prepared_end_utf8}`
    );
  for (const uncertainty of record.uncertainties)
    lines.push(`${indent}  Uncertain ${uncertainty.about}: ${JSON.stringify(uncertainty.note)}`);
  return lines;
}
