import { createHash } from 'node:crypto';

import {
  type Attribution,
  type AuthorityScope,
  canonicalJson,
  type ClaimRevision,
  ClaimRevisionSchema,
  type CorrectionAction,
  CorrectionActionSchema,
  type DecisionRevision,
  DecisionRevisionSchema,
  type ExpectationRevisionRef,
  type ExpectedState,
  type InterpretationEvidence,
  type InterpretationTarget,
  type KnowledgeInterpretation,
  knowledgeInterpretationId,
  type KnowledgeInterpretationIdentity,
  KnowledgeInterpretationSchema,
  type KnowledgeTarget,
  type PassageRestatement,
  PassageRestatementSchema,
  type RecordRevisionRef,
  type Relationship,
  RelationshipSchema,
  type RequirementIdentity,
  RequirementIdentitySchema,
  type RequirementRevision,
  RequirementRevisionSchema,
  type SourceSelector,
  type TaskUse,
  TaskUseSchema,
} from '@orcaops/storage';

import type { InterpretationManifest, ManifestRevisionEntry } from './manifest.js';
import type { ProposedUncertainty } from './proposal.js';
import type {
  AcceptedLink,
  AcceptedStatement,
  ProposalItem,
  ProposalQualityCounts,
  ValidatedProposal,
} from './validation.js';

export interface ExpectedGoverningState {
  target: KnowledgeTarget;
  knowledge_boundary: number;
  state: ExpectedState;
}

export type PublishableRecord =
  | { kind: 'interpretation'; record: KnowledgeInterpretation; rests_on: readonly [] }
  | {
      kind: 'requirement_revision';
      identity: RequirementIdentity | null;
      record: RequirementRevision;
      rests_on: readonly ExpectedGoverningState[];
    }
  | {
      kind: 'decision_revision';
      record: DecisionRevision;
      rests_on: readonly ExpectedGoverningState[];
    }
  | { kind: 'claim_revision'; record: ClaimRevision; rests_on: readonly ExpectedGoverningState[] }
  | {
      kind: 'passage_restatement';
      record: PassageRestatement;
      rests_on: readonly ExpectedGoverningState[];
    }
  | { kind: 'relationship'; record: Relationship; rests_on: readonly ExpectedGoverningState[] }
  | { kind: 'correction'; record: CorrectionAction; rests_on: readonly ExpectedGoverningState[] }
  | { kind: 'task_use'; record: TaskUse; rests_on: readonly ExpectedGoverningState[] };

export type HoldReason =
  | 'source_form_publishes_no_candidate'
  | 'link_publishes_nothing'
  | 'statement_published_no_candidate'
  | 'no_plan_event_in_manifest'
  | 'intended_scope_not_nameable'
  | 'candidate_already_retained'
  | 'candidate_identity_collision'
  | 'attribution_is_not_a_detector'
  | 'task_use_refused_by_contract'
  | 'refused_by_the_contract';

export interface HeldBack {
  item: ProposalItem;
  reason: HoldReason;
  detail: string;
}

export interface ReconciliationPlan {
  manifest_sha256: string;
  processor_contract: string;
  prompt_version: string;
  proposal_schema_version: string;
  attributed_to: Attribution;
  schedule_id: string;
  unit_id: string;
  source_ids: readonly string[];
  records: readonly PublishableRecord[];
  held_back: readonly HeldBack[];
  uncertainties: readonly ProposedUncertainty[];
  expected_state: readonly ExpectedGoverningState[];
  quality: ProposalQualityCounts;
}

export interface CandidateState {
  target: InterpretationTarget;
  status: 'compatible' | 'collision';
}

export interface CanonicalSourceAlias {
  requestedSourceId: string;
  sourceId: string;
}

export interface ReconciliationInput {
  manifest: InterpretationManifest;
  validated: ValidatedProposal;
  /** A deterministic retained source time, not the processing clock. */
  source_recorded_at: string;
  /** Retained by callers for attempt diagnostics; authored records never use this clock. */
  processed_at?: string;
  source_aliases?: readonly CanonicalSourceAlias[];
  candidate_state?: readonly CandidateState[];
}

interface ContractSchema<T> {
  safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown };
}

interface Publisher {
  keep: <T>(
    schema: ContractSchema<T>,
    record: T,
    item: ProposalItem,
    wrap: (record: T, rests_on: readonly ExpectedGoverningState[]) => PublishableRecord,
    rests_on?: readonly ExpectedGoverningState[],
    refusal_outcome?: 'held_back' | 'accepted',
    refusal_reason?: HoldReason
  ) => boolean;
  hold: (
    item: ProposalItem,
    reason: HoldReason,
    detail: string,
    outcome?: 'held_back' | 'accepted'
  ) => void;
}

