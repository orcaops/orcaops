import { stringifyTerminalSafeJson } from '@orcaops/evaluator-protocol/terminal';
import { ProjectDatabaseError, type readProjectRationale } from '@orcaops/storage/history/database';

import type { CanonicalWhyOptions } from './history-provenance.js';
import {
  inspectionBytes as bytes,
  inspectionArgument,
  measureResponse,
} from './inspection-output.js';
import { PROVENANCE_EXPLANATION_BYTES } from './provenance-explanation-groups.js';
import {
  conciseExplanation,
  type Explanation,
  explanationChangeSupport,
  explanationConnection,
  explanationEvolution,
  type FocusedKnowledge,
  provenanceExplanations,
} from './provenance-explanations.js';
import type { projectProvenanceJson } from './provenance-json.js';
import {
  type ExplanationOutput,
  isCompleteExplanation,
  omittedExplanation,
} from './provenance-omissions.js';
import {
  previewText,
  rationaleIssueSummary,
  summarizeProvenanceIssues,
  conciseText as textPreview,
} from './provenance-output.js';
import {
  EXPLANATION_TARGET_BYTES,
  isPrimaryExplanation,
  ORDINARY_EXPLANATION_BYTES,
  ORDINARY_EXPLANATION_COUNT,
} from './provenance-selection.js';
import { verificationSummary } from './provenance-verification.js';

type Reading = ReturnType<typeof readProjectRationale>['value'];
type Projection = ReturnType<typeof projectProvenanceJson>;
export const PROVENANCE_RESPONSE_BYTES = {
  compact: 16_384,
  rationale: 32_768,
  details: 65_536,
} as const;
export { PROVENANCE_EXPLANATION_BYTES } from './provenance-explanation-groups.js';

