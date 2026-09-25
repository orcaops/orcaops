import {
  type ApplicableNotSelected,
  implementationText,
  interpretationLines,
  type KnowledgeContextAnswer,
  type KnowledgeContextEntry,
  type KnowledgeContextEvidence,
  type KnowledgeContextUse,
  type KnowledgeProcessingCoverage,
} from '@orcaops/core';

/**
 * A context answer as a person reads it: the adopted rules that apply here first, each with the
 * one line that says why, then everything that is not a rule this work has to meet. A proposal, a
 * conflict and an unresolved point are named as what they are and never folded into the first
 * list, and the coverage line is last so an empty answer is never read as "there are none".
 */
const quoted = (statement: string | null) => (statement === null ? null : `"${statement}"`);

type ConflictDisposition = NonNullable<
  KnowledgeContextAnswer['conflicts'][number]['conflict']['disposition']
>;

const obligation = (revision: ConflictDisposition['unacknowledged'][number]) =>
  `${revision.kind}:${revision.entity_id}@${revision.revision_id}`;

function describeConflictDisposition(disposition: ConflictDisposition | null): string {
  if (disposition === null) return 'no recorded answer covers this work';
  if (disposition.action === 'ask_once')
    return (
      `action: ask once; obligation: ${disposition.unacknowledged.map(obligation).join(', ')}; ` +
      'rationale: no standing answer or assignment covers it; remedy: decide whether to change the rule ' +
      'or use another implementation that complies. Changing the rule requires recorded authority; ' +
      'record one explicit answer'
    );
  if (disposition.action === 'comply')
    return (
      `action: comply; obligation: ${disposition.declined.map(obligation).join(', ')}; ` +
      'rationale: a standing answer declined the departure; remedy: follow the obligation'
    );
  if (disposition.action === 'rest_on_assignment')
    return (
      `action: rest on assignment ${disposition.assignment_ids.join(', ')}; ` +
      'rationale: it covers the conflicting rule; remedy: cite it only for an act within its exact delegated footprint'
    );
  if (disposition.action === 'reuse_authorization')
    return (
      `action: reuse authorization ${disposition.answer_ids.join(', ')}; ` +
      'rationale: a standing answer covers this work; remedy: cite that exact answer'
    );
  return 'action: proceed; rationale: every conflicting obligation was acknowledged; remedy: none';
}

function describeUse(use: KnowledgeContextUse): string {
  const where = `plan event ${use.plan_event_id} of artifact ${use.artifact_id} (${use.role})`;
  if (use.discovered_at === null) return `      selected with the plan: ${where}`;
  const who = use.discovered_by;
  return (
    `      connected later: ${where}, found by ` +
    `${who?.name ?? 'an unnamed party'} (${who?.kind ?? 'unknown'}; ${who?.basis ?? 'unknown'}) ` +
    `at ${use.discovered_at}`
  );
}

/**
 * The assessments of one identity, under it and apart from its standing.
 *
 * Each is printed with the basis it judged on and what that makes it here. None of them is printed
 * as an outcome of the entry: an assessment's conclusion belongs to the software and revision it
 * names, and a line that read it as this identity's state would be the satisfaction claim against
 * unspecified software the store refuses to write.
 */
function describeEvidence(evidence: KnowledgeContextEvidence): string[] {
  const lines = [`     Assessments (${evidence.assessments.length}): ${evidence.statement}`];
  for (const assessment of evidence.assessments) {
    lines.push(
      `       ${assessment.assessment_id} — ${assessment.relevance.outcome}, concluded ` +
        `${assessment.conclusion} about revision ${assessment.expectation.revision_id}`
    );
    lines.push(
      `         Basis: ${implementationText(assessment.implementation)}; method ` +
        `${assessment.method.name} (configuration ` +
        `${assessment.method.configuration_sha256 ?? 'unrecorded'}); evidence ` +
        `${assessment.evidence.map((held) => `${held.kind}:${held.id} (${held.role})`).join(', ') || 'none'}` +
        `${assessment.exception_ids.length === 0 ? '' : `; exception(s) ${assessment.exception_ids.join(', ')}`}`
    );
    lines.push(
      `         Observed write sequence ${assessment.observed_write_sequence}, intent counter ` +
        `${assessment.observed_intent_counter}; recorded at write sequence ` +
        `${assessment.write_sequence}`
    );
    for (const state of assessment.check_states)
      lines.push(`         Check ${state.check}: ${state.state} — never a conclusion`);
    for (const limit of assessment.coverage_limits) lines.push(`         Limit: ${limit}`);
    lines.push(`         ${assessment.relevance.statement}`);
  }
  for (const standing of evidence.succession)
    lines.push(
      `       ${standing.later_assessment_id} after ${standing.prior_assessment_id}: ` +
        `${standing.effect.replaceAll('_', ' ')}. ${standing.statement}`
    );
  for (const needed of evidence.needed) lines.push(`       Would need: ${needed}`);
  if (evidence.later.length > 0)
    lines.push(`       Assessed after this boundary: ${evidence.later.join(', ')}`);
  return lines;
}