const RELATION_WORD: Readonly<Record<AcceptedLink['relation'], string>> = {
  exact_restatement: 'exactly restates',
  equivalent_to: 'may be equivalent to',
  refines: 'refines',
  departs_from: 'departs from',
  supports: 'rests on',
  contradicts: 'contradicts',
  unrelated: 'is unrelated to',
  cannot_tell: 'may or may not bear on',
};

export function buildReconciliationPlan(input: ReconciliationInput): ReconciliationPlan {
  const { manifest, source_recorded_at } = input;
  const validated = canonicalizeValidatedProposalSources(
    input.validated,
    input.source_aliases ?? []
  );
  const attribution = manifest.attributed_to;
  const records: PublishableRecord[] = [];
  const held: HeldBack[] = [];
  const finalHeldItems = new Map<string, ProposalItem>();
  const touched = new Map<string, ManifestRevisionEntry>();
  const suggestedUses = new Set<string>();
  const candidateState = new Map(
    (input.candidate_state ?? []).map((entry) => [targetKey(entry.target), entry.status])
  );

  const publisher: Publisher = {
    keep: (
      schema,
      record,
      item,
      wrap,
      restsOn = [],
      refusalOutcome = 'held_back',
      refusalReason = 'refused_by_the_contract'
    ) => {
      const parsed = schema.safeParse(record);
      if (!parsed.success || parsed.data === undefined) {
        publisher.hold(item, refusalReason, describeRefusal(parsed.error), refusalOutcome);
        return false;
      }
      records.push(wrap(parsed.data, restsOn));
      return true;
    },
    hold: (item, reason, detail, outcome = 'held_back') => {
      held.push({ item, reason, detail });
      if (outcome === 'held_back') finalHeldItems.set(proposalItemKey(item), item);
    },
  };

  const finish = (): ReconciliationPlan => ({
    manifest_sha256: manifest.manifest_sha256,
    processor_contract: manifest.processor_contract,
    prompt_version: manifest.prompt_version,
    proposal_schema_version: manifest.proposal_schema_version,
    attributed_to: attribution,
    schedule_id: manifest.schedule_id,
    unit_id: manifest.unit_id,
    source_ids: canonicalSourceIdsForManifest(manifest, input.source_aliases ?? []),
    records,
    held_back: held,
    uncertainties: validated.uncertainties,
    expected_state: expectedStates(manifest, [...touched.values()]),
    quality: reconciledQuality(validated, [...finalHeldItems.values()]),
  });

  if (attribution.kind !== 'detector') {
    publisher.hold(
      { kind: 'proposal' },
      'attribution_is_not_a_detector',
      'A manifest attributed to an actor publishes nothing.'
    );
    return finish();
  }

  for (const accepted of validated.statements) {
    const item: ProposalItem = { kind: 'statement', index: accepted.index };
    const origin = manifest.sources.find((source) => source.ref === accepted.statement.source_ref);
    if (origin === undefined) {
      publisher.hold(item, 'refused_by_the_contract', 'The validated origin source is missing.');
      holdUnpublishedAlternatives(accepted, publisher, 'The validated origin source is missing.');
      continue;
    }
    const originSourceId = canonicalSourceId(origin.source_id, input.source_aliases ?? []);

    const candidateTarget = candidateTargetForStatement({
      manifest,
      accepted,
      source_aliases: input.source_aliases,
    });
    const retainedState =
      candidateTarget === null ? undefined : candidateState.get(targetKey(candidateTarget));
    const collision = retainedState === 'collision';
    const outcome = interpretationOutcome(accepted, collision ? null : candidateTarget);
    const interpretation = makeInterpretation({
      manifest,
      accepted,
      sourceId: originSourceId,
      source_recorded_at,
      outcome,
    });
    const keptInterpretation = publisher.keep(
      KnowledgeInterpretationSchema,
      interpretation,
      item,
      (record) => ({ kind: 'interpretation', record, rests_on: [] })
    );
    if (!keptInterpretation) {
      holdUnpublishedLinks(accepted, publisher, 'The statement interpretation was refused.');
      holdUnpublishedAlternatives(accepted, publisher, 'The statement interpretation was refused.');
      continue;
    }

    if (accepted.statement.proposed_record === 'none') {
      publisher.hold(
        item,
        'source_form_publishes_no_candidate',
        'The source statement is retained as an interpretation without a canonical candidate.'
      );
      holdUnpublishedLinks(accepted, publisher, 'The statement publishes no canonical candidate.');
      continue;
    }
    if (collision) {
      publisher.hold(
        item,
        'candidate_identity_collision',
        `The deterministic candidate ${candidateTarget?.revision_id ?? '<unknown>'} is retained with incompatible semantics.`
      );
      holdUnpublishedLinks(accepted, publisher, 'The candidate identity collided.');
      holdUnpublishedAlternatives(accepted, publisher, 'The candidate identity collided.');
      continue;
    }
    if (accepted.identity.kind === 'exact_restatement') {
      const entry = revisionEntry(manifest, accepted.identity.revision);
      if (entry !== null) touched.set(entry.ref, entry);
      const published = publishExactRestatement({
        accepted,
        interpretation,
        source_recorded_at,
        publisher,
        manifest,
        item,
      });
      holdUnpublishedLinks(
        accepted,
        publisher,
        published
          ? 'An exact restatement publishes no relationship candidate.'
          : 'The exact restatement was not published.',
        published ? new Set(['exact_restatement']) : new Set()
      );
      holdUnpublishedAlternatives(
        accepted,
        publisher,
        'An exact restatement does not publish a decision candidate.'
      );
      continue;
    }
    if (accepted.identity.kind === 'proposed_equivalence') {
      holdUnpublishedLinks(
        accepted,
        publisher,
        'A proposed equivalence publishes no relationship candidate.',
        new Set(['equivalent_to'])
      );
      holdUnpublishedAlternatives(
        accepted,
        publisher,
        'A proposed equivalence does not publish a decision candidate.'
      );
      continue;
    }
    if (candidateTarget === null) {
      publisher.hold(item, 'statement_published_no_candidate', 'No candidate target was produced.');
      holdUnpublishedLinks(accepted, publisher, 'The statement produced no candidate target.');
      holdUnpublishedAlternatives(
        accepted,
        publisher,
        'The statement produced no decision candidate.'
      );
      continue;
    }

    const publishCandidate = retainedState !== 'compatible';
    if (publishCandidate) {
      const published = publishCandidateRevision({
        accepted,
        interpretation,
        target: candidateTarget,
        source_recorded_at,
        manifest,
        publisher,
        item,
      });
      if (!published) {
        holdUnpublishedLinks(accepted, publisher, 'The candidate revision was not published.');
        holdUnpublishedAlternatives(
          accepted,
          publisher,
          'The decision candidate was not published.'
        );
        continue;
      }
    } else {
      publisher.hold(
        item,
        'candidate_already_retained',
        `Candidate revision ${candidateTarget.revision_id} already has compatible retained semantics.`,
        'accepted'
      );
    }

    for (const link of accepted.links) {
      if (['exact_restatement', 'equivalent_to'].includes(link.relation)) continue;
      const at: ProposalItem = {
        kind: 'link',
        statement_index: accepted.index,
        link_index: link.index,
      };
      touched.set(link.entry.ref, link.entry);
      if (link.relation === 'unrelated' || link.relation === 'cannot_tell') {
        publisher.hold(
          at,
          'link_publishes_nothing',
          `${link.entry.ref} ${RELATION_WORD[link.relation]} this interpretation.`
        );
        continue;
      }
      const scope = relationshipScope(manifest, accepted.statement.intended_scope);
      if (scope === null) {
        publisher.hold(
          at,
          'intended_scope_not_nameable',
          'A relationship is not published when the interpretation leaves its scope unknown.'
        );
        continue;
      }
      const relationship = suggestedRelationship({
        link,
        published: candidateTarget,
        attribution,
        scope,
        sourceId: originSourceId,
        detector: attribution.detector,
      });
      if (relationship !== null) {
        publisher.keep(
          RelationshipSchema,
          relationship,
          at,
          (record, restsOn) => ({ kind: 'relationship', record, rests_on: restsOn }),
          restingOn(manifest, link.entry)
        );
      }
      suggestTaskUse({
        manifest,
        entry: link.entry,
        item: at,
        detector: attribution.detector,
        source_recorded_at,
        publisher,
        suggested: suggestedUses,
      });
    }
  }

  for (const accepted of validated.corrections) {
    const item: ProposalItem = { kind: 'correction', index: accepted.index };
    touched.set(accepted.entry.ref, accepted.entry);
    const common = {
      action_id: derivedId([
        'correction',
        accepted.correction.kind,
        accepted.evidence.source_id,
        accepted.entry.revision,
        accepted.evidence,
      ]),
      targets: [accepted.entry.revision],
      scope: sourceScope(manifest, accepted.evidence.source_id, input.source_aliases ?? []),
      attributed_to: attribution,
      source_id: accepted.evidence.source_id,
      authorization: null,
      expected_state: expectedStateFor(manifest, accepted.entry),
    };
    const correction: CorrectionAction =
      accepted.correction.kind === 'challenge'
        ? { ...common, kind: 'challenge', explanation: accepted.evidence.quote }
        : { ...common, kind: 'factual_correction', corrected_account: accepted.evidence.quote };
    publisher.keep(
      CorrectionActionSchema,
      correction,
      item,
      (record, restsOn) => ({ kind: 'correction', record, rests_on: restsOn }),
      restingOn(manifest, accepted.entry)
    );
  }

  return finish();
}