export function rationaleProvenanceJson(
  base: Projection,
  reading: Reading,
  options: CanonicalWhyOptions,
  tasks: ReadonlyMap<string, string | null> = new Map(),
  inspection?: { anchor: string }
) {
  const representation = options.details
    ? 'details'
    : options.view === 'rationale'
      ? 'rationale'
      : 'compact';
  const allowance = PROVENANCE_RESPONSE_BYTES[representation];
  const explanations = provenanceExplanations(reading, base.target.file);
  const rationaleItems = explanations.items
    .filter((item) => !item.verification && !item.planned_verification)
    .map((item) => (options.details ? item : conciseExplanation(item)));
  const candidateCaveats =
    options.details || base.results.length < 2
      ? []
      : base.results[0]!.reasons.filter((reason) =>
          base.results.every((row) => row.reasons.includes(reason))
        );
  const issueSummary = options.details ? summarizeProvenanceIssues : rationaleIssueSummary;
  const summary = (row: Projection['results'][number]) => ({
    id: `${row.artifact_id}:${row.source_event_id}`,
    artifact_id: row.artifact_id,
    source_event_id: row.source_event_id,
    label: row.label ? textPreview(row.label) : null,
    kind: row.kind,
    checkpoint: row.checkpoint?.n ?? null,
    recorded_at: row.recorded_at,
    confidence: row.confidence,
    relationship: row.relationship,
    reachability: row.reachability,
    origin: row.origin,
    reasons: row.reasons
      .filter((reason) => !candidateCaveats.includes(reason))
      .map((reason) => textPreview(reason)),
    evidence: {
      plan: row.plan_support.state,
      fingerprint: row.fingerprint.state,
      provisional: row.provisional,
    },
    historical_task:
      representation !== 'rationale'
        ? tasks.get(`${row.artifact_id}:${row.source_event_id}`)
          ? textPreview(tasks.get(`${row.artifact_id}:${row.source_event_id}`)!)
          : null
        : undefined,
  });
  const knowledge = {
    obligations: [] as FocusedKnowledge[],
    rationale: [] as ExplanationOutput[],
    evolution: [] as ReturnType<typeof explanationEvolution>,
    verification: null as ReturnType<typeof verificationSummary> | null,
  };
  const output = {
    ceiling_bytes: allowance,
    bytes: allowance,
    omitted_rationale: rationaleItems.length,
    omitted_knowledge: reading.context.entries.length,
    omitted_provenance: 0,
    rationale_withheld: null as string | null,
    inspect: [] as Array<{
      reference: string;
      kind: string;
      wording: ReturnType<typeof textPreview> | null;
      reason: 'output_budget' | 'selection_target';
      qualification_recovery: 'use_context';
    }>,
    omitted_audit: 0,
    omitted_verification: explanations.items.filter((item) => item.verification).length,
    omitted_planned_verification: explanations.items.filter((item) => item.planned_verification)
      .length,
    target_exception: undefined as 'required_metadata_or_qualifications' | undefined,
    selection: {
      target_bytes: options.details ? null : Math.min(allowance, EXPLANATION_TARGET_BYTES),
      stopped: 'exhausted' as 'exhausted' | 'selection_target' | 'output_budget',
      grouped_interpretations: options.details ? explanations.groupedInterpretations : undefined,
      excluded_lexical: options.details ? explanations.excludedLexical : undefined,
      omitted_supplemental: 0,
      omitted_changes: 0,
      omitted_oversized: 0,
      omitted_placeholders: 0,
    },
  };
  const {
    inventory_token: _inventory,
    generation_token: _generation,
    seed_witness_token: _seed,
    ...coverage
  } = base.project_coverage;
  const result = {
    schema_version: 8 as const,
    representation,
    context: {
      scope: base.knowledge.basis.scope,
      project_id: base.scope.authorities[0]?.project_id,
      mode: base.knowledge.basis.mode,
      historical_boundary: reading.boundary,
      observation_ceiling: reading.observation,
    },
    code_revision: base.code_revision,
    target: {
      file: base.target.file,
      line: base.target.line,
      selection: base.target.selection,
      state: base.target.state,
      dirty: base.target.dirty,
      requested_ref: base.target.requested_ref,
      blame: base.target.blame,
      issues: base.target.issues,
    },
    conclusion: base.conclusion,
    best: base.best ? `${base.best.artifact_id}:${base.best.source_event_id}` : null,
    ...(base.best &&
    !base.results.some(
      (row) =>
        row.artifact_id === base.best!.artifact_id &&
        row.source_event_id === base.best!.source_event_id
    )
      ? { best_candidate: summary(base.best) }
      : {}),
    results: base.results.map(summary),
    ...(candidateCaveats.length ? { candidate_caveats: candidateCaveats.map(textPreview) } : {}),
    ...(inspection ? { inspection } : {}),
    pagination: { ...base.pagination },
    knowledge,
    diagnostics: {
      completeness: {
        complete: base.completeness.complete,
        issues: Array.isArray(base.completeness.issues)
          ? issueSummary(base.completeness.issues)
          : base.completeness.issues,
      },
      project_coverage: {
        ...coverage,
        captured_artifacts: options.details ? coverage.captured_artifacts : undefined,
        imported_artifacts: options.details ? coverage.imported_artifacts : undefined,
        issues: Array.isArray(coverage.issues) ? issueSummary(coverage.issues) : coverage.issues,
      },
      candidate_selection: {
        ...base.candidate_selection,
        indexed: options.details ? base.candidate_selection.indexed : undefined,
        materialized: options.details ? base.candidate_selection.materialized : undefined,
        support_materialized: options.details
          ? base.candidate_selection.support_materialized
          : undefined,
      },
      seed_guidance:
        options.details || base.seed_guidance.state !== 'suppressed'
          ? base.seed_guidance
          : undefined,
      integrity: base.integrity,
      retrieval: {
        candidate_artifacts: options.details ? reading.diagnostics.candidate_artifacts : undefined,
        omitted_candidate_artifacts: reading.diagnostics.omitted_candidate_artifacts,
        omitted_direct_events: reading.diagnostics.omitted_direct_events,
        unavailable_events: reading.diagnostics.unavailable_events,
        discovery: {
          status: reading.diagnostics.discovery.status,
          matched_accounts: options.details
            ? reading.diagnostics.discovery.matched_accounts
            : undefined,
          omitted_accounts: reading.diagnostics.discovery.omitted_accounts,
          rejected_accounts: options.details
            ? reading.diagnostics.discovery.rejected_accounts
            : undefined,
          truncated_qualification_previews:
            reading.diagnostics.discovery.truncated_qualification_previews,
          limited: !!(
            reading.diagnostics.discovery.saturated_terms ||
            reading.diagnostics.discovery.omitted_terms
          ),
        },
        limits: reading.diagnostics.limits,
      },
      knowledge_limits: explanations.answer.limits,
      later_annotations: explanations.answer.later_annotations,
      processing: base.knowledge.coverage,
      uncertainty: [
        ...base.uncertainty,
        'Checkpoint or vocabulary matches do not establish decision-level file or symbol attribution.',
        'Recorded accounts and unapproved interpretations are not automatically current requirements.',
        'Search limits and vocabulary differences can hide later changes; no match does not prove completeness.',
      ],
    },
    output,
    follow_up: [
      ...(base.conclusion === 'none'
        ? ['Confirm the target path and coverage before requesting more evidence.']
        : []),
      ...(representation === 'compact' && rationaleItems.length
        ? [
            'If more explanation is needed: orcaops why <target> --json --view rationale --limit 5 (same bounded retrieval).',
          ]
        : []),
      ...(rationaleItems.length || explanations.obligations.length
        ? [
            'Inspect a needed account with current status: orcaops knowledge show <reference> --json; add --context for full qualifications. Select --project and --scope explicitly when needed. This is not historical replay.',
          ]
        : []),
      ...(base.results.length
        ? [
            options.details
              ? 'Only if anchored audit evidence lacks the needed broader chronology: orcaops show <artifact_id> --project <project_id> --json (includes later revisions).'
              : 'For a missing checkpoint body, changed files, or head SHA: repeat the same target and scope with --details --candidate <results[].id> --anchor <inspection.anchor> --json. Candidate pagination does not select detailed bodies.',
          ]
        : []),
      'Preserve query scope when expanding. Candidate --limit/--offset/--all do not continue rationale search.',
      ...(base.seed_guidance.command ? [base.seed_guidance.command] : []),
    ],
    ...(options.details
      ? {
          audit: {
            target_content_hash: base.target.content_hash,
            candidates: [] as Array<Projection['results'][number]>,
            knowledge: [] as Reading['records'],
            source_versions: [] as Array<{ artifact_id: string; version_token: string }>,
            retrieval: reading.diagnostics,
            diagnostics: { completeness: [] as unknown[], project_coverage: [] as unknown[] },
          },
        }
      : {}),
  };
  const update = () => {
    const complete = knowledge.rationale.filter(isCompleteExplanation);
    knowledge.evolution = explanationEvolution(
      reading,
      complete,
      knowledge.obligations,
      !!options.details
    );
    const keys = new Set([
      ...knowledge.obligations.map((entry) => entry.id),
      ...complete.flatMap((item) => item.context.map((entry) => entry.id)),
    ]);
    output.omitted_rationale = rationaleItems.length - complete.length;
    output.omitted_knowledge = reading.context.entries.length - keys.size;
  };
  const inspect = (
    reference: string | null,
    kind: string,
    wording?: string | null,
    reason: 'output_budget' | 'selection_target' = 'output_budget'
  ) => {
    if (
      !reference ||
      output.inspect.length >= 4 ||
      output.inspect.some((item) => item.reference === reference)
    )
      return;
    output.inspect.push({
      reference,
      kind,
      wording: wording ? textPreview(wording) : null,
      reason,
      qualification_recovery: 'use_context',
    });
    if (
      bytes(result) >
      (options.details ? allowance : Math.min(allowance, EXPLANATION_TARGET_BYTES)) - 256
    )
      output.inspect.pop();
  };
  const inspectUnit = (
    item: Explanation,
    reason: 'output_budget' | 'selection_target' = 'output_budget'
  ) => {
    for (const entry of item.context)
      for (const correction of entry.corrections ?? [])
        inspect(correction.reference, 'correction', correction.wording);
    inspect(item.reference, item.kind, item.account?.wording, reason);
    for (const entry of item.context)
      inspect(
        entry.reference,
        'qualification',
        entry.accounts.length === 1 ? entry.accounts[0]?.statement : null
      );
  };
  if (bytes(result) > allowance)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Required candidate summaries and warnings exceed the response allowance. Reduce --limit or request --view rationale.'
    );
  // Counts and stopping diagnostics can grow after the last selected unit.
  const explanationsAllowance =
    (options.details ? PROVENANCE_RESPONSE_BYTES.rationale : allowance) - 256;
  let missingObligations = reading.context.omissions.some(
    (limit) => limit.kind === 'identity_count' || limit.kind === 'statement_bytes'
  );
  for (const entry of explanations.obligations) {
    knowledge.obligations.push(entry);
    update();
    if (bytes(result) > explanationsAllowance) {
      knowledge.obligations.pop();
      missingObligations = true;
      update();
      inspect(
        entry.reference,
        'obligation',
        entry.accounts.length === 1 ? entry.accounts[0]?.statement : null
      );
    }
  }
  if (missingObligations) {
    output.rationale_withheld =
      'Applicable obligations could not all fit or could not all be examined. Background explanations are withheld; inspect the returned references or use knowledge lookup --adopted.';
    while ((bytes(result) > allowance || !output.inspect.length) && knowledge.obligations.length) {
      const removed = knowledge.obligations.pop()!;
      update();
      inspect(
        removed.reference,
        'obligation',
        removed.accounts.length === 1 ? removed.accounts[0]?.statement : null
      );
    }
  } else {
    const verification = explanations.items.filter((item) => item.verification);
    const planned = explanations.items.filter((item) => item.planned_verification);
    if (verification.length || planned.length) {
      const summary = verificationSummary(verification, planned);
      const verificationCeiling = Math.min(explanationsAllowance, bytes(result) + 1536);
      knowledge.verification = summary;
      while (bytes(result) > verificationCeiling && summary.references.length) {
        summary.references.pop();
        summary.omitted_references++;
      }
      while (bytes(result) > verificationCeiling && summary.planned?.references.length) {
        summary.planned.references.pop();
        summary.planned.omitted_references++;
      }
      while (bytes(result) > verificationCeiling && summary.groups.length) {
        summary.omitted_status_records += summary.groups.pop()!.reported_records;
      }
      if (bytes(result) > verificationCeiling) knowledge.verification = null;
      else {
        output.omitted_verification = 0;
        output.omitted_planned_verification = 0;
      }
    }
    const oversized = new Set(
      rationaleItems.filter((item) => bytes(item) > PROVENANCE_EXPLANATION_BYTES)
    );
    output.selection.omitted_oversized = oversized.size;
    output.selection.omitted_placeholders = oversized.size;
    const placeholderCeiling = Math.min(explanationsAllowance, bytes(result) + 2048);
    let placeholders = 0;
    for (const item of oversized) {
      if (placeholders >= 4) break;
      knowledge.rationale.push(omittedExplanation(item, reading));
      update();
      const materialCorrection = item.context.some(
        (entry) => entry.corrections?.length || entry.omitted_corrections
      );
      if (bytes(result) > (materialCorrection ? explanationsAllowance : placeholderCeiling)) {
        knowledge.rationale.pop();
      } else {
        placeholders++;
        output.selection.omitted_placeholders--;
      }
      update();
    }
    const changedKeys = new Set(
      reading.records
        .filter(
          (record) =>
            record.corrections.length ||
            record.relationships.some(
              (relation) => relation.relation === 'supersedes' || relation.relation === 'challenges'
            )
        )
        .map((record) => record.key)
    );
    const primary = rationaleItems.filter((item) => isPrimaryExplanation(item, base.target.file));
    const supported = primary.filter((item) => isPrimaryExplanation(item, base.target.file, false));
    const core = supported.length ? supported : primary;
    const changes = rationaleItems.filter(
      (item) =>
        (item.kind === 'decision' &&
          explanationChangeSupport(
            item,
            core
              .filter((seed) => seed.id !== item.id)
              .map((seed) =>
                [
                  seed.account?.wording,
                  seed.account?.reason,
                  ...(seed.account?.alternatives?.flatMap((alternative) => [
                    alternative.option,
                    alternative.rejected_because,
                  ]) ?? []),
                ].join(' ')
              )
          )) ||
        item.context.some((entry) => changedKeys.has(entry.id))
    );
    let supplemental = 0;
    let supplementalBytes = 0;
    let ordinary = 0;
    const queue = [...new Set([...core.slice(0, 4), ...changes, ...core, ...rationaleItems])];
    const target = options.details
      ? explanationsAllowance
      : Math.min(explanationsAllowance, EXPLANATION_TARGET_BYTES - 768);
    for (const item of queue) {
      if (knowledge.rationale.includes(item) || oversized.has(item)) continue;
      const protectedChange = changes.includes(item);
      if (
        !options.details &&
        ((!core.includes(item) && !protectedChange) ||
          (!protectedChange &&
            (ordinary >= ORDINARY_EXPLANATION_COUNT ||
              bytes(result) >= ORDINARY_EXPLANATION_BYTES)))
      ) {
        if (output.selection.stopped !== 'output_budget')
          output.selection.stopped = 'selection_target';
        output.selection.omitted_supplemental++;
        if (core.includes(item) || protectedChange) inspectUnit(item, 'selection_target');
        continue;
      }
      const optional = explanationConnection(item) === 3 && !changes.includes(item);
      const size = bytes(item);
      if (optional && (supplemental >= 3 || supplementalBytes + size > 4096)) {
        output.selection.omitted_supplemental++;
        continue;
      }
      knowledge.rationale.push(item);
      update();
      if (bytes(result) > target) {
        knowledge.rationale.pop();
        update();
        inspectUnit(item);
        output.selection.stopped = options.details ? 'output_budget' : 'selection_target';
      } else if (optional) {
        supplemental++;
        supplementalBytes += size;
      }
      if (knowledge.rationale.includes(item) && !protectedChange) ordinary++;
    }
    output.selection.omitted_changes = changes.filter(
      (item) => !knowledge.rationale.includes(item)
    ).length;
    const positions = new Map(rationaleItems.map((item, index) => [item.id, index]));
    knowledge.rationale.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
    update();
  }
  if (result.audit) {
    for (const row of [
      ...base.results,
      ...(result.best_candidate && base.best ? [base.best] : []),
    ]) {
      result.audit.candidates.push(row);
      if (bytes(result) > allowance) {
        result.audit.candidates.pop();
        output.omitted_audit++;
      }
    }
    const selected = new Set([
      ...knowledge.obligations.map((entry) => entry.id),
      ...rationaleItems
        .filter((item) => knowledge.rationale.some((row) => row.id === item.id))
        .flatMap((item) => item.context.map((entry) => entry.id)),
    ]);
    for (const record of reading.records.filter((record) => selected.has(record.key))) {
      result.audit.knowledge.push(record);
      if (bytes(result) > allowance) {
        result.audit.knowledge.pop();
        output.omitted_audit++;
      }
    }
    for (const [name, issues] of [
      ['completeness', base.completeness.issues],
      ['project_coverage', base.project_coverage.issues],
    ] as const) {
      for (const issue of Array.isArray(issues) ? issues : []) {
        result.audit.diagnostics[name].push(issue);
        if (bytes(result) > allowance) {
          result.audit.diagnostics[name].pop();
          output.omitted_audit++;
        }
      }
    }
    for (const version of Array.isArray(base.source_versions) ? base.source_versions : []) {
      result.audit.source_versions.push(version);
      if (bytes(result) > allowance) {
        result.audit.source_versions.pop();
        output.omitted_audit++;
      }
    }
  }
  if (bytes(result) > allowance)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Required provenance warnings exceed the response allowance. Reduce --limit or request --view rationale.'
    );
  const relevance = (value: Explanation['relevance']) => ({
    ...value,
    target: { kind: value.target.kind },
    ...(value.support
      ? { support: { ...value.support, target: { kind: value.support.target.kind } } }
      : {}),
  });
  const projected = options.details
    ? result
    : {
        ...result,
        knowledge: {
          ...knowledge,
          rationale: knowledge.rationale.map((item) =>
            !isCompleteExplanation(item)
              ? { ...item, relevance: relevance(item.relevance) }
              : {
                  ...item,
                  relevance: relevance(item.relevance),
                  interpretations: item.interpretations?.map((variant) => ({
                    ...variant,
                    relevance: variant.relevance ? relevance(variant.relevance) : undefined,
                  })),
                }
          ),
        },
      };
  if (output.selection.target_bytes !== null && bytes(projected) > output.selection.target_bytes)
    output.target_exception = 'required_metadata_or_qualifications';
  return measureResponse(projected);
}