function describeEntry(
  entry: KnowledgeContextEntry,
  position: number,
  askedAboutSoftware: boolean
): string[] {
  const governing = entry.revisions.filter((revision) => revision.standing === 'adopted');
  const shown = governing.length > 0 ? governing : entry.revisions.slice(-1);
  const lines = [`  ${position}. ${entry.key}`];
  for (const revision of shown) {
    const statement = quoted(revision.statement);
    if (statement !== null) lines.push(`     ${statement}`);
    if (revision.rationale !== undefined)
      lines.push(
        `     Rationale: ${revision.rationale === null ? 'reason unknown' : JSON.stringify(revision.rationale)}`
      );
    lines.push(
      `     revision ${revision.revision.revision_id} — ${revision.standing}` +
        `${revision.designation === null ? '' : `, ${revision.designation}`}` +
        `, applicability ${revision.applicability}${revision.is_tip ? ', tip' : ''}`
    );
  }
  lines.push(`     Why: ${entry.reason}`);
  if (entry.criterion !== null)
    lines.push(
      `     Promoted criterion ${entry.criterion.criterionId} of plan event ` +
        `${entry.criterion.planEventId} in artifact ${entry.criterion.artifactId}`
    );
  for (const reference of entry.references)
    lines.push(
      `     Source ${reference.sourceId}` +
        (reference.artifactId === null
          ? ''
          : ` — artifact ${reference.artifactId}, event ${reference.eventId}`)
    );
  // Who may already decide what about this identity, and what that delegates about it. It is never
  // folded into the standing above: an assignment changes nothing that stands.
  if (entry.assignments !== undefined)
    lines.push(
      `     Assignments (${entry.assignments.length})` +
        (entry.assignments.length === 0 ? ': nobody has delegated anything about it.' : '')
    );
  for (const assignment of entry.assignments ?? []) {
    lines.push(
      `       ${assignment.assignment_id} — ${assignment.standing}, responsible ` +
        `${assignment.responsible.identity ?? 'nobody named'} ` +
        `(${assignment.responsible.basis}, claimed and not authenticated)` +
        `${assignment.valid_until === null ? '' : `, until ${assignment.valid_until}`}`
    );
    lines.push(`         "${assignment.objective}"`);
    lines.push(
      `         delegates about this identity: ${assignment.delegates.adopts.length} adoption(s), ` +
        `${assignment.delegates.departs_from.length} departure(s), ` +
        `${assignment.delegates.restates.length} restatement(s)`
    );
    for (const escalate of assignment.escalation_conditions)
      lines.push(`         escalate: ${escalate}`);
    lines.push(`         ${assignment.reason}`);
  }
  if (entry.selected_with_plan.length > 0 || entry.connected_later.length > 0) {
    lines.push(
      `     Task uses: ${entry.selected_with_plan.length} selected with the plan, ` +
        `${entry.connected_later.length} connected later`
    );
    for (const use of entry.selected_with_plan) lines.push(describeUse(use));
    for (const use of entry.connected_later) lines.push(describeUse(use));
  }
  // Silent for an entry nobody assessed on a question that named no software: there the block
  // would say the same nothing under every entry. A question that DID name software gets the
  // "no applicable assessment" answer either way, because that is the answer it asked for.
  if (
    entry.evidence !== undefined &&
    (entry.evidence.assessments.length > 0 || entry.evidence.later.length > 0 || askedAboutSoftware)
  )
    lines.push(...describeEvidence(entry.evidence));
  return lines;
}

function describeGroup(
  title: string,
  entries: readonly KnowledgeContextEntry[],
  empty: string,
  askedAboutSoftware: boolean
): string[] {
  if (entries.length === 0) return [`${title} (0): ${empty}`];
  return [
    `${title} (${entries.length})`,
    ...entries.flatMap((entry, index) => describeEntry(entry, index + 1, askedAboutSoftware)),
  ];
}

function describeNotSelected(missed: ApplicableNotSelected): string[] {
  const lines = [
    missed.entries.length === 0
      ? `Applicable and not selected (0): ${missed.statement}`
      : `Applicable and not selected (${missed.entries.length}): ${missed.statement}`,
  ];
  for (const entry of missed.entries) {
    lines.push(`  - ${entry.key}`);
    if (entry.statement !== null) lines.push(`    "${entry.statement}"`);
    lines.push(`    revision(s) ${entry.revision_ids.join(', ')} — ${entry.reason}`);
    if (entry.selected_revision_ids.length > 0)
      lines.push(`    this plan selected revision(s) ${entry.selected_revision_ids.join(', ')}`);
  }
  return lines;
}