export function candidateTargetForStatement(input: {
  manifest: InterpretationManifest;
  accepted: AcceptedStatement;
  source_aliases?: readonly CanonicalSourceAlias[];
}): InterpretationTarget | null {
  const { manifest, accepted } = input;
  const record = accepted.statement.proposed_record;
  if (record === 'none') return null;
  if (
    accepted.identity.kind === 'exact_restatement' ||
    accepted.identity.kind === 'proposed_equivalence'
  ) {
    return accepted.identity.revision;
  }
  if (accepted.identity.kind === 'identity_unresolved') return null;
  const origin = manifest.sources.find((source) => source.ref === accepted.statement.source_ref);
  if (origin === undefined) return null;
  const originSourceId = canonicalSourceId(origin.source_id, input.source_aliases ?? []);
  const parent = accepted.identity.kind === 'refines' ? accepted.identity.from : null;
  const entityId = derivedId([
    'candidate-entity@1',
    originSourceId,
    record,
    accepted.statement.wording,
    normalizedScope(accepted.statement.intended_scope),
    parent === null ? 'unlinked' : 'refines',
    parent,
  ]);
  const rationale =
    accepted.rationale.kind === 'stated'
      ? { kind: 'stated', wording: accepted.rationale.wording }
      : { kind: 'unknown' };
  const derivation =
    parent === null
      ? null
      : {
          parent,
          explanation: derivationExplanation(manifest, parent, originSourceId),
        };
  const revisionParts: unknown[] = [
    'candidate-revision@1',
    { kind: record, entity_id: entityId },
    accepted.statement.wording,
    record === 'claim' ? null : rationale,
    derivation,
  ];
  if (record === 'decision' && accepted.alternatives.length > 0) {
    revisionParts.push({
      alternatives: accepted.alternatives.map(({ alternative }) => ({
        option: alternative.option,
        rejected_because: alternative.rejected_because,
      })),
    });
  }
  const revisionId = derivedId(revisionParts);
  return { kind: record, entity_id: entityId, revision_id: revisionId };
}