function knowledgeLines(entry: FocusedKnowledge): string[] {
  const lines = [entry.explanation ? `${entry.placement}: ${entry.explanation}` : entry.placement];
  if (entry.qualification)
    lines.push(
      `  ${entry.qualification.standing}; ${entry.qualification.applicability} (wording above)`
    );
  for (const account of entry.accounts) {
    lines.push(
      `  ${account.standing}; ${account.applicability}${account.wording_from ? ' (wording above)' : `: ${account.statement ?? 'Wording unavailable'}`}`
    );
    if (account.reason) lines.push(`    Reason: ${account.reason}`);
  }
  if (entry.conflicts?.length) lines.push('  Conflicting governing revisions remain unresolved.');
  for (const limit of entry.limitations ?? [])
    lines.push(`  ${limit.record} ${limit.record_id}: ${limit.reason}`);
  for (const unresolved of entry.unresolved ?? [])
    lines.push(`  Unresolved: ${JSON.stringify(unresolved)}`);
  for (const correction of entry.corrections ?? [])
    lines.push(
      `  Correction (${correction.status}): ${correction.wording ?? 'Content unavailable; inspect the record.'}`,
      ...(correction.reference ? [`    Inspect correction: ${correction.reference}`] : [])
    );
  return lines;
}

export function formatRationaleWhy(result: ReturnType<typeof rationaleProvenanceJson>): string {
  const lines = [
    `${result.target.file}${result.target.line === null ? '' : `:${result.target.line}`} — ${result.conclusion}`,
    ...result.target.issues,
    ...(result.candidate_caveats ?? []).map(previewText),
  ];
  for (const row of result.results) {
    lines.push(
      `${row.artifact_id}${row.checkpoint ? ` checkpoint ${row.checkpoint}` : ' plan'}: ${row.confidence}; ${row.reachability}${row.label ? ` — ${previewText(row.label)}` : ''}`,
      ...row.reasons.map((reason) => `  ${previewText(reason)}`)
    );
    if (row.origin === 'imported') lines.push('  Origin: imported from git history (synthesized)');
    if (row.historical_task) lines.push(`  Task: ${previewText(row.historical_task)}`);
  }
  if (result.best_candidate) {
    const row = result.best_candidate;
    lines.push(
      `Best match outside this page: ${row.artifact_id}; ${row.checkpoint ? `checkpoint ${row.checkpoint}` : 'plan'}; ${row.confidence}; ${row.reachability}`,
      ...row.reasons.map((reason) => `  ${previewText(reason)}`)
    );
  }
  for (const entry of result.knowledge.obligations) lines.push(...knowledgeLines(entry));
  for (const item of result.knowledge.rationale) {
    if (!isCompleteExplanation(item)) {
      lines.push(
        `${item.kind} omitted_oversized (${item.relevance.basis}; ${item.authority}): ${item.reason}`
      );
      if (item.conflicts) lines.push(`  ${item.conflicts} governing conflicts require inspection.`);
      if (item.unresolved || item.scope_or_coverage_limitations)
        lines.push('  Unresolved or scope/coverage qualifications require inspection.');
      for (const correction of item.corrections ?? [])
        lines.push(
          `  Correction (${correction.status}; ${correction.kind ?? 'kind unavailable'}): content ${correction.unavailable ? 'unavailable' : 'not displayed'}.${correction.reference ? ` Inspect: ${correction.reference}` : ''}`
        );
      for (const relation of item.relationships ?? [])
        lines.push(
          `  ${relation.relation}: ${relation.standing}; applied here: ${relation.applied}${relation.not_applied ? ` (${relation.not_applied})` : ''}`
        );
      for (const relation of item.outside_scope_relationships ?? [])
        lines.push(`  Relationship ${relation.id} has no effect in this scope.`);
      if (item.change_passage)
        lines.push(
          '  Recorded change-related wording is omitted; no replacement is established by that wording.'
        );
      if (
        item.omitted_corrections ||
        item.omitted_relationships ||
        item.omitted_context_references ||
        item.omitted_outside_scope_relationships
      )
        lines.push(
          '  Additional qualification references were omitted; this placeholder is incomplete.'
        );
      lines.push(
        `  Inspect account: orcaops knowledge show ${inspectionArgument(item.reference)} --json`,
        `  Recover qualifying context: orcaops knowledge show ${inspectionArgument(item.reference)} --context --json`,
        ...(item.source_reference ? [`  Inspect source account: ${item.source_reference}`] : []),
        ...(item.context_references ?? []).map(
          (reference) => `  Inspect authority context: ${reference}`
        )
      );
      continue;
    }
    if (item.account) {
      lines.push(`${item.form} (${item.authority}): ${item.account.wording}`);
      if (item.account.reason) lines.push(`  Reason: ${item.account.reason}`);
      for (const alternative of item.account.alternatives ?? [])
        lines.push(
          `  Rejected: ${alternative.option} — ${alternative.rejected_because ?? 'Reason unknown'}`
        );
    }
    if (item.source_account) {
      lines.push(`  Recorded source: ${item.source_account.wording}`);
      if (item.source_account.reason) lines.push(`    Reason: ${item.source_account.reason}`);
      for (const alternative of item.source_account.alternatives ?? [])
        lines.push(
          `    Rejected: ${alternative.option} — ${alternative.rejected_because ?? 'Reason unknown'}`
        );
    }
    for (const entry of item.context) lines.push(...knowledgeLines(entry));
    for (const interpretation of item.interpretations ?? []) {
      lines.push(
        `  Interpretation (${interpretation.authority}): ${interpretation.account?.wording ?? 'Same account as recorded above.'}`
      );
      if (interpretation.account?.reason)
        lines.push(`    Reason: ${interpretation.account.reason}`);
      for (const alternative of interpretation.account?.alternatives ?? [])
        lines.push(
          `    Rejected: ${alternative.option} — ${alternative.rejected_because ?? 'Reason unknown'}`
        );
      lines.push(`    Inspect interpretation: ${interpretation.reference}`);
    }
    lines.push(`  Inspect: ${item.reference}`);
  }
  for (const change of result.knowledge.evolution)
    lines.push(
      change.kind === 'relationship'
        ? `${change.relationship}: ${change.standing}; applied here: ${change.applied}${change.not_applied ? ` (${change.not_applied})` : ''}`
        : change.kind === 'outside_scope'
          ? `Relationship ${change.id} has no effect in this scope.`
          : 'A retained passage mentions a possible design change; read its qualifications. No replacement relationship is established by this wording.'
    );
  if (result.knowledge.verification)
    lines.push(
      `${result.knowledge.verification.reported_records} records report successful verification; this is not a test total.`,
      ...result.knowledge.verification.groups.map(
        (group) =>
          `  ${group.reported_records} reported (${group.authority}; evidence: ${group.evidence}); state: ${JSON.stringify(group.state)}`
      ),
      ...(result.knowledge.verification.omitted_status_records
        ? ['  Some verification status details were omitted.']
        : []),
      ...result.knowledge.verification.references.map(
        (reference) => `  Inspect verification: ${reference}`
      )
    );
  if (result.output.omitted_verification)
    lines.push(
      `${result.output.omitted_verification} verification reports omitted from this response.`
    );
  if (result.knowledge.verification?.planned)
    lines.push(
      `${result.knowledge.verification.planned.records} routine checks were planned; this does not report their completion.`,
      ...result.knowledge.verification.planned.references.map(
        (reference) => `  Inspect planned check: ${reference}`
      )
    );
  if (result.output.omitted_planned_verification)
    lines.push(`${result.output.omitted_planned_verification} planned checks omitted.`);
  if (result.output.rationale_withheld) lines.push(result.output.rationale_withheld);
  const diagnostics = result.diagnostics;
  if (diagnostics.retrieval.discovery.status !== 'available')
    lines.push(
      `Later prose discovery is ${diagnostics.retrieval.discovery.status}; lookup data was not repaired by this read.`
    );
  if (diagnostics.retrieval.discovery.limited || diagnostics.retrieval.discovery.omitted_accounts)
    lines.push(
      'Lexical discovery reached a selection limit; related passages may not have been examined.'
    );
  for (const limit of diagnostics.retrieval.limits) lines.push(limit.detail);
  if (diagnostics.retrieval.discovery.truncated_qualification_previews)
    lines.push(
      'Lexical relevance was checked using bounded wording/reason windows; relevant text outside those windows may have been missed.'
    );
  if (result.output.selection.omitted_changes)
    lines.push(
      `${result.output.selection.omitted_changes} retrieved change/correction accounts are not carried; the displayed history may omit a later qualification.`
    );
  if (result.output.selection.omitted_oversized)
    lines.push(
      `${result.output.selection.omitted_oversized} explanation bodies exceeded the per-item allowance. Inspect their placeholders before drawing conclusions from their absence.`
    );
  if (result.output.selection.omitted_placeholders)
    lines.push(
      `${result.output.selection.omitted_placeholders} oversized explanations also lack a placeholder within the display allowance.`
    );
  if (result.output.selection.omitted_supplemental || result.output.selection.excluded_lexical)
    lines.push(
      'Weak lexical context was filtered or limited separately from change/correction selection.'
    );
  for (const item of result.output.inspect)
    lines.push(
      `Omitted ${item.kind}${item.wording ? ` (discovery preview only): ${previewText(item.wording)}` : ''}. Inspect: orcaops knowledge show ${inspectionArgument(item.reference)} --context --json`
    );
  if (result.inspection) lines.push(`Candidate inspection anchor: ${result.inspection.anchor}`);
  lines.push(...diagnostics.uncertainty, diagnostics.processing.statement);
  if (!diagnostics.completeness.complete) lines.push('Provenance evidence is incomplete.');
  if (!diagnostics.candidate_selection.complete)
    lines.push(`${diagnostics.candidate_selection.omitted} candidate artifacts omitted.`);
  if (diagnostics.candidate_selection.support_omitted)
    lines.push(
      `${diagnostics.candidate_selection.support_omitted} overlap support artifacts omitted.`
    );
  if (diagnostics.retrieval.unavailable_events)
    lines.push(
      `${diagnostics.retrieval.unavailable_events} candidate sources were unavailable; historical evolution may be incomplete.`
    );
  const declinedArea = diagnostics.project_coverage.declined_area;
  if (declinedArea !== null)
    lines.push(
      `Git history imports for ${declinedArea} were declined. Allow future suggestions with: orcaops seed status --offer-again '${declinedArea.replaceAll("'", "'\\''")}'`
    );
  lines.push(
    `Omitted from this response: ${result.output.omitted_rationale} rationale items, ${result.output.omitted_knowledge} knowledge entries, ${result.output.omitted_provenance} provenance results.`,
    ...result.follow_up
  );
  if (result.pagination.next_offset !== null)
    lines.push(
      `More evaluated results: repeat with --all --offset ${result.pagination.next_offset} --limit ${result.pagination.limit}`
    );
  const text = lines.join('\n') + '\n';
  return Buffer.byteLength(text) <= result.output.ceiling_bytes
    ? text
    : stringifyTerminalSafeJson({ ok: true, ...result }) + '\n';
}