/**
 * Whether consent covers a job admitted now, beside the coverage claim and never in place of it,
 * in the wording `knowledge status` uses. The claim is about what HAS been interpreted; a denied
 * grant is why nothing more will be, and "Coverage: complete" alone reads as a standing promise.
 */
function consentLine(processing: KnowledgeProcessingCoverage | null): string {
  if (processing === null)
    return 'Consent: not read here, because this answer read no processing state.';
  if (processing.consent === null)
    return 'Consent: not evaluated, because no provider and limits could be resolved.';
  return processing.consent.granted
    ? 'Consent: granted.'
    : `Consent: not granted [${processing.consent.reason ?? 'no reason recorded'}]. ` +
        'Nothing further is sent to a provider until a grant covers it.';
}

export function formatKnowledgeContext(
  answer: KnowledgeContextAnswer & { applicable_not_selected?: ApplicableNotSelected }
): string {
  const { basis } = answer;
  const byKey = new Map(answer.entries.map((entry) => [entry.key, entry]));
  const pick = (keys: readonly string[]) =>
    keys.flatMap((key) => {
      const entry = byKey.get(key);
      return entry === undefined ? [] : [entry];
    });
  const scope =
    basis.scope.kind === 'project'
      ? `project ${basis.scope.project_id}`
      : `artifact ${basis.scope.artifact_id}`;
  const asked = basis.software != null;
  const lines = [
    `Knowledge read at write sequence ${basis.knowledge_boundary} (${basis.mode}), ${scope}.`,
    `Software in question: ${basis.software == null ? 'none was named, so no assessment applies' : implementationText(basis.software)}.`,
    '',
    ...describeGroup(
      'Applicable',
      pick(answer.applicable),
      'no adopted rule of this read applies here.',
      asked
    ),
    '',
    ...(answer.applicable_not_selected === undefined
      ? []
      : [...describeNotSelected(answer.applicable_not_selected), '']),
    ...describeGroup('Background', pick(answer.background), 'nothing else was found.', asked),
  ];
  lines.push(
    '',
    answer.proposals.length === 0
      ? 'Proposals (0): nothing is proposed.'
      : `Proposals (${answer.proposals.length})`
  );
  for (const proposal of answer.proposals)
    lines.push(
      `  - ${proposal.key}` +
        `${proposal.revision === null ? '' : ` revision ${proposal.revision.revision_id}`}` +
        `${proposal.correction === null ? '' : ` correction ${proposal.correction.action_id}`}` +
        `: ${proposal.label}`
    );
  const interpretations = answer.interpretations ?? [];
  if (interpretations.length > 0) {
    lines.push('', `Detector interpretations — unapproved (${interpretations.length})`);
    for (const interpretation of interpretations)
      lines.push(...interpretationLines(interpretation, '  '));
  }
  lines.push(
    '',
    answer.conflicts.length === 0
      ? 'Conflicts (0): no two adopted revisions overlap here.'
      : `Conflicts (${answer.conflicts.length})`
  );
  for (const held of answer.conflicts)
    lines.push(
      `  - ${held.key}: ${held.conflict.revisions
        .map((revision) => revision.revision_id)
        .join(' and ')}` + ` (${describeConflictDisposition(held.conflict.disposition)})`
    );
  lines.push(
    '',
    answer.unresolved.length === 0
      ? 'Unresolved (0): nothing was left undecided.'
      : `Unresolved (${answer.unresolved.length})`
  );
  for (const point of answer.unresolved)
    lines.push(`  - ${point.about} ${point.record_ids.join(', ')}: ${point.reason}`);
  if (answer.later_annotations.length > 0) {
    lines.push('', `Recorded after this boundary (${answer.later_annotations.length})`);
    for (const later of answer.later_annotations)
      lines.push(
        `  - ${later.record} ${later.record_id} at write sequence ${later.write_sequence}` +
          `${later.correction === null ? '' : ` (${later.correction.kind})`}` +
          `${later.recorded_at === null ? '' : `, recorded ${later.recorded_at}`}`
      );
  }
  const processing = answer.coverage.processing;
  lines.push(
    '',
    processing === null
      ? 'Coverage: the processing state was not read, so this answer claims no completeness.'
      : `Coverage: ${processing.claim.replaceAll('_', ' ')}. ${processing.statement}`,
    consentLine(processing)
  );
  if (answer.limits.length > 0) {
    lines.push('Limits:');
    for (const limit of answer.limits) lines.push(`  - ${limit.detail}`);
  }
  return `${lines.join('\n')}\n`;
}