function makeInterpretation(input: {
  manifest: InterpretationManifest;
  accepted: AcceptedStatement;
  sourceId: string;
  source_recorded_at: string;
  outcome: KnowledgeInterpretation['canonical_outcome'];
}): KnowledgeInterpretation {
  const { manifest, accepted, sourceId, source_recorded_at, outcome } = input;
  const evidence = canonicalEvidence([
    ...accepted.evidence,
    ...(accepted.rationale.kind === 'stated' ? accepted.rationale.evidence : []),
    ...accepted.alternatives.flatMap((alternative) => alternative.evidence),
  ]);
  const evidencePositions =
    accepted.rationale.kind === 'stated'
      ? accepted.rationale.evidence.map((item) =>
          evidence.findIndex((entry) => evidenceKey(entry) === evidenceKey(item))
        )
      : [];
  const rationale: KnowledgeInterpretation['rationale'] =
    accepted.rationale.kind === 'stated'
      ? {
          kind: 'stated',
          wording: accepted.rationale.wording,
          evidence_positions: [...new Set(evidencePositions)].sort((a, b) => a - b),
        }
      : { kind: 'unknown' };
  const uncertainties = [
    ...new Map(
      accepted.uncertainties.map((uncertainty) => [
        canonicalJson([uncertainty.about, uncertainty.note]),
        { about: uncertainty.about, note: uncertainty.note },
      ])
    ).values(),
  ].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const identity: KnowledgeInterpretationIdentity = {
    source_origin: { source_id: sourceId, task: manifest.task_context },
    wording: accepted.statement.wording,
    source_form: accepted.statement.source_form,
    proposed_record: accepted.statement.proposed_record,
    intended_scope: accepted.statement.intended_scope,
    rationale,
    uncertainties,
    evidence,
    canonical_outcome: outcome,
    attributed_to: manifest.attributed_to as Extract<Attribution, { kind: 'detector' }>,
  };
  return {
    interpretation_id: knowledgeInterpretationId(manifest.processor_contract, identity),
    ...identity,
    recorded_at: source_recorded_at,
  };
}

function interpretationOutcome(
  accepted: AcceptedStatement,
  candidate: InterpretationTarget | null
): KnowledgeInterpretation['canonical_outcome'] {
  if (candidate === null) return { kind: 'none', target: null };
  if (accepted.identity.kind === 'exact_restatement') {
    return { kind: 'exact_restatement', target: candidate };
  }
  if (accepted.identity.kind === 'proposed_equivalence') {
    return { kind: 'proposed_equivalence', target: candidate };
  }
  return { kind: 'candidate_revision', target: candidate };
}

function holdUnpublishedLinks(
  accepted: AcceptedStatement,
  publisher: Publisher,
  detail: string,
  successfulRelations: ReadonlySet<AcceptedLink['relation']> = new Set()
): void {
  for (const link of accepted.links) {
    if (
      link.relation === 'unrelated' ||
      link.relation === 'cannot_tell' ||
      successfulRelations.has(link.relation)
    )
      continue;
    publisher.hold(
      { kind: 'link', statement_index: accepted.index, link_index: link.index },
      'statement_published_no_candidate',
      detail
    );
  }
}

function holdUnpublishedAlternatives(
  accepted: AcceptedStatement,
  publisher: Publisher,
  detail: string
): void {
  for (const alternative of accepted.alternatives) {
    publisher.hold(
      {
        kind: 'alternative',
        statement_index: accepted.index,
        alternative_index: alternative.index,
      },
      'statement_published_no_candidate',
      detail
    );
  }
}

function publishCandidateRevision(input: {
  accepted: AcceptedStatement;
  interpretation: KnowledgeInterpretation;
  target: InterpretationTarget;
  source_recorded_at: string;
  manifest: InterpretationManifest;
  publisher: Publisher;
  item: ProposalItem;
}): boolean {
  const { accepted, interpretation, target, source_recorded_at, manifest, publisher, item } = input;
  const sourceIds = [...new Set(interpretation.evidence.map((evidence) => evidence.source_id))];
  const passages = interpretation.evidence.map(preparedPassage);
  const support = {
    interpretation_id: interpretation.interpretation_id,
    evidence_relation: 'supports' as const,
  };
  const parent = accepted.identity.kind === 'refines' ? accepted.identity.from : null;
  const restsOn = parent === null ? [] : restingOnRevision(manifest, parent);
  const common = {
    revision_id: target.revision_id,
    previous_revision_id: null,
    applicability: { all_of: [] },
    source_ids: sourceIds,
    passages,
    source_standing: 'extracted_candidate' as const,
    attributed_to: interpretation.attributed_to,
    interpretation: support,
    recorded_at: source_recorded_at,
  };

  if (target.kind === 'decision') {
    const decision: DecisionRevision = {
      ...common,
      decision_id: target.entity_id,
      chosen_approach: accepted.statement.wording,
      rationale: accepted.rationale.kind === 'stated' ? accepted.rationale.wording : null,
      alternatives: accepted.alternatives.map(({ alternative }) => ({
        option: alternative.option,
        rejected_because: alternative.rejected_because,
      })),
      assumptions: [],
      reconsideration_conditions: [],
      subject: null,
      derivation:
        parent === null
          ? null
          : {
              derived_from: parent,
              explanation: derivationExplanation(
                manifest,
                parent,
                interpretation.source_origin.source_id
              ),
              source_id: interpretation.source_origin.source_id,
              derived_at: source_recorded_at,
            },
    };
    return publisher.keep(
      DecisionRevisionSchema,
      decision,
      item,
      (record, on) => ({ kind: 'decision_revision', record, rests_on: on }),
      restsOn
    );
  }
  if (target.kind === 'claim') {
    const claim: ClaimRevision = {
      ...common,
      claim_id: target.entity_id,
      statement: accepted.statement.wording,
      subject: null,
      observation_ids: [],
      verification: null,
    };
    return publisher.keep(
      ClaimRevisionSchema,
      claim,
      item,
      (record, on) => ({ kind: 'claim_revision', record, rests_on: on }),
      restsOn
    );
  }

  const identity: RequirementIdentity = {
    requirement_id: target.entity_id,
    origin:
      parent === null
        ? { kind: 'interpreted_source', interpretation_id: interpretation.interpretation_id }
        : {
            kind: 'derived',
            derived_from: { kind: 'expectation', expectation: parent },
            explanation: derivationExplanation(
              manifest,
              parent,
              interpretation.source_origin.source_id
            ),
            source_id: interpretation.source_origin.source_id,
            derived_at: source_recorded_at,
          },
  };
  if (!RequirementIdentitySchema.safeParse(identity).success) {
    publisher.hold(
      item,
      'refused_by_the_contract',
      'The candidate requirement identity is invalid.'
    );
    return false;
  }
  const requirement: RequirementRevision = {
    ...common,
    requirement_id: target.entity_id,
    statement: accepted.statement.wording,
    rationale: accepted.rationale.kind === 'stated' ? accepted.rationale.wording : null,
    subject: null,
    duration: { kind: 'unknown' },
  };
  return publisher.keep(
    RequirementRevisionSchema,
    requirement,
    item,
    (record, on) => ({ kind: 'requirement_revision', identity, record, rests_on: on }),
    restsOn
  );
}

function publishExactRestatement(input: {
  accepted: AcceptedStatement;
  interpretation: KnowledgeInterpretation;
  source_recorded_at: string;
  publisher: Publisher;
  manifest: InterpretationManifest;
  item: ProposalItem;
}): boolean {
  const { accepted, interpretation, source_recorded_at, publisher, manifest, item } = input;
  if (accepted.identity.kind !== 'exact_restatement') return false;
  const evidence = interpretation.evidence.find(
    (candidate) =>
      candidate.quote === accepted.statement.wording && candidate.original_ranges.length === 1
  );
  if (evidence === undefined) {
    publisher.hold(
      item,
      'statement_published_no_candidate',
      'The exact restatement has no single original passage.'
    );
    return false;
  }
  const passage = legacyPassage(evidence) as SourceSelector;
  const restatement: PassageRestatement = {
    restatement_id: derivedId([
      'passage_restatement',
      passage.source_id,
      passage.location,
      accepted.identity.revision,
    ]),
    passage,
    restates: accepted.identity.revision,
    attributed_to: interpretation.attributed_to,
    recorded_at: source_recorded_at,
  };
  return publisher.keep(
    PassageRestatementSchema,
    restatement,
    item,
    (record, restsOn) => ({ kind: 'passage_restatement', record, rests_on: restsOn }),
    restingOnRevision(manifest, accepted.identity.revision)
  );
}

function suggestTaskUse(input: {
  manifest: InterpretationManifest;
  entry: ManifestRevisionEntry;
  item: ProposalItem;
  detector: string;
  source_recorded_at: string;
  publisher: Publisher;
  suggested: Set<string>;
}): void {
  const { manifest, entry, item, detector, source_recorded_at, publisher, suggested } = input;
  if (entry.revision.kind !== 'requirement' && entry.revision.kind !== 'decision') return;
  if (suggested.has(entry.ref)) return;
  suggested.add(entry.ref);
  const task = manifest.task_context;
  if (task === null) {
    publisher.hold(
      item,
      'no_plan_event_in_manifest',
      `A use of ${entry.ref} needs a plan event.`,
      'accepted'
    );
    return;
  }
  const taskUse: TaskUse = {
    artifact_id: task.artifact_id,
    plan_event_id: task.plan_event_id,
    target: entry.revision as ExpectationRevisionRef,
    role: 'background',
    local: null,
    exception_id: null,
    selection: {
      kind: 'connected_later',
      discovered_at: source_recorded_at,
      discovered_by: { kind: 'detector', detector },
    },
  };
  publisher.keep(
    TaskUseSchema,
    taskUse,
    item,
    (record, restsOn) => ({ kind: 'task_use', record, rests_on: restsOn }),
    restingOn(manifest, entry),
    'accepted',
    'task_use_refused_by_contract'
  );
}

function suggestedRelationship(input: {
  link: AcceptedLink;
  published: InterpretationTarget;
  attribution: Attribution;
  scope: AuthorityScope;
  sourceId: string;
  detector: string;
}): Relationship | null {
  const { link, published, attribution, scope, sourceId, detector } = input;
  const edge = (() => {
    switch (link.relation) {
      case 'departs_from':
        return { relation: 'supersedes' as const, from: published, to: link.entry.revision };
      case 'contradicts':
        return { relation: 'challenges' as const, from: published, to: link.entry.revision };
      case 'refines':
        return { relation: 'depends_on' as const, from: published, to: link.entry.revision };
      case 'supports':
        return { relation: 'motivates' as const, from: link.entry.revision, to: published };
      default:
        return null;
    }
  })();
  if (edge === null) return null;
  return {
    relationship_id: derivedId([
      'relationship',
      edge.relation,
      edge.from,
      edge.to,
      scope,
      sourceId,
    ]),
    ...edge,
    scope,
    standing: 'suggested',
    attributed_to: attribution,
    authorization: null,
    source_ids: [sourceId],
    explanation:
      `Suggested by ${detector}: interpretation of ${sourceId} ${RELATION_WORD[link.relation]} ` +
      `${link.entry.revision.kind} revision ${link.entry.revision.revision_id}.`,
  };
}

function canonicalEvidence(input: readonly InterpretationEvidence[]): InterpretationEvidence[] {
  return [...new Map(input.map((evidence) => [evidenceKey(evidence), evidence])).values()].sort(
    (a, b) => evidenceKey(a).localeCompare(evidenceKey(b))
  );
}

const evidenceKey = (evidence: InterpretationEvidence) => canonicalJson(evidence);

function preparedPassage(evidence: InterpretationEvidence): SourceSelector {
  return {
    source_id: evidence.source_id,
    location: `prepared-bytes:${evidence.prepared_start_utf8}-${evidence.prepared_end_utf8}`,
    passage_sha256: evidence.passage_sha256,
  };
}

function legacyPassage(evidence: InterpretationEvidence): SourceSelector | null {
  if (evidence.original_ranges.length !== 1) return null;
  const range = evidence.original_ranges[0];
  return {
    source_id: evidence.source_id,
    location: `bytes:${range.start}-${range.end}`,
    passage_sha256: evidence.passage_sha256,
  };
}

function relationshipScope(
  manifest: InterpretationManifest,
  scope: AcceptedStatement['statement']['intended_scope']
): AuthorityScope | null {
  if (scope.kind === 'unknown') return null;
  return scope.kind === 'project'
    ? { kind: 'project', project_id: manifest.project_id }
    : { kind: 'artifact', artifact_id: scope.artifact_id };
}

function sourceScope(
  manifest: InterpretationManifest,
  sourceId: string,
  aliases: readonly CanonicalSourceAlias[]
): AuthorityScope {
  const source = manifest.sources.find(
    (candidate) => canonicalSourceId(candidate.source_id, aliases) === sourceId
  );
  return source === undefined
    ? { kind: 'project', project_id: manifest.project_id }
    : { kind: 'artifact', artifact_id: source.occurrence.artifact_id };
}

export function canonicalizeValidatedProposalSources(
  validated: ValidatedProposal,
  aliases: readonly CanonicalSourceAlias[]
): ValidatedProposal {
  const evidence = (item: InterpretationEvidence): InterpretationEvidence => ({
    ...item,
    source_id: canonicalSourceId(item.source_id, aliases),
  });
  return {
    ...validated,
    statements: validated.statements.map((accepted) => ({
      ...accepted,
      evidence: accepted.evidence.map(evidence),
      rationale:
        accepted.rationale.kind === 'unknown'
          ? accepted.rationale
          : { ...accepted.rationale, evidence: accepted.rationale.evidence.map(evidence) },
      alternatives: accepted.alternatives.map((alternative) => ({
        ...alternative,
        evidence: alternative.evidence.map(evidence),
      })),
    })),
    corrections: validated.corrections.map((accepted) => ({
      ...accepted,
      evidence: evidence(accepted.evidence),
    })),
  };
}

export function canonicalSourceIdsForManifest(
  manifest: InterpretationManifest,
  aliases: readonly CanonicalSourceAlias[]
): string[] {
  return [
    ...new Set(manifest.sources.map((source) => canonicalSourceId(source.source_id, aliases))),
  ];
}

function reconciledQuality(
  validated: ValidatedProposal,
  finalHeldItems: readonly ProposalItem[]
): ProposalQualityCounts {
  const acceptedItems = new Set<string>();
  for (const statement of validated.statements) {
    if (statement.statement.proposed_record !== 'none') {
      acceptedItems.add(proposalItemKey({ kind: 'statement', index: statement.index }));
    }
    for (const link of statement.links) {
      if (link.relation !== 'unrelated' && link.relation !== 'cannot_tell') {
        acceptedItems.add(
          proposalItemKey({
            kind: 'link',
            statement_index: statement.index,
            link_index: link.index,
          })
        );
      }
    }
    for (const alternative of statement.alternatives) {
      acceptedItems.add(
        proposalItemKey({
          kind: 'alternative',
          statement_index: statement.index,
          alternative_index: alternative.index,
        })
      );
    }
  }
  for (const correction of validated.corrections) {
    acceptedItems.add(proposalItemKey({ kind: 'correction', index: correction.index }));
  }
  const newlyHeld = new Map<string, keyof ProposalQualityCounts['accepted']>();
  for (const item of finalHeldItems) {
    const key = proposalItemKey(item);
    const collection = proposalItemCollection(item);
    if (acceptedItems.has(key) && collection !== null) newlyHeld.set(key, collection);
  }

  const quality = {
    proposed: { ...validated.quality.proposed },
    accepted: { ...validated.quality.accepted },
    held_back: { ...validated.quality.held_back },
    rejected: { ...validated.quality.rejected },
  };
  for (const collection of newlyHeld.values()) {
    quality.accepted[collection] -= 1;
    quality.held_back[collection] += 1;
  }
  return quality;
}

function proposalItemKey(item: ProposalItem): string {
  switch (item.kind) {
    case 'proposal':
      return 'proposal';
    case 'statement':
      return `statement:${item.index}`;
    case 'citation':
      return `citation:${item.statement_index}:${item.citation_index}:${item.rationale}`;
    case 'link':
      return `link:${item.statement_index}:${item.link_index}`;
    case 'alternative':
      return `alternative:${item.statement_index}:${item.alternative_index}`;
    case 'correction':
      return `correction:${item.index}`;
    case 'uncertainty':
      return `uncertainty:${item.index}`;
  }
}

function proposalItemCollection(
  item: ProposalItem
): keyof ProposalQualityCounts['accepted'] | null {
  switch (item.kind) {
    case 'statement':
    case 'citation':
      return 'statements';
    case 'link':
      return 'links';
    case 'alternative':
      return 'alternatives';
    case 'correction':
      return 'corrections';
    case 'uncertainty':
      return 'uncertainties';
    case 'proposal':
      return null;
  }
}

function canonicalSourceId(
  requestedSourceId: string,
  aliases: readonly CanonicalSourceAlias[]
): string {
  return (
    aliases.find((alias) => alias.requestedSourceId === requestedSourceId)?.sourceId ??
    requestedSourceId
  );
}

const normalizedScope = (scope: AcceptedStatement['statement']['intended_scope']) =>
  scope.kind === 'artifact' ? `artifact:${scope.artifact_id}` : scope.kind;

function derivationExplanation(
  manifest: InterpretationManifest,
  parent: ExpectationRevisionRef,
  sourceId: string
): string {
  return (
    `Derived by ${manifest.processor_contract} from ${parent.kind} revision ` +
    `${parent.revision_id}, which the interpreted source ${sourceId} refines.`
  );
}

function revisionEntry(
  manifest: InterpretationManifest,
  revision: RecordRevisionRef
): ManifestRevisionEntry | null {
  return (
    manifest.revisions.find(
      (entry) =>
        entry.revision.kind === revision.kind &&
        entry.revision.entity_id === revision.entity_id &&
        entry.revision.revision_id === revision.revision_id
    ) ?? null
  );
}

function knowledgeFor(manifest: InterpretationManifest, entryRef: string) {
  return manifest.related_knowledge.find((candidate) => candidate.ref === entryRef) ?? null;
}

function expectedStateFor(
  manifest: InterpretationManifest,
  entry: ManifestRevisionEntry
): ExpectedState {
  const knowledge = knowledgeFor(manifest, entry.entry_ref);
  return {
    kind: 'observed',
    selection_ids: [...(knowledge?.resolved.governing_state.selection_ids ?? [])],
    correction_action_ids: [...(knowledge?.resolved.governing_state.correction_action_ids ?? [])],
  };
}

function restingOn(
  manifest: InterpretationManifest,
  entry: ManifestRevisionEntry
): ExpectedGoverningState[] {
  const knowledge = knowledgeFor(manifest, entry.entry_ref);
  if (knowledge === null) return [];
  return [
    {
      target: knowledge.resolved.target,
      knowledge_boundary: knowledge.resolved.basis.knowledge_boundary,
      state: expectedStateFor(manifest, entry),
    },
  ];
}

function restingOnRevision(
  manifest: InterpretationManifest,
  revision: RecordRevisionRef
): ExpectedGoverningState[] {
  const entry = revisionEntry(manifest, revision);
  return entry === null ? [] : restingOn(manifest, entry);
}

function expectedStates(
  manifest: InterpretationManifest,
  entries: readonly ManifestRevisionEntry[]
): ExpectedGoverningState[] {
  const refs = new Set(entries.map((entry) => entry.entry_ref));
  return manifest.related_knowledge
    .filter((entry) => refs.has(entry.ref))
    .map((entry) => ({
      target: entry.resolved.target,
      knowledge_boundary: entry.resolved.basis.knowledge_boundary,
      state: {
        kind: 'observed' as const,
        selection_ids: [...entry.resolved.governing_state.selection_ids],
        correction_action_ids: [...entry.resolved.governing_state.correction_action_ids],
      },
    }));
}

const targetKey = (target: InterpretationTarget) =>
  canonicalJson([target.kind, target.entity_id, target.revision_id]);

function derivedId(parts: readonly unknown[]): string {
  const hex = createHash('sha256').update(canonicalJson(parts)).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function describeRefusal(error: unknown): string {
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] } | undefined)
    ?.issues;
  if (issues === undefined) return String(error);
  return issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}
